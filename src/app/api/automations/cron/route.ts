import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resumePendingExecution } from '@/lib/automations/engine'
import type { AutomationContext } from '@/lib/automations/engine'
import { assignNextAgent } from '@/lib/leads/round-robin'

/**
 * Drain due `automation_pending_executions` rows. Meant to be hit
 * on a schedule (Vercel Cron / external pinger) — requires a shared
 * secret via the `x-cron-secret` header to match
 * `AUTOMATION_CRON_SECRET`.
 *
 * The claim step (status = 'running') serves as a simple lock so
 * overlapping invocations don't double-process rows. Best-effort
 * only; expensive SELECT ... FOR UPDATE is avoided in favor of a
 * two-step UPDATE-by-id.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  // Comparação em tempo constante — evita timing attack que permitiria
  // recuperar o secret byte a byte medindo delta de tempo de resposta.
  // timingSafeEqual exige buffers de mesmo tamanho, então o length check
  // vaza só o tamanho do secret (não sensível).
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (suppliedBuf.length !== expectedBuf.length || !timingSafeEqual(suppliedBuf, expectedBuf)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const { data: due, error } = await admin
    .from('automation_pending_executions')
    .select('*')
    .eq('status', 'pending')
    .lte('run_at', new Date().toISOString())
    .order('run_at', { ascending: true })
    .limit(50)

  if (error) {
    console.error('[automations-cron] due scan failed:', error.message)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  // Normaliza para array vazio quando não há linhas pendentes — evita
  // early return que pularia o segundo passe de distribuição automática.
  const dueRows = due ?? []
  let processed = 0
  for (const row of dueRows) {
    const { data: claim } = await admin
      .from('automation_pending_executions')
      .update({ status: 'running' })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claim) continue

    await resumePendingExecution({
      id: row.id as string,
      automation_id: row.automation_id as string,
      // account_id is NOT NULL on automation_pending_executions
      // post-017; the engine uses it for tenant-scoped lookups.
      account_id: row.account_id as string,
      user_id: row.user_id as string,
      contact_id: (row.contact_id as string | null) ?? null,
      log_id: (row.log_id as string | null) ?? null,
      parent_step_id: (row.parent_step_id as string | null) ?? null,
      branch: (row.branch as 'yes' | 'no' | null) ?? null,
      next_step_position: row.next_step_position as number,
      context: (row.context as AutomationContext) ?? {},
    })
    processed++
  }

  // ── Segundo passe: fila de espera da distribuição automática ──────────
  // Leads que chegaram sem ninguém disponível ficaram com
  // autoassign_waiting=true. Assim que um vendedor fica disponível, o cron
  // atribui o MAIS ANTIGO primeiro. assignNextAgent limpa o flag + seta o
  // assigned_agent_id de forma atômica; o guard `.is(null)` torna o passe
  // idempotente sob execuções sobrepostas.
  let assigned = 0
  const { data: waiting } = await admin
    .from('conversations')
    .select('id, account_id, contact_id')
    .eq('autoassign_waiting', true)
    .order('created_at', { ascending: true })
    .limit(100)
  for (const c of waiting ?? []) {
    const { data: s } = await admin
      .from('lead_autoassign_settings')
      .select('is_active')
      .eq('account_id', c.account_id as string)
      .maybeSingle()
    if (!s?.is_active) continue
    const { agentId } = await assignNextAgent(admin, c.account_id as string, c.contact_id as string)
    if (agentId) assigned++
  }

  return NextResponse.json({ processed, assigned })
}

// GET  — retorna presença própria do vendedor (in_pool, is_available).
// PUT  — atualiza disponibilidade/pool com rate limit por usuário.
// POST — heartbeat de atividade; atualiza last_activity_at.
import { NextResponse } from 'next/server'

import { requireActiveAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

export async function GET() {
  try {
    const ctx = await requireActiveAccount()

    const { data, error } = await ctx.supabase
      .from('agent_presence')
      .select('in_pool, is_available, last_activity_at')
      .eq('account_id', ctx.accountId)
      .eq('user_id', ctx.userId)
      .maybeSingle()

    if (error) {
      console.error('[GET /api/account/presence] erro ao buscar presença:', error)
      return NextResponse.json({ error: 'Falha ao buscar presença' }, { status: 500 })
    }

    // Sem linha (não-agente ou trigger ainda não rodou) — retorna padrão inerte.
    if (!data) {
      return NextResponse.json({ in_pool: false, is_available: false })
    }

    return NextResponse.json({ in_pool: data.in_pool, is_available: data.is_available })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('agent')

    // Rate limit por usuário — cobre toggle manual e qualquer burst.
    const rl = await checkRateLimit(`presence:${ctx.userId}`, RATE_LIMITS.presence)
    if (!rl.success) return rateLimitResponse(rl)

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Corpo inválido' }, { status: 400 })
    }

    // Constrói patch apenas com os booleanos fornecidos — campos ausentes não tocam o DB.
    // in_pool é exclusivo do admin e gerido via lead-autoassign; não aceitar aqui.
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (typeof body.is_available === 'boolean') patch.is_available = body.is_available

    if (Object.keys(patch).length === 1) {
      // Só tem updated_at; nenhum campo útil foi enviado.
      return NextResponse.json({ error: 'Nenhum campo válido fornecido' }, { status: 400 })
    }

    const { error } = await ctx.supabase
      .from('agent_presence')
      .update(patch)
      .eq('account_id', ctx.accountId)
      .eq('user_id', ctx.userId)

    if (error) {
      console.error('[PUT /api/account/presence] erro ao atualizar presença:', error)
      return NextResponse.json({ error: 'Falha ao atualizar presença' }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST() {
  try {
    const ctx = await requireRole('agent')

    // Rate limit compartilhado com o PUT — heartbeat e toggle usam o mesmo bucket.
    const rl = await checkRateLimit(`presence:${ctx.userId}`, RATE_LIMITS.presence)
    if (!rl.success) return rateLimitResponse(rl)

    const now = new Date().toISOString()

    const { error } = await ctx.supabase
      .from('agent_presence')
      .update({ last_activity_at: now, updated_at: now })
      .eq('account_id', ctx.accountId)
      .eq('user_id', ctx.userId)

    if (error) {
      console.error('[POST /api/account/presence] erro no heartbeat:', error)
      return NextResponse.json({ error: 'Falha no heartbeat' }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

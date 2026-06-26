// GET  — visão da configuração de auto-atribuição de leads (admin).
// PUT  — toggle is_active + atualiza quais agentes estão no pool (admin).
import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { isAvailableNow } from '@/lib/leads/round-robin'

// ─── Tipos da view retornada pelo GET e PUT ──────────────────────────────────

interface RosterEntry {
  user_id: string
  full_name: string | null
  email: string | null
  in_pool: boolean
  is_available: boolean
  available_now: boolean
}

interface AutoassignView {
  is_active: boolean
  roster: RosterEntry[]
  waiting_count: number
}

// ─── buildView: consultas ao banco e montagem da view ────────────────────────

/**
 * Monta a view de auto-atribuição para a conta, executando três queries
 * independentes e fazendo o merge em JS (sem FK entre agent_presence e profiles).
 */
async function buildView(
  supabase: Awaited<ReturnType<typeof requireRole>>['supabase'],
  accountId: string,
): Promise<AutoassignView> {
  // 1. Configuração de auto-atribuição
  const { data: settings } = await supabase
    .from('lead_autoassign_settings')
    .select('is_active')
    .eq('account_id', accountId)
    .maybeSingle()

  const is_active = settings?.is_active ?? false

  // 2. Presença dos agentes da conta
  const { data: presenceRows } = await supabase
    .from('agent_presence')
    .select('user_id, in_pool, is_available, last_activity_at')
    .eq('account_id', accountId)

  // 3. Perfis dos membros da conta
  const { data: profileRows } = await supabase
    .from('profiles')
    .select('user_id, full_name, email')
    .eq('account_id', accountId)

  // Índice de perfis por user_id para merge eficiente
  const profileMap = new Map(
    (profileRows ?? []).map((p) => [p.user_id as string, p]),
  )

  const now = new Date()

  // Merge: cada linha de presença com seu perfil correspondente
  const roster: RosterEntry[] = (presenceRows ?? [])
    .filter((p) => profileMap.has(p.user_id as string))
    .map((p) => {
      const profile = profileMap.get(p.user_id as string)!
      return {
        user_id: p.user_id as string,
        full_name: (profile.full_name as string | null) ?? null,
        email: (profile.email as string | null) ?? null,
        in_pool: Boolean(p.in_pool),
        is_available: Boolean(p.is_available),
        available_now: isAvailableNow(
          {
            in_pool: Boolean(p.in_pool),
            is_available: Boolean(p.is_available),
            last_activity_at: p.last_activity_at as string | null,
          },
          now,
        ),
      }
    })

  // 4. Leads aguardando atribuição automática
  const { count } = await supabase
    .from('conversations')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .eq('autoassign_waiting', true)

  return {
    is_active,
    roster,
    waiting_count: count ?? 0,
  }
}

// ─── GET ─────────────────────────────────────────────────────────────────────

export async function GET() {
  try {
    const ctx = await requireRole('admin')
    const view = await buildView(ctx.supabase, ctx.accountId)
    return NextResponse.json(view)
  } catch (err) {
    return toErrorResponse(err)
  }
}

// ─── PUT ─────────────────────────────────────────────────────────────────────

interface PutBody {
  is_active?: boolean
  pool?: { user_id: string; in_pool: boolean }[]
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin')

    const rl = await checkRateLimit(`laas:${ctx.accountId}`, RATE_LIMITS.adminAction)
    if (!rl.success) return rateLimitResponse(rl)

    const body = (await request.json().catch(() => null)) as PutBody | null
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Corpo inválido' }, { status: 400 })
    }

    // Atualiza is_active se enviado
    if (typeof body.is_active === 'boolean') {
      // Não inclui `cursor` no payload — preserva o ponteiro de rodízio no conflict
      const { error } = await ctx.supabase
        .from('lead_autoassign_settings')
        .upsert(
          {
            account_id: ctx.accountId,
            is_active: body.is_active,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'account_id' },
        )
      if (error) {
        console.error('[PUT /api/account/lead-autoassign] upsert settings error:', error)
        return NextResponse.json({ error: 'Falha ao salvar configuração' }, { status: 500 })
      }
    }

    // Atualiza in_pool para cada agente listado
    if (Array.isArray(body.pool)) {
      for (const { user_id, in_pool } of body.pool) {
        const { error } = await ctx.supabase
          .from('agent_presence')
          .update({ in_pool, updated_at: new Date().toISOString() })
          .eq('account_id', ctx.accountId)
          .eq('user_id', user_id)
        if (error) {
          console.error(`[PUT /api/account/lead-autoassign] update pool error (user ${user_id}):`, error)
          // Não aborta — continua para os demais agentes; falha não-crítica
        }
      }
    }

    // Retorna a view atualizada (mesma estrutura do GET)
    const view = await buildView(ctx.supabase, ctx.accountId)
    return NextResponse.json(view)
  } catch (err) {
    return toErrorResponse(err)
  }
}

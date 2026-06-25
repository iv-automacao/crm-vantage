// GET  — config CAPI da conta (token NUNCA volta; só has_access_token).
// PUT  — upsert da config (admin). Token só atualiza se enviado não-vazio.
import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { getCapiSettingsView, validateCapiInput, type CapiSettingsInput } from '@/lib/capi/settings'

export async function GET() {
  try {
    const ctx = await requireRole('admin')
    const view = await getCapiSettingsView(ctx.supabase, ctx.accountId)
    return NextResponse.json(view)
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin')

    const rl = checkRateLimit(`capi-cfg:${ctx.accountId}`, RATE_LIMITS.adminAction)
    if (!rl.success) return rateLimitResponse(rl)

    const input = (await request.json().catch(() => null)) as CapiSettingsInput | null
    if (!input || typeof input !== 'object') {
      return NextResponse.json({ error: 'Corpo inválido' }, { status: 400 })
    }

    // Estado atual pra decidir se ativar é permitido sem reenviar o token.
    const { data: cur } = await ctx.supabase
      .from('capi_settings')
      .select('dataset_id, access_token, event_name, is_active')
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    const validated = validateCapiInput(input, {
      dataset_id: (cur?.dataset_id as string | null) ?? null,
      has_token: Boolean(cur?.access_token),
      event_name: (cur?.event_name as string) ?? 'Purchase',
      is_active: Boolean(cur?.is_active),
    })
    if (!validated.ok) {
      return NextResponse.json({ error: validated.error, code: 'validation_error' }, { status: 422 })
    }

    const { error } = await ctx.supabase
      .from('capi_settings')
      .upsert(
        {
          account_id: ctx.accountId,
          created_by_user_id: ctx.userId,
          ...validated.patch,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'account_id' },
      )
    if (error) {
      console.error('[PUT /api/account/capi] upsert error:', error)
      return NextResponse.json({ error: 'Falha ao salvar a config do CAPI' }, { status: 500 })
    }

    const view = await getCapiSettingsView(ctx.supabase, ctx.accountId)
    return NextResponse.json(view)
  } catch (err) {
    return toErrorResponse(err)
  }
}

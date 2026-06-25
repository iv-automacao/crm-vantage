// Lista as últimas conversões CAPI da conta (RLS admin-only via capi_events_select).
import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const url = new URL(request.url)
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50), 1), 200)

    const { data, error } = await ctx.supabase
      .from('capi_events')
      .select('id, status, event_name, value, currency, last_error, attempts, created_at, sent_at')
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) {
      console.error('[GET /api/account/capi/events] fetch error:', error)
      return NextResponse.json({ error: 'Falha ao carregar eventos CAPI' }, { status: 500 })
    }
    return NextResponse.json({ events: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

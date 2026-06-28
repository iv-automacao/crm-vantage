// Reenfileira um evento CAPI (volta pra pending, zera attempts). A escrita é
// via service-role (capi_events não tem policy de UPDATE pra membros), mas o
// gate é admin e o ownership é checado por account_id.
//
// Guard contra duplo-envio: NÃO reenfileira um evento que já está na fila
// (pending) ou em voo (claimado há menos de CAPI_CLAIM_TTL_MS) — senão o cron
// poderia mandar a mesma conversão 2× pra Meta.
import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { CAPI_CLAIM_TTL_MS } from '@/lib/capi/dispatch'
import { supabaseAdmin } from '@/lib/flows/admin-client'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params

    const admin = supabaseAdmin()
    // Ownership: só reenvia evento da própria conta.
    const { data: ev } = await admin
      .from('capi_events')
      .select('id, account_id, status, claimed_at')
      .eq('id', id)
      .maybeSingle()
    if (!ev || ev.account_id !== ctx.accountId) {
      return NextResponse.json({ error: 'Evento não encontrado' }, { status: 404 })
    }

    // Já está na fila — nada a fazer.
    if (ev.status === 'pending') {
      return NextResponse.json({ error: 'Evento já está na fila' }, { status: 409 })
    }
    // Em voo — claimado recentemente por uma execução do cron.
    const claimedAt = ev.claimed_at ? Date.parse(ev.claimed_at as string) : null
    const inFlight = claimedAt != null && claimedAt > Date.now() - CAPI_CLAIM_TTL_MS
    if (inFlight) {
      return NextResponse.json(
        { error: 'Evento em processamento, tente novamente em alguns minutos' },
        { status: 409 },
      )
    }

    const { error } = await admin
      .from('capi_events')
      .update({ status: 'pending', attempts: 0, last_error: null, claimed_at: null })
      .eq('id', id)
    if (error) {
      console.error('[POST capi/events/resend] update error:', error)
      return NextResponse.json({ error: 'Falha ao reenfileirar' }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

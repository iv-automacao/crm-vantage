// Reenfileira um evento CAPI (volta pra pending, zera attempts). A escrita é
// via service-role (capi_events não tem policy de UPDATE pra membros), mas o
// gate é admin e o ownership é checado por account_id.
import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
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
      .select('id, account_id')
      .eq('id', id)
      .maybeSingle()
    if (!ev || ev.account_id !== ctx.accountId) {
      return NextResponse.json({ error: 'Evento não encontrado' }, { status: 404 })
    }

    const { error } = await admin
      .from('capi_events')
      .update({ status: 'pending', attempts: 0, last_error: null })
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

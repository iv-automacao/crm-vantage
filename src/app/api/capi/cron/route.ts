// Cron de envio das conversões CAPI pendentes/falhas. Autentica pelo header
// `x-cron-secret` (timing-safe) contra AUTOMATION_CRON_SECRET — mesmo padrão
// do cron de automations existente.
import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { processPendingCapiEvents } from '@/lib/capi/dispatch'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron não configurado' }, { status: 500 })
  }

  // Comparação em tempo constante — evita timing attack.
  // timingSafeEqual exige buffers de mesmo tamanho; o length check só vaza
  // o tamanho do secret (não sensível).
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (suppliedBuf.length !== expectedBuf.length || !timingSafeEqual(suppliedBuf, expectedBuf)) {
    return NextResponse.json({ error: 'não autorizado' }, { status: 401 })
  }

  const result = await processPendingCapiEvents(supabaseAdmin())
  return NextResponse.json(result)
}

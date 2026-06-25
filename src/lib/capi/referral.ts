// src/lib/capi/referral.ts
// Captura a atribuição de anúncio Click-to-WhatsApp (CTWA) que a Meta envia
// no objeto `referral` da primeira mensagem inbound. Persiste o `ctwa_clid`
// no contato pra, no fechamento do negócio, devolver a conversão (CAPI).
import type { SupabaseClient } from '@supabase/supabase-js'

interface MetaReferral {
  ctwa_clid?: string
  [k: string]: unknown
}

function extractReferral(message: unknown): MetaReferral | null {
  if (!message || typeof message !== 'object') return null
  const referral = (message as { referral?: unknown }).referral
  if (!referral || typeof referral !== 'object') return null
  const clid = (referral as MetaReferral).ctwa_clid
  if (typeof clid !== 'string' || clid.length === 0) return null
  return referral as MetaReferral
}

/**
 * Best-effort: se a mensagem traz um `referral` com `ctwa_clid`, grava no
 * contato (sempre o anúncio mais recente sobrescreve). Nunca lança — não pode
 * derrubar o processamento do webhook.
 */
export async function captureCtwaReferral(
  admin: SupabaseClient,
  contactId: string,
  message: unknown,
): Promise<void> {
  const referral = extractReferral(message)
  if (!referral) return
  try {
    const { error } = await admin
      .from('contacts')
      .update({
        ctwa_clid: referral.ctwa_clid,
        referral,
        referral_captured_at: new Date().toISOString(),
      })
      .eq('id', contactId)
    if (error) console.warn('[capi] captura de referral falhou:', error.message)
  } catch (err) {
    console.warn('[capi] captura de referral lançou:', err)
  }
}

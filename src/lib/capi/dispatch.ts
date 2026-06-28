// Processa a fila `capi_events`: resolve credencial da conta + ctwa_clid do
// contato, envia a conversão pra Meta e atualiza o status. Chamado pelo cron.
import type { SupabaseClient } from '@supabase/supabase-js'
import { sendConversionEvent } from './client'
import { decryptCapiToken } from './crypto'

export const MAX_CAPI_ATTEMPTS = 5

// TTL do claim: uma linha "em voo" volta elegível depois disso, recuperando
// linhas presas por crash no meio do envio (reaper embutido). Reusado no
// resend manual pra recusar reenfileiramento de linha ainda em processamento.
export const CAPI_CLAIM_TTL_MS = 5 * 60 * 1000

export interface CapiDispatchResult {
  processed: number
  sent: number
  skipped: number
  failed: number
}

/** Resolve o WABA id da conta (best-effort; null se ausente). */
async function resolveWabaId(admin: SupabaseClient, accountId: string): Promise<string | null> {
  const { data } = await admin
    .from('whatsapp_config')
    .select('waba_id')
    .eq('account_id', accountId)
    .maybeSingle()
  return (data?.waba_id as string | undefined) ?? null
}

/**
 * Busca eventos pending/failed (dentro do teto de tentativas), faz o claim
 * atômico de cada linha, resolve credenciais e ctwa_clid, envia pra Meta e
 * atualiza o status. Best-effort: falha num evento não interrompe o lote.
 */
export async function processPendingCapiEvents(
  admin: SupabaseClient,
  limit = 50,
): Promise<CapiDispatchResult> {
  const result: CapiDispatchResult = { processed: 0, sent: 0, skipped: 0, failed: 0 }

  // Seleciona pending OU failed ainda dentro do teto de tentativas.
  const { data: events, error } = await admin
    .from('capi_events')
    .select('id, account_id, deal_id, contact_id, value, currency, attempts, created_at')
    .or(`status.eq.pending,and(status.eq.failed,attempts.lt.${MAX_CAPI_ATTEMPTS})`)
    .order('created_at', { ascending: true })
    .limit(limit)
  if (error) throw error
  if (!events?.length) return result

  for (const ev of events as Array<Record<string, unknown>>) {
    const id = ev.id as string

    // 0. Claim atômico (compare-and-set): só uma execução fica com a linha.
    //    Sob READ COMMITTED, um 2º UPDATE concorrente re-avalia o predicado
    //    pós-commit do 1º e não casa (claimed_at recente) → 0 linhas → pula.
    //    claimed_at expira em CAPI_CLAIM_TTL_MS, então linha presa por crash
    //    volta elegível sozinha.
    const cutoff = new Date(Date.now() - CAPI_CLAIM_TTL_MS).toISOString()
    const { data: claimed } = await admin
      .from('capi_events')
      .update({ claimed_at: new Date().toISOString() })
      .eq('id', id)
      .in('status', ['pending', 'failed'])
      .or(`claimed_at.is.null,claimed_at.lt.${cutoff}`)
      .select('id')
      .maybeSingle()
    if (!claimed) continue // já pego por outra execução (ou em voo) → pula

    result.processed++

    // 1. Config da conta — sem CAPI ativo (dataset_id ou access_token ausentes),
    //    marca como skipped e segue pro próximo.
    const { data: settings } = await admin
      .from('capi_settings')
      .select('dataset_id, access_token, event_name, is_active')
      .eq('account_id', ev.account_id as string)
      .maybeSingle()
    if (!settings?.is_active || !settings.dataset_id || !settings.access_token) {
      await admin
        .from('capi_events')
        .update({ status: 'skipped', last_error: 'capi_inactive' })
        .eq('id', id)
      result.skipped++
      continue
    }

    // 2. ctwa_clid do contato — deal que não veio de anúncio não tem click-id.
    const { data: contact } = await admin
      .from('contacts')
      .select('ctwa_clid')
      .eq('id', ev.contact_id as string)
      .maybeSingle()
    if (!contact?.ctwa_clid) {
      await admin
        .from('capi_events')
        .update({ status: 'skipped', last_error: 'no_ctwa_clid' })
        .eq('id', id)
      result.skipped++
      continue
    }

    // 3. WABA id (best-effort — null se a conta ainda não configurou).
    const wabaId = await resolveWabaId(admin, ev.account_id as string)

    // 4. Envia. event_id = deal_id para dedup estável na Meta; fallback pro
    //    id da linha se deal_id for null. event_time = instante do 'won'.
    const attempts = ((ev.attempts as number) ?? 0) + 1
    const resp = await sendConversionEvent({
      datasetId: settings.dataset_id as string,
      accessToken: decryptCapiToken(settings.access_token as string),
      eventName: (settings.event_name as string) ?? 'Purchase',
      eventId: (ev.deal_id as string) ?? id,
      eventTimeUnix: Math.floor(Date.parse(ev.created_at as string) / 1000),
      ctwaClid: contact.ctwa_clid as string,
      wabaId,
      value: ev.value != null ? Number(ev.value) : null,
      currency: (ev.currency as string) ?? null,
    })

    if (resp.ok) {
      await admin
        .from('capi_events')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          attempts,
          meta_response: resp.body,
          last_error: null,
        })
        .eq('id', id)
      result.sent++
    } else {
      // Falha best-effort — registra o erro HTTP, incrementa tentativas e
      // libera o claim (claimed_at:null) pra a linha voltar elegível.
      await admin
        .from('capi_events')
        .update({
          status: 'failed',
          attempts,
          meta_response: resp.body,
          last_error: `http_${resp.status}`,
          claimed_at: null,
        })
        .eq('id', id)
      result.failed++
    }
  }

  return result
}

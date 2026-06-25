// Cliente da Meta Conversions API (CAPI) para conversões de Click-to-WhatsApp.
// Envia um evento de conversão referenciando o `ctwa_clid` do anúncio.
const GRAPH_API = 'https://graph.facebook.com/v21.0'

export interface ConversionEvent {
  datasetId: string
  accessToken: string
  eventName: string        // ex.: 'Purchase'
  eventId: string          // = deal_id — dedup estável na Meta
  eventTimeUnix: number    // = instante do 'won' (segundos)
  ctwaClid: string
  wabaId: string | null
  value: number | null
  currency: string | null
}

/**
 * Faz POST pro endpoint /{datasetId}/events. Best-effort: nunca lança por
 * erro HTTP ou de rede — devolve `ok` pra o chamador decidir status/retry.
 * O token vai só no corpo; nunca é logado.
 */
export async function sendConversionEvent(
  e: ConversionEvent,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const userData: Record<string, unknown> = { ctwa_clid: e.ctwaClid }
  if (e.wabaId) userData.whatsapp_business_account_id = e.wabaId

  const eventObj: Record<string, unknown> = {
    event_name: e.eventName,
    event_time: e.eventTimeUnix,
    action_source: 'business_messaging',
    messaging_channel: 'whatsapp',
    user_data: userData,
    event_id: e.eventId,
  }
  // Valor só entra quando há montante real — conversão sem valor ainda é
  // sinal válido pra otimização.
  if (e.value != null && e.value > 0) {
    eventObj.custom_data = { currency: e.currency ?? 'BRL', value: String(e.value) }
  }

  const url = `${GRAPH_API}/${encodeURIComponent(e.datasetId)}/events`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: [eventObj], access_token: e.accessToken }),
      signal: AbortSignal.timeout(10_000),
    })
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    return { ok: res.ok, status: res.status, body }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: { error: err instanceof Error ? err.message : 'fetch_failed' },
    }
  }
}

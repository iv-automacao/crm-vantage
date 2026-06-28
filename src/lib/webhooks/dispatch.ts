import type { SupabaseClient } from '@supabase/supabase-js'
import { signWebhookPayload } from './signature'
import { isValidWebhookUrl } from './secret'

export interface MessageReceivedPayload {
  event: 'message.received'
  account_id: string
  conversation_id: string
  contact: { id: string; phone: string; name: string | null }
  // Estado da conversa pro n8n decidir se responde (bot 24/7 + pausa manual).
  state: {
    bot_paused: boolean
    assigned_agent_id: string | null
    conversation_status: string
  }
  meta: { message: unknown; contact: unknown; metadata: unknown }
}

export function buildMessageReceivedPayload(args: {
  accountId: string
  conversationId: string
  contact: { id: string; phone: string; name: string | null }
  state: { bot_paused: boolean; assigned_agent_id: string | null; conversation_status: string }
  metaMessage: unknown
  metaContact: unknown
  metaMetadata: unknown
}): MessageReceivedPayload {
  return {
    event: 'message.received',
    account_id: args.accountId,
    conversation_id: args.conversationId,
    contact: args.contact,
    state: args.state,
    meta: { message: args.metaMessage, contact: args.metaContact, metadata: args.metaMetadata },
  }
}

/** Entrega best-effort: busca endpoints ativos da conta e faz POST assinado.
 *  NUNCA lança (não pode derrubar o inbound webhook). Nunca loga o secret. */
export async function dispatchMessageReceived(
  admin: SupabaseClient, accountId: string, payload: MessageReceivedPayload,
): Promise<void> {
  try {
    const { data: endpoints, error } = await admin
      .from('webhook_endpoints')
      .select('id,url,secret')
      .eq('account_id', accountId)
      .eq('is_active', true)
    if (error) { console.warn('[webhooks] lookup falhou:', error.message); return }
    if (!endpoints || endpoints.length === 0) return

    const rawBody = JSON.stringify(payload)
    await Promise.all(endpoints.map(async (ep: { id: string; url: string; secret: string }) => {
      // Hardening SSRF (#3): não dispara pra host interno/loopback/metadata.
      if (!isValidWebhookUrl(ep.url)) {
        console.warn(`[webhooks] endpoint ${ep.id} URL inválida/bloqueada — pulando`)
        return
      }
      try {
        const res = await fetch(ep.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-webhook-event': 'message.received',
            'x-webhook-signature': signWebhookPayload(rawBody, ep.secret),
          },
          body: rawBody,
          redirect: 'manual', // não seguir redirect pra rede interna
          signal: AbortSignal.timeout(10_000),
        })
        if (!res.ok) console.warn(`[webhooks] endpoint ${ep.id} retornou ${res.status}`)
      } catch (e) {
        console.warn(`[webhooks] endpoint ${ep.id} falhou:`, e instanceof Error ? e.message : e)
      }
    }))
  } catch (e) {
    console.warn('[webhooks] dispatch falhou:', e instanceof Error ? e.message : e)
  }
}

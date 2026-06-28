import type { SupabaseClient } from '@supabase/supabase-js'
import { isValidWebhookUrl } from './secret'
import type { ConversationContext } from './enrich'

// ============================================================
// Dispatch genérico de eventos de mensagem pro webhook bidirecional.
//
// Um único builder + dispatcher serve tanto o inbound (message.received,
// direction 'in') quanto o outbound (message.sent, direction 'out'). O
// header `x-webhook-event` reflete o `event`. Entrega best-effort: busca
// endpoints ativos da conta, valida SSRF, faz POST com token estático no
// header (x-webhook-token), redirect:'manual', timeout. NUNCA lança (não
// pode derrubar o envio nem o inbound). Nunca loga o secret.
// ============================================================

export type MessageEvent = 'message.received' | 'message.sent'
export type MessageDirection = 'in' | 'out'

/** Origem do envio — o n8n usa isto pra filtrar os próprios envios (anti-loop). */
export interface MessageSender {
  type: 'agent' | 'bot' | 'customer'
  via: 'inbox' | 'api' | 'automation' | 'flow' | 'meta'
  actor_id: string | null
  actor_name: string | null
  api_key_id: string | null
}

/** Bloco `message` normalizado (mesma forma pra in e out). */
export interface NormalizedMessage {
  id: string | null
  whatsapp_message_id: string | null
  content_type: string | null
  content_text: string | null
  created_at: string | null
}

/** Payload completo do evento de mensagem (in ou out). */
export interface MessageEventPayload {
  event: MessageEvent
  direction: MessageDirection
  timestamp: string
  account_id: string
  conversation_id: string
  sender: MessageSender
  contact: {
    id: string
    phone: string
    name: string | null
    tags: string[]
    custom_fields: { name: string; value: string }[]
    referral: unknown | null
    ctwa_clid: string | null
  }
  state: ConversationContext['state']
  deal: ConversationContext['deal']
  message: NormalizedMessage
  /** Cru da Meta — só no inbound (aditivo; consumidor atual depende disso). */
  meta?: { message: unknown; contact: unknown; metadata: unknown }
}

/** Monta o payload a partir de identidade + contexto enriquecido + mensagem. */
export function buildMessageEventPayload(args: {
  event: MessageEvent
  direction: MessageDirection
  accountId: string
  conversationId: string
  sender: MessageSender
  contact: { id: string; phone: string; name: string | null }
  context: ConversationContext
  message: NormalizedMessage
  timestamp?: string
  meta?: { message: unknown; contact: unknown; metadata: unknown }
}): MessageEventPayload {
  const payload: MessageEventPayload = {
    event: args.event,
    direction: args.direction,
    timestamp: args.timestamp ?? new Date().toISOString(),
    account_id: args.accountId,
    conversation_id: args.conversationId,
    sender: args.sender,
    contact: {
      id: args.contact.id,
      phone: args.contact.phone,
      name: args.contact.name,
      tags: args.context.contact.tags,
      custom_fields: args.context.contact.custom_fields,
      referral: args.context.contact.referral,
      ctwa_clid: args.context.contact.ctwa_clid,
    },
    state: args.context.state,
    deal: args.context.deal,
    message: args.message,
  }
  // `meta` só entra no inbound (campo opcional; não polui o outbound).
  if (args.meta !== undefined) payload.meta = args.meta
  return payload
}

/** Entrega best-effort. NUNCA lança. O header x-webhook-event reflete o evento. */
export async function dispatchMessageEvent(
  admin: SupabaseClient,
  accountId: string,
  payload: MessageEventPayload,
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
            'x-webhook-event': payload.event,
            'x-webhook-token': ep.secret,
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

// ============================================================
// Aliases de compatibilidade (inbound legado). Mantidos até o T3 migrar a
// chamada do webhook/route.ts pro builder genérico. Depois do T3 podem ser
// removidos, mas não custam nada e protegem qualquer outro consumidor.
// ============================================================

export type MessageReceivedPayload = MessageEventPayload

/** @deprecated use buildMessageEventPayload (mantido pra compatibilidade). */
export function buildMessageReceivedPayload(args: {
  accountId: string
  conversationId: string
  contact: { id: string; phone: string; name: string | null }
  state: { bot_paused: boolean; assigned_agent_id: string | null; conversation_status: string }
  metaMessage: unknown
  metaContact: unknown
  metaMetadata: unknown
}): MessageEventPayload {
  return {
    event: 'message.received',
    direction: 'in',
    timestamp: new Date().toISOString(),
    account_id: args.accountId,
    conversation_id: args.conversationId,
    sender: { type: 'customer', via: 'meta', actor_id: null, actor_name: null, api_key_id: null },
    contact: {
      id: args.contact.id,
      phone: args.contact.phone,
      name: args.contact.name,
      tags: [],
      custom_fields: [],
      referral: null,
      ctwa_clid: null,
    },
    state: {
      bot_paused: args.state.bot_paused,
      conversation_status: args.state.conversation_status,
      assigned_agent_id: args.state.assigned_agent_id,
      assigned_agent_name: null,
      unread_count: null,
      last_message_at: null,
      autoassign_waiting: false,
      created_at: null,
    },
    deal: null,
    message: { id: null, whatsapp_message_id: null, content_type: null, content_text: null, created_at: null },
    meta: { message: args.metaMessage, contact: args.metaContact, metadata: args.metaMetadata },
  }
}

/** @deprecated use dispatchMessageEvent (mantido pra compatibilidade). */
export async function dispatchMessageReceived(
  admin: SupabaseClient,
  accountId: string,
  payload: MessageReceivedPayload,
): Promise<void> {
  return dispatchMessageEvent(admin, accountId, payload)
}

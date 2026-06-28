// ============================================================
// Core de envio de mensagem para uma conversa — compartilhado entre
// a rota de sessão (`/api/whatsapp/send`) e a rota externa autenticada
// por API key (`/api/external/whatsapp/send`).
//
// Por que extrair: as duas rotas precisam exatamente do mesmo fluxo
// "envia na Meta → insere na inbox → atualiza conversa → pausa flow",
// só mudando a forma de autenticar e o client Supabase usado.
//
// SEGURANÇA — isolamento multi-tenant:
//   Toda query de gating filtra EXPLICITAMENTE por `account_id`
//   (conversa, whatsapp_config, template). Isso é obrigatório porque
//   a rota externa passa o client ADMIN (service role, SEM RLS) — não
//   dá pra confiar no RLS pra isolar conta aqui. A inserção em
//   `messages` e o update em `conversations` são por `conversation_id`
//   já validado como pertencente à conta.
//
// Retorna um resultado discriminado (não NextResponse) pra cada rota
// mapear status/erro do seu jeito.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  sendTextMessage,
  sendTemplateMessage,
  sendMediaMessage,
  type MediaKind,
} from '@/lib/whatsapp/meta-api'
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import type { MessageTemplate } from '@/types'
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard'
import { after } from 'next/server'
import { buildConversationContext } from '@/lib/webhooks/enrich'
import { buildMessageEventPayload, dispatchMessageEvent } from '@/lib/webhooks/dispatch'

const MEDIA_KINDS = ['image', 'video', 'document', 'audio'] as const
const VALID_MESSAGE_TYPES = ['text', 'template', ...MEDIA_KINDS] as const

export interface SendMessageInput {
  /** RLS-scoped (sessão) OU admin/service-role (externo). */
  supabase: SupabaseClient
  /** Conta dona da conversa — TODO gating filtra por isto. */
  accountId: string
  conversation_id: string
  message_type: string
  content_text?: string
  media_url?: string
  filename?: string
  template_name?: string
  template_language?: string
  template_params?: unknown[]
  template_message_params?: unknown
  reply_to_message_id?: string
  /** Origem do envio — usada pra montar o bloco `sender` do webhook
   *  message.sent. Opcional: se ausente, o disparo outbound é pulado
   *  (ex.: callers internos que não querem espelhar pro n8n). */
  source?: {
    via: 'inbox' | 'api'
    actor_id?: string | null
    actor_name?: string | null
    api_key_id?: string | null
  }
}

export type SendMessageResult =
  | { ok: true; message_id: string; whatsapp_message_id: string }
  | { ok: false; status: number; error: string }

/**
 * Envia uma mensagem para uma conversa: dispara na Meta (com retry de
 * variantes de telefone), insere em `messages` como `sender_type:'agent'`,
 * atualiza a conversa e pausa qualquer flow ativo do contato.
 */
export async function sendMessageToConversation(
  input: SendMessageInput,
): Promise<SendMessageResult> {
  const {
    supabase,
    accountId,
    conversation_id,
    message_type,
    content_text,
    media_url,
    filename,
    template_name,
    template_language,
    template_params,
    template_message_params,
    reply_to_message_id,
    source,
  } = input

  if (!conversation_id || !message_type) {
    return { ok: false, status: 400, error: 'conversation_id and message_type are required' }
  }

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(message_type)

  if (!(VALID_MESSAGE_TYPES as readonly string[]).includes(message_type)) {
    return { ok: false, status: 400, error: `Unsupported message_type "${message_type}"` }
  }
  if (message_type === 'text' && !content_text) {
    return { ok: false, status: 400, error: 'content_text is required for text messages' }
  }
  if (message_type === 'template' && !template_name) {
    return { ok: false, status: 400, error: 'template_name is required for template messages' }
  }
  if (isMediaKind && !media_url) {
    return { ok: false, status: 400, error: `media_url is required for ${message_type} messages` }
  }
  // Meta caps media captions at 1024 chars (audio carries no caption).
  if (
    isMediaKind &&
    message_type !== 'audio' &&
    typeof content_text === 'string' &&
    content_text.length > 1024
  ) {
    return { ok: false, status: 400, error: 'Caption exceeds the 1024-character limit' }
  }

  // Conversa + contato — escopado por account_id (não confiar só em RLS).
  const { data: conversation, error: convError } = await supabase
    .from('conversations')
    .select('*, contact:contacts(*)')
    .eq('id', conversation_id)
    .eq('account_id', accountId)
    .single()

  if (convError || !conversation) {
    return { ok: false, status: 404, error: 'Conversation not found' }
  }

  const contact = conversation.contact
  if (!contact?.phone) {
    return { ok: false, status: 400, error: 'Contact phone number not found' }
  }

  const sanitizedPhone = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitizedPhone)) {
    return { ok: false, status: 400, error: 'Invalid phone number format' }
  }

  // Config do WhatsApp da conta — também escopado por account_id.
  const { data: config, error: configError } = await supabase
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .single()

  if (configError || !config) {
    return {
      ok: false,
      status: 400,
      error: 'WhatsApp not configured. Please set up your WhatsApp integration first.',
    }
  }

  const accessToken = decrypt(config.access_token)

  // Self-heal de tokens CBC legados (fire-and-forget, idempotente).
  if (isLegacyFormat(config.access_token)) {
    void supabase
      .from('whatsapp_config')
      .update({ access_token: encrypt(accessToken) })
      .eq('id', config.id)
      .then(({ error }) => {
        if (error) {
          console.warn('[whatsapp/send] access_token GCM upgrade failed:', error.message)
        }
      })
  }

  // Resolve o alvo de reply (se houver) ao seu Meta message_id. O pai
  // precisa pertencer à MESMA conversa — senão um caller poderia citar
  // mensagens que não vê chutando UUIDs.
  let contextMessageId: string | undefined
  if (reply_to_message_id) {
    const { data: parent, error: parentError } = await supabase
      .from('messages')
      .select('message_id, conversation_id')
      .eq('id', reply_to_message_id)
      .eq('conversation_id', conversation_id)
      .maybeSingle()

    if (parentError || !parent) {
      return { ok: false, status: 400, error: 'reply_to_message_id not found in this conversation' }
    }
    if (!parent.message_id) {
      console.warn('[whatsapp/send] reply target has no Meta message_id; sending without context')
    } else {
      contextMessageId = parent.message_id
    }
  }

  // Carrega a linha do template (se for envio de template) pra montar
  // header + botões a partir da definição.
  let templateRow: MessageTemplate | null = null
  if (message_type === 'template' && template_name) {
    const { data } = await supabase
      .from('message_templates')
      .select('*')
      .eq('account_id', accountId)
      .eq('name', template_name)
      .eq('language', template_language || 'en_US')
      // Defesa: se houver duplicata residual pré-033, pega o mais recente
      // em vez de deixar o PostgREST lançar "multiple rows".
      .order('last_submitted_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle()
    if (data && !isMessageTemplate(data)) {
      return {
        ok: false,
        status: 500,
        error: 'Template row is malformed locally — run "Sync from Meta" in Settings to repair it.',
      }
    }
    templateRow = data ?? null
  }

  let waMessageId = ''
  let workingPhone = sanitizedPhone

  const attempt = async (phone: string): Promise<string> => {
    if (message_type === 'template') {
      const result = await sendTemplateMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        templateName: template_name as string,
        language: template_language || 'en_US',
        template: templateRow ?? undefined,
        messageParams: (template_message_params as never) ?? undefined,
        params: (template_params as never) || [],
        contextMessageId,
      })
      return result.messageId
    }
    if (isMediaKind) {
      const result = await sendMediaMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        kind: message_type as MediaKind,
        link: media_url as string,
        caption: content_text || undefined,
        filename: filename || undefined,
        contextMessageId,
      })
      return result.messageId
    }
    const result = await sendTextMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      text: content_text as string,
      contextMessageId,
    })
    return result.messageId
  }

  try {
    const variants = phoneVariants(sanitizedPhone)
    let lastError: unknown = null

    for (const variant of variants) {
      try {
        waMessageId = await attempt(variant)
        workingPhone = variant
        lastError = null
        break
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (!isRecipientNotAllowedError(message)) {
          throw err
        }
        lastError = err
        console.warn(`[whatsapp/send] variant "${variant}" rejected by Meta, trying next…`)
      }
    }

    if (lastError) throw lastError
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Meta API error'
    console.error('Meta API send failed for all variants:', message)
    return { ok: false, status: 502, error: `Meta API error: ${message}` }
  }

  // Se uma variante não-original funcionou, corrige o telefone do contato.
  if (workingPhone !== sanitizedPhone) {
    console.log(`[whatsapp/send] Auto-corrected contact phone: ${sanitizedPhone} → ${workingPhone}`)
    await supabase.from('contacts').update({ phone: workingPhone }).eq('id', contact.id)
  }

  // Insere a mensagem na inbox.
  const { data: messageRecord, error: msgError } = await supabase
    .from('messages')
    .insert({
      conversation_id,
      sender_type: 'agent',
      content_type: message_type,
      content_text: content_text || null,
      media_url: media_url || null,
      template_name: template_name || null,
      message_id: waMessageId,
      status: 'sent',
      reply_to_message_id: reply_to_message_id || null,
    })
    .select()
    .single()

  if (msgError) {
    // Detalhe do erro do banco fica só no log do servidor — a mensagem
    // de retorno é genérica pra não vazar internals pra clientes externos
    // (a rota pública /api/v1/messages/send repassa este `error` verbatim).
    console.error('Error inserting sent message:', msgError)
    return {
      ok: false,
      status: 500,
      error: 'Message sent to Meta but failed to save to DB',
    }
  }

  // Atualiza a conversa.
  await supabase
    .from('conversations')
    .update({
      last_message_text: content_text || `[${message_type}]`,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation_id)

  // Pausa qualquer flow ativo do contato — o agente entrando é o sinal
  // mais forte de "humano assumiu". Best-effort via service role.
  try {
    const { error: pauseErr } = await supabaseAdmin()
      .from('flow_runs')
      .update({
        status: 'paused_by_agent',
        ended_at: new Date().toISOString(),
        end_reason: 'agent_replied',
      })
      .eq('account_id', accountId)
      .eq('contact_id', contact.id)
      .eq('status', 'active')
    if (pauseErr) {
      console.error('[flows] pause-on-agent-send failed:', pauseErr.message)
    }
  } catch (err) {
    console.error('[flows] pause-on-agent-send threw:', err instanceof Error ? err.message : err)
  }

  // Webhook outbound (best-effort, NÃO-bloqueante): espelha o envio pro n8n
  // como message.sent. Só dispara quando o caller informa `source` (inbox/api).
  // RODA EM after(): pós-resposta do envio, fora do caminho crítico — não
  // adiciona latência ao 200 (diferente de um await aqui, que somaria até ~10s
  // do timeout do fetch). As 2 rotas que chamam esta função são request
  // handlers, então after() é válido e executa depois de responder.
  // Usa o client ADMIN pro lookup de endpoints/enrich — o client de sessão
  // pode não enxergar webhook_endpoints via RLS (mesmo padrão do inbound).
  // sender.type: inbox = humano respondendo (agent); api = agente n8n (bot).
  // NUNCA derruba o envio: dispatch e enrich são best-effort/nunca-lançam, e
  // o try/catch aqui é defesa extra (após o 200 já enviado).
  if (source) {
    // Captura os valores necessários ANTES do after() (escopo do callback).
    const senderType: 'agent' | 'bot' = source.via === 'inbox' ? 'agent' : 'bot'
    const sentMessage = {
      id: messageRecord.id,
      whatsapp_message_id: waMessageId,
      content_type: messageRecord.content_type ?? message_type,
      content_text: messageRecord.content_text ?? content_text ?? null,
      created_at: messageRecord.created_at ?? null,
    }
    after(async () => {
      try {
        const admin = supabaseAdmin()
        const context = await buildConversationContext(
          admin,
          accountId,
          conversation_id,
          contact.id,
        )
        await dispatchMessageEvent(
          admin,
          accountId,
          buildMessageEventPayload({
            event: 'message.sent',
            direction: 'out',
            accountId,
            conversationId: conversation_id,
            sender: {
              type: senderType,
              via: source.via,
              actor_id: source.actor_id ?? null,
              actor_name: source.actor_name ?? null,
              api_key_id: source.api_key_id ?? null,
            },
            contact: {
              id: contact.id,
              phone: contact.phone,
              name: contact.name ?? null,
            },
            context,
            message: sentMessage,
          }),
        )
      } catch (e) {
        console.warn('[webhooks] outbound message.sent falhou:', e instanceof Error ? e.message : e)
      }
    })
  }

  return { ok: true, message_id: messageRecord.id, whatsapp_message_id: waMessageId }
}

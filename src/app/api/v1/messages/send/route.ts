// ============================================================
// Rota canônica de envio de mensagem WhatsApp via API key.
//
// Autenticada por Bearer token (API key) com escopo messages:send.
// Rate limit por conta (120 req/min). O after() carimba last_used_at
// fora do caminho crítico pra não atrasar a resposta.
//
// Corpo de sucesso idêntico ao legado external/whatsapp/send para
// não quebrar fluxos n8n já configurados:
//   { success: true, message_id: string, whatsapp_message_id: string }
// ============================================================

import { after, NextResponse } from 'next/server'
import { defineRoute, type ResolvedCtx } from '@/lib/api/handler'
import { SendMessageBody } from '@/lib/api/schemas/messages'
import { SCOPE_MESSAGES_SEND } from '@/lib/auth/api-keys'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'

export const POST = defineRoute({
  auth: { type: 'apiKey', scopes: [SCOPE_MESSAGES_SEND] },
  body: SendMessageBody,
  rateLimit: {
    preset: RATE_LIMITS.apiSend,
    // Rate limit escopado por conta da chave — não por usuário individual.
    key: (ctx) =>
      `apiSend:${(ctx as Extract<ResolvedCtx, { auth: 'apiKey' }>).apiKey.accountId}`,
  },
  openapi: {
    summary: 'Enviar mensagem WhatsApp',
    tags: ['Messages'],
    operationId: 'sendMessage',
  },
  handler: async ({ body, ctx }) => {
    const { supabase, accountId, apiKeyId } = (
      ctx as Extract<ResolvedCtx, { auth: 'apiKey' }>
    ).apiKey

    // O helper valida que a conversa pertence à conta da chave (isolamento multi-tenant).
    const result = await sendMessageToConversation({
      supabase,
      accountId,
      conversation_id: body.conversation_id,
      message_type: body.message_type,
      content_text: body.content_text,
      media_url: body.media_url,
      filename: body.filename,
      template_name: body.template_name,
      template_language: body.template_language,
      template_params: body.template_params,
      template_message_params: body.template_message_params,
      reply_to_message_id: body.reply_to_message_id,
      // Origem: agente externo (n8n) via API key. api_key_id permite o n8n
      // filtrar os PRÓPRIOS envios e não entrar em loop. actor_name fica null
      // (ApiKeyContext não carrega o nome da chave — escopo enxuto).
      source: { via: 'api', actor_id: apiKeyId, actor_name: null, api_key_id: apiKeyId },
    })

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    // Carimba last_used_at fora do caminho crítico (after(), igual ao legado).
    after(async () => {
      const { error } = await supabase
        .from('api_keys')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', apiKeyId)
      if (error) console.warn('[v1/messages/send] last_used_at update failed:', error.message)
    })

    return NextResponse.json({
      success: true,
      message_id: result.message_id,
      whatsapp_message_id: result.whatsapp_message_id,
    })
  },
})

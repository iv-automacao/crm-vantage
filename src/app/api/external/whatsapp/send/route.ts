// ============================================================
// Endpoint EXTERNO de envio — autenticado por API key (bearer).
//
// Pensado pra integrações fora do navegador (ex: agente de IA no n8n
// respondendo ao cliente). Difere DELIBERADAMENTE da rota de sessão
// (`/api/whatsapp/send`):
//   - Auth por `Authorization: Bearer <chave>` (não cookie de sessão).
//   - A chave é resolvida pelo SHA-256 (`token_hash`) via service role
//     (que bypassa RLS) — o segredo cru nunca está no banco.
//   - O escopo da conta vem da própria chave (`api_keys.account_id`).
//   - Rate limit por CONTA.
//
// O envio em si reusa `sendMessageToConversation`, então a mensagem
// aparece na inbox (sender_type:'agent') E é entregue via Meta —
// idêntico ao envio manual de um atendente.
// ============================================================

import { NextResponse, after } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import {
  extractBearerToken,
  hashApiKey,
  SCOPE_MESSAGES_SEND,
} from '@/lib/auth/api-keys'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'

export async function POST(request: Request) {
  try {
    // 1) Extrai e valida o bearer token.
    const token = extractBearerToken(request.headers.get('authorization'))
    if (!token) {
      return NextResponse.json(
        { error: 'Missing or malformed Authorization: Bearer <api_key> header' },
        { status: 401 },
      )
    }

    // 2) Resolve a chave pelo hash (service role, sem RLS). Só chaves
    //    ativas (revoked_at IS NULL) valem.
    const admin = supabaseAdmin()
    const tokenHash = hashApiKey(token)
    const { data: apiKey, error: keyError } = await admin
      .from('api_keys')
      .select('id, account_id, scopes, revoked_at')
      .eq('token_hash', tokenHash)
      .is('revoked_at', null)
      .maybeSingle()

    if (keyError) {
      console.error('[external/send] api_keys lookup error:', keyError.message)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
    if (!apiKey) {
      // Mesma resposta pra chave inexistente vs. revogada — não vazar
      // qual das duas.
      return NextResponse.json({ error: 'Invalid API key' }, { status: 401 })
    }

    const accountId = apiKey.account_id as string

    // 3) Escopo — v1 exige messages:send.
    const scopes = (apiKey.scopes as string[] | null) ?? []
    if (!scopes.includes(SCOPE_MESSAGES_SEND)) {
      return NextResponse.json(
        { error: `API key missing required scope '${SCOPE_MESSAGES_SEND}'` },
        { status: 403 },
      )
    }

    // 4) Rate limit por conta.
    const limit = checkRateLimit(`apiSend:${accountId}`, RATE_LIMITS.apiSend)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    // 5) Envia. v1 aceita só conversation_id + texto/mídia/template;
    //    o helper valida que a conversa pertence à conta da chave.
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const result = await sendMessageToConversation({
      // Client admin: o gating por account_id no helper garante o
      // isolamento multi-tenant (não dependemos de RLS aqui).
      supabase: admin,
      accountId,
      conversation_id: body.conversation_id,
      message_type: body.message_type ?? 'text',
      content_text: body.content_text,
      media_url: body.media_url,
      filename: body.filename,
      template_name: body.template_name,
      template_language: body.template_language,
      template_params: body.template_params,
      template_message_params: body.template_message_params,
      reply_to_message_id: body.reply_to_message_id,
    })

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    // 6) Carimba last_used_at (fire-and-forget pós-resposta via after(),
    //    pra não atrasar o retorno nem ser cortado no serverless).
    after(async () => {
      const { error } = await admin
        .from('api_keys')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', apiKey.id)
      if (error) console.warn('[external/send] last_used_at update failed:', error.message)
    })

    return NextResponse.json({
      success: true,
      message_id: result.message_id,
      whatsapp_message_id: result.whatsapp_message_id,
    })
  } catch (error) {
    console.error('Error in external WhatsApp send POST:', error)
    return NextResponse.json({ error: 'Failed to send message' }, { status: 500 })
  }
}

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')
    const { supabase, accountId } = ctx

    // Per-user rate limit. Bucket key é scoped a esta rota para que
    // `/broadcast` tenha budget independente.
    const limit = await checkRateLimit(`send:${ctx.userId}`, RATE_LIMITS.send)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    // Parse defensivo: JSON malformado vira 400, não 500.
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    // Núcleo compartilhado com a rota externa (n8n). Aqui passamos o
    // client RLS-scoped da sessão; o gating por account_id no helper
    // é o mesmo independente do client.
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
      // Origem: humano respondendo pela inbox. actor_id = userId da sessão.
      source: { via: 'inbox', actor_id: ctx.userId, actor_name: null, api_key_id: null },
    })

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    return NextResponse.json({
      success: true,
      message_id: result.message_id,
      whatsapp_message_id: result.whatsapp_message_id,
    })
  } catch (error) {
    console.error('Error in WhatsApp send POST:', error)
    return toErrorResponse(error)
  }
}

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'

export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Per-user rate limit. Bucket key is scoped to this route so
    // `/broadcast` has an independent budget.
    const limit = await checkRateLimit(`send:${user.id}`, RATE_LIMITS.send)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    // Resolve the caller's account_id. Every downstream lookup is
    // account-scoped, so the previous `user_id` filters returned
    // nothing for teammates who didn't author the row.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
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
    return NextResponse.json({ error: 'Failed to send message' }, { status: 500 })
  }
}

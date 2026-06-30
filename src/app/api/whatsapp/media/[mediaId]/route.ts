import { NextResponse } from 'next/server'
import { requireActiveAccount, toErrorResponse } from '@/lib/auth/account'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params

    if (!mediaId) {
      return NextResponse.json({ error: 'Media ID is required' }, { status: 400 })
    }

    const ctx = await requireActiveAccount()
    const { supabase, accountId, userId } = ctx

    // Rate limit por usuário (mais barato primeiro). Trava download em massa
    // sem atrapalhar o inbox (respostas têm Cache-Control: max-age=86400).
    const limit = await checkRateLimit(`media:${userId}`, RATE_LIMITS.media)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    // Posse: só serve a mídia se houver uma mensagem DESTA conta que a
    // referencie. media_url guarda a proxy URL com o mediaId
    // (parseMessageContent); a RLS escopa messages→conversations→conta.
    // 0 linhas → 404 (não revela existência).
    const { data: owning } = await supabase
      .from('messages')
      .select('id')
      .eq('media_url', `/api/whatsapp/media/${mediaId}`)
      .limit(1)
    if (!owning || owning.length === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // Config do WhatsApp da conta + descriptografa o token (nunca logar).
    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json({ error: 'WhatsApp not configured' }, { status: 400 })
    }

    const accessToken = decrypt(config.access_token)

    // URL de download na Meta + binário.
    const mediaInfo = await getMediaUrl({ mediaId, accessToken })
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    })

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': contentType || mediaInfo.mimeType || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400',
      },
    })
  } catch (error) {
    console.error('Error in WhatsApp media GET:', error)
    return toErrorResponse(error)
  }
}

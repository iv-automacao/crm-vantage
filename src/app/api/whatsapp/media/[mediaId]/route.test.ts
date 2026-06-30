import { describe, expect, it, vi, beforeEach } from 'vitest'

const requireActiveAccountMock = vi.fn()
vi.mock('@/lib/auth/account', () => ({
  requireActiveAccount: (...a: unknown[]) => requireActiveAccountMock(...a),
  toErrorResponse: (err: { message?: string; status?: number } | null) =>
    new Response(JSON.stringify({ error: err?.message ?? 'err' }), {
      status: err?.status ?? 500, headers: { 'content-type': 'application/json' },
    }),
}))

const checkRateLimitMock = vi.fn()
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...a: unknown[]) => checkRateLimitMock(...a),
  rateLimitResponse: () =>
    new Response(JSON.stringify({ error: 'rate limited' }), { status: 429, headers: { 'content-type': 'application/json' } }),
  RATE_LIMITS: { media: { limit: 240, windowMs: 60_000 } },
}))

const getMediaUrlMock = vi.fn()
const downloadMediaMock = vi.fn()
vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: (...a: unknown[]) => getMediaUrlMock(...a),
  downloadMedia: (...a: unknown[]) => downloadMediaMock(...a),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => `dec:${v}` }))

import { GET } from './route'

// messages: .select('id').eq('media_url', x).limit(1) → {data}
// whatsapp_config: .select('*').eq('account_id', x).single() → {data, error}
function fakeSupabase(cfg: { owning?: unknown[]; config?: unknown }) {
  return {
    from: (t: string) => ({
      select: () => ({
        eq: () => ({
          limit: () => Promise.resolve({ data: t === 'messages' ? (cfg.owning ?? []) : [], error: null }),
          single: () =>
            Promise.resolve({ data: t === 'whatsapp_config' ? (cfg.config ?? null) : null, error: cfg.config ? null : { message: 'x' } }),
        }),
      }),
    }),
  } as never
}

function setCtx(cfg: { owning?: unknown[]; config?: unknown }) {
  requireActiveAccountMock.mockResolvedValue({
    supabase: fakeSupabase(cfg), accountId: 'acc1', userId: 'u1', role: 'agent', email: null,
    account: { id: 'acc1', name: 'X', status: 'active', accountType: null },
  })
}

const params = (mediaId = 'm-1') => ({ params: Promise.resolve({ mediaId }) })

beforeEach(() => {
  requireActiveAccountMock.mockReset()
  checkRateLimitMock.mockReset()
  getMediaUrlMock.mockReset()
  downloadMediaMock.mockReset()
})

describe('GET /api/whatsapp/media/[mediaId] — posse + rate limit', () => {
  it('429 quando estoura o rate limit (sem tocar a Meta)', async () => {
    setCtx({ owning: [{ id: 'msg1' }], config: { access_token: 'enc' } })
    checkRateLimitMock.mockResolvedValueOnce({ success: false })
    const res = await GET(new Request('http://x'), params())
    expect(res.status).toBe(429)
    expect(getMediaUrlMock).not.toHaveBeenCalled()
  })

  it('404 quando nenhuma mensagem da conta referencia o mediaId (sem tocar a Meta)', async () => {
    setCtx({ owning: [], config: { access_token: 'enc' } })
    checkRateLimitMock.mockResolvedValueOnce({ success: true })
    const res = await GET(new Request('http://x'), params())
    expect(res.status).toBe(404)
    expect(getMediaUrlMock).not.toHaveBeenCalled()
  })

  it('200 + binário quando há posse e o download ok', async () => {
    setCtx({ owning: [{ id: 'msg1' }], config: { access_token: 'enc' } })
    checkRateLimitMock.mockResolvedValueOnce({ success: true })
    getMediaUrlMock.mockResolvedValueOnce({ url: 'https://cdn.meta/x', mimeType: 'image/jpeg' })
    downloadMediaMock.mockResolvedValueOnce({ buffer: Buffer.from('abc'), contentType: 'image/jpeg' })
    const res = await GET(new Request('http://x'), params())
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/jpeg')
    expect(getMediaUrlMock).toHaveBeenCalledWith({ mediaId: 'm-1', accessToken: 'dec:enc' })
  })
})

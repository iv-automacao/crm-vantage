import { describe, expect, it, vi, beforeEach } from 'vitest'

const requireRoleMock = vi.fn()
vi.mock('@/lib/auth/account', () => ({
  requireRole: (...a: unknown[]) => requireRoleMock(...a),
  toErrorResponse: (err: { message?: string; status?: number } | null) =>
    new Response(JSON.stringify({ error: err?.message ?? 'err' }), { status: err?.status ?? 500, headers: { 'content-type': 'application/json' } }),
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({ sendTemplateMessage: vi.fn(async () => ({ messageId: 'm-1' })) }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: vi.fn((v: string) => `dec:${v}`) }))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ success: true })),
  rateLimitResponse: () => new Response(null, { status: 429 }),
  RATE_LIMITS: { broadcast: {} },
}))

import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { POST } from './route'

// Fake do ctx.supabase (sessão): config + template configuráveis.
function makeSupabase(cfg: { config?: unknown; template?: unknown }) {
  function from(table: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {
      select: () => b,
      eq: () => b,
      single: () => Promise.resolve({ data: table === 'whatsapp_config' ? cfg.config ?? null : null, error: cfg.config ? null : { message: 'x' } }),
      maybeSingle: () => Promise.resolve({ data: table === 'message_templates' ? cfg.template ?? null : null, error: null }),
    }
    return b
  }
  return { from } as never
}

const CONFIG = { phone_number_id: 'pn-1', access_token: 'enc' }
const TPL = (status: string) => ({ id: 't1', user_id: 'u1', account_id: 'a1', name: 'promo', language: 'en_US', status, body_text: 'Oi {{1}}', buttons: null, header_type: null, header_text: null, sample_values: null, meta_template_id: null })

function setCtx(cfg: { config?: unknown; template?: unknown }) {
  requireRoleMock.mockResolvedValue({ supabase: makeSupabase(cfg), accountId: 'a1', userId: 'u1', role: 'admin', email: null, account: { id: 'a1', name: 'X', status: 'active', accountType: null } })
}

function req(body: unknown) {
  return new Request('http://x', { method: 'POST', body: JSON.stringify(body) })
}

beforeEach(() => { requireRoleMock.mockReset(); vi.clearAllMocks() })

describe('POST /api/whatsapp/broadcast — selo APPROVED', () => {
  it('422 quando o template local não está APPROVED (sem fan-out)', async () => {
    setCtx({ config: CONFIG, template: TPL('PENDING') })
    const res = await POST(req({ recipients: [{ phone: '5592999999991' }], template_name: 'promo', template_language: 'en_US' }))
    expect(res.status).toBe(422)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('envia quando o template está APPROVED', async () => {
    setCtx({ config: CONFIG, template: TPL('APPROVED') })
    const res = await POST(req({ recipients: [{ phone: '5592999999991' }], template_name: 'promo', template_language: 'en_US' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sent).toBe(1)
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1)
  })

  it('403 quando requireRole rejeita', async () => {
    requireRoleMock.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403 }))
    const res = await POST(req({ recipients: [{ phone: '5592999999991' }], template_name: 'promo' }))
    expect(res.status).toBe(403)
  })
})

import { describe, expect, it, vi, beforeEach } from 'vitest'

const requireActiveAccountMock = vi.fn()
vi.mock('@/lib/auth/account', () => ({
  requireActiveAccount: (...a: unknown[]) => requireActiveAccountMock(...a),
  toErrorResponse: (err: { message?: string; status?: number } | null) =>
    new Response(JSON.stringify({ error: err?.message ?? 'err' }), {
      status: err?.status ?? 500, headers: { 'content-type': 'application/json' },
    }),
}))

import { GET } from './route'

function activeCtx() {
  return {
    supabase: {} as never,
    userId: 'u1', accountId: 'acc1', role: 'agent', email: null,
    account: { id: 'acc1', name: 'X', status: 'active', accountType: null },
  }
}

beforeEach(() => requireActiveAccountMock.mockReset())

describe('GET /api/flows/templates — muro de conta ativa', () => {
  it('403 quando a conta está pending/suspended', async () => {
    requireActiveAccountMock.mockRejectedValueOnce(Object.assign(new Error('Account is not active'), { status: 403 }))
    const res = await GET()
    expect(res.status).toBe(403)
  })

  it('200 + galeria de templates quando ativo', async () => {
    requireActiveAccountMock.mockResolvedValueOnce(activeCtx())
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.templates)).toBe(true)
    expect(body.templates.length).toBeGreaterThan(0)
  })
})

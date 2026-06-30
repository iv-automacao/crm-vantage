import { describe, expect, it, vi, beforeEach } from 'vitest'

const requireActiveAccountMock = vi.fn()
vi.mock('@/lib/auth/account', () => ({
  requireActiveAccount: (...a: unknown[]) => requireActiveAccountMock(...a),
  requireRole: vi.fn(),
  toErrorResponse: (err: { message?: string; status?: number } | null) =>
    new Response(JSON.stringify({ error: err?.message ?? 'err' }), {
      status: err?.status ?? 500,
      headers: { 'content-type': 'application/json' },
    }),
}))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: vi.fn() }))

import { GET } from './route'

function fakeSupabase(rows: unknown[]) {
  return {
    from: () => ({ select: () => ({ order: () => Promise.resolve({ data: rows, error: null }) }) }),
  } as never
}

function activeCtx(rows: unknown[]) {
  return {
    supabase: fakeSupabase(rows),
    userId: 'u1', accountId: 'acc1', role: 'agent', email: null,
    account: { id: 'acc1', name: 'X', status: 'active', accountType: null },
  }
}

beforeEach(() => requireActiveAccountMock.mockReset())

describe('GET /api/flows — muro de conta ativa', () => {
  it('403 quando a conta está pending/suspended', async () => {
    requireActiveAccountMock.mockRejectedValueOnce(Object.assign(new Error('Account is not active'), { status: 403 }))
    const res = await GET()
    expect(res.status).toBe(403)
  })

  it('200 + lista quando a conta está ativa', async () => {
    requireActiveAccountMock.mockResolvedValueOnce(activeCtx([{ id: 'f1' }]))
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ flows: [{ id: 'f1' }] })
  })
})

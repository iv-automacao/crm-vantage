import { describe, expect, it, vi, beforeEach } from 'vitest'

const requireRoleMock = vi.fn()
vi.mock('@/lib/auth/account', () => ({
  requireRole: (...a: unknown[]) => requireRoleMock(...a),
  toErrorResponse: () => new Response(null, { status: 500 }),
}))

let evRow: Record<string, unknown> | null = null
let updateError: unknown = null
const updateSpy = vi.fn()
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: evRow, error: null }) }) }),
      update: (payload: unknown) => {
        updateSpy(payload)
        return { eq: () => Promise.resolve({ error: updateError }) }
      },
    }),
  }),
}))

import { POST } from './route'

function call(id = 'e1') {
  return POST(new Request('http://localhost'), { params: Promise.resolve({ id }) })
}

beforeEach(() => {
  requireRoleMock.mockResolvedValue({ accountId: 'a1', userId: 'u1', role: 'admin' })
  evRow = null
  updateError = null
  updateSpy.mockReset()
})

describe('POST resend capi event', () => {
  it('404 quando o evento não existe', async () => {
    evRow = null
    const res = await call()
    expect(res.status).toBe(404)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('404 quando o evento é de outra conta', async () => {
    evRow = { id: 'e1', account_id: 'OUTRA', status: 'failed', claimed_at: null }
    const res = await call()
    expect(res.status).toBe(404)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('409 quando já está pending (na fila)', async () => {
    evRow = { id: 'e1', account_id: 'a1', status: 'pending', claimed_at: null }
    const res = await call()
    expect(res.status).toBe(409)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('409 quando está em voo (claimado há <5min)', async () => {
    evRow = { id: 'e1', account_id: 'a1', status: 'failed', claimed_at: new Date().toISOString() }
    const res = await call()
    expect(res.status).toBe(409)
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('reenfileira um failed não-em-voo (200 + reset)', async () => {
    evRow = { id: 'e1', account_id: 'a1', status: 'failed', claimed_at: null }
    const res = await call()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(updateSpy).toHaveBeenCalledWith({ status: 'pending', attempts: 0, last_error: null, claimed_at: null })
  })

  it('reenfileira um sent (resend forçado consciente)', async () => {
    evRow = { id: 'e1', account_id: 'a1', status: 'sent', claimed_at: null }
    const res = await call()
    expect(res.status).toBe(200)
    expect(updateSpy).toHaveBeenCalledWith({ status: 'pending', attempts: 0, last_error: null, claimed_at: null })
  })

  it('reenfileira um claim expirado (claimado há >5min)', async () => {
    evRow = { id: 'e1', account_id: 'a1', status: 'failed', claimed_at: new Date(Date.now() - 10 * 60 * 1000).toISOString() }
    const res = await call()
    expect(res.status).toBe(200)
    expect(updateSpy).toHaveBeenCalled()
  })
})

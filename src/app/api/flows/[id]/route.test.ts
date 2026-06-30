import { describe, expect, it, vi, beforeEach } from 'vitest'

const requireActiveAccountMock = vi.fn()
vi.mock('@/lib/auth/account', () => ({
  requireActiveAccount: (...a: unknown[]) => requireActiveAccountMock(...a),
  requireRole: vi.fn(),
  toErrorResponse: (err: { message?: string; status?: number } | null) =>
    new Response(JSON.stringify({ error: err?.message ?? 'err' }), {
      status: err?.status ?? 500, headers: { 'content-type': 'application/json' },
    }),
}))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: vi.fn() }))

import { GET } from './route'

// flows.select().eq().maybeSingle() + flow_nodes.select().eq().order()
function fakeSupabase(flow: unknown, nodes: unknown[]) {
  return {
    from: (t: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: t === 'flows' ? flow : null, error: null }),
          order: () => Promise.resolve({ data: t === 'flow_nodes' ? nodes : [], error: null }),
        }),
      }),
    }),
  } as never
}

function activeCtx(flow: unknown, nodes: unknown[]) {
  return {
    supabase: fakeSupabase(flow, nodes),
    userId: 'u1', accountId: 'acc1', role: 'agent', email: null,
    account: { id: 'acc1', name: 'X', status: 'active', accountType: null },
  }
}

const params = (id = 'f1') => ({ params: Promise.resolve({ id }) })

beforeEach(() => requireActiveAccountMock.mockReset())

describe('GET /api/flows/[id] — muro de conta ativa', () => {
  it('403 quando a conta está pending/suspended', async () => {
    requireActiveAccountMock.mockRejectedValueOnce(Object.assign(new Error('Account is not active'), { status: 403 }))
    const res = await GET(new Request('http://x'), params())
    expect(res.status).toBe(403)
  })

  it('404 quando o flow não é visível (RLS)', async () => {
    requireActiveAccountMock.mockResolvedValueOnce(activeCtx(null, []))
    const res = await GET(new Request('http://x'), params())
    expect(res.status).toBe(404)
  })

  it('200 + {flow, nodes} quando ativo e flow existe', async () => {
    requireActiveAccountMock.mockResolvedValueOnce(activeCtx({ id: 'f1', name: 'Fluxo' }, [{ id: 'n1' }]))
    const res = await GET(new Request('http://x'), params())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ flow: { id: 'f1', name: 'Fluxo' }, nodes: [{ id: 'n1' }] })
  })
})

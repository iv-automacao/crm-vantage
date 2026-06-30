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

// flows.select().eq().maybeSingle(); flow_runs.select().eq().order().limit();
// flow_run_events.select().in().order()
function fakeSupabase(flow: unknown, runs: unknown[], events: unknown[]) {
  return {
    from: (t: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: t === 'flows' ? flow : null, error: null }),
          order: () => ({ limit: () => Promise.resolve({ data: t === 'flow_runs' ? runs : [], error: null }) }),
        }),
        in: () => ({ order: () => Promise.resolve({ data: t === 'flow_run_events' ? events : [], error: null }) }),
      }),
    }),
  } as never
}

function activeCtx(flow: unknown, runs: unknown[], events: unknown[]) {
  return {
    supabase: fakeSupabase(flow, runs, events),
    userId: 'u1', accountId: 'acc1', role: 'agent', email: null,
    account: { id: 'acc1', name: 'X', status: 'active', accountType: null },
  }
}

const params = (id = 'f1') => ({ params: Promise.resolve({ id }) })

beforeEach(() => requireActiveAccountMock.mockReset())

describe('GET /api/flows/[id]/runs — muro de conta ativa', () => {
  it('403 quando a conta está pending/suspended', async () => {
    requireActiveAccountMock.mockRejectedValueOnce(Object.assign(new Error('Account is not active'), { status: 403 }))
    const res = await GET(new Request('http://x'), params())
    expect(res.status).toBe(403)
  })

  it('404 quando o flow não é visível', async () => {
    requireActiveAccountMock.mockResolvedValueOnce(activeCtx(null, [], []))
    const res = await GET(new Request('http://x'), params())
    expect(res.status).toBe(404)
  })

  it('200 + {flow, runs, events} quando ativo', async () => {
    requireActiveAccountMock.mockResolvedValueOnce(activeCtx({ id: 'f1', name: 'F' }, [{ id: 'r1' }], []))
    const res = await GET(new Request('http://x'), params())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.flow).toEqual({ id: 'f1', name: 'F' })
    expect(body.runs).toEqual([{ id: 'r1' }])
  })
})

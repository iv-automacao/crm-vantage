import { describe, expect, it, vi, beforeEach } from 'vitest'

const requireRoleMock = vi.fn()
vi.mock('@/lib/auth/account', () => ({
  requireRole: (...a: unknown[]) => requireRoleMock(...a),
  toErrorResponse: (err: { message?: string; status?: number } | null) =>
    new Response(JSON.stringify({ error: err?.message ?? 'err' }), {
      status: err?.status ?? 500,
      headers: { 'content-type': 'application/json' },
    }),
}))

// GUARD: qualquer uso de service-role explode o teste.
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: vi.fn(() => {
    throw new Error('service-role NÃO deve ser usado nesta rota')
  }),
}))

import { POST } from './route'

function makeSupabase(
  cfg: { original?: unknown | null; copy?: unknown; steps?: unknown[] } = {},
) {
  const rec = {
    inserts: [] as Array<{ table: string; payload: unknown }>,
    eqs: [] as Array<[string, unknown]>,
  }
  function from(table: string) {
    let verb = 'select'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {
      select: () => b,
      eq: (c: string, v: unknown) => {
        rec.eqs.push([c, v])
        return b
      },
      order: () => b,
      insert: (p: unknown) => {
        verb = 'insert'
        rec.inserts.push({ table, payload: p })
        return b
      },
      maybeSingle: () =>
        Promise.resolve({ data: table === 'automations' ? cfg.original ?? null : null, error: null }),
      single: () =>
        Promise.resolve({ data: cfg.copy ?? null, error: cfg.copy ? null : { message: 'fail' } }),
      then: (onF: (v: unknown) => unknown) => {
        const res =
          verb === 'insert'
            ? { error: null }
            : { data: table === 'automation_steps' ? cfg.steps ?? [] : [], error: null }
        return Promise.resolve(res).then(onF)
      },
    }
    return b
  }
  return { client: { from } as never, rec }
}

function setCtx(cfg: { original?: unknown | null; copy?: unknown; steps?: unknown[] } = {}) {
  const { client, rec } = makeSupabase(cfg)
  requireRoleMock.mockResolvedValue({
    supabase: client,
    userId: 'u1',
    accountId: 'acc1',
    role: 'admin',
    email: null,
    account: { id: 'acc1', name: 'X', status: 'active', accountType: null },
  })
  return rec
}

const params = (id = 'a1') => ({ params: Promise.resolve({ id }) })

beforeEach(() => requireRoleMock.mockReset())

describe('POST /api/automations/[id]/duplicate', () => {
  it('404 quando a origem não é visível (RLS / inexistente)', async () => {
    setCtx({ original: null })
    const res = await POST(new Request('http://x', { method: 'POST' }), params())
    expect(res.status).toBe(404)
  })

  it('201 + cópia na conta do caller, sem service-role', async () => {
    const rec = setCtx({
      original: {
        id: 'a1',
        account_id: 'acc1',
        name: 'Auto',
        description: 'd',
        trigger_type: 'message',
        trigger_config: {},
      },
      copy: { id: 'copy1', name: 'Auto (Copy)' },
      steps: [
        { id: 's1', parent_step_id: null, branch: null, step_type: 'send', step_config: {}, position: 0 },
      ],
    })
    const res = await POST(new Request('http://x', { method: 'POST' }), params())
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ automation: { id: 'copy1', name: 'Auto (Copy)' } })
    // cópia inserida na conta do caller (não por referência crua ao original)
    const autoInsert = rec.inserts.find((i) => i.table === 'automations')
    expect(autoInsert?.payload).toMatchObject({ account_id: 'acc1', user_id: 'u1', is_active: false })
    // steps copiados pro id da cópia
    const stepInsert = rec.inserts.find((i) => i.table === 'automation_steps')
    expect(Array.isArray(stepInsert?.payload)).toBe(true)
    expect((stepInsert?.payload as Array<{ automation_id: string }>)[0].automation_id).toBe('copy1')
  })

  it('403 quando requireRole rejeita', async () => {
    // mockRejectedValueOnce (não ...Value): com `clearMocks: true` + reset de
    // mock único, a versão persistente vaza unhandled-rejection no Vitest 4.
    requireRoleMock.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403 }))
    const res = await POST(new Request('http://x', { method: 'POST' }), params())
    expect(res.status).toBe(403)
  })
})

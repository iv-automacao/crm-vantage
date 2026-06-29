import { describe, expect, it, vi, beforeEach } from 'vitest'

const requireActiveAccountMock = vi.fn()
const requireRoleMock = vi.fn()
vi.mock('@/lib/auth/account', () => ({
  requireActiveAccount: (...a: unknown[]) => requireActiveAccountMock(...a),
  requireRole: (...a: unknown[]) => requireRoleMock(...a),
  toErrorResponse: (err: { message?: string; status?: number } | null) =>
    new Response(JSON.stringify({ error: err?.message ?? 'err' }), {
      status: err?.status ?? 500,
      headers: { 'content-type': 'application/json' },
    }),
}))

// Helpers de steps mockados → não tocam service-role nem banco.
vi.mock('@/lib/automations/steps-tree', () => ({
  loadStepsTree: vi.fn(async () => []),
  replaceSteps: vi.fn(async () => null),
}))

vi.mock('@/lib/automations/validate', () => ({
  validateTriggerForActivation: () => [],
  validateStepsForActivation: () => [],
}))

// GUARD: qualquer uso de service-role nesta rota explode o teste.
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: vi.fn(() => {
    throw new Error('service-role NÃO deve ser usado nesta rota')
  }),
}))

import { GET, PATCH, DELETE } from './route'

// Fake do client de sessão (ctx.supabase). A RLS é server-side; aqui
// simulamos "permitido" devolvendo a linha e "negado/inexistente"
// devolvendo null/vazio.
function makeSupabase(
  cfg: { automation?: unknown | null; deleteReturn?: unknown[]; updateError?: unknown } = {},
) {
  const rec = {
    eqs: [] as Array<[string, unknown]>,
    updatePayload: undefined as unknown,
    deleteCalled: false,
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
      update: (p: unknown) => {
        verb = 'update'
        rec.updatePayload = p
        return b
      },
      delete: () => {
        verb = 'delete'
        rec.deleteCalled = true
        return b
      },
      maybeSingle: () =>
        Promise.resolve({ data: table === 'automations' ? cfg.automation ?? null : null, error: null }),
      then: (onF: (v: unknown) => unknown) => {
        const res =
          verb === 'delete'
            ? { data: cfg.deleteReturn ?? [], error: null }
            : verb === 'update'
              ? { error: cfg.updateError ?? null }
              : { data: [], error: null }
        return Promise.resolve(res).then(onF)
      },
    }
    return b
  }
  return { client: { from } as never, rec }
}

function setCtx(
  cfg: { automation?: unknown | null; deleteReturn?: unknown[]; updateError?: unknown } = {},
  role = 'admin',
) {
  const { client, rec } = makeSupabase(cfg)
  const ctx = {
    supabase: client,
    userId: 'u1',
    accountId: 'acc1',
    role,
    email: null,
    account: { id: 'acc1', name: 'X', status: 'active', accountType: null },
  }
  requireActiveAccountMock.mockResolvedValue(ctx)
  requireRoleMock.mockResolvedValue(ctx)
  return rec
}

const params = (id = 'a1') => ({ params: Promise.resolve({ id }) })
const noUserIdFilter = (rec: { eqs: Array<[string, unknown]> }) =>
  expect(rec.eqs.find(([c]) => c === 'user_id')).toBeUndefined()

beforeEach(() => {
  requireActiveAccountMock.mockReset()
  requireRoleMock.mockReset()
})

describe('GET /api/automations/[id]', () => {
  it('200 com {automation, steps} quando a RLS devolve a linha', async () => {
    const rec = setCtx({ automation: { id: 'a1', name: 'Auto' } })
    const res = await GET(new Request('http://x'), params())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ automation: { id: 'a1', name: 'Auto' }, steps: [] })
    expect(requireActiveAccountMock).toHaveBeenCalled()
    noUserIdFilter(rec)
  })

  it('404 quando a RLS não devolve a linha (outra conta / inexistente)', async () => {
    setCtx({ automation: null })
    const res = await GET(new Request('http://x'), params())
    expect(res.status).toBe(404)
  })
})

describe('PATCH /api/automations/[id]', () => {
  it('404 quando a RLS esconde a automação', async () => {
    setCtx({ automation: null })
    const res = await PATCH(
      new Request('http://x', { method: 'PATCH', body: JSON.stringify({ name: 'novo' }) }),
      params(),
    )
    expect(res.status).toBe(404)
  })

  it('200 + update via ctx.supabase quando admin (sem filtro user_id)', async () => {
    const rec = setCtx({
      automation: { id: 'a1', is_active: false, trigger_type: 'message', trigger_config: {} },
    })
    const res = await PATCH(
      new Request('http://x', { method: 'PATCH', body: JSON.stringify({ name: 'novo nome' }) }),
      params(),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(requireRoleMock).toHaveBeenCalledWith('admin')
    expect(rec.updatePayload).toMatchObject({ name: 'novo nome' })
    noUserIdFilter(rec)
  })

  it('403 quando requireRole rejeita (não-admin)', async () => {
    // mockRejectedValueOnce (não ...Value): com `clearMocks: true` + reset de
    // mock único, a versão persistente vaza unhandled-rejection no Vitest 4.
    requireRoleMock.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403 }))
    const res = await PATCH(
      new Request('http://x', { method: 'PATCH', body: JSON.stringify({ name: 'x' }) }),
      params(),
    )
    expect(res.status).toBe(403)
  })
})

describe('DELETE /api/automations/[id]', () => {
  it('200 quando a RLS apaga a linha', async () => {
    const rec = setCtx({ deleteReturn: [{ id: 'a1' }] })
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), params())
    expect(res.status).toBe(200)
    expect(rec.deleteCalled).toBe(true)
    noUserIdFilter(rec)
  })

  it('404 quando nada foi apagado (RLS bloqueou / inexistente)', async () => {
    setCtx({ deleteReturn: [] })
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), params())
    expect(res.status).toBe(404)
  })
})

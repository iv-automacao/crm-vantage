# `automations/[id]` tenancy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer as rotas `automations/[id]` (GET/PATCH/DELETE) e `[id]/duplicate` usarem o client de sessão RLS-scoped (`ctx.supabase`) em vez de service-role + filtro manual `user_id`, escopando por conta (não por criador).

**Architecture:** A RLS de `automations` já está correta (017/032: select=membro, write=admin+) e o `requireRole`/`requireActiveAccount` já devolve o client RLS-scoped (`ctx.supabase`). As rotas só param de contornar a RLS: trocam `supabaseAdmin()` + `.eq('user_id', …)` por `ctx.supabase`. Sem migration.

**Tech Stack:** Next.js (App Router) + Supabase (client de sessão SSR / RLS) + Vitest. Sem libs novas.

**Spec:** `docs/superpowers/specs/2026-06-28-automations-id-tenancy-design.md`
**Auditoria:** `docs/auditoria/2026-06-28-conflitos-webhooks-apis.md` (item #4).

## Global Constraints

- Comentários de código em **português**.
- Nunca `git add -A` — sempre caminhos explícitos.
- `npx tsc --noEmit` limpo. Lint: não introduzir novos errors/warnings nos arquivos tocados (baseline = 3 errors / ~25 problems pré-existentes; não mexer em warnings legados).
- **Nenhuma migration** — não tocar em banco. A RLS necessária já existe.
- GET = `requireActiveAccount()` (qualquer membro ativo). PATCH/DELETE/duplicate = `requireRole('admin')`.
- Os helpers de steps (`loadStepsTree`/`replaceSteps`) ficam como estão (service-role internos); só rodam **depois** da verificação RLS da automação.
- As rotas tocadas **não** devem mais importar nem chamar `supabaseAdmin` — o teste mocka `supabaseAdmin` pra lançar se chamado.

---

### Task 1: `[id]/route.ts` (GET/PATCH/DELETE) via client de sessão

**Files:**
- Modify: `src/app/api/automations/[id]/route.ts` (reescreve os 3 handlers; remove `requireUser`/`supabaseAdmin`/filtros `user_id`)
- Test: `src/app/api/automations/[id]/route.test.ts` (novo)

**Interfaces:**
- Consumes: `requireActiveAccount`, `requireRole`, `toErrorResponse` (`@/lib/auth/account`); `loadStepsTree`, `replaceSteps`, `BuilderStepInput` (`@/lib/automations/steps-tree`); `validateTriggerForActivation`, `validateStepsForActivation` (`@/lib/automations/validate`).
- Produces: nada (rotas terminais).

- [ ] **Step 1: Escrever o teste (RED)**

Criar `src/app/api/automations/[id]/route.test.ts`:

```ts
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
    requireRoleMock.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }))
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
```

- [ ] **Step 2: Rodar o teste pra ver falhar (RED)**

Run: `npx vitest run "src/app/api/automations/[id]/route.test.ts"`
Expected: FALHA — a rota atual chama `supabaseAdmin()` (o mock-guard lança) e o GET usa `requireUser()`/`createClient` em vez de `requireActiveAccount`.

- [ ] **Step 3: Reescrever a rota (GREEN)**

Substituir TODO o conteúdo de `src/app/api/automations/[id]/route.ts` por:

```ts
import { NextResponse } from 'next/server'
import {
  loadStepsTree,
  replaceSteps,
  type BuilderStepInput,
} from '@/lib/automations/steps-tree'
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from '@/lib/automations/validate'
import { requireActiveAccount, requireRole, toErrorResponse } from '@/lib/auth/account'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Qualquer membro ativo da conta lê (consistente com a lista). A RLS
    // (automations_select) faz o escopo por conta — sem filtro user_id.
    const { supabase } = await requireActiveAccount()
    const { id } = await params

    const { data: automation, error } = await supabase
      .from('automations')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    if (error) {
      console.error('[GET /api/automations/[id]] DB error:', error.message)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
    if (!automation) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const steps = await loadStepsTree(id)
    return NextResponse.json({ automation, steps })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // admin+ da conta (RLS automations_update = admin). ctx.supabase é o
    // client de sessão RLS-scoped — sem service-role, sem filtro user_id.
    const { supabase } = await requireRole('admin')
    const { id } = await params

    const body = await request.json().catch(() => null)
    if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

    // Ownership pela RLS: se a linha não for visível/editável pra este admin,
    // o SELECT volta vazio → 404. Carrega os campos pra computar o estado
    // "efetivo" pós-patch na validação de ativação.
    const { data: existing } = await supabase
      .from('automations')
      .select('id, is_active, trigger_type, trigger_config')
      .eq('id', id)
      .maybeSingle()
    if (!existing) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const update: Record<string, unknown> = {}
    for (const k of [
      'name',
      'description',
      'trigger_type',
      'trigger_config',
      'is_active',
    ] as const) {
      if (k in body) update[k] = body[k]
    }

    // Se o PATCH deixa a automação ativa (ativando OU editando uma já ativa),
    // valida a config mergeada antes. Rascunhos podem ficar incompletos.
    const willBeActive =
      typeof update.is_active === 'boolean' ? update.is_active : existing.is_active
    if (willBeActive) {
      const mergedTriggerType = (update.trigger_type ?? existing.trigger_type) as string
      const mergedTriggerConfig = update.trigger_config ?? existing.trigger_config
      const mergedSteps = Array.isArray(body.steps)
        ? (body.steps as { step_type: string; step_config: Record<string, unknown> }[])
        : await loadStepsTree(id)
      const issues = [
        ...validateTriggerForActivation(mergedTriggerType, mergedTriggerConfig),
        ...validateStepsForActivation(mergedSteps),
      ]
      if (issues.length > 0) {
        return NextResponse.json(
          { error: 'Cannot keep automation active with invalid configuration', issues },
          { status: 400 },
        )
      }
    }

    if (Object.keys(update).length > 0) {
      const { error: updErr } = await supabase
        .from('automations')
        .update(update)
        .eq('id', id)
      if (updErr) {
        console.error('[PATCH /api/automations/[id]] update error:', updErr.message)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
      }
    }

    if (Array.isArray(body.steps)) {
      const err = await replaceSteps(id, body.steps as BuilderStepInput[])
      if (err) {
        console.error('[PATCH /api/automations/[id]] replaceSteps error:', err)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
      }
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase } = await requireRole('admin')
    const { id } = await params

    // RLS (automations_delete = admin+). .select('id') confirma se algo foi
    // de fato apagado — 0 linhas = inexistente / fora da conta → 404.
    const { data, error } = await supabase
      .from('automations')
      .delete()
      .eq('id', id)
      .select('id')
    if (error) {
      console.error('[DELETE /api/automations/[id]] delete error:', error.message)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
    if (!data || data.length === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
```

- [ ] **Step 4: Rodar o teste (GREEN)**

Run: `npx vitest run "src/app/api/automations/[id]/route.test.ts"`
Expected: 6 PASS.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: sem erros.

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/automations/[id]/route.ts" "src/app/api/automations/[id]/route.test.ts"
git commit -m "fix(automations): [id] via client de sessão (RLS), não service-role (#4)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `[id]/duplicate/route.ts` via client de sessão

**Files:**
- Modify: `src/app/api/automations/[id]/duplicate/route.ts` (tudo via `ctx.supabase`; remove `supabaseAdmin`)
- Test: `src/app/api/automations/[id]/duplicate/route.test.ts` (novo)

**Interfaces:**
- Consumes: `requireRole`, `toErrorResponse` (`@/lib/auth/account`).
- Produces: nada.

- [ ] **Step 1: Escrever o teste (RED)**

Criar `src/app/api/automations/[id]/duplicate/route.test.ts`:

```ts
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
    requireRoleMock.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }))
    const res = await POST(new Request('http://x', { method: 'POST' }), params())
    expect(res.status).toBe(403)
  })
})
```

- [ ] **Step 2: Rodar o teste pra ver falhar (RED)**

Run: `npx vitest run "src/app/api/automations/[id]/duplicate/route.test.ts"`
Expected: FALHA — a rota atual chama `supabaseAdmin()` (o mock-guard lança).

- [ ] **Step 3: Reescrever a rota (GREEN)**

Substituir TODO o conteúdo de `src/app/api/automations/[id]/duplicate/route.ts` por:

```ts
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // admin+ da conta. ctx.supabase é o client de sessão RLS-scoped — origem,
    // cópia e steps passam pela RLS (escopo por conta, não por criador).
    const { supabase, userId, accountId } = await requireRole('admin')
    const { id } = await params

    const { data: original, error: origErr } = await supabase
      .from('automations')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    if (origErr) {
      console.error('[POST automations/[id]/duplicate] origin error:', origErr.message)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
    if (!original) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // Cópia na MESMA conta do caller (admin verificado). RLS insert = admin+.
    const { data: copy, error: copyErr } = await supabase
      .from('automations')
      .insert({
        account_id: accountId,
        user_id: userId,
        name: `${original.name} (Copy)`,
        description: original.description,
        trigger_type: original.trigger_type,
        trigger_config: original.trigger_config,
        is_active: false,
      })
      .select()
      .single()
    if (copyErr || !copy) {
      console.error('[POST automations/[id]/duplicate] copy error:', copyErr?.message ?? 'unknown')
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }

    const { data: steps } = await supabase
      .from('automation_steps')
      .select('id, parent_step_id, branch, step_type, step_config, position')
      .eq('automation_id', id)
      .order('position', { ascending: true })

    if (steps && steps.length > 0) {
      // Re-mapeia parent_step_id: monta o mapa old→new id primeiro pra o
      // segundo passe inserir com as referências corretas.
      const idMap = new Map<string, string>()
      const uid = () =>
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : Math.random().toString(36).slice(2) + Date.now().toString(36)
      for (const row of steps) idMap.set(row.id as string, uid())

      const rows = steps.map((row) => ({
        id: idMap.get(row.id as string)!,
        automation_id: copy.id,
        parent_step_id: row.parent_step_id ? idMap.get(row.parent_step_id as string) : null,
        branch: row.branch,
        step_type: row.step_type,
        step_config: row.step_config,
        position: row.position,
      }))
      const { error: insErr } = await supabase.from('automation_steps').insert(rows)
      if (insErr) {
        console.error('[POST automations/[id]/duplicate] steps insert error:', insErr.message)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
      }
    }

    return NextResponse.json({ automation: copy }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
```

- [ ] **Step 4: Rodar o teste (GREEN)**

Run: `npx vitest run "src/app/api/automations/[id]/duplicate/route.test.ts"`
Expected: 3 PASS.

- [ ] **Step 5: Typecheck + lint + suíte + guardrail**

Run: `npx tsc --noEmit && npm run lint && npx vitest run`
Expected: `tsc` limpo; lint sem novos problemas nos arquivos tocados (baseline 3 errors / ~25 problems); suíte completa verde (inclui `route-auth-guard.test.ts` — GET usa `requireActiveAccount`, mutações usam `requireRole`).

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/automations/[id]/duplicate/route.ts" "src/app/api/automations/[id]/duplicate/route.test.ts"
git commit -m "fix(automations): duplicate via client de sessão (RLS) (#4)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Pós-execução

1. **Sem migration** — nada a aplicar no banco.
2. Review final de branch (opus) → PR `iv-automacao/crm-vantage` (base main). Merge a critério do Iago.
3. Pós-merge: atualizar a auditoria (#4 → ✅) e a memória `crm-vantage-rbac`.

## Self-review (writing-plans)

- **Cobertura do spec:** GET via `requireActiveAccount` + `ctx.supabase` (T1) ✓; PATCH/DELETE via `requireRole('admin')` + `ctx.supabase`, sem `user_id`/`supabaseAdmin`, DELETE 404 quando 0 linhas (T1) ✓; duplicate 100% via `ctx.supabase`, cópia na conta do caller (T2) ✓; guard de `supabaseAdmin`-lança nos dois testes ✓; sem migration ✓; helpers de steps intactos ✓.
- **Placeholders:** nenhum — todo passo tem código/comando completo.
- **Consistência de tipos:** `requireActiveAccount`/`requireRole` devolvem `{ supabase, userId, accountId, ... }` (AccountContext); os handlers desestruturam só o que usam; resposta de cada handler preservada (`{automation, steps}` / `{ok:true}` / `{automation}` 201). Mock de `toErrorResponse` idêntico nos dois testes.

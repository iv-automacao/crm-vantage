# Gate de aprovação nos GETs de flows/automations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pôr o muro de conta-ativa (`requireActiveAccount()`) nos 5 GETs de flows/automations que hoje usam `auth.getUser()` cru, pra conta `pending`/`suspended` parar de conseguir ler.

**Architecture:** Trocar o gate fraco pelo `requireActiveAccount()` (que devolve o MESMO client de sessão SSR em `ctx.supabase`) — só adiciona o muro 403 na frente; zero mudança no escopo RLS. Mutações e helpers usados por elas ficam intactos. Sem migration.

**Tech Stack:** Next.js (App Router) + Supabase (client de sessão SSR/RLS) + Vitest.

**Spec:** `docs/superpowers/specs/2026-06-30-approval-gate-gets-design.md`
**Auditoria:** `docs/auditoria/2026-06-28-conflitos-webhooks-apis.md` (item #7).

## Global Constraints

- Comentários de código em **português**.
- Nunca `git add -A` — caminhos explícitos.
- `npx tsc --noEmit` limpo; `npm run lint` sem novos problemas nos arquivos tocados (baseline 3 errors / ~25 problems).
- **Nenhuma migration.** Mesmo client de sessão (RLS), só o gate na frente — sem mudança de escopo de dados.
- `requireActiveAccount()` NÃO exige papel mínimo → viewer/agent ativos seguem lendo. Só pending/suspended → 403.
- Mutações (POST/PUT/DELETE) e os helpers `requireUser`/`requireOwnership` (usados por elas) **não** mudam.

---

### Task 1: gate nas listas (automations + flows)

**Files:**
- Modify: `src/app/api/automations/route.ts` (só o `GET`)
- Modify: `src/app/api/flows/route.ts` (só o `GET`)
- Test: `src/app/api/automations/route.test.ts` (novo)
- Test: `src/app/api/flows/route.test.ts` (novo)

**Interfaces:**
- Consumes: `requireActiveAccount`/`toErrorResponse` (`@/lib/auth/account`) — `requireActiveAccount()` resolve `{ supabase, userId, accountId, role, ... }` ou lança `AccountPendingError` (status 403) / `UnauthorizedError` (401).
- Produces: nada.

- [ ] **Step 1: Escrever os testes (RED)**

Criar `src/app/api/automations/route.test.ts`:

```ts
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
// admin-client é importado no módulo (usado só pelo POST) — mock pra import seguro.
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: vi.fn() }))

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

describe('GET /api/automations — muro de conta ativa', () => {
  it('403 quando a conta está pending/suspended', async () => {
    requireActiveAccountMock.mockRejectedValueOnce(Object.assign(new Error('Account is not active'), { status: 403 }))
    const res = await GET()
    expect(res.status).toBe(403)
  })

  it('200 + lista quando a conta está ativa', async () => {
    requireActiveAccountMock.mockResolvedValueOnce(activeCtx([{ id: 'a1' }]))
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ automations: [{ id: 'a1' }] })
  })
})
```

Criar `src/app/api/flows/route.test.ts`:

```ts
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
```

- [ ] **Step 2: Rodar os testes pra ver falhar (RED)**

Run: `npx vitest run src/app/api/automations/route.test.ts src/app/api/flows/route.test.ts`
Expected: FALHA — os GETs atuais usam `createClient()`/`auth.getUser()` (não chamam `requireActiveAccount`), então o caso pending não dá 403 (e o `createClient` real tenta `cookies()` fora de request → erro).

- [ ] **Step 3: Trocar o gate no GET de `automations/route.ts`**

No topo, no import de auth, adicionar `requireActiveAccount`:
```ts
import { requireActiveAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
```
Remover o import agora órfão `import { createClient } from '@/lib/supabase/server'` (o GET era o único uso; o POST usa `supabaseAdmin`).

Substituir TODO o handler `GET` por:
```ts
export async function GET() {
  try {
    // Muro de conta ativa: pending/suspended não lê (mesmo client de sessão →
    // RLS segue escopando por conta).
    const { supabase } = await requireActiveAccount()
    const { data, error } = await supabase
      .from('automations')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) {
      console.error('[GET /api/automations] DB error:', error.message)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
    return NextResponse.json({ automations: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}
```

- [ ] **Step 4: Trocar o gate no GET de `flows/route.ts`**

No import de auth, adicionar `requireActiveAccount`:
```ts
import { requireActiveAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
```
(NÃO remover o `createClient` — o helper `requireUser()` usado pelo POST ainda depende dele.)

Substituir TODO o handler `GET` por:
```ts
export async function GET() {
  try {
    const { supabase } = await requireActiveAccount()
    const { data, error } = await supabase
      .from('flows')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ flows: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}
```

- [ ] **Step 5: Rodar os testes (GREEN)**

Run: `npx vitest run src/app/api/automations/route.test.ts src/app/api/flows/route.test.ts`
Expected: 4 PASS.

- [ ] **Step 6: Typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: `tsc` sem erros; lint sem novos problemas nos arquivos tocados.

- [ ] **Step 7: Commit**

```bash
git add "src/app/api/automations/route.ts" "src/app/api/automations/route.test.ts" "src/app/api/flows/route.ts" "src/app/api/flows/route.test.ts"
git commit -m "fix(auth): muro de conta ativa nos GET de lista de automations/flows (#7)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: gate nos GETs de flows/[id], runs e templates

**Files:**
- Modify: `src/app/api/flows/[id]/route.ts` (só o `GET`)
- Modify: `src/app/api/flows/[id]/runs/route.ts` (`GET`)
- Modify: `src/app/api/flows/templates/route.ts` (`GET`)
- Test: `src/app/api/flows/[id]/route.test.ts`, `src/app/api/flows/[id]/runs/route.test.ts`, `src/app/api/flows/templates/route.test.ts` (novos)

**Interfaces:**
- Consumes: `requireActiveAccount`/`toErrorResponse` (`@/lib/auth/account`).
- Produces: nada.

- [ ] **Step 1: Escrever os testes (RED)**

Criar `src/app/api/flows/[id]/route.test.ts`:

```ts
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
```

Criar `src/app/api/flows/[id]/runs/route.test.ts`:

```ts
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
```

Criar `src/app/api/flows/templates/route.test.ts`:

```ts
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
```

- [ ] **Step 2: Rodar os testes pra ver falhar (RED)**

Run: `npx vitest run "src/app/api/flows/[id]/route.test.ts" "src/app/api/flows/[id]/runs/route.test.ts" "src/app/api/flows/templates/route.test.ts"`
Expected: FALHA — os GETs atuais não chamam `requireActiveAccount` (caso pending não dá 403; e `createClient()` real tenta `cookies()` fora de request).

- [ ] **Step 3: Trocar o gate no GET de `flows/[id]/route.ts`**

No import de auth, adicionar `requireActiveAccount`:
```ts
import { requireActiveAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
```
(NÃO remover `createClient` — o helper `requireOwnership()` usado por PUT/DELETE ainda depende dele.)

Substituir TODO o handler `GET` por:
```ts
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  try {
    const { supabase } = await requireActiveAccount()
    const [{ data: flow }, { data: nodes }] = await Promise.all([
      supabase.from('flows').select('*').eq('id', id).maybeSingle(),
      supabase
        .from('flow_nodes')
        .select('*')
        .eq('flow_id', id)
        .order('created_at', { ascending: true }),
    ])
    if (!flow) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    return NextResponse.json({ flow, nodes: nodes ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}
```

- [ ] **Step 4: Reescrever `flows/[id]/runs/route.ts`**

Substituir TODO o conteúdo do arquivo por:
```ts
import { NextResponse } from 'next/server'
import { requireActiveAccount, toErrorResponse } from '@/lib/auth/account'

/**
 * GET /api/flows/[id]/runs — lista os runs (mais recentes primeiro) de um
 * flow com o timeline de eventos embutido. Exige conta ativa; a RLS faz o
 * escopo de posse (404 se o flow não for visível). Limite de 50 runs.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  try {
    const { supabase } = await requireActiveAccount()

    // Confirma que o flow existe + é visível (RLS) antes da query de runs —
    // 404 limpo em vez de lista vazia.
    const { data: flow } = await supabase
      .from('flows')
      .select('id, name')
      .eq('id', id)
      .maybeSingle()
    if (!flow) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const { data: runs, error: runsErr } = await supabase
      .from('flow_runs')
      .select(
        'id, status, current_node_key, started_at, last_advanced_at, ended_at, end_reason, vars, reprompt_count, contact:contacts(id, name, phone)',
      )
      .eq('flow_id', id)
      .order('started_at', { ascending: false })
      .limit(50)
    if (runsErr) {
      return NextResponse.json({ error: runsErr.message }, { status: 500 })
    }

    const runIds = (runs ?? []).map((r) => (r as { id: string }).id)
    let events: Array<{
      flow_run_id: string
      event_type: string
      node_key: string | null
      payload: Record<string, unknown>
      created_at: string
    }> = []
    if (runIds.length > 0) {
      const { data: evs, error: evsErr } = await supabase
        .from('flow_run_events')
        .select('flow_run_id, event_type, node_key, payload, created_at')
        .in('flow_run_id', runIds)
        .order('created_at', { ascending: true })
      if (evsErr) {
        // Não-fatal — a página ainda mostra os runs sem timeline.
        console.error('[flows-runs] events fetch failed:', evsErr.message)
      } else if (evs) {
        events = evs as typeof events
      }
    }

    return NextResponse.json({ flow, runs: runs ?? [], events })
  } catch (err) {
    return toErrorResponse(err)
  }
}
```

- [ ] **Step 5: Reescrever `flows/templates/route.ts`**

Substituir TODO o conteúdo do arquivo por:
```ts
import { NextResponse } from 'next/server'
import { listFlowTemplates } from '@/lib/flows/templates'
import { requireActiveAccount, toErrorResponse } from '@/lib/auth/account'

/**
 * GET /api/flows/templates — galeria estática de templates (slug + name +
 * description + icon + node_count) pro diálogo de novo flow. Exige conta
 * ativa (sem leitura de banco — só o muro de aprovação).
 */
export async function GET() {
  try {
    await requireActiveAccount()
    const templates = listFlowTemplates().map((t) => ({
      slug: t.slug,
      name: t.name,
      description: t.description,
      icon: t.icon,
      trigger_type: t.trigger_type,
      node_count: t.nodes.length,
    }))
    return NextResponse.json({ templates })
  } catch (err) {
    return toErrorResponse(err)
  }
}
```

- [ ] **Step 6: Rodar os testes (GREEN)**

Run: `npx vitest run "src/app/api/flows/[id]/route.test.ts" "src/app/api/flows/[id]/runs/route.test.ts" "src/app/api/flows/templates/route.test.ts"`
Expected: 8 PASS.

- [ ] **Step 7: Typecheck + lint + suíte completa + guardrail**

Run: `npx tsc --noEmit && npm run lint && npx vitest run`
Expected: `tsc` limpo; lint sem novos problemas; suíte completa verde (inclui `route-auth-guard.test.ts` — os GETs agora têm `requireActiveAccount` = AUTH_MARKER).

- [ ] **Step 8: Commit**

```bash
git add "src/app/api/flows/[id]/route.ts" "src/app/api/flows/[id]/route.test.ts" "src/app/api/flows/[id]/runs/route.ts" "src/app/api/flows/[id]/runs/route.test.ts" "src/app/api/flows/templates/route.ts" "src/app/api/flows/templates/route.test.ts"
git commit -m "fix(auth): muro de conta ativa nos GET de flows/[id], runs e templates (#7)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Pós-execução

1. **Sem migration** — nada a aplicar no banco.
2. Review final de branch (opus) → PR `iv-automacao/crm-vantage` (base main). Merge a critério do Iago.
3. Pós-merge: atualizar a auditoria (#7 → ✅) e a memória `crm-vantage-account-approval-gate`.

## Self-review (writing-plans)

- **Cobertura do spec:** os 5 GETs (automations lista T1; flows lista T1; flows/[id] T2; flows/[id]/runs T2; flows/templates T2) ✓; `requireActiveAccount` + `ctx.supabase` ✓; sem mudança de papel (mock usa `role: 'agent'` ativo → 200) ✓; mutações/helpers intactos (só o GET muda em cada arquivo) ✓; sem migration ✓.
- **Placeholders:** nenhum — todo passo tem código/comando completo.
- **Consistência de tipos:** mock de `toErrorResponse` idêntico em todos os testes (mapeia `err.status`); `requireActiveAccount` resolve o shape `{ supabase, userId, accountId, role, email, account }` (AccountContext) usado por todos; fakes de supabase batem com as chamadas reais de cada GET (`select().order()`; `select().eq().maybeSingle()`+`select().eq().order()`; `+ .limit()` e `.in().order()`).

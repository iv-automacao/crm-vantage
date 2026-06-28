# CAPI — claim atômico + resend guard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminar o duplo-envio de conversões CAPI pra Meta, via claim atômico por linha na fila `capi_events` + guard no resend manual.

**Architecture:** Lock por coluna `claimed_at` (compare-and-set `UPDATE ... WHERE ... RETURNING`) que expira em 5min — só uma execução fica com cada linha; linha presa por crash volta elegível sozinha. O resend manual passa a recusar (409) eventos que estão na fila (`pending`) ou em voo (claimados há <5min).

**Tech Stack:** Next.js (App Router) + Supabase (service-role/`supabaseAdmin`) + Vitest. Sem libs novas.

**Spec:** `docs/superpowers/specs/2026-06-28-capi-claim-atomico-design.md`
**Auditoria:** `docs/auditoria/2026-06-28-conflitos-webhooks-apis.md` (item #2).

## Global Constraints

- Comentários de código em **português**.
- Nunca `git add -A` — sempre `git add` com caminhos explícitos.
- Lint baseline = **3 errors** (`npm run lint` reporta ~25 problems: 3 errors + ~22 warnings pré-existentes, todos alheios ao CAPI). Não introduzir novos errors/warnings nos arquivos tocados; **não** "consertar" warnings legados. `npx tsc --noEmit` limpo.
- Migration aplicada **manualmente** pelo Iago no SQL Editor (MCP sem escrita) **antes** do merge/deploy. Não rodar migration por aqui.
- `capi_events.status` é TEXT livre (sem CHECK) — não introduzir novos valores de status nesta feature; o lock é por `claimed_at`, não por status.
- TTL do claim = `5 * 60 * 1000` ms, exportado de `src/lib/capi/dispatch.ts` como `CAPI_CLAIM_TTL_MS` e reusado no resend (fonte única).
- Claim/dispatch **best-effort**: erro num evento não derruba o lote.

---

### Task 1: Claim atômico no dispatch + migration 037

**Files:**
- Create: `supabase/migrations/037_capi_claim.sql`
- Modify: `src/lib/capi/dispatch.ts` (reescreve `processPendingCapiEvents`; +const `CAPI_CLAIM_TTL_MS`)
- Test: `src/lib/capi/dispatch.test.ts` (reescreve o fake admin pra ser claim-aware; +3 testes)

**Interfaces:**
- Consumes: `sendConversionEvent` (`./client`), `decryptCapiToken` (`./crypto`), `MAX_CAPI_ATTEMPTS`.
- Produces: `export const CAPI_CLAIM_TTL_MS = 5 * 60 * 1000` (consumido pela Task 2). `processPendingCapiEvents(admin, limit=50): Promise<CapiDispatchResult>` — assinatura inalterada.

- [ ] **Step 1: Criar a migration 037**

Criar `supabase/migrations/037_capi_claim.sql`:

```sql
-- 037: claim atômico da fila CAPI. Lock por claimed_at que expira sozinho,
-- evitando duplo-envio quando dois processos pegam a mesma linha. O claim é
-- por id (PK), então não precisa de índice novo.
ALTER TABLE capi_events ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
```

- [ ] **Step 2: Reescrever o teste (RED) com fake admin claim-aware**

Substituir TODO o conteúdo de `src/lib/capi/dispatch.test.ts` por:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendMock = vi.fn()
vi.mock('./client', () => ({ sendConversionEvent: (...a: unknown[]) => sendMock(...a) }))

import { processPendingCapiEvents } from './dispatch'

// Admin Supabase falso, table-aware, ciente do claim atômico.
// - select().or().order().limit()  → lista (<tabela>:list)
// - select().eq().maybeSingle()    → linha única (<tabela>:one)
// - update().eq()                  → update terminal (await direto; grava em `updates`)
// - update().eq().in().or().select().maybeSingle() → claim (resultado em `claimResults`)
function makeAdmin(
  tables: Record<string, unknown>,
  claimResults?: Array<{ id: string } | null>,
) {
  const updates: Record<string, unknown[]> = {}
  const claims: Array<{ payload: Record<string, unknown>; statusIn?: unknown; or?: string }> = []
  let claimIdx = 0

  function from(table: string) {
    return {
      select: () => ({
        or: () => ({
          order: () => ({
            limit: () => Promise.resolve({ data: tables[`${table}:list`] ?? [], error: null }),
          }),
        }),
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: tables[`${table}:one`] ?? null, error: null }),
        }),
      }),
      update: (payload: Record<string, unknown>) => {
        const rec: { payload: Record<string, unknown>; statusIn?: unknown; or?: string } = { payload }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const claimChain: any = {
          in: (_c: string, vals: unknown) => { rec.statusIn = vals; return claimChain },
          or: (f: string) => { rec.or = f; return claimChain },
          select: () => claimChain,
          maybeSingle: () => {
            claims.push(rec)
            const r = claimResults ? (claimResults[claimIdx++] ?? null) : { id: table }
            return Promise.resolve({ data: r, error: null })
          },
        }
        // .eq() serve aos dois caminhos: terminal (await direto) e claim (encadeia .in)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const eqResult: any = {
          ...claimChain,
          then: (onF: (v: { error: null }) => unknown) => {
            ;(updates[table] ??= []).push(payload)
            return Promise.resolve({ error: null }).then(onF)
          },
        }
        return { eq: () => eqResult }
      },
    }
  }
  return { admin: { from } as never, updates, claims }
}

beforeEach(() => sendMock.mockReset())

describe('processPendingCapiEvents', () => {
  const ev = { id: 'e1', account_id: 'a1', deal_id: 'd1', contact_id: 'c1', value: 1500, currency: 'BRL', attempts: 0, created_at: '2026-06-25T12:00:00Z' }

  it('envia e marca sent quando conta ativa + contato com ctwa_clid', async () => {
    sendMock.mockResolvedValue({ ok: true, status: 200, body: { events_received: 1 } })
    const { admin, updates } = makeAdmin({
      'capi_events:list': [ev],
      'capi_settings:one': { dataset_id: 'ds', access_token: 'tok', event_name: 'Purchase', is_active: true },
      'contacts:one': { ctwa_clid: 'clid_1' },
      'whatsapp_config:one': { waba_id: 'waba_9' },
    })
    const res = await processPendingCapiEvents(admin)
    expect(res).toEqual({ processed: 1, sent: 1, skipped: 0, failed: 0 })
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'd1', ctwaClid: 'clid_1', wabaId: 'waba_9', eventTimeUnix: 1782388800 }))
    expect(updates['capi_events'][0]).toMatchObject({ status: 'sent', attempts: 1 })
  })

  it('marca skipped/capi_inactive quando conta sem CAPI ativo', async () => {
    const { admin, updates } = makeAdmin({ 'capi_events:list': [ev], 'capi_settings:one': { is_active: false } })
    const res = await processPendingCapiEvents(admin)
    expect(res.skipped).toBe(1)
    expect(updates['capi_events'][0]).toMatchObject({ status: 'skipped', last_error: 'capi_inactive' })
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('marca skipped/no_ctwa_clid quando contato sem click-id', async () => {
    const { admin, updates } = makeAdmin({
      'capi_events:list': [ev],
      'capi_settings:one': { dataset_id: 'ds', access_token: 'tok', event_name: 'Purchase', is_active: true },
      'contacts:one': { ctwa_clid: null },
    })
    const res = await processPendingCapiEvents(admin)
    expect(res.skipped).toBe(1)
    expect(updates['capi_events'][0]).toMatchObject({ status: 'skipped', last_error: 'no_ctwa_clid' })
  })

  it('marca failed + incrementa attempts quando a Meta rejeita', async () => {
    sendMock.mockResolvedValue({ ok: false, status: 400, body: { error: 'bad' } })
    const { admin, updates } = makeAdmin({
      'capi_events:list': [{ ...ev, attempts: 2 }],
      'capi_settings:one': { dataset_id: 'ds', access_token: 'tok', event_name: 'Purchase', is_active: true },
      'contacts:one': { ctwa_clid: 'clid_1' },
      'whatsapp_config:one': { waba_id: null },
    })
    const res = await processPendingCapiEvents(admin)
    expect(res.failed).toBe(1)
    expect(updates['capi_events'][0]).toMatchObject({ status: 'failed', attempts: 3, last_error: 'http_400' })
  })

  // ── Novos: claim atômico ──────────────────────────────────────────────

  it('não envia quando o claim falha (linha já pega por outra execução)', async () => {
    sendMock.mockResolvedValue({ ok: true, status: 200, body: {} })
    const { admin, updates } = makeAdmin(
      {
        'capi_events:list': [ev],
        'capi_settings:one': { dataset_id: 'ds', access_token: 'tok', event_name: 'Purchase', is_active: true },
        'contacts:one': { ctwa_clid: 'clid_1' },
      },
      [null], // claim retorna null → contenção
    )
    const res = await processPendingCapiEvents(admin)
    expect(res).toEqual({ processed: 0, sent: 0, skipped: 0, failed: 0 })
    expect(sendMock).not.toHaveBeenCalled()
    expect(updates['capi_events']).toBeUndefined()
  })

  it('failed zera claimed_at pra a linha voltar elegível', async () => {
    sendMock.mockResolvedValue({ ok: false, status: 400, body: { error: 'bad' } })
    const { admin, updates } = makeAdmin({
      'capi_events:list': [{ ...ev, attempts: 2 }],
      'capi_settings:one': { dataset_id: 'ds', access_token: 'tok', event_name: 'Purchase', is_active: true },
      'contacts:one': { ctwa_clid: 'clid_1' },
      'whatsapp_config:one': { waba_id: null },
    })
    await processPendingCapiEvents(admin)
    expect(updates['capi_events'][0]).toMatchObject({ status: 'failed', attempts: 3, claimed_at: null })
  })

  it('emite o claim com claimed_at + filtro de expiração antes de enviar', async () => {
    sendMock.mockResolvedValue({ ok: true, status: 200, body: {} })
    const { admin, claims } = makeAdmin({
      'capi_events:list': [ev],
      'capi_settings:one': { dataset_id: 'ds', access_token: 'tok', event_name: 'Purchase', is_active: true },
      'contacts:one': { ctwa_clid: 'clid_1' },
      'whatsapp_config:one': { waba_id: 'waba_9' },
    })
    await processPendingCapiEvents(admin)
    expect(claims).toHaveLength(1)
    expect(typeof claims[0].payload.claimed_at).toBe('string')
    expect(claims[0].statusIn).toEqual(['pending', 'failed'])
    expect(claims[0].or).toContain('claimed_at.is.null')
    expect(claims[0].or).toContain('claimed_at.lt.')
  })
})
```

- [ ] **Step 3: Rodar os testes pra ver os novos falharem (RED)**

Run: `npx vitest run src/lib/capi/dispatch.test.ts`
Expected: os 3 testes novos FALHAM (o `dispatch.ts` atual não faz claim → `sendMock` é chamado na contenção, `claimed_at` ausente no failed, `claims` vazio). Os 4 antigos ainda passam.

- [ ] **Step 4: Implementar o claim no dispatch (GREEN)**

Substituir TODO o conteúdo de `src/lib/capi/dispatch.ts` por:

```ts
// Processa a fila `capi_events`: resolve credencial da conta + ctwa_clid do
// contato, envia a conversão pra Meta e atualiza o status. Chamado pelo cron.
import type { SupabaseClient } from '@supabase/supabase-js'
import { sendConversionEvent } from './client'
import { decryptCapiToken } from './crypto'

export const MAX_CAPI_ATTEMPTS = 5

// TTL do claim: uma linha "em voo" volta elegível depois disso, recuperando
// linhas presas por crash no meio do envio (reaper embutido). Reusado no
// resend manual pra recusar reenfileiramento de linha ainda em processamento.
export const CAPI_CLAIM_TTL_MS = 5 * 60 * 1000

export interface CapiDispatchResult {
  processed: number
  sent: number
  skipped: number
  failed: number
}

/** Resolve o WABA id da conta (best-effort; null se ausente). */
async function resolveWabaId(admin: SupabaseClient, accountId: string): Promise<string | null> {
  const { data } = await admin
    .from('whatsapp_config')
    .select('waba_id')
    .eq('account_id', accountId)
    .maybeSingle()
  return (data?.waba_id as string | undefined) ?? null
}

/**
 * Busca eventos pending/failed (dentro do teto de tentativas), faz o claim
 * atômico de cada linha, resolve credenciais e ctwa_clid, envia pra Meta e
 * atualiza o status. Best-effort: falha num evento não interrompe o lote.
 */
export async function processPendingCapiEvents(
  admin: SupabaseClient,
  limit = 50,
): Promise<CapiDispatchResult> {
  const result: CapiDispatchResult = { processed: 0, sent: 0, skipped: 0, failed: 0 }

  // Seleciona pending OU failed ainda dentro do teto de tentativas.
  const { data: events, error } = await admin
    .from('capi_events')
    .select('id, account_id, deal_id, contact_id, value, currency, attempts, created_at')
    .or(`status.eq.pending,and(status.eq.failed,attempts.lt.${MAX_CAPI_ATTEMPTS})`)
    .order('created_at', { ascending: true })
    .limit(limit)
  if (error) throw error
  if (!events?.length) return result

  for (const ev of events as Array<Record<string, unknown>>) {
    const id = ev.id as string

    // 0. Claim atômico (compare-and-set): só uma execução fica com a linha.
    //    Sob READ COMMITTED, um 2º UPDATE concorrente re-avalia o predicado
    //    pós-commit do 1º e não casa (claimed_at recente) → 0 linhas → pula.
    //    claimed_at expira em CAPI_CLAIM_TTL_MS, então linha presa por crash
    //    volta elegível sozinha.
    const cutoff = new Date(Date.now() - CAPI_CLAIM_TTL_MS).toISOString()
    const { data: claimed } = await admin
      .from('capi_events')
      .update({ claimed_at: new Date().toISOString() })
      .eq('id', id)
      .in('status', ['pending', 'failed'])
      .or(`claimed_at.is.null,claimed_at.lt.${cutoff}`)
      .select('id')
      .maybeSingle()
    if (!claimed) continue // já pego por outra execução (ou em voo) → pula

    result.processed++

    // 1. Config da conta — sem CAPI ativo (dataset_id ou access_token ausentes),
    //    marca como skipped e segue pro próximo.
    const { data: settings } = await admin
      .from('capi_settings')
      .select('dataset_id, access_token, event_name, is_active')
      .eq('account_id', ev.account_id as string)
      .maybeSingle()
    if (!settings?.is_active || !settings.dataset_id || !settings.access_token) {
      await admin
        .from('capi_events')
        .update({ status: 'skipped', last_error: 'capi_inactive' })
        .eq('id', id)
      result.skipped++
      continue
    }

    // 2. ctwa_clid do contato — deal que não veio de anúncio não tem click-id.
    const { data: contact } = await admin
      .from('contacts')
      .select('ctwa_clid')
      .eq('id', ev.contact_id as string)
      .maybeSingle()
    if (!contact?.ctwa_clid) {
      await admin
        .from('capi_events')
        .update({ status: 'skipped', last_error: 'no_ctwa_clid' })
        .eq('id', id)
      result.skipped++
      continue
    }

    // 3. WABA id (best-effort — null se a conta ainda não configurou).
    const wabaId = await resolveWabaId(admin, ev.account_id as string)

    // 4. Envia. event_id = deal_id para dedup estável na Meta; fallback pro
    //    id da linha se deal_id for null. event_time = instante do 'won'.
    const attempts = ((ev.attempts as number) ?? 0) + 1
    const resp = await sendConversionEvent({
      datasetId: settings.dataset_id as string,
      accessToken: decryptCapiToken(settings.access_token as string),
      eventName: (settings.event_name as string) ?? 'Purchase',
      eventId: (ev.deal_id as string) ?? id,
      eventTimeUnix: Math.floor(Date.parse(ev.created_at as string) / 1000),
      ctwaClid: contact.ctwa_clid as string,
      wabaId,
      value: ev.value != null ? Number(ev.value) : null,
      currency: (ev.currency as string) ?? null,
    })

    if (resp.ok) {
      await admin
        .from('capi_events')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          attempts,
          meta_response: resp.body,
          last_error: null,
        })
        .eq('id', id)
      result.sent++
    } else {
      // Falha best-effort — registra o erro HTTP, incrementa tentativas e
      // libera o claim (claimed_at:null) pra a linha voltar elegível.
      await admin
        .from('capi_events')
        .update({
          status: 'failed',
          attempts,
          meta_response: resp.body,
          last_error: `http_${resp.status}`,
          claimed_at: null,
        })
        .eq('id', id)
      result.failed++
    }
  }

  return result
}
```

- [ ] **Step 5: Rodar os testes (GREEN)**

Run: `npx vitest run src/lib/capi/dispatch.test.ts`
Expected: 7 PASS.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: sem erros.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/037_capi_claim.sql src/lib/capi/dispatch.ts src/lib/capi/dispatch.test.ts
git commit -m "feat(capi): claim atômico na fila contra duplo-envio (#2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Resend guard contra reenfileirar evento em voo

**Files:**
- Modify: `src/app/api/account/capi/events/[id]/resend/route.ts`
- Test: `src/app/api/account/capi/events/[id]/resend/route.test.ts` (novo)

**Interfaces:**
- Consumes: `CAPI_CLAIM_TTL_MS` (de `@/lib/capi/dispatch`, Task 1), `requireRole`/`toErrorResponse` (`@/lib/auth/account`), `supabaseAdmin` (`@/lib/flows/admin-client`).
- Produces: nada (rota terminal).

- [ ] **Step 1: Escrever o teste (RED)**

Criar `src/app/api/account/capi/events/[id]/resend/route.test.ts`:

```ts
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
```

- [ ] **Step 2: Rodar o teste pra ver falhar (RED)**

Run: `npx vitest run "src/app/api/account/capi/events/[id]/resend/route.test.ts"`
Expected: FALHA — a rota atual não traz `status`/`claimed_at` nem aplica os guards 409 (os testes de 409 recebem 200; o de pending reenfileira indevidamente).

- [ ] **Step 3: Implementar o guard (GREEN)**

Substituir TODO o conteúdo de `src/app/api/account/capi/events/[id]/resend/route.ts` por:

```ts
// Reenfileira um evento CAPI (volta pra pending, zera attempts). A escrita é
// via service-role (capi_events não tem policy de UPDATE pra membros), mas o
// gate é admin e o ownership é checado por account_id.
//
// Guard contra duplo-envio: NÃO reenfileira um evento que já está na fila
// (pending) ou em voo (claimado há menos de CAPI_CLAIM_TTL_MS) — senão o cron
// poderia mandar a mesma conversão 2× pra Meta.
import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { CAPI_CLAIM_TTL_MS } from '@/lib/capi/dispatch'
import { supabaseAdmin } from '@/lib/flows/admin-client'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params

    const admin = supabaseAdmin()
    // Ownership: só reenvia evento da própria conta.
    const { data: ev } = await admin
      .from('capi_events')
      .select('id, account_id, status, claimed_at')
      .eq('id', id)
      .maybeSingle()
    if (!ev || ev.account_id !== ctx.accountId) {
      return NextResponse.json({ error: 'Evento não encontrado' }, { status: 404 })
    }

    // Já está na fila — nada a fazer.
    if (ev.status === 'pending') {
      return NextResponse.json({ error: 'Evento já está na fila' }, { status: 409 })
    }
    // Em voo — claimado recentemente por uma execução do cron.
    const claimedAt = ev.claimed_at ? Date.parse(ev.claimed_at as string) : null
    const inFlight = claimedAt != null && claimedAt > Date.now() - CAPI_CLAIM_TTL_MS
    if (inFlight) {
      return NextResponse.json(
        { error: 'Evento em processamento, tente novamente em alguns minutos' },
        { status: 409 },
      )
    }

    const { error } = await admin
      .from('capi_events')
      .update({ status: 'pending', attempts: 0, last_error: null, claimed_at: null })
      .eq('id', id)
    if (error) {
      console.error('[POST capi/events/resend] update error:', error)
      return NextResponse.json({ error: 'Falha ao reenfileirar' }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
```

- [ ] **Step 4: Rodar o teste (GREEN)**

Run: `npx vitest run "src/app/api/account/capi/events/[id]/resend/route.test.ts"`
Expected: 7 PASS.

- [ ] **Step 5: Typecheck + lint + suíte completa**

Run: `npx tsc --noEmit && npm run lint && npx vitest run`
Expected: `tsc` limpo; lint **sem novos** errors/warnings nos arquivos tocados (baseline = 3 errors / ~25 problems pré-existentes — não regredir, não mexer em warnings legados); suíte verde (~757 testes).

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/account/capi/events/[id]/resend/route.ts" "src/app/api/account/capi/events/[id]/resend/route.test.ts"
git commit -m "feat(capi): resend guard contra reenfileirar evento em voo (#2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Pós-execução

1. **Iago aplica a migration 037** no SQL Editor do banco dedicado (antes do merge/deploy). Verificação pra colar:
   ```sql
   SELECT EXISTS (
     SELECT 1 FROM information_schema.columns
     WHERE table_name = 'capi_events' AND column_name = 'claimed_at'
   ) AS coluna_claimed_at_existe;
   ```
   Esperado: `true`.

   > **Invariante de concorrência (revisão adversarial):** o claim por `claimed_at` fecha o duplo-envio porque `CAPI_CLAIM_TTL_MS` (5min) ≫ `maxDuration` do cron (60s) ≫ timeout do client HTTP (~10s). Ou seja, nenhuma linha fica "em voo viva" por mais que o TTL — só crash deixa o claim vencer, e aí o re-claim é correto. Pra um POST patologicamente lento (>5min, processo vivo) a última defesa segue sendo o dedup da Meta por `event_id`. Na verificação manual do resend de um `sent`, confirmar no painel/Meta que **não** houve 2ª conversão contada (fecha o loop do dedup).
2. Review final de branch (opus) → PR `iv-automacao/crm-vantage` (base main). Merge a critério do Iago.
3. Atualizar a auditoria (#2 → ✅) e a memória `crm-vantage-capi` após o merge.

## Self-review (writing-plans)

- **Cobertura do spec:** migration 037 (Task 1 Step 1) ✓; claim atômico + `CAPI_CLAIM_TTL_MS` + `processed++` pós-claim + `claimed_at:null` no failed (Task 1) ✓; resend guard 409 pending/em-voo + reset com `claimed_at:null` + permite sent (Task 2) ✓; SELECT do lote inalterado ✓; sem rate-limit/backoff (fora de escopo) ✓.
- **Placeholders:** nenhum — todo passo tem código/comando completo.
- **Consistência de tipos:** `CAPI_CLAIM_TTL_MS` exportado na Task 1 e importado na Task 2; `processPendingCapiEvents` assinatura inalterada; payload do reset idêntico no código e na asserção do teste (`{ status:'pending', attempts:0, last_error:null, claimed_at:null }`).

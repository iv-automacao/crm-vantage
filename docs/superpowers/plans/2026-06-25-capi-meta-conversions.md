# CAPI (CRM → Meta Conversions API) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Devolver conversões de CTWA (negócio ganho) pra Meta via Conversions API, persistindo o `ctwa_clid` do anúncio e disparando o evento de conversão por trigger de banco + cron com retry.

**Architecture:** Captura do `ctwa_clid` no inbound webhook (best-effort, sempre-on) → config CAPI por conta (painel admin) → trigger Postgres `deal.won` enfileira `capi_events` → cron resolve credencial+click-id e faz POST pra Graph API, com status `pending/sent/skipped/failed`, teto de tentativas e reenvio manual.

**Tech Stack:** Next.js 16 (App Router, route handlers), TypeScript, Supabase (service-role + RLS), Zod já presente, vitest 4, Meta Graph API v21.0.

## Global Constraints

- Migrations são `.sql` numeradas e aplicadas **MANUALMENTE** pelo Iago no SQL Editor do Supabase dedicado (`mgmokvpjswtjxhqhnyps`). O implementer **só cria o arquivo**, nunca roda. O MCP do Supabase NÃO tem acesso a esse banco.
- NUNCA `git add -A` (há untracked: `docs/embedded-signup-plan.md`, `supabase/.temp/`). Sempre `git add <arquivos explícitos>`.
- `access_token` do CAPI guardado em texto (admin-only RLS, igual `webhook_endpoints.secret`); **nunca** retornado em GET/list, **nunca** logado, mascarado no painel.
- Toda query de banco filtra por `account_id` (defesa em profundidade além da RLS).
- Comentários de código em **português** (regra VANTAGE).
- `event_id = deal_id` (dedup estável na Meta); `event_time = capi_events.created_at` (instante do won).
- `MAX_CAPI_ATTEMPTS = 5`.
- Graph API base: `https://graph.facebook.com/v21.0`. `action_source: 'business_messaging'`, `messaging_channel: 'whatsapp'`.
- Cron autentica via header `x-cron-secret` vs `process.env.AUTOMATION_CRON_SECRET` (timing-safe, reusa o env existente).
- Captura no inbound e envio no dispatch são **best-effort**: nunca lançam de forma que derrube o webhook/lote.

---

### Task 1: Migrations (027 contato, 028 config, 029 fila+trigger)

**Files:**
- Create: `supabase/migrations/027_contact_referral.sql`
- Create: `supabase/migrations/028_capi_settings.sql`
- Create: `supabase/migrations/029_capi_events.sql`

**Interfaces:**
- Produces (esquema que as tasks seguintes consomem):
  - `contacts.ctwa_clid TEXT`, `contacts.referral JSONB`, `contacts.referral_captured_at TIMESTAMPTZ`
  - `capi_settings(account_id UNIQUE, dataset_id, access_token, event_name DEFAULT 'Purchase', is_active, created_by_user_id, created_at, updated_at)`
  - `capi_events(id, account_id, deal_id, contact_id, event_name DEFAULT 'Purchase', value, currency, status DEFAULT 'pending', attempts DEFAULT 0, last_error, meta_response, created_at, sent_at)`
  - trigger `trg_capi_event_on_deal_won` em `deals` que insere `capi_events` na transição pra `won`.

- [ ] **Step 1: Criar `027_contact_referral.sql`**

```sql
-- 027: captura de atribuição CTWA no contato.
-- Quando um lead clica num anúncio Click-to-WhatsApp, a primeira mensagem
-- inbound traz um objeto `referral` com o `ctwa_clid` (click-id). Guardamos
-- pra, no fechamento do negócio, devolver a conversão pra Meta (CAPI).
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ctwa_clid TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS referral JSONB;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS referral_captured_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_contacts_ctwa_clid
  ON contacts(ctwa_clid) WHERE ctwa_clid IS NOT NULL;
```

- [ ] **Step 2: Criar `028_capi_settings.sql`**

```sql
-- 028: configuração do CAPI por conta (Dataset ID + Access Token + evento).
-- Token guardado em texto (usado pra chamar a Graph API), protegido por
-- RLS admin-only — mesma postura do `webhook_endpoints.secret`.
CREATE TABLE IF NOT EXISTS capi_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  dataset_id TEXT,
  access_token TEXT,
  event_name TEXT NOT NULL DEFAULT 'Purchase',
  is_active BOOLEAN NOT NULL DEFAULT false,
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE capi_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS capi_settings_select ON capi_settings;
CREATE POLICY capi_settings_select ON capi_settings
  FOR SELECT USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS capi_settings_modify ON capi_settings;
CREATE POLICY capi_settings_modify ON capi_settings
  FOR ALL USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
```

- [ ] **Step 3: Criar `029_capi_events.sql`**

```sql
-- 029: fila de conversões CAPI + trigger que enfileira no `deal.won`.
-- A UI marca deal como ganho client-side (via RLS), então o gancho fica
-- no banco pra pegar TODOS os caminhos (kanban, contact-detail, API).
CREATE TABLE IF NOT EXISTS capi_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  event_name TEXT NOT NULL DEFAULT 'Purchase',
  value NUMERIC(12,2),
  currency TEXT,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | sent | skipped | failed
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  meta_response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_capi_events_pending
  ON capi_events(status) WHERE status IN ('pending','failed');
CREATE INDEX IF NOT EXISTS idx_capi_events_account
  ON capi_events(account_id, created_at DESC);

ALTER TABLE capi_events ENABLE ROW LEVEL SECURITY;

-- Só leitura pra admin; escrita exclusivamente via service-role (cron/trigger).
DROP POLICY IF EXISTS capi_events_select ON capi_events;
CREATE POLICY capi_events_select ON capi_events
  FOR SELECT USING (is_account_member(account_id, 'admin'));

-- Enfileira uma conversão quando o deal entra em 'won' (e não estava antes).
CREATE OR REPLACE FUNCTION enqueue_capi_event_on_deal_won() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'won' AND (OLD.status IS DISTINCT FROM 'won') THEN
    INSERT INTO capi_events (account_id, deal_id, contact_id, value, currency)
    VALUES (NEW.account_id, NEW.id, NEW.contact_id, NEW.value, NEW.currency);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_capi_event_on_deal_won ON deals;
CREATE TRIGGER trg_capi_event_on_deal_won
  AFTER UPDATE OF status ON deals
  FOR EACH ROW EXECUTE FUNCTION enqueue_capi_event_on_deal_won();
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/027_contact_referral.sql supabase/migrations/028_capi_settings.sql supabase/migrations/029_capi_events.sql
git commit -m "feat(capi): migrations contato/referral + capi_settings + capi_events com trigger deal.won"
```

> **Nota pro controller:** avisar o Iago pra aplicar 027/028/029 MANUALMENTE no SQL Editor antes do deploy (senão as rotas/cron dão 500). Sem teste automatizado — review da SQL (trigger dispara só na transição, RLS admin-only, índices parciais).

---

### Task 2: Cliente CAPI (POST pra Graph API)

**Files:**
- Create: `src/lib/capi/client.ts`
- Test: `src/lib/capi/client.test.ts`

**Interfaces:**
- Produces:
  - `interface ConversionEvent { datasetId: string; accessToken: string; eventName: string; eventId: string; eventTimeUnix: number; ctwaClid: string; wabaId: string | null; value: number | null; currency: string | null }`
  - `sendConversionEvent(e: ConversionEvent): Promise<{ ok: boolean; status: number; body: unknown }>`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/lib/capi/client.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendConversionEvent, type ConversionEvent } from './client'

const base: ConversionEvent = {
  datasetId: 'ds_123',
  accessToken: 'tok_secret',
  eventName: 'Purchase',
  eventId: 'deal-1',
  eventTimeUnix: 1_700_000_000,
  ctwaClid: 'clid_abc',
  wabaId: 'waba_9',
  value: 1500,
  currency: 'BRL',
}

afterEach(() => vi.restoreAllMocks())

describe('sendConversionEvent', () => {
  it('faz POST pro dataset com o payload CTWA correto', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ events_received: 1 }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await sendConversionEvent(base)

    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://graph.facebook.com/v21.0/ds_123/events')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.access_token).toBe('tok_secret')
    expect(body.data[0]).toMatchObject({
      event_name: 'Purchase',
      event_time: 1_700_000_000,
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      event_id: 'deal-1',
      user_data: { ctwa_clid: 'clid_abc', whatsapp_business_account_id: 'waba_9' },
      custom_data: { currency: 'BRL', value: '1500' },
    })
  })

  it('omite waba_id e custom_data quando ausentes/zerados', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await sendConversionEvent({ ...base, wabaId: null, value: 0 })

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.data[0].user_data).toEqual({ ctwa_clid: 'clid_abc' })
    expect(body.data[0].custom_data).toBeUndefined()
  })

  it('devolve ok=false em erro HTTP sem lançar', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'bad token' } }), { status: 400 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await sendConversionEvent(base)
    expect(res.ok).toBe(false)
    expect(res.status).toBe(400)
  })

  it('devolve ok=false em falha de rede sem lançar', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const res = await sendConversionEvent(base)
    expect(res.ok).toBe(false)
    expect(res.status).toBe(0)
  })
})
```

- [ ] **Step 2: Rodar o teste e ver falhar**

Run: `npx vitest run src/lib/capi/client.test.ts`
Expected: FAIL — `Cannot find module './client'`.

- [ ] **Step 3: Implementar o cliente**

```ts
// src/lib/capi/client.ts
// Cliente da Meta Conversions API (CAPI) para conversões de Click-to-WhatsApp.
// Envia um evento de conversão referenciando o `ctwa_clid` do anúncio.
const GRAPH_API = 'https://graph.facebook.com/v21.0'

export interface ConversionEvent {
  datasetId: string
  accessToken: string
  eventName: string        // ex.: 'Purchase'
  eventId: string          // = deal_id — dedup estável na Meta
  eventTimeUnix: number    // = instante do 'won' (segundos)
  ctwaClid: string
  wabaId: string | null
  value: number | null
  currency: string | null
}

/**
 * Faz POST pro endpoint /{datasetId}/events. Best-effort: nunca lança por
 * erro HTTP ou de rede — devolve `ok` pra o chamador decidir status/retry.
 * O token vai só no corpo; nunca é logado.
 */
export async function sendConversionEvent(
  e: ConversionEvent,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const userData: Record<string, unknown> = { ctwa_clid: e.ctwaClid }
  if (e.wabaId) userData.whatsapp_business_account_id = e.wabaId

  const eventObj: Record<string, unknown> = {
    event_name: e.eventName,
    event_time: e.eventTimeUnix,
    action_source: 'business_messaging',
    messaging_channel: 'whatsapp',
    user_data: userData,
    event_id: e.eventId,
  }
  // Valor só entra quando há montante real — conversão sem valor ainda é
  // sinal válido pra otimização.
  if (e.value != null && e.value > 0) {
    eventObj.custom_data = { currency: e.currency ?? 'BRL', value: String(e.value) }
  }

  const url = `${GRAPH_API}/${encodeURIComponent(e.datasetId)}/events`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: [eventObj], access_token: e.accessToken }),
      signal: AbortSignal.timeout(10_000),
    })
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    return { ok: res.ok, status: res.status, body }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: { error: err instanceof Error ? err.message : 'fetch_failed' },
    }
  }
}
```

- [ ] **Step 4: Rodar o teste e ver passar**

Run: `npx vitest run src/lib/capi/client.test.ts`
Expected: PASS (4 testes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/capi/client.ts src/lib/capi/client.test.ts
git commit -m "feat(capi): cliente da Conversions API (POST /{dataset}/events, best-effort)"
```

---

### Task 3: Captura do `ctwa_clid` no inbound webhook

**Files:**
- Create: `src/lib/capi/referral.ts`
- Test: `src/lib/capi/referral.test.ts`
- Modify: `src/app/api/whatsapp/webhook/route.ts` (engatar no `processMessage`, perto da linha 634 onde já roda `dispatchMessageReceived`)

**Interfaces:**
- Consumes: nenhum (usa o objeto `message` cru da Meta já disponível no `processMessage`).
- Produces: `captureCtwaReferral(admin: SupabaseClient, contactId: string, message: { referral?: { ctwa_clid?: string } | unknown }): Promise<void>`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/lib/capi/referral.test.ts
import { describe, expect, it, vi } from 'vitest'
import { captureCtwaReferral } from './referral'

function fakeAdmin() {
  const update = vi.fn().mockReturnThis()
  const eq = vi.fn().mockResolvedValue({ error: null })
  const from = vi.fn(() => ({ update, eq }))
  return { client: { from } as never, update, eq, from }
}

describe('captureCtwaReferral', () => {
  it('persiste ctwa_clid + referral quando presente', async () => {
    const a = fakeAdmin()
    const message = { referral: { ctwa_clid: 'clid_1', source_id: 'ad_9', headline: 'Promo' } }

    await captureCtwaReferral(a.client, 'contact-1', message)

    expect(a.from).toHaveBeenCalledWith('contacts')
    const payload = a.update.mock.calls[0][0]
    expect(payload.ctwa_clid).toBe('clid_1')
    expect(payload.referral).toEqual(message.referral)
    expect(payload.referral_captured_at).toEqual(expect.any(String))
    expect(a.eq).toHaveBeenCalledWith('id', 'contact-1')
  })

  it('não faz nada quando não há referral/ctwa_clid', async () => {
    const a = fakeAdmin()
    await captureCtwaReferral(a.client, 'contact-1', { text: { body: 'oi' } })
    expect(a.from).not.toHaveBeenCalled()
  })

  it('não lança quando o update falha (best-effort)', async () => {
    const a = fakeAdmin()
    a.eq.mockResolvedValueOnce({ error: { message: 'boom' } })
    await expect(
      captureCtwaReferral(a.client, 'contact-1', { referral: { ctwa_clid: 'clid_1' } }),
    ).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Rodar o teste e ver falhar**

Run: `npx vitest run src/lib/capi/referral.test.ts`
Expected: FAIL — `Cannot find module './referral'`.

- [ ] **Step 3: Implementar o helper**

```ts
// src/lib/capi/referral.ts
// Captura a atribuição de anúncio Click-to-WhatsApp (CTWA) que a Meta envia
// no objeto `referral` da primeira mensagem inbound. Persiste o `ctwa_clid`
// no contato pra, no fechamento do negócio, devolver a conversão (CAPI).
import type { SupabaseClient } from '@supabase/supabase-js'

interface MetaReferral {
  ctwa_clid?: string
  [k: string]: unknown
}

function extractReferral(message: unknown): MetaReferral | null {
  if (!message || typeof message !== 'object') return null
  const referral = (message as { referral?: unknown }).referral
  if (!referral || typeof referral !== 'object') return null
  const clid = (referral as MetaReferral).ctwa_clid
  if (typeof clid !== 'string' || clid.length === 0) return null
  return referral as MetaReferral
}

/**
 * Best-effort: se a mensagem traz um `referral` com `ctwa_clid`, grava no
 * contato (sempre o anúncio mais recente sobrescreve). Nunca lança — não pode
 * derrubar o processamento do webhook.
 */
export async function captureCtwaReferral(
  admin: SupabaseClient,
  contactId: string,
  message: unknown,
): Promise<void> {
  const referral = extractReferral(message)
  if (!referral) return
  try {
    const { error } = await admin
      .from('contacts')
      .update({
        ctwa_clid: referral.ctwa_clid,
        referral,
        referral_captured_at: new Date().toISOString(),
      })
      .eq('id', contactId)
    if (error) console.warn('[capi] captura de referral falhou:', error.message)
  } catch (err) {
    console.warn('[capi] captura de referral lançou:', err)
  }
}
```

- [ ] **Step 4: Rodar o teste e ver passar**

Run: `npx vitest run src/lib/capi/referral.test.ts`
Expected: PASS (3 testes).

- [ ] **Step 5: Engatar no webhook**

Em `src/app/api/whatsapp/webhook/route.ts`, adicionar o import junto aos outros (perto da linha 10):

```ts
import { captureCtwaReferral } from '@/lib/capi/referral'
```

E logo após o bloco `await dispatchMessageReceived(...)` (que termina por volta da linha 644), antes do `// Update conversation`, inserir:

```ts
  // Captura de atribuição CTWA (best-effort): se o lead veio de um anúncio
  // Click-to-WhatsApp, guarda o `ctwa_clid` no contato pra devolver a
  // conversão pra Meta quando o negócio fechar (CAPI).
  await captureCtwaReferral(supabaseAdmin(), contactRecord.id, message)
```

- [ ] **Step 6: Rodar typecheck + a suíte do webhook**

Run: `npx tsc --noEmit && npx vitest run src/lib/capi/referral.test.ts`
Expected: typecheck limpo; testes PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/capi/referral.ts src/lib/capi/referral.test.ts src/app/api/whatsapp/webhook/route.ts
git commit -m "feat(capi): captura ctwa_clid do referral no inbound webhook (best-effort)"
```

---

### Task 4: Dispatch (fila → Graph API) + cron

**Files:**
- Create: `src/lib/capi/dispatch.ts`
- Test: `src/lib/capi/dispatch.test.ts`
- Create: `src/app/api/capi/cron/route.ts`
- Modify: `vercel.json` (adicionar o cron schedule)

**Interfaces:**
- Consumes: `sendConversionEvent` (Task 2).
- Produces:
  - `const MAX_CAPI_ATTEMPTS = 5`
  - `interface CapiDispatchResult { processed: number; sent: number; skipped: number; failed: number }`
  - `processPendingCapiEvents(admin: SupabaseClient, limit?: number): Promise<CapiDispatchResult>`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/lib/capi/dispatch.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendMock = vi.fn()
vi.mock('./client', () => ({ sendConversionEvent: (...a: unknown[]) => sendMock(...a) }))

import { processPendingCapiEvents } from './dispatch'

// Builder de um admin Supabase falso, table-aware.
function makeAdmin(tables: Record<string, unknown>) {
  const updates: Record<string, unknown[]> = {}
  const admin = {
    from(table: string) {
      const chain: Record<string, unknown> = {}
      const ret = (v: unknown) => Object.assign(chain, v)
      ret({
        select: () => ret({
          or: () => ret({ order: () => ret({ limit: () => Promise.resolve({ data: tables[`${table}:list`] ?? [], error: null }) }) }),
          eq: () => ret({ maybeSingle: () => Promise.resolve({ data: tables[`${table}:one`] ?? null, error: null }) }),
        }),
        update: (payload: unknown) => {
          ;(updates[table] ??= []).push(payload)
          return ret({ eq: () => Promise.resolve({ error: null }) })
        },
      })
      return chain
    },
  }
  return { admin: admin as never, updates }
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
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'd1', ctwaClid: 'clid_1', wabaId: 'waba_9', eventTimeUnix: 1782734400 }))
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
})
```

- [ ] **Step 2: Rodar o teste e ver falhar**

Run: `npx vitest run src/lib/capi/dispatch.test.ts`
Expected: FAIL — `Cannot find module './dispatch'`.

- [ ] **Step 3: Implementar o dispatch**

```ts
// src/lib/capi/dispatch.ts
// Processa a fila `capi_events`: resolve credencial da conta + ctwa_clid do
// contato, envia a conversão pra Meta e atualiza o status. Chamado pelo cron.
import type { SupabaseClient } from '@supabase/supabase-js'
import { sendConversionEvent } from './client'

export const MAX_CAPI_ATTEMPTS = 5

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

export async function processPendingCapiEvents(
  admin: SupabaseClient,
  limit = 50,
): Promise<CapiDispatchResult> {
  const result: CapiDispatchResult = { processed: 0, sent: 0, skipped: 0, failed: 0 }

  // pending OU (failed ainda dentro do teto de tentativas).
  const { data: events, error } = await admin
    .from('capi_events')
    .select('id, account_id, deal_id, contact_id, value, currency, attempts, created_at')
    .or(`status.eq.pending,and(status.eq.failed,attempts.lt.${MAX_CAPI_ATTEMPTS})`)
    .order('created_at', { ascending: true })
    .limit(limit)
  if (error) throw error
  if (!events?.length) return result

  for (const ev of events as Array<Record<string, unknown>>) {
    result.processed++
    const id = ev.id as string

    // 1. Config da conta — sem CAPI ativo, pula.
    const { data: settings } = await admin
      .from('capi_settings')
      .select('dataset_id, access_token, event_name, is_active')
      .eq('account_id', ev.account_id as string)
      .maybeSingle()
    if (!settings?.is_active || !settings.dataset_id || !settings.access_token) {
      await admin.from('capi_events').update({ status: 'skipped', last_error: 'capi_inactive' }).eq('id', id)
      result.skipped++
      continue
    }

    // 2. ctwa_clid do contato — sem click-id, esse deal não veio de anúncio.
    const { data: contact } = await admin
      .from('contacts')
      .select('ctwa_clid')
      .eq('id', ev.contact_id as string)
      .maybeSingle()
    if (!contact?.ctwa_clid) {
      await admin.from('capi_events').update({ status: 'skipped', last_error: 'no_ctwa_clid' }).eq('id', id)
      result.skipped++
      continue
    }

    // 3. WABA id (best-effort).
    const wabaId = await resolveWabaId(admin, ev.account_id as string)

    // 4. Envia. event_id = deal_id (dedup); event_time = instante do won.
    const attempts = ((ev.attempts as number) ?? 0) + 1
    const resp = await sendConversionEvent({
      datasetId: settings.dataset_id as string,
      accessToken: settings.access_token as string,
      eventName: (settings.event_name as string) ?? 'Purchase',
      eventId: (ev.deal_id as string) ?? id,
      eventTimeUnix: Math.floor(new Date(ev.created_at as string).getTime() / 1000),
      ctwaClid: contact.ctwa_clid as string,
      wabaId,
      value: ev.value != null ? Number(ev.value) : null,
      currency: (ev.currency as string) ?? null,
    })

    if (resp.ok) {
      await admin
        .from('capi_events')
        .update({ status: 'sent', sent_at: new Date().toISOString(), attempts, meta_response: resp.body, last_error: null })
        .eq('id', id)
      result.sent++
    } else {
      await admin
        .from('capi_events')
        .update({ status: 'failed', attempts, meta_response: resp.body, last_error: `http_${resp.status}` })
        .eq('id', id)
      result.failed++
    }
  }

  return result
}
```

- [ ] **Step 4: Rodar o teste e ver passar**

Run: `npx vitest run src/lib/capi/dispatch.test.ts`
Expected: PASS (4 testes).

- [ ] **Step 5: Criar a rota do cron**

```ts
// src/app/api/capi/cron/route.ts
// Cron de envio das conversões CAPI pendentes/falhas. Autentica pelo header
// `x-cron-secret` (timing-safe) contra AUTOMATION_CRON_SECRET — mesmo padrão
// de automations/cron.
import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { processPendingCapiEvents } from '@/lib/capi/dispatch'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

function secretMatches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function POST(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron não configurado' }, { status: 500 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  if (!secretMatches(supplied, expected)) {
    return NextResponse.json({ error: 'não autorizado' }, { status: 401 })
  }

  const result = await processPendingCapiEvents(supabaseAdmin())
  return NextResponse.json(result)
}
```

- [ ] **Step 6: Adicionar o schedule no `vercel.json`**

Abrir `vercel.json`. Se já existir um array `"crons"`, adicionar o objeto abaixo a ele; senão, criar o array no nível raiz do JSON:

```json
{ "path": "/api/capi/cron", "schedule": "*/5 * * * *" }
```

> Se a Vercel exigir GET pra crons no plano atual, espelhar o método do cron de automations existente (conferir `vercel.json` antes — usar o mesmo verbo/rota-pattern já adotado lá).

- [ ] **Step 7: Rodar typecheck + testes**

Run: `npx tsc --noEmit && npx vitest run src/lib/capi/dispatch.test.ts`
Expected: typecheck limpo; PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/capi/dispatch.ts src/lib/capi/dispatch.test.ts src/app/api/capi/cron/route.ts vercel.json
git commit -m "feat(capi): dispatch da fila com teto de tentativas + cron de envio"
```

---

### Task 5: Camada de config + rotas de gestão (admin)

**Files:**
- Create: `src/lib/capi/settings.ts`
- Test: `src/lib/capi/settings.test.ts`
- Create: `src/app/api/account/capi/route.ts` (GET + PUT)
- Create: `src/app/api/account/capi/events/route.ts` (GET)
- Create: `src/app/api/account/capi/events/[id]/resend/route.ts` (POST)

**Interfaces:**
- Consumes: `requireRole('admin')` → `{ supabase, accountId, user }` (de `@/lib/auth/account`); `supabaseAdmin()` (de `@/lib/flows/admin-client`); `checkRateLimit`, `rateLimitResponse`, `RATE_LIMITS.adminAction` (de `@/lib/rate-limit`).
- Produces:
  - `interface CapiSettingsView { dataset_id: string | null; event_name: string; is_active: boolean; has_access_token: boolean }`
  - `getCapiSettingsView(supabase, accountId): Promise<CapiSettingsView>`
  - `interface CapiSettingsInput { dataset_id?: string | null; access_token?: string | null; event_name?: string; is_active?: boolean }`
  - `validateCapiInput(input, current): { ok: true; patch: Record<string, unknown> } | { ok: false; error: string }`

- [ ] **Step 1: Escrever o teste que falha (validação pura)**

```ts
// src/lib/capi/settings.test.ts
import { describe, expect, it } from 'vitest'
import { validateCapiInput } from './settings'

const current = { dataset_id: null, has_token: false, event_name: 'Purchase', is_active: false }

describe('validateCapiInput', () => {
  it('aceita config válida e monta o patch (token só quando enviado)', () => {
    const r = validateCapiInput({ dataset_id: 'ds_1', access_token: 'tok', event_name: 'Lead', is_active: true }, current)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.patch).toMatchObject({ dataset_id: 'ds_1', access_token: 'tok', event_name: 'Lead', is_active: true })
    }
  })

  it('não inclui access_token no patch quando vazio/omitido', () => {
    const r = validateCapiInput({ dataset_id: 'ds_1', is_active: false }, current)
    expect(r.ok).toBe(true)
    if (r.ok) expect('access_token' in r.patch).toBe(false)
  })

  it('rejeita ativar sem dataset_id', () => {
    const r = validateCapiInput({ is_active: true, access_token: 'tok' }, current)
    expect(r).toEqual({ ok: false, error: expect.any(String) })
  })

  it('rejeita ativar sem token (nem novo nem salvo)', () => {
    const r = validateCapiInput({ dataset_id: 'ds_1', is_active: true }, current)
    expect(r.ok).toBe(false)
  })

  it('aceita ativar usando token já salvo', () => {
    const r = validateCapiInput({ dataset_id: 'ds_1', is_active: true }, { ...current, has_token: true })
    expect(r.ok).toBe(true)
  })
})
```

- [ ] **Step 2: Rodar o teste e ver falhar**

Run: `npx vitest run src/lib/capi/settings.test.ts`
Expected: FAIL — `Cannot find module './settings'`.

- [ ] **Step 3: Implementar a camada de settings**

```ts
// src/lib/capi/settings.ts
// Leitura/validação da config CAPI por conta. O token nunca sai daqui pro
// cliente — a view expõe só `has_access_token`.
import type { SupabaseClient } from '@supabase/supabase-js'

export interface CapiSettingsView {
  dataset_id: string | null
  event_name: string
  is_active: boolean
  has_access_token: boolean
}

export interface CapiSettingsInput {
  dataset_id?: string | null
  access_token?: string | null
  event_name?: string
  is_active?: boolean
}

interface CurrentState {
  dataset_id: string | null
  has_token: boolean
  event_name: string
  is_active: boolean
}

/** Lê a config da conta e devolve a view segura (sem token). */
export async function getCapiSettingsView(
  supabase: SupabaseClient,
  accountId: string,
): Promise<CapiSettingsView> {
  const { data } = await supabase
    .from('capi_settings')
    .select('dataset_id, access_token, event_name, is_active')
    .eq('account_id', accountId)
    .maybeSingle()
  return {
    dataset_id: (data?.dataset_id as string | null) ?? null,
    event_name: (data?.event_name as string) ?? 'Purchase',
    is_active: Boolean(data?.is_active),
    has_access_token: Boolean(data?.access_token),
  }
}

/**
 * Valida o input e monta o patch pro upsert. `access_token` só entra no
 * patch quando enviado não-vazio (preserva o token salvo). Ativar exige
 * dataset_id e um token (novo ou já salvo).
 */
export function validateCapiInput(
  input: CapiSettingsInput,
  current: CurrentState,
): { ok: true; patch: Record<string, unknown> } | { ok: false; error: string } {
  const patch: Record<string, unknown> = {}

  const datasetId =
    input.dataset_id !== undefined ? (input.dataset_id?.trim() || null) : current.dataset_id
  if (input.dataset_id !== undefined) patch.dataset_id = datasetId

  const newToken = typeof input.access_token === 'string' ? input.access_token.trim() : ''
  if (newToken) patch.access_token = newToken
  const willHaveToken = Boolean(newToken) || current.has_token

  if (input.event_name !== undefined) {
    const name = input.event_name.trim()
    if (!name) return { ok: false, error: 'event_name não pode ser vazio' }
    patch.event_name = name
  }

  const isActive = input.is_active !== undefined ? input.is_active : current.is_active
  if (input.is_active !== undefined) patch.is_active = isActive

  if (isActive) {
    if (!datasetId) return { ok: false, error: 'Dataset ID é obrigatório para ativar o CAPI' }
    if (!willHaveToken) return { ok: false, error: 'Access Token é obrigatório para ativar o CAPI' }
  }

  return { ok: true, patch }
}
```

- [ ] **Step 4: Rodar o teste e ver passar**

Run: `npx vitest run src/lib/capi/settings.test.ts`
Expected: PASS (5 testes).

- [ ] **Step 5: Criar a rota de config `GET/PUT /api/account/capi`**

```ts
// src/app/api/account/capi/route.ts
// GET  — config CAPI da conta (token NUNCA volta; só has_access_token).
// PUT  — upsert da config (admin). Token só atualiza se enviado não-vazio.
import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { getCapiSettingsView, validateCapiInput, type CapiSettingsInput } from '@/lib/capi/settings'

export async function GET() {
  try {
    const ctx = await requireRole('admin')
    const view = await getCapiSettingsView(ctx.supabase, ctx.accountId)
    return NextResponse.json(view)
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin')

    const rl = checkRateLimit(`capi-cfg:${ctx.accountId}`, RATE_LIMITS.adminAction)
    if (!rl.success) return rateLimitResponse(rl)

    const input = (await request.json().catch(() => null)) as CapiSettingsInput | null
    if (!input || typeof input !== 'object') {
      return NextResponse.json({ error: 'Corpo inválido' }, { status: 400 })
    }

    // Estado atual pra decidir se ativar é permitido sem reenviar o token.
    const { data: cur } = await ctx.supabase
      .from('capi_settings')
      .select('dataset_id, access_token, event_name, is_active')
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    const validated = validateCapiInput(input, {
      dataset_id: (cur?.dataset_id as string | null) ?? null,
      has_token: Boolean(cur?.access_token),
      event_name: (cur?.event_name as string) ?? 'Purchase',
      is_active: Boolean(cur?.is_active),
    })
    if (!validated.ok) {
      return NextResponse.json({ error: validated.error, code: 'validation_error' }, { status: 422 })
    }

    const { error } = await ctx.supabase
      .from('capi_settings')
      .upsert(
        {
          account_id: ctx.accountId,
          created_by_user_id: ctx.user.id,
          ...validated.patch,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'account_id' },
      )
    if (error) {
      console.error('[PUT /api/account/capi] upsert error:', error)
      return NextResponse.json({ error: 'Falha ao salvar a config do CAPI' }, { status: 500 })
    }

    const view = await getCapiSettingsView(ctx.supabase, ctx.accountId)
    return NextResponse.json(view)
  } catch (err) {
    return toErrorResponse(err)
  }
}
```

> **Conferir antes de implementar:** o nome do campo do usuário no contexto de `requireRole` (`ctx.user.id` vs `ctx.userId`). Abrir `src/lib/auth/account.ts` e usar o que existir no `AccountContext`.

- [ ] **Step 6: Criar a rota de listagem de eventos `GET /api/account/capi/events`**

```ts
// src/app/api/account/capi/events/route.ts
// Lista as últimas conversões CAPI da conta (RLS admin-only via capi_events_select).
import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const url = new URL(request.url)
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50), 1), 200)

    const { data, error } = await ctx.supabase
      .from('capi_events')
      .select('id, status, event_name, value, currency, last_error, attempts, created_at, sent_at')
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) {
      console.error('[GET /api/account/capi/events] fetch error:', error)
      return NextResponse.json({ error: 'Falha ao carregar eventos CAPI' }, { status: 500 })
    }
    return NextResponse.json({ events: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}
```

- [ ] **Step 7: Criar a rota de reenvio `POST /api/account/capi/events/[id]/resend`**

```ts
// src/app/api/account/capi/events/[id]/resend/route.ts
// Reenfileira um evento CAPI (volta pra pending, zera attempts). A escrita é
// via service-role (capi_events não tem policy de UPDATE pra membros), mas o
// gate é admin e o ownership é checado por account_id.
import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
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
      .select('id, account_id')
      .eq('id', id)
      .maybeSingle()
    if (!ev || ev.account_id !== ctx.accountId) {
      return NextResponse.json({ error: 'Evento não encontrado' }, { status: 404 })
    }

    const { error } = await admin
      .from('capi_events')
      .update({ status: 'pending', attempts: 0, last_error: null })
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

- [ ] **Step 8: Rodar typecheck + testes**

Run: `npx tsc --noEmit && npx vitest run src/lib/capi/settings.test.ts`
Expected: typecheck limpo; PASS (5 testes).

- [ ] **Step 9: Commit**

```bash
git add src/lib/capi/settings.ts src/lib/capi/settings.test.ts src/app/api/account/capi/route.ts src/app/api/account/capi/events/route.ts "src/app/api/account/capi/events/[id]/resend/route.ts"
git commit -m "feat(capi): camada de config + rotas admin (config, eventos, reenviar)"
```

---

### Task 6: Painel Configurações → CAPI/Meta

**Files:**
- Create: `src/components/settings/capi-panel.tsx`
- Modify: `src/components/settings/settings-sections.ts` (adicionar seção `capi`)
- Modify: o componente que renderiza as seções de Configurações (onde `webhooks-panel` é montado) — localizar com `grep -rln "webhooks-panel\|WebhooksPanel" src`.

**Interfaces:**
- Consumes: as rotas da Task 5 (`GET/PUT /api/account/capi`, `GET /api/account/capi/events`, `POST /api/account/capi/events/[id]/resend`).
- Produces: seção `'capi'` em `SETTINGS_SECTIONS`/`SECTION_META` e o componente `<CapiPanel />`.

- [ ] **Step 1: Adicionar a seção `capi` em `settings-sections.ts`**

Adicionar `'capi'` ao array `SETTINGS_SECTIONS` (logo após `'webhooks'`). Importar um ícone do `lucide-react` (`Target`) no bloco de imports. Adicionar a entrada no `SECTION_META`:

```ts
  capi: { id: 'capi', label: 'CAPI / Meta', icon: Target, group: 'workspace' },
```

> Conferir se `SECTION_META` ou outra estrutura marca itens admin-only (campo `adminOnly`); se o `webhooks` usa, espelhar pro `capi`.

- [ ] **Step 2: Criar o painel `capi-panel.tsx`**

Espelhar a estrutura de `src/components/settings/webhooks-panel.tsx` (ler antes pra reusar os mesmos componentes de UI/estilo). O painel tem duas partes:

1. **Form de config** — carrega `GET /api/account/capi`; campos: `dataset_id` (texto), `access_token` (password; placeholder `••••••••` quando `has_access_token` e vazio = mantém), `event_name` (texto, default `Purchase`), `is_active` (toggle). Salva com `PUT` (só manda `access_token` se o usuário digitou algo). Mostra erro do 422.
2. **Tabela de eventos** — carrega `GET /api/account/capi/events`; colunas: status (badge), evento, valor+moeda, tentativas, erro, criado em. Botão "Reenviar" por linha chama `POST .../resend` e recarrega.

```tsx
// src/components/settings/capi-panel.tsx
'use client'

import { useCallback, useEffect, useState } from 'react'

// Devolver conversões de CTWA pra Meta. Espelha o padrão do webhooks-panel.
interface CapiView {
  dataset_id: string | null
  event_name: string
  is_active: boolean
  has_access_token: boolean
}
interface CapiEvent {
  id: string
  status: 'pending' | 'sent' | 'skipped' | 'failed'
  event_name: string
  value: number | null
  currency: string | null
  last_error: string | null
  attempts: number
  created_at: string
  sent_at: string | null
}

export function CapiPanel() {
  const [view, setView] = useState<CapiView | null>(null)
  const [events, setEvents] = useState<CapiEvent[]>([])
  const [datasetId, setDatasetId] = useState('')
  const [token, setToken] = useState('')
  const [eventName, setEventName] = useState('Purchase')
  const [isActive, setIsActive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const loadConfig = useCallback(async () => {
    const res = await fetch('/api/account/capi')
    if (!res.ok) return
    const data = (await res.json()) as CapiView
    setView(data)
    setDatasetId(data.dataset_id ?? '')
    setEventName(data.event_name)
    setIsActive(data.is_active)
  }, [])

  const loadEvents = useCallback(async () => {
    const res = await fetch('/api/account/capi/events?limit=50')
    if (!res.ok) return
    const data = (await res.json()) as { events: CapiEvent[] }
    setEvents(data.events ?? [])
  }, [])

  useEffect(() => {
    void loadConfig()
    void loadEvents()
  }, [loadConfig, loadEvents])

  async function save() {
    setSaving(true)
    setError(null)
    const body: Record<string, unknown> = {
      dataset_id: datasetId,
      event_name: eventName,
      is_active: isActive,
    }
    if (token) body.access_token = token // só envia se digitou
    const res = await fetch('/api/account/capi', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    setSaving(false)
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      setError(data.error ?? 'Falha ao salvar')
      return
    }
    setToken('')
    await loadConfig()
  }

  async function resend(id: string) {
    await fetch(`/api/account/capi/events/${id}/resend`, { method: 'POST' })
    await loadEvents()
  }

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <header>
          <h2 className="text-lg font-semibold">CAPI / Meta</h2>
          <p className="text-sm text-muted-foreground">
            Devolve conversões de negócios ganhos pra Meta, pra otimizar seus anúncios
            Click-to-WhatsApp pelos clientes que realmente fecham.
          </p>
        </header>

        <label className="block text-sm font-medium">Dataset ID</label>
        <input
          className="w-full rounded border px-3 py-2 text-sm"
          value={datasetId}
          onChange={(e) => setDatasetId(e.target.value)}
          placeholder="ex.: 123456789012345"
        />

        <label className="block text-sm font-medium">Access Token</label>
        <input
          type="password"
          className="w-full rounded border px-3 py-2 text-sm"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={view?.has_access_token ? '•••••••• (mantém o salvo)' : 'Cole o token do System User'}
        />

        <label className="block text-sm font-medium">Evento de conversão</label>
        <input
          className="w-full rounded border px-3 py-2 text-sm"
          value={eventName}
          onChange={(e) => setEventName(e.target.value)}
          placeholder="Purchase"
        />

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          Ativo
        </label>

        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          className="rounded bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
          onClick={() => void save()}
          disabled={saving}
        >
          {saving ? 'Salvando…' : 'Salvar'}
        </button>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Conversões recentes</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1">Status</th>
                <th>Evento</th>
                <th>Valor</th>
                <th>Tentativas</th>
                <th>Erro</th>
                <th>Criado</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <tr key={ev.id} className="border-t">
                  <td className="py-1">{ev.status}</td>
                  <td>{ev.event_name}</td>
                  <td>{ev.value != null ? `${ev.currency ?? ''} ${ev.value}` : '—'}</td>
                  <td>{ev.attempts}</td>
                  <td className="text-red-600">{ev.last_error ?? ''}</td>
                  <td>{new Date(ev.created_at).toLocaleString('pt-BR')}</td>
                  <td>
                    {ev.status !== 'sent' && (
                      <button className="text-primary underline" onClick={() => void resend(ev.id)}>
                        Reenviar
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {events.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-3 text-center text-muted-foreground">
                    Nenhuma conversão ainda.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
```

> Os nomes de classes/utilitários e componentes de input/botão acima são um esqueleto — **ler `webhooks-panel.tsx` e reusar os mesmos componentes/classe de UI do projeto** (Button, Input, Card, Badge etc.) em vez dos elementos crus, pra manter consistência visual.

- [ ] **Step 3: Montar o `<CapiPanel />` no renderizador de seções**

Localizar onde `WebhooksPanel`/`webhooks-panel` é renderizado por seção (`grep -rln "webhooks-panel\|WebhooksPanel" src`). Adicionar o branch da seção `'capi'` renderizando `<CapiPanel />` (mesmo gating admin-only do webhooks).

- [ ] **Step 4: Rodar typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: typecheck limpo; build exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/capi-panel.tsx src/components/settings/settings-sections.ts
git commit -m "feat(capi): painel Configurações → CAPI/Meta (config + eventos + reenviar)"
```

> Se o Step 3 modificar outro arquivo (o renderizador de seções), incluí-lo no `git add` explicitamente.

---

## Verificação final (E2E — após todas as tasks)

1. `npx tsc --noEmit` limpo; `npx vitest run` verde (client, referral, dispatch, settings); `npm run build` exit 0.
2. Migrations 027/028/029 aplicadas manualmente (Iago).
3. **Captura:** inbound com `referral.ctwa_clid` → `contacts.ctwa_clid/referral/referral_captured_at` preenchidos; segundo anúncio sobrescreve; mensagem sem referral não toca no contato.
4. **Config:** painel salva dataset+token+evento+ativo; GET nunca devolve token (só `has_access_token`); ativar sem dataset/token → 422.
5. **Conversão feliz:** deal → `won` (kanban) → trigger enfileira `capi_events` pending → cron envia → `sent` + `sent_at` + `meta_response`; anúncio recebe `Purchase` com valor/moeda + `event_id=deal_id`.
6. **Skips:** won sem `ctwa_clid` → `skipped/no_ctwa_clid`; won de conta sem CAPI ativo → `skipped/capi_inactive`; nenhum POST nesses casos.
7. **Retry/reenvio:** token inválido → `failed/http_400` + `attempts++`; cron retenta até 5; "reenviar" volta pra `pending`+`attempts=0`. Re-won do mesmo deal não conta 2x.
8. **Segurança:** cron sem `x-cron-secret` certo → 401; não-admin → 403 no painel/rotas; evento de outra conta → 404 no reenvio.

## Pós-implementação

- Atualizar memória `crm-vantage-api-foundation` (ou nova entrada CAPI): captura de `ctwa_clid` no inbound, `capi_settings` por conta (painel admin), trigger `deal.won` → `capi_events` → cron envia pra Graph API; loop CRM↔Meta fechado. Linkar `[[crm-vantage-api-foundation]]`.

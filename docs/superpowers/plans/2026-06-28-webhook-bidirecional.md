# Webhook bidirecional (in/out) + payload enriquecido — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Disparar webhook em TODO envio de mensagem (`message.sent`, outbound) além do `message.received` (inbound) atual, com `direction`, `timestamp`, bloco `sender` e payload enriquecido (tags, agente, custom fields, deal/pipeline, CTWA) — sem quebrar o consumidor existente e sem migration.

**Architecture:** Um único builder/dispatcher genérico em `src/lib/webhooks/dispatch.ts` monta e entrega qualquer evento de mensagem (header `x-webhook-event` reflete o evento). Um helper puro-ish `src/lib/webhooks/enrich.ts` lê tabelas existentes (contato/tags/custom fields/ctwa_clid, conversa, agente via lookup separado em `profiles`, deal por conversa+fallback contato) best-effort pra anexar contexto. O inbound (`webhook/route.ts`) e os chokepoints de envio (`send-message.ts`, `automations/meta-send.ts`, `flows/meta-send.ts`) chamam o dispatcher após persistir a mensagem. **Onde rodar o disparo:** `send-message.ts` é chamado pelas 2 ROTAS de envio (request handlers que `await`am o helper antes de responder), então o disparo outbound vai em `after()` (pós-resposta, sem somar latência); automações e flows rodam no engine/flow runner — que JÁ está dentro do `after()` do inbound — então ali o disparo é síncrono (`await`) best-effort. Tudo best-effort: nunca derruba o envio nem o inbound.

**Tech Stack:** Next.js App Router (server routes), TypeScript, Supabase JS (`@supabase/supabase-js`, client admin/service-role via `supabaseAdmin()`), Vitest (unit), `fetch` nativo com `AbortSignal.timeout`.

## Global Constraints

- Comentários de código em **português**.
- Nunca `git add -A` — adicionar arquivos explicitamente por caminho em cada commit.
- Lint baseline = **3** warnings (não aumentar); `npx tsc --noEmit` limpo (zero erros).
- **Sem migration** — `sender` é passado em memória no disparo; o enriquecimento lê tabelas existentes.
- Branch de trabalho: **`feat/webhook-bidirecional`** (já criada e em uso).
- Dispatch e enrich são **best-effort**: try/catch, NUNCA lançam, NUNCA bloqueiam o caminho crítico de envio/inbound. Nunca logar o `secret`.
- **Aditivo**: o consumidor atual de `message.received` não pode quebrar — campos só somam.
- Filtro de loop é responsabilidade do **n8n** (documentar): ignorar quando `direction==='out' && sender.via==='api' && sender.api_key_id === <sua chave>`. `sender.actor_id` deve ser lido SEMPRE em conjunto com `sender.via` — pra `via:'api'` o `actor_id` é o `apiKeyId` (= `api_key_id`); pra `via:'inbox'|'automation'|'flow'` é o `user_id`. Não interpretar `actor_id` sem olhar `via`.
- **Fora de escopo:** broadcasts, reações (react), histórico de mensagens no payload, notas internas, presença, eventos de status, subscrição por endpoint.

## Tech facts confirmados (do código atual)

- `dispatch.ts`: lookup `webhook_endpoints` `.select('id,url,secret').eq('account_id',accountId).eq('is_active',true)`; `isValidWebhookUrl` de `./secret`; `fetch` com headers `content-type`/`x-webhook-event`/`x-webhook-token`, `redirect:'manual'`, `AbortSignal.timeout(10_000)`; best-effort.
- `send-message.ts`: `SendMessageInput` (linhas 43-58); conversa carregada com `'*, contact:contacts(*)'` → `conversation.contact.id` disponível; insert em `messages` com `.select().single()` → `messageRecord` (id, content_type, content_text, message_id, created_at, status, conversation_id, sender_type:'agent'); `return { ok:true, message_id: messageRecord.id, whatsapp_message_id: waMessageId }` (~:347). `supabaseAdmin` já importado de `@/lib/flows/admin-client`. **As 2 rotas que chamam `sendMessageToConversation` fazem `await ...` ANTES de responder** → por isso o disparo outbound precisa rodar em `after()` (pós-resposta), senão somaria até ~10s à resposta do envio.
- Rota `whatsapp/send/route.ts`: `requireRole('agent')` → `ctx.userId`, `ctx.supabase`, `ctx.accountId`. É request handler (after() válido).
- Rota `v1/messages/send/route.ts`: `ctx.apiKey.{accountId, apiKeyId}` — **`ApiKeyContext` NÃO tem `name`** (ver `src/lib/auth/api-key-context.ts:7-16`); então `actor_name` da API = `null` (decisão: não fazer lookup extra; escopo enxuto). Já usa `after()` (carimba `last_used_at`). **Tem teste** (`route.test.ts`): mocka `sendMessageToConversation` + `next/server.after` (no-op) + `resolveApiKey`; o happy-path usa `expect.objectContaining` na chamada do helper.
- `automations/meta-send.ts`: `sendViaMeta` insere em `messages` com `sender_type:'bot'` (~:150) SEM `.select()`; retorna `{whatsapp_message_id}`. `supabaseAdmin` já em escopo (`db`).
- `flows/meta-send.ts`: três funções públicas (`engineSendText`, `engineSendMedia`, `engineSendInteractiveButtons`/`...List` via `sendInteractiveViaMeta`) — cada uma insere `sender_type:'bot'` e atualiza a conversa. `supabaseAdmin` já em escopo (`db`).
- Inbound `webhook/route.ts` (~:783-804): re-SELECT `freshConv` (status, assigned_agent_id, bot_paused); chama `dispatchMessageReceived(supabaseAdmin(), accountId, buildMessageReceivedPayload({...}))`. `message` é `WhatsAppMessage` com `.timestamp` epoch (string); padrão `new Date(parseInt(message.timestamp) * 1000).toISOString()` (linha 621).
- Schema: `contacts(ctwa_clid TEXT, referral JSONB)` (migration 027 — `ctwa_clid` é coluna DEDICADA, separada do `referral`); `conversations(status, bot_paused, assigned_agent_id, unread_count, last_message_at, autoassign_waiting, created_at, account_id)`; **`assigned_agent_id UUID` SEM `REFERENCES`** (001:145) → a FK `conversations_assigned_agent_id_fkey` NÃO existe → embed PostgREST quebraria a query inteira (PGRST200); `assigned_agent_id` é um **user_id** (comparado a `userId` em `leads/visibility.ts`); `profiles(user_id, full_name, account_id)` com **`UNIQUE(user_id)` GLOBAL** (001:22) → lookup por `user_id` não precisa filtrar `account_id`; `deals(contact_id, conversation_id NULLABLE, title, value, currency, status default 'active', pipeline_id→pipelines(name), stage_id→pipeline_stages(name))` — deals criados na UI de pipelines têm `conversation_id` null (daí o fallback por `contact_id`).
- Query de tags/custom fields (padrão `contacts/api-service.ts:85-86`): `contact_tags ( tags ( name ) )`, `contact_custom_values ( value, custom_fields ( field_name ) )`.

---

## File Structure

| Arquivo | Responsabilidade | Task |
|---|---|---|
| `src/lib/webhooks/enrich.ts` | **novo** — `buildConversationContext` (contexto enriquecido, best-effort) | T1 |
| `src/lib/webhooks/enrich.test.ts` | **novo** — testes unitários do helper (TDD) | T1 |
| `src/lib/webhooks/dispatch.ts` | generaliza: tipos `MessageEventPayload`/`MessageSender`, `buildMessageEventPayload`, `dispatchMessageEvent`; mantém wrappers inbound | T2 |
| `src/lib/webhooks/dispatch.test.ts` | adapta basePayload + testes de `message.sent`/direction/sender/header por evento | T2 |
| `src/app/api/whatsapp/webhook/route.ts` | inbound usa builder genérico (direction:'in', sender:'customer/meta', timestamp, enrich) | T3 |
| `src/lib/whatsapp/send-message.ts` | +campo `source` no input; dispara `message.sent` após insert | T4 |
| `src/app/api/whatsapp/send/route.ts` | passa `source={via:'inbox', actor_id: ctx.userId}` | T4 |
| `src/app/api/v1/messages/send/route.ts` | passa `source={via:'api', actor_id: apiKeyId, api_key_id: apiKeyId}` | T4 |
| `src/app/api/v1/messages/send/route.test.ts` | asserção de que a rota passa `source` (via:'api') pro helper | T4 |
| `src/lib/automations/meta-send.ts` | `.select()` no insert + dispara `message.sent` (sender bot/automation) | T5 |
| `src/lib/flows/meta-send.ts` | `.select()` nos inserts + dispara `message.sent` (sender bot/flow) | T6 |

---

## Task 1: Helper de enriquecimento (`enrich.ts`) — TDD

**Files:**
- Create: `src/lib/webhooks/enrich.ts`
- Test: `src/lib/webhooks/enrich.test.ts`

**Interfaces:**
- Consumes: nada de tasks anteriores. Usa `SupabaseClient` de `@supabase/supabase-js`.
- Produces (usado por T2/T3/T4/T5/T6):

```ts
export interface ConversationContext {
  contact: {
    tags: string[]
    custom_fields: { name: string; value: string }[]
    referral: unknown | null
    ctwa_clid: string | null
  }
  state: {
    bot_paused: boolean
    conversation_status: string
    assigned_agent_id: string | null
    assigned_agent_name: string | null
    unread_count: number | null
    last_message_at: string | null
    autoassign_waiting: boolean
    created_at: string | null
  }
  deal:
    | { id: string; title: string; value: number; currency: string; stage: string | null; pipeline: string | null; status: string }
    | null
}

export function emptyConversationContext(): ConversationContext
export async function buildConversationContext(
  admin: SupabaseClient,
  accountId: string,
  conversationId: string,
  contactId: string,
): Promise<ConversationContext>
```

- [ ] **Step 1: Escrever os testes (falhando)**

Cria `src/lib/webhooks/enrich.test.ts` com o conteúdo COMPLETO abaixo. O mock do client espelha `dispatch.test.ts` (encadeia `from().select().eq()...`), mas como aqui temos várias tabelas, usamos um roteador por nome de tabela.

```ts
import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildConversationContext, emptyConversationContext } from './enrich'

// ── Fábrica de client admin fake, roteando por nome de tabela ────────────────
// Cada tabela recebe uma "resposta" (data/error). As queries do enrich são:
//   contacts        → maybeSingle()  (contato + tags + custom + referral + ctwa_clid)
//   conversations   → maybeSingle()  (estado escalar, SEM embed de profiles)
//   profiles        → maybeSingle()  (Bloco 2b: nome do agente por user_id)
//   deals           → maybeSingle()  (deal ativo + joins pipeline/stage)
// Mock-chain robusto: QUALQUER método de filtro retorna o próprio builder; os
// terminadores (maybeSingle/single) resolvem com a resposta da tabela. Não
// depende da ORDEM dos .eq() — só do nome da tabela.
function makeAdmin(responses: Record<string, { data: unknown; error: unknown }>) {
  function builderFor(table: string) {
    const resp = responses[table] ?? { data: null, error: null }
    const builder: Record<string, unknown> = {}
    const chain = () => builder
    for (const m of ['select', 'eq', 'is', 'order', 'limit']) builder[m] = vi.fn(chain)
    builder.maybeSingle = vi.fn().mockResolvedValue(resp)
    builder.single = vi.fn().mockResolvedValue(resp)
    return builder
  }
  const from = vi.fn((table: string) => builderFor(table))
  return { from } as unknown as SupabaseClient
}

describe('emptyConversationContext', () => {
  it('retorna um esqueleto seguro (tudo vazio/null/false)', () => {
    const ctx = emptyConversationContext()
    expect(ctx.contact).toEqual({ tags: [], custom_fields: [], referral: null, ctwa_clid: null })
    expect(ctx.deal).toBeNull()
    expect(ctx.state.bot_paused).toBe(false)
    expect(ctx.state.assigned_agent_id).toBeNull()
    expect(ctx.state.assigned_agent_name).toBeNull()
    expect(ctx.state.autoassign_waiting).toBe(false)
    expect(ctx.state.conversation_status).toBe('open')
  })
})

describe('buildConversationContext', () => {
  it('monta contact (tags + custom + referral + ctwa_clid), state escalar + nome do agente (Bloco 2b) e deal', async () => {
    // IMPORTANTE: conversations devolve SÓ colunas escalares (sem embed de
    // profiles — `assigned_agent_id` não tem FK no schema, embed quebraria a
    // query inteira). O nome do agente vem do lookup SEPARADO em `profiles`.
    const admin = makeAdmin({
      contacts: {
        data: {
          ctwa_clid: 'clid-123',
          referral: { source_id: 'ad-9' },
          contact_tags: [{ tags: { name: 'lead' } }, { tags: { name: 'vip' } }],
          contact_custom_values: [
            { value: 'Honda', custom_fields: { field_name: 'modelo' } },
            { value: null, custom_fields: { field_name: 'vazio' } },
          ],
        },
        error: null,
      },
      conversations: {
        data: {
          status: 'pending',
          bot_paused: true,
          assigned_agent_id: 'user-7',
          unread_count: 3,
          last_message_at: '2026-06-28T17:00:00Z',
          autoassign_waiting: false,
          created_at: '2026-06-20T10:00:00Z',
        },
        error: null,
      },
      profiles: { data: { full_name: 'Ana Vendas' }, error: null },
      deals: {
        data: {
          id: 'deal-1',
          title: 'Civic 2020',
          value: 75000,
          currency: 'BRL',
          status: 'active',
          pipelines: { name: 'Vendas' },
          pipeline_stages: { name: 'Negociação' },
        },
        error: null,
      },
    })

    const ctx = await buildConversationContext(admin, 'acc1', 'conv1', 'c1')

    expect(ctx.contact.tags).toEqual(['lead', 'vip'])
    expect(ctx.contact.custom_fields).toEqual([
      { name: 'modelo', value: 'Honda' },
      { name: 'vazio', value: '' },
    ])
    expect(ctx.contact.referral).toEqual({ source_id: 'ad-9' })
    expect(ctx.contact.ctwa_clid).toBe('clid-123')
    expect(ctx.state.conversation_status).toBe('pending')
    expect(ctx.state.bot_paused).toBe(true)
    expect(ctx.state.assigned_agent_id).toBe('user-7')
    // Nome resolvido pelo Bloco 2b (lookup em profiles por user_id), não por embed.
    expect(ctx.state.assigned_agent_name).toBe('Ana Vendas')
    expect(ctx.state.unread_count).toBe(3)
    expect(ctx.state.autoassign_waiting).toBe(false)
    expect(ctx.deal).toEqual({
      id: 'deal-1',
      title: 'Civic 2020',
      value: 75000,
      currency: 'BRL',
      stage: 'Negociação',
      pipeline: 'Vendas',
      status: 'active',
    })
  })

  it('sem agente atribuído → não faz lookup de nome; sem deal → deal:null', async () => {
    const admin = makeAdmin({
      contacts: { data: { ctwa_clid: null, referral: null, contact_tags: [], contact_custom_values: [] }, error: null },
      conversations: {
        data: {
          status: 'open',
          bot_paused: false,
          assigned_agent_id: null,
          unread_count: 0,
          last_message_at: null,
          autoassign_waiting: true,
          created_at: '2026-06-20T10:00:00Z',
        },
        error: null,
      },
      // profiles ausente de propósito: sem assigned_agent_id, o 2b nem roda.
      deals: { data: null, error: null },
    })

    const ctx = await buildConversationContext(admin, 'acc1', 'conv1', 'c1')

    expect(ctx.contact.tags).toEqual([])
    expect(ctx.contact.referral).toBeNull()
    expect(ctx.contact.ctwa_clid).toBeNull()
    expect(ctx.state.assigned_agent_id).toBeNull()
    expect(ctx.state.assigned_agent_name).toBeNull()
    expect(ctx.state.autoassign_waiting).toBe(true)
    expect(ctx.deal).toBeNull()
  })

  it('deal sem conversation_id (criado na UI por contato) → fallback por contact_id', async () => {
    // O 1º lookup (por conversation_id) volta vazio; o fallback (por contact_id)
    // traz o deal. Como o mock roteia só por tabela, `deals` responde nos dois
    // lookups; aqui validamos que o deal é montado a partir da resposta da tabela.
    const admin = makeAdmin({
      contacts: { data: { ctwa_clid: null, referral: null, contact_tags: [], contact_custom_values: [] }, error: null },
      conversations: {
        data: { status: 'open', bot_paused: false, assigned_agent_id: null, unread_count: 0, last_message_at: null, autoassign_waiting: false, created_at: null },
        error: null,
      },
      deals: {
        data: {
          id: 'deal-9',
          title: 'Negócio do contato',
          value: 1000,
          currency: 'BRL',
          status: 'active',
          pipelines: { name: 'Pós-venda' },
          pipeline_stages: { name: 'Aberto' },
        },
        error: null,
      },
    })

    const ctx = await buildConversationContext(admin, 'acc1', 'conv1', 'c1')

    expect(ctx.deal).toEqual({
      id: 'deal-9',
      title: 'Negócio do contato',
      value: 1000,
      currency: 'BRL',
      stage: 'Aberto',
      pipeline: 'Pós-venda',
      status: 'active',
    })
  })

  it('erro na query de contacts → bloco contact degrada vazio; state ainda monta', async () => {
    const admin = makeAdmin({
      contacts: { data: null, error: { message: 'boom' } },
      conversations: {
        data: { status: 'open', bot_paused: false, assigned_agent_id: null, unread_count: 0, last_message_at: null, autoassign_waiting: false, created_at: null },
        error: null,
      },
      deals: { data: null, error: null },
    })

    const ctx = await buildConversationContext(admin, 'acc1', 'conv1', 'c1')

    // contacts falhou → bloco contact volta vazio, mas state ainda monta
    expect(ctx.contact).toEqual({ tags: [], custom_fields: [], referral: null, ctwa_clid: null })
    expect(ctx.state.conversation_status).toBe('open')
  })

  it('erro na query de conversations → state degrada pro esqueleto, sem quebrar o resto', async () => {
    const admin = makeAdmin({
      contacts: { data: { ctwa_clid: 'x', referral: null, contact_tags: [{ tags: { name: 'lead' } }], contact_custom_values: [] }, error: null },
      conversations: { data: null, error: { message: 'PGRST200 ou outro' } },
      deals: { data: null, error: null },
    })

    const ctx = await buildConversationContext(admin, 'acc1', 'conv1', 'c1')

    // conversa falhou → state fica o do esqueleto (defaults seguros), MAS sem
    // forçar bot_paused:false enganoso vindo de um embed que quebrou a query:
    // aqui é genuinamente "não consegui ler" → o n8n vê os defaults seguros.
    expect(ctx.state.bot_paused).toBe(false)
    expect(ctx.state.conversation_status).toBe('open')
    expect(ctx.state.assigned_agent_id).toBeNull()
    // os demais blocos seguem montados normalmente
    expect(ctx.contact.tags).toEqual(['lead'])
    expect(ctx.contact.ctwa_clid).toBe('x')
  })

  it('from() lançando (cliente quebrado) → retorna esqueleto e NÃO lança', async () => {
    const admin = { from: vi.fn(() => { throw new Error('client down') }) } as unknown as SupabaseClient
    await expect(buildConversationContext(admin, 'acc1', 'conv1', 'c1')).resolves.toEqual(
      emptyConversationContext(),
    )
  })
})
```

- [ ] **Step 2: Rodar o teste pra ver falhar**

Run: `npx vitest run src/lib/webhooks/enrich.test.ts`
Expected: FAIL — `Failed to resolve import "./enrich"` (módulo não existe ainda).

- [ ] **Step 3: Implementar `enrich.ts`**

Cria `src/lib/webhooks/enrich.ts` com o conteúdo COMPLETO abaixo.

```ts
import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Enriquecimento de contexto pro webhook bidirecional.
//
// Lê tabelas EXISTENTES (sem migration) pra anexar ao payload o
// contexto de negócio que o agente n8n usa pra decidir: tags do
// contato, custom fields, origem CTWA (referral), estado da conversa
// (incl. NOME do agente atribuído) e o deal ativo (pipeline/stage).
//
// BEST-EFFORT por natureza: cada bloco roda em try/catch isolado; se
// uma query falhar, aquele bloco degrada pro vazio e o resto continua.
// NUNCA lança — não pode derrubar o envio nem o inbound webhook.
// Minimiza queries: 1 contato (tags/custom/referral/ctwa_clid aninhados),
// 1 conversa (só escalares — SEM embed de profiles, ver Bloco 2),
// 0-1 lookup de nome do agente (profiles por user_id) e 1-2 deal
// (conversa; fallback por contato quando o deal não tem conversa).
// ============================================================

/** Bloco enriquecido anexado ao payload do webhook. */
export interface ConversationContext {
  contact: {
    tags: string[]
    custom_fields: { name: string; value: string }[]
    referral: unknown | null
    /** Click-id de CTWA (coluna dedicada, migration 027). Usado pelo CAPI. */
    ctwa_clid: string | null
  }
  state: {
    bot_paused: boolean
    conversation_status: string
    assigned_agent_id: string | null
    assigned_agent_name: string | null
    unread_count: number | null
    last_message_at: string | null
    autoassign_waiting: boolean
    created_at: string | null
  }
  deal:
    | {
        id: string
        title: string
        value: number
        currency: string
        stage: string | null
        pipeline: string | null
        status: string
      }
    | null
}

/** Esqueleto seguro — retornado quando tudo falha. Cada bloco degrada pra cá. */
export function emptyConversationContext(): ConversationContext {
  return {
    contact: { tags: [], custom_fields: [], referral: null, ctwa_clid: null },
    state: {
      bot_paused: false,
      conversation_status: 'open',
      assigned_agent_id: null,
      assigned_agent_name: null,
      unread_count: null,
      last_message_at: null,
      autoassign_waiting: false,
      created_at: null,
    },
    deal: null,
  }
}

// ── Normalizadores de joins aninhados do PostgREST ───────────────────────────
// O PostgREST pode devolver a relação aninhada como objeto OU array (depende da
// cardinalidade inferida). Normalizamos os dois casos de forma defensiva.

function firstOrSelf<T>(rel: unknown): T | null {
  if (rel == null) return null
  if (Array.isArray(rel)) return (rel[0] as T) ?? null
  return rel as T
}

function extractTags(row: Record<string, unknown> | null): string[] {
  if (!row) return []
  const raw = row.contact_tags
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const link of raw as Record<string, unknown>[]) {
    const tag = firstOrSelf<{ name?: unknown }>(link.tags)
    if (tag && typeof tag.name === 'string') out.push(tag.name)
  }
  return out
}

function extractCustomFields(
  row: Record<string, unknown> | null,
): { name: string; value: string }[] {
  if (!row) return []
  const raw = row.contact_custom_values
  if (!Array.isArray(raw)) return []
  const out: { name: string; value: string }[] = []
  for (const cv of raw as Record<string, unknown>[]) {
    const field = firstOrSelf<{ field_name?: unknown }>(cv.custom_fields)
    if (field && typeof field.field_name === 'string') {
      out.push({ name: field.field_name, value: cv.value == null ? '' : String(cv.value) })
    }
  }
  return out
}

// ── Builder principal ────────────────────────────────────────────────────────

export async function buildConversationContext(
  admin: SupabaseClient,
  accountId: string,
  conversationId: string,
  contactId: string,
): Promise<ConversationContext> {
  const result = emptyConversationContext()

  // Bloco 1 — contato: tags + custom fields + referral + ctwa_clid, em 1 select
  // aninhado. `ctwa_clid` é coluna dedicada (migration 027), separada do
  // `referral` jsonb; o CAPI usa o click-id, então expomos ele explicitamente.
  try {
    const { data, error } = await admin
      .from('contacts')
      .select(
        'referral, ctwa_clid, contact_tags ( tags ( name ) ), contact_custom_values ( value, custom_fields ( field_name ) )',
      )
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!error && data) {
      const row = data as Record<string, unknown>
      result.contact = {
        tags: extractTags(row),
        custom_fields: extractCustomFields(row),
        referral: row.referral ?? null,
        ctwa_clid: typeof row.ctwa_clid === 'string' ? row.ctwa_clid : null,
      }
    } else if (error) {
      console.warn('[enrich] contato falhou:', error.message)
    }
  } catch (e) {
    console.warn('[enrich] contato lançou:', e instanceof Error ? e.message : e)
  }

  // Bloco 2 — conversa: SÓ colunas escalares. NÃO embutimos `profiles` aqui de
  // propósito: `conversations.assigned_agent_id` NÃO tem FK no schema (001:145,
  // `assigned_agent_id UUID` sem REFERENCES). Um embed `profiles!...fkey` faria
  // o PostgREST devolver PGRST200 pra REQUISIÇÃO INTEIRA → o `state` degradaria
  // pro esqueleto (perderia bot_paused/assigned_agent_id/status reais) = uma
  // REGRESSÃO silenciosa (o n8n veria bot_paused:false/status:'open' sempre e
  // responderia por cima de humano). O nome do agente vem do Bloco 2b (lookup
  // separado em `profiles` por user_id).
  try {
    const { data, error } = await admin
      .from('conversations')
      .select(
        'status, bot_paused, assigned_agent_id, unread_count, last_message_at, autoassign_waiting, created_at',
      )
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!error && data) {
      const row = data as Record<string, unknown>
      result.state = {
        bot_paused: row.bot_paused === true,
        conversation_status: typeof row.status === 'string' ? row.status : 'open',
        assigned_agent_id: (row.assigned_agent_id as string | null) ?? null,
        // nome resolvido no Bloco 2b (lookup separado).
        assigned_agent_name: null,
        unread_count: typeof row.unread_count === 'number' ? row.unread_count : null,
        last_message_at: (row.last_message_at as string | null) ?? null,
        autoassign_waiting: row.autoassign_waiting === true,
        created_at: (row.created_at as string | null) ?? null,
      }
    } else if (error) {
      console.warn('[enrich] conversa falhou:', error.message)
    }
  } catch (e) {
    console.warn('[enrich] conversa lançou:', e instanceof Error ? e.message : e)
  }

  // Bloco 2b — nome do agente: lookup direto em `profiles` por user_id
  // (`assigned_agent_id` é um user_id). É o ÚNICO caminho pro nome — não há
  // embed no Bloco 2. Best-effort: só roda quando há agente atribuído.
  // `profiles` tem UNIQUE(user_id) GLOBAL (001:22), então o filtro por
  // account_id é redundante e foi omitido (um user_id resolve 1 profile só).
  if (result.state.assigned_agent_id) {
    try {
      const { data, error } = await admin
        .from('profiles')
        .select('full_name')
        .eq('user_id', result.state.assigned_agent_id)
        .maybeSingle()
      if (!error && data && typeof (data as { full_name?: unknown }).full_name === 'string') {
        result.state.assigned_agent_name = (data as { full_name: string }).full_name
      }
    } catch (e) {
      console.warn('[enrich] nome do agente lançou:', e instanceof Error ? e.message : e)
    }
  }

  // Bloco 3 — deal ATIVO (1, o mais recente), com pipeline/stage. Primeiro tenta
  // o deal da CONVERSA (`conversation_id`); se não houver, faz fallback pro deal
  // do CONTATO (`deals.conversation_id` é nullable — deals criados na UI de
  // pipelines têm conversation_id null). Ordem determinística (created_at desc).
  const SELECT_DEAL =
    'id, title, value, currency, status, pipelines ( name ), pipeline_stages ( name )'
  // Mapeia a row crua do PostgREST pro shape do payload (joins normalizados).
  const mapDeal = (row: Record<string, unknown>): ConversationContext['deal'] => {
    const pipeline = firstOrSelf<{ name?: unknown }>(row.pipelines)
    const stage = firstOrSelf<{ name?: unknown }>(row.pipeline_stages)
    return {
      id: String(row.id),
      title: typeof row.title === 'string' ? row.title : '',
      value: typeof row.value === 'number' ? row.value : Number(row.value ?? 0),
      currency: typeof row.currency === 'string' ? row.currency : 'BRL',
      stage: stage && typeof stage.name === 'string' ? stage.name : null,
      pipeline: pipeline && typeof pipeline.name === 'string' ? pipeline.name : null,
      status: typeof row.status === 'string' ? row.status : 'active',
    }
  }
  try {
    // 1ª tentativa: deal ativo VINCULADO à conversa.
    const { data: byConv, error: errConv } = await admin
      .from('deals')
      .select(SELECT_DEAL)
      .eq('account_id', accountId)
      .eq('conversation_id', conversationId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!errConv && byConv) {
      result.deal = mapDeal(byConv as Record<string, unknown>)
    } else {
      if (errConv) console.warn('[enrich] deal (conversa) falhou:', errConv.message)
      // Fallback: deal ativo do CONTATO (sem vínculo de conversa).
      const { data: byContact, error: errContact } = await admin
        .from('deals')
        .select(SELECT_DEAL)
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (!errContact && byContact) {
        result.deal = mapDeal(byContact as Record<string, unknown>)
      } else if (errContact) {
        console.warn('[enrich] deal (contato) falhou:', errContact.message)
      }
    }
  } catch (e) {
    console.warn('[enrich] deal lançou:', e instanceof Error ? e.message : e)
  }

  return result
}
```

> **Nota pro implementador:** NÃO use embed `profiles:profiles!conversations_assigned_agent_id_fkey` no Bloco 2 — `conversations.assigned_agent_id` é `UUID` SEM `REFERENCES` no schema (migration 001:145), então a FK nomeada não existe e o PostgREST devolveria PGRST200 pra requisição inteira, derrubando o `state` pro esqueleto (regressão: `bot_paused`/`status`/`assigned_agent_id` reais sumiriam). O nome do agente vem EXCLUSIVAMENTE do **Bloco 2b** (lookup separado em `profiles` por `user_id`). Os testes do Step 1 exercitam exatamente esse caminho real (conversa devolve só escalares; `profiles` resolve o nome num lookup à parte).

- [ ] **Step 4: Rodar os testes pra ver passar**

Run: `npx vitest run src/lib/webhooks/enrich.test.ts`
Expected: PASS — 8 testes verdes (1 de `emptyConversationContext` + 7 de `buildConversationContext`).

- [ ] **Step 5: Typecheck + lint**

Run: `npx tsc --noEmit`
Expected: sem erros.

Run: `npm run lint`
Expected: baseline ≤ 3 warnings, sem erros novos.

- [ ] **Step 6: Commit**

```bash
git add src/lib/webhooks/enrich.ts src/lib/webhooks/enrich.test.ts
git commit -m "feat(webhooks): helper buildConversationContext (enriquecimento best-effort)"
```

---

## Task 2: Generalizar o dispatch (`dispatch.ts`) — TDD

**Files:**
- Modify: `src/lib/webhooks/dispatch.ts`
- Test: `src/lib/webhooks/dispatch.test.ts`

**Interfaces:**
- Consumes de T1: `ConversationContext` (de `./enrich`).
- Produces (usado por T3/T4/T5/T6):

```ts
export type MessageEvent = 'message.received' | 'message.sent'
export type MessageDirection = 'in' | 'out'
export interface MessageSender {
  type: 'agent' | 'bot' | 'customer'
  via: 'inbox' | 'api' | 'automation' | 'flow' | 'meta'
  actor_id: string | null
  actor_name: string | null
  api_key_id: string | null
}
export interface NormalizedMessage {
  id: string | null
  whatsapp_message_id: string | null
  content_type: string | null
  content_text: string | null
  created_at: string | null
}
export interface MessageEventPayload {
  event: MessageEvent
  direction: MessageDirection
  timestamp: string
  account_id: string
  conversation_id: string
  sender: MessageSender
  contact: { id: string; phone: string; name: string | null; tags: string[]; custom_fields: { name: string; value: string }[]; referral: unknown | null; ctwa_clid: string | null }
  state: ConversationContext['state']
  deal: ConversationContext['deal']
  message: NormalizedMessage
  meta?: { message: unknown; contact: unknown; metadata: unknown }
}
export function buildMessageEventPayload(args: {...}): MessageEventPayload
export async function dispatchMessageEvent(admin, accountId, payload): Promise<void>
// wrappers de compatibilidade mantidos:
export type MessageReceivedPayload = MessageEventPayload
export function buildMessageReceivedPayload(args): MessageEventPayload
export async function dispatchMessageReceived(admin, accountId, payload): Promise<void>
```

- [ ] **Step 1: Reescrever `dispatch.ts` (implementação completa)**

Substitui o conteúdo INTEIRO de `src/lib/webhooks/dispatch.ts` pelo abaixo. (Mantém os nomes legados `MessageReceivedPayload`/`buildMessageReceivedPayload`/`dispatchMessageReceived` como aliases pra não quebrar nada antes do T3.)

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { isValidWebhookUrl } from './secret'
import type { ConversationContext } from './enrich'

// ============================================================
// Dispatch genérico de eventos de mensagem pro webhook bidirecional.
//
// Um único builder + dispatcher serve tanto o inbound (message.received,
// direction 'in') quanto o outbound (message.sent, direction 'out'). O
// header `x-webhook-event` reflete o `event`. Entrega best-effort: busca
// endpoints ativos da conta, valida SSRF, faz POST com token estático no
// header (x-webhook-token), redirect:'manual', timeout. NUNCA lança (não
// pode derrubar o envio nem o inbound). Nunca loga o secret.
// ============================================================

export type MessageEvent = 'message.received' | 'message.sent'
export type MessageDirection = 'in' | 'out'

/** Origem do envio — o n8n usa isto pra filtrar os próprios envios (anti-loop). */
export interface MessageSender {
  type: 'agent' | 'bot' | 'customer'
  via: 'inbox' | 'api' | 'automation' | 'flow' | 'meta'
  actor_id: string | null
  actor_name: string | null
  api_key_id: string | null
}

/** Bloco `message` normalizado (mesma forma pra in e out). */
export interface NormalizedMessage {
  id: string | null
  whatsapp_message_id: string | null
  content_type: string | null
  content_text: string | null
  created_at: string | null
}

/** Payload completo do evento de mensagem (in ou out). */
export interface MessageEventPayload {
  event: MessageEvent
  direction: MessageDirection
  timestamp: string
  account_id: string
  conversation_id: string
  sender: MessageSender
  contact: {
    id: string
    phone: string
    name: string | null
    tags: string[]
    custom_fields: { name: string; value: string }[]
    referral: unknown | null
    ctwa_clid: string | null
  }
  state: ConversationContext['state']
  deal: ConversationContext['deal']
  message: NormalizedMessage
  /** Cru da Meta — só no inbound (aditivo; consumidor atual depende disso). */
  meta?: { message: unknown; contact: unknown; metadata: unknown }
}

/** Monta o payload a partir de identidade + contexto enriquecido + mensagem. */
export function buildMessageEventPayload(args: {
  event: MessageEvent
  direction: MessageDirection
  accountId: string
  conversationId: string
  sender: MessageSender
  contact: { id: string; phone: string; name: string | null }
  context: ConversationContext
  message: NormalizedMessage
  timestamp?: string
  meta?: { message: unknown; contact: unknown; metadata: unknown }
}): MessageEventPayload {
  const payload: MessageEventPayload = {
    event: args.event,
    direction: args.direction,
    timestamp: args.timestamp ?? new Date().toISOString(),
    account_id: args.accountId,
    conversation_id: args.conversationId,
    sender: args.sender,
    contact: {
      id: args.contact.id,
      phone: args.contact.phone,
      name: args.contact.name,
      tags: args.context.contact.tags,
      custom_fields: args.context.contact.custom_fields,
      referral: args.context.contact.referral,
      ctwa_clid: args.context.contact.ctwa_clid,
    },
    state: args.context.state,
    deal: args.context.deal,
    message: args.message,
  }
  // `meta` só entra no inbound (campo opcional; não polui o outbound).
  if (args.meta !== undefined) payload.meta = args.meta
  return payload
}

/** Entrega best-effort. NUNCA lança. O header x-webhook-event reflete o evento. */
export async function dispatchMessageEvent(
  admin: SupabaseClient,
  accountId: string,
  payload: MessageEventPayload,
): Promise<void> {
  try {
    const { data: endpoints, error } = await admin
      .from('webhook_endpoints')
      .select('id,url,secret')
      .eq('account_id', accountId)
      .eq('is_active', true)
    if (error) { console.warn('[webhooks] lookup falhou:', error.message); return }
    if (!endpoints || endpoints.length === 0) return

    const rawBody = JSON.stringify(payload)
    await Promise.all(endpoints.map(async (ep: { id: string; url: string; secret: string }) => {
      // Hardening SSRF (#3): não dispara pra host interno/loopback/metadata.
      if (!isValidWebhookUrl(ep.url)) {
        console.warn(`[webhooks] endpoint ${ep.id} URL inválida/bloqueada — pulando`)
        return
      }
      try {
        const res = await fetch(ep.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-webhook-event': payload.event,
            'x-webhook-token': ep.secret,
          },
          body: rawBody,
          redirect: 'manual', // não seguir redirect pra rede interna
          signal: AbortSignal.timeout(10_000),
        })
        if (!res.ok) console.warn(`[webhooks] endpoint ${ep.id} retornou ${res.status}`)
      } catch (e) {
        console.warn(`[webhooks] endpoint ${ep.id} falhou:`, e instanceof Error ? e.message : e)
      }
    }))
  } catch (e) {
    console.warn('[webhooks] dispatch falhou:', e instanceof Error ? e.message : e)
  }
}

// ============================================================
// Aliases de compatibilidade (inbound legado). Mantidos até o T3 migrar a
// chamada do webhook/route.ts pro builder genérico. Depois do T3 podem ser
// removidos, mas não custam nada e protegem qualquer outro consumidor.
// ============================================================

export type MessageReceivedPayload = MessageEventPayload

/** @deprecated use buildMessageEventPayload (mantido pra compatibilidade). */
export function buildMessageReceivedPayload(args: {
  accountId: string
  conversationId: string
  contact: { id: string; phone: string; name: string | null }
  state: { bot_paused: boolean; assigned_agent_id: string | null; conversation_status: string }
  metaMessage: unknown
  metaContact: unknown
  metaMetadata: unknown
}): MessageEventPayload {
  return {
    event: 'message.received',
    direction: 'in',
    timestamp: new Date().toISOString(),
    account_id: args.accountId,
    conversation_id: args.conversationId,
    sender: { type: 'customer', via: 'meta', actor_id: null, actor_name: null, api_key_id: null },
    contact: {
      id: args.contact.id,
      phone: args.contact.phone,
      name: args.contact.name,
      tags: [],
      custom_fields: [],
      referral: null,
      ctwa_clid: null,
    },
    state: {
      bot_paused: args.state.bot_paused,
      conversation_status: args.state.conversation_status,
      assigned_agent_id: args.state.assigned_agent_id,
      assigned_agent_name: null,
      unread_count: null,
      last_message_at: null,
      autoassign_waiting: false,
      created_at: null,
    },
    deal: null,
    message: { id: null, whatsapp_message_id: null, content_type: null, content_text: null, created_at: null },
    meta: { message: args.metaMessage, contact: args.metaContact, metadata: args.metaMetadata },
  }
}

/** @deprecated use dispatchMessageEvent (mantido pra compatibilidade). */
export async function dispatchMessageReceived(
  admin: SupabaseClient,
  accountId: string,
  payload: MessageReceivedPayload,
): Promise<void> {
  return dispatchMessageEvent(admin, accountId, payload)
}
```

- [ ] **Step 2: Reescrever `dispatch.test.ts` (adapta basePayload + novos testes)**

Substitui o conteúdo INTEIRO de `src/lib/webhooks/dispatch.test.ts` pelo abaixo. Mantém a semântica dos testes do inbound (token, header content-type, redirect:manual, SSRF, best-effort, múltiplos endpoints) e adiciona os do builder genérico (`message.sent`, direction, sender, header por evento).

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  buildMessageEventPayload,
  dispatchMessageEvent,
  buildMessageReceivedPayload,
  dispatchMessageReceived,
  type MessageEventPayload,
} from './dispatch'
import { emptyConversationContext } from './enrich'
import type { SupabaseClient } from '@supabase/supabase-js'

// Fake admin client factory — mock-chain ROBUSTO (mesmo padrão do enrich.test):
// qualquer método de filtro (select/eq/is/order/limit) retorna o próprio
// builder; o lookup de endpoints termina com `.eq().eq()` que resolve a Promise
// (o builder é thenable). Não depende da PROFUNDIDADE/ORDEM dos filtros.
function makeAdmin(
  endpoints: { id: string; url: string; secret: string }[] | null = [],
  error: unknown = null,
) {
  const result = { data: endpoints, error }
  const builder: Record<string, unknown> = {}
  const chain = () => builder
  for (const m of ['select', 'eq', 'is', 'order', 'limit']) builder[m] = vi.fn(chain)
  // O dispatch faz `await admin.from(...).select(...).eq(...).eq(...)` — o
  // último `.eq()` precisa resolver. Tornamos o builder thenable.
  builder.then = (resolve: (v: typeof result) => unknown) => resolve(result)
  const from = vi.fn(() => builder)
  return { from } as unknown as SupabaseClient
}

const baseContact = { id: 'c1', phone: '+5592999999999', name: 'Teste' }

// Payload base de OUTBOUND (message.sent) — usado nos testes de entrega.
const baseSentPayload: MessageEventPayload = buildMessageEventPayload({
  event: 'message.sent',
  direction: 'out',
  accountId: 'acc1',
  conversationId: 'conv1',
  sender: { type: 'agent', via: 'inbox', actor_id: 'user-7', actor_name: null, api_key_id: null },
  contact: baseContact,
  context: emptyConversationContext(),
  message: {
    id: 'm1',
    whatsapp_message_id: 'wamid.X',
    content_type: 'text',
    content_text: 'oi',
    created_at: '2026-06-28T17:00:00Z',
  },
  timestamp: '2026-06-28T17:00:00Z',
})

describe('buildMessageEventPayload', () => {
  it('outbound: monta message.sent com direction:out, sender e bloco message', () => {
    expect(baseSentPayload.event).toBe('message.sent')
    expect(baseSentPayload.direction).toBe('out')
    expect(baseSentPayload.sender).toEqual({
      type: 'agent', via: 'inbox', actor_id: 'user-7', actor_name: null, api_key_id: null,
    })
    expect(baseSentPayload.message.whatsapp_message_id).toBe('wamid.X')
    expect(baseSentPayload.timestamp).toBe('2026-06-28T17:00:00Z')
    // outbound NÃO carrega meta cru.
    expect(baseSentPayload.meta).toBeUndefined()
  })

  it('inbound: meta presente quando passado; contact enriquecido', () => {
    const ctx = emptyConversationContext()
    ctx.contact.tags = ['lead']
    const p = buildMessageEventPayload({
      event: 'message.received',
      direction: 'in',
      accountId: 'acc1',
      conversationId: 'conv1',
      sender: { type: 'customer', via: 'meta', actor_id: null, actor_name: null, api_key_id: null },
      contact: baseContact,
      context: ctx,
      message: { id: 'm2', whatsapp_message_id: 'wamid.Y', content_type: 'text', content_text: 'olá', created_at: '2026-06-28T17:05:00Z' },
      meta: { message: { text: 'olá' }, contact: {}, metadata: {} },
    })
    expect(p.direction).toBe('in')
    expect(p.contact.tags).toEqual(['lead'])
    expect(p.meta).toEqual({ message: { text: 'olá' }, contact: {}, metadata: {} })
  })

  it('timestamp default é gerado quando omitido', () => {
    const p = buildMessageEventPayload({
      event: 'message.sent',
      direction: 'out',
      accountId: 'a', conversationId: 'c',
      sender: { type: 'bot', via: 'automation', actor_id: null, actor_name: null, api_key_id: null },
      contact: baseContact,
      context: emptyConversationContext(),
      message: { id: null, whatsapp_message_id: null, content_type: 'text', content_text: 'x', created_at: null },
    })
    expect(typeof p.timestamp).toBe('string')
    expect(p.timestamp.length).toBeGreaterThan(0)
  })
})

describe('buildMessageReceivedPayload (compat legado)', () => {
  it('monta event message.received com direction:in, sender meta e meta cru', () => {
    const result = buildMessageReceivedPayload({
      accountId: 'acc1',
      conversationId: 'conv1',
      contact: baseContact,
      state: { bot_paused: true, assigned_agent_id: 'agent-9', conversation_status: 'pending' },
      metaMessage: { text: 'oi' },
      metaContact: {},
      metaMetadata: {},
    })
    expect(result.event).toBe('message.received')
    expect(result.direction).toBe('in')
    expect(result.sender.via).toBe('meta')
    expect(result.state.bot_paused).toBe(true)
    expect(result.state.assigned_agent_id).toBe('agent-9')
    expect(result.state.conversation_status).toBe('pending')
    expect(result.meta).toEqual({ message: { text: 'oi' }, contact: {}, metadata: {} })
  })
})

describe('dispatchMessageEvent', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('1 endpoint ativo → fetch 1x com token, body e header x-webhook-event=message.sent', async () => {
    const secret = 'whsec_test123'
    const admin = makeAdmin([{ id: 'ep1', url: 'https://n8n.example.com/webhook/abc', secret }])

    await dispatchMessageEvent(admin, 'acc1', baseSentPayload)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://n8n.example.com/webhook/abc')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify(baseSentPayload))
    expect(init.headers['content-type']).toBe('application/json')
    expect(init.headers['x-webhook-event']).toBe('message.sent')
    expect(init.headers['x-webhook-token']).toBe(secret)
    expect(init.headers['x-webhook-signature']).toBeUndefined()
  })

  it('header x-webhook-event reflete message.received quando o evento é inbound', async () => {
    const admin = makeAdmin([{ id: 'ep1', url: 'https://n8n.example.com/webhook/abc', secret: 's' }])
    const inbound = buildMessageReceivedPayload({
      accountId: 'acc1', conversationId: 'conv1', contact: baseContact,
      state: { bot_paused: false, assigned_agent_id: null, conversation_status: 'open' },
      metaMessage: {}, metaContact: {}, metaMetadata: {},
    })

    await dispatchMessageEvent(admin, 'acc1', inbound)

    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers['x-webhook-event']).toBe('message.received')
  })

  it('2 endpoints → 2 fetches', async () => {
    const admin = makeAdmin([
      { id: 'ep1', url: 'https://n8n.example.com/webhook/1', secret: 's1' },
      { id: 'ep2', url: 'https://n8n.example.com/webhook/2', secret: 's2' },
    ])
    await dispatchMessageEvent(admin, 'acc1', baseSentPayload)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('fetch lançando → NÃO lança (best-effort)', async () => {
    fetchMock.mockRejectedValue(new Error('Connection refused'))
    const admin = makeAdmin([{ id: 'ep1', url: 'https://n8n.example.com/webhook/fail', secret: 's' }])
    await expect(dispatchMessageEvent(admin, 'acc1', baseSentPayload)).resolves.toBeUndefined()
  })

  it('nenhum endpoint → não chama fetch', async () => {
    const admin = makeAdmin([])
    await dispatchMessageEvent(admin, 'acc1', baseSentPayload)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('resposta HTTP non-ok (500) → resolve sem lançar', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 })
    const admin = makeAdmin([{ id: 'ep1', url: 'https://n8n.example.com/webhook/fail500', secret: 's' }])
    await expect(dispatchMessageEvent(admin, 'acc1', baseSentPayload)).resolves.toBeUndefined()
  })

  it('erro no lookup do Supabase → resolve e fetch NÃO é chamado', async () => {
    const adminComErro = makeAdmin(null, { message: 'DB down' })
    await expect(dispatchMessageEvent(adminComErro, 'acc1', baseSentPayload)).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('endpoint com URL interna (SSRF) → fetch NÃO é chamado', async () => {
    const admin = makeAdmin([{ id: 'epbad', url: 'http://169.254.169.254/latest', secret: 's' }])
    await dispatchMessageEvent(admin, 'acc1', baseSentPayload)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetch é chamado com redirect:manual', async () => {
    const admin = makeAdmin([{ id: 'ep1', url: 'https://n8n.example.com/webhook/abc', secret: 's' }])
    await dispatchMessageEvent(admin, 'acc1', baseSentPayload)
    const [, init] = fetchMock.mock.calls[0]
    expect(init.redirect).toBe('manual')
  })

  it('integração builder+dispatch: body serializado carrega o contexto enriquecido', async () => {
    // Contexto NÃO-vazio: tags, agente com nome (via 2b), deal não-null e
    // ctwa_clid. Confirma que buildMessageEventPayload + dispatch entregam tudo
    // no corpo do POST (o n8n lê isto pra decidir).
    const context = emptyConversationContext()
    context.contact.tags = ['lead']
    context.contact.ctwa_clid = 'clid-abc'
    context.state.assigned_agent_id = 'user-7'
    context.state.assigned_agent_name = 'Ana Vendas'
    context.deal = {
      id: 'deal-1', title: 'Civic 2020', value: 75000, currency: 'BRL',
      stage: 'Negociação', pipeline: 'Vendas', status: 'active',
    }
    const enriched = buildMessageEventPayload({
      event: 'message.sent',
      direction: 'out',
      accountId: 'acc1',
      conversationId: 'conv1',
      sender: { type: 'agent', via: 'inbox', actor_id: 'user-7', actor_name: null, api_key_id: null },
      contact: baseContact,
      context,
      message: { id: 'm1', whatsapp_message_id: 'wamid.Z', content_type: 'text', content_text: 'oi', created_at: '2026-06-28T17:00:00Z' },
      timestamp: '2026-06-28T17:00:00Z',
    })
    const admin = makeAdmin([{ id: 'ep1', url: 'https://n8n.example.com/webhook/abc', secret: 's' }])

    await dispatchMessageEvent(admin, 'acc1', enriched)

    const [, init] = fetchMock.mock.calls[0]
    const sent = JSON.parse(init.body as string)
    expect(sent.contact.tags).toEqual(['lead'])
    expect(sent.contact.ctwa_clid).toBe('clid-abc')
    expect(sent.state.assigned_agent_name).toBe('Ana Vendas')
    expect(sent.deal).toEqual({
      id: 'deal-1', title: 'Civic 2020', value: 75000, currency: 'BRL',
      stage: 'Negociação', pipeline: 'Vendas', status: 'active',
    })
  })
})

describe('dispatchMessageReceived (compat legado)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })
  afterEach(() => vi.restoreAllMocks())

  it('delega pra dispatchMessageEvent (1 fetch, header message.received)', async () => {
    const admin = makeAdmin([{ id: 'ep1', url: 'https://n8n.example.com/webhook/abc', secret: 's' }])
    const inbound = buildMessageReceivedPayload({
      accountId: 'acc1', conversationId: 'conv1', contact: baseContact,
      state: { bot_paused: false, assigned_agent_id: null, conversation_status: 'open' },
      metaMessage: {}, metaContact: {}, metaMetadata: {},
    })
    await dispatchMessageReceived(admin, 'acc1', inbound)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers['x-webhook-event']).toBe('message.received')
  })
})
```

- [ ] **Step 3: Rodar os testes de dispatch**

Run: `npx vitest run src/lib/webhooks/dispatch.test.ts`
Expected: PASS — todos os blocos verdes (`buildMessageEventPayload`, `buildMessageReceivedPayload`, `dispatchMessageEvent`, `dispatchMessageReceived`).

- [ ] **Step 4: Rodar a suíte de webhooks inteira (regressão)**

Run: `npx vitest run src/lib/webhooks/`
Expected: PASS — `enrich.test.ts` + `dispatch.test.ts` verdes.

- [ ] **Step 5: Typecheck + lint**

Run: `npx tsc --noEmit`
Expected: sem erros.

Run: `npm run lint`
Expected: baseline ≤ 3 warnings.

- [ ] **Step 6: Commit**

```bash
git add src/lib/webhooks/dispatch.ts src/lib/webhooks/dispatch.test.ts
git commit -m "feat(webhooks): dispatch genérico (event/direction/sender/timestamp) + compat inbound"
```

---

## Task 3: Inbound usa o builder genérico (`webhook/route.ts`)

**Files:**
- Modify: `src/app/api/whatsapp/webhook/route.ts` (import na linha 10; bloco de dispatch ~:783-804)

**Interfaces:**
- Consumes de T1: `buildConversationContext` (de `@/lib/webhooks/enrich`).
- Consumes de T2: `buildMessageEventPayload`, `dispatchMessageEvent` (de `@/lib/webhooks/dispatch`).
- Produces: payload inbound enriquecido com `direction:'in'`, `sender:{type:'customer',via:'meta'}`, `timestamp` e os blocos de contexto. Mantém `meta` cru (aditivo).

- [ ] **Step 1: Atualizar o import (linha 10)**

Substitui:

```ts
import { buildMessageReceivedPayload, dispatchMessageReceived } from '@/lib/webhooks/dispatch'
```

por:

```ts
import { buildMessageEventPayload, dispatchMessageEvent } from '@/lib/webhooks/dispatch'
import { buildConversationContext } from '@/lib/webhooks/enrich'
```

- [ ] **Step 2: Substituir o bloco de dispatch (~:783-804)**

Substitui o bloco INTEIRO que começa em `const { data: freshConv } = await supabaseAdmin()` e vai até o fechamento da chamada `await dispatchMessageReceived(...)` (linhas ~783-804) pelo abaixo:

```ts
  // Webhook de saída do agente (best-effort, Caminho A): reencaminha o payload
  // completo da Meta + o estado FRESCO da conversa + o contexto enriquecido
  // (tags, agente, custom fields, deal, CTWA) pros endpoints da conta, pro n8n
  // decidir se responde. Roda POR ÚLTIMO (depois de autoassign, flow runner e
  // automações) pra não serializar o caminho crítico; AWAITED porque dentro do
  // after() um promise solto pode ser cortado antes de completar. Re-lê a
  // conversa pra o state não vir stale (assigned_agent_id pós-autoassign;
  // bot_paused mudado no meio). Nunca lança.
  const admin = supabaseAdmin()
  // Enriquecimento best-effort: traz tags/custom/referral, estado+nome do
  // agente e deal ativo. Substitui o re-SELECT manual de freshConv (o helper
  // já lê o estado fresco da conversa, incl. assigned_agent_id pós-autoassign).
  const context = await buildConversationContext(
    admin,
    accountId,
    conversation.id,
    contactRecord.id,
  )
  // direction:'in' + sender de cliente via Meta. timestamp = horário da
  // mensagem na Meta (epoch → ISO); o `meta` cru segue presente (aditivo,
  // o consumidor atual de message.received depende dele).
  const messageTimestampIso = (() => {
    const epoch = parseInt(message.timestamp)
    return Number.isFinite(epoch) ? new Date(epoch * 1000).toISOString() : new Date().toISOString()
  })()
  await dispatchMessageEvent(
    admin,
    accountId,
    buildMessageEventPayload({
      event: 'message.received',
      direction: 'in',
      accountId,
      conversationId: conversation.id,
      sender: { type: 'customer', via: 'meta', actor_id: null, actor_name: null, api_key_id: null },
      contact: {
        id: contactRecord.id,
        phone: contactRecord.phone,
        name: contactRecord.name ?? null,
      },
      context,
      message: {
        id: null,
        whatsapp_message_id: message.id ?? null,
        content_type: message.type ?? null,
        // `contentText` (não `inboundText`): contentText é null pra mídia/não-texto;
        // `inboundText` tem fallback '' (nunca null) e mascararia mídia como ''.
        content_text: contentText ?? null,
        created_at: messageTimestampIso,
      },
      timestamp: messageTimestampIso,
      meta: { message, contact, metadata: metaMetadata },
    }),
  )
}
```

> **Nota pro implementador:** `message.id`, `message.type` e `message.timestamp` pertencem à interface `WhatsAppMessage` (definida no topo do arquivo, ~:31). `contentText` (`string | null`, definido em ~:559 via `parseMessageContent`) e `metaMetadata` (`unknown`, ~:527) já estão em escopo nesse ponto. Use `contentText` no `content_text` da mensagem — NÃO `inboundText` (esse tem fallback `''` e mascararia mídia/não-texto como string vazia). `contactRecord`, `conversation`, `contact`, `accountId` também estão em escopo. Não é necessário mais nenhum SELECT manual — o `freshConv` foi removido porque `buildConversationContext` lê o estado fresco da conversa.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: sem erros (confirma que `message.type`, `message.id`, `contentText`, `metaMetadata`, `contact` existem no escopo do bloco).

> **Se `tsc` reclamar** que `contentText` ou `metaMetadata` são incompatíveis: `contentText` já é `string | null`, então `contentText ?? null` é seguro; `metaMetadata` é `unknown` (aceito por `meta.metadata: unknown`). Se `message.type` não existir na interface, usar `null` no lugar de `message.type ?? null` e seguir.

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: baseline ≤ 3 warnings.

- [ ] **Step 5: Regressão da suíte de webhooks**

Run: `npx vitest run src/lib/webhooks/`
Expected: PASS (nada quebrou; este arquivo não tem teste unitário próprio, a cobertura é o `tsc`).

- [ ] **Step 6: Commit**

```bash
git add src/app/api/whatsapp/webhook/route.ts
git commit -m "feat(webhooks): inbound usa dispatch genérico (direction:in + sender + timestamp + enrich)"
```

---

## Task 4: Outbound no núcleo de envio + as 2 rotas (`send-message.ts`, `whatsapp/send`, `v1/messages/send`)

**Files:**
- Modify: `src/lib/whatsapp/send-message.ts` (interface `SendMessageInput` ~:43-58; após o insert/return ~:347)
- Modify: `src/app/api/whatsapp/send/route.ts` (chamada de `sendMessageToConversation` ~:27-40)
- Modify: `src/app/api/v1/messages/send/route.ts` (chamada ~:40-53)

**Interfaces:**
- Consumes de T1: `buildConversationContext` (de `@/lib/webhooks/enrich`).
- Consumes de T2: `buildMessageEventPayload`, `dispatchMessageEvent` (de `@/lib/webhooks/dispatch`).
- Produces: campo opcional `source` em `SendMessageInput`:

```ts
source?: {
  via: 'inbox' | 'api'
  actor_id?: string | null
  actor_name?: string | null
  api_key_id?: string | null
}
```

- [ ] **Step 1: Adicionar imports em `send-message.ts`**

Logo após a linha `import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard'` (linha 38), adicionar:

```ts
import { after } from 'next/server'
import { buildConversationContext } from '@/lib/webhooks/enrich'
import { buildMessageEventPayload, dispatchMessageEvent } from '@/lib/webhooks/dispatch'
```

> **Por que `after`:** `send-message.ts` é chamado SÓ pelas 2 rotas (request
> handlers `whatsapp/send` e `v1/messages/send`), e ambas fazem
> `await sendMessageToConversation(...)` ANTES de responder. Se o disparo
> outbound fosse `await`ado dentro da função, ele atrasaria a resposta do envio
> em até ~10s (timeout do fetch). Envolvendo o disparo em `after(() => {...})`,
> ele roda PÓS-resposta (depois do 200), fora do caminho crítico — válido aqui
> porque estamos dentro de um request handler. NÃO usar `void ...catch()` solto:
> em serverless um promise solto pode ser cortado antes de completar; `after()`
> é a primitiva do Next que garante a execução pós-resposta.

- [ ] **Step 2: Adicionar o campo `source` à `SendMessageInput`**

Em `SendMessageInput` (linhas 43-58), logo após `reply_to_message_id?: string`, adicionar:

```ts
  /** Origem do envio — usada pra montar o bloco `sender` do webhook
   *  message.sent. Opcional: se ausente, o disparo outbound é pulado
   *  (ex.: callers internos que não querem espelhar pro n8n). */
  source?: {
    via: 'inbox' | 'api'
    actor_id?: string | null
    actor_name?: string | null
    api_key_id?: string | null
  }
```

- [ ] **Step 3: Desestruturar `source` no corpo da função**

No bloco de desestruturação do `input` (linhas 72-85), adicionar `source,` (ex.: logo após `reply_to_message_id,`):

```ts
    reply_to_message_id,
    source,
```

- [ ] **Step 4: Disparar `message.sent` ANTES do return final**

Substituir a linha final (linha ~347):

```ts
  return { ok: true, message_id: messageRecord.id, whatsapp_message_id: waMessageId }
```

por:

```ts
  // Webhook outbound (best-effort, NÃO-bloqueante): espelha o envio pro n8n
  // como message.sent. Só dispara quando o caller informa `source` (inbox/api).
  // RODA EM after(): pós-resposta do envio, fora do caminho crítico — não
  // adiciona latência ao 200 (diferente de um await aqui, que somaria até ~10s
  // do timeout do fetch). As 2 rotas que chamam esta função são request
  // handlers, então after() é válido e executa depois de responder.
  // Usa o client ADMIN pro lookup de endpoints/enrich — o client de sessão
  // pode não enxergar webhook_endpoints via RLS (mesmo padrão do inbound).
  // sender.type: inbox = humano respondendo (agent); api = agente n8n (bot).
  // NUNCA derruba o envio: dispatch e enrich são best-effort/nunca-lançam, e
  // o try/catch aqui é defesa extra (após o 200 já enviado).
  if (source) {
    // Captura os valores necessários ANTES do after() (escopo do callback).
    const senderType: 'agent' | 'bot' = source.via === 'inbox' ? 'agent' : 'bot'
    const sentMessage = {
      id: messageRecord.id,
      whatsapp_message_id: waMessageId,
      content_type: messageRecord.content_type ?? message_type,
      content_text: messageRecord.content_text ?? content_text ?? null,
      created_at: messageRecord.created_at ?? null,
    }
    after(async () => {
      try {
        const admin = supabaseAdmin()
        const context = await buildConversationContext(
          admin,
          accountId,
          conversation_id,
          contact.id,
        )
        await dispatchMessageEvent(
          admin,
          accountId,
          buildMessageEventPayload({
            event: 'message.sent',
            direction: 'out',
            accountId,
            conversationId: conversation_id,
            sender: {
              type: senderType,
              via: source.via,
              actor_id: source.actor_id ?? null,
              actor_name: source.actor_name ?? null,
              api_key_id: source.api_key_id ?? null,
            },
            contact: {
              id: contact.id,
              phone: contact.phone,
              name: contact.name ?? null,
            },
            context,
            message: sentMessage,
          }),
        )
      } catch (e) {
        console.warn('[webhooks] outbound message.sent falhou:', e instanceof Error ? e.message : e)
      }
    })
  }

  return { ok: true, message_id: messageRecord.id, whatsapp_message_id: waMessageId }
```

- [ ] **Step 5: Passar `source` na rota da inbox (`whatsapp/send/route.ts`)**

Na chamada de `sendMessageToConversation` (linhas 27-40), adicionar `source` logo após `reply_to_message_id: body.reply_to_message_id,`:

```ts
      reply_to_message_id: body.reply_to_message_id,
      // Origem: humano respondendo pela inbox. actor_id = userId da sessão.
      source: { via: 'inbox', actor_id: ctx.userId, actor_name: null, api_key_id: null },
```

- [ ] **Step 6: Passar `source` na rota da API (`v1/messages/send/route.ts`)**

Na chamada de `sendMessageToConversation` (linhas 40-53), adicionar `source` logo após `reply_to_message_id: body.reply_to_message_id,`:

```ts
      reply_to_message_id: body.reply_to_message_id,
      // Origem: agente externo (n8n) via API key. api_key_id permite o n8n
      // filtrar os PRÓPRIOS envios e não entrar em loop. actor_name fica null
      // (ApiKeyContext não carrega o nome da chave — escopo enxuto).
      source: { via: 'api', actor_id: apiKeyId, actor_name: null, api_key_id: apiKeyId },
```

> **Nota:** `apiKeyId` já está desestruturado de `ctx.apiKey` na linha 35-37 desta rota. Não precisa de mudança extra.

- [ ] **Step 7: Cobrir o `source` no teste da rota v1 (`v1/messages/send/route.test.ts`)**

O teste de happy path existente usa `expect.objectContaining({...})` SEM `source` — não cobre a passagem da origem. Substituir a asserção do happy path (no `it('chama sendMessageToConversation com os campos corretos e retorna 200', ...)`) pra exigir o bloco `source` da API:

```ts
    // Verifica que sendMessageToConversation foi chamado com os campos corretos
    // E com o bloco `source` da API (via:'api', actor_id/api_key_id = apiKeyId)
    // — é o que o n8n usa pra filtrar os próprios envios (anti-loop).
    expect(sendMessageMod.sendMessageToConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: fakeApiKeyCtx.accountId,
        conversation_id: VALID_UUID,
        message_type: 'text',
        content_text: 'Olá, teste!',
        source: {
          via: 'api',
          actor_id: fakeApiKeyCtx.apiKeyId,
          actor_name: null,
          api_key_id: fakeApiKeyCtx.apiKeyId,
        },
      }),
    )
```

> **Nota:** `fakeApiKeyCtx.apiKeyId` é `'key-id-test'` (já definido no topo do teste).
> O `sendMessageToConversation` está mockado (não executa o corpo real), então o
> `after()` interno NÃO roda neste teste — só validamos o argumento `source`.

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit`
Expected: sem erros. (Confirma que `messageRecord.content_type`, `messageRecord.content_text`, `messageRecord.created_at` existem — o insert usa `.select().single()` que retorna a linha completa; `ctx.userId` existe no `requireRole` ctx; `apiKeyId` está em escopo; `after` importado de `next/server`.)

- [ ] **Step 9: Regressão dos testes**

Run: `npx vitest run`
Expected: PASS — suíte inteira verde, incl. `v1/messages/send/route.test.ts` com a nova asserção de `source`. (Nenhum teste existente depende da assinatura sem `source`; `source` é opcional. O `after` é mockado como no-op no route.test, então o disparo outbound não dispara fetch nos testes.)

- [ ] **Step 10: Lint**

Run: `npm run lint`
Expected: baseline ≤ 3 warnings.

- [ ] **Step 11: Commit**

```bash
git add src/lib/whatsapp/send-message.ts src/app/api/whatsapp/send/route.ts src/app/api/v1/messages/send/route.ts src/app/api/v1/messages/send/route.test.ts
git commit -m "feat(webhooks): outbound message.sent no envio humano (inbox) + agente (api)"
```

---

## Task 5: Outbound nas automações (`automations/meta-send.ts`)

**Files:**
- Modify: `src/lib/automations/meta-send.ts` (insert em `messages` ~:150; antes do `return` final ~:175)

**Interfaces:**
- Consumes de T1: `buildConversationContext` (de `@/lib/webhooks/enrich`).
- Consumes de T2: `buildMessageEventPayload`, `dispatchMessageEvent` (de `@/lib/webhooks/dispatch`).
- Produces: dispara `message.sent` com `sender:{type:'bot', via:'automation'}` após cada send de automação.

- [ ] **Step 1: Adicionar imports**

Após a linha `import { supabaseAdmin } from './admin-client'` (linha 9), adicionar:

```ts
import { buildConversationContext } from '@/lib/webhooks/enrich'
import { buildMessageEventPayload, dispatchMessageEvent } from '@/lib/webhooks/dispatch'
```

- [ ] **Step 2: Capturar o id interno no insert (`.select().single()`)**

Substituir o insert (linhas ~150-163):

```ts
  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: input.conversationId,
    sender_type: 'bot',
    content_type,
    content_text,
    template_name,
    message_id: waMessageId,
    status: 'sent',
  })
  if (msgErr) {
    // Meta already has the message; record the DB error but don't pretend
    // the send failed. The engine wraps this in a log line.
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)
  }
```

por:

```ts
  const { data: messageRecord, error: msgErr } = await db
    .from('messages')
    .insert({
      conversation_id: input.conversationId,
      sender_type: 'bot',
      content_type,
      content_text,
      template_name,
      message_id: waMessageId,
      status: 'sent',
    })
    .select('id, content_type, content_text, created_at')
    .single()
  if (msgErr) {
    // Meta already has the message; record the DB error but don't pretend
    // the send failed. The engine wraps this in a log line.
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)
  }
```

- [ ] **Step 3: Disparar `message.sent` antes do return final**

Substituir o `return { whatsapp_message_id: waMessageId }` final (linha ~175) por:

```ts
  // Webhook outbound (best-effort): espelha o envio da automação pro n8n como
  // message.sent com sender bot/automation. INTENCIONALMENTE SÍNCRONO (await):
  // este código roda no engine/flow runner, que JÁ está dentro do after() do
  // inbound (webhook/route.ts) — ou seja, já é pós-resposta. NÃO usar after()
  // aqui (só as 2 ROTAS de envio usam after(), porque elas estão no caminho de
  // request). O try/catch NUNCA propaga: derrubar o engine por causa do espelho
  // não é aceitável. (sender.type:'bot' porque automação não é humano.)
  try {
    const context = await buildConversationContext(
      db,
      input.accountId,
      input.conversationId,
      input.contactId,
    )
    await dispatchMessageEvent(
      db,
      input.accountId,
      buildMessageEventPayload({
        event: 'message.sent',
        direction: 'out',
        accountId: input.accountId,
        conversationId: input.conversationId,
        sender: { type: 'bot', via: 'automation', actor_id: input.userId, actor_name: null, api_key_id: null },
        contact: { id: contact.id, phone: contact.phone, name: null },
        context,
        message: {
          id: messageRecord?.id ?? null,
          whatsapp_message_id: waMessageId,
          content_type: messageRecord?.content_type ?? content_type,
          content_text: messageRecord?.content_text ?? content_text,
          created_at: messageRecord?.created_at ?? null,
        },
      }),
    )
  } catch (e) {
    console.warn('[webhooks] outbound automação falhou:', e instanceof Error ? e.message : e)
  }

  return { whatsapp_message_id: waMessageId }
```

> **Nota:** `contact` aqui é o resultado do select `'id, phone'` (linhas 71-76) — não tem `name`, por isso `name: null`. `input.userId` é `string` (não-nulo) em ambos `SendTextArgs`/`SendTemplateArgs` — passar direto (sem `?? null`, que seria dead code). `content_type`/`content_text` são as variáveis já calculadas acima do insert (linhas ~146-147).

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: sem erros.

- [ ] **Step 5: Regressão dos testes**

Run: `npx vitest run`
Expected: PASS — suíte inteira verde.

- [ ] **Step 6: Lint**

Run: `npm run lint`
Expected: baseline ≤ 3 warnings.

- [ ] **Step 7: Commit**

```bash
git add src/lib/automations/meta-send.ts
git commit -m "feat(webhooks): outbound message.sent nas automações (sender bot/automation)"
```

---

## Task 6: Outbound nos flows (`flows/meta-send.ts`)

**Files:**
- Modify: `src/lib/flows/meta-send.ts` (3 pontos de insert + return: `engineSendText` ~:123/144, `engineSendMedia` ~:240/261, `sendInteractiveViaMeta` ~:412/433)

**Interfaces:**
- Consumes de T1: `buildConversationContext`.
- Consumes de T2: `buildMessageEventPayload`, `dispatchMessageEvent`.
- Produces: dispara `message.sent` com `sender:{type:'bot', via:'flow'}` após cada send de flow (texto, mídia, interativo).

Como há 3 funções com o mesmo padrão (insert + update da conversa + return), introduzimos **um helper local** `dispatchFlowSent` neste arquivo pra não repetir o bloco 3x (DRY). Cada função captura o `id` no insert e chama o helper.

- [ ] **Step 1: Adicionar imports**

Após a linha `import { supabaseAdmin } from './admin-client'` (linha 17), adicionar:

```ts
import { buildConversationContext } from '@/lib/webhooks/enrich'
import { buildMessageEventPayload, dispatchMessageEvent } from '@/lib/webhooks/dispatch'
import type { SupabaseClient } from '@supabase/supabase-js'
```

- [ ] **Step 2: Adicionar o helper local `dispatchFlowSent`**

Logo após os imports (antes do primeiro `interface SendTextEngineArgs`, ~linha 34), adicionar:

```ts
// ------------------------------------------------------------
// Helper local: espelha um envio do flow pro n8n como message.sent
// (sender bot/flow). Best-effort — NUNCA lança (não pode derrubar o
// runner). Compartilhado pelas 3 funções de envio deste arquivo (DRY).
//
// INTENCIONALMENTE SÍNCRONO (await): o flow runner já roda dentro do
// after() do inbound (pós-resposta), então NÃO precisa (nem pode) usar
// after() de novo aqui — `after()` é primitiva de request handler, e
// este código não está num. Só as 2 ROTAS de envio (send-message.ts via
// whatsapp/send e v1/messages/send) usam after(). O try/catch nunca
// propaga — derrubar o runner por causa do espelho não é aceitável.
// ------------------------------------------------------------
async function dispatchFlowSent(args: {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contact: { id: string; phone: string }
  userId: string
  message: {
    id: string | null
    whatsapp_message_id: string
    content_type: string
    content_text: string | null
    created_at: string | null
  }
}): Promise<void> {
  try {
    const context = await buildConversationContext(
      args.db,
      args.accountId,
      args.conversationId,
      args.contact.id,
    )
    await dispatchMessageEvent(
      args.db,
      args.accountId,
      buildMessageEventPayload({
        event: 'message.sent',
        direction: 'out',
        accountId: args.accountId,
        conversationId: args.conversationId,
        // sender.type:'bot' — flow não é humano. actor_id = userId (string).
        sender: { type: 'bot', via: 'flow', actor_id: args.userId, actor_name: null, api_key_id: null },
        contact: { id: args.contact.id, phone: args.contact.phone, name: null },
        context,
        message: args.message,
      }),
    )
  } catch (e) {
    console.warn('[webhooks] outbound flow falhou:', e instanceof Error ? e.message : e)
  }
}
```

- [ ] **Step 3: `engineSendText` — capturar id no insert + chamar o helper**

Substituir o insert de `engineSendText` (linhas ~123-133):

```ts
  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: args.conversationId,
    sender_type: 'bot',
    content_type: 'text',
    content_text: args.text,
    message_id: waMessageId,
    status: 'sent',
  })
  if (msgErr) {
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)
  }
```

por:

```ts
  const { data: messageRecord, error: msgErr } = await db
    .from('messages')
    .insert({
      conversation_id: args.conversationId,
      sender_type: 'bot',
      content_type: 'text',
      content_text: args.text,
      message_id: waMessageId,
      status: 'sent',
    })
    .select('id, created_at')
    .single()
  if (msgErr) {
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)
  }
```

E substituir o `return { whatsapp_message_id: waMessageId }` desta função (linha ~144) por:

```ts
  await dispatchFlowSent({
    db,
    accountId: args.accountId,
    conversationId: args.conversationId,
    contact: { id: contact.id, phone: contact.phone },
    userId: args.userId,
    message: {
      id: messageRecord?.id ?? null,
      whatsapp_message_id: waMessageId,
      content_type: 'text',
      content_text: args.text,
      created_at: messageRecord?.created_at ?? null,
    },
  })

  return { whatsapp_message_id: waMessageId }
```

- [ ] **Step 4: `engineSendMedia` — capturar id no insert + chamar o helper**

Substituir o insert de `engineSendMedia` (linhas ~240-250):

```ts
  const preview = args.caption?.trim() || `[${args.kind}]`
  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: args.conversationId,
    sender_type: 'bot',
    content_type: args.kind,
    content_text: args.caption ?? null,
    message_id: waMessageId,
    status: 'sent',
  })
  if (msgErr) {
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)
  }
```

por:

```ts
  const preview = args.caption?.trim() || `[${args.kind}]`
  const { data: messageRecord, error: msgErr } = await db
    .from('messages')
    .insert({
      conversation_id: args.conversationId,
      sender_type: 'bot',
      content_type: args.kind,
      content_text: args.caption ?? null,
      message_id: waMessageId,
      status: 'sent',
    })
    .select('id, created_at')
    .single()
  if (msgErr) {
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)
  }
```

E substituir o `return { whatsapp_message_id: waMessageId }` desta função (linha ~261) por:

```ts
  await dispatchFlowSent({
    db,
    accountId: args.accountId,
    conversationId: args.conversationId,
    contact: { id: contact.id, phone: contact.phone },
    userId: args.userId,
    message: {
      id: messageRecord?.id ?? null,
      whatsapp_message_id: waMessageId,
      content_type: args.kind,
      content_text: args.caption ?? null,
      created_at: messageRecord?.created_at ?? null,
    },
  })

  return { whatsapp_message_id: waMessageId }
```

- [ ] **Step 5: `sendInteractiveViaMeta` — capturar id no insert + chamar o helper**

Substituir o insert de `sendInteractiveViaMeta` (linhas ~412-422):

```ts
  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: input.conversationId,
    sender_type: 'bot',
    content_type: 'interactive',
    content_text: input.bodyText,
    message_id: waMessageId,
    status: 'sent',
  })
  if (msgErr) {
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)
  }
```

por:

```ts
  const { data: messageRecord, error: msgErr } = await db
    .from('messages')
    .insert({
      conversation_id: input.conversationId,
      sender_type: 'bot',
      content_type: 'interactive',
      content_text: input.bodyText,
      message_id: waMessageId,
      status: 'sent',
    })
    .select('id, created_at')
    .single()
  if (msgErr) {
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)
  }
```

E substituir o `return { whatsapp_message_id: waMessageId }` desta função (linha ~433) por:

```ts
  await dispatchFlowSent({
    db,
    accountId: input.accountId,
    conversationId: input.conversationId,
    contact: { id: contact.id, phone: contact.phone },
    userId: input.userId,
    message: {
      id: messageRecord?.id ?? null,
      whatsapp_message_id: waMessageId,
      content_type: 'interactive',
      content_text: input.bodyText,
      created_at: messageRecord?.created_at ?? null,
    },
  })

  return { whatsapp_message_id: waMessageId }
```

> **Nota:** em todas as três funções, `contact` é o resultado do select `'id, phone'` (sem `name`), por isso `name: null` no helper. `args.userId`/`input.userId` são `string` (não-nulos) em todas as interfaces de args deste arquivo — passar direto pro helper (sem `?? null`).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: sem erros.

- [ ] **Step 7: Regressão dos testes**

Run: `npx vitest run`
Expected: PASS — suíte inteira verde.

- [ ] **Step 8: Lint**

Run: `npm run lint`
Expected: baseline ≤ 3 warnings.

- [ ] **Step 9: Commit**

```bash
git add src/lib/flows/meta-send.ts
git commit -m "feat(webhooks): outbound message.sent nos flows (sender bot/flow) via helper DRY"
```

---

## Verificação final (toda a feature)

- [ ] **Suíte completa:** `npx vitest run` → PASS.
- [ ] **Typecheck:** `npx tsc --noEmit` → sem erros.
- [ ] **Lint:** `npm run lint` → baseline ≤ 3 warnings.
- [ ] **E2E manual (n8n `vantage-crm-agente`):**
  1. Cliente manda msg → n8n recebe `message.received` `direction:in` com `tags`/`deal`/`assigned_agent_name`/`referral`/`ctwa_clid` + `meta` cru. Conferir que o `state` traz `bot_paused`/`status`/`assigned_agent_id` REAIS (não os defaults do esqueleto — sinal de que o enrich não degradou).
  2. Humano responde pela inbox → `message.sent` `direction:out` `sender.via:'inbox'` `sender.type:'agent'` `sender.actor_id=<userId>`. Conferir que a RESPOSTA do envio volta rápido (disparo em `after()`, não bloqueia).
  3. Agente n8n responde via API → `message.sent` `sender.via:'api'` `sender.type:'bot'` + `sender.api_key_id` → **n8n ignora (filtro de loop)** → sem loop.
  4. Automação responde → `message.sent` `sender.via:'automation'` `sender.type:'bot'`.
  5. Flow responde (texto/mídia/interativo) → `message.sent` `sender.via:'flow'` `sender.type:'bot'`.
  6. Confirmar no log do n8n que `timestamp` e `sender` chegam corretos e o header `x-webhook-event` reflete o evento.

---

## Documentação do filtro de loop (n8n) — anexar ao manual

No runbook/manual do CRM (Google Doc de implantação), documentar a regra que o n8n DEVE aplicar pra não responder os próprios envios:

> No nó de filtro do workflow `vantage-crm-agente`, ignorar a execução quando:
> `direction === 'out' && sender.via === 'api' && sender.api_key_id === <a chave do próprio n8n>`.
> Os demais `message.sent` (`via: 'inbox'|'automation'|'flow'`) devem ser usados pra
> sincronizar a memória do agente (humano/bot assumiu a conversa), mas não disparam resposta.
>
> **Importante — `actor_id` SEMPRE com `via`:** o significado de `sender.actor_id`
> depende de `sender.via`. Pra `via:'api'`, `actor_id === api_key_id` (a chave que
> enviou). Pra `via:'inbox'|'automation'|'flow'`, `actor_id` é o `user_id` (humano
> ou dono do bot). Nunca compare `actor_id` sem antes checar `via` — senão um
> `user_id` poderia colidir conceitualmente com um `apiKeyId` na sua lógica.

(Esta é uma tarefa de documentação fora do código; não tem commit no repo. Registrar no manual após o merge.)

---

## Self-Review

**1. Cobertura da spec** (cada requisito → task):

| Requisito da spec | Onde |
|---|---|
| `message.sent` em TODO outbound (inbox + api + automation + flow) | T4 (inbox/api), T5 (automation), T6 (flow) |
| Bloco `sender` (type/via/actor_id/actor_name/api_key_id) | T2 (tipo), T3 (customer/meta), T4 (agent/inbox+api), T5 (bot/automation), T6 (bot/flow) |
| `direction` ('in'/'out') nos dois eventos | T2 (tipo + builder), T3 (in), T4/T5/T6 (out) |
| `timestamp` ISO em todo evento + horário da mensagem | T2 (default), T3 (epoch Meta → ISO), T4/T5/T6 (default now / created_at) |
| Payload enriquecido (tags, agente+nome, custom fields, deal/pipeline, CTWA `ctwa_clid`+`referral`) | T1 (`buildConversationContext`: nome do agente via lookup `profiles`; deal por conversa + fallback contato; `ctwa_clid` dedicado), consumido em T3/T4/T5/T6 |
| Header `x-webhook-event` reflete o evento | T2 (`payload.event` no header) + teste |
| Aditivo (não quebra `message.received`) | T2 (compat aliases + `meta` opcional + `ctwa_clid` campo novo), T3 (mantém `meta` cru) |
| Sem migration | confirmado: nenhuma task toca `supabase/migrations/` |
| Best-effort (dispatch + enrich nunca derrubam) | T1 (try/catch por bloco + esqueleto), T2 (dispatch nunca lança), T4 (`after()` + try/catch), T5/T6 (await síncrono + try/catch que nunca propaga) |
| Filtro de loop no n8n (documentar) | seção "Documentação do filtro de loop" |
| Broadcasts/react fora | nenhuma task toca broadcast/react |
| Reuso de entrega/SSRF/token | T2 reusa `isValidWebhookUrl`, headers, redirect, timeout |
| Reuso do padrão de query tags/custom | T1 usa `contact_tags ( tags ( name ) )` / `contact_custom_values ( value, custom_fields ( field_name ) )` |

Sem gaps identificados.

**2. Scan de placeholders:** nenhum "TBD"/"TODO"/"similar a"/"adicione tratamento". Todo step de código mostra o código completo. Comandos exatos com expected.

**3. Consistência de tipos:**
- `ConversationContext` (T1) é consumido por `buildMessageEventPayload` (T2) via `args.context.contact.*` (incl. `ctwa_clid`), `args.context.state`, `args.context.deal` — campos batem (`contact.ctwa_clid` adicionado ao payload em T2; `state` é exatamente `ConversationContext['state']`; `deal` é `ConversationContext['deal']`).
- `MessageSender.type` (T2): T3 = `customer`; T4 = `source.via==='inbox' ? 'agent' : 'bot'` (inbox→agent humano, api→bot n8n); T5/T6 = `bot`. NUNCA hardcodado `agent` pra API. `via` cobre todos os literais do union.
- `NormalizedMessage` (T2): `{id, whatsapp_message_id, content_type, content_text, created_at}` — preenchido consistentemente em T3 (Meta, `content_text: contentText ?? null` — NÃO `inboundText`, que mascararia mídia como `''`), T4 (`messageRecord.*`), T5 (`messageRecord?.*`), T6 (`messageRecord?.*`).
- `source` em `SendMessageInput` (T4): `via:'inbox'|'api'` — a rota inbox passa `'inbox'`, a API passa `'api'`. OK.
- `dispatchFlowSent` (T6) assina `contact:{id,phone}` e `message:NormalizedMessage`-compatível — chamadas batem nas 3 funções.
- `actor_id` (T4/T5/T6): `string` direto (userId/apiKeyId), sem `?? null` (dead code — os campos de origem são não-nulos nesses callers).

**4. Decisões registradas:**
- `actor_name` da API = `null` porque `ApiKeyContext` não carrega `name` (evita lookup extra — escopo enxuto).
- `assigned_agent_name`: SÓ via lookup separado em `profiles` por `user_id` (Bloco 2b), SEM embed no Bloco 2 — `conversations.assigned_agent_id` não tem FK no schema (001:145), então um embed `profiles!...fkey` retornaria PGRST200 pra query inteira e degradaria o `state` (regressão).
- `deal`: lookup por `conversation_id` com FALLBACK por `contact_id` (deals da UI de pipelines têm `conversation_id` null).
- `ctwa_clid`: exposto como campo dedicado de `contact` (coluna 027, separada do `referral` jsonb; usado pelo CAPI).
- Disparo outbound em `send-message.ts` roda em `after()` (request handler, pós-resposta — não soma latência ao envio); em automações/flows roda síncrono (`await`), pois já estão sob o `after()` do inbound.
- `freshConv` (re-SELECT manual do inbound) removido: `buildConversationContext` já lê o estado fresco da conversa.

---

## Notas de risco

- **Nome do agente no enrich (SEM embed):** o Bloco 2 NÃO embute `profiles` — `conversations.assigned_agent_id` não tem FK no schema, e um embed `profiles!conversations_assigned_agent_id_fkey` faria o PostgREST devolver PGRST200 pra REQUISIÇÃO INTEIRA, derrubando o `state` pro esqueleto (regressão silenciosa: o n8n veria `bot_paused:false`/`status:'open'` sempre e responderia por cima de humano). O nome vem EXCLUSIVAMENTE do Bloco 2b (lookup separado em `profiles` por `user_id`). Custo: +1 query quando há agente atribuído — aceitável (best-effort, volume baixo).
- **Custo/volume:** outbound agora dispara em todo envio + enriquecimento = +queries por envio (1 contato, 1 conversa, 0-1 agente, 1-2 deal). Volume baixo (negócios locais); best-effort. Nas 2 rotas roda em `after()` (não soma latência à resposta); em automações/flows é síncrono mas já pós-resposta (dentro do after() do inbound). Se virar gargalo, cachear o contexto por conversa numa janela curta é o próximo passo (fora de escopo).
- **Latência do disparo no envio (RESOLVIDO):** nas 2 rotas (`whatsapp/send`, `v1/messages/send`) o helper é `await`ado ANTES da resposta; se o disparo outbound fosse `await`ado dentro do helper, somaria até ~10s (timeout do fetch) à resposta do envio. Por isso o disparo vai em **`after()`** dentro de `send-message.ts` — roda pós-200, fora do caminho crítico. NÃO usar `void promise.catch()` solto (serverless pode cortar promise não-rastreada). Automações/flows ficam síncronos (`await`) de propósito: rodam no engine/flow runner que JÁ está sob o `after()` do inbound — `after()` ali não se aplica (não é request handler).
- **`meta` no outbound:** propositalmente ausente (campo opcional). Consumidores que esperam `meta` só devem lê-lo quando `direction==='in'`. Documentado no payload da spec.
- **Compat aliases:** `buildMessageReceivedPayload`/`dispatchMessageReceived` ficam como aliases. Após T3, nenhum código de produção os usa (só o teste de compat). Podem ser removidos num PR de limpeza futuro sem pressa.

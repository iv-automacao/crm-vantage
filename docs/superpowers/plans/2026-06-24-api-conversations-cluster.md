# API Conversations Cluster (leitura) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expor endpoints públicos `/api/v1` read-only pra o agente n8n / terceiros lerem o contexto da conversa de um contato — status da conversa e histórico de mensagens paginado.

**Architecture:** Espelha os clusters de contatos/deals já no ar. Schema Zod → camada de serviço account-scoped (`src/lib/conversations/api-service.ts`, service-role admin client com guard de `account_id`) → route handlers via `defineRoute`. Reusa `findContactByPhone`/`getContactById` (contatos) e o helper `apiKeyServiceCtx`. **Sem migração.**

**Tech Stack:** Next.js 16 App Router, TypeScript, Zod v4, Supabase (service role), vitest 4.

## Global Constraints

- Comentários de código em **português**.
- Sem migração: `conversations` já tem `account_id NOT NULL` (017); `messages` não tem `account_id` (escopo via conversa pai já validada).
- Contrato de erro flat e aditivo: `{ error, code?, details? }`. Nunca mudar o shape `{error}`.
- **Read-only:** nenhum endpoint escreve. Contato por telefone OU id (exatamente um). Conversa/contato não encontrado → 404.
- **Tenant:** `conversations` filtrado por `account_id`; mensagens lidas SÓ após validar a conversa ∈ conta (via `getConversationById`). `messages` consultado só por `conversation_id` já validado.
- Identidade (`accountId`/`auditUserId`) sempre via `apiKeyServiceCtx(ctx)` — nunca do body/query/URL. (Read-only não usa `auditUserId`, mas o ctx é o mesmo.)
- Auth: scope `conversations:read` (via `defineRoute` apiKey). Chave sem scope → 403.
- Paginação de mensagens: cursor por `created_at`; `limit` 1..100 (default 30); resposta em ordem cronológica (antiga→nova) + `has_more` + `next_before`.
- `npm run typecheck` limpo, `npm test` verde, `npm run build` exit 0 ao fim de cada task. Sem push/PR/merge.

---

### Task 1: Scope + schemas + serviço de conversas (account-scoped)

**Files:**
- Modify: `src/lib/auth/api-keys.ts` (+`SCOPE_CONVERSATIONS_READ` em `ALL_SCOPES` + `API_KEY_SCOPE_META`)
- Create: `src/lib/api/schemas/conversations.ts` (`ConversationContactQuery`, `MessageListQuery`)
- Create: `src/lib/conversations/api-service.ts`
- Test: `src/lib/auth/api-keys.test.ts` (scope), `src/lib/api/schemas/conversations.test.ts`, `src/lib/conversations/api-service.test.ts`

**Interfaces:**
- Consumes: `ApiServiceCtx` (`@/lib/api/service-context`), `NotFoundError` (`@/lib/api/errors`), `findContactByPhone`/`getContactById` (`@/lib/contacts/api-service`).
- Produces: `SCOPE_CONVERSATIONS_READ='conversations:read'`; Zod `ConversationContactQuery`/`MessageListQuery`; serviço (recebe `ctx: ApiServiceCtx`): `findConversationsByContact(ctx, q): Promise<ConversationResource[]>`, `getConversationById(ctx, id): Promise<ConversationResource>` (lança `NotFoundError`), `listMessages(ctx, conversationId, opts): Promise<{ messages: MessageResource[]; has_more: boolean; next_before: string|null }>`.
- Tipos: `ConversationResource = { id; contact_id; status; assigned_agent_id: string|null; last_message_text: string|null; last_message_at: string|null; unread_count: number; created_at; updated_at }`; `MessageResource = { id; sender_type; content_type; content_text: string|null; media_url: string|null; status; created_at }`.

- [ ] **Step 1: Scope em `api-keys.ts`**

Adicionar:
```ts
export const SCOPE_CONVERSATIONS_READ = 'conversations:read'
// ALL_SCOPES passa a incluir SCOPE_CONVERSATIONS_READ
// API_KEY_SCOPE_META ganha:
//   [SCOPE_CONVERSATIONS_READ]: { label: 'Ler conversas', description: 'Ler conversas e histórico de mensagens.' },
```
Em `api-keys.test.ts` adicionar 1 caso: `sanitizeScopes(['conversations:read','x'])` → `['conversations:read']`.

- [ ] **Step 2: Rodar — passa** (`sanitizeScopes` já existe)

Run: `npx vitest run src/lib/auth/api-keys.test.ts` — PASS.

- [ ] **Step 3: Schemas `src/lib/api/schemas/conversations.ts`**
```ts
import { z } from 'zod'

export const ConversationContactQuery = z
  .object({
    contact_phone: z.string().min(5).optional(),
    contact_id: z.string().uuid().optional(),
  })
  .refine((v) => !!v.contact_phone !== !!v.contact_id, {
    message: 'Envie exatamente um de contact_phone ou contact_id',
  })
  .meta({ id: 'ConversationContactQuery' })

export const MessageListQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(30),
    before: z.string().datetime().optional(),
  })
  .meta({ id: 'MessageListQuery' })

export type MessageListQuery = z.infer<typeof MessageListQuery>
```
Teste `conversations.test.ts`: `ConversationContactQuery` rejeita vazio e os dois, aceita um; `MessageListQuery` default 30, `limit=200` falha, `before` não-ISO falha, `before` ISO ok.

- [ ] **Step 4: Rodar — falha** (`src/lib/conversations` ainda não existe)

Run: `npx vitest run src/lib/api/schemas/conversations.test.ts src/lib/conversations` — FAIL.

- [ ] **Step 5: Testes do serviço (fake admin client injetado, padrão de `src/lib/contacts/api-service.test.ts` / `src/lib/deals/api-service.test.ts`)**

Casos: `getConversationById` (achou→ConversationResource; não/outra conta→NotFoundError); `findConversationsByContact` (resolve contato e filtra por account_id+contact_id); `listMessages` (valida conversa ∈ conta ANTES — conversa de outra conta→NotFoundError; pega `limit+1` e seta `has_more`/`next_before`; retorna em ordem cronológica antiga→nova).

- [ ] **Step 6: Implementar `src/lib/conversations/api-service.ts`**

Padrões (account-scoped, service-role; comentários em português):
- `getConversationById`: `admin.from('conversations').select('id,contact_id,status,assigned_agent_id,last_message_text,last_message_at,unread_count,created_at,updated_at').eq('id', id).eq('account_id', ctx.accountId).maybeSingle()` → null lança `NotFoundError('Conversa não encontrada')`. Montar `ConversationResource`.
- `findConversationsByContact`: resolve contato via `findContactByPhone(ctx, q.contact_phone)` (ou `getContactById(ctx, q.contact_id)`); contato null → retorna `[]` (ou lança NotFound se id explícito não existe — usar `getContactById` que já lança). Depois `admin.from('conversations').select(...mesmos campos).eq('account_id', ctx.accountId).eq('contact_id', contactId).order('last_message_at', { ascending: false })`. Mapear pra `ConversationResource[]`.
- `listMessages(ctx, conversationId, { limit, before })`: **chamar `getConversationById(ctx, conversationId)` primeiro** (valida tenant; lança 404 se não for da conta). Depois:
  ```ts
  let q = admin.from('messages')
    .select('id,sender_type,content_type,content_text,media_url,status,created_at')
    .eq('conversation_id', conversationId)
  if (before) q = q.lt('created_at', before)
  const { data } = await q.order('created_at', { ascending: false }).limit(limit + 1)
  const rows = data ?? []
  const has_more = rows.length > limit
  const page = has_more ? rows.slice(0, limit) : rows
  const next_before = has_more ? (page[page.length - 1].created_at as string) : null
  const messages = [...page].reverse() // cronológico: antiga → nova
  return { messages: messages.map(toMessageResource), has_more, next_before }
  ```

- [ ] **Step 7: Rodar — passa**

Run: `npm run typecheck && npx vitest run src/lib/api/schemas/conversations.test.ts src/lib/conversations`
Expected: PASS.

- [ ] **Step 8: Commit**
```bash
git add src/lib/auth/api-keys.ts src/lib/auth/api-keys.test.ts src/lib/api/schemas/conversations.ts src/lib/api/schemas/conversations.test.ts src/lib/conversations/api-service.ts src/lib/conversations/api-service.test.ts
git commit -m "feat(conversations): scope + schemas + serviço de leitura (account-scoped)"
```

---

### Task 2: Route handlers `/api/v1` + rate limit + OpenAPI

**Files:**
- Create: `src/app/api/v1/conversations/route.ts` (GET ?contact_phone=/?contact_id=)
- Create: `src/app/api/v1/conversations/[id]/route.ts` (GET por id)
- Create: `src/app/api/v1/conversations/[id]/messages/route.ts` (GET histórico)
- Create test: `src/app/api/v1/conversations/route.test.ts`
- Modify: `src/lib/rate-limit.ts` (preset `conversationsRead`)
- Modify: `src/lib/api/openapi/spec.ts` (registrar 3 ops + import dos schemas)

**Interfaces:**
- Consumes: `defineRoute` (`@/lib/api/handler`), `apiKeyServiceCtx` (`@/lib/api/service-context`), `SCOPE_CONVERSATIONS_READ` (`@/lib/auth/api-keys`), serviço da Task 1, schemas da Task 1, `RATE_LIMITS`. Erros: `ApiBadRequestError` (`@/lib/api/errors`) pra id ausente.

- [ ] **Step 1: Preset de rate limit (`src/lib/rate-limit.ts`)**
```ts
/** Leitura de conversas/mensagens via API. Por conta. */
conversationsRead: { limit: 240, windowMs: 60_000 },
```

- [ ] **Step 2: Testes dos handlers (serviço + resolveApiKey mockados, padrão de `src/app/api/v1/contacts/route.test.ts` e `deals/route.test.ts`)**

`GET /api/v1/conversations`: sem Bearer→401; chave sem `conversations:read`→403; query sem contato→422; serviço lança `NotFoundError`→404; happy path→200 `{conversations}`. Para `/messages`: happy path→200 `{messages, has_more, next_before}` (pode testar o handler direto com serviço mockado).

- [ ] **Step 3: Rodar — falha**

Run: `npx vitest run src/app/api/v1/conversations/route.test.ts` — FAIL.

- [ ] **Step 4: Implementar os 3 route handlers**

Molde (usar `apiKeyServiceCtx(ctx)` pro ctx do serviço; ler `[id]` de `new URL(req.url).pathname.split('/').filter(Boolean)`):
```ts
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/handler'
import { apiKeyServiceCtx } from '@/lib/api/service-context'
import { SCOPE_CONVERSATIONS_READ } from '@/lib/auth/api-keys'
import { ConversationContactQuery } from '@/lib/api/schemas/conversations'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { findConversationsByContact } from '@/lib/conversations/api-service'

export const GET = defineRoute({
  auth: { type: 'apiKey', scopes: [SCOPE_CONVERSATIONS_READ] },
  query: ConversationContactQuery,
  rateLimit: { preset: RATE_LIMITS.conversationsRead, key: (ctx) => `conversationsRead:${apiKeyServiceCtx(ctx).accountId}` },
  openapi: { summary: 'Conversas de um contato', tags: ['Conversations'], operationId: 'findConversationsByContact' },
  handler: async ({ query, ctx }) => {
    const conversations = await findConversationsByContact(apiKeyServiceCtx(ctx), query)
    return NextResponse.json({ conversations })
  },
})
```
- `[id]/route.ts` (GET): ler `id` = penúltimo? NÃO — para `/conversations/{id}` o id é o último segmento: `new URL(req.url).pathname.split('/').filter(Boolean).pop()`. Se vazio → `throw new ApiBadRequestError('id da conversa ausente')`. Chama `getConversationById` → `{ conversation }`.
- `[id]/messages/route.ts` (GET): o id da conversa é o **penúltimo** segmento (último é `messages`): `const segs = new URL(req.url).pathname.split('/').filter(Boolean); const id = segs[segs.length - 2]`. Se vazio → `ApiBadRequestError`. `query: MessageListQuery`. Chama `listMessages(ctx, id, query)` → `{ messages, has_more, next_before }`.
  Erros do serviço (`NotFoundError`) sobem e o funil do `defineRoute` mapeia (404).

- [ ] **Step 5: Rodar — passa**

Run: `npx vitest run src/app/api/v1/conversations/route.test.ts` — PASS.

- [ ] **Step 6: Registrar no OpenAPI (`src/lib/api/openapi/spec.ts`)**

`import '@/lib/api/schemas/conversations'` (efeito colateral) + `registerOperation`:
```ts
registerOperation({ method: 'get', path: '/api/v1/conversations',              summary: 'Conversas de um contato', tags:['Conversations'], operationId:'findConversationsByContact', security:'apiKey' })
registerOperation({ method: 'get', path: '/api/v1/conversations/{id}',         summary: 'Obter conversa', tags:['Conversations'], operationId:'getConversation', security:'apiKey' })
registerOperation({ method: 'get', path: '/api/v1/conversations/{id}/messages', summary: 'Histórico de mensagens (paginado)', tags:['Conversations'], operationId:'listMessages', security:'apiKey' })
```

- [ ] **Step 7: Verificação + commit**

Run: `npm run typecheck && npx vitest run src/app/api/v1 src/lib/api/openapi && npm run build`
Expected: verde, build exit 0. (Manual na review: `/docs` mostra a tag "Conversations".)
```bash
git add src/app/api/v1/conversations src/lib/rate-limit.ts src/lib/api/openapi/spec.ts
git commit -m "feat(api): endpoints /api/v1 de conversas (leitura: conversa + histórico) + OpenAPI"
```

---

## Self-Review (feito)

- **Cobertura do spec:** scope (T1), schemas xor + limit/before (T1), serviço findByContact/getById/listMessages com tenant-validation-antes-de-mensagens (T1), paginação cursor cronológica + has_more/next_before (T1), 3 endpoints + rate limit + OpenAPI (T2), `[id]` (último) e id-da-conversa em `/messages` (penúltimo) (T2). ✓
- **Sem migração** confirmado. ✓
- **Consistência de tipos:** `ConversationResource`/`MessageResource`, `findConversationsByContact`/`getConversationById`/`listMessages`, `SCOPE_CONVERSATIONS_READ`, `ConversationContactQuery`/`MessageListQuery` — idênticos entre T1/T2. ✓
- **Tenant:** `listMessages` chama `getConversationById` (account-scoped) ANTES de ler mensagens — invariante crítica anotada. `messages` sem account_id é seguro porque o `conversation_id` já foi validado. ✓
- **Risco do `/messages` route:** o id da conversa é o PENÚLTIMO segmento do path (último é `messages`) — anotado explícito no T2 step4 pra não pegar `messages` como id.

## Fora de escopo (próximas rodadas)
Escrita (fechar/reabrir/atribuir/marcar lida); listagem geral de conversas; conteúdo rico (reações/reply/interactive); clusters de broadcasts e orquestração.

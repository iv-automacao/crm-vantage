# API Deals Cluster (Funil de Vendas) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expor endpoints públicos `/api/v1` pra o agente n8n / terceiros operarem o funil de vendas — criar negócio, mover de etapa, marcar ganho/perdido, ler negócios e listar pipelines — referenciando pipeline/etapa por nome e contato por telefone/id.

**Architecture:** Espelha o cluster de contatos (já no ar). Schemas Zod → camada de serviço account-scoped (`src/lib/deals/api-service.ts`, service-role admin client com guard de `account_id`) → route handlers via `defineRoute`. Reusa `findContactByPhone`/`getContactById` do cluster de contatos pra resolver o contato. Extrai um helper compartilhado `apiKeyServiceCtx`/`ApiServiceCtx` (resolve o follow-up DRY da review anterior).

**Tech Stack:** Next.js 16 App Router, TypeScript, Zod v4, Supabase (service role), vitest 4.

## Global Constraints

- Comentários de código em **português**.
- Sem migração de banco: `pipelines`/`pipeline_stages`/`deals` já têm `account_id NOT NULL` (017).
- Contrato de erro flat e aditivo: `{ error: string, code?: string, details?: [{field,message}] }`. Nunca mudar o shape `{error}`.
- Referência **por nome**: pipeline na conta, etapa dentro do pipeline; contato por telefone OU id (exatamente um). Nome inexistente → **422** (`unknown_pipeline`/`unknown_stage`); contato não achado → 404.
- **Moeda sempre do `accounts.default_currency`** (NOT NULL, default 'USD') — nunca do cliente.
- **Status do deal:** criar sempre com `'open'` (igual a engine `create_deal`); PATCH aceita enum `'open'|'won'|'lost'`. (Ignorar o DEFAULT legado `'active'` do schema — sempre setar explícito.)
- Tenant: TODA query com guard explícito de `account_id`. Etapa resolvida só dentro de pipeline da conta. Deal validado ∈ conta antes de qualquer update.
- Auditoria: `deals.user_id` (NOT NULL) = `auditUserId` do ctx (= `createdByUserId ?? ownerUserId` da chave).
- Auth: leitura `deals:read`, escrita `deals:write` (via `defineRoute` apiKey). Chave sem scope → 403.
- `npm run typecheck` limpo, `npm test` verde, `npm run build` exit 0 ao fim de cada task. Sem push/PR/merge.

---

### Task 1: Primitivos compartilhados — scopes, erros, service-context, schemas

**Files:**
- Modify: `src/lib/auth/api-keys.ts` (+`SCOPE_DEALS_READ`/`SCOPE_DEALS_WRITE` em `ALL_SCOPES` + `API_KEY_SCOPE_META`)
- Modify: `src/lib/api/errors.ts` (+`UnknownPipelineError`, `UnknownStageError`)
- Create: `src/lib/api/service-context.ts` (tipo `ApiServiceCtx` + `apiKeyServiceCtx`)
- Create: `src/lib/api/schemas/deals.ts` (`DealCreateBody`, `DealPatchBody`, `DealContactQuery`)
- Test: `src/lib/auth/api-keys.test.ts` (deals scopes válidos), `src/lib/api/errors.test.ts` (novos 422), `src/lib/api/schemas/deals.test.ts`, `src/lib/api/service-context.test.ts`

**Interfaces:**
- Produces: `SCOPE_DEALS_READ='deals:read'`, `SCOPE_DEALS_WRITE='deals:write'`; `UnknownPipelineError(name)`/`UnknownStageError(name)` (422, subclasses de `ApiError`); `interface ApiServiceCtx { admin: SupabaseClient; accountId: string; auditUserId: string }`; `apiKeyServiceCtx(ctx: ResolvedCtx): ApiServiceCtx`; Zod `DealCreateBody`/`DealPatchBody`/`DealContactQuery`.

- [ ] **Step 1: Scopes em `api-keys.ts`**

Adicionar as duas constantes e incluí-las em `ALL_SCOPES` + `API_KEY_SCOPE_META`:
```ts
export const SCOPE_DEALS_READ = 'deals:read'
export const SCOPE_DEALS_WRITE = 'deals:write'
// ALL_SCOPES passa a incluir SCOPE_DEALS_READ, SCOPE_DEALS_WRITE
// API_KEY_SCOPE_META ganha:
//   [SCOPE_DEALS_READ]:  { label: 'Ler negócios', description: 'Ler negócios e listar pipelines.' },
//   [SCOPE_DEALS_WRITE]: { label: 'Gerenciar negócios', description: 'Criar e atualizar negócios no funil.' },
```
Em `api-keys.test.ts` adicionar 1 caso: `sanitizeScopes(['deals:write','x'])` → `['deals:write']`.

- [ ] **Step 2: Rodar — passa** (`sanitizeScopes` já existe)

Run: `npx vitest run src/lib/auth/api-keys.test.ts` — PASS.

- [ ] **Step 3: Erros em `errors.ts`**
```ts
export class UnknownPipelineError extends ApiError {
  constructor(name: string) {
    super(422, 'unknown_pipeline', `O pipeline '${name}' não existe nesta conta. Crie no CRM primeiro.`, [
      { field: 'pipeline', message: `pipeline '${name}' não existe` },
    ])
  }
}
export class UnknownStageError extends ApiError {
  constructor(name: string) {
    super(422, 'unknown_stage', `A etapa '${name}' não existe neste pipeline.`, [
      { field: 'stage', message: `etapa '${name}' não existe` },
    ])
  }
}
```
Teste em `errors.test.ts`: `new UnknownPipelineError('Vendas')` → status 422, code `unknown_pipeline`, details[0].field `pipeline`.

- [ ] **Step 4: `src/lib/api/service-context.ts`**
```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ResolvedCtx } from '@/lib/api/handler'
import type { ApiKeyContext } from '@/lib/auth/api-key-context'

/** Contexto que as camadas de serviço account-scoped recebem. */
export interface ApiServiceCtx {
  admin: SupabaseClient
  accountId: string
  auditUserId: string
}

/**
 * Deriva o ApiServiceCtx do ctx resolvido por uma rota apiKey.
 * Identidade SEMPRE da chave — nunca do corpo/URL. Auditoria cai
 * pro dono da conta quando a chave não tem criador rastreado.
 */
export function apiKeyServiceCtx(ctx: ResolvedCtx): ApiServiceCtx {
  const { apiKey } = ctx as Extract<ResolvedCtx, { auth: 'apiKey' }>
  return {
    admin: apiKey.supabase,
    accountId: apiKey.accountId,
    auditUserId: apiKey.createdByUserId ?? apiKey.ownerUserId,
  }
}
```
Teste `service-context.test.ts`: passar um ctx fake `{auth:'apiKey', apiKey:{supabase:{}, accountId:'a', createdByUserId:null, ownerUserId:'o'}}` → `apiKeyServiceCtx` retorna `auditUserId:'o'`; com `createdByUserId:'c'` → `'c'`.

- [ ] **Step 5: Schemas `src/lib/api/schemas/deals.ts`**
```ts
import { z } from 'zod'

export const DealCreateBody = z
  .object({
    contact_phone: z.string().min(5).optional(),
    contact_id: z.string().uuid().optional(),
    pipeline: z.string().min(1),
    stage: z.string().min(1),
    title: z.string().min(1).max(200),
    value: z.number().nonnegative().optional(),
  })
  .refine((v) => !!v.contact_phone !== !!v.contact_id, {
    message: 'Envie exatamente um de contact_phone ou contact_id',
  })
  .meta({ id: 'DealCreateBody' })

export const DealPatchBody = z
  .object({
    stage: z.string().min(1).optional(),
    status: z.enum(['open', 'won', 'lost']).optional(),
    value: z.number().nonnegative().optional(),
    title: z.string().min(1).max(200).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Envie ao menos um campo' })
  .meta({ id: 'DealPatchBody' })

export const DealContactQuery = z
  .object({
    contact_phone: z.string().min(5).optional(),
    contact_id: z.string().uuid().optional(),
  })
  .refine((v) => !!v.contact_phone !== !!v.contact_id, {
    message: 'Envie exatamente um de contact_phone ou contact_id',
  })
  .meta({ id: 'DealContactQuery' })

export type DealCreateBody = z.infer<typeof DealCreateBody>
export type DealPatchBody = z.infer<typeof DealPatchBody>
```
Teste `deals.test.ts`: `DealCreateBody` rejeita sem contato e com os dois; aceita com um + pipeline/stage/title; `DealPatchBody` rejeita `{}`, aceita `{status:'won'}` e rejeita `{status:'x'}`.

- [ ] **Step 6: Rodar todos + commit**

Run: `npm run typecheck && npx vitest run src/lib/auth/api-keys.test.ts src/lib/api`
```bash
git add src/lib/auth/api-keys.ts src/lib/api/errors.ts src/lib/api/errors.test.ts src/lib/api/service-context.ts src/lib/api/service-context.test.ts src/lib/api/schemas/deals.ts src/lib/api/schemas/deals.test.ts src/lib/auth/api-keys.test.ts
git commit -m "feat(api): primitivos do cluster deals — scopes, erros, service-context, schemas"
```

---

### Task 2: Camada de serviço de deals (account-scoped)

**Files:**
- Create: `src/lib/deals/api-service.ts`
- Create test: `src/lib/deals/api-service.test.ts`

**Interfaces:**
- Consumes: `ApiServiceCtx` (`@/lib/api/service-context`), `UnknownPipelineError`/`UnknownStageError`/`NotFoundError` (`@/lib/api/errors`), `findContactByPhone`/`getContactById` (`@/lib/contacts/api-service`), tipos `DealCreateBody`/`DealPatchBody` (`@/lib/api/schemas/deals`).
- Produces (todas recebem `ctx: ApiServiceCtx`): `createDeal(ctx, body): Promise<DealResource>`, `getDealById(ctx, id): Promise<DealResource>` (lança `NotFoundError`), `updateDeal(ctx, id, patch): Promise<DealResource>`, `listDealsByContact(ctx, q): Promise<DealResource[]>`, `listPipelines(ctx): Promise<PipelineResource[]>`. Internas exportadas pra teste: `resolvePipelineByName(ctx, name)`, `resolveStageByName(ctx, pipelineId, name)`.
- Tipos: `DealResource = { id; title; value; currency; status; pipeline: {id;name}; stage: {id;name}; contact_id; expected_close_date: string|null; created_at; updated_at }`; `PipelineResource = { id; name; stages: {id;name;position;color}[] }`.

**Padrões de query (account-scoped, service-role):**
- Pipeline por nome: `admin.from('pipelines').select('id,name').eq('account_id', accountId).eq('name', name).maybeSingle()` → null lança `UnknownPipelineError(name)`.
- Etapa por nome: `admin.from('pipeline_stages').select('id,name').eq('pipeline_id', pipelineId).eq('name', name).maybeSingle()` → null lança `UnknownStageError(name)`. (Tenant garantido pelo pipeline já resolvido na conta.)
- Contato: `resolveContact(ctx, q)` reusa `findContactByPhone(ctx, phone)` ou `getContactById(ctx, id)` do cluster de contatos (ambos account-scoped) → não achou lança `NotFoundError`.
- Moeda: `admin.from('accounts').select('default_currency').eq('id', accountId).maybeSingle()` → `?.default_currency ?? 'USD'`.
- Insert deal: `{ account_id, user_id: auditUserId, pipeline_id, stage_id, contact_id, title, value: value ?? 0, currency, status: 'open' }`.
- Update deal: validar `admin.from('deals').select('id,pipeline_id').eq('id', id).eq('account_id', accountId).maybeSingle()` → null lança `NotFoundError`. Se `patch.stage`, resolver dentro de `deal.pipeline_id` → `stage_id`. Montar update por allow-list (`stage_id`/`status`/`value`/`title`) + `updated_at`.
- Montar `DealResource` lendo o deal + join `pipeline:pipelines(id,name)` + `stage:pipeline_stages(id,name)` (normalizar array→objeto, como o `getCurrentAccount` faz).

- [ ] **Step 1: Testes (fake admin client injetado, padrão de `src/lib/contacts/api-service.test.ts`)**

Casos: `resolvePipelineByName` (achou→id; não→UnknownPipelineError); `resolveStageByName` (não→UnknownStageError); `createDeal` (resolve pipeline→stage→contato e chama insert com `status:'open'` e currency da conta; pipeline inexistente → UnknownPipelineError ANTES do insert); `updateDeal` (deal de outra conta / inexistente → NotFoundError; `stage` resolve dentro do pipeline do deal); `getDealById` (ausente → NotFoundError).

- [ ] **Step 2: Rodar — falha**

Run: `npx vitest run src/lib/deals/api-service.test.ts` — FAIL.

- [ ] **Step 3: Implementar `src/lib/deals/api-service.ts`**

Seguir os padrões acima. Resolver TODOS os nomes ANTES de inserir (fail-fast). Comentários em português. Reusar os helpers de contato (não reimplementar resolução de contato).

- [ ] **Step 4: Rodar — passa**

Run: `npx vitest run src/lib/deals/api-service.test.ts` — PASS.

- [ ] **Step 5: typecheck + commit**

Run: `npm run typecheck`
```bash
git add src/lib/deals/api-service.ts src/lib/deals/api-service.test.ts
git commit -m "feat(deals): camada de serviço da API (create/get/update/list + resolvers), account-scoped"
```

---

### Task 3: Route handlers `/api/v1` + rate limit + OpenAPI

**Files:**
- Create: `src/app/api/v1/deals/route.ts` (POST criar, GET ?contact_phone=/?contact_id=)
- Create: `src/app/api/v1/deals/[id]/route.ts` (GET, PATCH)
- Create: `src/app/api/v1/pipelines/route.ts` (GET)
- Create test: `src/app/api/v1/deals/route.test.ts`
- Modify: `src/lib/rate-limit.ts` (presets `dealsWrite`, `dealsRead`)
- Modify: `src/lib/api/openapi/spec.ts` (registrar 5 ops + import dos schemas de deals)

**Interfaces:**
- Consumes: `defineRoute` (`@/lib/api/handler`), `apiKeyServiceCtx` (`@/lib/api/service-context`), `SCOPE_DEALS_READ/WRITE` (`@/lib/auth/api-keys`), serviço da Task 2, schemas da Task 1, `RATE_LIMITS`.

- [ ] **Step 1: Presets de rate limit (`src/lib/rate-limit.ts`)**
```ts
/** Escrita de negócios via API. Por conta. */
dealsWrite: { limit: 120, windowMs: 60_000 },
/** Leitura de negócios/pipelines via API. Mais folgado. */
dealsRead: { limit: 240, windowMs: 60_000 },
```

- [ ] **Step 2: Testes dos handlers (serviço + resolveApiKey mockados, padrão de `src/app/api/v1/contacts/route.test.ts`)**

`POST /api/v1/deals`: sem Bearer→401; chave sem `deals:write`→403; JSON malformado→400; body sem contato (nem phone nem id)→422; serviço lança `UnknownPipelineError`→422 `unknown_pipeline`; happy path→201 `{deal}`.

- [ ] **Step 3: Rodar — falha**

Run: `npx vitest run src/app/api/v1/deals/route.test.ts` — FAIL.

- [ ] **Step 4: Implementar os 3 route handlers**

Molde (POST cria) — usar `apiKeyServiceCtx(ctx)` pra o ctx do serviço:
```ts
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/handler'
import { apiKeyServiceCtx } from '@/lib/api/service-context'
import { SCOPE_DEALS_WRITE, SCOPE_DEALS_READ } from '@/lib/auth/api-keys'
import { DealCreateBody, DealContactQuery } from '@/lib/api/schemas/deals'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { createDeal, listDealsByContact } from '@/lib/deals/api-service'

export const POST = defineRoute({
  auth: { type: 'apiKey', scopes: [SCOPE_DEALS_WRITE] },
  body: DealCreateBody,
  rateLimit: { preset: RATE_LIMITS.dealsWrite, key: (ctx) => `dealsWrite:${apiKeyServiceCtx(ctx).accountId}` },
  openapi: { summary: 'Criar negócio', tags: ['Deals'], operationId: 'createDeal' },
  handler: async ({ body, ctx }) => {
    const deal = await createDeal(apiKeyServiceCtx(ctx), body)
    return NextResponse.json({ deal }, { status: 201 })
  },
})

export const GET = defineRoute({
  auth: { type: 'apiKey', scopes: [SCOPE_DEALS_READ] },
  query: DealContactQuery,
  rateLimit: { preset: RATE_LIMITS.dealsRead, key: (ctx) => `dealsRead:${apiKeyServiceCtx(ctx).accountId}` },
  openapi: { summary: 'Listar negócios de um contato', tags: ['Deals'], operationId: 'listDealsByContact' },
  handler: async ({ query, ctx }) => {
    const deals = await listDealsByContact(apiKeyServiceCtx(ctx), query)
    return NextResponse.json({ deals })
  },
})
```
`[id]/route.ts` (GET + PATCH) — ler o `id` de `new URL(req.url).pathname.split('/').filter(Boolean).pop()`; se vazio → `new ApiBadRequestError('id do negócio ausente')` (de `@/lib/api/errors`). GET chama `getDealById`, PATCH chama `updateDeal(ctx, id, body)` com `body: DealPatchBody`, scope `deals:write`. `pipelines/route.ts` GET chama `listPipelines`, scope `deals:read`, retorna `{ pipelines }`. Erros do serviço sobem e o funil do `defineRoute` mapeia (UnknownPipeline/Stage→422, NotFound→404).

- [ ] **Step 5: Rodar — passa**

Run: `npx vitest run src/app/api/v1/deals/route.test.ts` — PASS.

- [ ] **Step 6: Registrar no OpenAPI (`src/lib/api/openapi/spec.ts`)**

`import '@/lib/api/schemas/deals'` (efeito colateral) + `registerOperation` pra cada:
```ts
registerOperation({ method: 'post',  path: '/api/v1/deals',        summary: 'Criar negócio', tags:['Deals'], operationId:'createDeal', security:'apiKey', requestBodySchemaId:'DealCreateBody', successDescription:'Negócio criado.' })
registerOperation({ method: 'get',   path: '/api/v1/deals',        summary: 'Listar negócios de um contato', tags:['Deals'], operationId:'listDealsByContact', security:'apiKey' })
registerOperation({ method: 'get',   path: '/api/v1/deals/{id}',   summary: 'Obter negócio', tags:['Deals'], operationId:'getDeal', security:'apiKey' })
registerOperation({ method: 'patch', path: '/api/v1/deals/{id}',   summary: 'Atualizar negócio (etapa/status/valor/título)', tags:['Deals'], operationId:'patchDeal', security:'apiKey', requestBodySchemaId:'DealPatchBody' })
registerOperation({ method: 'get',   path: '/api/v1/pipelines',    summary: 'Listar pipelines e etapas', tags:['Deals'], operationId:'listPipelines', security:'apiKey' })
```

- [ ] **Step 7: Verificação + commit**

Run: `npm run typecheck && npx vitest run src/app/api/v1 src/lib/api/openapi && npm run build`
Expected: verde, build exit 0. (Manual na review: `/docs` mostra a tag "Deals".)
```bash
git add src/app/api/v1/deals src/app/api/v1/pipelines src/lib/rate-limit.ts src/lib/api/openapi/spec.ts
git commit -m "feat(api): endpoints /api/v1 de deals (criar/mover/ganho-perdido/listar) + pipelines + OpenAPI"
```

---

## Self-Review (feito)

- **Cobertura do spec:** scopes (T1), erros 422 (T1), schemas+refine de contato-exclusivo (T1), service-context compartilhado (T1), resolvers por nome + create/update/list account-scoped + moeda da conta + status 'open' (T2), reuso de findContactByPhone/getContactById (T2), 5 endpoints + rate limit + OpenAPI (T3), `[id]` hardening 400 (T3). ✓
- **Sem migração** confirmado. ✓
- **Consistência de tipos:** `ApiServiceCtx`/`apiKeyServiceCtx`, `DealResource`/`PipelineResource`, `resolvePipelineByName`/`resolveStageByName`, `UnknownPipelineError`/`UnknownStageError` — idênticos entre T1/T2/T3. ✓
- **Status:** sempre setar explícito ('open' no create; enum no PATCH) — não confiar no DEFAULT legado 'active' do schema. Anotado nos Global Constraints. ✓
- **Tenant:** etapa resolvida só dentro de pipeline da conta; deal validado ∈ conta antes do update; contato via helpers account-scoped. ✓

## Fora de escopo (próximas rodadas)
Mover entre pipelines; deletar deal; `assigned_to`/`notes`/`expected_close_date` no create; dedup de deal por contato; CRUD de pipelines via API; clusters de conversas/broadcasts/orquestração.

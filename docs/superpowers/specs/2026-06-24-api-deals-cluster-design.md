# Design — API pública do cluster Funil de Vendas (Deals)

**Data:** 2026-06-24 · **Status:** aprovado no brainstorming, aguardando review do spec

## Contexto

Segundo cluster da API pública (`/api/v1`), sobre a fundação `defineRoute` + Zod + OpenAPI e o padrão de serviço account-scoped já estabelecidos (ver `crm-vantage-api-foundation`; cluster de contatos no ar via PR #9). Objetivo: dar ao agente n8n / terceiros a capacidade de **operar o funil de vendas** — criar negócio quando o lead qualifica, mover de etapa conforme avança, marcar ganho/perdido. Fecha o loop *upsert contato → cria deal → move no funil*.

**Consumidor:** agente n8n interno **e** terceiros — construir robusto desde já.

## Decisões travadas (brainstorming)

- **Referência por nome** (igual contatos): pipeline e etapa por nome, contato por telefone (ou id). Nome inexistente → **422** claro. Sem auto-criação.
- **Loop completo do agente:** criar + mover etapa + ganho/perdido + editar valor/título (tudo via PATCH) + ler negócio + listar negócios de um contato + listar pipelines/etapas.
- **Moeda sempre do `accounts.default_currency`** — nunca vem do cliente.
- **PATCH `stage`** resolve a etapa dentro do pipeline atual do negócio (mover entre pipelines fica fora de escopo).

## Fatos do código (grounding)

- `pipelines`, `pipeline_stages` (via pipeline pai), `deals` — todos `account_id NOT NULL` (migration 017), RLS por `is_account_member`. **Sem migração necessária.**
- `deals` colunas: `id, user_id (NOT NULL, auditoria), account_id, pipeline_id, stage_id, contact_id, conversation_id, assigned_to, title, value, currency, notes, expected_close_date, status ('open'|'won'|'lost')`.
- `pipeline_stages`: `id, pipeline_id, name, position, color`. Nome único por pipeline (ordenado por `position`).
- Padrão `create_deal` da engine (`src/lib/automations/engine.ts:503-528`): insere `account_id`+`user_id`(audit)+`pipeline_id`+`stage_id`+`contact_id`+`title`(interpolado)+`value`+`currency` (do `accounts.default_currency`, fallback 'USD')+`status:'open'`.
- Reuso do cluster de contatos: `findContactByPhone`/`getContactById` (`src/lib/contacts/api-service.ts`) pra resolver/validar o contato dentro da conta.
- Auth/auditoria: `resolveApiKey` já retorna `createdByUserId`/`ownerUserId` (auditoria = `createdByUserId ?? ownerUserId`). Endpoints usam service-role admin client com guard explícito de `account_id`.

## Arquitetura (espelha o cluster de contatos)

```
src/lib/api/service-context.ts       # NOVO: tipo ApiServiceCtx {admin,accountId,auditUserId} + apiKeyServiceCtx(resolvedCtx) (resolve follow-up DRY)
src/lib/api/schemas/deals.ts         # Zod: DealCreateBody, DealPatchBody, DealContactQuery (.meta({id}))
src/lib/deals/api-service.ts         # createDeal/getDealById/updateDeal/listDealsByContact/listPipelines + resolvers por nome, account-scoped
src/lib/api/errors.ts                # +UnknownPipelineError, UnknownStageError (422)
src/lib/auth/api-keys.ts             # +SCOPE_DEALS_READ/WRITE em ALL_SCOPES + API_KEY_SCOPE_META
src/app/api/v1/deals/route.ts                # POST (criar) + GET (?contact_phone=/?contact_id=)
src/app/api/v1/deals/[id]/route.ts           # GET (por id) + PATCH (stage/status/value/title)
src/app/api/v1/pipelines/route.ts            # GET (listar pipelines+etapas)
src/lib/api/openapi/spec.ts          # registra os endpoints novos
src/lib/rate-limit.ts                # presets dealsWrite/dealsRead
```

### Scopes
`deals:read`, `deals:write` adicionados a `ALL_SCOPES` + `API_KEY_SCOPE_META` (label PT). Os checkboxes do painel de chaves já renderizam de `ALL_SCOPES` → aparecem automaticamente. Chave sem o scope → 403.

### Endpoints

| Método | Rota | Scope | Ação |
|---|---|---|---|
| POST | `/api/v1/deals` | `deals:write` | Cria negócio |
| GET | `/api/v1/deals/{id}` | `deals:read` | Negócio por id |
| PATCH | `/api/v1/deals/{id}` | `deals:write` | Move etapa / status / valor / título |
| GET | `/api/v1/deals?contact_phone=` (ou `?contact_id=`) | `deals:read` | Negócios de um contato |
| GET | `/api/v1/pipelines` | `deals:read` | Pipelines + etapas |

### Schemas (Zod, `src/lib/api/schemas/deals.ts`)
- `DealCreateBody`: `{ contact_phone?: string, contact_id?: string (uuid), pipeline: string, stage: string, title: string, value?: number }` — refine: exige `contact_phone` OU `contact_id` (exatamente um).
- `DealPatchBody`: `{ stage?: string, status?: enum('open'|'won'|'lost'), value?: number, title?: string }` — refine: ao menos um campo.
- `DealContactQuery`: `{ contact_phone?: string, contact_id?: string }` — refine: exatamente um.
- Resposta `DealResource`: `{ id, title, value, currency, status, pipeline: {id,name}, stage: {id,name}, contact_id, expected_close_date, created_at, updated_at }`.

### Lógica de negócio (`src/lib/deals/api-service.ts`, recebe `ApiServiceCtx`)
- `resolvePipelineByName(ctx, name)` → `pipelines WHERE account_id AND name`; null → `UnknownPipelineError(name)` (422).
- `resolveStageByName(ctx, pipelineId, name)` → `pipeline_stages WHERE pipeline_id AND name`; null → `UnknownStageError(name)` (422).
- `resolveContact(ctx, {contact_phone, contact_id})` → reusa `findContactByPhone`/`getContactById`; não achou → `NotFoundError`.
- `createDeal(ctx, body)` → resolve pipeline→stage→contato (todos ANTES de inserir); lê `accounts.default_currency` (fallback 'USD'); insere deal (`account_id`, `user_id: auditUserId`, status 'open'); retorna `DealResource`.
- `updateDeal(ctx, id, patch)` → valida deal ∈ conta (`.eq('id').eq('account_id')` → null = `NotFoundError`); se `stage` veio, resolve dentro do `pipeline_id` atual do deal; monta update por allow-list (`stage_id`/`status`/`value`/`title` apenas) + `updated_at`; retorna `DealResource`.
- `getDealById(ctx, id)` / `listDealsByContact(ctx, {contact_phone|contact_id})` — leitura account-scoped (lista resolve o contato primeiro, depois `deals WHERE account_id AND contact_id`).
- `listPipelines(ctx)` → pipelines da conta + suas etapas (ordenadas por `position`).

### Erros (contrato `{ error, code?, details? }`)
- `unknown_pipeline` / `unknown_stage` → 422 com `details`.
- `status` inválido / falta contato / dois contatos → 422 (validação Zod).
- Deal/contato não encontrado → 404 `not_found`.
- Scope faltando → 403; conta suspensa → 403 `account_pending`; sem Bearer → 401.

### Rate limit
`dealsWrite` (120/min por conta), `dealsRead` (240/min por conta) em `RATE_LIMITS`; key por `account_id`.

## Fora de escopo (próximas rodadas)
- Mover negócio entre pipelines; deletar negócio; atribuir a um membro (`assigned_to`); `notes`/`expected_close_date` no create.
- Dedup de negócio por contato (v1 = create cria sempre).
- CRUD de pipelines/etapas via API (só leitura nesta rodada).
- Outros clusters: conversas/mensagens (leitura), broadcasts, orquestração.

## Verificação (E2E)
1. `typecheck` limpo, `npm test` verde, `build` exit 0.
2. Chave com `deals:write` → `POST /api/v1/deals {contact_phone, pipeline:'Vendas', stage:'Novo', title:'Lead X'}` cria deal com a moeda da conta. `PATCH /deals/{id} {stage:'Negociação'}` move; `{status:'won'}` marca ganho.
3. Pipeline/etapa inexistente → 422 `unknown_pipeline`/`unknown_stage`. Status inválido → 422. Chave só com `contacts:write` → 403. Sem Bearer → 401.
4. `GET /deals?contact_phone=` lista os negócios do contato; `GET /pipelines` lista pipelines+etapas.
5. `/docs` mostra a tag "Deals" com os endpoints; `/api/openapi.json` inclui os schemas.
6. Isolamento multi-tenant: deal/pipeline/etapa/contato de outra conta nunca alcançável (guard de `account_id`; etapa resolvida só dentro de pipeline da conta).

## Pós-implementação
- Atualizar memória `crm-vantage-api-foundation`: cluster Deals no ar, scopes `deals:read/write`, helper compartilhado `apiKeyServiceCtx`/`ApiServiceCtx`.

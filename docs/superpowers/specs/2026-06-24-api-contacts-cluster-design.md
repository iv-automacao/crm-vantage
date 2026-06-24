# Design — API pública do cluster Lead → CRM (Contatos / Tags / Campos)

**Data:** 2026-06-24 · **Status:** aprovado no brainstorming, aguardando review do spec

## Contexto

A API pública do CRM (`/api/v1`, fundação `defineRoute` + Zod + OpenAPI/Scalar — ver `crm-vantage-api-foundation`) hoje só expõe **`POST /api/v1/messages/send`**. O objetivo é dar ao agente n8n (e a terceiros) a capacidade de **transformar conversa em registro no CRM**: capturar um lead e cadastrá-lo/enriquecê-lo automaticamente. Este spec cobre o **primeiro cluster — Lead → CRM**: contatos, tags e campos customizados. Os demais clusters (conversas/mensagens-leitura, deals, broadcasts) seguem o mesmo padrão em rodadas futuras.

**Consumidor:** ambos — agente n8n interno **e** terceiros externos. Logo, construir robusto desde já: contrato firme, erros claros, documentado no OpenAPI.

## Decisões travadas (brainstorming)

- **Tags/campos só existentes:** a API aplica apenas tags/campos já criados no CRM (pela equipe na UI). Nome inexistente → **422** com mensagem clara. Sem auto-criação (evita proliferação de tags duplicadas).
- **Leitura:** get por id + busca por telefone nesta rodada. Listagem paginada de contatos fica pra depois.
- **Scopes via checkboxes:** o painel de chaves ganha seleção de scopes por checkbox (least-privilege) ao criar a chave.
- **Escopo de endpoints:** "herói + leitura" (upsert com tags/campos inline, PATCH, GET por id/telefone, listar tags/campos). Remover tag granular fica pra próxima.

## Fatos do código (grounding)

- **Dedupe:** `findExistingContact(db, accountId, phone)` em `src/lib/contacts/dedupe.ts` — pré-filtra por sufixo de 8 dígitos + `phonesMatch` estrito. `isUniqueViolation(err)` detecta 23505 (backstop de corrida). `normalizeKey/normalizePhone` = forma canônica.
- **`contacts`:** `phone_normalized` é coluna **gerada no banco** (migration 022) com UNIQUE `(account_id, phone_normalized) WHERE phone_normalized <> ''`. Colunas: `id, user_id (NOT NULL, auditoria), account_id, phone, name, email, company, avatar_url`.
- **`tags` e `custom_fields`:** ambos `account_id NOT NULL` (migration 017), RLS por `is_account_member`. A engine resolve por **id** (`tag_id`, `custom:<id>`); a API resolve por **nome** dentro da conta.
- **`contact_tags`:** sem `account_id` (RLS via contato pai). Aplicar tag exige validar contato **e** tag na mesma conta.
- **`contact_custom_values`:** UNIQUE `(contact_id, custom_field_id)` → upsert com `onConflict`.
- **Auditoria:** chave de API carrega só `account_id`. `contacts.user_id` é NOT NULL → usar `api_key.created_by_user_id` (fallback `accounts.owner_user_id`).
- **Auth:** endpoints de chave usam service-role admin client (sem sessão) com guard explícito de `account_id` em toda query — padrão de `sendMessageToConversation`/`resolveApiKey`.

## Arquitetura

```
src/lib/api/schemas/contacts.ts      # Zod: ContactUpsertBody, ContactPatchBody, ContactPhoneQuery, etc. (.meta({id}))
src/lib/contacts/api-service.ts      # lógica de negócio reusável (upsert/update/get/aplicar tags/campos), account-scoped
src/lib/auth/api-keys.ts             # +scopes novos (CONTACTS_READ, CONTACTS_WRITE) + lista ALL_SCOPES
src/app/api/v1/contacts/route.ts             # POST (upsert) + GET (?phone=)
src/app/api/v1/contacts/[id]/route.ts        # GET (por id) + PATCH (update)
src/app/api/v1/tags/route.ts                 # GET (listar tags da conta)
src/app/api/v1/custom-fields/route.ts        # GET (listar definições de campo da conta)
src/lib/api/openapi/spec.ts          # registra os novos endpoints + scopes
src/components/settings/api-keys-panel.tsx   # checkboxes de scope no dialog de criação
src/app/api/account/api-keys/route.ts        # POST aceita `scopes[]` validado contra ALL_SCOPES
```

### Scopes
- `messages:send` (existente), `contacts:read`, `contacts:write`.
- `src/lib/auth/api-keys.ts` exporta `ALL_SCOPES` (lista) e os metadados (label PT pra UI). Criação de chave valida que os scopes pedidos ∈ `ALL_SCOPES`.
- Chaves antigas (só `messages:send`) → 403 nos endpoints novos (força concessão explícita). Comportamento correto/seguro.

### Endpoints

| Método | Rota | Scope | Ação |
|---|---|---|---|
| POST | `/api/v1/contacts` | `contacts:write` | **Upsert por telefone** + aplica `tags[]`/`custom_fields[]` inline |
| PATCH | `/api/v1/contacts/{id}` | `contacts:write` | Atualiza `name/email/company` + opcional `tags[]`/`custom_fields[]` |
| GET | `/api/v1/contacts/{id}` | `contacts:read` | Contato por id (com tags + valores de campo) |
| GET | `/api/v1/contacts?phone=` | `contacts:read` | Busca por telefone (dedupe) → contato ou `null` |
| GET | `/api/v1/tags` | `contacts:read` | Lista tags da conta (`id, name, color`) |
| GET | `/api/v1/custom-fields` | `contacts:read` | Lista definições de campo (`id, field_name, field_type, field_options`) |

### Schemas (Zod, `src/lib/api/schemas/contacts.ts`)
- `ContactUpsertBody`: `{ phone: string (req), name?, email? (email), company?, tags?: string[], custom_fields?: {name: string, value: string}[] }`.
- `ContactPatchBody`: igual sem `phone` (todos opcionais; ao menos 1 campo).
- `ContactPhoneQuery`: `{ phone: string (req) }`.
- Resposta `ContactResource`: `{ id, phone, name, email, company, tags: string[], custom_fields: {name,value}[], created_at, updated_at }`.

### Lógica de negócio (`src/lib/contacts/api-service.ts`)
Funções account-scoped que os route handlers chamam (recebem `admin` client + `accountId` + `auditUserId`):
- `upsertContactByPhone(...)` — `findExistingContact`; se existe → update parcial; senão → insert (com `user_id` de auditoria); backstop `isUniqueViolation` re-busca. Depois aplica tags/campos. Retorna `ContactResource`.
- `updateContact(id, patch)` — valida contato ∈ conta; update parcial; aplica tags/campos opcionais.
- `getContactById(id)` / `findContactByPhone(phone)` — leitura com tags + valores.
- `applyTagsByName(contactId, names[])` — resolve cada nome em `tags WHERE account_id AND name`; nome inexistente → erro tipado `UnknownTagError` (→ 422); insere em `contact_tags` (idempotente).
- `setCustomFieldsByName(contactId, pairs[])` — resolve nome em `custom_fields WHERE account_id AND field_name`; inexistente → `UnknownFieldError` (→ 422); upsert em `contact_custom_values` (`onConflict: contact_id,custom_field_id`).
- `listTags()` / `listCustomFields()`.

### Erros (contrato existente `{ error, code?, details? }`)
- Nome de tag/campo inexistente → **422** `code: 'unknown_tag'` / `'unknown_field'`, `details: [{field, message}]` com o nome ofensor.
- `phone` inválido/vazio → 422 (validação Zod).
- Contato não encontrado (GET/PATCH por id) → 404 `code: 'not_found'`.
- Scope faltando → 403 (via `defineRoute`). Conta suspensa → 403 `account_pending` (via `resolveApiKey`). Sem Bearer → 401.

### Rate limit
- Reusar/estender `RATE_LIMITS`: writes de contato com um preset (ex.: `contactsWrite` 120/min por conta, igual `apiSend`); leituras com preset mais folgado. Key por `account_id`.

## Fora de escopo (próximas rodadas)
- Listagem paginada de contatos com filtros (por tag/data).
- Remover tag granular; deletar contato.
- Outros clusters: conversas/mensagens (leitura de histórico), deals/pipelines, broadcasts.
- Webhooks de saída (CRM → n8n) e rotação/expiração de chave.

## Verificação (E2E)
1. `typecheck` limpo, `npm test` verde, `build` exit 0.
2. Criar chave com `contacts:write` (checkbox novo) → `POST /api/v1/contacts {phone, name, tags:['cliente']}` cria contato com a tag; repetir mesma chamada → atualiza (não duplica). `GET /api/v1/contacts?phone=` acha o contato.
3. Tag inexistente → 422 `unknown_tag`. Chave só com `messages:send` → 403 nos endpoints novos. Sem Bearer → 401.
4. `GET /api/v1/tags` e `/api/v1/custom-fields` retornam o vocabulário da conta.
5. `/docs` (Scalar) lista os novos endpoints com scopes e exemplos; `/api/openapi.json` inclui os schemas novos.
6. Isolamento multi-tenant: contato/tag/campo de outra conta nunca alcançável (guard de `account_id` em toda query).

## Pós-implementação
- Atualizar memória `crm-vantage-api-foundation` (ou nova entrada): cluster Contatos no ar, scopes `contacts:read/write`, seletor de scopes na UI, padrão `api-service` account-scoped pra reusar nos próximos clusters.

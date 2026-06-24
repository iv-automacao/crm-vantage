# API Contacts Cluster (Lead → CRM) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expor endpoints públicos `/api/v1` pra o agente n8n / terceiros criarem e enriquecerem contatos (upsert por telefone, tags e campos customizados por nome), com seletor de scopes na UI de chaves.

**Architecture:** Reusa a fundação `defineRoute` + Zod + OpenAPI (ver `crm-vantage-api-foundation`). Lógica de negócio account-scoped numa camada de serviço (`src/lib/contacts/api-service.ts`) que os route handlers chamam via service-role admin client com guard explícito de `account_id`. Erros tipados (`ApiError`) fluem pelo funil único `toErrorResponse`, agora generalizado.

**Tech Stack:** Next.js 16 App Router, TypeScript, Zod v4, Supabase (service role), vitest 4.

## Global Constraints

- Comentários de código em **português**.
- Sem migração de banco: `tags`/`custom_fields` já têm `account_id NOT NULL` (017); `api_keys.scopes` já é `TEXT[]`.
- Contrato de erro **flat e aditivo**: `{ error: string, code?: string, details?: [{field,message}] }`. Nunca mudar o shape `{error}` que o frontend lê.
- Tags/campos: aplicar **apenas os já existentes** na conta; nome inexistente → **422** claro. Sem auto-criação.
- Tenant: TODA query com guard explícito de `account_id`. Tags via contato pai (contact_tags não tem account_id).
- Auditoria: `contacts.user_id` (NOT NULL) = `api_key.created_by_user_id` com fallback `accounts.owner_user_id`.
- Auth dos endpoints: `apiKey` scopes — leitura `contacts:read`, escrita `contacts:write`. Chave sem o scope → 403 (via `defineRoute`).
- `npm run typecheck` limpo, `npm test` verde, `npm run build` exit 0 ao fim de cada task. Sem push/PR/merge (controlador decide no fim).

---

### Task 1: Scopes novos + criação de chave aceita scopes (backend)

**Files:**
- Modify: `src/lib/auth/api-keys.ts` (adicionar scopes + metadados + validador)
- Modify: `src/app/api/account/api-keys/route.ts:50-121` (POST aceita `scopes[]`)
- Test: `src/lib/auth/api-keys.test.ts` (existe; adicionar casos de scope)

**Interfaces:**
- Produces: `SCOPE_CONTACTS_READ='contacts:read'`, `SCOPE_CONTACTS_WRITE='contacts:write'`, `ALL_SCOPES: readonly string[]`, `API_KEY_SCOPE_META: Record<string,{label:string;description:string}>`, `sanitizeScopes(input: unknown): string[]` (mantém só scopes válidos; default `['messages:send']` se vazio).

- [ ] **Step 1: Teste de `sanitizeScopes`**

```ts
// em src/lib/auth/api-keys.test.ts
import { sanitizeScopes, SCOPE_MESSAGES_SEND, SCOPE_CONTACTS_WRITE } from './api-keys'

describe('sanitizeScopes', () => {
  it('mantém só scopes válidos', () => {
    expect(sanitizeScopes(['contacts:write', 'inventado:x'])).toEqual([SCOPE_CONTACTS_WRITE])
  })
  it('default messages:send quando vazio/ inválido', () => {
    expect(sanitizeScopes([])).toEqual([SCOPE_MESSAGES_SEND])
    expect(sanitizeScopes(undefined)).toEqual([SCOPE_MESSAGES_SEND])
    expect(sanitizeScopes('x')).toEqual([SCOPE_MESSAGES_SEND])
  })
  it('dedup', () => {
    expect(sanitizeScopes(['contacts:read','contacts:read'])).toEqual(['contacts:read'])
  })
})
```

- [ ] **Step 2: Rodar — falha (sanitizeScopes não existe)**

Run: `npx vitest run src/lib/auth/api-keys.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar em `src/lib/auth/api-keys.ts`**

```ts
export const SCOPE_CONTACTS_READ = 'contacts:read'
export const SCOPE_CONTACTS_WRITE = 'contacts:write'

/** Todos os scopes que uma chave pode ter. Fonte da verdade. */
export const ALL_SCOPES = [
  SCOPE_MESSAGES_SEND,
  SCOPE_CONTACTS_READ,
  SCOPE_CONTACTS_WRITE,
] as const

/** Metadados pra UI (checkboxes) — label/descrição em português. */
export const API_KEY_SCOPE_META: Record<string, { label: string; description: string }> = {
  [SCOPE_MESSAGES_SEND]: { label: 'Enviar mensagens', description: 'Enviar mensagens em conversas desta conta.' },
  [SCOPE_CONTACTS_READ]: { label: 'Ler contatos', description: 'Buscar contatos e listar tags/campos.' },
  [SCOPE_CONTACTS_WRITE]: { label: 'Gerenciar contatos', description: 'Criar/atualizar contatos e aplicar tags/campos.' },
}

/**
 * Normaliza scopes vindos do cliente: mantém só os válidos, dedup,
 * e cai pra ['messages:send'] se nada válido sobrar.
 */
export function sanitizeScopes(input: unknown): string[] {
  const valid = new Set<string>(ALL_SCOPES)
  const arr = Array.isArray(input) ? input.filter((s): s is string => typeof s === 'string') : []
  const kept = [...new Set(arr)].filter((s) => valid.has(s))
  return kept.length > 0 ? kept : [SCOPE_MESSAGES_SEND]
}
```

- [ ] **Step 4: Rodar — passa**

Run: `npx vitest run src/lib/auth/api-keys.test.ts`
Expected: PASS.

- [ ] **Step 5: POST aceita `scopes[]`**

Em `src/app/api/account/api-keys/route.ts`: importar `sanitizeScopes` (remover import isolado de `SCOPE_MESSAGES_SEND` se não usado), e trocar o insert de `scopes: [SCOPE_MESSAGES_SEND]` por:

```ts
// após validar name, antes do insert:
const scopes = sanitizeScopes(body?.scopes)
// ...
.insert({
  account_id: ctx.accountId,
  name,
  token_hash: tokenHash,
  prefix,
  scopes,
  created_by_user_id: ctx.userId,
})
```

- [ ] **Step 6: typecheck + commit**

Run: `npm run typecheck`
```bash
git add src/lib/auth/api-keys.ts src/lib/auth/api-keys.test.ts src/app/api/account/api-keys/route.ts
git commit -m "feat(api-keys): scopes contacts:read/write + criação aceita scopes"
```

---

### Task 2: Checkboxes de scope no dialog de criação de chave (UI)

**Files:**
- Modify: `src/components/settings/api-keys-panel.tsx` (estado + checkboxes + envia scopes)

**Interfaces:**
- Consumes: `ALL_SCOPES`, `API_KEY_SCOPE_META`, `SCOPE_MESSAGES_SEND` de `@/lib/auth/api-keys`.

- [ ] **Step 1: Estado de scopes selecionados**

Adicionar perto dos outros `useState` (após linha 76 `newName`):
```ts
import { ALL_SCOPES, API_KEY_SCOPE_META, SCOPE_MESSAGES_SEND } from '@/lib/auth/api-keys';
// ...
const [selectedScopes, setSelectedScopes] = useState<string[]>([SCOPE_MESSAGES_SEND]);

function toggleScope(scope: string) {
  setSelectedScopes((prev) =>
    prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
  );
}
```

- [ ] **Step 2: Enviar scopes no `handleCreate`**

Trocar `body: JSON.stringify({ name })` por `body: JSON.stringify({ name, scopes: selectedScopes })`. Após sucesso, resetar: `setSelectedScopes([SCOPE_MESSAGES_SEND])` (junto do `setNewName('')`). No `onOpenChange` de fechar o dialog, também resetar `setSelectedScopes([SCOPE_MESSAGES_SEND])`.

- [ ] **Step 3: Checkboxes no form do dialog**

No bloco de criação (após o campo Nome, ~linha 406), adicionar:
```tsx
<div className="space-y-2 py-2">
  <Label className="text-muted-foreground">Permissões da chave</Label>
  <div className="space-y-2">
    {ALL_SCOPES.map((scope) => (
      <label key={scope} className="flex cursor-pointer items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={selectedScopes.includes(scope)}
          onChange={() => toggleScope(scope)}
          className="mt-0.5 size-4 accent-primary"
        />
        <span>
          <span className="font-medium text-foreground">{API_KEY_SCOPE_META[scope].label}</span>
          <span className="block text-xs text-muted-foreground">
            {API_KEY_SCOPE_META[scope].description}
          </span>
        </span>
      </label>
    ))}
  </div>
</div>
```
Ajustar a `DialogDescription` (linha ~395) pra: "Dê um nome e escolha o que a chave pode fazer." (remover a frase fixa "apenas enviar mensagens").

- [ ] **Step 4: Verificação manual + typecheck**

Run: `npm run typecheck && npx eslint src/components/settings/api-keys-panel.tsx`
Expected: typecheck limpo, eslint sem erros no arquivo. (UI: validar no dev na review final.)

- [ ] **Step 5: Commit**
```bash
git add src/components/settings/api-keys-panel.tsx
git commit -m "feat(settings): seletor de scopes (checkboxes) ao criar chave de API"
```

---

### Task 3: Primitivos compartilhados — schemas Zod + erros ApiError + toErrorResponse generalizado

**Files:**
- Create: `src/lib/api/schemas/contacts.ts`
- Create test: `src/lib/api/schemas/contacts.test.ts`
- Modify: `src/lib/api/errors.ts` (classes `ApiError` + subclasses)
- Modify: `src/lib/auth/account.ts` (generalizar `toErrorResponse`)
- Test: `src/lib/auth/account.test.ts` se existir, senão `src/lib/api/errors.test.ts` (adicionar casos)

**Interfaces:**
- Produces (schemas): `ContactUpsertBody`, `ContactPatchBody`, `ContactPhoneQuery` (Zod) + tipos inferidos.
- Produces (erros): `class ApiError extends Error { status: number; code: string; details?: {field:string;message:string}[] }`, e subclasses `UnknownTagError(name)`, `UnknownFieldError(name)`, `NotFoundError(msg)`, `ApiBadRequestError(msg)`.
- `toErrorResponse` passa a tratar qualquer `ApiError` (emite `{error, code, details?}` no `status`).

- [ ] **Step 1: Teste dos schemas**
```ts
// src/lib/api/schemas/contacts.test.ts
import { ContactUpsertBody, ContactPatchBody, ContactPhoneQuery } from './contacts'

describe('ContactUpsertBody', () => {
  it('exige phone', () => {
    expect(ContactUpsertBody.safeParse({ name: 'x' }).success).toBe(false)
  })
  it('aceita phone + tags + custom_fields', () => {
    const r = ContactUpsertBody.safeParse({
      phone: '5592999999999', name: 'João',
      tags: ['cliente'], custom_fields: [{ name: 'modelo', value: 'Onix' }],
    })
    expect(r.success).toBe(true)
  })
  it('rejeita email inválido', () => {
    expect(ContactUpsertBody.safeParse({ phone: '559299', email: 'x' }).success).toBe(false)
  })
})

describe('ContactPhoneQuery', () => {
  it('exige phone', () => {
    expect(ContactPhoneQuery.safeParse({}).success).toBe(false)
  })
})
```

- [ ] **Step 2: Rodar — falha**

Run: `npx vitest run src/lib/api/schemas/contacts.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar schemas `src/lib/api/schemas/contacts.ts`**
```ts
import { z } from 'zod'

const CustomFieldPair = z.object({
  name: z.string().min(1),
  value: z.string(),
})

export const ContactUpsertBody = z
  .object({
    phone: z.string().min(5),
    name: z.string().max(200).optional(),
    email: z.string().email().optional(),
    company: z.string().max(200).optional(),
    tags: z.array(z.string().min(1)).optional(),
    custom_fields: z.array(CustomFieldPair).optional(),
  })
  .meta({ id: 'ContactUpsertBody' })

export const ContactPatchBody = z
  .object({
    name: z.string().max(200).optional(),
    email: z.string().email().optional(),
    company: z.string().max(200).optional(),
    tags: z.array(z.string().min(1)).optional(),
    custom_fields: z.array(CustomFieldPair).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Envie ao menos um campo' })
  .meta({ id: 'ContactPatchBody' })

export const ContactPhoneQuery = z.object({ phone: z.string().min(5) }).meta({ id: 'ContactPhoneQuery' })

export type ContactUpsertBody = z.infer<typeof ContactUpsertBody>
export type ContactPatchBody = z.infer<typeof ContactPatchBody>
```

- [ ] **Step 4: Rodar — passa**

Run: `npx vitest run src/lib/api/schemas/contacts.test.ts`
Expected: PASS.

- [ ] **Step 5: Classes de erro em `src/lib/api/errors.ts`**

Adicionar (mantendo `errorEnvelope`/`validationError` existentes):
```ts
/** Erro de API com status/código/detalhes — tratado pelo funil toErrorResponse. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: { field: string; message: string }[],
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export class UnknownTagError extends ApiError {
  constructor(name: string) {
    super(422, 'unknown_tag', `A tag '${name}' não existe nesta conta. Crie no CRM primeiro.`, [
      { field: 'tags', message: `tag '${name}' não existe` },
    ])
  }
}

export class UnknownFieldError extends ApiError {
  constructor(name: string) {
    super(422, 'unknown_field', `O campo '${name}' não existe nesta conta. Crie no CRM primeiro.`, [
      { field: 'custom_fields', message: `campo '${name}' não existe` },
    ])
  }
}

export class NotFoundError extends ApiError {
  constructor(message = 'Recurso não encontrado') {
    super(404, 'not_found', message)
  }
}
```

- [ ] **Step 6: Generalizar `toErrorResponse` em `src/lib/auth/account.ts`**

No `toErrorResponse` (linha ~85), ANTES do branch genérico 500 e DEPOIS dos branches existentes (AccountPending / Unauthorized / Forbidden), adicionar tratamento de `ApiError`. Importar `ApiError` de `@/lib/api/errors`. Inserir:
```ts
// Erros de API tipados (status/code/details) — ex.: validação de tag/campo, 404.
if (err instanceof ApiError) {
  return NextResponse.json(
    { error: err.message, code: err.code, ...(err.details && { details: err.details }) },
    { status: err.status },
  )
}
```
ATENÇÃO: garantir que NÃO há import circular (`account.ts` ↔ `errors.ts`). `errors.ts` hoje importa só `next/server` e `zod` — importar `ApiError` de `errors.ts` dentro de `account.ts` é seguro (sentido único). Se o lint/TS acusar ciclo, mover as classes `ApiError*` pra um arquivo novo `src/lib/api/api-error.ts` sem deps de `account.ts` e importar de lá nos dois lados.

- [ ] **Step 7: Teste do toErrorResponse com ApiError**
```ts
// onde os testes de toErrorResponse vivem (ou novo src/lib/api/errors.test.ts)
import { toErrorResponse } from '@/lib/auth/account'
import { UnknownTagError } from '@/lib/api/errors'

it('toErrorResponse mapeia ApiError (422 unknown_tag)', async () => {
  const res = toErrorResponse(new UnknownTagError('quente'))
  expect(res.status).toBe(422)
  const body = await res.json()
  expect(body.code).toBe('unknown_tag')
  expect(body.details[0].field).toBe('tags')
})
```

- [ ] **Step 8: Rodar todos + commit**

Run: `npm run typecheck && npx vitest run src/lib/api src/lib/auth`
Expected: PASS.
```bash
git add src/lib/api/schemas/contacts.ts src/lib/api/schemas/contacts.test.ts src/lib/api/errors.ts src/lib/auth/account.ts src/lib/api/errors.test.ts
git commit -m "feat(api): schemas de contato + erros ApiError + toErrorResponse generalizado"
```

---

### Task 4: Camada de serviço de contatos (lógica account-scoped)

**Files:**
- Create: `src/lib/contacts/api-service.ts`
- Create test: `src/lib/contacts/api-service.test.ts`

**Interfaces:**
- Consumes: `findExistingContact`, `isUniqueViolation` (`@/lib/contacts/dedupe`), `normalizePhone` (`@/lib/whatsapp/phone-utils`), `UnknownTagError`/`UnknownFieldError`/`NotFoundError` (`@/lib/api/errors`).
- Produces (todas recebem `{ admin: SupabaseClient; accountId: string; auditUserId: string }` no 1º arg `ctx`):
  - `upsertContactByPhone(ctx, body: ContactUpsertBody): Promise<ContactResource>`
  - `updateContact(ctx, id: string, patch: ContactPatchBody): Promise<ContactResource>`
  - `getContactById(ctx, id: string): Promise<ContactResource>` (lança `NotFoundError`)
  - `findContactByPhone(ctx, phone: string): Promise<ContactResource | null>`
  - `listTags(ctx): Promise<{ id; name; color }[]>`
  - `listCustomFields(ctx): Promise<{ id; field_name; field_type; field_options }[]>`
  - tipo `ContactResource = { id; phone; name; email; company; tags: string[]; custom_fields: {name;value}[]; created_at; updated_at }`
- Internas (exportadas pra teste): `resolveTagIdByName(ctx, name): Promise<string>` (lança UnknownTagError), `resolveFieldIdByName(ctx, name): Promise<string>` (lança UnknownFieldError).

**Padrões de query a seguir (verbatim do código existente):**
- Aplicar tag: `admin.from('contact_tags').upsert({ contact_id, tag_id }, { onConflict: 'contact_id,tag_id', ignoreDuplicates: true })`.
- Setar campo: `admin.from('contact_custom_values').upsert({ contact_id, custom_field_id, value }, { onConflict: 'contact_id,custom_field_id' })`.
- Resolver tag por nome: `admin.from('tags').select('id').eq('account_id', accountId).eq('name', name).maybeSingle()` → null lança `UnknownTagError(name)`.
- Resolver campo por nome: `admin.from('custom_fields').select('id').eq('account_id', accountId).eq('field_name', name).maybeSingle()` → null lança `UnknownFieldError(name)`.
- Upsert contato: `findExistingContact(admin, accountId, phone)`; se achou → `update`; senão → `insert({ account_id, user_id: auditUserId, phone, name, email, company })`; em `isUniqueViolation` re-busca e faz update (corrida).

- [ ] **Step 1: Teste das resoluções e do upsert (admin client fake injetado)**

Seguir o padrão injetável de `src/lib/auth/platform-admin.test.ts`. Criar um fake mínimo do supabase admin (objeto com `.from(table)` retornando um query-builder encadeável que devolve `data`/`error` configuráveis). Testes:
```ts
// src/lib/contacts/api-service.test.ts — esboço dos casos (montar o fake builder):
// 1) resolveTagIdByName: tag existe -> retorna id; não existe -> lança UnknownTagError
// 2) resolveFieldIdByName: idem com UnknownFieldError
// 3) upsertContactByPhone: telefone novo -> chama insert; telefone existente (findExistingContact retorna linha) -> chama update; aplica tags resolvidas
// 4) getContactById: linha ausente -> lança NotFoundError
```
(O implementador escreve o fake builder mínimo necessário; cada `it` configura o retorno de `.from(table)` por tabela. O objetivo é cobrir os ramos de resolução/erro e o create-vs-update — não a infra do Supabase.)

- [ ] **Step 2: Rodar — falha**

Run: `npx vitest run src/lib/contacts/api-service.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar `src/lib/contacts/api-service.ts`**

Implementar as funções acima seguindo os padrões de query listados. Pontos-chave:
- `ContactResource` montado lendo o contato + `contact_tags→tags(name)` + `contact_custom_values→custom_fields(field_name),value`. Para `tags: string[]` retornar os nomes; para `custom_fields` retornar `{name: field_name, value}`.
- `upsertContactByPhone`: aplicar tags/campos SÓ depois do contato existir (precisa do id). Resolver TODOS os nomes ANTES de inserir valores (falha cedo com 422 se algum nome não existe, sem aplicar nada parcial).
- Toda query filtra por `account_id` (exceto `contact_tags`/`contact_custom_values` que dependem do `contact_id` já validado como da conta).
- Comentários em português.

- [ ] **Step 4: Rodar — passa**

Run: `npx vitest run src/lib/contacts/api-service.test.ts`
Expected: PASS.

- [ ] **Step 5: typecheck + commit**

Run: `npm run typecheck`
```bash
git add src/lib/contacts/api-service.ts src/lib/contacts/api-service.test.ts
git commit -m "feat(contacts): camada de serviço da API (upsert/get/tags/campos), account-scoped"
```

---

### Task 5: Route handlers `/api/v1` + rate limit + registro no OpenAPI

**Files:**
- Create: `src/app/api/v1/contacts/route.ts` (POST upsert, GET ?phone=)
- Create: `src/app/api/v1/contacts/[id]/route.ts` (GET, PATCH)
- Create: `src/app/api/v1/tags/route.ts` (GET)
- Create: `src/app/api/v1/custom-fields/route.ts` (GET)
- Create test: `src/app/api/v1/contacts/route.test.ts`
- Modify: `src/lib/rate-limit.ts` (presets `contactsWrite`, `contactsRead`)
- Modify: `src/lib/api/openapi/spec.ts` (registrar os novos endpoints + os schemas)
- Modify: `src/lib/auth/api-key-context.ts` se precisar expor `created_by_user_id`/owner pra auditoria (ver abaixo)

**Interfaces:**
- Consumes: `defineRoute`, `ResolvedCtx` (`@/lib/api/handler`), `ApiKeyContext` (`@/lib/auth/api-key-context`), `SCOPE_CONTACTS_READ/WRITE` (`@/lib/auth/api-keys`), serviço da Task 4, schemas da Task 3, `RATE_LIMITS`.

**Auditoria (pré-requisito):** o handler precisa de um `auditUserId` pra o `contacts.user_id`. `resolveApiKey` hoje retorna `{ supabase, apiKeyId, accountId, scopes }`. Estender `ApiKeyContext` + `resolveApiKey` (`src/lib/auth/api-key-context.ts`) pra também trazer `createdByUserId: string | null` e `ownerUserId: string` (via o select: `account:accounts!inner(id, status, owner_user_id)` e `created_by_user_id` da própria linha da chave). O handler usa `auditUserId = createdByUserId ?? ownerUserId`. Adicionar isto como primeiro passo da task (com 1 teste em `api-key-context.test.ts` confirmando que os campos vêm no contexto).

- [ ] **Step 1: Estender `resolveApiKey` com auditoria**

Em `src/lib/auth/api-key-context.ts`: no `select`, trocar `account:accounts!inner(id, status)` por `account:accounts!inner(id, status, owner_user_id)` e incluir `created_by_user_id`. Adicionar ao `ApiKeyContext`: `createdByUserId: string | null; ownerUserId: string`. Retornar ambos. (A validação de status/scope NÃO muda.)

- [ ] **Step 2: Presets de rate limit**

Em `src/lib/rate-limit.ts`, adicionar a `RATE_LIMITS`:
```ts
/** Escrita de contatos via API (upsert/patch). Por conta. */
contactsWrite: { limit: 120, windowMs: 60_000 },
/** Leitura de contatos/tags/campos via API. Mais folgado. */
contactsRead: { limit: 240, windowMs: 60_000 },
```

- [ ] **Step 3: Teste dos handlers (serviço + resolveApiKey mockados)**

`src/app/api/v1/contacts/route.test.ts` — seguindo o padrão de `src/app/api/v1/messages/send/route.test.ts`: sem Bearer → 401; chave sem `contacts:write` → 403; JSON malformado → 400; body sem phone → 422; tag inexistente (serviço lança `UnknownTagError`) → 422 `unknown_tag`; happy path → 200/201 com o `ContactResource`.

- [ ] **Step 4: Rodar — falha**

Run: `npx vitest run src/app/api/v1/contacts/route.test.ts`
Expected: FAIL.

- [ ] **Step 5: Implementar os 4 route handlers**

Padrão (exemplo `POST /api/v1/contacts`):
```ts
import { defineRoute, type ResolvedCtx } from '@/lib/api/handler'
import type { ApiKeyContext } from '@/lib/auth/api-key-context'
import { SCOPE_CONTACTS_WRITE, SCOPE_CONTACTS_READ } from '@/lib/auth/api-keys'
import { ContactUpsertBody, ContactPhoneQuery } from '@/lib/api/schemas/contacts'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { upsertContactByPhone, findContactByPhone } from '@/lib/contacts/api-service'
import { NextResponse } from 'next/server'

function apiKeyOf(ctx: ResolvedCtx): ApiKeyContext {
  return (ctx as Extract<ResolvedCtx, { auth: 'apiKey' }>).apiKey
}
function svcCtx(k: ApiKeyContext) {
  return { admin: k.supabase, accountId: k.accountId, auditUserId: k.createdByUserId ?? k.ownerUserId }
}

export const POST = defineRoute({
  auth: { type: 'apiKey', scopes: [SCOPE_CONTACTS_WRITE] },
  body: ContactUpsertBody,
  rateLimit: { preset: RATE_LIMITS.contactsWrite, key: (ctx) => `contactsWrite:${apiKeyOf(ctx).accountId}` },
  openapi: { summary: 'Criar/atualizar contato por telefone', tags: ['Contacts'], operationId: 'upsertContact' },
  handler: async ({ body, ctx }) => {
    const contact = await upsertContactByPhone(svcCtx(apiKeyOf(ctx)), body)
    return NextResponse.json({ contact }, { status: 201 })
  },
})

export const GET = defineRoute({
  auth: { type: 'apiKey', scopes: [SCOPE_CONTACTS_READ] },
  query: ContactPhoneQuery,
  rateLimit: { preset: RATE_LIMITS.contactsRead, key: (ctx) => `contactsRead:${apiKeyOf(ctx).accountId}` },
  openapi: { summary: 'Buscar contato por telefone', tags: ['Contacts'], operationId: 'findContactByPhone' },
  handler: async ({ query, ctx }) => {
    const contact = await findContactByPhone(svcCtx(apiKeyOf(ctx)), query.phone)
    return NextResponse.json({ contact })
  },
})
```
Os demais (`[id]/route.ts` GET+PATCH, `tags/route.ts` GET, `custom-fields/route.ts` GET) seguem o mesmo molde, chamando `getContactById`/`updateContact`/`listTags`/`listCustomFields`. Para rotas com `[id]`, ler o `id` de `req` (Next 16: o handler recebe `req`; extrair o último segmento do `req.url` OU usar o 2º arg de params — confirmar a convenção no `node_modules/next/dist/docs/`; o `defineRoute` repassa `req`, então parsear `new URL(req.url).pathname` é o caminho seguro sem depender de params). Erros do serviço (`UnknownTagError`/`NotFoundError`) sobem e o funil do `defineRoute` (`toErrorResponse`, já generalizado na Task 3) mapeia pra 422/404.

- [ ] **Step 6: Rodar — passa**

Run: `npx vitest run src/app/api/v1/contacts/route.test.ts`
Expected: PASS.

- [ ] **Step 7: Registrar no OpenAPI (`src/lib/api/openapi/spec.ts`)**

Importar os schemas novos (efeito colateral: `import '@/lib/api/schemas/contacts'`) e `registerOperation` pra cada endpoint:
```ts
registerOperation({ method: 'post', path: '/api/v1/contacts', summary: 'Criar/atualizar contato', tags: ['Contacts'], operationId: 'upsertContact', security: 'apiKey', requestBodySchemaId: 'ContactUpsertBody', successDescription: 'Contato criado/atualizado.' })
registerOperation({ method: 'get', path: '/api/v1/contacts', summary: 'Buscar contato por telefone', tags: ['Contacts'], operationId: 'findContactByPhone', security: 'apiKey' })
registerOperation({ method: 'get', path: '/api/v1/contacts/{id}', summary: 'Obter contato', tags: ['Contacts'], operationId: 'getContact', security: 'apiKey' })
registerOperation({ method: 'patch', path: '/api/v1/contacts/{id}', summary: 'Atualizar contato', tags: ['Contacts'], operationId: 'patchContact', security: 'apiKey', requestBodySchemaId: 'ContactPatchBody' })
registerOperation({ method: 'get', path: '/api/v1/tags', summary: 'Listar tags', tags: ['Contacts'], operationId: 'listTags', security: 'apiKey' })
registerOperation({ method: 'get', path: '/api/v1/custom-fields', summary: 'Listar campos customizados', tags: ['Contacts'], operationId: 'listCustomFields', security: 'apiKey' })
```

- [ ] **Step 8: Verificar OpenAPI + build + commit**

Run: `npm run typecheck && npx vitest run src/app/api/v1 src/lib/api/openapi && npm run build`
Expected: tudo verde, build exit 0. (Manual na review: `/docs` mostra a tag "Contacts" com os 6 endpoints.)
```bash
git add src/app/api/v1/contacts src/app/api/v1/tags src/app/api/v1/custom-fields src/lib/rate-limit.ts src/lib/api/openapi/spec.ts src/lib/auth/api-key-context.ts
git commit -m "feat(api): endpoints /api/v1 de contatos (upsert/get/tags/campos) + OpenAPI"
```

---

## Self-Review (feito)

- **Cobertura do spec:** scopes+UI (T1,T2), tags/campos só-existentes→422 (T3 erros, T4 serviço), upsert por telefone (T4), get+busca por telefone (T4,T5), listar tags/campos (T4,T5), OpenAPI/docs (T5), auditoria user_id (T5 step1), tenant guard (T4). ✓
- **Sem migração** confirmado (tags/custom_fields já account-scoped; api_keys.scopes já TEXT[]). ✓
- **Consistência de tipos:** `ContactResource`, `svcCtx({admin,accountId,auditUserId})`, `resolveTagIdByName`/`resolveFieldIdByName`, `ApiError` subclasses — nomes idênticos entre T3/T4/T5. ✓
- **Risco Next 16:** rotas `[id]` — parsear `new URL(req.url).pathname` em vez de depender de params (o `defineRoute` repassa só `req`); confirmar nos docs locais. Anotado em T5 step5.
- **Risco import circular** `account.ts`↔`errors.ts`: mitigação anotada em T3 step6 (mover ApiError pra `api-error.ts` se necessário).

## Fora de escopo (próximas rodadas)
Listagem paginada de contatos; remover tag granular; deletar contato; clusters de conversas/deals/broadcasts; webhooks de saída.

# API Broadcasts Cluster (disparo em massa) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expor endpoints públicos `/api/v1` pra o agente n8n / terceiros dispararem campanhas por template aprovado (inline, com cap) e listarem os templates aprovados da conta.

**Architecture:** Espelha os clusters já no ar (contatos/deals/conversas). Schema Zod → camada de serviço account-scoped (`src/lib/broadcasts/api-service.ts`, service-role admin client com guard de `account_id`) que reusa o mecanismo de envio da rota interna (`sendTemplateMessage` + helpers de telefone) → route handlers via `defineRoute`. **Sem migração.**

**Tech Stack:** Next.js 16 App Router, TypeScript, Zod v4, Supabase (service role), vitest 4.

## Global Constraints

- Comentários de código em **português**.
- Sem migração: `message_templates`/`whatsapp_config` já têm `account_id` (017/013).
- Contrato de erro flat e aditivo: `{ error, code?, details? }`. Nunca mudar o shape `{error}`.
- **Cap 200 destinatários/chamada** (Zod `.max(200)`); `export const maxDuration = 300` na rota de broadcast.
- **Template precisa estar `status='APPROVED'`** → senão `TemplateNotApprovedError` (422). WhatsApp não configurado → `WhatsappNotConfiguredError` (409).
- **Falha de um destinatário NÃO derruba o lote** — vira entrada `failed` no `results`. Nunca vazar o access token em mensagem de erro.
- **Tenant:** config/template lidos por `account_id` da chave (`apiKeyServiceCtx`); identidade sempre da chave, nunca do body.
- Auth: scope `broadcasts:send`. Rate limit apertado por conta (`broadcastSend` 10/min).
- `npm run typecheck` limpo, `npm test` verde, `npm run build` exit 0 ao fim de cada task. Sem push/PR/merge.

---

### Task 1: Scope + erros + schemas + serviço de broadcasts (account-scoped)

**Files:**
- Modify: `src/lib/auth/api-keys.ts` (+`SCOPE_BROADCASTS_SEND`)
- Modify: `src/lib/api/errors.ts` (+`TemplateNotApprovedError` 422, `WhatsappNotConfiguredError` 409)
- Create: `src/lib/api/schemas/broadcasts.ts` (`BroadcastSendBody`)
- Create: `src/lib/broadcasts/api-service.ts`
- Test: `src/lib/auth/api-keys.test.ts` (scope), `src/lib/api/errors.test.ts` (novos), `src/lib/api/schemas/broadcasts.test.ts`, `src/lib/broadcasts/api-service.test.ts`

**Interfaces:**
- Consumes: `ApiServiceCtx` (`@/lib/api/service-context`), `ApiError` (`@/lib/api/errors`); de `@/lib/whatsapp/meta-api`: `sendTemplateMessage(args)`; de `@/lib/whatsapp/phone-utils`: `sanitizePhoneForMeta`, `isValidE164`, `phoneVariants`, `isRecipientNotAllowedError`; de `@/lib/whatsapp/encryption`: `decrypt`; de `@/lib/whatsapp/template-row-guard`: `isMessageTemplate`.
- Produces: `SCOPE_BROADCASTS_SEND='broadcasts:send'`; `TemplateNotApprovedError(name)` (422), `WhatsappNotConfiguredError()` (409); Zod `BroadcastSendBody`; serviço (recebe `ctx: ApiServiceCtx`): `listApprovedTemplates(ctx): Promise<TemplateResource[]>`, `sendBroadcast(ctx, body: BroadcastSendBody): Promise<BroadcastSendResult>`.
- Tipos: `TemplateResource = { name; language; category: string|null; status; body_text: string|null; variables_count: number }`; `BroadcastSendResult = { sent: number; failed: number; results: Array<{ phone: string; status: 'sent'|'failed'; whatsapp_message_id?: string; error?: string }> }`.

- [ ] **Step 1: Scope em `api-keys.ts`**

```ts
export const SCOPE_BROADCASTS_SEND = 'broadcasts:send'
// ALL_SCOPES passa a incluir SCOPE_BROADCASTS_SEND
// API_KEY_SCOPE_META ganha:
//   [SCOPE_BROADCASTS_SEND]: { label: 'Disparar campanhas', description: 'Enviar broadcasts por template e listar templates aprovados.' },
```
Em `api-keys.test.ts`: `sanitizeScopes(['broadcasts:send','x'])` → `['broadcasts:send']`.

- [ ] **Step 2: Rodar — passa**

Run: `npx vitest run src/lib/auth/api-keys.test.ts` — PASS.

- [ ] **Step 3: Erros em `errors.ts`**
```ts
export class TemplateNotApprovedError extends ApiError {
  constructor(name: string) {
    super(422, 'template_not_approved', `O template '${name}' não existe ou não está aprovado nesta conta.`, [
      { field: 'template_name', message: `template '${name}' não aprovado` },
    ])
  }
}
export class WhatsappNotConfiguredError extends ApiError {
  constructor() {
    super(409, 'whatsapp_not_configured', 'WhatsApp não está configurado nesta conta. Configure a integração antes de disparar.')
  }
}
```
Teste em `errors.test.ts`: `new TemplateNotApprovedError('promo')` → 422, code `template_not_approved`, details[0].field `template_name`; `new WhatsappNotConfiguredError()` → 409, code `whatsapp_not_configured`.

- [ ] **Step 4: Schema `src/lib/api/schemas/broadcasts.ts`**
```ts
import { z } from 'zod'

const Recipient = z.object({
  phone: z.string().min(5),
  params: z.array(z.string()).optional(),
})

export const BroadcastSendBody = z
  .object({
    template_name: z.string().min(1),
    template_language: z.string().min(2).default('en_US'),
    recipients: z.array(Recipient).min(1).max(200),
  })
  .meta({ id: 'BroadcastSendBody' })

export type BroadcastSendBody = z.infer<typeof BroadcastSendBody>
```
Teste `broadcasts.test.ts`: exige `template_name` e `recipients` não-vazio; rejeita 201 destinatários; `template_language` default `'en_US'`; aceita `recipients:[{phone:'5592999999999', params:['João']}]`.

- [ ] **Step 5: Testes do serviço (fake admin + mock de `sendTemplateMessage`, padrão de `src/lib/contacts/api-service.test.ts`)**

Mockar `@/lib/whatsapp/meta-api` (`sendTemplateMessage`) e `@/lib/whatsapp/encryption` (`decrypt`). Casos:
- `listApprovedTemplates`: filtra `status='APPROVED'`; mapeia `variables_count` contando `{{n}}` no `body_text` (ex.: body `'Oi {{1}}, seu pedido {{2}}'` → 2).
- `sendBroadcast`: config ausente → `WhatsappNotConfiguredError`; template ausente ou `status!='APPROVED'` → `TemplateNotApprovedError`; happy path com 2 destinatários válidos → `sendTemplateMessage` chamado 2x, retorna `{sent:2, failed:0, results:[...]}`; um telefone inválido (falha no `isValidE164`) → vira `failed` no results e os válidos seguem; erro do `sendTemplateMessage` num destinatário → `{status:'failed', error}` sem derrubar os outros.

- [ ] **Step 6: Rodar — falha**

Run: `npx vitest run src/lib/api/schemas/broadcasts.test.ts src/lib/broadcasts` — FAIL.

- [ ] **Step 7: Implementar `src/lib/broadcasts/api-service.ts`**

Padrões (account-scoped; comentários em português; reusa o núcleo da rota interna `src/app/api/whatsapp/broadcast/route.ts`):
```ts
import type { ApiServiceCtx } from '@/lib/api/service-context'
import { TemplateNotApprovedError, WhatsappNotConfiguredError, ApiError } from '@/lib/api/errors'
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sanitizePhoneForMeta, isValidE164, phoneVariants, isRecipientNotAllowedError } from '@/lib/whatsapp/phone-utils'
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard'
import type { BroadcastSendBody } from '@/lib/api/schemas/broadcasts'

const VAR_RE = /\{\{\s*\d+\s*\}\}/g

export interface TemplateResource { name: string; language: string; category: string | null; status: string; body_text: string | null; variables_count: number }
export interface BroadcastRecipientResult { phone: string; status: 'sent' | 'failed'; whatsapp_message_id?: string; error?: string }
export interface BroadcastSendResult { sent: number; failed: number; results: BroadcastRecipientResult[] }

export async function listApprovedTemplates(ctx: ApiServiceCtx): Promise<TemplateResource[]> {
  const { data, error } = await ctx.admin
    .from('message_templates')
    .select('name,language,category,status,body_text')
    .eq('account_id', ctx.accountId)
    .eq('status', 'APPROVED')
    .order('name')
  if (error) throw error
  return (data ?? []).map((t: any) => ({
    name: t.name, language: t.language, category: t.category ?? null,
    status: t.status, body_text: t.body_text ?? null,
    variables_count: (String(t.body_text ?? '').match(VAR_RE) ?? []).length,
  }))
}

export async function sendBroadcast(ctx: ApiServiceCtx, body: BroadcastSendBody): Promise<BroadcastSendResult> {
  // 1) Config da conta (token criptografado).
  const { data: config } = await ctx.admin
    .from('whatsapp_config').select('*').eq('account_id', ctx.accountId).maybeSingle()
  if (!config) throw new WhatsappNotConfiguredError()
  const accessToken = decrypt(config.access_token as string)

  // 2) Template — precisa existir e estar APPROVED.
  const { data: rawTemplate } = await ctx.admin
    .from('message_templates').select('*')
    .eq('account_id', ctx.accountId).eq('name', body.template_name)
    .eq('language', body.template_language).maybeSingle()
  if (!rawTemplate || rawTemplate.status !== 'APPROVED') {
    throw new TemplateNotApprovedError(body.template_name)
  }
  if (!isMessageTemplate(rawTemplate)) {
    console.error('[sendBroadcast] template local malformado:', body.template_name)
    throw new ApiError(500, 'internal_error', 'Erro interno ao carregar o template.')
  }

  // 3) Fan-out inline (igual a rota interna): retry de variante de telefone.
  const results: BroadcastRecipientResult[] = []
  let sent = 0, failed = 0
  for (const r of body.recipients) {
    const sanitized = sanitizePhoneForMeta(r.phone)
    if (!isValidE164(sanitized)) {
      results.push({ phone: r.phone, status: 'failed', error: 'Telefone em formato inválido' }); failed++; continue
    }
    let messageId: string | null = null, lastError: string | null = null
    for (const variant of phoneVariants(sanitized)) {
      try {
        const res = await sendTemplateMessage({
          phoneNumberId: config.phone_number_id as string, accessToken, to: variant,
          templateName: body.template_name, language: body.template_language,
          template: rawTemplate, params: r.params ?? [],
        })
        messageId = res.messageId; lastError = null; break
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Erro desconhecido'
        lastError = msg
        if (!isRecipientNotAllowedError(msg)) break // só re-tenta variante em "not allowed"
      }
    }
    if (messageId) { results.push({ phone: r.phone, status: 'sent', whatsapp_message_id: messageId }); sent++ }
    else { results.push({ phone: r.phone, status: 'failed', error: lastError ?? 'Falha no envio' }); failed++ }
  }
  return { sent, failed, results }
}
```

- [ ] **Step 8: Rodar — passa**

Run: `npm run typecheck && npx vitest run src/lib/api/schemas/broadcasts.test.ts src/lib/broadcasts`
Expected: PASS.

- [ ] **Step 9: Commit**
```bash
git add src/lib/auth/api-keys.ts src/lib/auth/api-keys.test.ts src/lib/api/errors.ts src/lib/api/errors.test.ts src/lib/api/schemas/broadcasts.ts src/lib/api/schemas/broadcasts.test.ts src/lib/broadcasts/api-service.ts src/lib/broadcasts/api-service.test.ts
git commit -m "feat(broadcasts): scope + erros + schema + serviço (templates aprovados + envio inline)"
```

---

### Task 2: Route handlers `/api/v1` + rate limit + OpenAPI

**Files:**
- Create: `src/app/api/v1/broadcasts/route.ts` (POST, `maxDuration=300`)
- Create: `src/app/api/v1/templates/route.ts` (GET)
- Create test: `src/app/api/v1/broadcasts/route.test.ts`
- Modify: `src/lib/rate-limit.ts` (preset `broadcastSend`)
- Modify: `src/lib/api/openapi/spec.ts` (registrar 2 ops + import do schema)

**Interfaces:**
- Consumes: `defineRoute` (`@/lib/api/handler`), `apiKeyServiceCtx` (`@/lib/api/service-context`), `SCOPE_BROADCASTS_SEND` (`@/lib/auth/api-keys`), serviço da Task 1, schema da Task 1, `RATE_LIMITS`.

- [ ] **Step 1: Preset de rate limit (`src/lib/rate-limit.ts`)**
```ts
/** Disparo de broadcast via API. APERTADO (custa $) — por conta. */
broadcastSend: { limit: 10, windowMs: 60_000 },
```

- [ ] **Step 2: Testes dos handlers (serviço + resolveApiKey mockados, padrão de `src/app/api/v1/deals/route.test.ts`)**

`POST /api/v1/broadcasts`: sem Bearer→401; chave sem `broadcasts:send`→403; JSON malformado→400; `recipients` vazio→422; serviço lança `TemplateNotApprovedError`→422 `template_not_approved`; serviço lança `WhatsappNotConfiguredError`→409; happy path→200 `{sent, failed, results}`. `GET /api/v1/templates`: happy path→200 `{templates}`.

- [ ] **Step 3: Rodar — falha**

Run: `npx vitest run src/app/api/v1/broadcasts/route.test.ts` — FAIL.

- [ ] **Step 4: Implementar os 2 route handlers**

`src/app/api/v1/broadcasts/route.ts`:
```ts
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/handler'
import { apiKeyServiceCtx } from '@/lib/api/service-context'
import { SCOPE_BROADCASTS_SEND } from '@/lib/auth/api-keys'
import { BroadcastSendBody } from '@/lib/api/schemas/broadcasts'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { sendBroadcast } from '@/lib/broadcasts/api-service'

// Fan-out sequencial pode levar tempo com até 200 destinatários.
export const maxDuration = 300

export const POST = defineRoute({
  auth: { type: 'apiKey', scopes: [SCOPE_BROADCASTS_SEND] },
  body: BroadcastSendBody,
  rateLimit: { preset: RATE_LIMITS.broadcastSend, key: (ctx) => `broadcastSend:${apiKeyServiceCtx(ctx).accountId}` },
  openapi: { summary: 'Disparar broadcast por template', tags: ['Broadcasts'], operationId: 'sendBroadcast' },
  handler: async ({ body, ctx }) => {
    const result = await sendBroadcast(apiKeyServiceCtx(ctx), body)
    return NextResponse.json(result)
  },
})
```
`src/app/api/v1/templates/route.ts` (GET, sem body/query): scope `broadcasts:send`, rate limit `broadcastSend` (ou um read mais folgado — usar `broadcastSend` é aceitável), chama `listApprovedTemplates(apiKeyServiceCtx(ctx))` → `{ templates }`. Erros do serviço (`TemplateNotApprovedError`/`WhatsappNotConfiguredError`) sobem e o funil do `defineRoute` mapeia (422/409).

- [ ] **Step 5: Rodar — passa**

Run: `npx vitest run src/app/api/v1/broadcasts/route.test.ts` — PASS.

- [ ] **Step 6: Registrar no OpenAPI (`src/lib/api/openapi/spec.ts`)**

`import '@/lib/api/schemas/broadcasts'` (efeito colateral) + `registerOperation`:
```ts
registerOperation({ method: 'get',  path: '/api/v1/templates',  summary: 'Listar templates aprovados', tags:['Broadcasts'], operationId:'listTemplates', security:'apiKey' })
registerOperation({ method: 'post', path: '/api/v1/broadcasts', summary: 'Disparar broadcast por template (até 200 destinatários)', tags:['Broadcasts'], operationId:'sendBroadcast', security:'apiKey', requestBodySchemaId:'BroadcastSendBody', successDescription:'Resultado por destinatário (sent/failed).' })
```

- [ ] **Step 7: Verificação + commit**

Run: `npm run typecheck && npx vitest run src/app/api/v1 src/lib/api/openapi && npm run build`
Expected: verde, build exit 0. (Manual na review: `/docs` mostra a tag "Broadcasts".)
```bash
git add src/app/api/v1/broadcasts src/app/api/v1/templates src/lib/rate-limit.ts src/lib/api/openapi/spec.ts
git commit -m "feat(api): endpoints /api/v1 de broadcasts (disparar + listar templates) + OpenAPI"
```

---

## Self-Review (feito)

- **Cobertura do spec:** scope (T1), erros 422/409 (T1), schema cap 200 (T1), listApprovedTemplates + variables_count (T1), sendBroadcast inline com fail-isolada-por-destinatário + reuso de sendTemplateMessage/helpers (T1), 2 endpoints + rate limit apertado + maxDuration + OpenAPI (T2). ✓
- **Sem migração** confirmado. ✓
- **Consistência de tipos:** `TemplateResource`/`BroadcastSendResult`/`BroadcastRecipientResult`, `listApprovedTemplates`/`sendBroadcast`, `SCOPE_BROADCASTS_SEND`, `BroadcastSendBody`, `TemplateNotApprovedError`/`WhatsappNotConfiguredError` — idênticos entre T1/T2. ✓
- **Guarda-corpos:** cap 200 (Zod), maxDuration 300, rate limit 10/min, token nunca em mensagem de erro (erros do `sendTemplateMessage` são da Meta, não expõem token; mas o serviço não loga o token). ✓
- **Tenant:** config/template por `account_id` da chave; identidade via `apiKeyServiceCtx`. ✓

## Fora de escopo (próximas rodadas)
Persistir broadcast + tracking de entrega; audiência por tag; agendamento; disparo assíncrono; orquestração (flow trigger + webhooks de saída).

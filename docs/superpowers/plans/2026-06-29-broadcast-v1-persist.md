# Broadcast v1 persiste + selo APPROVED no interno — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer o broadcast v1 (API) registrar `broadcasts` + `broadcast_recipients` (com `whatsapp_message_id`) pra analytics/status-webhook funcionarem, e a rota de broadcast interna rejeitar template não-APPROVED.

**Architecture:** `sendBroadcast` (service-role `ctx.admin`) cria a linha `broadcasts` (falha alto se não der) e insere 1 `broadcast_recipients` por destinatário com o `whatsapp_message_id` (best-effort), espelhando server-side o que o client hook já faz pro broadcast interno. A rota interna ganha um guard de `status === 'APPROVED'`. Sem migration.

**Tech Stack:** Next.js (App Router) + Supabase (service-role + sessão) + Vitest. Sem libs novas.

**Spec:** `docs/superpowers/specs/2026-06-29-broadcast-v1-persist-design.md`
**Auditoria:** `docs/auditoria/2026-06-28-conflitos-webhooks-apis.md` (item #5, escopo Opção 1).

## Global Constraints

- Comentários de código em **português**.
- Nunca `git add -A` — caminhos explícitos.
- `npx tsc --noEmit` limpo; `npm run lint` sem novos problemas nos arquivos tocados (baseline 3 errors / ~25 problems pré-existentes; não mexer em warnings legados).
- **Nenhuma migration** — `broadcast_recipients.contact_id` já é nullable (004); `broadcasts.account_id` já existe (017). Tudo via `ctx.admin` (service-role), RLS não se aplica.
- Persistência do `broadcasts` falha alto (500 via `ApiError`); lookup de contatos, inserts de recipient e finalização de status são **best-effort** (a mensagem já saiu — não derrubar por erro de tracking).
- `contact_id` do recipient: best-effort linkado a contato existente por telefone; `null` se não casar. **Não** criar contatos.

---

### Task 1: v1 persiste broadcasts + recipients

**Files:**
- Modify: `src/lib/api/schemas/broadcasts.ts` (+`name` opcional)
- Modify: `src/lib/broadcasts/api-service.ts` (`sendBroadcast` persiste; +`broadcast_id` no retorno)
- Test: `src/lib/broadcasts/api-service.test.ts` (estende o fake admin + testes de persistência)

**Interfaces:**
- Consumes: `ApiServiceCtx` (`{ admin, accountId, auditUserId }`), `sendTemplateMessage`, `decrypt`, phone-utils, `isMessageTemplate`, `ApiError`/`TemplateNotApprovedError`/`WhatsappNotConfiguredError`.
- Produces: `sendBroadcast(ctx, body): Promise<BroadcastSendResult>` com `BroadcastSendResult` agora incluindo `broadcast_id: string`.

- [ ] **Step 1: Adicionar `name` opcional ao schema**

Em `src/lib/api/schemas/broadcasts.ts`, dentro do `z.object({...})` do `BroadcastSendBody`, adicionar a chave (antes de `recipients`):

```ts
    name: z.string().min(1).max(120).optional(),
```

Resultado do objeto:
```ts
export const BroadcastSendBody = z
  .object({
    template_name: z.string().min(1),
    template_language: z.string().min(2).default('en_US'),
    name: z.string().min(1).max(120).optional(),
    recipients: z.array(Recipient).min(1).max(200),
  })
  .meta({ id: 'BroadcastSendBody' })
```

- [ ] **Step 2: Reescrever o teste (RED) — fake admin com insert/in/update + persistência**

Substituir TODO o conteúdo de `src/lib/broadcasts/api-service.test.ts` por:

```ts
/**
 * Testes unitários de broadcasts/api-service.ts.
 *
 * Estratégia: fake do Supabase admin (service-role) injetado via ctx,
 * agora ciente de insert/in/update além de select/eq/order/maybeSingle.
 * sendTemplateMessage e decrypt mockados para isolar a lógica.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { TemplateNotApprovedError, WhatsappNotConfiguredError } from '@/lib/api/errors'
import { listApprovedTemplates, sendBroadcast } from './api-service'
import type { ApiServiceCtx } from '@/lib/api/service-context'

vi.mock('@/lib/whatsapp/meta-api', () => ({ sendTemplateMessage: vi.fn() }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: vi.fn((v: string) => `decrypted:${v}`) }))

import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'

interface Recorders {
  eqCalls?: Record<string, Array<[string, unknown]>>
  inserts?: Record<string, unknown[]>
  updates?: Record<string, unknown[]>
}

/**
 * Fake admin com respostas configuráveis por tabela. Chaves de resposta:
 *  - '<tabela>'           → select chains (.eq/.in/.order/.maybeSingle/.single)
 *  - '<tabela>:insert'    → .insert(...) (await direto OU .select().single())
 *  - '<tabela>:update'    → .update(...).eq(...) (await)
 */
function makeFakeAdmin(
  tableResponses: Record<string, { data: unknown; error: unknown }>,
  rec: Recorders = {},
): SupabaseClient {
  function makeBuilder(table: string) {
    const selectResp = tableResponses[table] ?? { data: null, error: null }
    let verb: 'select' | 'insert' | 'update' = 'select'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder: any = {}
    const thenableOf = (resp: { data: unknown; error: unknown }) => ({
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(resp).then(resolve),
      catch: (reject: (e: unknown) => unknown) => Promise.resolve(resp).catch(reject),
      maybeSingle: () => Promise.resolve(resp),
      single: () => Promise.resolve(resp),
    })
    builder.select = () => builder
    builder.eq = (column: string, value: unknown) => {
      if (rec.eqCalls) (rec.eqCalls[table] ??= []).push([column, value])
      if (verb === 'update') {
        return Promise.resolve(tableResponses[`${table}:update`] ?? { error: null })
      }
      return builder
    }
    builder.in = () => thenableOf(selectResp)
    builder.order = () => thenableOf(selectResp)
    builder.maybeSingle = () => Promise.resolve(selectResp)
    builder.single = () => Promise.resolve(selectResp)
    builder.insert = (payload: unknown) => {
      if (rec.inserts) (rec.inserts[table] ??= []).push(payload)
      verb = 'insert'
      const insResp = tableResponses[`${table}:insert`] ?? { data: null, error: null }
      return {
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(insResp).then(resolve),
        catch: (reject: (e: unknown) => unknown) => Promise.resolve(insResp).catch(reject),
        select: () => ({
          single: () => Promise.resolve(insResp),
          maybeSingle: () => Promise.resolve(insResp),
        }),
      }
    }
    builder.update = (payload: unknown) => {
      if (rec.updates) (rec.updates[table] ??= []).push(payload)
      verb = 'update'
      return builder
    }
    return builder
  }
  return { from: (table: string) => makeBuilder(table) } as unknown as SupabaseClient
}

function makeCtx(
  tableResponses: Record<string, { data: unknown; error: unknown }>,
  rec: Recorders = {},
): ApiServiceCtx {
  return { admin: makeFakeAdmin(tableResponses, rec), accountId: 'acct-test', auditUserId: 'user-audit' }
}

const FAKE_CONFIG = { account_id: 'acct-test', phone_number_id: 'phone-id-1', access_token: 'encrypted-token' }
const FAKE_TEMPLATE = {
  id: 'tpl-1', user_id: 'user-1', account_id: 'acct-test', name: 'promo', language: 'pt_BR',
  category: 'MARKETING', status: 'APPROVED', body_text: 'Oi {{1}}, seu pedido {{2}} chegou!',
  buttons: null, header_type: null, header_text: null, sample_values: null, meta_template_id: null,
  created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
}
// Resposta padrão da criação do broadcast (sucesso) — usada no happy path.
const OK_PERSIST = {
  whatsapp_config: { data: FAKE_CONFIG, error: null },
  message_templates: { data: FAKE_TEMPLATE, error: null },
  'broadcasts:insert': { data: { id: 'bc-1' }, error: null },
  contacts: { data: [], error: null },
}

beforeEach(() => vi.clearAllMocks())

describe('listApprovedTemplates', () => {
  it('retorna lista vazia quando não há templates aprovados', async () => {
    const ctx = makeCtx({ message_templates: { data: [], error: null } })
    expect(await listApprovedTemplates(ctx)).toEqual([])
  })

  it('mapeia os campos corretamente incluindo variables_count', async () => {
    const templates = [{ name: 'promo', language: 'pt_BR', category: 'MARKETING', status: 'APPROVED', body_text: 'Oi {{1}}, seu pedido {{2}} chegou!' }]
    const ctx = makeCtx({ message_templates: { data: templates, error: null } })
    const result = await listApprovedTemplates(ctx)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('promo')
    expect(result[0].variables_count).toBe(2)
  })

  it('variables_count = 0 quando body_text é null', async () => {
    const ctx = makeCtx({ message_templates: { data: [{ name: 'x', language: 'en_US', category: null, status: 'APPROVED', body_text: null }], error: null } })
    expect((await listApprovedTemplates(ctx))[0].variables_count).toBe(0)
  })

  it('propaga erro do Supabase', async () => {
    const ctx = makeCtx({ message_templates: { data: null, error: new Error('DB error') } })
    await expect(listApprovedTemplates(ctx)).rejects.toThrow('DB error')
  })
})

describe('sendBroadcast — configuração/template inválidos', () => {
  it('WhatsappNotConfiguredError (409) quando config ausente', async () => {
    const ctx = makeCtx({ whatsapp_config: { data: null, error: null } })
    await expect(sendBroadcast(ctx, { template_name: 'promo', template_language: 'pt_BR', recipients: [{ phone: '5592999999999' }] }))
      .rejects.toBeInstanceOf(WhatsappNotConfiguredError)
  })

  it('TemplateNotApprovedError (422) quando template PENDING', async () => {
    const ctx = makeCtx({ whatsapp_config: { data: FAKE_CONFIG, error: null }, message_templates: { data: { ...FAKE_TEMPLATE, status: 'PENDING' }, error: null } })
    await expect(sendBroadcast(ctx, { template_name: 'promo', template_language: 'pt_BR', recipients: [{ phone: '5592999999999' }] }))
      .rejects.toBeInstanceOf(TemplateNotApprovedError)
  })

  it('propaga erro do banco em whatsapp_config sem mascarar', async () => {
    const ctx = makeCtx({ whatsapp_config: { data: null, error: { message: 'DB down' } }, message_templates: { data: FAKE_TEMPLATE, error: null } })
    await expect(sendBroadcast(ctx, { template_name: 'promo', template_language: 'pt_BR', recipients: [{ phone: '5592999999999' }] }))
      .rejects.toMatchObject({ message: 'DB down' })
  })
})

describe('sendBroadcast — happy path + persistência', () => {
  it('envia para 2 destinatários e retorna sent=2, failed=0, broadcast_id', async () => {
    vi.mocked(sendTemplateMessage).mockResolvedValueOnce({ messageId: 'msg-1' }).mockResolvedValueOnce({ messageId: 'msg-2' })
    const ctx = makeCtx(OK_PERSIST)
    const result = await sendBroadcast(ctx, {
      template_name: 'promo', template_language: 'pt_BR',
      recipients: [{ phone: '5592999999991', params: ['João', 'ORD-001'] }, { phone: '5592999999992', params: ['Maria', 'ORD-002'] }],
    })
    expect(result.sent).toBe(2)
    expect(result.failed).toBe(0)
    expect(result.broadcast_id).toBe('bc-1')
    expect(result.results[0]).toMatchObject({ phone: '5592999999991', status: 'sent', whatsapp_message_id: 'msg-1' })
  })

  it('cria a linha broadcasts com account_id, user_id (auditUserId), status sending e total_recipients', async () => {
    vi.mocked(sendTemplateMessage).mockResolvedValue({ messageId: 'm' })
    const inserts: Record<string, unknown[]> = {}
    const ctx = makeCtx(OK_PERSIST, { inserts })
    await sendBroadcast(ctx, { template_name: 'promo', template_language: 'pt_BR', name: 'Campanha X', recipients: [{ phone: '5592999999991' }, { phone: '5592999999992' }] })
    expect(inserts['broadcasts'][0]).toMatchObject({
      account_id: 'acct-test', user_id: 'user-audit', name: 'Campanha X',
      template_name: 'promo', template_language: 'pt_BR', status: 'sending', total_recipients: 2,
    })
  })

  it('insere 1 broadcast_recipients por destinatário com whatsapp_message_id', async () => {
    vi.mocked(sendTemplateMessage).mockResolvedValueOnce({ messageId: 'msg-1' }).mockResolvedValueOnce({ messageId: 'msg-2' })
    const inserts: Record<string, unknown[]> = {}
    const ctx = makeCtx(OK_PERSIST, { inserts })
    await sendBroadcast(ctx, { template_name: 'promo', template_language: 'pt_BR', recipients: [{ phone: '5592999999991' }, { phone: '5592999999992' }] })
    const recps = inserts['broadcast_recipients']
    expect(recps).toHaveLength(2)
    expect(recps[0]).toMatchObject({ broadcast_id: 'bc-1', status: 'sent', whatsapp_message_id: 'msg-1' })
    expect(recps[1]).toMatchObject({ broadcast_id: 'bc-1', status: 'sent', whatsapp_message_id: 'msg-2' })
  })

  it('linka contact_id quando o telefone casa um contato existente; null quando não', async () => {
    vi.mocked(sendTemplateMessage).mockResolvedValueOnce({ messageId: 'msg-1' }).mockResolvedValueOnce({ messageId: 'msg-2' })
    const inserts: Record<string, unknown[]> = {}
    const ctx = makeCtx(
      { ...OK_PERSIST, contacts: { data: [{ id: 'c-1', phone: '5592999999991' }], error: null } },
      { inserts },
    )
    await sendBroadcast(ctx, { template_name: 'promo', template_language: 'pt_BR', recipients: [{ phone: '5592999999991' }, { phone: '5592999999992' }] })
    const recps = inserts['broadcast_recipients'] as Array<{ contact_id: string | null }>
    expect(recps[0].contact_id).toBe('c-1')
    expect(recps[1].contact_id).toBeNull()
  })

  it('finaliza broadcasts.status = sent quando ao menos 1 enviou', async () => {
    vi.mocked(sendTemplateMessage).mockResolvedValue({ messageId: 'm' })
    const updates: Record<string, unknown[]> = {}
    const ctx = makeCtx(OK_PERSIST, { updates })
    await sendBroadcast(ctx, { template_name: 'promo', template_language: 'pt_BR', recipients: [{ phone: '5592999999991' }] })
    expect(updates['broadcasts'][0]).toMatchObject({ status: 'sent' })
  })

  it('falha do envio vira recipient failed + error_message, sem derrubar o lote', async () => {
    vi.mocked(sendTemplateMessage).mockRejectedValueOnce(new Error('Meta 500')).mockResolvedValueOnce({ messageId: 'msg-ok' })
    const inserts: Record<string, unknown[]> = {}
    const ctx = makeCtx(OK_PERSIST, { inserts })
    const result = await sendBroadcast(ctx, { template_name: 'promo', template_language: 'pt_BR', recipients: [{ phone: '5592999999995' }, { phone: '5592999999996' }] })
    expect(result.sent).toBe(1)
    expect(result.failed).toBe(1)
    const recps = inserts['broadcast_recipients'] as Array<{ status: string; error_message: string | null }>
    expect(recps[0]).toMatchObject({ status: 'failed', error_message: 'Meta 500' })
    expect(recps[1]).toMatchObject({ status: 'sent' })
  })

  it('erro ao criar broadcasts → 500 (ApiError), sem enviar', async () => {
    const ctx = makeCtx({ ...OK_PERSIST, 'broadcasts:insert': { data: null, error: { message: 'insert fail' } } })
    await expect(sendBroadcast(ctx, { template_name: 'promo', template_language: 'pt_BR', recipients: [{ phone: '5592999999991' }] }))
      .rejects.toMatchObject({ status: 500 })
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Rodar o teste pra ver falhar (RED)**

Run: `npx vitest run src/lib/broadcasts/api-service.test.ts`
Expected: FALHA — `sendBroadcast` atual não cria `broadcasts` (sem `broadcast_id` no retorno, `inserts['broadcasts']` vazio) nem insere recipients; o teste de erro-ao-criar não dá 500.

- [ ] **Step 4: Implementar a persistência (GREEN)**

Em `src/lib/broadcasts/api-service.ts`:

(a) Estender o tipo de retorno:
```ts
export interface BroadcastSendResult {
  sent: number
  failed: number
  results: BroadcastRecipientResult[]
  broadcast_id: string
}
```

(b) Adicionar um helper best-effort de insert de recipient (no topo do arquivo, após os imports):
```ts
// Grava uma linha de broadcast_recipients (best-effort: a mensagem já saiu,
// um erro de tracking não deve derrubar o envio). contact_id é nullable.
async function persistRecipient(
  ctx: ApiServiceCtx,
  broadcastId: string,
  contactId: string | null,
  messageId: string | null,
  errorMessage: string | null,
): Promise<void> {
  try {
    await ctx.admin.from('broadcast_recipients').insert({
      broadcast_id: broadcastId,
      contact_id: contactId,
      status: messageId ? 'sent' : 'failed',
      sent_at: messageId ? new Date().toISOString() : null,
      whatsapp_message_id: messageId,
      error_message: errorMessage,
    })
  } catch (e) {
    console.error('[sendBroadcast] falha ao gravar recipient (best-effort):', e)
  }
}
```

(c) Reescrever o corpo de `sendBroadcast` a partir do passo "3) Fan-out" (mantém 1 e 2 — config + template APPROVED — exatamente como estão). Substituir do comentário `// 3) Fan-out` até o `return` final por:

```ts
  // 3) Cria a linha broadcasts (rastreio). Falha alto: sem rastro, não envia.
  const { data: broadcast, error: broadcastError } = await ctx.admin
    .from('broadcasts')
    .insert({
      account_id: ctx.accountId,
      user_id: ctx.auditUserId,
      name: body.name ?? `API: ${body.template_name}`,
      template_name: body.template_name,
      template_language: body.template_language,
      audience_filter: { type: 'api' },
      status: 'sending',
      total_recipients: body.recipients.length,
    })
    .select('id')
    .single()
  if (broadcastError || !broadcast) {
    console.error('[sendBroadcast] falha ao criar broadcast:', (broadcastError as { message?: string })?.message)
    throw new ApiError(500, 'internal_error', 'Erro interno ao registrar o broadcast.')
  }
  const broadcastId = (broadcast as { id: string }).id

  // 4) Best-effort: linka recipients a contatos existentes por telefone (sem criar).
  const sanitizedByOriginal = new Map<string, string>()
  for (const r of body.recipients) sanitizedByOriginal.set(r.phone, sanitizePhoneForMeta(r.phone))
  const contactIdByPhone = new Map<string, string>()
  try {
    const { data: contacts } = await ctx.admin
      .from('contacts')
      .select('id, phone')
      .eq('account_id', ctx.accountId)
      .in('phone', [...sanitizedByOriginal.values()])
    for (const c of (contacts as Array<{ id: string; phone: string | null }> | null) ?? []) {
      if (c.phone) contactIdByPhone.set(c.phone, c.id)
    }
  } catch (e) {
    console.error('[sendBroadcast] lookup de contatos falhou (best-effort):', e)
  }

  // 5) Fan-out: envia + persiste cada destinatário.
  const results: BroadcastRecipientResult[] = []
  let sent = 0
  let failed = 0

  for (const r of body.recipients) {
    const sanitized = sanitizedByOriginal.get(r.phone) as string
    const contactId = contactIdByPhone.get(sanitized) ?? null

    if (!isValidE164(sanitized)) {
      results.push({ phone: r.phone, status: 'failed', error: 'Telefone em formato inválido' })
      failed++
      await persistRecipient(ctx, broadcastId, contactId, null, 'Telefone em formato inválido')
      continue
    }

    let messageId: string | null = null
    let lastError: string | null = null
    for (const variant of phoneVariants(sanitized)) {
      try {
        const res = await sendTemplateMessage({
          phoneNumberId: config.phone_number_id as string,
          accessToken,
          to: variant,
          templateName: body.template_name,
          language: body.template_language,
          template: rawTemplate,
          params: r.params ?? [],
        })
        messageId = res.messageId
        lastError = null
        break
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Erro desconhecido'
        lastError = msg
        if (!isRecipientNotAllowedError(msg)) break
      }
    }

    if (messageId) {
      results.push({ phone: r.phone, status: 'sent', whatsapp_message_id: messageId })
      sent++
    } else {
      results.push({ phone: r.phone, status: 'failed', error: lastError ?? 'Falha no envio' })
      failed++
    }
    await persistRecipient(ctx, broadcastId, contactId, messageId, messageId ? null : (lastError ?? 'Falha no envio'))
  }

  // 6) Finaliza o status do broadcast (best-effort; counts vêm do trigger 003).
  try {
    await ctx.admin.from('broadcasts').update({ status: sent === 0 ? 'failed' : 'sent' }).eq('id', broadcastId)
  } catch (e) {
    console.error('[sendBroadcast] falha ao finalizar status (best-effort):', e)
  }

  return { sent, failed, results, broadcast_id: broadcastId }
}
```

(d) Garantir que `ApiError` está importado (já está: `import { ..., ApiError } from '@/lib/api/errors'`).

- [ ] **Step 5: Rodar o teste (GREEN)**

Run: `npx vitest run src/lib/broadcasts/api-service.test.ts`
Expected: todos PASS (os mantidos + os novos de persistência).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: sem erros.

- [ ] **Step 7: Ajustar o teste da rota v1 se ele assertar o shape exato**

Abrir `src/app/api/v1/broadcasts/route.test.ts`. Se algum `expect` comparar a resposta com `toEqual({ sent, failed, results })` (shape exato), trocar por `toMatchObject({ sent, failed, results })` (o `broadcast_id` é aditivo). Se já usa `toMatchObject`/checa campos individualmente, **não mexer**. Rodar:

Run: `npx vitest run "src/app/api/v1/broadcasts/route.test.ts"`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/api/schemas/broadcasts.ts src/lib/broadcasts/api-service.ts src/lib/broadcasts/api-service.test.ts
git commit -m "feat(broadcasts): v1 persiste broadcasts + recipients (status webhook/analytics) (#5)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

(Se o Step 7 tocou `route.test.ts`, incluir o caminho no `git add`.)

---

### Task 2: selo APPROVED no broadcast interno

**Files:**
- Modify: `src/app/api/whatsapp/broadcast/route.ts` (guard 422 quando template local não-APPROVED)
- Test: `src/app/api/whatsapp/broadcast/route.test.ts` (novo)

**Interfaces:**
- Consumes: `requireRole`/`toErrorResponse`, `sendTemplateMessage`, `decrypt`, `checkRateLimit`, `isMessageTemplate`, phone-utils.
- Produces: nada.

- [ ] **Step 1: Escrever o teste (RED)**

Criar `src/app/api/whatsapp/broadcast/route.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest'

const requireRoleMock = vi.fn()
vi.mock('@/lib/auth/account', () => ({
  requireRole: (...a: unknown[]) => requireRoleMock(...a),
  toErrorResponse: (err: { message?: string; status?: number } | null) =>
    new Response(JSON.stringify({ error: err?.message ?? 'err' }), { status: err?.status ?? 500, headers: { 'content-type': 'application/json' } }),
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({ sendTemplateMessage: vi.fn(async () => ({ messageId: 'm-1' })) }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: vi.fn((v: string) => `dec:${v}`) }))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ success: true })),
  rateLimitResponse: () => new Response(null, { status: 429 }),
  RATE_LIMITS: { broadcast: {} },
}))

import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { POST } from './route'

// Fake do ctx.supabase (sessão): config + template configuráveis.
function makeSupabase(cfg: { config?: unknown; template?: unknown }) {
  function from(table: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {
      select: () => b,
      eq: () => b,
      single: () => Promise.resolve({ data: table === 'whatsapp_config' ? cfg.config ?? null : null, error: cfg.config ? null : { message: 'x' } }),
      maybeSingle: () => Promise.resolve({ data: table === 'message_templates' ? cfg.template ?? null : null, error: null }),
    }
    return b
  }
  return { from } as never
}

const CONFIG = { phone_number_id: 'pn-1', access_token: 'enc' }
const TPL = (status: string) => ({ id: 't1', user_id: 'u1', account_id: 'a1', name: 'promo', language: 'en_US', status, body_text: 'Oi {{1}}', buttons: null, header_type: null, header_text: null, sample_values: null, meta_template_id: null })

function setCtx(cfg: { config?: unknown; template?: unknown }) {
  requireRoleMock.mockResolvedValue({ supabase: makeSupabase(cfg), accountId: 'a1', userId: 'u1', role: 'admin', email: null, account: { id: 'a1', name: 'X', status: 'active', accountType: null } })
}

function req(body: unknown) {
  return new Request('http://x', { method: 'POST', body: JSON.stringify(body) })
}

beforeEach(() => { requireRoleMock.mockReset(); vi.clearAllMocks() })

describe('POST /api/whatsapp/broadcast — selo APPROVED', () => {
  it('422 quando o template local não está APPROVED (sem fan-out)', async () => {
    setCtx({ config: CONFIG, template: TPL('PENDING') })
    const res = await POST(req({ recipients: [{ phone: '5592999999991' }], template_name: 'promo', template_language: 'en_US' }))
    expect(res.status).toBe(422)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('envia quando o template está APPROVED', async () => {
    setCtx({ config: CONFIG, template: TPL('APPROVED') })
    const res = await POST(req({ recipients: [{ phone: '5592999999991' }], template_name: 'promo', template_language: 'en_US' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sent).toBe(1)
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1)
  })

  it('403 quando requireRole rejeita', async () => {
    requireRoleMock.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403 }))
    const res = await POST(req({ recipients: [{ phone: '5592999999991' }], template_name: 'promo' }))
    expect(res.status).toBe(403)
  })
})
```

- [ ] **Step 2: Rodar o teste pra ver falhar (RED)**

Run: `npx vitest run "src/app/api/whatsapp/broadcast/route.test.ts"`
Expected: FALHA no caso 422 — a rota atual não checa `status`, então um template PENDING faz o fan-out (200 + sendTemplateMessage chamado).

- [ ] **Step 3: Implementar o guard (GREEN)**

Em `src/app/api/whatsapp/broadcast/route.ts`, logo após o bloco que valida `isMessageTemplate` (o `if (rawTemplateRow && !isMessageTemplate(rawTemplateRow)) { ... return 500 }`), adicionar:

```ts
    // Selo: não disparar template que a Meta não aprovou (consistente com o
    // broadcast v1). Só quando temos a linha local — template não sincronizado
    // segue como antes (a Meta valida no envio).
    if (rawTemplateRow && rawTemplateRow.status !== 'APPROVED') {
      return NextResponse.json(
        { error: 'Template não está aprovado pela Meta.' },
        { status: 422 },
      )
    }
```

- [ ] **Step 4: Rodar o teste (GREEN)**

Run: `npx vitest run "src/app/api/whatsapp/broadcast/route.test.ts"`
Expected: 3 PASS.

- [ ] **Step 5: Typecheck + lint + suíte completa**

Run: `npx tsc --noEmit && npm run lint && npx vitest run`
Expected: `tsc` limpo; lint sem novos problemas nos arquivos tocados (baseline 3 errors / ~25 problems); suíte completa verde.

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/whatsapp/broadcast/route.ts" "src/app/api/whatsapp/broadcast/route.test.ts"
git commit -m "feat(broadcasts): rota interna rejeita template não-APPROVED (#5)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Pós-execução

1. **Sem migration** — nada a aplicar no banco.
2. Review final de branch (opus) → PR `iv-automacao/crm-vantage` (base main). Merge a critério do Iago.
3. Pós-merge: atualizar a auditoria (#5 → ✅, com a nota de escopo Opção 1) e a memória (`crm-vantage-api-foundation` ou criar uma específica de broadcasts).

## Self-review (writing-plans)

- **Cobertura do spec:** `name` opcional (T1 S1) ✓; cria `broadcasts` falha-alto + insere `broadcast_recipients` best-effort com wamid + contact_id best-effort + finaliza status + `broadcast_id` no retorno (T1 S4) ✓; selo APPROVED no interno 422 (T2) ✓; sem migration ✓; client hook/webhook/trigger/RLS intactos ✓.
- **Placeholders:** nenhum — todo passo tem código/comando completo.
- **Consistência de tipos:** `BroadcastSendResult` ganha `broadcast_id: string` (usado no teste e no retorno); `persistRecipient(ctx, broadcastId, contactId, messageId, errorMessage)` assinatura única; o fake admin cobre insert/in/update/select usados pelo código. `ctx.auditUserId` → `broadcasts.user_id`. Mock de `toErrorResponse` idêntico ao usado nos planos #2/#4.

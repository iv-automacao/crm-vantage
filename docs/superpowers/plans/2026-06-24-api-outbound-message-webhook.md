# Outbound message.received Webhook — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quando um cliente manda mensagem no WhatsApp, o CRM faz um POST assinado (HMAC) pra os endpoints de webhook configurados pela conta, com o payload COMPLETO da Meta + ids internos — best-effort, gerenciado por um painel admin.

**Architecture:** Tabela `webhook_endpoints` (account-scoped, admin-only RLS). Uma lib de assinatura (reusa o HMAC existente) + uma lib de dispatch best-effort. O inbound webhook da Meta (`webhook/route.ts`), dentro do `after()` que já existe, monta o payload e chama o dispatch. Gestão via rotas de sessão (`/api/account/webhooks`) + painel Configurações → Webhooks (espelha o de chaves de API).

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase (service role + sessão), Node crypto, vitest 4.

## Global Constraints

- Comentários de código em **português**.
- **Migration 026 é aplicada MANUALMENTE pelo Iago** no SQL Editor do Supabase dedicado (`mgmokvpjswtjxhqhnyps`) — o implementer só CRIA o arquivo `.sql`. Os testes mockam o banco; rotas/dispatch só funcionam em runtime após a migration.
- **Best-effort:** o dispatch NUNCA lança nem bloqueia o inbound webhook (200 pra Meta sai na hora). Timeout 10s por endpoint. **Secret NUNCA em log.**
- **Payload completo:** carrega o objeto cru da Meta (`meta.message`/`meta.contact`/`meta.metadata`) + ids normalizados (`account_id`, `conversation_id`, `contact{id,phone,name}`).
- Contrato de erro flat `{ error, code?, details? }` nas rotas de gestão. Gestão = admin-only (`requireRole('admin')`).
- Multi-tenant: endpoints filtrados por `account_id`.
- `npm run typecheck` limpo, `npm test` verde, `npm run build` exit 0 ao fim de cada task. Sem push/PR/merge.

---

### Task 1: Migration + lib de assinatura + lib de dispatch (núcleo da entrega)

**Files:**
- Create: `supabase/migrations/026_webhook_endpoints.sql`
- Create: `src/lib/webhooks/signature.ts`
- Create: `src/lib/webhooks/dispatch.ts`
- Create test: `src/lib/webhooks/signature.test.ts`, `src/lib/webhooks/dispatch.test.ts`

**Interfaces:**
- Produces: `signWebhookPayload(rawBody: string, secret: string): string` (`'sha256='+hex`); `buildMessageReceivedPayload(args): MessageReceivedPayload`; `dispatchMessageReceived(admin: SupabaseClient, accountId: string, payload: MessageReceivedPayload): Promise<void>` (best-effort, nunca lança).
- Tipos: `MessageReceivedPayload = { event: 'message.received'; account_id: string; conversation_id: string; contact: { id: string; phone: string; name: string | null }; meta: { message: unknown; contact: unknown; metadata: unknown } }`.

- [ ] **Step 1: Migration `supabase/migrations/026_webhook_endpoints.sql`**

```sql
-- 026_webhook_endpoints — endpoints de webhook de saída (message.received).
-- Aplicar MANUALMENTE no SQL Editor do Supabase. Idempotente.
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_account_active
  ON webhook_endpoints(account_id) WHERE is_active;
ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS webhook_endpoints_select ON webhook_endpoints;
DROP POLICY IF EXISTS webhook_endpoints_modify ON webhook_endpoints;
CREATE POLICY webhook_endpoints_select ON webhook_endpoints FOR SELECT
  USING (is_account_member(account_id, 'admin'));
CREATE POLICY webhook_endpoints_modify ON webhook_endpoints FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
```
(Sem teste — é SQL aplicado manual. Committar o arquivo.)

- [ ] **Step 2: Teste da assinatura `src/lib/webhooks/signature.test.ts`**
```ts
import { signWebhookPayload } from './signature'
import crypto from 'node:crypto'

it('assina HMAC-SHA256 com prefixo sha256=', () => {
  const body = '{"a":1}', secret = 'whsec_test'
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
  expect(signWebhookPayload(body, secret)).toBe(expected)
})
it('muda quando o corpo muda', () => {
  expect(signWebhookPayload('{"a":1}', 's')).not.toBe(signWebhookPayload('{"a":2}', 's'))
})
```

- [ ] **Step 3: Rodar — falha**

Run: `npx vitest run src/lib/webhooks/signature.test.ts` — FAIL.

- [ ] **Step 4: Implementar `src/lib/webhooks/signature.ts`**
```ts
import crypto from 'node:crypto'
/** Assina o corpo cru com HMAC-SHA256. Mesma forma que verifyMetaWebhookSignature compara. */
export function signWebhookPayload(rawBody: string, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
}
```

- [ ] **Step 5: Rodar — passa**

Run: `npx vitest run src/lib/webhooks/signature.test.ts` — PASS.

- [ ] **Step 6: Teste do dispatch `src/lib/webhooks/dispatch.test.ts`**

Mockar `globalThis.fetch`. Casos com um fake admin client (`.from().select().eq().eq()` resolvendo `data`):
- `buildMessageReceivedPayload`: monta o objeto com `event:'message.received'`, ids e `meta` cru.
- `dispatchMessageReceived`: 1 endpoint ativo → `fetch` chamado 1x com header `x-webhook-signature` correto (= `signWebhookPayload(JSON.stringify(payload), secret)`) e `body` = JSON do payload; 2 endpoints → 2 fetches; `fetch` lançando (rejeita) → `dispatchMessageReceived` NÃO lança (best-effort) e resolve; nenhum endpoint → não chama fetch.

- [ ] **Step 7: Rodar — falha**

Run: `npx vitest run src/lib/webhooks/dispatch.test.ts` — FAIL.

- [ ] **Step 8: Implementar `src/lib/webhooks/dispatch.ts`**
```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { signWebhookPayload } from './signature'

export interface MessageReceivedPayload {
  event: 'message.received'
  account_id: string
  conversation_id: string
  contact: { id: string; phone: string; name: string | null }
  meta: { message: unknown; contact: unknown; metadata: unknown }
}

export function buildMessageReceivedPayload(args: {
  accountId: string
  conversationId: string
  contact: { id: string; phone: string; name: string | null }
  metaMessage: unknown
  metaContact: unknown
  metaMetadata: unknown
}): MessageReceivedPayload {
  return {
    event: 'message.received',
    account_id: args.accountId,
    conversation_id: args.conversationId,
    contact: args.contact,
    meta: { message: args.metaMessage, contact: args.metaContact, metadata: args.metaMetadata },
  }
}

/** Entrega best-effort: busca endpoints ativos da conta e faz POST assinado.
 *  NUNCA lança (não pode derrubar o inbound webhook). Nunca loga o secret. */
export async function dispatchMessageReceived(
  admin: SupabaseClient, accountId: string, payload: MessageReceivedPayload,
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
      try {
        const res = await fetch(ep.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-webhook-event': 'message.received',
            'x-webhook-signature': signWebhookPayload(rawBody, ep.secret),
          },
          body: rawBody,
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
```

- [ ] **Step 9: Rodar — passa + commit**

Run: `npm run typecheck && npx vitest run src/lib/webhooks`
```bash
git add supabase/migrations/026_webhook_endpoints.sql src/lib/webhooks/signature.ts src/lib/webhooks/signature.test.ts src/lib/webhooks/dispatch.ts src/lib/webhooks/dispatch.test.ts
git commit -m "feat(webhooks): migration + assinatura HMAC + dispatch best-effort (message.received)"
```

---

### Task 2: Engatar o dispatch no inbound webhook

**Files:**
- Modify: `src/app/api/whatsapp/webhook/route.ts` (passar `value.metadata` ao `processMessage`; disparar após o insert da mensagem)

**Interfaces:**
- Consumes: `buildMessageReceivedPayload`, `dispatchMessageReceived` (`@/lib/webhooks/dispatch`), `supabaseAdmin` (já importado na rota).

- [ ] **Step 1: Threadar `metadata` no `processMessage`**

No loop (~270): `processMessage(message, contact, config.account_id, config.user_id, decryptedAccessToken, value.metadata)`. Adicionar o parâmetro `metaMetadata: unknown` à assinatura de `processMessage`.

- [ ] **Step 2: Disparar após o insert da mensagem**

Dentro de `processMessage`, IMEDIATAMENTE após o insert bem-sucedido em `messages` (o ponto onde hoje a mensagem é gravada, ~604-618; NÃO no caminho de reaction nem nos early-returns), e antes de qualquer `runAutomationsForTrigger`/`dispatchInboundToFlows`, adicionar:
```ts
// Webhook de saída (best-effort): reencaminha o payload completo da Meta
// pros endpoints da conta. Não bloqueia nem derruba o processamento.
await dispatchMessageReceived(
  supabaseAdmin(),
  accountId,
  buildMessageReceivedPayload({
    accountId,
    conversationId: conversation.id,
    contact: { id: contactRecord.id, phone: contactRecord.phone, name: contactRecord.name ?? null },
    metaMessage: message,        // value.messages[i] cru
    metaContact: contact,        // value.contacts[i] cru
    metaMetadata: metaMetadata,  // value.metadata cru (novo parâmetro)
  }),
)
```
(Confirmar os nomes reais das variáveis no escopo: `conversation`, `contactRecord`, `message`, `contact`, `accountId`. Se `contactRecord.name`/`.phone` tiverem outro nome, ajustar.)

- [ ] **Step 3: typecheck + verificação manual**

Run: `npm run typecheck`
Expected: limpo. (E2E real precisa da migration aplicada + um endpoint — testado na review final / produção.)

- [ ] **Step 4: Commit**
```bash
git add src/app/api/whatsapp/webhook/route.ts
git commit -m "feat(webhooks): dispara message.received do inbound webhook (payload cru da Meta + ids internos)"
```

---

### Task 3: Rotas de gestão `/api/account/webhooks` (sessão, admin-only)

**Files:**
- Create: `src/app/api/account/webhooks/route.ts` (GET listar, POST criar)
- Create: `src/app/api/account/webhooks/[id]/route.ts` (PATCH toggle, DELETE)
- Create: `src/lib/webhooks/secret.ts` (gerador de secret) + test `src/lib/webhooks/secret.test.ts`

**Interfaces:**
- Consumes: `requireRole`/`toErrorResponse` (`@/lib/auth/account`), `checkRateLimit`/`rateLimitResponse`/`RATE_LIMITS` (`@/lib/rate-limit`).
- Produces: `generateWebhookSecret(): string` (`'whsec_'+base64url(32)`).

- [ ] **Step 1: Gerador de secret + teste**

`src/lib/webhooks/secret.ts`:
```ts
import { randomBytes } from 'node:crypto'
export const WEBHOOK_SECRET_PREFIX = 'whsec_'
export function generateWebhookSecret(): string {
  return WEBHOOK_SECRET_PREFIX + randomBytes(32).toString('base64url')
}
```
Teste `secret.test.ts`: começa com `whsec_`; dois geram valores diferentes; comprimento > 40.

- [ ] **Step 2: Rodar — passa**

Run: `npx vitest run src/lib/webhooks/secret.test.ts` — PASS.

- [ ] **Step 3: Rota `src/app/api/account/webhooks/route.ts`** (espelha `src/app/api/account/api-keys/route.ts`)
- `GET`: `requireRole('admin')` → `ctx.supabase.from('webhook_endpoints').select('id,url,description,is_active,created_at').eq('account_id', ctx.accountId).order('created_at', {ascending:false})` → `{ endpoints }`.
- `POST`: `requireRole('admin')` + `checkRateLimit('adminAction:'+ctx.userId, RATE_LIMITS.adminAction)`. Body `{ url, description? }`. Validar `url`: string não-vazia, começa com `http://` ou `https://` (senão 400 `{error:'URL inválida'}`). Gerar `secret = generateWebhookSecret()`. Insert `{ account_id, url, secret, description, created_by_user_id: ctx.userId }` retornando `id,url,description,is_active,created_at`. Resposta inclui o `secret` cru UMA vez (201). Limite de, ex., 10 endpoints ativos por conta (count + 409 se exceder).

- [ ] **Step 4: Rota `src/app/api/account/webhooks/[id]/route.ts`**
- `PATCH`: `requireRole('admin')` + rate limit. Body `{ is_active: boolean }`. `update({is_active}).eq('id', id).eq('account_id', ctx.accountId).select('id,is_active').maybeSingle()` → null = 404 `{error:'Endpoint não encontrado'}`. Retorna o registro. (Ler o `id` do 2º arg de params do Next 16 OU de `new URL(req.url).pathname` — confirmar nos docs; seguir o padrão das rotas `[id]` de `/api/account/members/[userId]`.)
- `DELETE`: `requireRole('admin')` + rate limit. `delete().eq('id', id).eq('account_id', ctx.accountId)` → 200 `{ ok: true }`.
- Ambos via `try { ... } catch (err) { return toErrorResponse(err) }`.

- [ ] **Step 5: Teste do gerador (já no Step 1) + typecheck**

Run: `npm run typecheck && npx vitest run src/lib/webhooks` — verde. (As rotas de sessão espelham as de api-keys, que não têm teste de rota dedicado; cobrir o gerador + validação por inspeção. Se quiser, um teste fino da validação de URL extraída numa função `isValidWebhookUrl(url)` em `secret.ts`.)

- [ ] **Step 6: Commit**
```bash
git add src/app/api/account/webhooks src/lib/webhooks/secret.ts src/lib/webhooks/secret.test.ts
git commit -m "feat(webhooks): rotas de gestão /api/account/webhooks (admin) + gerador de secret"
```

---

### Task 4: Painel Configurações → Webhooks

**Files:**
- Create: `src/components/settings/webhooks-panel.tsx`
- Modify: `src/components/settings/settings-sections.ts` (+seção 'webhooks')
- Modify: `src/app/(dashboard)/settings/page.tsx` (mapear a seção pro painel — conferir como as seções são renderizadas)

**Interfaces:**
- Consumes: `useAuth` (`canManageMembers` pro gate admin), os endpoints da Task 3.

- [ ] **Step 1: Seção no `settings-sections.ts`**

Adicionar `'webhooks'` ao array `SETTINGS_SECTIONS` e ao `SECTION_META` (grupo `'workspace'`, label `'Webhooks'`, ícone `Webhook` de lucide-react). Conferir o tipo/registro existente.

- [ ] **Step 2: Painel `webhooks-panel.tsx`** (espelha `src/components/settings/api-keys-panel.tsx`)

`'use client'`. Gate admin (`canManageMembers` do `useAuth` → não-admin vê aviso de bloqueio, igual ao api-keys-panel). Estado: lista de endpoints (`fetch('/api/account/webhooks')`), dialog de criação (campo URL + descrição → POST → mostra o `secret` UMA vez com aviso de copiar + botão "Ver documentação"? não — só o secret), toggle ativo (PATCH), deletar (DELETE com confirmação). `SettingsPanelHead` title "Webhooks", description "Receba um POST no seu n8n quando um cliente mandar mensagem.". Mostrar a URL, status ativo, data; o secret só aparece no dialog de criação. Comentários em português.

- [ ] **Step 3: Renderizar a seção em `settings/page.tsx`**

Conferir como `settings/page.tsx` mapeia `section → componente` e adicionar `webhooks: <WebhooksPanel />` no mapa (seguir o padrão de `api`/`members`).

- [ ] **Step 4: Verificação + commit**

Run: `npm run typecheck && npx eslint src/components/settings/webhooks-panel.tsx src/components/settings/settings-sections.ts && npm run build`
Expected: typecheck limpo, eslint sem erros nos arquivos novos, build exit 0. (UI validada no dev na review final.)
```bash
git add src/components/settings/webhooks-panel.tsx src/components/settings/settings-sections.ts src/app/(dashboard)/settings/page.tsx
git commit -m "feat(settings): painel Webhooks (criar/listar/toggle/deletar endpoints)"
```

---

## Self-Review (feito)

- **Cobertura do spec:** tabela+migration (T1), assinatura HMAC (T1), dispatch best-effort + payload cru (T1), engate no inbound (T2), rotas de gestão admin (T3), painel + seção (T4). ✓
- **Migration manual** anotada nos Global Constraints + Task 1 step 1. ✓
- **Consistência de tipos:** `MessageReceivedPayload`, `signWebhookPayload`, `buildMessageReceivedPayload`, `dispatchMessageReceived`, `generateWebhookSecret` — idênticos entre T1/T2/T3. ✓
- **Best-effort/segurança:** dispatch nunca lança (try/catch externo + por-endpoint), timeout 10s, secret nunca em log, payload cru completo. ✓
- **Tenant:** endpoints por `account_id` (dispatch usa o accountId do inbound; gestão usa `ctx.accountId`). ✓
- **Risco:** confirmar nomes reais das vars no `processMessage` (`conversation`, `contactRecord.phone/.name`) — anotado em T2 step2.

## Fora de escopo (próximas rodadas)
Outros eventos; fila durável + retry; log de entregas; CRUD via API pública; criptografar secret em repouso; **CRM → Meta (CAPI)**.

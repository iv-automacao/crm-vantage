# Design — Webhook de saída `message.received` (CRM → n8n)

**Data:** 2026-06-24 · **Status:** aprovado no brainstorming, aguardando review do spec

## Contexto

A API pública do CRM já deixa o agente n8n **agir** (contatos, deals, conversas, broadcasts — PRs #9/#10/#11/#12). Falta o sentido inverso: o CRM **avisar** o n8n quando algo acontece. Esta é a fatia mínima viável disso — **um único evento, `message.received`** (cliente mandou mensagem no WhatsApp), reencaminhando o **payload completo da Meta** pro endpoint do cliente, assinado com HMAC.

Escopo deliberadamente enxuto (ver `crm-vantage-scope-preference`): só `message.received` porque é o único evento que vem do nosso servidor (o inbound webhook da Meta) — não precisa de triggers de banco. As demais mudanças (deal, contato, conversa) o agente já cobre pela API, então não duplicamos num subsistema pesado. Entrega **best-effort** (fire-and-forget no `after()` que já existe) — sem fila/cron/retry.

**Próxima frente anotada (fora deste escopo):** CRM → Meta via Conversions API (CAPI) — devolver conversões de CTWA pra Meta otimizar tráfego. O `referral` da Meta (capturado no payload completo aqui) é o insumo dela.

## Decisões travadas (brainstorming)

- **Um evento:** `message.received` (inbound do cliente). Statuses (delivered/read) fora.
- **Payload completo:** carrega o objeto **cru da Meta** (`value.messages[i]` + `value.contacts[i]` + `value.metadata`) + ids normalizados do CRM. O n8n mapeia tudo (incl. `referral`, `context`, `interactive`, mídia).
- **Entrega best-effort** via `after()` (sem outbox/cron/retry). Mensagem continua salva no inbox mesmo se o POST falhar.
- **Gestão por painel** Configurações → Webhooks (admin-only). Sem CRUD via API nesta rodada.

## Fatos do código (grounding)

- Inbound webhook: `src/app/api/whatsapp/webhook/route.ts` — `processWebhook` roda dentro de `after()` (linha ~190). O loop em ~270 tem em mãos `message = value.messages[i]`, `contact = value.contacts[i]`, `value.metadata` (objeto cru da Meta), `phoneNumberId` (~229) e o `account_id` resolvido (via config). `findOrCreateContact`/`findOrCreateConversation` dão os ids internos (`contact.id`, conversation id).
- HMAC: `verifyMetaWebhookSignature` (`src/lib/whatsapp/webhook-signature.ts`) verifica inbound (`'sha256='+HMAC-SHA256(rawBody, secret)`, timing-safe). A direção de **assinatura** (gerar o digest) é a mesma lógica — extrair/criar um `signWebhookPayload(rawBody, secret)`.
- Convenções de tabela (migration manual no SQL Editor; ver `024_api_keys.sql`): `account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE`, RLS via `is_account_member(account_id, 'admin')`, índice parcial, `created_by_user_id`, timestamps.
- Padrão de painel: `src/components/settings/api-keys-panel.tsx` (admin-only, gera secret 1x, lista/cria/revoga) — espelhar.
- `src/lib/notify/approval.ts` é o padrão best-effort de `fetch` (erros só logados) — reusar a postura.

## Arquitetura

```
supabase/migrations/026_webhook_endpoints.sql   # tabela webhook_endpoints (manual)
src/lib/webhooks/signature.ts        # signWebhookPayload(rawBody, secret) (HMAC-SHA256) — reuso da lógica existente
src/lib/webhooks/dispatch.ts         # dispatchMessageReceived(admin, accountId, payload) — busca endpoints ativos + POST assinado best-effort
src/app/api/whatsapp/webhook/route.ts # (modificar) no loop de mensagem, monta o payload e chama dispatch dentro do after()
src/app/api/account/webhooks/route.ts        # GET (listar) + POST (criar endpoint) — admin, sessão
src/app/api/account/webhooks/[id]/route.ts   # PATCH (toggle is_active) + DELETE
src/components/settings/webhooks-panel.tsx   # painel Configurações → Webhooks
src/components/settings/settings-sections.ts # +seção 'webhooks' no rail de Configurações
```

### Tabela `webhook_endpoints` (migration 026, manual)
```sql
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,            -- segredo de assinatura (mostrado 1x na criação)
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_account_active
  ON webhook_endpoints(account_id) WHERE is_active;
ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;
CREATE POLICY webhook_endpoints_select ON webhook_endpoints FOR SELECT USING (is_account_member(account_id, 'admin'));
CREATE POLICY webhook_endpoints_modify ON webhook_endpoints FOR ALL
  USING (is_account_member(account_id, 'admin')) WITH CHECK (is_account_member(account_id, 'admin'));
```
> Decisão: o `secret` fica em texto na tabela (não hash) porque precisa ser usado pra **assinar** cada disparo (diferente da chave de API, que só é comparada). É admin-only via RLS; aceitável. (Criptografar com `ENCRYPTION_KEY` é upgrade futuro.)

### Assinatura (`src/lib/webhooks/signature.ts`)
```ts
import crypto from 'node:crypto'
/** Assina o corpo cru com HMAC-SHA256 → header X-Webhook-Signature. */
export function signWebhookPayload(rawBody: string, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
}
```
(Espelha exatamente a geração que `verifyMetaWebhookSignature` compara.)

### Disparo (`src/lib/webhooks/dispatch.ts`)
```ts
export interface MessageReceivedPayload {
  event: 'message.received'
  account_id: string
  conversation_id: string
  contact: { id: string; phone: string; name: string | null }
  meta: { message: unknown; contact: unknown; metadata: unknown }  // cru da Meta
}
// Busca endpoints ativos da conta e faz POST assinado, best-effort (nunca lança).
export async function dispatchMessageReceived(admin, accountId: string, payload: MessageReceivedPayload): Promise<void>
```
- `admin.from('webhook_endpoints').select('id,url,secret').eq('account_id', accountId).eq('is_active', true)`.
- Pra cada endpoint: `rawBody = JSON.stringify(payload)`, `sig = signWebhookPayload(rawBody, secret)`, `fetch(url, { method:'POST', headers:{'content-type':'application/json','x-webhook-signature':sig,'x-webhook-event':'message.received'}, body: rawBody })` com timeout (`AbortSignal.timeout(10_000)`). Erro/timeout → `console.warn` (nunca lança — best-effort). **Nunca logar o secret.**

### Engate no inbound webhook (`webhook/route.ts`, no loop de mensagem ~270)
Após resolver contato/conversa e salvar a mensagem, dentro do `after()` já existente, montar o `MessageReceivedPayload` (ids internos + `meta` cru) e chamar `dispatchMessageReceived(...)`. Não bloqueia o ACK do webhook (200 pra Meta sai na hora). Falha de entrega não afeta o processamento.

### Gestão — painel + rotas de sessão (admin-only)
- `GET/POST /api/account/webhooks` e `PATCH/DELETE /api/account/webhooks/[id]` — `requireRole('admin')`, RLS scoped, rate limit `adminAction`. POST gera o `secret` (CSPRNG, ex.: `whsec_<base64url(32)>`) e o devolve **uma vez**; depois a UI mostra só um prefixo/máscara.
- `webhooks-panel.tsx` espelha `api-keys-panel.tsx`: criar (URL + descrição → mostra secret 1x), listar (URL, ativo, criado), toggle ativo, deletar. Aviso de copiar o secret.
- Nova seção `webhooks` no `settings-sections.ts` (grupo workspace, ícone tipo `Webhook`/`Radio`), admin-only.

### Erros / segurança
- Endpoints de gestão: contrato de erro existente; `requireRole('admin')` (403 a não-admin). URL validada (http/https, não-vazia).
- Disparo best-effort: nunca derruba o inbound webhook; timeout de 10s por endpoint; secret nunca em log.
- Multi-tenant: endpoints filtrados por `account_id` (da config do inbound, que já é account-scoped).

## Fora de escopo (próximas rodadas)
- Outros eventos (deal/contato/conversa) — o agente já cobre pela API; se precisar, exigem triggers de banco (decisão adiada).
- Fila durável + retry/backoff (hoje best-effort); log de entregas; reenvio manual.
- CRUD de endpoints via API pública (hoje só painel/sessão).
- Criptografar o `secret` em repouso.
- **CRM → Meta (CAPI):** devolver conversões pra Meta — cluster próprio, alto valor.

## Verificação (E2E)
1. `typecheck` limpo, `npm test` verde, `build` exit 0.
2. Migration 026 aplicada (manual). Criar endpoint no painel (URL de teste, ex.: webhook.site) → secret aparece 1x.
3. Cliente manda mensagem no WhatsApp → o endpoint recebe um POST com `event:'message.received'`, `account_id`, `conversation_id`, `contact{...}`, e `meta.message`/`meta.contact`/`meta.metadata` **crus da Meta** (conferir que `referral`/`context`/mídia aparecem quando presentes). Header `X-Webhook-Signature: sha256=...` validável com o secret.
4. Endpoint inativo (toggle off) → não recebe. Endpoint de outra conta → nunca recebe (isolamento).
5. URL fora do ar → o inbound webhook responde 200 normalmente pra Meta e a mensagem é salva (best-effort não derruba nada); só um `console.warn`.
6. Não-admin não vê o painel / `/api/account/webhooks` retorna 403.

## Pós-implementação
- Atualizar memória `crm-vantage-api-foundation` (ou nova): webhook de saída `message.received` no ar (best-effort, payload cru da Meta, painel admin), e o ponteiro pra a frente CAPI (CRM→Meta).

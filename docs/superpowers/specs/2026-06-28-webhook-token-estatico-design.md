# Token estático no webhook do agente — Design

**Data:** 2026-06-28
**Contexto:** Simplificação do canal de saída CRM → n8n. Substitui a assinatura HMAC por um **token estático em header**, validável nativamente pelo Header Auth do n8n (zero código). Continuação de `2026-06-28-webhook-agente-n8n-design.md` (mesma branch/PR #23).
**Relacionados:** [[crm-vantage-webhook-agent-feed]], [[crm-vantage-n8n-agent-loop]].

## Problema

O webhook de saída (`message.received`, `dispatch.ts`) assina o corpo com **HMAC-SHA256** (`x-webhook-signature: sha256=…`, `signature.ts`). Validar isso no n8n exige um nó de código + acertar o "corpo cru" (fonte comum de erro). Como o n8n é infra própria em HTTPS, o HMAC é defesa-em-profundidade desnecessária — dá pra simplificar sem perder autenticação real.

## Decisões (do brainstorming)

1. **Substituir HMAC por token estático.** O CRM manda `x-webhook-token: <secret>`; o HMAC do canal de saída sai.
2. **Token = o secret que já existe** (`webhook_endpoints.secret`, `whsec_…`, por endpoint/conta). **Sem gerador novo, sem migration.**
3. **Header:** `x-webhook-token`.
4. **Acesso ao token: "uma vez + rotacionar".** Continua exibido só na criação; ganha botão **Rotacionar** (gera novo secret, invalida o antigo) sem deletar o endpoint. Sem "revelar a qualquer momento".
5. **Dobrar no PR #23** (ainda não mergeado, mesmo `dispatch.ts`).

## Arquitetura

### 1. Transporte (`src/lib/webhooks/dispatch.ts`)
- Trocar o header `x-webhook-signature` (HMAC) por **`x-webhook-token: ep.secret`**.
- Remover o import/uso de `signWebhookPayload`.
- Manter o resto que o #23 trouxe: `redirect:'manual'`, `AbortSignal.timeout(10_000)`, guard `isValidWebhookUrl(ep.url)`, e o header `x-webhook-event`.
- `dispatch.test.ts`: os testes que verificavam a assinatura passam a verificar o header `x-webhook-token` (= o secret do endpoint).

### 2. Código morto removido
- `src/lib/webhooks/signature.ts` e `src/lib/webhooks/signature.test.ts` são **só do canal de saída** → remover (ninguém mais usa `signWebhookPayload`).
- ⚠️ **NÃO** tocar em `src/lib/whatsapp/webhook-signature.ts` (assinatura de **entrada** da Meta, `x-hub-signature-256`) — é outra coisa, continua.

### 3. Rotacionar token
- **Rota:** `POST /api/account/webhooks/[id]/rotate` — `requireRole('admin')`, valida posse por `account_id`, gera `generateWebhookSecret()`, faz `UPDATE webhook_endpoints SET secret = … WHERE id = … AND account_id = …`, devolve `{ secret }` **uma vez** (mesmo formato do POST de criação). Rate limit `adminAction` como as outras mutações.
- **UI (`webhooks-panel.tsx`):** botão "Rotacionar token" por endpoint → dialog de confirmação (avisa: "o n8n para de validar até você atualizar o token lá") → reaproveita a tela de "secret exibido uma vez" (input read-only + copiar).

### 4. Configurar o n8n melhor (UX)
Os dialogs de **criar** e **rotacionar** exibem, prontos pra colar:
- **Header:** `x-webhook-token`
- **Token:** o secret (com botão copiar)
- Nota: *"No n8n, nó Webhook → Authentication: **Header Auth** → credencial com Name = `x-webhook-token` e Value = este token."*
- Atualizar a descrição do painel e o texto do dialog (hoje citam "assinatura HMAC") pra refletir o Header Auth.

## Componentes e responsabilidades

| Arquivo | Mudança |
|---|---|
| `src/lib/webhooks/dispatch.ts` | header `x-webhook-token` no lugar do HMAC; remove `signWebhookPayload` |
| `src/lib/webhooks/dispatch.test.ts` | testes do header `x-webhook-token` |
| `src/lib/webhooks/signature.ts` + `.test.ts` | **remover** (dead code do outbound) |
| `src/app/api/account/webhooks/[id]/rotate/route.ts` | **novo** — POST rotate (admin, por conta, devolve secret 1x) |
| `src/components/settings/webhooks-panel.tsx` | botão Rotacionar + dialog; textos do n8n (header + Header Auth) |

## Fora de escopo (YAGNI)
- "Revelar token a qualquer momento" (escolhido rotacionar).
- Integridade/anti-replay (HMAC) — abandonado de propósito (n8n próprio, HTTPS).

> **Trade-off de segurança (reconhecido):** o token estático viaja igual em todo request e fica **em repouso** no log de execução do n8n (o nó Webhook guarda os headers recebidos, visíveis em Executions) e em proxies (Easypanel/reverse-proxy) — diferente do HMAC, que nunca transmite o secret. HTTPS cobre só o trânsito, não o repouso. Mitigação: retenção curta de execuções no n8n + **Rotacionar** se o token vazar. Aceitável pro modelo (n8n próprio).
- Assinatura de entrada (Meta) — intocada.
- Migration — nenhuma (reusa coluna `secret` existente).

## Restrições
- Comentários em **português**. Nunca `git add -A`. PRs → `iv-automacao/crm-vantage` (dobrar no #23, branch `feat/webhook-agente-n8n`).
- Lint baseline = 3. `npx tsc --noEmit` limpo; suíte verde.
- Rota nova segue o padrão das rotas `account/webhooks` (sessão + RLS + `requireRole('admin')` + rate limit `adminAction`).

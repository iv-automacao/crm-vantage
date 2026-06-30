# `whatsapp/media/[mediaId]` — posse + rate limit — Design

**Data:** 2026-06-30
**Contexto:** Item **#8 (P2)** da auditoria `docs/auditoria/2026-06-28-conflitos-webhooks-apis.md`.
**Relacionados:** [[crm-vantage-rbac]], [[crm-vantage-hardening]], auditoria-mãe.

## Problema

`src/app/api/whatsapp/media/[mediaId]/route.ts` serve o binário de uma mídia do WhatsApp pelo `mediaId`. Já tem `requireActiveAccount()` (o gate de conta/role que o audit listou **já existe** — desatualizado nesse ponto). Faltam dois controles:

1. **Sem checagem de posse:** recebe um `mediaId` e baixa direto da Meta com o token da conta, **sem confirmar** que aquele mídia pertence a uma mensagem da conta. O cross-tenant é limitado pela Meta (token escopado por WABA), mas **dentro da conta** é over-permissão — qualquer membro ativo poderia puxar qualquer `mediaId` que conheça/chute.
2. **Sem rate limit:** baixa binário sem throttle → exfiltração em massa.

## Fato que destrava a posse (sem migration)

As mensagens guardam `media_url = `/api/whatsapp/media/${mediaId}`` (construído em `parseMessageContent`, `webhook/route.ts:857`; coluna `messages.media_url`). Então dá pra confirmar posse com 1 SELECT via `ctx.supabase` (RLS escopa `messages`→`conversations`→conta): existe uma mensagem da conta com esse `media_url`?

## Decisões (do brainstorming)

1. **Checagem de posse a nível de CONTA:** antes de tocar a Meta, `ctx.supabase.from('messages').select('id').eq('media_url', `/api/whatsapp/media/${mediaId}`).limit(1)`. Se não achar (RLS) → **404** (não revela existência). Falha barata e cedo.
2. **Rate limit por USUÁRIO:** novo preset `RATE_LIMITS.media = { limit: 240, windowMs: 60_000 }` (generoso pro inbox — abrir conversa carrega várias mídias; respostas têm `Cache-Control: max-age=86400`, então re-render não reconta; ainda trava download em massa). `checkRateLimit(`media:${ctx.userId}`, RATE_LIMITS.media)` → **429** via `rateLimitResponse` se estourar. Por usuário (não conta): bate com `send`/`react`; o agente n8n não usa essa rota (pega URLs cruas).
3. **Sem mudança de papel:** `requireActiveAccount` (qualquer membro ativo) continua — ver mídia de conversa é coerente com ver a conversa.
4. **Sem migration.**

## Fora de escopo (decisão consciente)

- **Posse por-AGENTE** (vendedor só vê mídia de conversa atribuída a ele): é a **mesma limitação que o #21 já aceitou** — a visibilidade da inbox é app-layer e não barra API/URL direta. Trancar só a mídia ficaria inconsistente (mídia trancada, mas a API de `messages` não). Item maior; follow-up.
- Mover a mídia pra storage próprio / signed URLs: fora.

## Arquitetura

`src/app/api/whatsapp/media/[mediaId]/route.ts` GET, **após** `requireActiveAccount()`:
1. **Rate limit** (mais barato primeiro): `const limit = await checkRateLimit(`media:${ctx.userId}`, RATE_LIMITS.media); if (!limit.success) return rateLimitResponse(limit)`.
2. **Posse:** SELECT em `messages` por `media_url`; 0 linhas → 404.
3. Segue igual: config → `decrypt` → `getMediaUrl` → `downloadMedia` → `Response` com `Cache-Control`.

`src/lib/rate-limit.ts`: adiciona o preset `media` ao objeto `RATE_LIMITS` (perto de `presence`).

## Componentes e responsabilidades

| Arquivo | Mudança |
|---|---|
| `src/lib/rate-limit.ts` | +preset `media: { limit: 240, windowMs: 60_000 }` |
| `src/app/api/whatsapp/media/[mediaId]/route.ts` | +rate limit (429) +checagem de posse (404) antes de tocar a Meta |
| `src/app/api/whatsapp/media/[mediaId]/route.test.ts` | **novo** — 429 sob limite; 404 sem posse; 200 quando posse ok |

## Verificação

- **Unit (vitest):** mock de `@/lib/auth/account` (`requireActiveAccount` resolve ctx com `supabase` fake + `userId`/`accountId`), `@/lib/rate-limit` (`checkRateLimit` controlável `{success}`, `rateLimitResponse`, `RATE_LIMITS`), `@/lib/whatsapp/meta-api` (`getMediaUrl`/`downloadMedia`), `@/lib/whatsapp/encryption` (`decrypt`). Asserts:
  - **429** quando `checkRateLimit` retorna `{success:false}` (sem tocar `messages`/Meta).
  - **404** quando o SELECT de `messages` por `media_url` volta vazio (sem chamar `getMediaUrl`/`downloadMedia`).
  - **200** + binário quando há a mensagem (posse) e o download ok.
  - (Garantia anti-regressão: `getMediaUrl`/`downloadMedia` NÃO são chamados nos casos 429/404.)
- **Typecheck/lint:** `npx tsc --noEmit`, `npm run lint` (sem novos problemas), suíte completa verde.
- **Manual:** abrir conversa com imagens → carregam (200, posse ok); forjar um `mediaId` aleatório na URL → 404; recarregar muitas mídias rápido → eventualmente 429.

## Restrições

- Comentários em **português**. Nunca `git add -A`. PRs → `iv-automacao/crm-vantage`. `tsc` limpo; lint sem novos problemas (baseline 2 errors / ~24 problems pré-existentes).
- **Nenhuma migration** — `messages.media_url` já existe e guarda a proxy URL com o `mediaId`.
- Ordem: rate limit → posse → Meta (falha barata e cedo; não toca a Meta sem posse).

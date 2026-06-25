# Design — Hardening de segurança (token CAPI cifrado + guardrail de auth + rate limit distribuído)

**Data:** 2026-06-25 · **Status:** aprovado no brainstorming, aguardando review do spec

## Contexto

Um mapeamento do codebase (auditoria) levantou 3 achados de segurança, que **verifiquei no código**:

1. **Rate limiter in-process** (`src/lib/rate-limit.ts`) — `Map` em memória. Na Vercel (fan-out serverless) cada instância tem seu contador → limite efetivo = `limite × nº instâncias`. O próprio arquivo admite a limitação. **Real** sob carga/ataque (chave de API vazada spamma WhatsApp).
2. **Token do CAPI em texto plano** (`capi_settings.access_token`) — enquanto `whatsapp_config.access_token` é cifrado com AES-256-GCM. Admin-only RLS limita exposição, mas é um token de Ads com permissão ampla.
3. **Middleware não protege `/api/account|admin|v1|automations|flows|capi/*`** — só dá 401 em `/api/whatsapp/*`. **Verificado: NÃO é buraco aberto** — todas as 56 rotas se auto-protegem (`requireRole`/`getCurrentAccount`/`defineRoute`+apiKey/`x-cron-secret`). É risco de **manutenção**: uma rota futura que esquecer o gate ficaria exposta.

**Restrição mestra do dono:** *não pode quebrar nada existente.* O design prioriza zero-breakage: transição tolerante a legado no #2, mudança só-de-teste no #3, fallback local no #1.

## Decisões travadas (brainstorming)

- **Empacotamento:** **PR-A (agora)** = #2 (cifrar token CAPI) + #3 (guardrail de auth). **PR-B (depois)** = #1 (rate limit → Upstash), porque depende de provisionar Upstash + env vars. Este spec detalha PR-A; PR-B fica desenhado para execução posterior.
- **#1 backend:** Upstash Redis + `@upstash/ratelimit`. **Fail-open** (Redis fora → deixa passar + warn). **Fallback local:** sem as env vars (dev/test) → cai no `Map` atual.
- **#2:** reusar `encrypt`/`decrypt` existentes; **decrypt tolerante a legado** (token plano antigo segue funcionando, auto-cifra no próximo save). Sem migration SQL (AES não roda em SQL).
- **#3:** **não** mexer no middleware (quebraria `/api/v1` Bearer e crons `x-cron-secret`). Em vez disso, um **teste de CI** que exige auth em toda rota, com allowlist explícita de rotas públicas.

## Fatos do código (grounding)

- `src/lib/whatsapp/encryption.ts`: `encrypt(text)` → GCM `iv:ct:tag` (2 dois-pontos / 3 partes). `decrypt(text)` detecta formato: 3 partes (GCM), 2 partes (CBC legado), **senão lança** `unrecognised format`. `isLegacyFormat(text)` = 2 partes. Usa `process.env.ENCRYPTION_KEY` (hex). → Token plano (0 dois-pontos) faz `decrypt` lançar — detectável.
- `src/lib/capi/dispatch.ts`: lê `capi_settings.access_token` e passa como `accessToken` pro `sendConversionEvent`. É o **único ponto de leitura-pra-uso** do token.
- `src/app/api/account/capi/route.ts` (PUT): monta `validated.patch` via `validateCapiInput`; `access_token` só entra no patch quando enviado não-vazio; faz `upsert` em `capi_settings`. É o **único ponto de escrita** do token.
- `src/lib/capi/settings.ts` `getCapiSettingsView`: `has_access_token = Boolean(access_token)` — funciona com valor cifrado (continua truthy).
- `src/middleware.ts`: só 401 em `/api/whatsapp/*` não-webhook. Demais rotas dependem do gate no handler.
- 56 arquivos `route.ts` em `src/app/api/**`. Markers de auth usados: `requireRole`, `requireActiveAccount`, `getCurrentAccount`, `requirePlatformAdmin`, `resolveApiKey`, `defineRoute`, `AUTOMATION_CRON_SECRET` (crons).

## Arquitetura — PR-A

```
src/lib/capi/crypto.ts            # (novo) encryptCapiToken / decryptCapiToken — wrapper tolerante a legado
src/lib/capi/crypto.test.ts       # (novo) testes do wrapper
src/app/api/account/capi/route.ts # (modificar) cifra o token no PUT antes do upsert
src/lib/capi/dispatch.ts          # (modificar) decifra o token antes de enviar pra Meta
src/app/api/route-auth-guard.test.ts  # (novo) guardrail: toda rota tem auth ou está na allowlist
```

### #2 — Cifra do token CAPI

**Wrapper (`src/lib/capi/crypto.ts`)** — isola a lógica de transição num lugar testável:
```ts
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'

/** Cifra o token CAPI (AES-256-GCM). Sempre produz formato cifrado. */
export function encryptCapiToken(plaintext: string): string {
  return encrypt(plaintext)
}

/**
 * Decifra o token CAPI. Tolerante a legado: se o valor não estiver no
 * formato cifrado (token plano salvo antes deste hardening), `decrypt`
 * lança e a gente devolve o valor cru (+ warn). Auto-cifra no próximo save.
 */
export function decryptCapiToken(stored: string): string {
  try {
    return decrypt(stored)
  } catch {
    console.warn('[capi] access_token em formato legado (texto plano) — re-salve a config para cifrar')
    return stored
  }
}
```

**Escrita (`route.ts` PUT):** depois do `validateCapiInput`, se `validated.patch.access_token` existir (token novo enviado), substituir por `encryptCapiToken(validated.patch.access_token)` antes do `upsert`. (Onde não há token novo, o patch não toca a coluna — o valor cifrado salvo permanece.)

**Leitura (`dispatch.ts`):** ao montar o `sendConversionEvent`, trocar `accessToken: settings.access_token` por `accessToken: decryptCapiToken(settings.access_token)`.

**`getCapiSettingsView`:** sem mudança (`has_access_token` = truthy serve cifrado).

**Linhas existentes:** zero migration. O `decryptCapiToken` tolera o token plano atual; ele é auto-cifrado quando o admin re-salva a config (ou em qualquer PUT futuro). Zero-breakage.

> **Não-objetivo:** cifrar `webhook_endpoints.secret` (fora de escopo; decisão anterior de mantê-lo plano, admin-only RLS).

### #3 — Guardrail de auth (`src/app/api/route-auth-guard.test.ts`)

Teste vitest que:
1. Glob de todos os `src/app/api/**/route.ts` (via `import.meta.glob` ou `fs.readdirSync` recursivo a partir de `src/app/api`).
2. Pra cada arquivo, lê o conteúdo e checa se contém **algum** marker de auth:
   `requireRole`, `requireActiveAccount`, `getCurrentAccount`, `requirePlatformAdmin`, `resolveApiKey`, `defineRoute`, `AUTOMATION_CRON_SECRET`.
3. Se não contém nenhum marker, o arquivo precisa estar na **`PUBLIC_ROUTES` allowlist** (caminhos relativos, cada um com comentário justificando):
   - `whatsapp/webhook/route.ts` — webhook da Meta, verificado por HMAC/verify_token internamente
   - `openapi.json/route.ts` — spec OpenAPI pública
   - `external/whatsapp/send/route.ts` — alias `export { POST } from '@/app/api/v1/messages/send/route'` (a rota destino é autenticada)
   - `invitations/[token]/peek/route.ts` — público por design (token + rate limit por IP)
   - (a allowlist final é fechada na implementação rodando o teste: cada rota que cair fora dos markers é justificada como pública ou ganha gate; o teste deve passar verde refletindo o estado atual)
4. Falha com mensagem clara listando o(s) arquivo(s) sem auth nem allowlist.

Efeito: rota futura sem proteção **quebra o CI**. Zero runtime, zero breakage.

> Nota: `src/app/docs/route.ts` é página pública (Scalar), fora de `src/app/api/**` — não entra no glob. Se o glob for ampliado, incluir na allowlist.

## Arquitetura — PR-B (#1, deferido; executar quando Upstash provisionado)

```
src/lib/rate-limit.ts             # checkRateLimit vira async; usa @upstash/ratelimit quando env presente, senão Map local
```
- Deps: `@upstash/ratelimit` + `@upstash/redis`.
- Env: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`. **Ausentes → Map em memória** (dev/test/local sem Redis).
- `checkRateLimit(key, opts)` → `Promise<RateLimitResult>` (mesma shape). **Fail-open:** erro/timeout do Upstash → `{ success: true }` + warn.
- Todos os call sites ganham `await` (já são handlers async): `whatsapp/send`, `whatsapp/react`, `whatsapp/broadcast`, `v1/messages/send`, `v1/broadcasts`, `account/*` (adminAction), `invitations/peek`, etc.
- Spec/plano próprios no PR-B.

## Erros / segurança
- `ENCRYPTION_KEY` é pré-requisito (já usado pelo WhatsApp). Se ausente, `encrypt` lança — mas a env já é obrigatória no projeto.
- Token nunca em log (o `decryptCapiToken` loga só um aviso genérico, nunca o valor).
- Guardrail é só teste — não altera comportamento de runtime.

## Verificação (E2E) — PR-A
1. `typecheck` limpo, `npm test` verde, `build` exit 0.
2. **#2 escrita:** salvar config CAPI no painel → no banco, `access_token` está no formato `iv:ct:tag` (cifrado), não em claro.
3. **#2 leitura:** cron processa um `capi_events` pending → `sendConversionEvent` recebe o token **decifrado** (envio funciona igual a antes).
4. **#2 legado:** linha com token plano (pré-hardening) → cron ainda envia (decrypt tolerante), com warn; re-salvar no painel passa a gravar cifrado.
5. **#2 has_access_token:** GET `/api/account/capi` segue devolvendo `has_access_token: true` com token cifrado; nunca devolve o token.
6. **#3:** o teste passa verde no estado atual (todas as 56 rotas têm auth ou estão na allowlist). Introduzir uma rota dummy sem auth → o teste **falha** apontando o arquivo. (Remover a dummy.)
7. **Não-regressão:** envio de mensagem, broadcast, e o fluxo CAPI completo seguem funcionando.

## Pós-implementação
- Atualizar memória (`crm-vantage-capi` e/ou nova nota de hardening): token CAPI cifrado em repouso; guardrail de auth no CI; e o ponteiro do PR-B (rate limit Upstash, fail-open, decisão travada).

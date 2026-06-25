# Design — Rate limit distribuído (Upstash Redis), PR-B do hardening

**Data:** 2026-06-25 · **Status:** design travado no brainstorming (hardening), aguardando review do spec

## Contexto

`src/lib/rate-limit.ts` é um contador de janela fixa **em memória** (`Map`). Na Vercel (fan-out serverless) cada instância tem o próprio `Map` → o limite efetivo vira `limite × nº de instâncias`, e sob carga/ataque não segura nada (o próprio arquivo admite). É o achado de segurança mais sério da auditoria. Este PR-B troca o backend por **Upstash Redis** (distribuído), mantendo a mesma superfície de chamada — só que **async**.

PR-A (cifrar token CAPI + guardrail de auth) é independente e já está em PR #15.

## Decisões travadas (brainstorming)

- **Backend:** Upstash Redis + `@upstash/ratelimit` (lib oficial, janela pronta). Env: `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (já provisionadas na Vercel e no `.env.local`).
- **Fail-open:** se o Upstash falhar/timeout → **deixa passar** + `console.warn`. O rate limit é proteção, não caminho crítico; um soluço do Redis não pode derrubar envios legítimos.
- **Fallback local:** sem as env vars (dev/test/CI) → cai no `Map` em memória atual. Local e CI não precisam de Redis.
- **`checkRateLimit` vira `async`** (`Promise<RateLimitResult>`), mesma shape de retorno. Todos os call sites ganham `await`.

## Fatos do código (grounding)

- `src/lib/rate-limit.ts`: `checkRateLimit(key, { limit, windowMs }): RateLimitResult` (sync, Map). `rateLimitResponse(result)` monta o 429. `RATE_LIMITS` = ~14 presets `{ limit, windowMs }` (todos `windowMs: 60_000`).
- **Call sites (~21)** acessam `.success`/`.remaining` no retorno → tornar `checkRateLimit` async faz o **`tsc` apontar todo site sem `await`** (Promise não tem `.success`). `tsc --noEmit` limpo = garantia de que nenhum site ficou sem `await` (rate limit nunca silenciosamente desligado). Sites: 15 rotas `src/app/api/account|admin/**`, `whatsapp/send|react|broadcast`, `invitations/[token]/peek|redeem`, e **`src/lib/api/handler.ts`** (o `defineRoute`, cobre todas as `/api/v1`).
- `rateLimitResponse` continua **sync** (recebe o `RateLimitResult` já resolvido) — não muda.
- Deps `@upstash/ratelimit` e `@upstash/redis` **não instaladas** ainda.

## Arquitetura

```
src/lib/rate-limit.ts        # (reescrever) checkRateLimit async: Upstash quando env presente, senão Map; fail-open
src/lib/rate-limit.test.ts   # (atualizar) await + casos novos (fallback local, fail-open, Upstash mockado)
<~21 arquivos de rota> + src/lib/api/handler.ts   # (modificar) await checkRateLimit(...)
.env.local.example           # (se existir) documentar UPSTASH_REDIS_REST_URL/TOKEN
package.json                 # +@upstash/ratelimit +@upstash/redis
```

### `checkRateLimit` (async, `src/lib/rate-limit.ts`)
```ts
export async function checkRateLimit(
  key: string,
  opts: RateLimitOptions,
): Promise<RateLimitResult>
```
Lógica:
1. **Sem Upstash** (`!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN`) → usa a lógica atual do `Map` (extraída pra um helper sync `checkRateLimitLocal`) e devolve resolvido. Mantém o sweep oportunista.
2. **Com Upstash** → resolve um `Ratelimit` cacheado por `${limit}:${windowMs}` (`Ratelimit.fixedWindow(limit, \`${windowMs} ms\`)`, `prefix: 'vtg-rl'`, `analytics: false`), chama `await rl.limit(key)`, mapeia `{ success, remaining, reset, limit }` pro `RateLimitResult` (`reset` do Upstash é unix ms).
3. **Fail-open:** todo o caminho Upstash dentro de `try/catch` — erro/timeout → `console.warn('[rate-limit] Upstash indisponível, fail-open')` (sem vazar key sensível) e retorna `{ success: true, remaining: limit - 1, reset: Date.now() + windowMs, limit }`.

Cliente Redis e cache de instâncias criados uma vez no módulo (lazy), só quando as env vars existem.

### Call sites
Adicionar `await` em cada `checkRateLimit(...)`. Todos já estão dentro de handlers `async`. O `handler.ts` (defineRoute) também. `tsc --noEmit` valida exaustivamente.

### Testes (`rate-limit.test.ts`)
- Os testes atuais (janela, isolamento por key, refill) rodam no **caminho local** (sem env Upstash no ambiente de teste) — adicionar `await`.
- Novos: (a) fail-open quando o `Ratelimit.limit` lança (mockar `@upstash/ratelimit` pra throw, com env vars stubadas) → `success: true` + warn; (b) caminho Upstash feliz (mock retornando `{success:false,...}`) → mapeia certo.

## Erros / segurança
- Fail-open é intencional (documentado). Logs nunca incluem a `key` crua se ela tiver dado sensível (usar mensagem genérica).
- Sem mudança de contrato HTTP (429 igual). Sem migration.

## Verificação (E2E)
1. `npm install` das 2 deps; `tsc --noEmit` **limpo** (prova que todos os call sites têm `await`); `grep -rn 'checkRateLimit(' src | grep -v await | grep -v 'export async' | grep -v '.test.'` retorna vazio (rede dupla); `npm test` verde; `build` exit 0.
2. **Local (sem env Upstash):** rate limit funciona pelo Map (testes atuais passam).
3. **Com Upstash (prod/preview):** chamadas repetidas além do limite retornam 429; o contador é **compartilhado entre instâncias** (não reseta por instância).
4. **Fail-open:** simular Upstash fora (env apontando errado) → requests passam (não 429 nem 500), com warn nos logs.
5. **Não-regressão:** envio de mensagem, broadcast, ações admin e `/api/v1` seguem funcionando.

## Pós-implementação
- Atualizar memória (nota de hardening): rate limit agora distribuído (Upstash, fail-open, fallback local), fechando o achado #1. Registrar as env vars novas.

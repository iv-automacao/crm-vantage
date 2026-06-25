# Rate Limit Distribuído (Upstash) — Implementation Plan (PR-B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trocar o rate limiter em memória (derrotado pelo fan-out serverless da Vercel) por um distribuído via Upstash Redis, com fail-open e fallback local, mantendo a mesma superfície de chamada (agora async).

**Architecture:** `checkRateLimit` vira `async`: usa `@upstash/ratelimit` quando as env vars do Upstash existem, senão cai no `Map` em memória atual; falha do Redis → fail-open (deixa passar + warn). Todos os call sites ganham `await` (o `tsc` valida que nenhum ficou de fora).

**Tech Stack:** Next.js 16, TypeScript, `@upstash/ratelimit` + `@upstash/redis`, vitest 4.

## Global Constraints

- **Não pode quebrar nada.** Sem env Upstash (dev/test/CI) → comportamento idêntico ao atual (Map em memória). Fail-open: erro do Upstash nunca vira 500 nem 429 indevido.
- `checkRateLimit(key, opts): Promise<RateLimitResult>` — MESMA shape de retorno (`{ success, remaining, reset, limit }`). `rateLimitResponse` continua **sync**, inalterado.
- Env vars: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (já provisionadas). Ausentes → fallback local.
- Comentários em **português**.
- NUNCA `git add -A` (untracked: `docs/embedded-signup-plan.md`, `supabase/.temp/`). Adicionar arquivos explícitos.
- `tsc --noEmit` limpo é critério de aceite (prova que todo call site tem `await`).
- Fail-open log genérico — nunca vazar a `key` em log.

---

### Task 1: Reescrever `rate-limit.ts` (async, Upstash + fallback + fail-open)

**Files:**
- Modify: `src/lib/rate-limit.ts`
- Modify: `src/lib/rate-limit.test.ts`
- Modify: `package.json` (+`@upstash/ratelimit`, +`@upstash/redis`)

**Interfaces:**
- Consumes: nada novo do projeto.
- Produces: `checkRateLimit(key: string, opts: RateLimitOptions): Promise<RateLimitResult>` (async). `RateLimitOptions`/`RateLimitResult`/`rateLimitResponse`/`RATE_LIMITS` inalterados na forma.

- [ ] **Step 1: Instalar as deps**

```bash
npm install @upstash/ratelimit@^2 @upstash/redis@^1 --save
```

Confirmar que `package.json` (e `package-lock.json`) registraram as duas.

- [ ] **Step 2: Escrever os testes que falham**

Substituir o conteúdo de `src/lib/rate-limit.test.ts` por (mantém os casos atuais com `await`, adiciona fallback-local explícito, fail-open e caminho Upstash mockado):

```ts
// src/lib/rate-limit.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const OPTS = { limit: 3, windowMs: 1000 }

// Mock do @upstash/ratelimit. `limitImpl` é trocado por teste.
let limitImpl: (id: string) => Promise<unknown> = async () => ({
  success: true, limit: 3, remaining: 2, reset: Date.now() + 1000,
})
vi.mock('@upstash/ratelimit', () => ({
  Ratelimit: class {
    static fixedWindow() { return {} }
    limit(id: string) { return limitImpl(id) }
  },
}))
vi.mock('@upstash/redis', () => ({ Redis: class {} }))

async function freshModule() {
  vi.resetModules()
  return await import('./rate-limit')
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('checkRateLimit — fallback local (sem env Upstash)', () => {
  beforeEach(() => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '')
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '')
  })

  it('permite dentro do limite e bloqueia ao estourar', async () => {
    const { checkRateLimit } = await freshModule()
    expect((await checkRateLimit('user:1', OPTS)).success).toBe(true)
    expect((await checkRateLimit('user:1', OPTS)).success).toBe(true)
    expect((await checkRateLimit('user:1', OPTS)).success).toBe(true)
    expect((await checkRateLimit('user:1', OPTS)).success).toBe(false)
  })

  it('isola buckets por key', async () => {
    const { checkRateLimit } = await freshModule()
    await checkRateLimit('user:1', OPTS)
    await checkRateLimit('user:1', OPTS)
    await checkRateLimit('user:1', OPTS)
    expect((await checkRateLimit('user:2', OPTS)).success).toBe(true)
  })
})

describe('checkRateLimit — Upstash (com env)', () => {
  beforeEach(() => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://x.upstash.io')
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'tok')
  })

  it('mapeia a resposta do Upstash pro RateLimitResult', async () => {
    const reset = Date.now() + 5000
    limitImpl = async () => ({ success: false, limit: 3, remaining: 0, reset })
    const { checkRateLimit } = await freshModule()
    const r = await checkRateLimit('user:1', OPTS)
    expect(r).toEqual({ success: false, remaining: 0, reset, limit: 3 })
  })

  it('fail-open quando o Upstash lança', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    limitImpl = async () => { throw new Error('rede caiu') }
    const { checkRateLimit } = await freshModule()
    const r = await checkRateLimit('user:1', OPTS)
    expect(r.success).toBe(true) // deixou passar
    expect(warn).toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Rodar o teste e ver falhar**

Run: `npx vitest run src/lib/rate-limit.test.ts`
Expected: FAIL (a função ainda é sync / não tem os caminhos novos).

- [ ] **Step 4: Reescrever `src/lib/rate-limit.ts`**

Manter o cabeçalho/JSDoc atualizado, `RateLimitOptions`, `RateLimitResult`, `rateLimitResponse` e `RATE_LIMITS` exatamente como estão (só o `checkRateLimit` muda + helpers internos). Substituir o núcleo:

```ts
import { NextResponse } from 'next/server';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

export interface RateLimitOptions { limit: number; windowMs: number; }
export interface RateLimitResult {
  success: boolean; remaining: number; reset: number; limit: number;
}

// ───────────── Fallback local (Map em memória) ─────────────
// Usado quando o Upstash não está configurado (dev/test/CI). Em produção
// na Vercel, o Map é por-instância e NÃO segura sob fan-out — por isso o
// Upstash. Mantido como fallback que nunca derruba o app.
interface Entry { count: number; resetAt: number; }
const buckets = new Map<string, Entry>();
const LIGHT_SWEEP_EVERY = 1000;
let callsSinceSweep = 0;
function sweepExpired(now: number) {
  for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
}
function checkRateLimitLocal(key: string, { limit, windowMs }: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  if (++callsSinceSweep >= LIGHT_SWEEP_EVERY) { callsSinceSweep = 0; sweepExpired(now); }
  const entry = buckets.get(key);
  if (!entry || entry.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { success: true, remaining: limit - 1, reset: now + windowMs, limit };
  }
  if (entry.count >= limit) return { success: false, remaining: 0, reset: entry.resetAt, limit };
  entry.count += 1;
  return { success: true, remaining: limit - entry.count, reset: entry.resetAt, limit };
}

// ───────────── Backend Upstash (distribuído) ─────────────
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const upstashEnabled = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

let redis: Redis | null = null;
const limiterCache = new Map<string, Ratelimit>();
function getLimiter(opts: RateLimitOptions): Ratelimit {
  if (!redis) redis = new Redis({ url: UPSTASH_URL!, token: UPSTASH_TOKEN! });
  const cacheKey = `${opts.limit}:${opts.windowMs}`;
  let rl = limiterCache.get(cacheKey);
  if (!rl) {
    rl = new Ratelimit({
      redis,
      limiter: Ratelimit.fixedWindow(opts.limit, `${opts.windowMs} ms`),
      prefix: 'vtg-rl',
      analytics: false,
    });
    limiterCache.set(cacheKey, rl);
  }
  return rl;
}

/**
 * Verifica e consome 1 do orçamento de `key`. Distribuído via Upstash quando
 * configurado; senão, Map local. Fail-open: qualquer erro do Upstash deixa
 * passar (warn) — o rate limit é proteção, não pode derrubar tráfego legítimo.
 */
export async function checkRateLimit(
  key: string,
  opts: RateLimitOptions,
): Promise<RateLimitResult> {
  if (!upstashEnabled) return checkRateLimitLocal(key, opts);
  try {
    const r = await getLimiter(opts).limit(key);
    return { success: r.success, remaining: r.remaining, reset: r.reset, limit: r.limit };
  } catch {
    console.warn('[rate-limit] Upstash indisponível — fail-open');
    return { success: true, remaining: opts.limit - 1, reset: Date.now() + opts.windowMs, limit: opts.limit };
  }
}
```

Manter `rateLimitResponse` e `RATE_LIMITS` exatamente como já estão no arquivo (não reescrever — preservar).

- [ ] **Step 5: Rodar o teste e ver passar**

Run: `npx vitest run src/lib/rate-limit.test.ts`
Expected: PASS (todos os describes).

- [ ] **Step 6: Commit**

```bash
git add src/lib/rate-limit.ts src/lib/rate-limit.test.ts package.json package-lock.json
git commit -m "feat(rate-limit): backend Upstash distribuído (async) com fallback local e fail-open"
```

> **Nota:** após esta task o `tsc` ainda NÃO está limpo (call sites sem `await`). Isso é resolvido na Task 2. Os testes desta task passam isolados.

---

### Task 2: Propagar `await` para todos os call sites

**Files (modify — adicionar `await` em cada `checkRateLimit(`):**
- `src/lib/api/handler.ts` (defineRoute — cobre todas as `/api/v1`)
- `src/app/api/whatsapp/send/route.ts`, `whatsapp/react/route.ts`, `whatsapp/broadcast/route.ts`
- `src/app/api/invitations/[token]/peek/route.ts`, `invitations/[token]/redeem/route.ts`
- `src/app/api/account/route.ts`, `account/capi/route.ts`, `account/api-keys/route.ts`, `account/api-keys/[keyId]/route.ts`, `account/transfer-ownership/route.ts`, `account/members/[userId]/route.ts` (2 usos), `account/webhooks/route.ts`, `account/webhooks/[id]/route.ts` (2 usos), `account/invitations/route.ts`, `account/invitations/[id]/route.ts`
- `src/app/api/admin/accounts/[accountId]/route.ts`, `admin/accounts/[accountId]/approve|reject|suspend|reactivate/route.ts`

**Interfaces:**
- Consumes: `checkRateLimit(...) → Promise<RateLimitResult>` (Task 1).
- Produces: nada novo.

- [ ] **Step 1: Achar todos os call sites sem `await`**

Run: `grep -rn "checkRateLimit(" src --include="*.ts" | grep -v "await checkRateLimit" | grep -v "export async function" | grep -v ".test.ts"`
Expected: lista de ~21 linhas (todas `= checkRateLimit(` ou `const r = checkRateLimit(`).

- [ ] **Step 2: Adicionar `await` em cada call site**

Em cada arquivo da lista, trocar a chamada para `await`. Padrões exatos a aplicar:
- `const limit = checkRateLimit(` → `const limit = await checkRateLimit(`
- `const rl = checkRateLimit(` → `const rl = await checkRateLimit(`
- `const r = checkRateLimit(` → `const r = await checkRateLimit(` (em `handler.ts`)

Todos já estão dentro de funções `async` (handlers de rota / o pipeline do `defineRoute`), então o `await` é válido. NÃO mudar mais nada nesses arquivos.

- [ ] **Step 3: Provar que nenhum call site ficou sem `await` (dupla checagem)**

Run: `npx tsc --noEmit`
Expected: **limpo (exit 0)**. Se algum site ficou sem `await`, o TS acusa erro tipo `Property 'success' does not exist on type 'Promise<RateLimitResult>'` apontando o arquivo:linha — corrigir e repetir.

Run: `grep -rn "checkRateLimit(" src --include="*.ts" | grep -v "await checkRateLimit" | grep -v "export async function" | grep -v ".test.ts"`
Expected: **vazio**.

- [ ] **Step 4: Suíte + build (não-regressão)**

Run: `npx vitest run && npx tsc --noEmit`
Expected: testes verdes (incl. rate-limit) e typecheck limpo. (Falhas pré-existentes em `src/lib/dashboard/date-utils.test.ts` por timezone NÃO são desta mudança — ignorar se aparecerem.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/api/handler.ts "src/app/api/whatsapp/send/route.ts" "src/app/api/whatsapp/react/route.ts" "src/app/api/whatsapp/broadcast/route.ts" "src/app/api/invitations/[token]/peek/route.ts" "src/app/api/invitations/[token]/redeem/route.ts" "src/app/api/account/route.ts" "src/app/api/account/capi/route.ts" "src/app/api/account/api-keys/route.ts" "src/app/api/account/api-keys/[keyId]/route.ts" "src/app/api/account/transfer-ownership/route.ts" "src/app/api/account/members/[userId]/route.ts" "src/app/api/account/webhooks/route.ts" "src/app/api/account/webhooks/[id]/route.ts" "src/app/api/account/invitations/route.ts" "src/app/api/account/invitations/[id]/route.ts" "src/app/api/admin/accounts/[accountId]/route.ts" "src/app/api/admin/accounts/[accountId]/approve/route.ts" "src/app/api/admin/accounts/[accountId]/reject/route.ts" "src/app/api/admin/accounts/[accountId]/suspend/route.ts" "src/app/api/admin/accounts/[accountId]/reactivate/route.ts"
git commit -m "refactor(rate-limit): await em todos os call sites (defineRoute + rotas) p/ o checkRateLimit async"
```

---

## Verificação final (E2E — após as 2 tasks)

1. `npx tsc --noEmit` **limpo**; `grep` de call sites sem `await` **vazio**; `npx vitest run src/lib/rate-limit.test.ts` verde; `npm run build` exit 0.
2. **Local (sem env):** rate limit via Map, testes atuais passam.
3. **Upstash (prod/preview):** estouro do limite → 429; contador compartilhado entre instâncias.
4. **Fail-open:** Upstash inacessível → requests passam (warn), sem 500/429 indevido.
5. **Não-regressão:** mensagem, broadcast, ações admin, `/api/v1` seguem funcionando.

## Pós-implementação
- Atualizar memória (hardening): rate limit distribuído via Upstash (fail-open, fallback local) fecha o achado #1; env vars `UPSTASH_REDIS_REST_URL`/`TOKEN` registradas.

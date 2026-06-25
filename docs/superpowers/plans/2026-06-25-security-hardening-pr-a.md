# Hardening PR-A Implementation Plan (token CAPI cifrado + guardrail de auth)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cifrar o `access_token` do CAPI em repouso (AES-256-GCM, transição tolerante a legado) e adicionar um teste de CI que garante que toda rota de API tem autenticação.

**Architecture:** Um wrapper de cripto reusa o `encrypt`/`decrypt` do WhatsApp; o PUT do CAPI cifra ao salvar e o dispatch decifra ao usar (com fallback para token plano legado). Um teste vitest varre `src/app/api/**/route.ts` e exige um marker de auth ou allowlist pública.

**Tech Stack:** Next.js 16, TypeScript, Supabase, vitest 4, Node `crypto` (AES-256-GCM via `ENCRYPTION_KEY`).

## Global Constraints

- **Não pode quebrar nada existente.** Token plano legado deve continuar funcionando (decrypt tolerante); o guardrail é só teste (zero runtime).
- Reusar `encrypt`/`decrypt` de `src/lib/whatsapp/encryption.ts` — NÃO reimplementar cripto.
- `access_token` nunca em log (nem cifrado nem plano). O aviso de legado é genérico, sem o valor.
- Comentários de código em **português**.
- NUNCA `git add -A` (untracked: `docs/embedded-signup-plan.md`, `supabase/.temp/`). Adicionar arquivos explícitos.
- `ENCRYPTION_KEY` (hex) já é env obrigatória do projeto — não criar nova env.
- Sem migration de banco (AES não roda em SQL; transição é em código).

---

### Task 1: Cifrar o token CAPI em repouso

**Files:**
- Create: `src/lib/capi/crypto.ts`
- Test: `src/lib/capi/crypto.test.ts`
- Modify: `src/app/api/account/capi/route.ts` (cifra no PUT antes do upsert)
- Modify: `src/lib/capi/dispatch.ts` (decifra antes de enviar pra Meta)

**Interfaces:**
- Consumes: `encrypt(text: string): string`, `decrypt(text: string): string` de `@/lib/whatsapp/encryption`.
- Produces:
  - `encryptCapiToken(plaintext: string): string`
  - `decryptCapiToken(stored: string): string`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/lib/capi/crypto.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encryptCapiToken, decryptCapiToken } from './crypto'

afterEach(() => vi.restoreAllMocks())

describe('crypto do token CAPI', () => {
  it('round-trip: decryptCapiToken(encryptCapiToken(x)) === x', () => {
    const token = 'EAAGtoken_secreto_123'
    const cifrado = encryptCapiToken(token)
    expect(cifrado).not.toContain(token) // não vaza o plano
    expect(cifrado.split(':').length).toBe(3) // formato GCM iv:ct:tag
    expect(decryptCapiToken(cifrado)).toBe(token)
  })

  it('tolerante a legado: token plano (sem formato cifrado) volta cru', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const plano = 'EAAGtoken_plano_legado'
    expect(decryptCapiToken(plano)).toBe(plano)
    expect(warn).toHaveBeenCalled()
  })

  it('o aviso de legado nunca inclui o valor do token', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const plano = 'EAAGtoken_super_secreto'
    decryptCapiToken(plano)
    const loggedArgs = warn.mock.calls.flat().join(' ')
    expect(loggedArgs).not.toContain(plano)
  })
})
```

- [ ] **Step 2: Rodar o teste e ver falhar**

Run: `npx vitest run src/lib/capi/crypto.test.ts`
Expected: FAIL — `Cannot find module './crypto'`.

- [ ] **Step 3: Implementar o wrapper**

```ts
// src/lib/capi/crypto.ts
// Cifra/decifra o access_token do CAPI em repouso, reusando o AES-256-GCM
// do WhatsApp. A leitura é tolerante a legado: tokens salvos em texto plano
// (antes deste hardening) continuam funcionando e são cifrados no próximo save.
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'

/** Cifra o token CAPI (AES-256-GCM). Sempre produz formato cifrado. */
export function encryptCapiToken(plaintext: string): string {
  return encrypt(plaintext)
}

/**
 * Decifra o token CAPI. Se o valor não estiver no formato cifrado (token
 * plano legado), `decrypt` lança e devolvemos o valor cru + um aviso
 * genérico (nunca logando o token). O re-save no painel passa a cifrar.
 */
export function decryptCapiToken(stored: string): string {
  try {
    return decrypt(stored)
  } catch {
    console.warn(
      '[capi] access_token em formato legado (texto plano) — re-salve a config do CAPI para cifrar em repouso',
    )
    return stored
  }
}
```

- [ ] **Step 4: Rodar o teste e ver passar**

Run: `npx vitest run src/lib/capi/crypto.test.ts`
Expected: PASS (3 testes).

- [ ] **Step 5: Cifrar no PUT da rota de config**

Em `src/app/api/account/capi/route.ts`, adicionar o import junto aos outros:

```ts
import { encryptCapiToken } from '@/lib/capi/crypto'
```

Localizar, dentro do `PUT`, o ponto logo após o `if (!validated.ok) { ... return 422 }` e ANTES do `await ctx.supabase.from('capi_settings').upsert(...)`. Inserir:

```ts
    // Cifra o token em repouso quando um token novo foi enviado. Sem token
    // novo, o patch não toca a coluna e o valor cifrado salvo é preservado.
    if (typeof validated.patch.access_token === 'string') {
      validated.patch.access_token = encryptCapiToken(validated.patch.access_token)
    }
```

- [ ] **Step 6: Decifrar no dispatch**

Em `src/lib/capi/dispatch.ts`, adicionar o import:

```ts
import { decryptCapiToken } from './crypto'
```

Localizar a chamada `sendConversionEvent({ ... })` dentro do loop e trocar a linha do `accessToken`:

```ts
      accessToken: decryptCapiToken(settings.access_token as string),
```

(de `accessToken: settings.access_token as string,`)

- [ ] **Step 7: Typecheck + suíte do CAPI (não-regressão)**

Run: `npx tsc --noEmit && npx vitest run src/lib/capi/`
Expected: typecheck limpo; todos os testes do CAPI (client, referral, dispatch, settings, crypto) PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/capi/crypto.ts src/lib/capi/crypto.test.ts src/app/api/account/capi/route.ts src/lib/capi/dispatch.ts
git commit -m "feat(hardening): cifra o access_token do CAPI em repouso (AES-256-GCM, tolerante a legado)"
```

---

### Task 2: Guardrail de auth nas rotas de API (teste de CI)

**Files:**
- Create: `src/app/api/route-auth-guard.test.ts`

**Interfaces:**
- Consumes: nada (lê arquivos do disco).
- Produces: nada (teste).

- [ ] **Step 1: Escrever o teste (já é o "código" — falha se houver rota sem auth)**

```ts
// src/app/api/route-auth-guard.test.ts
// Guardrail de defesa-em-profundidade: toda rota de API precisa ter um
// mecanismo de autenticação OU estar na allowlist explícita de rotas
// públicas. O middleware NÃO protege /api/account|admin|v1|... — cada
// handler se protege. Este teste garante que nenhuma rota futura esqueça.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const API_DIR = join(process.cwd(), 'src/app/api')

// Markers de auth aceitos (qualquer um presente no arquivo basta).
const AUTH_MARKERS = [
  'requireRole',
  'requireActiveAccount',
  'getCurrentAccount',
  'requirePlatformAdmin',
  'resolveApiKey',
  'defineRoute',
  'AUTOMATION_CRON_SECRET', // crons: auth via header x-cron-secret
]

// Rotas públicas POR DESIGN — cada entrada justificada. Caminhos relativos
// a src/app/api, com barras normais.
const PUBLIC_ROUTES = new Set<string>([
  'whatsapp/webhook/route.ts',          // webhook da Meta; verificado por HMAC/verify_token internamente
  'openapi.json/route.ts',              // spec OpenAPI pública
  'external/whatsapp/send/route.ts',    // alias `export { POST } from` da rota v1 (autenticada lá)
  'invitations/[token]/peek/route.ts',  // público por design: token + rate limit por IP
  'invitations/[token]/redeem/route.ts',// público por design: aceitação de convite por token
])

function findRouteFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...findRouteFiles(full))
    else if (entry.name === 'route.ts') out.push(full)
  }
  return out
}

describe('guardrail de auth das rotas de API', () => {
  const routeFiles = findRouteFiles(API_DIR)

  it('encontra um conjunto não-trivial de rotas (sanidade do glob)', () => {
    expect(routeFiles.length).toBeGreaterThan(20)
  })

  it('toda rota tem um marker de auth ou está na allowlist pública', () => {
    const offenders: string[] = []
    for (const file of routeFiles) {
      const rel = relative(API_DIR, file).split('\\').join('/')
      const src = readFileSync(file, 'utf8')
      const hasAuth = AUTH_MARKERS.some((m) => src.includes(m))
      if (!hasAuth && !PUBLIC_ROUTES.has(rel)) offenders.push(rel)
    }
    expect(
      offenders,
      `Rotas sem auth nem allowlist:\n${offenders.join('\n')}\n` +
        'Adicione um gate (requireRole/getCurrentAccount/defineRoute/...) ou, ' +
        'se for pública por design, registre em PUBLIC_ROUTES com justificativa.',
    ).toEqual([])
  })

  it('a allowlist não tem entradas mortas (toda pública existe e segue sem auth)', () => {
    const relSet = new Set(
      routeFiles.map((f) => relative(API_DIR, f).split('\\').join('/')),
    )
    for (const pub of PUBLIC_ROUTES) {
      expect(relSet.has(pub), `Allowlist aponta para rota inexistente: ${pub}`).toBe(true)
    }
  })
})
```

- [ ] **Step 2: Rodar o teste e ver passar (estado atual já é compatível)**

Run: `npx vitest run src/app/api/route-auth-guard.test.ts`
Expected: PASS. Se FALHAR listando alguma rota, investigar: a rota usa auth por um caminho não coberto pelos markers (adicionar o marker à lista com cuidado) OU é pública por design (adicionar a `PUBLIC_ROUTES` com comentário justificando) OU é um buraco real (adicionar gate na rota — fora deste plano; reportar).

- [ ] **Step 3: Provar que o guardrail pega uma rota sem auth (teste manual temporário)**

Criar temporariamente `src/app/api/__dummy_unsafe/route.ts` com:

```ts
import { NextResponse } from 'next/server'
export async function GET() {
  return NextResponse.json({ ok: true })
}
```

Run: `npx vitest run src/app/api/route-auth-guard.test.ts`
Expected: FAIL apontando `__dummy_unsafe/route.ts` na lista de offenders.

Depois **remover** o arquivo dummy:

```bash
rm -rf src/app/api/__dummy_unsafe
```

Run: `npx vitest run src/app/api/route-auth-guard.test.ts`
Expected: PASS de novo.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/route-auth-guard.test.ts
git commit -m "test(hardening): guardrail de CI exige auth em toda rota de API (allowlist explícita de públicas)"
```

---

## Verificação final (E2E — após as 2 tasks)

1. `npx tsc --noEmit` limpo; `npx vitest run src/lib/capi/ src/app/api/route-auth-guard.test.ts` verde; `npm run build` exit 0.
2. **#2 escrita:** salvar config CAPI no painel → `access_token` no banco no formato `iv:ct:tag` (cifrado), nunca em claro.
3. **#2 leitura:** cron processa pending → `sendConversionEvent` recebe token decifrado (envio igual a antes).
4. **#2 legado:** token plano pré-existente ainda envia (decrypt tolerante + warn); re-salvar passa a cifrar.
5. **#2 view:** GET `/api/account/capi` segue com `has_access_token: true`, nunca devolve o token.
6. **#3:** guardrail verde no estado atual; rota dummy sem auth quebra o teste (provado e removido).
7. **Não-regressão:** fluxo CAPI completo + suíte geral seguem funcionando.

## Pós-implementação

- Atualizar memória `crm-vantage-capi` (token CAPI agora cifrado em repouso) e registrar o guardrail de auth no CI + o ponteiro do PR-B (rate limit Upstash, fail-open, decisão travada — executar quando o Upstash for provisionado).

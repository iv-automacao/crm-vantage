# `whatsapp/media/[mediaId]` — posse + rate limit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Antes de servir o binário de uma mídia, confirmar que ela pertence a uma mensagem da conta (404 se não) e aplicar rate limit por usuário (429).

**Architecture:** No GET de `whatsapp/media/[mediaId]`, após `requireActiveAccount()`: rate limit por usuário (preset novo) → checagem de posse via `ctx.supabase` (SELECT em `messages` por `media_url`, RLS escopa por conta) → só então toca a Meta. Sem migration.

**Tech Stack:** Next.js (App Router) + Supabase (client de sessão/RLS) + Vitest.

**Spec:** `docs/superpowers/specs/2026-06-30-media-ownership-ratelimit-design.md`
**Auditoria:** `docs/auditoria/2026-06-28-conflitos-webhooks-apis.md` (item #8).

## Global Constraints

- Comentários de código em **português**.
- Nunca `git add -A` — caminhos explícitos.
- `npx tsc --noEmit` limpo; `npm run lint` sem novos problemas nos arquivos tocados (baseline 2 errors / ~24 problems pré-existentes).
- **Nenhuma migration** — `messages.media_url` já guarda `/api/whatsapp/media/{mediaId}`.
- Posse a nível de **conta** (não por-agente — follow-up, igual #21). Rate limit por **usuário**. `requireActiveAccount` mantido (qualquer membro ativo).
- Ordem: rate limit → posse → Meta (falha barata; não toca a Meta sem posse).

---

### Task 1: posse + rate limit no GET de mídia

**Files:**
- Modify: `src/lib/rate-limit.ts` (+preset `media`)
- Modify: `src/app/api/whatsapp/media/[mediaId]/route.ts` (rate limit + posse)
- Test: `src/app/api/whatsapp/media/[mediaId]/route.test.ts` (novo)

**Interfaces:**
- Consumes: `requireActiveAccount`/`toErrorResponse` (`@/lib/auth/account`), `checkRateLimit`/`rateLimitResponse`/`RATE_LIMITS` (`@/lib/rate-limit`), `getMediaUrl`/`downloadMedia` (`@/lib/whatsapp/meta-api`), `decrypt` (`@/lib/whatsapp/encryption`).
- Produces: `RATE_LIMITS.media = { limit: 240, windowMs: 60_000 }`.

- [ ] **Step 1: Adicionar o preset `media` ao RATE_LIMITS**

Em `src/lib/rate-limit.ts`, dentro do objeto `RATE_LIMITS`, adicionar (logo após a linha `conversationsRead: { limit: 240, windowMs: 60_000 },`):

```ts
  /** Download de mídia do WhatsApp pelo proxy. Por usuário — humano no inbox
   *  carrega várias mídias ao abrir conversa (e elas ficam em cache no
   *  navegador, então re-render não reconta). 240/min trava download em massa
   *  sem atrapalhar uso normal. */
  media: { limit: 240, windowMs: 60_000 },
```

- [ ] **Step 2: Escrever o teste (RED)**

Criar `src/app/api/whatsapp/media/[mediaId]/route.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest'

const requireActiveAccountMock = vi.fn()
vi.mock('@/lib/auth/account', () => ({
  requireActiveAccount: (...a: unknown[]) => requireActiveAccountMock(...a),
  toErrorResponse: (err: { message?: string; status?: number } | null) =>
    new Response(JSON.stringify({ error: err?.message ?? 'err' }), {
      status: err?.status ?? 500, headers: { 'content-type': 'application/json' },
    }),
}))

const checkRateLimitMock = vi.fn()
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...a: unknown[]) => checkRateLimitMock(...a),
  rateLimitResponse: () =>
    new Response(JSON.stringify({ error: 'rate limited' }), { status: 429, headers: { 'content-type': 'application/json' } }),
  RATE_LIMITS: { media: { limit: 240, windowMs: 60_000 } },
}))

const getMediaUrlMock = vi.fn()
const downloadMediaMock = vi.fn()
vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: (...a: unknown[]) => getMediaUrlMock(...a),
  downloadMedia: (...a: unknown[]) => downloadMediaMock(...a),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => `dec:${v}` }))

import { GET } from './route'

// messages: .select('id').eq('media_url', x).limit(1) → {data}
// whatsapp_config: .select('*').eq('account_id', x).single() → {data, error}
function fakeSupabase(cfg: { owning?: unknown[]; config?: unknown }) {
  return {
    from: (t: string) => ({
      select: () => ({
        eq: () => ({
          limit: () => Promise.resolve({ data: t === 'messages' ? (cfg.owning ?? []) : [], error: null }),
          single: () =>
            Promise.resolve({ data: t === 'whatsapp_config' ? (cfg.config ?? null) : null, error: cfg.config ? null : { message: 'x' } }),
        }),
      }),
    }),
  } as never
}

function setCtx(cfg: { owning?: unknown[]; config?: unknown }) {
  requireActiveAccountMock.mockResolvedValue({
    supabase: fakeSupabase(cfg), accountId: 'acc1', userId: 'u1', role: 'agent', email: null,
    account: { id: 'acc1', name: 'X', status: 'active', accountType: null },
  })
}

const params = (mediaId = 'm-1') => ({ params: Promise.resolve({ mediaId }) })

beforeEach(() => {
  requireActiveAccountMock.mockReset()
  checkRateLimitMock.mockReset()
  getMediaUrlMock.mockReset()
  downloadMediaMock.mockReset()
})

describe('GET /api/whatsapp/media/[mediaId] — posse + rate limit', () => {
  it('429 quando estoura o rate limit (sem tocar a Meta)', async () => {
    setCtx({ owning: [{ id: 'msg1' }], config: { access_token: 'enc' } })
    checkRateLimitMock.mockResolvedValueOnce({ success: false })
    const res = await GET(new Request('http://x'), params())
    expect(res.status).toBe(429)
    expect(getMediaUrlMock).not.toHaveBeenCalled()
  })

  it('404 quando nenhuma mensagem da conta referencia o mediaId (sem tocar a Meta)', async () => {
    setCtx({ owning: [], config: { access_token: 'enc' } })
    checkRateLimitMock.mockResolvedValueOnce({ success: true })
    const res = await GET(new Request('http://x'), params())
    expect(res.status).toBe(404)
    expect(getMediaUrlMock).not.toHaveBeenCalled()
  })

  it('200 + binário quando há posse e o download ok', async () => {
    setCtx({ owning: [{ id: 'msg1' }], config: { access_token: 'enc' } })
    checkRateLimitMock.mockResolvedValueOnce({ success: true })
    getMediaUrlMock.mockResolvedValueOnce({ url: 'https://cdn.meta/x', mimeType: 'image/jpeg' })
    downloadMediaMock.mockResolvedValueOnce({ buffer: Buffer.from('abc'), contentType: 'image/jpeg' })
    const res = await GET(new Request('http://x'), params())
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/jpeg')
    expect(getMediaUrlMock).toHaveBeenCalledWith({ mediaId: 'm-1', accessToken: 'dec:enc' })
  })
})
```

- [ ] **Step 3: Rodar o teste pra ver falhar (RED)**

Run: `npx vitest run "src/app/api/whatsapp/media/[mediaId]/route.test.ts"`
Expected: FALHA nos casos 429 e 404 — a rota atual não faz rate limit nem checagem de posse, então cai direto no download e retorna 200 (o caso 200 já passa).

- [ ] **Step 4: Implementar rate limit + posse na rota (GREEN)**

Substituir TODO o conteúdo de `src/app/api/whatsapp/media/[mediaId]/route.ts` por:

```ts
import { NextResponse } from 'next/server'
import { requireActiveAccount, toErrorResponse } from '@/lib/auth/account'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params

    if (!mediaId) {
      return NextResponse.json({ error: 'Media ID is required' }, { status: 400 })
    }

    const ctx = await requireActiveAccount()
    const { supabase, accountId, userId } = ctx

    // Rate limit por usuário (mais barato primeiro). Trava download em massa
    // sem atrapalhar o inbox (respostas têm Cache-Control: max-age=86400).
    const limit = await checkRateLimit(`media:${userId}`, RATE_LIMITS.media)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    // Posse: só serve a mídia se houver uma mensagem DESTA conta que a
    // referencie. media_url guarda a proxy URL com o mediaId
    // (parseMessageContent); a RLS escopa messages→conversations→conta.
    // 0 linhas → 404 (não revela existência).
    const { data: owning } = await supabase
      .from('messages')
      .select('id')
      .eq('media_url', `/api/whatsapp/media/${mediaId}`)
      .limit(1)
    if (!owning || owning.length === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // Config do WhatsApp da conta + descriptografa o token (nunca logar).
    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json({ error: 'WhatsApp not configured' }, { status: 400 })
    }

    const accessToken = decrypt(config.access_token)

    // URL de download na Meta + binário.
    const mediaInfo = await getMediaUrl({ mediaId, accessToken })
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    })

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': contentType || mediaInfo.mimeType || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400',
      },
    })
  } catch (error) {
    console.error('Error in WhatsApp media GET:', error)
    return toErrorResponse(error)
  }
}
```

(O param `request` segue não-usado, como no original — a regra `no-unused-vars` em modo `after-used` não flagra arg posicional antes do `params`, que é usado.)

- [ ] **Step 5: Rodar o teste (GREEN)**

Run: `npx vitest run "src/app/api/whatsapp/media/[mediaId]/route.test.ts"`
Expected: 3 PASS.

- [ ] **Step 6: Typecheck + lint + suíte completa**

Run: `npx tsc --noEmit && npm run lint && npx vitest run`
Expected: `tsc` limpo; lint sem novos problemas nos arquivos tocados (baseline 2 errors / ~24 problems); suíte completa verde.

- [ ] **Step 7: Commit**

```bash
git add src/lib/rate-limit.ts "src/app/api/whatsapp/media/[mediaId]/route.ts" "src/app/api/whatsapp/media/[mediaId]/route.test.ts"
git commit -m "fix(media): checagem de posse + rate limit no whatsapp/media/[mediaId] (#8)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Pós-execução

1. **Sem migration** — nada a aplicar no banco.
2. Review final de branch (opus) → PR `iv-automacao/crm-vantage` (base main). Merge a critério do Iago.
3. Pós-merge: atualizar a auditoria (#8 → ✅) e a memória `crm-vantage-hardening`.

## Self-review (writing-plans)

- **Cobertura do spec:** preset `media` (Step 1) ✓; rate limit por usuário 429 (Step 4) ✓; posse via `messages.media_url` 404 (Step 4) ✓; ordem rate→posse→Meta ✓; sem migration ✓; `requireActiveAccount` mantido ✓; posse nível-conta (por-agente fora) ✓.
- **Placeholders:** nenhum — código/comando completos.
- **Consistência de tipos:** `checkRateLimit(key, preset)` → `{success}` (usado no route + mock); `rateLimitResponse(limit)`; `RATE_LIMITS.media` definido no Step 1 e mockado no teste; fake supabase cobre `messages.select().eq().limit()` e `whatsapp_config.select().eq().single()`; `getMediaUrl({mediaId, accessToken})`/`downloadMedia({downloadUrl, accessToken})` batem com as chamadas reais.

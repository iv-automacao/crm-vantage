/**
 * Testes do wrapper defineRoute.
 *
 * Estratégia: mockar os módulos de auth e usar stubs injetados.
 * O handler em si é testado como função pura — não bate em rede/DB.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { z } from 'zod'

// ---------------------------------------------------------------
// Mocks globais de módulos com I/O — declarados antes de qualquer
// import dos módulos que os usam.
// ---------------------------------------------------------------

// Mock next/server — NextRequest e NextResponse precisam funcionar
// em ambiente node (vitest usa globalThis.Response do node 18+).
vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server')
  return actual
})

// Mock dos módulos de auth para controle total nos testes.
vi.mock('@/lib/auth/account', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/account')>('@/lib/auth/account')
  return {
    ...actual,
    requireActiveAccount: vi.fn(),
    requireRole: vi.fn(),
  }
})

vi.mock('@/lib/auth/platform-admin', () => ({
  requirePlatformAdmin: vi.fn(),
}))

vi.mock('@/lib/auth/api-key-context', () => ({
  resolveApiKey: vi.fn(),
}))

// ---------------------------------------------------------------
// Imports após os mocks
// ---------------------------------------------------------------

import { NextRequest } from 'next/server'
import { defineRoute } from './handler'
import {
  UnauthorizedError,
  ForbiddenError,
  AccountPendingError,
} from '@/lib/auth/account'
import * as accountMod from '@/lib/auth/account'
import * as apiKeyCtx from '@/lib/auth/api-key-context'

// ---------------------------------------------------------------
// Helpers de teste
// ---------------------------------------------------------------

/** Cria uma NextRequest fake com o body e headers desejados. */
function makeReq(opts: {
  url?: string
  method?: string
  body?: unknown
  headers?: Record<string, string>
}): NextRequest {
  const url = opts.url ?? 'http://localhost/api/test'
  const headers = new Headers(opts.headers ?? {})
  if (opts.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return new NextRequest(url, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
}

// Schema simples para os testes de validação de body.
const TestBody = z.object({
  nome: z.string(),
  valor: z.number(),
})

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------
// Suite principal
// ---------------------------------------------------------------

describe('defineRoute — auth: public', () => {
  it('happy path — chama o handler e retorna sua resposta', async () => {
    const handler = defineRoute({
      auth: { type: 'public' },
      async handler() {
        return Response.json({ ok: true })
      },
    })
    const res = await handler(makeReq({}))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })
})

describe('defineRoute — auth: session', () => {
  it('sem bearer / sem sessão → 401 via toErrorResponse', async () => {
    vi.mocked(accountMod.requireActiveAccount).mockRejectedValue(
      new UnauthorizedError('Unauthorized'),
    )
    const handler = defineRoute({
      auth: { type: 'session' },
      async handler() {
        return Response.json({ ok: true })
      },
    })
    const res = await handler(makeReq({}))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.code).toBe('unauthorized')
  })
})

describe('defineRoute — auth: apiKey', () => {
  it('sem bearer → 401 (UnauthorizedError de resolveApiKey)', async () => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockRejectedValue(
      new UnauthorizedError('Missing or malformed Authorization: Bearer header'),
    )
    const handler = defineRoute({
      auth: { type: 'apiKey', scopes: ['messages:send'] },
      async handler() {
        return Response.json({ ok: true })
      },
    })
    const res = await handler(makeReq({}))
    expect(res.status).toBe(401)
  })

  it('conta suspensa → 403 account_pending', async () => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockRejectedValue(
      new AccountPendingError('suspended'),
    )
    const handler = defineRoute({
      auth: { type: 'apiKey', scopes: ['messages:send'] },
      async handler() {
        return Response.json({ ok: true })
      },
    })
    const res = await handler(makeReq({ headers: { authorization: 'Bearer vtg_sk_fake' } }))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('account_pending')
    expect(body.status).toBe('suspended')
  })

  it('escopo ausente → 403 forbidden', async () => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockRejectedValue(
      new ForbiddenError("API key missing required scope 'messages:send'"),
    )
    const handler = defineRoute({
      auth: { type: 'apiKey', scopes: ['messages:send'] },
      async handler() {
        return Response.json({ ok: true })
      },
    })
    const res = await handler(makeReq({ headers: { authorization: 'Bearer vtg_sk_fake' } }))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('forbidden')
  })

  it('happy path — resolveApiKey ok, chama o handler', async () => {
    const fakeCtx = {
      supabase: {} as never,
      apiKeyId: 'key-id-1',
      accountId: 'acc-id-1',
      scopes: ['messages:send'],
      createdByUserId: 'user-1',
      ownerUserId: 'owner-1',
    }
    vi.mocked(apiKeyCtx.resolveApiKey).mockResolvedValue(fakeCtx)
    let capturedCtx: unknown = null
    const handler = defineRoute({
      auth: { type: 'apiKey', scopes: ['messages:send'] },
      async handler({ ctx }) {
        capturedCtx = ctx
        return Response.json({ ok: true })
      },
    })
    const res = await handler(makeReq({ headers: { authorization: 'Bearer vtg_sk_abc' } }))
    expect(res.status).toBe(200)
    expect((capturedCtx as { auth: string }).auth).toBe('apiKey')
    expect((capturedCtx as { apiKey: typeof fakeCtx }).apiKey).toBe(fakeCtx)
  })
})

describe('defineRoute — validação de body', () => {
  it('JSON malformado → 400 bad_request', async () => {
    const handler = defineRoute({
      auth: { type: 'public' },
      body: TestBody,
      async handler() {
        return Response.json({ ok: true })
      },
    })
    // Envia texto inválido como JSON
    const req = new NextRequest('http://localhost/api/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'isso nao é json{{{',
    })
    const res = await handler(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('bad_request')
  })

  it('body válido JSON mas schema inválido → 422 validation_error', async () => {
    const handler = defineRoute({
      auth: { type: 'public' },
      body: TestBody,
      async handler() {
        return Response.json({ ok: true })
      },
    })
    // Envia objeto que não satisfaz o schema (nome faltando, valor errado)
    const res = await handler(makeReq({ body: { valor: 'nao-é-numero' } }))
    expect(res.status).toBe(422)
    const respBody = await res.json()
    expect(respBody.code).toBe('validation_error')
    expect(Array.isArray(respBody.details)).toBe(true)
  })

  it('body válido → handler recebe os dados parseados', async () => {
    let capturedBody: unknown = null
    const handler = defineRoute({
      auth: { type: 'public' },
      body: TestBody,
      async handler({ body }) {
        capturedBody = body
        return Response.json({ ok: true })
      },
    })
    const res = await handler(makeReq({ body: { nome: 'VANTAGE', valor: 42 } }))
    expect(res.status).toBe(200)
    expect(capturedBody).toEqual({ nome: 'VANTAGE', valor: 42 })
  })
})

describe('defineRoute — validação de query params', () => {
  const QuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })

  it('query param inválido → 422', async () => {
    const handler = defineRoute({
      auth: { type: 'public' },
      query: QuerySchema,
      async handler() {
        return Response.json({ ok: true })
      },
    })
    const req = makeReq({ url: 'http://localhost/api/test?limit=0' })
    const res = await handler(req)
    expect(res.status).toBe(422)
  })

  it('query param válido → handler recebe valor coercido', async () => {
    let capturedQuery: unknown = null
    const handler = defineRoute({
      auth: { type: 'public' },
      query: QuerySchema,
      async handler({ query }) {
        capturedQuery = query
        return Response.json({ ok: true })
      },
    })
    const req = makeReq({ url: 'http://localhost/api/test?limit=50' })
    const res = await handler(req)
    expect(res.status).toBe(200)
    expect((capturedQuery as { limit: number }).limit).toBe(50)
  })
})

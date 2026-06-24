/**
 * Testes dos handlers POST/GET /api/v1/deals.
 *
 * Estratégia: mockar resolveApiKey e os serviços de deals para testar
 * todos os ramos sem bater em rede ou banco.
 * Segue o padrão de src/app/api/v1/contacts/route.test.ts.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------
// Mocks — declarados antes dos imports dos módulos que os usam.
// ---------------------------------------------------------------

vi.mock('@/lib/auth/api-key-context', () => ({
  resolveApiKey: vi.fn(),
}))

vi.mock('@/lib/deals/api-service', () => ({
  createDeal: vi.fn(),
  listDealsByContact: vi.fn(),
}))

// ---------------------------------------------------------------
// Imports pós-mocks
// ---------------------------------------------------------------

import { POST, GET } from './route'
import * as apiKeyCtx from '@/lib/auth/api-key-context'
import * as dealsSvc from '@/lib/deals/api-service'
import { UnauthorizedError, ForbiddenError } from '@/lib/auth/account'
import { SCOPE_DEALS_WRITE, SCOPE_DEALS_READ } from '@/lib/auth/api-keys'
import { UnknownPipelineError } from '@/lib/api/errors'

// ---------------------------------------------------------------
// Helpers de teste
// ---------------------------------------------------------------

const fakeApiKeyCtxWrite = {
  supabase: {} as never,
  apiKeyId: 'key-id-test',
  accountId: 'acc-id-test',
  scopes: [SCOPE_DEALS_WRITE],
  createdByUserId: 'user-abc',
  ownerUserId: 'owner-xyz',
}

const fakeApiKeyCtxRead = {
  ...fakeApiKeyCtxWrite,
  scopes: [SCOPE_DEALS_READ],
}

const fakeDeal = {
  id: 'deal-uuid-1',
  title: 'Negócio Teste',
  value: 5000,
  currency: 'BRL',
  status: 'open',
  pipeline: { id: 'pipeline-uuid-1', name: 'Vendas' },
  stage: { id: 'stage-uuid-1', name: 'Prospecção' },
  contact_id: 'contact-uuid-1',
  expected_close_date: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

function makePostReq(opts: { body?: unknown; auth?: string } = {}): NextRequest {
  const headers: Record<string, string> = {
    authorization: opts.auth !== undefined ? opts.auth : 'Bearer vtg_sk_valid',
  }
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json'
  }
  return new NextRequest('http://localhost/api/v1/deals', {
    method: 'POST',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
}

function makeGetReq(opts: { phone?: string; contactId?: string; auth?: string } = {}): NextRequest {
  const params = new URLSearchParams()
  if (opts.phone) params.set('contact_phone', opts.phone)
  if (opts.contactId) params.set('contact_id', opts.contactId)
  const qs = params.toString()
  const url = qs ? `http://localhost/api/v1/deals?${qs}` : 'http://localhost/api/v1/deals'
  return new NextRequest(url, {
    method: 'GET',
    headers: {
      authorization: opts.auth !== undefined ? opts.auth : 'Bearer vtg_sk_valid',
    },
  })
}

const validBody = {
  contact_phone: '+5592999990001',
  pipeline: 'Vendas',
  stage: 'Prospecção',
  title: 'Negócio Teste',
  value: 5000,
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------
// POST — Autenticação
// ---------------------------------------------------------------

describe('POST /api/v1/deals — autenticação', () => {
  it('sem Authorization header → 401', async () => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockRejectedValue(
      new UnauthorizedError('Missing or malformed Authorization: Bearer header'),
    )
    const res = await POST(makePostReq({ auth: '', body: validBody }))
    expect(res.status).toBe(401)
  })

  it('chave sem deals:write → 403 com code forbidden', async () => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockRejectedValue(
      new ForbiddenError(`API key missing required scope '${SCOPE_DEALS_WRITE}'`),
    )
    const res = await POST(makePostReq({ body: validBody }))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('forbidden')
  })
})

// ---------------------------------------------------------------
// POST — Validação de body
// ---------------------------------------------------------------

describe('POST /api/v1/deals — validação de body', () => {
  beforeEach(() => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockResolvedValue(fakeApiKeyCtxWrite)
  })

  it('JSON malformado → 400 bad_request', async () => {
    const req = new NextRequest('http://localhost/api/v1/deals', {
      method: 'POST',
      headers: {
        authorization: 'Bearer vtg_sk_valid',
        'content-type': 'application/json',
      },
      body: 'isso{nao_e_json',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('bad_request')
  })

  it('body sem contact_phone nem contact_id → 422 validation_error', async () => {
    const res = await POST(
      makePostReq({
        body: { pipeline: 'Vendas', stage: 'Prospecção', title: 'Negócio Sem Contato' },
      }),
    )
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.code).toBe('validation_error')
  })

  it('body com contact_phone E contact_id (ambos) → 422 validation_error', async () => {
    const res = await POST(
      makePostReq({
        body: {
          contact_phone: '+5592999990001',
          contact_id: 'some-uuid-here-1234',
          pipeline: 'Vendas',
          stage: 'Prospecção',
          title: 'Negócio Duplo',
        },
      }),
    )
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.code).toBe('validation_error')
  })
})

// ---------------------------------------------------------------
// POST — Erros de serviço
// ---------------------------------------------------------------

describe('POST /api/v1/deals — erros de serviço', () => {
  beforeEach(() => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockResolvedValue(fakeApiKeyCtxWrite)
  })

  it('pipeline inexistente → 422 com code unknown_pipeline', async () => {
    vi.mocked(dealsSvc.createDeal).mockRejectedValue(
      new UnknownPipelineError('Vendas'),
    )
    const res = await POST(makePostReq({ body: validBody }))
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.code).toBe('unknown_pipeline')
  })
})

// ---------------------------------------------------------------
// POST — Happy path
// ---------------------------------------------------------------

describe('POST /api/v1/deals — happy path', () => {
  beforeEach(() => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockResolvedValue(fakeApiKeyCtxWrite)
    vi.mocked(dealsSvc.createDeal).mockResolvedValue(fakeDeal)
  })

  it('retorna 201 com { deal } no body', async () => {
    const res = await POST(makePostReq({ body: validBody }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.deal).toBeDefined()
    expect(body.deal.title).toBe(fakeDeal.title)
    expect(body.deal.status).toBe('open')
  })

  it('chama createDeal com serviceCtx correto da chave (não do body)', async () => {
    await POST(makePostReq({ body: validBody }))
    expect(dealsSvc.createDeal).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: fakeApiKeyCtxWrite.accountId,
        auditUserId: fakeApiKeyCtxWrite.createdByUserId,
      }),
      expect.objectContaining({ contact_phone: validBody.contact_phone }),
    )
  })

  it('auditUserId cai para ownerUserId quando createdByUserId é null', async () => {
    const ctxSemCreator = { ...fakeApiKeyCtxWrite, createdByUserId: null }
    vi.mocked(apiKeyCtx.resolveApiKey).mockResolvedValue(ctxSemCreator)
    await POST(makePostReq({ body: validBody }))
    expect(dealsSvc.createDeal).toHaveBeenCalledWith(
      expect.objectContaining({ auditUserId: fakeApiKeyCtxWrite.ownerUserId }),
      expect.anything(),
    )
  })
})

// ---------------------------------------------------------------
// GET — Autenticação
// ---------------------------------------------------------------

describe('GET /api/v1/deals — autenticação', () => {
  it('sem Authorization header → 401', async () => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockRejectedValue(
      new UnauthorizedError('Missing or malformed Authorization: Bearer header'),
    )
    const res = await GET(makeGetReq({ phone: '+5592999990001', auth: '' }))
    expect(res.status).toBe(401)
  })

  it('chave sem deals:read → 403 com code forbidden', async () => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockRejectedValue(
      new ForbiddenError(`API key missing required scope '${SCOPE_DEALS_READ}'`),
    )
    const res = await GET(makeGetReq({ phone: '+5592999990001' }))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('forbidden')
  })
})

// ---------------------------------------------------------------
// GET — Validação de query
// ---------------------------------------------------------------

describe('GET /api/v1/deals — validação de query', () => {
  beforeEach(() => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockResolvedValue(fakeApiKeyCtxRead)
  })

  it('sem ?contact_phone nem ?contact_id → 422 validation_error', async () => {
    const res = await GET(makeGetReq())
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.code).toBe('validation_error')
  })
})

// ---------------------------------------------------------------
// GET — Happy path
// ---------------------------------------------------------------

describe('GET /api/v1/deals — happy path', () => {
  beforeEach(() => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockResolvedValue(fakeApiKeyCtxRead)
  })

  it('deals encontrados → 200 com { deals }', async () => {
    vi.mocked(dealsSvc.listDealsByContact).mockResolvedValue([fakeDeal])
    const res = await GET(makeGetReq({ phone: '+5592999990001' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.deals)).toBe(true)
    expect(body.deals).toHaveLength(1)
    expect(body.deals[0].id).toBe(fakeDeal.id)
  })

  it('nenhum deal → 200 com { deals: [] }', async () => {
    vi.mocked(dealsSvc.listDealsByContact).mockResolvedValue([])
    const res = await GET(makeGetReq({ phone: '+5592000000000' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.deals).toEqual([])
  })
})

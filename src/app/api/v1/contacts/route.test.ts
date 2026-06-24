/**
 * Testes dos handlers POST/GET /api/v1/contacts.
 *
 * Estratégia: mockar resolveApiKey e os serviços de contatos para testar
 * todos os ramos sem bater em rede ou banco.
 * Segue o padrão de src/app/api/v1/messages/send/route.test.ts.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------
// Mocks — declarados antes dos imports dos módulos que os usam.
// ---------------------------------------------------------------

vi.mock('@/lib/auth/api-key-context', () => ({
  resolveApiKey: vi.fn(),
}))

vi.mock('@/lib/contacts/api-service', () => ({
  upsertContactByPhone: vi.fn(),
  findContactByPhone: vi.fn(),
}))

// ---------------------------------------------------------------
// Imports pós-mocks
// ---------------------------------------------------------------

import { POST, GET } from './route'
import * as apiKeyCtx from '@/lib/auth/api-key-context'
import * as contactSvc from '@/lib/contacts/api-service'
import { UnauthorizedError, AccountPendingError, ForbiddenError } from '@/lib/auth/account'
import { SCOPE_CONTACTS_WRITE, SCOPE_CONTACTS_READ } from '@/lib/auth/api-keys'
import { UnknownTagError } from '@/lib/api/errors'

// ---------------------------------------------------------------
// Helpers de teste
// ---------------------------------------------------------------

const fakeApiKeyCtxWrite = {
  supabase: {} as never,
  apiKeyId: 'key-id-test',
  accountId: 'acc-id-test',
  scopes: [SCOPE_CONTACTS_WRITE],
  createdByUserId: 'user-abc',
  ownerUserId: 'owner-xyz',
}

const fakeApiKeyCtxRead = {
  ...fakeApiKeyCtxWrite,
  scopes: [SCOPE_CONTACTS_READ],
}

const fakeContact = {
  id: 'contact-uuid-1',
  phone: '+5592999990001',
  name: 'João Silva',
  email: 'joao@example.com',
  company: 'VANTAGE',
  tags: ['vip'],
  custom_fields: [],
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
  return new NextRequest('http://localhost/api/v1/contacts', {
    method: 'POST',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
}

function makeGetReq(opts: { phone?: string; auth?: string } = {}): NextRequest {
  const url = opts.phone
    ? `http://localhost/api/v1/contacts?phone=${encodeURIComponent(opts.phone)}`
    : 'http://localhost/api/v1/contacts'
  return new NextRequest(url, {
    method: 'GET',
    headers: {
      authorization: opts.auth !== undefined ? opts.auth : 'Bearer vtg_sk_valid',
    },
  })
}

const validBody = {
  phone: '+5592999990001',
  name: 'João Silva',
  email: 'joao@example.com',
  company: 'VANTAGE',
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------
// POST — Autenticação
// ---------------------------------------------------------------

describe('POST /api/v1/contacts — autenticação', () => {
  it('sem Authorization header → 401', async () => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockRejectedValue(
      new UnauthorizedError('Missing or malformed Authorization: Bearer header'),
    )
    const res = await POST(makePostReq({ auth: '', body: validBody }))
    expect(res.status).toBe(401)
  })

  it('conta suspensa → 403 com code account_pending', async () => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockRejectedValue(
      new AccountPendingError('suspended'),
    )
    const res = await POST(makePostReq({ body: validBody }))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('account_pending')
    expect(body.status).toBe('suspended')
  })

  it('escopo contacts:write ausente → 403 com code forbidden', async () => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockRejectedValue(
      new ForbiddenError(`API key missing required scope '${SCOPE_CONTACTS_WRITE}'`),
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

describe('POST /api/v1/contacts — validação de body', () => {
  beforeEach(() => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockResolvedValue(fakeApiKeyCtxWrite)
  })

  it('JSON malformado → 400 bad_request', async () => {
    const req = new NextRequest('http://localhost/api/v1/contacts', {
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

  it('body sem phone → 422 com details', async () => {
    const res = await POST(makePostReq({ body: { name: 'Teste' } }))
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.code).toBe('validation_error')
    expect(Array.isArray(body.details)).toBe(true)
    expect(body.details.some((d: { field: string }) => d.field === 'phone')).toBe(true)
  })

  it('phone muito curto → 422', async () => {
    const res = await POST(makePostReq({ body: { phone: '123' } }))
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.code).toBe('validation_error')
  })
})

// ---------------------------------------------------------------
// POST — Erros de serviço
// ---------------------------------------------------------------

describe('POST /api/v1/contacts — erros de serviço', () => {
  beforeEach(() => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockResolvedValue(fakeApiKeyCtxWrite)
  })

  it('tag inexistente → 422 com code unknown_tag', async () => {
    vi.mocked(contactSvc.upsertContactByPhone).mockRejectedValue(
      new UnknownTagError('vip'),
    )
    const res = await POST(makePostReq({ body: { ...validBody, tags: ['vip'] } }))
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.code).toBe('unknown_tag')
  })
})

// ---------------------------------------------------------------
// POST — Happy path
// ---------------------------------------------------------------

describe('POST /api/v1/contacts — happy path', () => {
  beforeEach(() => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockResolvedValue(fakeApiKeyCtxWrite)
    vi.mocked(contactSvc.upsertContactByPhone).mockResolvedValue(fakeContact)
  })

  it('retorna 201 com { contact } no body', async () => {
    const res = await POST(makePostReq({ body: validBody }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.contact).toBeDefined()
    expect(body.contact.phone).toBe(fakeContact.phone)
  })

  it('chama upsertContactByPhone com svcCtx correto', async () => {
    await POST(makePostReq({ body: validBody }))
    expect(contactSvc.upsertContactByPhone).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: fakeApiKeyCtxWrite.accountId,
        auditUserId: fakeApiKeyCtxWrite.createdByUserId,
      }),
      expect.objectContaining({ phone: validBody.phone }),
    )
  })

  it('auditUserId cai para ownerUserId quando createdByUserId é null', async () => {
    const ctxSemCreator = { ...fakeApiKeyCtxWrite, createdByUserId: null }
    vi.mocked(apiKeyCtx.resolveApiKey).mockResolvedValue(ctxSemCreator)
    await POST(makePostReq({ body: validBody }))
    expect(contactSvc.upsertContactByPhone).toHaveBeenCalledWith(
      expect.objectContaining({ auditUserId: fakeApiKeyCtxWrite.ownerUserId }),
      expect.anything(),
    )
  })
})

// ---------------------------------------------------------------
// GET — Autenticação
// ---------------------------------------------------------------

describe('GET /api/v1/contacts — autenticação', () => {
  it('sem Authorization header → 401', async () => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockRejectedValue(
      new UnauthorizedError('Missing or malformed Authorization: Bearer header'),
    )
    const res = await GET(makeGetReq({ phone: '+5592999990001', auth: '' }))
    expect(res.status).toBe(401)
  })

  it('escopo contacts:read ausente → 403', async () => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockRejectedValue(
      new ForbiddenError(`API key missing required scope '${SCOPE_CONTACTS_READ}'`),
    )
    const res = await GET(makeGetReq({ phone: '+5592999990001' }))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('forbidden')
  })
})

// ---------------------------------------------------------------
// GET — Query sem phone
// ---------------------------------------------------------------

describe('GET /api/v1/contacts — validação de query', () => {
  beforeEach(() => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockResolvedValue(fakeApiKeyCtxRead)
  })

  it('sem ?phone → 422 validation_error', async () => {
    const res = await GET(makeGetReq())
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.code).toBe('validation_error')
  })
})

// ---------------------------------------------------------------
// GET — Happy path
// ---------------------------------------------------------------

describe('GET /api/v1/contacts — happy path', () => {
  beforeEach(() => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockResolvedValue(fakeApiKeyCtxRead)
  })

  it('contato encontrado → 200 com { contact }', async () => {
    vi.mocked(contactSvc.findContactByPhone).mockResolvedValue(fakeContact)
    const res = await GET(makeGetReq({ phone: fakeContact.phone }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.contact).toBeDefined()
    expect(body.contact.phone).toBe(fakeContact.phone)
  })

  it('contato não encontrado → 200 com { contact: null }', async () => {
    vi.mocked(contactSvc.findContactByPhone).mockResolvedValue(null)
    const res = await GET(makeGetReq({ phone: '+5592000000000' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.contact).toBeNull()
  })
})

/**
 * Testes dos handlers POST /api/v1/broadcasts e GET /api/v1/templates.
 *
 * Estratégia: mockar resolveApiKey e os serviços de broadcasts para testar
 * todos os ramos sem bater em rede ou banco.
 * Segue o padrão de src/app/api/v1/deals/route.test.ts.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------
// Mocks — declarados antes dos imports dos módulos que os usam.
// ---------------------------------------------------------------

vi.mock('@/lib/auth/api-key-context', () => ({
  resolveApiKey: vi.fn(),
}))

vi.mock('@/lib/broadcasts/api-service', () => ({
  sendBroadcast: vi.fn(),
  listApprovedTemplates: vi.fn(),
}))

// ---------------------------------------------------------------
// Imports pós-mocks
// ---------------------------------------------------------------

import { POST } from './route'
import { GET } from '../templates/route'
import * as apiKeyCtx from '@/lib/auth/api-key-context'
import * as broadcastsSvc from '@/lib/broadcasts/api-service'
import { UnauthorizedError, ForbiddenError } from '@/lib/auth/account'
import { SCOPE_BROADCASTS_SEND } from '@/lib/auth/api-keys'
import { TemplateNotApprovedError, WhatsappNotConfiguredError } from '@/lib/api/errors'

// ---------------------------------------------------------------
// Helpers de teste
// ---------------------------------------------------------------

const fakeApiKeyCtx = {
  supabase: {} as never,
  apiKeyId: 'key-id-test',
  accountId: 'acc-id-test',
  scopes: [SCOPE_BROADCASTS_SEND],
  createdByUserId: 'user-abc',
  ownerUserId: 'owner-xyz',
}

const fakeBroadcastResult = {
  sent: 2,
  failed: 0,
  broadcast_id: 'bc-1',
  results: [
    { phone: '+5592999990001', status: 'sent' as const, whatsapp_message_id: 'wamid.001' },
    { phone: '+5592999990002', status: 'sent' as const, whatsapp_message_id: 'wamid.002' },
  ],
}

const fakeTemplates = [
  {
    name: 'bem_vindo',
    language: 'pt_BR',
    category: 'MARKETING',
    status: 'APPROVED',
    body_text: 'Olá {{1}}, bem-vindo!',
    variables_count: 1,
  },
]

function makePostReq(opts: { body?: unknown; auth?: string } = {}): NextRequest {
  const headers: Record<string, string> = {
    authorization: opts.auth !== undefined ? opts.auth : 'Bearer vtg_sk_valid',
  }
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json'
  }
  return new NextRequest('http://localhost/api/v1/broadcasts', {
    method: 'POST',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
}

function makeGetReq(opts: { auth?: string } = {}): NextRequest {
  return new NextRequest('http://localhost/api/v1/templates', {
    method: 'GET',
    headers: {
      authorization: opts.auth !== undefined ? opts.auth : 'Bearer vtg_sk_valid',
    },
  })
}

const validBody = {
  template_name: 'bem_vindo',
  template_language: 'pt_BR',
  recipients: [
    { phone: '+5592999990001' },
    { phone: '+5592999990002' },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------
// POST /api/v1/broadcasts — Autenticação
// ---------------------------------------------------------------

describe('POST /api/v1/broadcasts — autenticação', () => {
  it('sem Authorization header → 401', async () => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockRejectedValue(
      new UnauthorizedError('Missing or malformed Authorization: Bearer header'),
    )
    const res = await POST(makePostReq({ auth: '', body: validBody }))
    expect(res.status).toBe(401)
  })

  it('chave sem broadcasts:send → 403 com code forbidden', async () => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockRejectedValue(
      new ForbiddenError(`API key missing required scope '${SCOPE_BROADCASTS_SEND}'`),
    )
    const res = await POST(makePostReq({ body: validBody }))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('forbidden')
  })
})

// ---------------------------------------------------------------
// POST /api/v1/broadcasts — Validação de body
// ---------------------------------------------------------------

describe('POST /api/v1/broadcasts — validação de body', () => {
  beforeEach(() => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockResolvedValue(fakeApiKeyCtx)
  })

  it('JSON malformado → 400 bad_request', async () => {
    const req = new NextRequest('http://localhost/api/v1/broadcasts', {
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

  it('recipients vazio → 422 validation_error', async () => {
    const res = await POST(
      makePostReq({
        body: {
          template_name: 'bem_vindo',
          template_language: 'pt_BR',
          recipients: [],
        },
      }),
    )
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.code).toBe('validation_error')
  })
})

// ---------------------------------------------------------------
// POST /api/v1/broadcasts — Erros de serviço
// ---------------------------------------------------------------

describe('POST /api/v1/broadcasts — erros de serviço', () => {
  beforeEach(() => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockResolvedValue(fakeApiKeyCtx)
  })

  it('serviço lança TemplateNotApprovedError → 422 com code template_not_approved', async () => {
    vi.mocked(broadcastsSvc.sendBroadcast).mockRejectedValue(
      new TemplateNotApprovedError('bem_vindo'),
    )
    const res = await POST(makePostReq({ body: validBody }))
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.code).toBe('template_not_approved')
  })

  it('serviço lança WhatsappNotConfiguredError → 409', async () => {
    vi.mocked(broadcastsSvc.sendBroadcast).mockRejectedValue(
      new WhatsappNotConfiguredError(),
    )
    const res = await POST(makePostReq({ body: validBody }))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('whatsapp_not_configured')
  })
})

// ---------------------------------------------------------------
// POST /api/v1/broadcasts — Happy path
// ---------------------------------------------------------------

describe('POST /api/v1/broadcasts — happy path', () => {
  beforeEach(() => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockResolvedValue(fakeApiKeyCtx)
    vi.mocked(broadcastsSvc.sendBroadcast).mockResolvedValue(fakeBroadcastResult)
  })

  it('retorna 200 com { sent, failed, results } direto (sem wrapper extra)', async () => {
    const res = await POST(makePostReq({ body: validBody }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sent).toBe(fakeBroadcastResult.sent)
    expect(body.failed).toBe(fakeBroadcastResult.failed)
    expect(Array.isArray(body.results)).toBe(true)
    expect(body.results).toHaveLength(2)
  })

  it('chama sendBroadcast com serviceCtx correto da chave (não do body)', async () => {
    await POST(makePostReq({ body: validBody }))
    expect(broadcastsSvc.sendBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: fakeApiKeyCtx.accountId,
        auditUserId: fakeApiKeyCtx.createdByUserId,
      }),
      expect.objectContaining({ template_name: validBody.template_name }),
    )
  })
})

// ---------------------------------------------------------------
// GET /api/v1/templates — Autenticação
// ---------------------------------------------------------------

describe('GET /api/v1/templates — autenticação', () => {
  it('sem Authorization header → 401', async () => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockRejectedValue(
      new UnauthorizedError('Missing or malformed Authorization: Bearer header'),
    )
    const res = await GET(makeGetReq({ auth: '' }))
    expect(res.status).toBe(401)
  })

  it('chave sem broadcasts:send → 403 com code forbidden', async () => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockRejectedValue(
      new ForbiddenError(`API key missing required scope '${SCOPE_BROADCASTS_SEND}'`),
    )
    const res = await GET(makeGetReq())
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('forbidden')
  })
})

// ---------------------------------------------------------------
// GET /api/v1/templates — Happy path
// ---------------------------------------------------------------

describe('GET /api/v1/templates — happy path', () => {
  beforeEach(() => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockResolvedValue(fakeApiKeyCtx)
    vi.mocked(broadcastsSvc.listApprovedTemplates).mockResolvedValue(fakeTemplates)
  })

  it('retorna 200 com { templates }', async () => {
    const res = await GET(makeGetReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.templates)).toBe(true)
    expect(body.templates).toHaveLength(1)
    expect(body.templates[0].name).toBe('bem_vindo')
  })

  it('templates vazio → 200 com { templates: [] }', async () => {
    vi.mocked(broadcastsSvc.listApprovedTemplates).mockResolvedValue([])
    const res = await GET(makeGetReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.templates).toEqual([])
  })
})

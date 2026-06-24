/**
 * Testes dos handlers GET /api/v1/conversations e subrotas.
 *
 * Estratégia: mockar resolveApiKey e os serviços de conversas para testar
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

vi.mock('@/lib/conversations/api-service', () => ({
  findConversationsByContact: vi.fn(),
  getConversationById: vi.fn(),
  listMessages: vi.fn(),
}))

// ---------------------------------------------------------------
// Imports pós-mocks
// ---------------------------------------------------------------

import { GET } from './route'
import { GET as GETById } from './[id]/route'
import { GET as GETMessages } from './[id]/messages/route'
import * as apiKeyCtx from '@/lib/auth/api-key-context'
import * as convSvc from '@/lib/conversations/api-service'
import { UnauthorizedError, ForbiddenError } from '@/lib/auth/account'
import { SCOPE_CONVERSATIONS_READ } from '@/lib/auth/api-keys'
import { NotFoundError } from '@/lib/api/errors'

// ---------------------------------------------------------------
// Helpers de teste
// ---------------------------------------------------------------

const fakeApiKeyCtx = {
  supabase: {} as never,
  apiKeyId: 'key-id-test',
  accountId: 'acc-id-test',
  scopes: [SCOPE_CONVERSATIONS_READ],
  createdByUserId: 'user-abc',
  ownerUserId: 'owner-xyz',
}

const fakeConversation = {
  id: 'conv-uuid-1',
  contact_id: 'contact-uuid-1',
  status: 'open',
  assigned_agent_id: null,
  last_message_text: 'Olá',
  last_message_at: '2026-01-01T10:00:00Z',
  unread_count: 2,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T10:00:00Z',
}

const fakeMessage = {
  id: 'msg-uuid-1',
  sender_type: 'contact',
  content_type: 'text',
  content_text: 'Olá',
  media_url: null,
  status: 'delivered',
  created_at: '2026-01-01T10:00:00Z',
}

function makeGetReq(opts: { phone?: string; contactId?: string; auth?: string } = {}): NextRequest {
  const params = new URLSearchParams()
  if (opts.phone) params.set('contact_phone', opts.phone)
  if (opts.contactId) params.set('contact_id', opts.contactId)
  const qs = params.toString()
  const url = qs
    ? `http://localhost/api/v1/conversations?${qs}`
    : 'http://localhost/api/v1/conversations'
  return new NextRequest(url, {
    method: 'GET',
    headers: {
      authorization: opts.auth !== undefined ? opts.auth : 'Bearer vtg_sk_valid',
    },
  })
}

function makeGetByIdReq(id = 'conv-uuid-1', opts: { auth?: string } = {}): NextRequest {
  return new NextRequest(`http://localhost/api/v1/conversations/${id}`, {
    method: 'GET',
    headers: {
      authorization: opts.auth !== undefined ? opts.auth : 'Bearer vtg_sk_valid',
    },
  })
}

function makeGetMessagesReq(
  id = 'conv-uuid-1',
  opts: { limit?: number; before?: string; auth?: string } = {},
): NextRequest {
  const params = new URLSearchParams()
  if (opts.limit !== undefined) params.set('limit', String(opts.limit))
  if (opts.before) params.set('before', opts.before)
  const qs = params.toString()
  const url = qs
    ? `http://localhost/api/v1/conversations/${id}/messages?${qs}`
    : `http://localhost/api/v1/conversations/${id}/messages`
  return new NextRequest(url, {
    method: 'GET',
    headers: {
      authorization: opts.auth !== undefined ? opts.auth : 'Bearer vtg_sk_valid',
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------
// GET /api/v1/conversations — Autenticação
// ---------------------------------------------------------------

describe('GET /api/v1/conversations — autenticação', () => {
  it('sem Authorization header → 401', async () => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockRejectedValue(
      new UnauthorizedError('Missing or malformed Authorization: Bearer header'),
    )
    const res = await GET(makeGetReq({ phone: '+5592999990001', auth: '' }))
    expect(res.status).toBe(401)
  })

  it('chave sem conversations:read → 403 com code forbidden', async () => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockRejectedValue(
      new ForbiddenError(`API key missing required scope '${SCOPE_CONVERSATIONS_READ}'`),
    )
    const res = await GET(makeGetReq({ phone: '+5592999990001' }))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('forbidden')
  })
})

// ---------------------------------------------------------------
// GET /api/v1/conversations — Validação de query
// ---------------------------------------------------------------

describe('GET /api/v1/conversations — validação de query', () => {
  beforeEach(() => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockResolvedValue(fakeApiKeyCtx)
  })

  it('sem ?contact_phone nem ?contact_id → 422 validation_error', async () => {
    const res = await GET(makeGetReq())
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.code).toBe('validation_error')
  })

  it('com ambos contact_phone e contact_id → 422 validation_error', async () => {
    const res = await GET(
      makeGetReq({ phone: '+5592999990001', contactId: 'contact-uuid-1' }),
    )
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.code).toBe('validation_error')
  })
})

// ---------------------------------------------------------------
// GET /api/v1/conversations — Erros de serviço
// ---------------------------------------------------------------

describe('GET /api/v1/conversations — erros de serviço', () => {
  beforeEach(() => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockResolvedValue(fakeApiKeyCtx)
  })

  it('contact_id inexistente → 404 com code not_found', async () => {
    vi.mocked(convSvc.findConversationsByContact).mockRejectedValue(
      new NotFoundError('Contato não encontrado'),
    )
    const res = await GET(makeGetReq({ contactId: '00000000-0000-0000-0000-000000000000' }))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('not_found')
  })
})

// ---------------------------------------------------------------
// GET /api/v1/conversations — Happy path
// ---------------------------------------------------------------

describe('GET /api/v1/conversations — happy path', () => {
  beforeEach(() => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockResolvedValue(fakeApiKeyCtx)
  })

  it('conversas encontradas → 200 com { conversations }', async () => {
    vi.mocked(convSvc.findConversationsByContact).mockResolvedValue([fakeConversation])
    const res = await GET(makeGetReq({ phone: '+5592999990001' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.conversations)).toBe(true)
    expect(body.conversations).toHaveLength(1)
    expect(body.conversations[0].id).toBe(fakeConversation.id)
  })

  it('nenhuma conversa → 200 com { conversations: [] }', async () => {
    vi.mocked(convSvc.findConversationsByContact).mockResolvedValue([])
    const res = await GET(makeGetReq({ phone: '+5592000000000' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.conversations).toEqual([])
  })
})

// ---------------------------------------------------------------
// GET /api/v1/conversations/[id] — Autenticação e happy path
// ---------------------------------------------------------------

describe('GET /api/v1/conversations/[id] — autenticação', () => {
  it('sem Authorization header → 401', async () => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockRejectedValue(
      new UnauthorizedError('Missing or malformed Authorization: Bearer header'),
    )
    const res = await GETById(makeGetByIdReq('conv-uuid-1', { auth: '' }))
    expect(res.status).toBe(401)
  })

  it('chave sem conversations:read → 403', async () => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockRejectedValue(
      new ForbiddenError(`API key missing required scope '${SCOPE_CONVERSATIONS_READ}'`),
    )
    const res = await GETById(makeGetByIdReq('conv-uuid-1'))
    expect(res.status).toBe(403)
  })
})

describe('GET /api/v1/conversations/[id] — happy path', () => {
  beforeEach(() => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockResolvedValue(fakeApiKeyCtx)
  })

  it('conversa encontrada → 200 com { conversation }', async () => {
    vi.mocked(convSvc.getConversationById).mockResolvedValue(fakeConversation)
    const res = await GETById(makeGetByIdReq('conv-uuid-1'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.conversation).toBeDefined()
    expect(body.conversation.id).toBe(fakeConversation.id)
  })

  it('conversa não encontrada → 404', async () => {
    vi.mocked(convSvc.getConversationById).mockRejectedValue(
      new NotFoundError('Conversa não encontrada'),
    )
    const res = await GETById(makeGetByIdReq('conv-inexistente'))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('not_found')
  })
})

// ---------------------------------------------------------------
// GET /api/v1/conversations/[id]/messages — Happy path e paginação
// ---------------------------------------------------------------

describe('GET /api/v1/conversations/[id]/messages — autenticação', () => {
  it('sem Authorization header → 401', async () => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockRejectedValue(
      new UnauthorizedError('Missing or malformed Authorization: Bearer header'),
    )
    const res = await GETMessages(makeGetMessagesReq('conv-uuid-1', { auth: '' }))
    expect(res.status).toBe(401)
  })
})

describe('GET /api/v1/conversations/[id]/messages — happy path', () => {
  beforeEach(() => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockResolvedValue(fakeApiKeyCtx)
  })

  it('mensagens encontradas → 200 com { messages, has_more, next_before }', async () => {
    vi.mocked(convSvc.listMessages).mockResolvedValue({
      messages: [fakeMessage],
      has_more: false,
      next_before: null,
    })
    const res = await GETMessages(makeGetMessagesReq('conv-uuid-1'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.messages)).toBe(true)
    expect(body.messages).toHaveLength(1)
    expect(body.has_more).toBe(false)
    expect(body.next_before).toBeNull()
  })

  it('paginação com has_more → retorna next_before correto', async () => {
    vi.mocked(convSvc.listMessages).mockResolvedValue({
      messages: [fakeMessage],
      has_more: true,
      next_before: '2026-01-01T09:59:59Z',
    })
    const res = await GETMessages(makeGetMessagesReq('conv-uuid-1', { limit: 1 }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.has_more).toBe(true)
    expect(body.next_before).toBe('2026-01-01T09:59:59Z')
  })

  it('conversa não encontrada → 404', async () => {
    vi.mocked(convSvc.listMessages).mockRejectedValue(
      new NotFoundError('Conversa não encontrada'),
    )
    const res = await GETMessages(makeGetMessagesReq('conv-inexistente'))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('not_found')
  })
})

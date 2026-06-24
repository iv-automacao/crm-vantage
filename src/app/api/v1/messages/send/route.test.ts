/**
 * Testes do handler POST /api/v1/messages/send.
 *
 * Estratégia: mockar resolveApiKey e sendMessageToConversation pra testar
 * todos os ramos sem bater em rede ou banco. Reutiliza o padrão de
 * handler.test.ts e api-key-context.test.ts.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------
// Mocks — declarados antes dos imports dos módulos que os usam.
// ---------------------------------------------------------------

vi.mock('@/lib/auth/api-key-context', () => ({
  resolveApiKey: vi.fn(),
}))

vi.mock('@/lib/whatsapp/send-message', () => ({
  sendMessageToConversation: vi.fn(),
}))

// after() do Next.js é no-op em testes — só registra, não executa.
vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server')
  return {
    ...actual,
    after: vi.fn(),
  }
})

// ---------------------------------------------------------------
// Imports pós-mocks
// ---------------------------------------------------------------

import { POST } from './route'
import * as apiKeyCtx from '@/lib/auth/api-key-context'
import * as sendMessageMod from '@/lib/whatsapp/send-message'
import { UnauthorizedError, AccountPendingError, ForbiddenError } from '@/lib/auth/account'
import { SCOPE_MESSAGES_SEND } from '@/lib/auth/api-keys'

// ---------------------------------------------------------------
// Helpers de teste
// ---------------------------------------------------------------

const VALID_UUID = '00000000-0000-4000-8000-000000000001'

const fakeApiKeyCtx = {
  supabase: {
    from: vi.fn().mockReturnValue({
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      }),
    }),
  } as never,
  apiKeyId: 'key-id-test',
  accountId: 'acc-id-test',
  scopes: [SCOPE_MESSAGES_SEND],
}

function makeReq(opts: { body?: unknown; auth?: string } = {}): NextRequest {
  const headers: Record<string, string> = {}
  if (opts.auth !== undefined) {
    headers['authorization'] = opts.auth
  } else {
    headers['authorization'] = 'Bearer vtg_sk_valid'
  }
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json'
  }
  return new NextRequest('http://localhost/api/v1/messages/send', {
    method: 'POST',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
}

const validBody = {
  conversation_id: VALID_UUID,
  message_type: 'text',
  content_text: 'Olá, teste!',
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------
// Testes de autenticação
// ---------------------------------------------------------------

describe('POST /api/v1/messages/send — autenticação', () => {
  it('sem Authorization header → 401', async () => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockRejectedValue(
      new UnauthorizedError('Missing or malformed Authorization: Bearer header'),
    )
    const req = makeReq({ auth: '', body: validBody })
    const res = await POST(req)
    expect(res.status).toBe(401)
  })

  it('conta suspensa → 403 com code account_pending', async () => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockRejectedValue(
      new AccountPendingError('suspended'),
    )
    const req = makeReq({ body: validBody })
    const res = await POST(req)
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('account_pending')
    expect(body.status).toBe('suspended')
  })

  it('escopo ausente → 403 com code forbidden', async () => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockRejectedValue(
      new ForbiddenError(`API key missing required scope '${SCOPE_MESSAGES_SEND}'`),
    )
    const req = makeReq({ body: validBody })
    const res = await POST(req)
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('forbidden')
  })
})

// ---------------------------------------------------------------
// Testes de validação de body
// ---------------------------------------------------------------

describe('POST /api/v1/messages/send — validação de body', () => {
  beforeEach(() => {
    // Auth ok pra esses testes
    vi.mocked(apiKeyCtx.resolveApiKey).mockResolvedValue(fakeApiKeyCtx)
  })

  it('JSON malformado → 400 bad_request', async () => {
    const req = new NextRequest('http://localhost/api/v1/messages/send', {
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

  it('conversation_id inválido (não é UUID) → 422 com details', async () => {
    const req = makeReq({
      body: { conversation_id: 'nao-e-uuid', message_type: 'text', content_text: 'oi' },
    })
    const res = await POST(req)
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.code).toBe('validation_error')
    expect(Array.isArray(body.details)).toBe(true)
    expect(body.details.some((d: { field: string }) => d.field === 'conversation_id')).toBe(true)
  })

  it('body sem campos obrigatórios → 422', async () => {
    const req = makeReq({ body: {} })
    const res = await POST(req)
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.code).toBe('validation_error')
  })
})

// ---------------------------------------------------------------
// Testes do happy path
// ---------------------------------------------------------------

describe('POST /api/v1/messages/send — happy path', () => {
  beforeEach(() => {
    vi.mocked(apiKeyCtx.resolveApiKey).mockResolvedValue(fakeApiKeyCtx)
  })

  it('chama sendMessageToConversation com os campos corretos e retorna 200', async () => {
    vi.mocked(sendMessageMod.sendMessageToConversation).mockResolvedValue({
      ok: true,
      message_id: 'msg-abc-123',
      whatsapp_message_id: 'wamid.xyz',
    })

    const req = makeReq({ body: validBody })
    const res = await POST(req)

    expect(res.status).toBe(200)
    const respBody = await res.json()
    expect(respBody.success).toBe(true)
    expect(respBody.message_id).toBe('msg-abc-123')
    expect(respBody.whatsapp_message_id).toBe('wamid.xyz')

    // Verifica que sendMessageToConversation foi chamado com os campos corretos.
    expect(sendMessageMod.sendMessageToConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: fakeApiKeyCtx.accountId,
        conversation_id: VALID_UUID,
        message_type: 'text',
        content_text: 'Olá, teste!',
      }),
    )
  })

  it('sendMessageToConversation retorna erro → repassa status e error', async () => {
    vi.mocked(sendMessageMod.sendMessageToConversation).mockResolvedValue({
      ok: false,
      status: 404,
      error: 'Conversation not found',
    })

    const req = makeReq({ body: validBody })
    const res = await POST(req)

    expect(res.status).toBe(404)
    const respBody = await res.json()
    expect(respBody.error).toBe('Conversation not found')
  })
})

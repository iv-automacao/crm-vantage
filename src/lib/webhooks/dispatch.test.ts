import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildMessageReceivedPayload, dispatchMessageReceived, type MessageReceivedPayload } from './dispatch'
import type { SupabaseClient } from '@supabase/supabase-js'

// Fake admin client factory
function makeAdmin(endpoints: { id: string; url: string; secret: string }[] | null = []) {
  const eqInner = vi.fn().mockResolvedValue({ data: endpoints, error: null })
  const eqOuter = vi.fn().mockReturnValue({ eq: eqInner })
  const select = vi.fn().mockReturnValue({ eq: eqOuter })
  const from = vi.fn().mockReturnValue({ select })
  return { from } as unknown as SupabaseClient
}

const baseContact = { id: 'c1', phone: '+5592999999999', name: 'Teste' }
const basePayload: MessageReceivedPayload = {
  event: 'message.received',
  account_id: 'acc1',
  conversation_id: 'conv1',
  contact: baseContact,
  state: { bot_paused: false, assigned_agent_id: null, conversation_status: 'open' },
  meta: { message: { text: 'oi' }, contact: {}, metadata: {} },
}

describe('buildMessageReceivedPayload', () => {
  it('monta o objeto com event message.received e bloco state', () => {
    const result = buildMessageReceivedPayload({
      accountId: 'acc1',
      conversationId: 'conv1',
      contact: baseContact,
      state: { bot_paused: true, assigned_agent_id: 'agent-9', conversation_status: 'pending' },
      metaMessage: { text: 'oi' },
      metaContact: {},
      metaMetadata: {},
    })
    expect(result.event).toBe('message.received')
    expect(result.account_id).toBe('acc1')
    expect(result.conversation_id).toBe('conv1')
    expect(result.contact).toEqual(baseContact)
    expect(result.state).toEqual({ bot_paused: true, assigned_agent_id: 'agent-9', conversation_status: 'pending' })
    expect(result.meta).toEqual({ message: { text: 'oi' }, contact: {}, metadata: {} })
  })
})

describe('dispatchMessageReceived', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('1 endpoint ativo → fetch chamado 1x com token e body corretos', async () => {
    const secret = 'whsec_test123'
    const admin = makeAdmin([{ id: 'ep1', url: 'https://n8n.example.com/webhook/abc', secret }])

    await dispatchMessageReceived(admin, 'acc1', basePayload)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://n8n.example.com/webhook/abc')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify(basePayload))
    expect(init.headers['x-webhook-token']).toBe(secret)
    expect(init.headers['x-webhook-signature']).toBeUndefined()
  })

  it('2 endpoints → 2 fetches', async () => {
    const admin = makeAdmin([
      { id: 'ep1', url: 'https://n8n.example.com/webhook/1', secret: 's1' },
      { id: 'ep2', url: 'https://n8n.example.com/webhook/2', secret: 's2' },
    ])

    await dispatchMessageReceived(admin, 'acc1', basePayload)

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('fetch lançando → dispatchMessageReceived NÃO lança (best-effort)', async () => {
    fetchMock.mockRejectedValue(new Error('Connection refused'))
    const admin = makeAdmin([{ id: 'ep1', url: 'https://n8n.example.com/webhook/fail', secret: 's' }])

    await expect(dispatchMessageReceived(admin, 'acc1', basePayload)).resolves.toBeUndefined()
  })

  it('nenhum endpoint → não chama fetch', async () => {
    const admin = makeAdmin([])

    await dispatchMessageReceived(admin, 'acc1', basePayload)

    expect(fetchMock).not.toHaveBeenCalled()
  })

  // Verifica os headers obrigatórios content-type e x-webhook-event no endpoint ativo
  it('1 endpoint ativo → headers content-type e x-webhook-event enviados corretamente', async () => {
    const secret = 'whsec_test123'
    const admin = makeAdmin([{ id: 'ep1', url: 'https://n8n.example.com/webhook/abc', secret }])

    await dispatchMessageReceived(admin, 'acc1', basePayload)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers['content-type']).toBe('application/json')
    expect(init.headers['x-webhook-event']).toBe('message.received')
  })

  // Resposta HTTP non-ok (500) não deve causar rejeição — comportamento best-effort
  it('resposta HTTP non-ok (500) → dispatch resolve sem lançar', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 })
    const admin = makeAdmin([{ id: 'ep1', url: 'https://n8n.example.com/webhook/fail500', secret: 's' }])

    await expect(dispatchMessageReceived(admin, 'acc1', basePayload)).resolves.toBeUndefined()
  })

  // Erro no lookup do Supabase → dispatch resolve sem chamar fetch (retorna antes de enviar)
  it('erro no lookup do Supabase → dispatch resolve e fetch NÃO é chamado', async () => {
    // Substitui makeAdmin para retornar erro simulado do banco
    const eqInner = vi.fn().mockResolvedValue({ data: null, error: { message: 'DB down' } })
    const eqOuter = vi.fn().mockReturnValue({ eq: eqInner })
    const select = vi.fn().mockReturnValue({ eq: eqOuter })
    const from = vi.fn().mockReturnValue({ select })
    const adminComErro = { from } as unknown as import('@supabase/supabase-js').SupabaseClient

    await expect(dispatchMessageReceived(adminComErro, 'acc1', basePayload)).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('endpoint com URL interna (SSRF) → fetch NÃO é chamado pra ele', async () => {
    const admin = makeAdmin([{ id: 'epbad', url: 'http://169.254.169.254/latest', secret: 's' }])

    await dispatchMessageReceived(admin, 'acc1', basePayload)

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetch é chamado com redirect:manual (não segue redirect pra interno)', async () => {
    const admin = makeAdmin([{ id: 'ep1', url: 'https://n8n.example.com/webhook/abc', secret: 's' }])

    await dispatchMessageReceived(admin, 'acc1', basePayload)

    const [, init] = fetchMock.mock.calls[0]
    expect(init.redirect).toBe('manual')
  })
})

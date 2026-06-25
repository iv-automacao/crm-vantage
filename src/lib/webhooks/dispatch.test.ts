import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildMessageReceivedPayload, dispatchMessageReceived, type MessageReceivedPayload } from './dispatch'
import { signWebhookPayload } from './signature'
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
  meta: { message: { text: 'oi' }, contact: {}, metadata: {} },
}

describe('buildMessageReceivedPayload', () => {
  it('monta o objeto com event message.received', () => {
    const result = buildMessageReceivedPayload({
      accountId: 'acc1',
      conversationId: 'conv1',
      contact: baseContact,
      metaMessage: { text: 'oi' },
      metaContact: {},
      metaMetadata: {},
    })
    expect(result.event).toBe('message.received')
    expect(result.account_id).toBe('acc1')
    expect(result.conversation_id).toBe('conv1')
    expect(result.contact).toEqual(baseContact)
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

  it('1 endpoint ativo → fetch chamado 1x com assinatura e body corretos', async () => {
    const secret = 'whsec_test123'
    const admin = makeAdmin([{ id: 'ep1', url: 'https://n8n.example.com/webhook/abc', secret }])

    await dispatchMessageReceived(admin, 'acc1', basePayload)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://n8n.example.com/webhook/abc')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify(basePayload))
    expect(init.headers['x-webhook-signature']).toBe(
      signWebhookPayload(JSON.stringify(basePayload), secret),
    )
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
})

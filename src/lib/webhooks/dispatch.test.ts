import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  buildMessageEventPayload,
  dispatchMessageEvent,
  buildMessageReceivedPayload,
  dispatchMessageReceived,
  type MessageEventPayload,
} from './dispatch'
import { emptyConversationContext } from './enrich'
import type { SupabaseClient } from '@supabase/supabase-js'

// Fake admin client factory — mock-chain ROBUSTO (mesmo padrão do enrich.test):
// qualquer método de filtro (select/eq/is/order/limit) retorna o próprio
// builder; o lookup de endpoints termina com `.eq().eq()` que resolve a Promise
// (o builder é thenable). Não depende da PROFUNDIDADE/ORDEM dos filtros.
function makeAdmin(
  endpoints: { id: string; url: string; secret: string }[] | null = [],
  error: unknown = null,
) {
  const result = { data: endpoints, error }
  const builder: Record<string, unknown> = {}
  const chain = () => builder
  for (const m of ['select', 'eq', 'is', 'order', 'limit']) builder[m] = vi.fn(chain)
  // O dispatch faz `await admin.from(...).select(...).eq(...).eq(...)` — o
  // último `.eq()` precisa resolver. Tornamos o builder thenable.
  builder.then = (resolve: (v: typeof result) => unknown) => resolve(result)
  const from = vi.fn(() => builder)
  return { from } as unknown as SupabaseClient
}

const baseContact = { id: 'c1', phone: '+5592999999999', name: 'Teste' }

// Payload base de OUTBOUND (message.sent) — usado nos testes de entrega.
const baseSentPayload: MessageEventPayload = buildMessageEventPayload({
  event: 'message.sent',
  direction: 'out',
  accountId: 'acc1',
  conversationId: 'conv1',
  sender: { type: 'agent', via: 'inbox', actor_id: 'user-7', actor_name: null, api_key_id: null },
  contact: baseContact,
  context: emptyConversationContext(),
  message: {
    id: 'm1',
    whatsapp_message_id: 'wamid.X',
    content_type: 'text',
    content_text: 'oi',
    created_at: '2026-06-28T17:00:00Z',
  },
  timestamp: '2026-06-28T17:00:00Z',
})

describe('buildMessageEventPayload', () => {
  it('outbound: monta message.sent com direction:out, sender e bloco message', () => {
    expect(baseSentPayload.event).toBe('message.sent')
    expect(baseSentPayload.direction).toBe('out')
    expect(baseSentPayload.sender).toEqual({
      type: 'agent', via: 'inbox', actor_id: 'user-7', actor_name: null, api_key_id: null,
    })
    expect(baseSentPayload.message.whatsapp_message_id).toBe('wamid.X')
    expect(baseSentPayload.timestamp).toBe('2026-06-28T17:00:00Z')
    // outbound NÃO carrega meta cru.
    expect(baseSentPayload.meta).toBeUndefined()
  })

  it('inbound: meta presente quando passado; contact enriquecido', () => {
    const ctx = emptyConversationContext()
    ctx.contact.tags = ['lead']
    const p = buildMessageEventPayload({
      event: 'message.received',
      direction: 'in',
      accountId: 'acc1',
      conversationId: 'conv1',
      sender: { type: 'customer', via: 'meta', actor_id: null, actor_name: null, api_key_id: null },
      contact: baseContact,
      context: ctx,
      message: { id: 'm2', whatsapp_message_id: 'wamid.Y', content_type: 'text', content_text: 'olá', created_at: '2026-06-28T17:05:00Z' },
      meta: { message: { text: 'olá' }, contact: {}, metadata: {} },
    })
    expect(p.direction).toBe('in')
    expect(p.contact.tags).toEqual(['lead'])
    expect(p.meta).toEqual({ message: { text: 'olá' }, contact: {}, metadata: {} })
  })

  it('timestamp default é gerado quando omitido', () => {
    const p = buildMessageEventPayload({
      event: 'message.sent',
      direction: 'out',
      accountId: 'a', conversationId: 'c',
      sender: { type: 'bot', via: 'automation', actor_id: null, actor_name: null, api_key_id: null },
      contact: baseContact,
      context: emptyConversationContext(),
      message: { id: null, whatsapp_message_id: null, content_type: 'text', content_text: 'x', created_at: null },
    })
    expect(typeof p.timestamp).toBe('string')
    expect(p.timestamp.length).toBeGreaterThan(0)
  })
})

describe('buildMessageReceivedPayload (compat legado)', () => {
  it('monta event message.received com direction:in, sender meta e meta cru', () => {
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
    expect(result.direction).toBe('in')
    expect(result.sender.via).toBe('meta')
    expect(result.state.bot_paused).toBe(true)
    expect(result.state.assigned_agent_id).toBe('agent-9')
    expect(result.state.conversation_status).toBe('pending')
    expect(result.meta).toEqual({ message: { text: 'oi' }, contact: {}, metadata: {} })
  })
})

describe('dispatchMessageEvent', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('1 endpoint ativo → fetch 1x com token, body e header x-webhook-event=message.sent', async () => {
    const secret = 'whsec_test123'
    const admin = makeAdmin([{ id: 'ep1', url: 'https://n8n.example.com/webhook/abc', secret }])

    await dispatchMessageEvent(admin, 'acc1', baseSentPayload)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://n8n.example.com/webhook/abc')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify(baseSentPayload))
    expect(init.headers['content-type']).toBe('application/json')
    expect(init.headers['x-webhook-event']).toBe('message.sent')
    expect(init.headers['x-webhook-token']).toBe(secret)
    expect(init.headers['x-webhook-signature']).toBeUndefined()
  })

  it('header x-webhook-event reflete message.received quando o evento é inbound', async () => {
    const admin = makeAdmin([{ id: 'ep1', url: 'https://n8n.example.com/webhook/abc', secret: 's' }])
    const inbound = buildMessageReceivedPayload({
      accountId: 'acc1', conversationId: 'conv1', contact: baseContact,
      state: { bot_paused: false, assigned_agent_id: null, conversation_status: 'open' },
      metaMessage: {}, metaContact: {}, metaMetadata: {},
    })

    await dispatchMessageEvent(admin, 'acc1', inbound)

    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers['x-webhook-event']).toBe('message.received')
  })

  it('2 endpoints → 2 fetches', async () => {
    const admin = makeAdmin([
      { id: 'ep1', url: 'https://n8n.example.com/webhook/1', secret: 's1' },
      { id: 'ep2', url: 'https://n8n.example.com/webhook/2', secret: 's2' },
    ])
    await dispatchMessageEvent(admin, 'acc1', baseSentPayload)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('fetch lançando → NÃO lança (best-effort)', async () => {
    fetchMock.mockRejectedValue(new Error('Connection refused'))
    const admin = makeAdmin([{ id: 'ep1', url: 'https://n8n.example.com/webhook/fail', secret: 's' }])
    await expect(dispatchMessageEvent(admin, 'acc1', baseSentPayload)).resolves.toBeUndefined()
  })

  it('nenhum endpoint → não chama fetch', async () => {
    const admin = makeAdmin([])
    await dispatchMessageEvent(admin, 'acc1', baseSentPayload)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('resposta HTTP non-ok (500) → resolve sem lançar', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 })
    const admin = makeAdmin([{ id: 'ep1', url: 'https://n8n.example.com/webhook/fail500', secret: 's' }])
    await expect(dispatchMessageEvent(admin, 'acc1', baseSentPayload)).resolves.toBeUndefined()
  })

  it('erro no lookup do Supabase → resolve e fetch NÃO é chamado', async () => {
    const adminComErro = makeAdmin(null, { message: 'DB down' })
    await expect(dispatchMessageEvent(adminComErro, 'acc1', baseSentPayload)).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('endpoint com URL interna (SSRF) → fetch NÃO é chamado', async () => {
    const admin = makeAdmin([{ id: 'epbad', url: 'http://169.254.169.254/latest', secret: 's' }])
    await dispatchMessageEvent(admin, 'acc1', baseSentPayload)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetch é chamado com redirect:manual', async () => {
    const admin = makeAdmin([{ id: 'ep1', url: 'https://n8n.example.com/webhook/abc', secret: 's' }])
    await dispatchMessageEvent(admin, 'acc1', baseSentPayload)
    const [, init] = fetchMock.mock.calls[0]
    expect(init.redirect).toBe('manual')
  })

  it('integração builder+dispatch: body serializado carrega o contexto enriquecido', async () => {
    // Contexto NÃO-vazio: tags, agente com nome (via 2b), deal não-null e
    // ctwa_clid. Confirma que buildMessageEventPayload + dispatch entregam tudo
    // no corpo do POST (o n8n lê isto pra decidir).
    const context = emptyConversationContext()
    context.contact.tags = ['lead']
    context.contact.ctwa_clid = 'clid-abc'
    context.state.assigned_agent_id = 'user-7'
    context.state.assigned_agent_name = 'Ana Vendas'
    context.deal = {
      id: 'deal-1', title: 'Civic 2020', value: 75000, currency: 'BRL',
      stage: 'Negociação', pipeline: 'Vendas', status: 'active',
    }
    const enriched = buildMessageEventPayload({
      event: 'message.sent',
      direction: 'out',
      accountId: 'acc1',
      conversationId: 'conv1',
      sender: { type: 'agent', via: 'inbox', actor_id: 'user-7', actor_name: null, api_key_id: null },
      contact: baseContact,
      context,
      message: { id: 'm1', whatsapp_message_id: 'wamid.Z', content_type: 'text', content_text: 'oi', created_at: '2026-06-28T17:00:00Z' },
      timestamp: '2026-06-28T17:00:00Z',
    })
    const admin = makeAdmin([{ id: 'ep1', url: 'https://n8n.example.com/webhook/abc', secret: 's' }])

    await dispatchMessageEvent(admin, 'acc1', enriched)

    const [, init] = fetchMock.mock.calls[0]
    const sent = JSON.parse(init.body as string)
    expect(sent.contact.tags).toEqual(['lead'])
    expect(sent.contact.ctwa_clid).toBe('clid-abc')
    expect(sent.state.assigned_agent_name).toBe('Ana Vendas')
    expect(sent.deal).toEqual({
      id: 'deal-1', title: 'Civic 2020', value: 75000, currency: 'BRL',
      stage: 'Negociação', pipeline: 'Vendas', status: 'active',
    })
  })
})

describe('dispatchMessageReceived (compat legado)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })
  afterEach(() => vi.restoreAllMocks())

  it('delega pra dispatchMessageEvent (1 fetch, header message.received)', async () => {
    const admin = makeAdmin([{ id: 'ep1', url: 'https://n8n.example.com/webhook/abc', secret: 's' }])
    const inbound = buildMessageReceivedPayload({
      accountId: 'acc1', conversationId: 'conv1', contact: baseContact,
      state: { bot_paused: false, assigned_agent_id: null, conversation_status: 'open' },
      metaMessage: {}, metaContact: {}, metaMetadata: {},
    })
    await dispatchMessageReceived(admin, 'acc1', inbound)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers['x-webhook-event']).toBe('message.received')
  })
})

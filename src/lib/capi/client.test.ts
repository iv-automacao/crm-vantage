import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendConversionEvent, type ConversionEvent } from './client'

const base: ConversionEvent = {
  datasetId: 'ds_123',
  accessToken: 'tok_secret',
  eventName: 'Purchase',
  eventId: 'deal-1',
  eventTimeUnix: 1_700_000_000,
  ctwaClid: 'clid_abc',
  wabaId: 'waba_9',
  value: 1500,
  currency: 'BRL',
}

afterEach(() => vi.restoreAllMocks())

describe('sendConversionEvent', () => {
  it('faz POST pro dataset com o payload CTWA correto', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ events_received: 1 }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await sendConversionEvent(base)

    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://graph.facebook.com/v21.0/ds_123/events')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.access_token).toBe('tok_secret')
    expect(body.data[0]).toMatchObject({
      event_name: 'Purchase',
      event_time: 1_700_000_000,
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      event_id: 'deal-1',
      user_data: { ctwa_clid: 'clid_abc', whatsapp_business_account_id: 'waba_9' },
      custom_data: { currency: 'BRL', value: '1500' },
    })
  })

  it('omite waba_id e custom_data quando ausentes/zerados', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await sendConversionEvent({ ...base, wabaId: null, value: 0 })

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.data[0].user_data).toEqual({ ctwa_clid: 'clid_abc' })
    expect(body.data[0].custom_data).toBeUndefined()
  })

  it('devolve ok=false em erro HTTP sem lançar', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'bad token' } }), { status: 400 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await sendConversionEvent(base)
    expect(res.ok).toBe(false)
    expect(res.status).toBe(400)
  })

  it('devolve ok=false em falha de rede sem lançar', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const res = await sendConversionEvent(base)
    expect(res.ok).toBe(false)
    expect(res.status).toBe(0)
  })
})

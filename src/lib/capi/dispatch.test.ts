import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendMock = vi.fn()
vi.mock('./client', () => ({ sendConversionEvent: (...a: unknown[]) => sendMock(...a) }))

import { processPendingCapiEvents } from './dispatch'

// Builder de um admin Supabase falso, table-aware.
function makeAdmin(tables: Record<string, unknown>) {
  const updates: Record<string, unknown[]> = {}
  const admin = {
    from(table: string) {
      const chain: Record<string, unknown> = {}
      const ret = (v: unknown) => Object.assign(chain, v)
      ret({
        select: () => ret({
          or: () => ret({ order: () => ret({ limit: () => Promise.resolve({ data: tables[`${table}:list`] ?? [], error: null }) }) }),
          eq: () => ret({ maybeSingle: () => Promise.resolve({ data: tables[`${table}:one`] ?? null, error: null }) }),
        }),
        update: (payload: unknown) => {
          ;(updates[table] ??= []).push(payload)
          return ret({ eq: () => Promise.resolve({ error: null }) })
        },
      })
      return chain
    },
  }
  return { admin: admin as never, updates }
}

beforeEach(() => sendMock.mockReset())

describe('processPendingCapiEvents', () => {
  const ev = { id: 'e1', account_id: 'a1', deal_id: 'd1', contact_id: 'c1', value: 1500, currency: 'BRL', attempts: 0, created_at: '2026-06-25T12:00:00Z' }

  it('envia e marca sent quando conta ativa + contato com ctwa_clid', async () => {
    sendMock.mockResolvedValue({ ok: true, status: 200, body: { events_received: 1 } })
    const { admin, updates } = makeAdmin({
      'capi_events:list': [ev],
      'capi_settings:one': { dataset_id: 'ds', access_token: 'tok', event_name: 'Purchase', is_active: true },
      'contacts:one': { ctwa_clid: 'clid_1' },
      'whatsapp_config:one': { waba_id: 'waba_9' },
    })
    const res = await processPendingCapiEvents(admin)
    expect(res).toEqual({ processed: 1, sent: 1, skipped: 0, failed: 0 })
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'd1', ctwaClid: 'clid_1', wabaId: 'waba_9', eventTimeUnix: 1782388800 }))
    expect(updates['capi_events'][0]).toMatchObject({ status: 'sent', attempts: 1 })
  })

  it('marca skipped/capi_inactive quando conta sem CAPI ativo', async () => {
    const { admin, updates } = makeAdmin({ 'capi_events:list': [ev], 'capi_settings:one': { is_active: false } })
    const res = await processPendingCapiEvents(admin)
    expect(res.skipped).toBe(1)
    expect(updates['capi_events'][0]).toMatchObject({ status: 'skipped', last_error: 'capi_inactive' })
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('marca skipped/no_ctwa_clid quando contato sem click-id', async () => {
    const { admin, updates } = makeAdmin({
      'capi_events:list': [ev],
      'capi_settings:one': { dataset_id: 'ds', access_token: 'tok', event_name: 'Purchase', is_active: true },
      'contacts:one': { ctwa_clid: null },
    })
    const res = await processPendingCapiEvents(admin)
    expect(res.skipped).toBe(1)
    expect(updates['capi_events'][0]).toMatchObject({ status: 'skipped', last_error: 'no_ctwa_clid' })
  })

  it('marca failed + incrementa attempts quando a Meta rejeita', async () => {
    sendMock.mockResolvedValue({ ok: false, status: 400, body: { error: 'bad' } })
    const { admin, updates } = makeAdmin({
      'capi_events:list': [{ ...ev, attempts: 2 }],
      'capi_settings:one': { dataset_id: 'ds', access_token: 'tok', event_name: 'Purchase', is_active: true },
      'contacts:one': { ctwa_clid: 'clid_1' },
      'whatsapp_config:one': { waba_id: null },
    })
    const res = await processPendingCapiEvents(admin)
    expect(res.failed).toBe(1)
    expect(updates['capi_events'][0]).toMatchObject({ status: 'failed', attempts: 3, last_error: 'http_400' })
  })
})

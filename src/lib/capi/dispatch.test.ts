import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendMock = vi.fn()
vi.mock('./client', () => ({ sendConversionEvent: (...a: unknown[]) => sendMock(...a) }))

import { processPendingCapiEvents } from './dispatch'

// Admin Supabase falso, table-aware, ciente do claim atômico.
// - select().or().order().limit()  → lista (<tabela>:list)
// - select().eq().maybeSingle()    → linha única (<tabela>:one)
// - update().eq()                  → update terminal (await direto; grava em `updates`)
// - update().eq().in().or().select().maybeSingle() → claim (resultado em `claimResults`)
function makeAdmin(
  tables: Record<string, unknown>,
  claimResults?: Array<{ id: string } | null>,
) {
  const updates: Record<string, unknown[]> = {}
  const claims: Array<{ payload: Record<string, unknown>; statusIn?: unknown; or?: string }> = []
  let claimIdx = 0

  function from(table: string) {
    return {
      select: () => ({
        or: () => ({
          order: () => ({
            limit: () => Promise.resolve({ data: tables[`${table}:list`] ?? [], error: null }),
          }),
        }),
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: tables[`${table}:one`] ?? null, error: null }),
        }),
      }),
      update: (payload: Record<string, unknown>) => {
        const rec: { payload: Record<string, unknown>; statusIn?: unknown; or?: string } = { payload }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const claimChain: any = {
          in: (_c: string, vals: unknown) => { rec.statusIn = vals; return claimChain },
          or: (f: string) => { rec.or = f; return claimChain },
          select: () => claimChain,
          maybeSingle: () => {
            claims.push(rec)
            const r = claimResults ? (claimResults[claimIdx++] ?? null) : { id: table }
            return Promise.resolve({ data: r, error: null })
          },
        }
        // .eq() serve aos dois caminhos: terminal (await direto) e claim (encadeia .in)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const eqResult: any = {
          ...claimChain,
          then: (onF: (v: { error: null }) => unknown) => {
            ;(updates[table] ??= []).push(payload)
            return Promise.resolve({ error: null }).then(onF)
          },
        }
        return { eq: () => eqResult }
      },
    }
  }
  return { admin: { from } as never, updates, claims }
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

  // ── Novos: claim atômico ──────────────────────────────────────────────

  it('não envia quando o claim falha (linha já pega por outra execução)', async () => {
    sendMock.mockResolvedValue({ ok: true, status: 200, body: {} })
    const { admin, updates } = makeAdmin(
      {
        'capi_events:list': [ev],
        'capi_settings:one': { dataset_id: 'ds', access_token: 'tok', event_name: 'Purchase', is_active: true },
        'contacts:one': { ctwa_clid: 'clid_1' },
      },
      [null], // claim retorna null → contenção
    )
    const res = await processPendingCapiEvents(admin)
    expect(res).toEqual({ processed: 0, sent: 0, skipped: 0, failed: 0 })
    expect(sendMock).not.toHaveBeenCalled()
    expect(updates['capi_events']).toBeUndefined()
  })

  it('failed zera claimed_at pra a linha voltar elegível', async () => {
    sendMock.mockResolvedValue({ ok: false, status: 400, body: { error: 'bad' } })
    const { admin, updates } = makeAdmin({
      'capi_events:list': [{ ...ev, attempts: 2 }],
      'capi_settings:one': { dataset_id: 'ds', access_token: 'tok', event_name: 'Purchase', is_active: true },
      'contacts:one': { ctwa_clid: 'clid_1' },
      'whatsapp_config:one': { waba_id: null },
    })
    await processPendingCapiEvents(admin)
    expect(updates['capi_events'][0]).toMatchObject({ status: 'failed', attempts: 3, claimed_at: null })
  })

  it('emite o claim com claimed_at + filtro de expiração antes de enviar', async () => {
    sendMock.mockResolvedValue({ ok: true, status: 200, body: {} })
    const { admin, claims } = makeAdmin({
      'capi_events:list': [ev],
      'capi_settings:one': { dataset_id: 'ds', access_token: 'tok', event_name: 'Purchase', is_active: true },
      'contacts:one': { ctwa_clid: 'clid_1' },
      'whatsapp_config:one': { waba_id: 'waba_9' },
    })
    await processPendingCapiEvents(admin)
    expect(claims).toHaveLength(1)
    expect(typeof claims[0].payload.claimed_at).toBe('string')
    expect(claims[0].statusIn).toEqual(['pending', 'failed'])
    expect(claims[0].or).toContain('claimed_at.is.null')
    expect(claims[0].or).toContain('claimed_at.lt.')
  })
})

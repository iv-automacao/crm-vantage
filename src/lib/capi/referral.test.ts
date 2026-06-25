// src/lib/capi/referral.test.ts
import { describe, expect, it, vi } from 'vitest'
import { captureCtwaReferral } from './referral'

function fakeAdmin() {
  const update = vi.fn().mockReturnThis()
  const eq = vi.fn().mockResolvedValue({ error: null })
  const from = vi.fn(() => ({ update, eq }))
  return { client: { from } as never, update, eq, from }
}

describe('captureCtwaReferral', () => {
  it('persiste ctwa_clid + referral quando presente', async () => {
    const a = fakeAdmin()
    const message = { referral: { ctwa_clid: 'clid_1', source_id: 'ad_9', headline: 'Promo' } }

    await captureCtwaReferral(a.client, 'contact-1', message)

    expect(a.from).toHaveBeenCalledWith('contacts')
    const payload = a.update.mock.calls[0][0]
    expect(payload.ctwa_clid).toBe('clid_1')
    expect(payload.referral).toEqual(message.referral)
    expect(payload.referral_captured_at).toEqual(expect.any(String))
    expect(a.eq).toHaveBeenCalledWith('id', 'contact-1')
  })

  it('não faz nada quando não há referral/ctwa_clid', async () => {
    const a = fakeAdmin()
    await captureCtwaReferral(a.client, 'contact-1', { text: { body: 'oi' } })
    expect(a.from).not.toHaveBeenCalled()
  })

  it('não lança quando o update falha (best-effort)', async () => {
    const a = fakeAdmin()
    a.eq.mockResolvedValueOnce({ error: { message: 'boom' } })
    await expect(
      captureCtwaReferral(a.client, 'contact-1', { referral: { ctwa_clid: 'clid_1' } }),
    ).resolves.toBeUndefined()
  })
})

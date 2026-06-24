import { describe, expect, it } from 'vitest'
import { BroadcastSendBody } from './broadcasts'

describe('BroadcastSendBody', () => {
  it('exige template_name', () => {
    const result = BroadcastSendBody.safeParse({
      recipients: [{ phone: '5592999999999' }],
    })
    expect(result.success).toBe(false)
  })

  it('exige recipients não-vazio', () => {
    const result = BroadcastSendBody.safeParse({
      template_name: 'promo',
      recipients: [],
    })
    expect(result.success).toBe(false)
  })

  it('rejeita mais de 200 destinatários', () => {
    const result = BroadcastSendBody.safeParse({
      template_name: 'promo',
      recipients: Array.from({ length: 201 }, (_, i) => ({ phone: `559299999${String(i).padStart(4, '0')}` })),
    })
    expect(result.success).toBe(false)
  })

  it('template_language default é "en_US"', () => {
    const result = BroadcastSendBody.safeParse({
      template_name: 'promo',
      recipients: [{ phone: '5592999999999' }],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.template_language).toBe('en_US')
    }
  })

  it('aceita recipients com phone e params', () => {
    const result = BroadcastSendBody.safeParse({
      template_name: 'promo',
      recipients: [{ phone: '5592999999999', params: ['João'] }],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.recipients[0].params).toEqual(['João'])
    }
  })

  it('aceita até 200 destinatários', () => {
    const result = BroadcastSendBody.safeParse({
      template_name: 'promo',
      recipients: Array.from({ length: 200 }, (_, i) => ({ phone: `559299999${String(i).padStart(4, '0')}` })),
    })
    expect(result.success).toBe(true)
  })
})

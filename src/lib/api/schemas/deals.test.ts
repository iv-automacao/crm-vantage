import { describe, expect, it } from 'vitest'
import { DealCreateBody, DealPatchBody, DealContactQuery } from './deals'

describe('DealCreateBody', () => {
  const base = { pipeline: 'Vendas', stage: 'Prospecção', title: 'Novo cliente' }

  it('aceita com contact_phone', () => {
    const result = DealCreateBody.safeParse({ ...base, contact_phone: '+5592999999999' })
    expect(result.success).toBe(true)
  })

  it('aceita com contact_id (uuid)', () => {
    const result = DealCreateBody.safeParse({ ...base, contact_id: '550e8400-e29b-41d4-a716-446655440000' })
    expect(result.success).toBe(true)
  })

  it('aceita com value opcional', () => {
    const result = DealCreateBody.safeParse({ ...base, contact_phone: '+5592999999999', value: 1500 })
    expect(result.success).toBe(true)
  })

  it('rejeita quando nem contact_phone nem contact_id enviado', () => {
    const result = DealCreateBody.safeParse({ ...base })
    expect(result.success).toBe(false)
  })

  it('rejeita quando contact_phone e contact_id enviados juntos', () => {
    const result = DealCreateBody.safeParse({
      ...base,
      contact_phone: '+5592999999999',
      contact_id: '550e8400-e29b-41d4-a716-446655440000',
    })
    expect(result.success).toBe(false)
  })

  it('rejeita value negativo', () => {
    const result = DealCreateBody.safeParse({ ...base, contact_phone: '+5592999999999', value: -1 })
    expect(result.success).toBe(false)
  })

  it('rejeita title vazio', () => {
    const result = DealCreateBody.safeParse({ ...base, contact_phone: '+5592999999999', title: '' })
    expect(result.success).toBe(false)
  })
})

describe('DealPatchBody', () => {
  it('rejeita objeto vazio', () => {
    const result = DealPatchBody.safeParse({})
    expect(result.success).toBe(false)
  })

  it('aceita só status', () => {
    const result = DealPatchBody.safeParse({ status: 'won' })
    expect(result.success).toBe(true)
  })

  it('aceita só stage', () => {
    const result = DealPatchBody.safeParse({ stage: 'Fechado' })
    expect(result.success).toBe(true)
  })

  it('aceita combinação de campos', () => {
    const result = DealPatchBody.safeParse({ status: 'lost', value: 0 })
    expect(result.success).toBe(true)
  })

  it('rejeita status inválido', () => {
    const result = DealPatchBody.safeParse({ status: 'cancelado' })
    expect(result.success).toBe(false)
  })
})

describe('DealContactQuery', () => {
  it('aceita só contact_phone', () => {
    const result = DealContactQuery.safeParse({ contact_phone: '+5592999999999' })
    expect(result.success).toBe(true)
  })

  it('aceita só contact_id', () => {
    const result = DealContactQuery.safeParse({ contact_id: '550e8400-e29b-41d4-a716-446655440000' })
    expect(result.success).toBe(true)
  })

  it('rejeita quando ambos enviados', () => {
    const result = DealContactQuery.safeParse({
      contact_phone: '+5592999999999',
      contact_id: '550e8400-e29b-41d4-a716-446655440000',
    })
    expect(result.success).toBe(false)
  })

  it('rejeita quando nenhum enviado', () => {
    const result = DealContactQuery.safeParse({})
    expect(result.success).toBe(false)
  })
})

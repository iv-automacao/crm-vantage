import { describe, expect, it } from 'vitest'
import { ContactUpsertBody, ContactPatchBody, ContactPhoneQuery } from './contacts'

describe('ContactUpsertBody', () => {
  it('exige phone', () => {
    expect(ContactUpsertBody.safeParse({ name: 'x' }).success).toBe(false)
  })
  it('aceita phone + tags + custom_fields', () => {
    const r = ContactUpsertBody.safeParse({
      phone: '5592999999999', name: 'João',
      tags: ['cliente'], custom_fields: [{ name: 'modelo', value: 'Onix' }],
    })
    expect(r.success).toBe(true)
  })
  it('rejeita email inválido', () => {
    expect(ContactUpsertBody.safeParse({ phone: '559299', email: 'x' }).success).toBe(false)
  })
})

describe('ContactPatchBody', () => {
  it('rejeita objeto vazio', () => {
    expect(ContactPatchBody.safeParse({}).success).toBe(false)
  })
  it('aceita ao menos um campo', () => {
    expect(ContactPatchBody.safeParse({ name: 'Maria' }).success).toBe(true)
  })
})

describe('ContactPhoneQuery', () => {
  it('exige phone', () => {
    expect(ContactPhoneQuery.safeParse({}).success).toBe(false)
  })
  it('aceita phone válido', () => {
    expect(ContactPhoneQuery.safeParse({ phone: '5592999999999' }).success).toBe(true)
  })
})

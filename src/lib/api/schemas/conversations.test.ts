import { describe, expect, it } from 'vitest'
import { ConversationContactQuery, MessageListQuery } from './conversations'

describe('ConversationContactQuery', () => {
  it('rejeita objeto vazio (nenhum dos dois enviado)', () => {
    const result = ConversationContactQuery.safeParse({})
    expect(result.success).toBe(false)
  })

  it('rejeita quando contact_phone e contact_id enviados juntos', () => {
    const result = ConversationContactQuery.safeParse({
      contact_phone: '+5592999999999',
      contact_id: '550e8400-e29b-41d4-a716-446655440000',
    })
    expect(result.success).toBe(false)
  })

  it('aceita quando só contact_phone enviado', () => {
    const result = ConversationContactQuery.safeParse({ contact_phone: '+5592999999999' })
    expect(result.success).toBe(true)
  })

  it('aceita quando só contact_id (uuid) enviado', () => {
    const result = ConversationContactQuery.safeParse({
      contact_id: '550e8400-e29b-41d4-a716-446655440000',
    })
    expect(result.success).toBe(true)
  })

  it('rejeita contact_id inválido (não é uuid)', () => {
    const result = ConversationContactQuery.safeParse({ contact_id: 'nao-e-uuid' })
    expect(result.success).toBe(false)
  })

  it('rejeita contact_phone curto demais (< 5 chars)', () => {
    const result = ConversationContactQuery.safeParse({ contact_phone: '+55' })
    expect(result.success).toBe(false)
  })
})

describe('MessageListQuery', () => {
  it('usa limit=30 como default quando não enviado', () => {
    const result = MessageListQuery.safeParse({})
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.limit).toBe(30)
  })

  it('rejeita limit=200 (acima do máximo 100)', () => {
    const result = MessageListQuery.safeParse({ limit: 200 })
    expect(result.success).toBe(false)
  })

  it('rejeita limit=0 (abaixo do mínimo 1)', () => {
    const result = MessageListQuery.safeParse({ limit: 0 })
    expect(result.success).toBe(false)
  })

  it('rejeita before não-ISO (string inválida)', () => {
    const result = MessageListQuery.safeParse({ before: 'ontem' })
    expect(result.success).toBe(false)
  })

  it('aceita before no formato ISO 8601', () => {
    const result = MessageListQuery.safeParse({ before: '2024-01-15T10:30:00.000Z' })
    expect(result.success).toBe(true)
  })

  it('coerce converte string "10" para número 10', () => {
    const result = MessageListQuery.safeParse({ limit: '10' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.limit).toBe(10)
  })
})

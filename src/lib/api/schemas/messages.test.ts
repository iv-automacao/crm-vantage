import { describe, expect, it } from 'vitest'
import { SendMessageBody } from './messages'

// UUIDs válidos (versão 4) para uso nos testes — zod v4 valida versão e bits de variante.
const UUID_1 = '550e8400-e29b-41d4-a716-446655440001'
const UUID_2 = '550e8400-e29b-41d4-a716-446655440002'
const UUID_3 = '550e8400-e29b-41d4-a716-446655440003'
const UUID_4 = '550e8400-e29b-41d4-a716-446655440004'
const UUID_5 = '550e8400-e29b-41d4-a716-446655440005'
const UUID_6 = '550e8400-e29b-41d4-a716-446655440006'
const UUID_7 = '550e8400-e29b-41d4-a716-446655440007'
const UUID_8 = '550e8400-e29b-41d4-a716-446655440008'
const UUID_9 = '550e8400-e29b-41d4-a716-446655440009'

describe('SendMessageBody', () => {
  it('parse válido — apenas conversation_id obrigatório', () => {
    const input = { conversation_id: UUID_1 }
    const result = SendMessageBody.safeParse(input)
    expect(result.success).toBe(true)
    if (result.success) {
      // message_type deve ter default 'text'
      expect(result.data.message_type).toBe('text')
      expect(result.data.conversation_id).toBe(UUID_1)
    }
  })

  it('parse válido — payload completo de mensagem de texto', () => {
    const input = {
      conversation_id: UUID_2,
      message_type: 'text',
      content_text: 'Olá, como posso ajudar?',
    }
    const result = SendMessageBody.safeParse(input)
    expect(result.success).toBe(true)
  })

  it('parse válido — mensagem de imagem com media_url', () => {
    const input = {
      conversation_id: UUID_3,
      message_type: 'image',
      media_url: 'https://example.com/foto.jpg',
    }
    const result = SendMessageBody.safeParse(input)
    expect(result.success).toBe(true)
  })

  it('parse válido — mensagem de template com params', () => {
    const input = {
      conversation_id: UUID_4,
      message_type: 'template',
      template_name: 'boas_vindas',
      template_language: 'pt_BR',
      template_params: ['João', 'VANTAGE'],
      template_message_params: { header: 'Bem-vindo' },
    }
    const result = SendMessageBody.safeParse(input)
    expect(result.success).toBe(true)
  })

  it('inválido — conversation_id não é UUID', () => {
    const input = { conversation_id: 'nao-é-um-uuid' }
    const result = SendMessageBody.safeParse(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      const fields = result.error.issues.map((i) => i.path.join('.'))
      expect(fields).toContain('conversation_id')
    }
  })

  it('inválido — conversation_id ausente', () => {
    const result = SendMessageBody.safeParse({})
    expect(result.success).toBe(false)
  })

  it('inválido — message_type com valor fora do enum', () => {
    const input = {
      conversation_id: UUID_5,
      message_type: 'sticker', // não suportado
    }
    const result = SendMessageBody.safeParse(input)
    expect(result.success).toBe(false)
    if (!result.success) {
      const fields = result.error.issues.map((i) => i.path.join('.'))
      expect(fields).toContain('message_type')
    }
  })

  it('inválido — content_text excede 4096 chars', () => {
    const input = {
      conversation_id: UUID_6,
      content_text: 'x'.repeat(4097),
    }
    const result = SendMessageBody.safeParse(input)
    expect(result.success).toBe(false)
  })

  it('inválido — media_url não é URL válida', () => {
    const input = {
      conversation_id: UUID_7,
      media_url: 'nao-é-uma-url',
    }
    const result = SendMessageBody.safeParse(input)
    expect(result.success).toBe(false)
  })

  it('inválido — reply_to_message_id não é UUID', () => {
    const input = {
      conversation_id: UUID_8,
      reply_to_message_id: 'nao-uuid',
    }
    const result = SendMessageBody.safeParse(input)
    expect(result.success).toBe(false)
  })

  it('default message_type = text mesmo com undefined explícito', () => {
    const input = {
      conversation_id: UUID_9,
      message_type: undefined,
    }
    const result = SendMessageBody.safeParse(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.message_type).toBe('text')
    }
  })
})

import { z } from 'zod'

/**
 * Query para buscar conversas de um contato.
 * Exige exatamente um de contact_phone ou contact_id.
 */
export const ConversationContactQuery = z
  .object({
    contact_phone: z.string().min(5).optional(),
    contact_id: z.string().uuid().optional(),
  })
  .refine((v) => !!v.contact_phone !== !!v.contact_id, {
    message: 'Envie exatamente um de contact_phone ou contact_id',
  })
  .meta({ id: 'ConversationContactQuery' })

/**
 * Query de paginação de mensagens — cursor-based (before = timestamp ISO).
 * limit usa z.coerce.number() para aceitar query string ("30" → 30).
 */
export const MessageListQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(30),
    before: z.string().datetime().optional(),
  })
  .meta({ id: 'MessageListQuery' })

export type ConversationContactQuery = z.infer<typeof ConversationContactQuery>
export type MessageListQuery = z.infer<typeof MessageListQuery>

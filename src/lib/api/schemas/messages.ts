import { z } from 'zod'

// Espelha exatamente o que sendMessageToConversation aceita hoje.
export const SendMessageBody = z
  .object({
    conversation_id: z.string().uuid(),
    message_type: z
      .enum(['text', 'template', 'image', 'video', 'document', 'audio'])
      .default('text'),
    content_text: z.string().max(4096).optional(),
    media_url: z.string().url().optional(),
    filename: z.string().max(255).optional(),
    template_name: z.string().optional(),
    template_language: z.string().optional(),
    template_params: z.array(z.unknown()).optional(),
    template_message_params: z.unknown().optional(),
    reply_to_message_id: z.string().uuid().optional(),
  })
  .meta({ id: 'SendMessageBody' })

export type SendMessageBody = z.infer<typeof SendMessageBody>

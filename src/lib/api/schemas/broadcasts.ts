import { z } from 'zod'

const Recipient = z.object({
  phone: z.string().min(5),
  params: z.array(z.string()).optional(),
})

export const BroadcastSendBody = z
  .object({
    template_name: z.string().min(1),
    template_language: z.string().min(2).default('en_US'),
    recipients: z.array(Recipient).min(1).max(200),
  })
  .meta({ id: 'BroadcastSendBody' })

export type BroadcastSendBody = z.infer<typeof BroadcastSendBody>

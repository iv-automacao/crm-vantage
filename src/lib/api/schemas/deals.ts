import { z } from 'zod'

export const DealCreateBody = z
  .object({
    contact_phone: z.string().min(5).optional(),
    contact_id: z.string().uuid().optional(),
    pipeline: z.string().min(1),
    stage: z.string().min(1),
    title: z.string().min(1).max(200),
    value: z.number().nonnegative().optional(),
  })
  .refine((v) => !!v.contact_phone !== !!v.contact_id, {
    message: 'Envie exatamente um de contact_phone ou contact_id',
  })
  .meta({ id: 'DealCreateBody' })

export const DealPatchBody = z
  .object({
    stage: z.string().min(1).optional(),
    status: z.enum(['open', 'won', 'lost']).optional(),
    value: z.number().nonnegative().optional(),
    title: z.string().min(1).max(200).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Envie ao menos um campo' })
  .meta({ id: 'DealPatchBody' })

export const DealContactQuery = z
  .object({
    contact_phone: z.string().min(5).optional(),
    contact_id: z.string().uuid().optional(),
  })
  .refine((v) => !!v.contact_phone !== !!v.contact_id, {
    message: 'Envie exatamente um de contact_phone ou contact_id',
  })
  .meta({ id: 'DealContactQuery' })

export type DealCreateBody = z.infer<typeof DealCreateBody>
export type DealPatchBody = z.infer<typeof DealPatchBody>
export type DealContactQuery = z.infer<typeof DealContactQuery>

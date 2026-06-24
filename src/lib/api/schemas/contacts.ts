import { z } from 'zod'

const CustomFieldPair = z.object({
  name: z.string().min(1),
  value: z.string(),
})

export const ContactUpsertBody = z
  .object({
    phone: z.string().min(5),
    name: z.string().max(200).optional(),
    email: z.string().email().optional(),
    company: z.string().max(200).optional(),
    tags: z.array(z.string().min(1)).optional(),
    custom_fields: z.array(CustomFieldPair).optional(),
  })
  .meta({ id: 'ContactUpsertBody' })

export const ContactPatchBody = z
  .object({
    name: z.string().max(200).optional(),
    email: z.string().email().optional(),
    company: z.string().max(200).optional(),
    tags: z.array(z.string().min(1)).optional(),
    custom_fields: z.array(CustomFieldPair).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Envie ao menos um campo' })
  .meta({ id: 'ContactPatchBody' })

export const ContactPhoneQuery = z
  .object({ phone: z.string().min(5) })
  .meta({ id: 'ContactPhoneQuery' })

export type ContactUpsertBody = z.infer<typeof ContactUpsertBody>
export type ContactPatchBody = z.infer<typeof ContactPatchBody>
export type ContactPhoneQuery = z.infer<typeof ContactPhoneQuery>

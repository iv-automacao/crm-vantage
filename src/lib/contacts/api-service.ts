/**
 * Camada de serviço para contatos via API externa.
 * Todas as operações são account-scoped — nunca acessa dados de outra conta.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { NotFoundError, UnknownFieldError, UnknownTagError } from '@/lib/api/errors'
import type { ContactUpsertBody, ContactPatchBody } from '@/lib/api/schemas/contacts'

// ─── Tipos públicos ──────────────────────────────────────────────────────────

export interface ContactResource {
  id: string
  phone: string
  name: string | null
  email: string | null
  company: string | null
  tags: string[]
  custom_fields: { name: string; value: string }[]
  created_at: string
  updated_at: string
}

/** Contexto injetado em todas as funções — jamais usar cliente anon aqui. */
export interface ApiServiceCtx {
  admin: SupabaseClient
  accountId: string
  auditUserId: string
}

// ─── Resolvers internos (exportados para testes) ──────────────────────────────

/**
 * Resolve nome de tag → id. Lança UnknownTagError (422) se não encontrar.
 * Query sempre filtrada por account_id para não vazar dados entre contas.
 */
export async function resolveTagIdByName(ctx: ApiServiceCtx, name: string): Promise<string> {
  const { data, error } = await ctx.admin
    .from('tags')
    .select('id')
    .eq('account_id', ctx.accountId)
    .eq('name', name)
    .maybeSingle()

  if (error) throw error
  if (!data) throw new UnknownTagError(name)
  return (data as { id: string }).id
}

/**
 * Resolve nome de campo customizado → id. Lança UnknownFieldError (422) se não encontrar.
 * Query sempre filtrada por account_id.
 */
export async function resolveFieldIdByName(ctx: ApiServiceCtx, name: string): Promise<string> {
  const { data, error } = await ctx.admin
    .from('custom_fields')
    .select('id')
    .eq('account_id', ctx.accountId)
    .eq('field_name', name)
    .maybeSingle()

  if (error) throw error
  if (!data) throw new UnknownFieldError(name)
  return (data as { id: string }).id
}

// ─── Helpers de leitura ───────────────────────────────────────────────────────

/**
 * Busca um contato completo (com tags e campos customizados) pelo id.
 * Lança NotFoundError se não existir ou pertencer a outra conta.
 */
export async function getContactById(ctx: ApiServiceCtx, contactId: string): Promise<ContactResource> {
  const { data, error } = await ctx.admin
    .from('contacts')
    .select(`
      id,
      phone,
      name,
      email,
      company,
      created_at,
      updated_at,
      contact_tags ( tags ( name ) ),
      contact_custom_values ( value, custom_fields ( field_name ) )
    `)
    .eq('id', contactId)
    .eq('account_id', ctx.accountId)
    .maybeSingle()

  if (error) throw error
  if (!data) throw new NotFoundError(`Contato ${contactId} não encontrado`)

  return toContactResource(data)
}

/**
 * Busca um contato pelo telefone. Retorna null se não existir.
 */
export async function findContactByPhone(
  ctx: ApiServiceCtx,
  phone: string,
): Promise<ContactResource | null> {
  const existing = await findExistingContact(ctx.admin, ctx.accountId, phone)
  if (!existing) return null
  return getContactById(ctx, existing.id)
}

// ─── Listagens ────────────────────────────────────────────────────────────────

export async function listTags(
  ctx: ApiServiceCtx,
): Promise<{ id: string; name: string; color: string | null }[]> {
  const { data, error } = await ctx.admin
    .from('tags')
    .select('id, name, color')
    .eq('account_id', ctx.accountId)
    .order('name')

  if (error) throw error
  return (data ?? []) as { id: string; name: string; color: string | null }[]
}

export async function listCustomFields(
  ctx: ApiServiceCtx,
): Promise<{ id: string; field_name: string; field_type: string; field_options: unknown }[]> {
  const { data, error } = await ctx.admin
    .from('custom_fields')
    .select('id, field_name, field_type, field_options')
    .eq('account_id', ctx.accountId)
    .order('field_name')

  if (error) throw error
  return (data ?? []) as { id: string; field_name: string; field_type: string; field_options: unknown }[]
}

// ─── Escritas ─────────────────────────────────────────────────────────────────

/**
 * Aplica uma tag a um contato via upsert idempotente.
 * Resolve o nome da tag antes de escrever.
 */
export async function applyTag(ctx: ApiServiceCtx, contactId: string, tagName: string): Promise<void> {
  const tagId = await resolveTagIdByName(ctx, tagName)
  const { error } = await ctx.admin
    .from('contact_tags')
    .upsert({ contact_id: contactId, tag_id: tagId }, { onConflict: 'contact_id,tag_id', ignoreDuplicates: true })

  if (error) throw error
}

/**
 * Seta (ou atualiza) um campo customizado para um contato.
 * Resolve o nome do campo antes de escrever.
 */
export async function setCustomField(
  ctx: ApiServiceCtx,
  contactId: string,
  fieldName: string,
  value: string,
): Promise<void> {
  const fieldId = await resolveFieldIdByName(ctx, fieldName)
  const { error } = await ctx.admin
    .from('contact_custom_values')
    .upsert(
      { contact_id: contactId, custom_field_id: fieldId, value },
      { onConflict: 'contact_id,custom_field_id' },
    )

  if (error) throw error
}

// ─── Upsert principal ─────────────────────────────────────────────────────────

/**
 * Cria ou atualiza um contato pelo telefone.
 *
 * Resolve TODOS os nomes de tags e campos ANTES de qualquer escrita
 * para garantir falha cedo (422) sem efeitos parciais.
 *
 * Fluxo:
 * 1. Resolve nomes → ids (falha rápido se algum não existir)
 * 2. findExistingContact → update ou insert
 * 3. Aplica tags e campos no contato resultante
 */
export async function upsertContactByPhone(
  ctx: ApiServiceCtx,
  body: ContactUpsertBody,
): Promise<ContactResource> {
  const { admin, accountId, auditUserId } = ctx
  const { phone, name, email, company, tags = [], custom_fields = [] } = body

  // ── Passo 1: resolver nomes antes de qualquer escrita ──────────────────────
  const tagIds = await Promise.all(tags.map((t) => resolveTagIdByName(ctx, t)))
  const fieldPairs = await Promise.all(
    custom_fields.map(async (cf) => ({
      fieldId: await resolveFieldIdByName(ctx, cf.name),
      value: cf.value,
    })),
  )

  // ── Passo 2: upsert do contato ─────────────────────────────────────────────
  let contactId: string

  const existing = await findExistingContact(admin, accountId, phone)

  if (existing) {
    // Atualiza os campos escalares (nunca seta phone_normalized — é gerado pelo DB)
    const { error } = await admin
      .from('contacts')
      .update({ name, email, company, updated_at: new Date().toISOString() })
      .eq('id', existing.id)
      .eq('account_id', accountId)

    if (error) throw error
    contactId = existing.id
  } else {
    // Insere novo contato — user_id NOT NULL, phone_normalized é gerado pelo DB
    const { data, error } = await admin
      .from('contacts')
      .insert({ account_id: accountId, user_id: auditUserId, phone, name, email, company })
      .select('id')
      .single()

    if (error) {
      // Corrida: outro insert ganhou — re-busca e atualiza
      if (isUniqueViolation(error)) {
        const raceExisting = await findExistingContact(admin, accountId, phone)
        if (raceExisting) {
          await admin
            .from('contacts')
            .update({ name, email, company, updated_at: new Date().toISOString() })
            .eq('id', raceExisting.id)
            .eq('account_id', accountId)
          contactId = raceExisting.id
        } else {
          throw error
        }
      } else {
        throw error
      }
    } else {
      contactId = (data as { id: string }).id
    }
  }

  // ── Passo 3: aplicar tags ─────────────────────────────────────────────────
  for (const tagId of tagIds) {
    const { error } = await admin
      .from('contact_tags')
      .upsert({ contact_id: contactId, tag_id: tagId }, { onConflict: 'contact_id,tag_id', ignoreDuplicates: true })
    if (error) throw error
  }

  // ── Passo 4: aplicar campos customizados ──────────────────────────────────
  for (const { fieldId, value } of fieldPairs) {
    const { error } = await admin
      .from('contact_custom_values')
      .upsert(
        { contact_id: contactId, custom_field_id: fieldId, value },
        { onConflict: 'contact_id,custom_field_id' },
      )
    if (error) throw error
  }

  return getContactById(ctx, contactId)
}

/**
 * Atualiza campos escalares e/ou tags/campos customizados de um contato existente.
 * Lança NotFoundError se o contato não pertencer à conta.
 */
export async function updateContact(
  ctx: ApiServiceCtx,
  contactId: string,
  patch: ContactPatchBody,
): Promise<ContactResource> {
  const { admin, accountId } = ctx
  const { tags, custom_fields, ...scalarFields } = patch

  // Verifica existência antes de resolver tags/campos (falha 404 cedo)
  const { data: existing, error: findError } = await admin
    .from('contacts')
    .select('id')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle()

  if (findError) throw findError
  if (!existing) throw new NotFoundError(`Contato ${contactId} não encontrado`)

  // Resolve nomes ANTES de escrever qualquer coisa
  const tagIds = await Promise.all((tags ?? []).map((t) => resolveTagIdByName(ctx, t)))
  const fieldPairs = await Promise.all(
    (custom_fields ?? []).map(async (cf) => ({
      fieldId: await resolveFieldIdByName(ctx, cf.name),
      value: cf.value,
    })),
  )

  // Atualiza campos escalares se houver
  if (Object.keys(scalarFields).length > 0) {
    const { error } = await admin
      .from('contacts')
      .update({ ...scalarFields, updated_at: new Date().toISOString() })
      .eq('id', contactId)
      .eq('account_id', accountId)

    if (error) throw error
  }

  // Aplica tags
  for (const tagId of tagIds) {
    const { error } = await admin
      .from('contact_tags')
      .upsert({ contact_id: contactId, tag_id: tagId }, { onConflict: 'contact_id,tag_id', ignoreDuplicates: true })
    if (error) throw error
  }

  // Aplica campos customizados
  for (const { fieldId, value } of fieldPairs) {
    const { error } = await admin
      .from('contact_custom_values')
      .upsert(
        { contact_id: contactId, custom_field_id: fieldId, value },
        { onConflict: 'contact_id,custom_field_id' },
      )
    if (error) throw error
  }

  return getContactById(ctx, contactId)
}

// ─── Conversor interno ────────────────────────────────────────────────────────

/** Converte uma linha raw do Supabase (com joins) para ContactResource. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toContactResource(row: any): ContactResource {
  // contact_tags → tags(name) pode vir como array de objetos ou null
  const tags: string[] = (row.contact_tags ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((ct: any) => ct.tags?.name)
    .filter(Boolean)

  // contact_custom_values → custom_fields(field_name), value
  const custom_fields: { name: string; value: string }[] = (row.contact_custom_values ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((cv: any) => ({
      name: cv.custom_fields?.field_name ?? '',
      value: cv.value ?? '',
    }))
    .filter((cf: { name: string; value: string }) => cf.name)

  return {
    id: row.id,
    phone: row.phone,
    name: row.name ?? null,
    email: row.email ?? null,
    company: row.company ?? null,
    tags,
    custom_fields,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

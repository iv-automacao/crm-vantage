// ============================================================
// POST /api/v1/contacts — upsert de contato por telefone
// GET  /api/v1/contacts?phone= — busca por telefone
//
// Autenticação por Bearer token (API key).
// POST requer contacts:write, GET requer contacts:read.
// Rate limit por conta.
// ============================================================

import { NextResponse } from 'next/server'
import { defineRoute, type ResolvedCtx } from '@/lib/api/handler'
import type { ApiKeyContext } from '@/lib/auth/api-key-context'
import { SCOPE_CONTACTS_WRITE, SCOPE_CONTACTS_READ } from '@/lib/auth/api-keys'
import { ContactUpsertBody, ContactPhoneQuery } from '@/lib/api/schemas/contacts'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { upsertContactByPhone, findContactByPhone } from '@/lib/contacts/api-service'

// Extrai o ApiKeyContext tipado do contexto resolvido.
function apiKeyOf(ctx: ResolvedCtx): ApiKeyContext {
  return (ctx as Extract<ResolvedCtx, { auth: 'apiKey' }>).apiKey
}

// Monta o ServiceCtx a partir do ApiKeyContext.
function svcCtx(k: ApiKeyContext) {
  return {
    admin: k.supabase,
    accountId: k.accountId,
    auditUserId: k.createdByUserId ?? k.ownerUserId,
  }
}

export const POST = defineRoute({
  auth: { type: 'apiKey', scopes: [SCOPE_CONTACTS_WRITE] },
  body: ContactUpsertBody,
  rateLimit: {
    preset: RATE_LIMITS.contactsWrite,
    key: (ctx) => `contactsWrite:${apiKeyOf(ctx).accountId}`,
  },
  openapi: {
    summary: 'Criar/atualizar contato por telefone',
    tags: ['Contacts'],
    operationId: 'upsertContact',
  },
  handler: async ({ body, ctx }) => {
    const contact = await upsertContactByPhone(svcCtx(apiKeyOf(ctx)), body)
    return NextResponse.json({ contact }, { status: 201 })
  },
})

export const GET = defineRoute({
  auth: { type: 'apiKey', scopes: [SCOPE_CONTACTS_READ] },
  query: ContactPhoneQuery,
  rateLimit: {
    preset: RATE_LIMITS.contactsRead,
    key: (ctx) => `contactsRead:${apiKeyOf(ctx).accountId}`,
  },
  openapi: {
    summary: 'Buscar contato por telefone',
    tags: ['Contacts'],
    operationId: 'findContactByPhone',
  },
  handler: async ({ query, ctx }) => {
    const contact = await findContactByPhone(svcCtx(apiKeyOf(ctx)), query.phone)
    return NextResponse.json({ contact })
  },
})

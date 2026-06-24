// ============================================================
// GET  /api/v1/contacts/[id] — obtém contato pelo id
// PATCH /api/v1/contacts/[id] — atualiza contato
//
// Autenticação por Bearer token (API key).
// GET requer contacts:read, PATCH requer contacts:write.
// O id é extraído do pathname da URL (seguro com Next 16).
// Rate limit por conta.
// ============================================================

import { NextResponse } from 'next/server'
import { defineRoute, type ResolvedCtx } from '@/lib/api/handler'
import type { ApiKeyContext } from '@/lib/auth/api-key-context'
import { SCOPE_CONTACTS_READ, SCOPE_CONTACTS_WRITE } from '@/lib/auth/api-keys'
import { ContactPatchBody } from '@/lib/api/schemas/contacts'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { getContactById, updateContact } from '@/lib/contacts/api-service'
import { ApiBadRequestError } from '@/lib/api/errors'

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

// Extrai o último segmento não-vazio do pathname.
// Filtra segmentos vazios para lidar com trailing slash (/contacts/<id>/)
// sem retornar string vazia que geraria um 404 confuso.
function extractId(req: Request): string {
  const id = new URL(req.url).pathname.split('/').filter(Boolean).pop()
  if (!id) throw new ApiBadRequestError('id do contato ausente')
  return id
}

export const GET = defineRoute({
  auth: { type: 'apiKey', scopes: [SCOPE_CONTACTS_READ] },
  rateLimit: {
    preset: RATE_LIMITS.contactsRead,
    key: (ctx) => `contactsRead:${apiKeyOf(ctx).accountId}`,
  },
  openapi: {
    summary: 'Obter contato por id',
    tags: ['Contacts'],
    operationId: 'getContact',
  },
  handler: async ({ ctx, req }) => {
    const id = extractId(req)
    const contact = await getContactById(svcCtx(apiKeyOf(ctx)), id)
    return NextResponse.json({ contact })
  },
})

export const PATCH = defineRoute({
  auth: { type: 'apiKey', scopes: [SCOPE_CONTACTS_WRITE] },
  body: ContactPatchBody,
  rateLimit: {
    preset: RATE_LIMITS.contactsWrite,
    key: (ctx) => `contactsWrite:${apiKeyOf(ctx).accountId}`,
  },
  openapi: {
    summary: 'Atualizar contato',
    tags: ['Contacts'],
    operationId: 'patchContact',
  },
  handler: async ({ body, ctx, req }) => {
    const id = extractId(req)
    const contact = await updateContact(svcCtx(apiKeyOf(ctx)), id, body)
    return NextResponse.json({ contact })
  },
})

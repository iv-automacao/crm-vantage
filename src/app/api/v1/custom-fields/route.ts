// ============================================================
// GET /api/v1/custom-fields — lista todos os campos customizados da conta
//
// Autenticação por Bearer token (API key) com contacts:read.
// Rate limit por conta.
// ============================================================

import { NextResponse } from 'next/server'
import { defineRoute, type ResolvedCtx } from '@/lib/api/handler'
import type { ApiKeyContext } from '@/lib/auth/api-key-context'
import { SCOPE_CONTACTS_READ } from '@/lib/auth/api-keys'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { listCustomFields } from '@/lib/contacts/api-service'

// Extrai o ApiKeyContext tipado do contexto resolvido.
function apiKeyOf(ctx: ResolvedCtx): ApiKeyContext {
  return (ctx as Extract<ResolvedCtx, { auth: 'apiKey' }>).apiKey
}

export const GET = defineRoute({
  auth: { type: 'apiKey', scopes: [SCOPE_CONTACTS_READ] },
  rateLimit: {
    preset: RATE_LIMITS.contactsRead,
    key: (ctx) => `contactsRead:${apiKeyOf(ctx).accountId}`,
  },
  openapi: {
    summary: 'Listar campos customizados',
    tags: ['Contacts'],
    operationId: 'listCustomFields',
  },
  handler: async ({ ctx }) => {
    const k = apiKeyOf(ctx)
    const custom_fields = await listCustomFields({ admin: k.supabase, accountId: k.accountId, auditUserId: k.createdByUserId ?? k.ownerUserId })
    return NextResponse.json({ custom_fields })
  },
})

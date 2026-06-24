// ============================================================
// GET /api/v1/conversations?contact_phone= ou ?contact_id= — conversas de um contato
//
// Autenticação por Bearer token (API key).
// GET requer conversations:read.
// accountId/auditUserId SEMPRE da chave — nunca do body/query.
// Rate limit por conta.
// ============================================================

import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/handler'
import { apiKeyServiceCtx } from '@/lib/api/service-context'
import { SCOPE_CONVERSATIONS_READ } from '@/lib/auth/api-keys'
import { ConversationContactQuery } from '@/lib/api/schemas/conversations'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { findConversationsByContact } from '@/lib/conversations/api-service'

export const GET = defineRoute({
  auth: { type: 'apiKey', scopes: [SCOPE_CONVERSATIONS_READ] },
  query: ConversationContactQuery,
  rateLimit: {
    preset: RATE_LIMITS.conversationsRead,
    key: (ctx) => `conversationsRead:${apiKeyServiceCtx(ctx).accountId}`,
  },
  openapi: {
    summary: 'Conversas de um contato',
    tags: ['Conversations'],
    operationId: 'findConversationsByContact',
  },
  handler: async ({ query, ctx }) => {
    const conversations = await findConversationsByContact(apiKeyServiceCtx(ctx), query)
    return NextResponse.json({ conversations })
  },
})

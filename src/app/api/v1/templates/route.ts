// ============================================================
// GET /api/v1/templates  — listar templates aprovados da conta
//
// Autenticação por Bearer token (API key).
// Requer escopo broadcasts:send.
// accountId SEMPRE da chave — nunca da query.
// ============================================================

import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/handler'
import { apiKeyServiceCtx } from '@/lib/api/service-context'
import { SCOPE_BROADCASTS_SEND } from '@/lib/auth/api-keys'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { listApprovedTemplates } from '@/lib/broadcasts/api-service'

export const GET = defineRoute({
  auth: { type: 'apiKey', scopes: [SCOPE_BROADCASTS_SEND] },
  rateLimit: {
    preset: RATE_LIMITS.broadcastSend,
    key: (ctx) => `broadcastSend:${apiKeyServiceCtx(ctx).accountId}`,
  },
  openapi: {
    summary: 'Listar templates aprovados',
    tags: ['Broadcasts'],
    operationId: 'listTemplates',
  },
  handler: async ({ ctx }) => {
    const templates = await listApprovedTemplates(apiKeyServiceCtx(ctx))
    return NextResponse.json({ templates })
  },
})

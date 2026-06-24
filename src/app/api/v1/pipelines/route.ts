// ============================================================
// GET /api/v1/pipelines — lista pipelines e etapas da conta
//
// Autenticação por Bearer token (API key).
// Requer deals:read.
// Retorna { pipelines } com etapas ordenadas por posição.
// Rate limit por conta.
// ============================================================

import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/handler'
import { apiKeyServiceCtx } from '@/lib/api/service-context'
import { SCOPE_DEALS_READ } from '@/lib/auth/api-keys'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { listPipelines } from '@/lib/deals/api-service'

export const GET = defineRoute({
  auth: { type: 'apiKey', scopes: [SCOPE_DEALS_READ] },
  rateLimit: {
    preset: RATE_LIMITS.dealsRead,
    key: (ctx) => `dealsRead:${apiKeyServiceCtx(ctx).accountId}`,
  },
  openapi: {
    summary: 'Listar pipelines e etapas',
    tags: ['Deals'],
    operationId: 'listPipelines',
  },
  handler: async ({ ctx }) => {
    const pipelines = await listPipelines(apiKeyServiceCtx(ctx))
    return NextResponse.json({ pipelines })
  },
})

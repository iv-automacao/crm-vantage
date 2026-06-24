// ============================================================
// POST /api/v1/deals  — criar negócio
// GET  /api/v1/deals?contact_phone= ou ?contact_id= — listar negócios de um contato
//
// Autenticação por Bearer token (API key).
// POST requer deals:write, GET requer deals:read.
// accountId/auditUserId SEMPRE da chave — nunca do body/query.
// Rate limit por conta.
// ============================================================

import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/handler'
import { apiKeyServiceCtx } from '@/lib/api/service-context'
import { SCOPE_DEALS_WRITE, SCOPE_DEALS_READ } from '@/lib/auth/api-keys'
import { DealCreateBody, DealContactQuery } from '@/lib/api/schemas/deals'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { createDeal, listDealsByContact } from '@/lib/deals/api-service'

export const POST = defineRoute({
  auth: { type: 'apiKey', scopes: [SCOPE_DEALS_WRITE] },
  body: DealCreateBody,
  rateLimit: {
    preset: RATE_LIMITS.dealsWrite,
    key: (ctx) => `dealsWrite:${apiKeyServiceCtx(ctx).accountId}`,
  },
  openapi: {
    summary: 'Criar negócio',
    tags: ['Deals'],
    operationId: 'createDeal',
  },
  handler: async ({ body, ctx }) => {
    const deal = await createDeal(apiKeyServiceCtx(ctx), body)
    return NextResponse.json({ deal }, { status: 201 })
  },
})

export const GET = defineRoute({
  auth: { type: 'apiKey', scopes: [SCOPE_DEALS_READ] },
  query: DealContactQuery,
  rateLimit: {
    preset: RATE_LIMITS.dealsRead,
    key: (ctx) => `dealsRead:${apiKeyServiceCtx(ctx).accountId}`,
  },
  openapi: {
    summary: 'Listar negócios de um contato',
    tags: ['Deals'],
    operationId: 'listDealsByContact',
  },
  handler: async ({ query, ctx }) => {
    const deals = await listDealsByContact(apiKeyServiceCtx(ctx), query)
    return NextResponse.json({ deals })
  },
})

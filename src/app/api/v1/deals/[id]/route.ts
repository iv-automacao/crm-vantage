// ============================================================
// GET   /api/v1/deals/[id] — obtém negócio pelo id
// PATCH /api/v1/deals/[id] — atualiza negócio (etapa/status/valor/título)
//
// Autenticação por Bearer token (API key).
// GET requer deals:read, PATCH requer deals:write.
// O id é extraído do pathname da URL (seguro com Next 16).
// accountId/auditUserId SEMPRE da chave — nunca do body/URL.
// Rate limit por conta.
// ============================================================

import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/handler'
import { apiKeyServiceCtx } from '@/lib/api/service-context'
import { SCOPE_DEALS_READ, SCOPE_DEALS_WRITE } from '@/lib/auth/api-keys'
import { DealPatchBody } from '@/lib/api/schemas/deals'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { getDealById, updateDeal } from '@/lib/deals/api-service'
import { ApiBadRequestError } from '@/lib/api/errors'

// Extrai o último segmento não-vazio do pathname.
// Filtra segmentos vazios para lidar com trailing slash (/deals/<id>/)
// sem retornar string vazia que geraria um 404 confuso.
function extractId(req: Request): string {
  const id = new URL(req.url).pathname.split('/').filter(Boolean).pop()
  if (!id) throw new ApiBadRequestError('id do negócio ausente')
  return id
}

export const GET = defineRoute({
  auth: { type: 'apiKey', scopes: [SCOPE_DEALS_READ] },
  rateLimit: {
    preset: RATE_LIMITS.dealsRead,
    key: (ctx) => `dealsRead:${apiKeyServiceCtx(ctx).accountId}`,
  },
  openapi: {
    summary: 'Obter negócio por id',
    tags: ['Deals'],
    operationId: 'getDeal',
  },
  handler: async ({ ctx, req }) => {
    const id = extractId(req)
    const deal = await getDealById(apiKeyServiceCtx(ctx), id)
    return NextResponse.json({ deal })
  },
})

export const PATCH = defineRoute({
  auth: { type: 'apiKey', scopes: [SCOPE_DEALS_WRITE] },
  body: DealPatchBody,
  rateLimit: {
    preset: RATE_LIMITS.dealsWrite,
    key: (ctx) => `dealsWrite:${apiKeyServiceCtx(ctx).accountId}`,
  },
  openapi: {
    summary: 'Atualizar negócio (etapa/status/valor/título)',
    tags: ['Deals'],
    operationId: 'patchDeal',
  },
  handler: async ({ body, ctx, req }) => {
    const id = extractId(req)
    const deal = await updateDeal(apiKeyServiceCtx(ctx), id, body)
    return NextResponse.json({ deal })
  },
})

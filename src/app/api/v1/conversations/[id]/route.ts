// ============================================================
// GET /api/v1/conversations/[id] — obtém conversa pelo id
//
// Autenticação por Bearer token (API key).
// GET requer conversations:read.
// O id é extraído do pathname da URL (seguro com Next 16).
// accountId/auditUserId SEMPRE da chave — nunca do body/URL.
// Rate limit por conta.
// ============================================================

import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/handler'
import { apiKeyServiceCtx } from '@/lib/api/service-context'
import { SCOPE_CONVERSATIONS_READ } from '@/lib/auth/api-keys'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { getConversationById } from '@/lib/conversations/api-service'
import { ApiBadRequestError } from '@/lib/api/errors'

// Extrai o último segmento não-vazio do pathname.
// Filtra segmentos vazios para lidar com trailing slash (/conversations/<id>/)
// sem retornar string vazia que geraria um 404 confuso.
function extractId(req: Request): string {
  const id = new URL(req.url).pathname.split('/').filter(Boolean).pop()
  if (!id) throw new ApiBadRequestError('id da conversa ausente')
  return id
}

export const GET = defineRoute({
  auth: { type: 'apiKey', scopes: [SCOPE_CONVERSATIONS_READ] },
  rateLimit: {
    preset: RATE_LIMITS.conversationsRead,
    key: (ctx) => `conversationsRead:${apiKeyServiceCtx(ctx).accountId}`,
  },
  openapi: {
    summary: 'Obter conversa',
    tags: ['Conversations'],
    operationId: 'getConversation',
  },
  handler: async ({ ctx, req }) => {
    const id = extractId(req)
    const conversation = await getConversationById(apiKeyServiceCtx(ctx), id)
    return NextResponse.json({ conversation })
  },
})

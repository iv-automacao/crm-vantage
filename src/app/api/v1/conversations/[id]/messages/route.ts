// ============================================================
// GET /api/v1/conversations/[id]/messages — histórico paginado de mensagens
//
// Autenticação por Bearer token (API key).
// GET requer conversations:read.
// O id da conversa é o PENÚLTIMO segmento do path (último é "messages").
// accountId/auditUserId SEMPRE da chave — nunca do body/URL.
// Rate limit por conta.
// Tenant gate: listMessages valida a conversa antes de acessar mensagens.
// ============================================================

import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/handler'
import { apiKeyServiceCtx } from '@/lib/api/service-context'
import { SCOPE_CONVERSATIONS_READ } from '@/lib/auth/api-keys'
import { MessageListQuery } from '@/lib/api/schemas/conversations'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { listMessages } from '@/lib/conversations/api-service'
import { ApiBadRequestError } from '@/lib/api/errors'

// Extrai o id da conversa: é o PENÚLTIMO segmento do path, pois o último é "messages".
// Exemplo: /api/v1/conversations/<id>/messages → segs[-2] = <id>
function extractConversationId(req: Request): string {
  const segs = new URL(req.url).pathname.split('/').filter(Boolean)
  const id = segs[segs.length - 2]
  if (!id) throw new ApiBadRequestError('id da conversa ausente')
  return id
}

export const GET = defineRoute({
  auth: { type: 'apiKey', scopes: [SCOPE_CONVERSATIONS_READ] },
  query: MessageListQuery,
  rateLimit: {
    preset: RATE_LIMITS.conversationsRead,
    key: (ctx) => `conversationsRead:${apiKeyServiceCtx(ctx).accountId}`,
  },
  openapi: {
    summary: 'Histórico de mensagens (paginado)',
    tags: ['Conversations'],
    operationId: 'listMessages',
  },
  handler: async ({ query, ctx, req }) => {
    const conversationId = extractConversationId(req)
    const result = await listMessages(apiKeyServiceCtx(ctx), conversationId, query)
    return NextResponse.json(result)
  },
})

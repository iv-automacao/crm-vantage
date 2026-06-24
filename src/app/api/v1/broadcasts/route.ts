// ============================================================
// POST /api/v1/broadcasts  — disparar broadcast via template aprovado
//
// Autenticação por Bearer token (API key).
// Requer escopo broadcasts:send.
// accountId/auditUserId SEMPRE da chave — nunca do body/query.
// Rate limit apertado por conta (custa $).
// Fan-out sequencial até 200 destinatários — maxDuration estendido.
// ============================================================

import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/handler'
import { apiKeyServiceCtx } from '@/lib/api/service-context'
import { SCOPE_BROADCASTS_SEND } from '@/lib/auth/api-keys'
import { BroadcastSendBody } from '@/lib/api/schemas/broadcasts'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { sendBroadcast } from '@/lib/broadcasts/api-service'

// Fan-out sequencial pode levar tempo com até 200 destinatários.
export const maxDuration = 300

export const POST = defineRoute({
  auth: { type: 'apiKey', scopes: [SCOPE_BROADCASTS_SEND] },
  body: BroadcastSendBody,
  rateLimit: {
    preset: RATE_LIMITS.broadcastSend,
    key: (ctx) => `broadcastSend:${apiKeyServiceCtx(ctx).accountId}`,
  },
  openapi: {
    summary: 'Disparar broadcast por template',
    tags: ['Broadcasts'],
    operationId: 'sendBroadcast',
  },
  handler: async ({ body, ctx }) => {
    const result = await sendBroadcast(apiKeyServiceCtx(ctx), body)
    return NextResponse.json(result)
  },
})

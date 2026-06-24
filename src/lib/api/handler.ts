import { timingSafeEqual } from 'node:crypto'
import { type NextRequest, NextResponse } from 'next/server'
import type { ZodType } from 'zod'
import {
  type AccountContext,
  requireActiveAccount,
  requireRole,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account'
import { requirePlatformAdmin } from '@/lib/auth/platform-admin'
import type { AccountRole } from '@/lib/auth/roles'
import { type RateLimitOptions, checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { resolveApiKey, type ApiKeyContext } from '@/lib/auth/api-key-context'
import { errorEnvelope, validationError } from '@/lib/api/errors'

// ------------------------------------------------------------
// Tipos de autenticação suportados pelo wrapper de rota.
// ------------------------------------------------------------

type AuthSpec =
  | { type: 'public' }
  | { type: 'session'; minRole?: AccountRole }
  | { type: 'apiKey'; scopes: string[] }
  | { type: 'platformAdmin' }
  | { type: 'webhook'; secretEnv: string; header: string }

export type ResolvedCtx =
  | { auth: 'public' }
  | { auth: 'session'; account: AccountContext }
  | { auth: 'apiKey'; apiKey: ApiKeyContext }
  | { auth: 'platformAdmin'; admin: Awaited<ReturnType<typeof requirePlatformAdmin>> }
  | { auth: 'webhook' }

// ------------------------------------------------------------
// Configuração de rota tipada.
// ------------------------------------------------------------

interface RouteConfig<B, Q> {
  auth: AuthSpec
  body?: ZodType<B>
  query?: ZodType<Q>
  rateLimit?: {
    preset: RateLimitOptions
    key: (ctx: ResolvedCtx, req: NextRequest) => string
  }
  openapi?: { summary: string; tags?: string[]; operationId?: string }
  handler: (args: { body: B; query: Q; ctx: ResolvedCtx; req: NextRequest }) => Promise<Response>
}

// Sentinela para distinguir JSON inválido de um body vazio/undefined.
const BAD_JSON = Symbol('bad_json')

// ------------------------------------------------------------
// Comparação tempo-constante de strings (evita timing attack
// no secret do webhook/cron).
// ------------------------------------------------------------

function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

// ------------------------------------------------------------
// Resolve o contexto de autenticação para o AuthSpec fornecido.
// ------------------------------------------------------------

async function resolveAuth(spec: AuthSpec, req: NextRequest): Promise<ResolvedCtx> {
  switch (spec.type) {
    case 'public':
      return { auth: 'public' }

    case 'session': {
      const account = spec.minRole
        ? await requireRole(spec.minRole)
        : await requireActiveAccount()
      return { auth: 'session', account }
    }

    case 'apiKey':
      return { auth: 'apiKey', apiKey: await resolveApiKey(req, spec.scopes) }

    case 'platformAdmin':
      return { auth: 'platformAdmin', admin: await requirePlatformAdmin() }

    case 'webhook': {
      const secret = process.env[spec.secretEnv]
      const provided = req.headers.get(spec.header)
      if (!secret || !provided || !timingSafeEqualStr(provided, secret)) {
        throw new UnauthorizedError('Invalid or missing webhook secret')
      }
      return { auth: 'webhook' }
    }
  }
}

// ------------------------------------------------------------
// defineRoute — único ponto de entrada para criar handlers de
// rota tipados. Exportar como named export de um route.ts:
//   export const POST = defineRoute({ ... })
// ------------------------------------------------------------

export function defineRoute<B = undefined, Q = undefined>(config: RouteConfig<B, Q>) {
  return async (req: NextRequest): Promise<Response> => {
    try {
      // 1) Autenticação / autorização
      const ctx = await resolveAuth(config.auth, req)

      // 2) Rate limit (opcional)
      if (config.rateLimit) {
        const r = checkRateLimit(config.rateLimit.key(ctx, req), config.rateLimit.preset)
        if (!r.success) return rateLimitResponse(r)
      }

      // 3) Parse do body JSON → 400 se malformado, 422 se inválido
      let body = undefined as B
      if (config.body) {
        const raw = await req.json().catch(() => BAD_JSON)
        if (raw === BAD_JSON) return errorEnvelope('bad_request', 'Corpo JSON inválido', 400)
        const parsed = config.body.safeParse(raw)
        if (!parsed.success) return validationError(parsed.error)
        body = parsed.data
      }

      // 4) Parse dos query params → 422 se inválidos
      let query = undefined as Q
      if (config.query) {
        const obj = Object.fromEntries(new URL(req.url).searchParams)
        const parsed = config.query.safeParse(obj)
        if (!parsed.success) return validationError(parsed.error)
        query = parsed.data
      }

      // 5) Chama o handler da rota
      return await config.handler({ body, query, ctx, req })
    } catch (err) {
      // 6) Funil único de erros lançados → toErrorResponse
      return toErrorResponse(err)
    }
  }
}

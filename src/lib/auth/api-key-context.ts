import type { NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { extractBearerToken, hashApiKey } from '@/lib/auth/api-keys'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { UnauthorizedError, ForbiddenError, AccountPendingError, type AccountStatus } from '@/lib/auth/account'

export interface ApiKeyContext {
  supabase: SupabaseClient   // admin (service role)
  apiKeyId: string
  accountId: string
  scopes: string[]
}

// ------------------------------------------------------------
// Validação pura pós-lookup — injetável nos testes sem rede.
// Recebe os campos relevantes e lança os erros tipados.
// ------------------------------------------------------------

/** @internal Extraído para facilitar testes unitários. */
export function validateApiKeyPayload(payload: {
  scopes: string[] | null
  accountStatus: string
  requiredScopes: string[]
}): string[] {
  // Conta precisa estar ativa — brecha fechada aqui.
  if (payload.accountStatus !== 'active') {
    throw new AccountPendingError(payload.accountStatus as AccountStatus)
  }

  const scopes = payload.scopes ?? []
  for (const s of payload.requiredScopes) {
    if (!scopes.includes(s)) {
      throw new ForbiddenError(`API key missing required scope '${s}'`)
    }
  }
  return scopes
}

// ------------------------------------------------------------
// Resolução completa: lê o bearer, consulta o banco, valida.
// ------------------------------------------------------------

export async function resolveApiKey(
  req: NextRequest | Request,
  requiredScopes: string[],
): Promise<ApiKeyContext> {
  const token = extractBearerToken(req.headers.get('authorization'))
  if (!token) throw new UnauthorizedError('Missing or malformed Authorization: Bearer header')

  const admin = supabaseAdmin()
  const { data: key, error } = await admin
    .from('api_keys')
    .select('id, account_id, scopes, revoked_at, account:accounts!inner(id, status)')
    .eq('token_hash', hashApiKey(token))
    .is('revoked_at', null)
    .maybeSingle()

  if (error) throw error                       // → 500 genérico via toErrorResponse
  if (!key) throw new UnauthorizedError('Invalid API key')

  // Normaliza o join — Supabase pode retornar array mesmo em !inner single.
  const acct = Array.isArray(key.account) ? key.account[0] : key.account

  const scopes = validateApiKeyPayload({
    scopes: key.scopes as string[] | null,
    accountStatus: acct.status,
    requiredScopes,
  })

  return { supabase: admin, apiKeyId: key.id, accountId: key.account_id, scopes }
}

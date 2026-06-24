import type { SupabaseClient } from '@supabase/supabase-js'
import type { ResolvedCtx } from '@/lib/api/handler'

/** Contexto que as camadas de serviço account-scoped recebem. */
export interface ApiServiceCtx {
  admin: SupabaseClient
  accountId: string
  auditUserId: string
}

/**
 * Deriva o ApiServiceCtx do ctx resolvido por uma rota apiKey.
 * Identidade SEMPRE da chave — nunca do corpo/URL. Auditoria cai
 * pro dono da conta quando a chave não tem criador rastreado.
 */
export function apiKeyServiceCtx(ctx: ResolvedCtx): ApiServiceCtx {
  const { apiKey } = ctx as Extract<ResolvedCtx, { auth: 'apiKey' }>
  return {
    admin: apiKey.supabase,
    accountId: apiKey.accountId,
    auditUserId: apiKey.createdByUserId ?? apiKey.ownerUserId,
  }
}

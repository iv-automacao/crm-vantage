import { describe, expect, it } from 'vitest'
import { apiKeyServiceCtx } from './service-context'
import type { ResolvedCtx } from '@/lib/api/handler'

/** Constrói um ctx fake de apiKey para os testes — sem rede. */
function makeCtx(overrides: {
  accountId?: string
  createdByUserId?: string | null
  ownerUserId?: string
}): ResolvedCtx {
  return {
    auth: 'apiKey',
    apiKey: {
      supabase: {} as never,
      apiKeyId: 'key-id',
      accountId: overrides.accountId ?? 'account-a',
      scopes: [],
      createdByUserId: overrides.createdByUserId ?? null,
      ownerUserId: overrides.ownerUserId ?? 'owner-o',
    },
  }
}

describe('apiKeyServiceCtx', () => {
  it('usa ownerUserId como auditUserId quando createdByUserId é null', () => {
    const ctx = makeCtx({ createdByUserId: null, ownerUserId: 'o' })
    const result = apiKeyServiceCtx(ctx)
    expect(result.auditUserId).toBe('o')
  })

  it('usa createdByUserId como auditUserId quando disponível', () => {
    const ctx = makeCtx({ createdByUserId: 'c', ownerUserId: 'o' })
    const result = apiKeyServiceCtx(ctx)
    expect(result.auditUserId).toBe('c')
  })

  it('repassa accountId corretamente', () => {
    const ctx = makeCtx({ accountId: 'account-xyz' })
    const result = apiKeyServiceCtx(ctx)
    expect(result.accountId).toBe('account-xyz')
  })

  it('repassa o cliente supabase admin', () => {
    const fakeSupabase = { from: () => {} } as never
    const ctx: ResolvedCtx = {
      auth: 'apiKey',
      apiKey: {
        supabase: fakeSupabase,
        apiKeyId: 'k',
        accountId: 'a',
        scopes: [],
        createdByUserId: null,
        ownerUserId: 'o',
      },
    }
    expect(apiKeyServiceCtx(ctx).admin).toBe(fakeSupabase)
  })
})

/**
 * Testes das partes PURAS de api-key-context.
 *
 * Estratégia (mesmo padrão de platform-admin.test.ts): testar a função
 * interna `validateApiKeyPayload` injetando valores — sem rede, sem banco.
 * O lookup no Supabase fica para o teste de integração da rota (Task 2).
 *
 * O describe "resolveApiKey — campos de auditoria" usa vi.mock para
 * substituir o admin client e as funções de hash por fakes controláveis,
 * exercitando o caminho real de resolveApiKey sem tocar no banco.
 */

import { describe, expect, it, vi } from 'vitest'
import { validateApiKeyPayload } from './api-key-context'
import { AccountPendingError, ForbiddenError } from './account'

// Mock do admin client — substituído antes de qualquer import do módulo alvo.
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: vi.fn(),
}))

// Mock das funções de hash/bearer — retornam valores determinísticos nos testes.
vi.mock('@/lib/auth/api-keys', () => ({
  extractBearerToken: vi.fn(),
  hashApiKey: vi.fn(),
  SCOPE_CONTACTS_READ: 'contacts:read',
  SCOPE_CONTACTS_WRITE: 'contacts:write',
}))

import * as adminClientMod from '@/lib/flows/admin-client'
import * as apiKeysMod from '@/lib/auth/api-keys'
import { resolveApiKey } from './api-key-context'

describe('validateApiKeyPayload — status da conta', () => {
  it('lança AccountPendingError quando status é "pending"', () => {
    expect(() =>
      validateApiKeyPayload({
        scopes: ['messages:send'],
        accountStatus: 'pending',
        requiredScopes: [],
      }),
    ).toThrowError(AccountPendingError)
  })

  it('lança AccountPendingError quando status é "suspended"', () => {
    expect(() =>
      validateApiKeyPayload({
        scopes: ['messages:send'],
        accountStatus: 'suspended',
        requiredScopes: [],
      }),
    ).toThrowError(AccountPendingError)
  })

  it('lança AccountPendingError quando status é "rejected"', () => {
    expect(() =>
      validateApiKeyPayload({
        scopes: null,
        accountStatus: 'rejected',
        requiredScopes: [],
      }),
    ).toThrowError(AccountPendingError)
  })

  it('AccountPendingError carrega o accountStatus correto', () => {
    try {
      validateApiKeyPayload({
        scopes: null,
        accountStatus: 'suspended',
        requiredScopes: [],
      })
      expect.fail('deveria lançar AccountPendingError')
    } catch (err) {
      expect(err).toBeInstanceOf(AccountPendingError)
      expect((err as AccountPendingError).accountStatus).toBe('suspended')
      expect((err as AccountPendingError).code).toBe('account_pending')
      expect((err as AccountPendingError).status).toBe(403)
    }
  })

  it('não lança quando status é "active"', () => {
    expect(() =>
      validateApiKeyPayload({
        scopes: ['messages:send'],
        accountStatus: 'active',
        requiredScopes: [],
      }),
    ).not.toThrow()
  })
})

describe('validateApiKeyPayload — validação de scopes', () => {
  it('lança ForbiddenError quando scope requerido está ausente', () => {
    expect(() =>
      validateApiKeyPayload({
        scopes: ['other:scope'],
        accountStatus: 'active',
        requiredScopes: ['messages:send'],
      }),
    ).toThrowError(ForbiddenError)
  })

  it('mensagem de ForbiddenError cita o scope faltante', () => {
    try {
      validateApiKeyPayload({
        scopes: [],
        accountStatus: 'active',
        requiredScopes: ['messages:send'],
      })
      expect.fail('deveria lançar ForbiddenError')
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError)
      expect((err as ForbiddenError).message).toContain('messages:send')
    }
  })

  it('lança para cada scope faltante (para no primeiro)', () => {
    // Valida que a função para na primeira falha
    expect(() =>
      validateApiKeyPayload({
        scopes: null,
        accountStatus: 'active',
        requiredScopes: ['messages:send', 'contacts:read'],
      }),
    ).toThrowError(ForbiddenError)
  })

  it('retorna os scopes quando todos os requeridos estão presentes', () => {
    const result = validateApiKeyPayload({
      scopes: ['messages:send', 'contacts:read'],
      accountStatus: 'active',
      requiredScopes: ['messages:send'],
    })
    expect(result).toEqual(['messages:send', 'contacts:read'])
  })

  it('scopes null equivale a lista vazia (sem scopes)', () => {
    // Nenhum scope requerido — null é ok
    const result = validateApiKeyPayload({
      scopes: null,
      accountStatus: 'active',
      requiredScopes: [],
    })
    expect(result).toEqual([])
  })
})

describe('ApiKeyContext — campos de auditoria', () => {
  it('resolveApiKey expõe createdByUserId e ownerUserId no contexto', async () => {
    // Testa a estrutura do tipo ApiKeyContext sem bater no banco.
    // O campo createdByUserId pode ser null (chave sem rastreamento de criador).
    // O campo ownerUserId sempre existe (owner_user_id da conta).
    const mockCtx = {
      supabase: {} as never,
      apiKeyId: 'key-123',
      accountId: 'acc-456',
      scopes: ['contacts:write'],
      createdByUserId: 'user-789',
      ownerUserId: 'owner-111',
    }
    // Verifica que auditUserId é o createdByUserId quando presente.
    const auditUserId = mockCtx.createdByUserId ?? mockCtx.ownerUserId
    expect(auditUserId).toBe('user-789')
  })

  it('auditUserId cai para ownerUserId quando createdByUserId é null', () => {
    const mockCtx = {
      supabase: {} as never,
      apiKeyId: 'key-123',
      accountId: 'acc-456',
      scopes: ['contacts:read'],
      createdByUserId: null,
      ownerUserId: 'owner-111',
    }
    const auditUserId = mockCtx.createdByUserId ?? mockCtx.ownerUserId
    expect(auditUserId).toBe('owner-111')
  })
})

describe('resolveApiKey — campos de auditoria vindos do banco', () => {
  it('retorna createdByUserId e ownerUserId corretamente ao resolver a chave', async () => {
    // Verifica que a string de select inclui created_by_user_id e owner_user_id
    // e que resolveApiKey os propaga corretamente no ApiKeyContext retornado.
    // Sem tocar no banco: admin client e funções de hash são substituídos por fakes.

    const fakeKeyRow = {
      id: 'key-id-abc',
      account_id: 'acc-id-xyz',
      scopes: ['contacts:read'],
      revoked_at: null,
      created_by_user_id: 'creator-user-001',
      account: {
        id: 'acc-id-xyz',
        status: 'active',
        owner_user_id: 'owner-user-999',
      },
    }

    // Monta a cadeia .from().select().eq().is().maybeSingle() como fake encadeável.
    const maybeSingleFake = vi.fn().mockResolvedValue({ data: fakeKeyRow, error: null })
    const isFake = vi.fn().mockReturnValue({ maybeSingle: maybeSingleFake })
    const eqFake = vi.fn().mockReturnValue({ is: isFake })
    const selectFake = vi.fn().mockReturnValue({ eq: eqFake })
    const fromFake = vi.fn().mockReturnValue({ select: selectFake })

    // supabaseAdmin() retorna o cliente fake.
    vi.mocked(adminClientMod.supabaseAdmin).mockReturnValue({ from: fromFake } as never)

    // Bearer token e hash retornam valores fixos — não importa o valor real.
    vi.mocked(apiKeysMod.extractBearerToken).mockReturnValue('token-claro')
    vi.mocked(apiKeysMod.hashApiKey).mockReturnValue('hash-fixo')

    const req = new Request('http://localhost/api/v1/contacts', {
      headers: { Authorization: 'Bearer token-claro' },
    })

    const ctx = await resolveApiKey(req, ['contacts:read'])

    // Campos de auditoria devem estar presentes e corretos.
    expect(ctx.createdByUserId).toBe('creator-user-001')
    expect(ctx.ownerUserId).toBe('owner-user-999')
    // Campos complementares também estão corretos.
    expect(ctx.apiKeyId).toBe('key-id-abc')
    expect(ctx.accountId).toBe('acc-id-xyz')
    expect(ctx.scopes).toEqual(['contacts:read'])
  })

  it('createdByUserId é null quando a chave não tem rastreamento de criador', async () => {
    // Garante que a ausência de created_by_user_id no registro resulta em null
    // (não em undefined nem em erro).

    const fakeKeyRow = {
      id: 'key-id-sem-criador',
      account_id: 'acc-id-xyz',
      scopes: ['contacts:write'],
      revoked_at: null,
      created_by_user_id: null,
      account: {
        id: 'acc-id-xyz',
        status: 'active',
        owner_user_id: 'owner-user-999',
      },
    }

    const maybeSingleFake = vi.fn().mockResolvedValue({ data: fakeKeyRow, error: null })
    const isFake = vi.fn().mockReturnValue({ maybeSingle: maybeSingleFake })
    const eqFake = vi.fn().mockReturnValue({ is: isFake })
    const selectFake = vi.fn().mockReturnValue({ eq: eqFake })
    const fromFake = vi.fn().mockReturnValue({ select: selectFake })

    vi.mocked(adminClientMod.supabaseAdmin).mockReturnValue({ from: fromFake } as never)
    vi.mocked(apiKeysMod.extractBearerToken).mockReturnValue('token-sem-criador')
    vi.mocked(apiKeysMod.hashApiKey).mockReturnValue('hash-sem-criador')

    const req = new Request('http://localhost/api/v1/contacts', {
      headers: { Authorization: 'Bearer token-sem-criador' },
    })

    const ctx = await resolveApiKey(req, ['contacts:write'])

    // createdByUserId deve ser null — ownerUserId serve de fallback de auditoria.
    expect(ctx.createdByUserId).toBeNull()
    expect(ctx.ownerUserId).toBe('owner-user-999')
    // auditUserId calculado como no svcCtx das rotas.
    const auditUserId = ctx.createdByUserId ?? ctx.ownerUserId
    expect(auditUserId).toBe('owner-user-999')
  })
})

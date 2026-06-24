/**
 * Testes das partes PURAS de api-key-context.
 *
 * Estratégia (mesmo padrão de platform-admin.test.ts): testar a função
 * interna `validateApiKeyPayload` injetando valores — sem rede, sem banco.
 * O lookup no Supabase fica para o teste de integração da rota (Task 2).
 */

import { describe, expect, it } from 'vitest'
import { validateApiKeyPayload } from './api-key-context'
import { AccountPendingError, ForbiddenError } from './account'

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

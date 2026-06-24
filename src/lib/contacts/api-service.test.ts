/**
 * Testes unitários de api-service.ts.
 *
 * Estratégia: fake mínimo do Supabase admin injetado via ctx.
 * Cada teste configura os retornos de .from(table) conforme o cenário.
 * Não testa a infra do Supabase — testa a lógica de resolução e erro.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { UnknownTagError, UnknownFieldError, NotFoundError } from '@/lib/api/errors'
import {
  resolveTagIdByName,
  resolveFieldIdByName,
  upsertContactByPhone,
  updateContact,
  getContactById,
} from './api-service'
import type { ApiServiceCtx } from './api-service'
import type { SupabaseClient } from '@supabase/supabase-js'

// ─── Fake query builder ───────────────────────────────────────────────────────

/**
 * Cria um fake do Supabase admin que retorna respostas configuráveis por tabela.
 * O builder encadeia .select/.eq/.like/.upsert/.insert/.update/.single/.maybeSingle
 * e resolve com { data, error } configurado ao chamar o terminal da cadeia.
 */
function makeFakeAdmin(
  tableResponses: Record<string, { data: unknown; error: unknown }>,
): SupabaseClient {
  function makeBuilder(table: string) {
    const resp = tableResponses[table] ?? { data: null, error: null }

    // Objeto encadeável — todos os métodos intermediários retornam o builder
    const builder: Record<string, unknown> = {}

    const terminal = () => Promise.resolve(resp)
    const chain = () => builder

    builder.select = chain
    builder.eq = chain
    builder.like = chain
    builder.order = chain
    builder.upsert = terminal
    builder.insert = () => ({
      select: () => ({
        single: terminal,
      }),
    })
    builder.update = () => ({
      eq: () => ({
        eq: terminal,
      }),
    })
    builder.single = terminal
    builder.maybeSingle = terminal

    return builder
  }

  return {
    from: (table: string) => makeBuilder(table),
  } as unknown as SupabaseClient
}

// ─── Contexto padrão de teste ─────────────────────────────────────────────────

function makeCtx(tableResponses: Record<string, { data: unknown; error: unknown }>): ApiServiceCtx {
  return {
    admin: makeFakeAdmin(tableResponses),
    accountId: 'acct-123',
    auditUserId: 'user-audit',
  }
}

// ─── resolveTagIdByName ───────────────────────────────────────────────────────

describe('resolveTagIdByName', () => {
  it('retorna o id quando a tag existe', async () => {
    const ctx = makeCtx({ tags: { data: { id: 'tag-1' }, error: null } })
    const id = await resolveTagIdByName(ctx, 'VIP')
    expect(id).toBe('tag-1')
  })

  it('lança UnknownTagError quando data é null (tag não existe)', async () => {
    const ctx = makeCtx({ tags: { data: null, error: null } })
    await expect(resolveTagIdByName(ctx, 'inexistente')).rejects.toThrow(UnknownTagError)
  })

  it('UnknownTagError tem status 422 e code unknown_tag', async () => {
    const ctx = makeCtx({ tags: { data: null, error: null } })
    try {
      await resolveTagIdByName(ctx, 'ghost')
      expect.fail('deveria ter lançado')
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownTagError)
      expect((err as UnknownTagError).status).toBe(422)
      expect((err as UnknownTagError).code).toBe('unknown_tag')
    }
  })
})

// ─── resolveFieldIdByName ─────────────────────────────────────────────────────

describe('resolveFieldIdByName', () => {
  it('retorna o id quando o campo existe', async () => {
    const ctx = makeCtx({ custom_fields: { data: { id: 'field-9' }, error: null } })
    const id = await resolveFieldIdByName(ctx, 'cpf')
    expect(id).toBe('field-9')
  })

  it('lança UnknownFieldError quando data é null (campo não existe)', async () => {
    const ctx = makeCtx({ custom_fields: { data: null, error: null } })
    await expect(resolveFieldIdByName(ctx, 'campo_inexistente')).rejects.toThrow(UnknownFieldError)
  })

  it('UnknownFieldError tem status 422 e code unknown_field', async () => {
    const ctx = makeCtx({ custom_fields: { data: null, error: null } })
    try {
      await resolveFieldIdByName(ctx, 'ghost_field')
      expect.fail('deveria ter lançado')
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownFieldError)
      expect((err as UnknownFieldError).status).toBe(422)
      expect((err as UnknownFieldError).code).toBe('unknown_field')
    }
  })
})

// ─── getContactById ───────────────────────────────────────────────────────────

describe('getContactById', () => {
  it('lança NotFoundError quando o contato não existe (data null)', async () => {
    const ctx = makeCtx({ contacts: { data: null, error: null } })
    await expect(getContactById(ctx, 'c-nao-existe')).rejects.toThrow(NotFoundError)
  })

  it('NotFoundError tem status 404', async () => {
    const ctx = makeCtx({ contacts: { data: null, error: null } })
    try {
      await getContactById(ctx, 'c-xyz')
      expect.fail('deveria ter lançado')
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError)
      expect((err as NotFoundError).status).toBe(404)
    }
  })

  it('retorna ContactResource quando o contato existe', async () => {
    const row = {
      id: 'c-1',
      phone: '+5511999999999',
      name: 'João',
      email: 'joao@test.com',
      company: 'ACME',
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-02T00:00:00Z',
      contact_tags: [{ tags: { name: 'VIP' } }],
      contact_custom_values: [{ value: '123.456.789-00', custom_fields: { field_name: 'cpf' } }],
    }
    const ctx = makeCtx({ contacts: { data: row, error: null } })
    const result = await getContactById(ctx, 'c-1')

    expect(result.id).toBe('c-1')
    expect(result.tags).toEqual(['VIP'])
    expect(result.custom_fields).toEqual([{ name: 'cpf', value: '123.456.789-00' }])
  })
})

// ─── upsertContactByPhone — branch de criação ────────────────────────────────

describe('upsertContactByPhone — branch insert (telefone novo)', () => {
  it('chama insert quando findExistingContact retorna null', async () => {
    // contacts: candidatos do LIKE retornam [] (nenhum existente)
    // Depois, o insert retorna o novo id; o getContactById final retorna a row completa
    const insertSpy = vi.fn().mockReturnValue({
      select: () => ({
        single: () => Promise.resolve({ data: { id: 'new-c' }, error: null }),
      }),
    })

    // Montamos admin manualmente para espionar o insert
    const contactsRow = {
      id: 'new-c',
      phone: '+5511988888888',
      name: 'Maria',
      email: null,
      company: null,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      contact_tags: [],
      contact_custom_values: [],
    }

    let callCount = 0
    const admin = {
      from: (table: string) => {
        if (table === 'tags') {
          // sem tags no body, não será chamado
          return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) }
        }
        if (table === 'custom_fields') {
          return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) }
        }
        if (table === 'contacts') {
          callCount++
          // Primeira chamada: LIKE de findExistingContact → sem match
          if (callCount === 1) {
            return {
              select: () => ({
                eq: () => ({
                  like: () => Promise.resolve({ data: [], error: null }),
                }),
              }),
            }
          }
          // Segunda chamada: insert
          if (callCount === 2) {
            return { insert: insertSpy }
          }
          // Terceira chamada: getContactById (maybeSingle do select final)
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({ data: contactsRow, error: null }),
                }),
              }),
            }),
          }
        }
        // contact_tags / contact_custom_values
        return {
          upsert: () => Promise.resolve({ data: null, error: null }),
        }
      },
    } as unknown as SupabaseClient

    const ctx: ApiServiceCtx = { admin, accountId: 'acct-1', auditUserId: 'u-1' }
    const result = await upsertContactByPhone(ctx, { phone: '+5511988888888', name: 'Maria' })

    expect(insertSpy).toHaveBeenCalled()
    expect(result.id).toBe('new-c')
    expect(result.name).toBe('Maria')
  })
})

// ─── upsertContactByPhone — branch de atualização ───────────────────────────

describe('upsertContactByPhone — branch update (telefone existente)', () => {
  it('chama update quando findExistingContact retorna contato existente', async () => {
    const updateSpy = vi.fn().mockReturnValue({
      eq: () => ({
        eq: () => Promise.resolve({ data: null, error: null }),
      }),
    })

    const existingRow = { id: 'c-existing', phone: '+5511977777777' }
    const contactsRow = {
      id: 'c-existing',
      phone: '+5511977777777',
      name: 'Pedro Atualizado',
      email: null,
      company: null,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-03T00:00:00Z',
      contact_tags: [],
      contact_custom_values: [],
    }

    let contactCallCount = 0
    const admin = {
      from: (table: string) => {
        if (table === 'contacts') {
          contactCallCount++
          // Primeira chamada: LIKE de findExistingContact → retorna o existente
          if (contactCallCount === 1) {
            return {
              select: () => ({
                eq: () => ({
                  like: () => Promise.resolve({ data: [existingRow], error: null }),
                }),
              }),
            }
          }
          // Segunda chamada: update
          if (contactCallCount === 2) {
            return { update: updateSpy }
          }
          // Terceira chamada: getContactById
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({ data: contactsRow, error: null }),
                }),
              }),
            }),
          }
        }
        return {
          upsert: () => Promise.resolve({ data: null, error: null }),
        }
      },
    } as unknown as SupabaseClient

    const ctx: ApiServiceCtx = { admin, accountId: 'acct-1', auditUserId: 'u-1' }
    const result = await upsertContactByPhone(ctx, { phone: '+5511977777777', name: 'Pedro Atualizado' })

    expect(updateSpy).toHaveBeenCalled()
    expect(result.id).toBe('c-existing')
  })
})

// ─── upsertContactByPhone — resolução de tag inválida ───────────────────────

describe('upsertContactByPhone — validação prévia de nomes', () => {
  it('lança UnknownTagError ANTES de qualquer insert se tag não existe', async () => {
    const insertSpy = vi.fn()

    const admin = {
      from: (table: string) => {
        if (table === 'tags') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({ data: null, error: null }),
                }),
              }),
            }),
          }
        }
        if (table === 'contacts') {
          return { insert: insertSpy }
        }
        return {}
      },
    } as unknown as SupabaseClient

    const ctx: ApiServiceCtx = { admin, accountId: 'acct-1', auditUserId: 'u-1' }

    await expect(
      upsertContactByPhone(ctx, { phone: '+5511966666666', tags: ['TAG_INEXISTENTE'] }),
    ).rejects.toThrow(UnknownTagError)

    // insert nunca deve ter sido chamado
    expect(insertSpy).not.toHaveBeenCalled()
  })
})

// ─── updateContact — isolamento de tenant ────────────────────────────────────

describe('updateContact — isolamento de tenant', () => {
  it('lança NotFoundError (404) quando o contactId não pertence à conta do ctx', async () => {
    // O maybeSingle da verificação de ownership retorna null — contato de outra conta
    const admin = {
      from: (table: string) => {
        if (table === 'contacts') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({ data: null, error: null }),
                }),
              }),
            }),
          }
        }
        return {}
      },
    } as unknown as SupabaseClient

    const ctx: ApiServiceCtx = { admin, accountId: 'acct-minha', auditUserId: 'u-1' }

    await expect(
      updateContact(ctx, 'contato-de-outra-conta', { name: 'hacker' }),
    ).rejects.toThrow(NotFoundError)

    let thrown: unknown
    try {
      await updateContact(ctx, 'contato-de-outra-conta', { name: 'hacker' })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(NotFoundError)
    expect((thrown as NotFoundError).status).toBe(404)
  })
})

// ─── upsertContactByPhone — race backstop (23505) ───────────────────────────

describe('upsertContactByPhone — race backstop (violação de unicidade)', () => {
  it('não lança quando o insert retorna 23505 e o contato já existe (outro worker ganhou a corrida)', async () => {
    const raceRow = {
      id: 'c-race',
      phone: '+5511955555555',
      name: 'Carlos',
      email: null,
      company: null,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      contact_tags: [],
      contact_custom_values: [],
    }

    let contactCallCount = 0
    const admin = {
      from: (table: string) => {
        if (table === 'contacts') {
          contactCallCount++
          // Primeira chamada: findExistingContact (LIKE) → nenhum existente
          if (contactCallCount === 1) {
            return {
              select: () => ({
                eq: () => ({
                  like: () => Promise.resolve({ data: [], error: null }),
                }),
              }),
            }
          }
          // Segunda chamada: insert → retorna violação de unicidade 23505
          if (contactCallCount === 2) {
            return {
              insert: () => ({
                select: () => ({
                  single: () => Promise.resolve({ data: null, error: { code: '23505' } }),
                }),
              }),
            }
          }
          // Terceira chamada: findExistingContact de retry (LIKE) → retorna o row existente
          if (contactCallCount === 3) {
            return {
              select: () => ({
                eq: () => ({
                  like: () => Promise.resolve({ data: [{ id: 'c-race', phone: '+5511955555555' }], error: null }),
                }),
              }),
            }
          }
          // Quarta chamada: update do race path
          if (contactCallCount === 4) {
            return {
              update: () => ({
                eq: () => ({
                  eq: () => Promise.resolve({ data: null, error: null }),
                }),
              }),
            }
          }
          // Quinta chamada: getContactById (maybeSingle final)
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({ data: raceRow, error: null }),
                }),
              }),
            }),
          }
        }
        // contact_tags / contact_custom_values
        return {
          upsert: () => Promise.resolve({ data: null, error: null }),
        }
      },
    } as unknown as SupabaseClient

    const ctx: ApiServiceCtx = { admin, accountId: 'acct-1', auditUserId: 'u-1' }
    const result = await upsertContactByPhone(ctx, { phone: '+5511955555555', name: 'Carlos' })

    // Deve resolver sem lançar e retornar o contato encontrado após a corrida
    expect(result.id).toBe('c-race')
  })
})

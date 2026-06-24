/**
 * Testes unitários de deals/api-service.ts.
 *
 * Estratégia: fake mínimo do Supabase admin injetado via ctx (mesmo padrão
 * de src/lib/contacts/api-service.test.ts). Não testa infra Supabase —
 * testa lógica de resolução, isolamento de conta e erros 422/404.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  UnknownPipelineError,
  UnknownStageError,
  NotFoundError,
} from '@/lib/api/errors'
import {
  resolvePipelineByName,
  resolveStageByName,
  createDeal,
  getDealById,
  updateDeal,
} from './api-service'
import type { ApiServiceCtx } from '@/lib/api/service-context'
import type { SupabaseClient } from '@supabase/supabase-js'

// ─── Helpers de fake admin ────────────────────────────────────────────────────

/**
 * Cria um fake Supabase admin que devolve { data, error } configurável por tabela.
 * Suporta apenas o subconjunto de métodos usado em deals/api-service.ts.
 */
function makeFakeAdmin(
  tableResponses: Record<string, { data: unknown; error: unknown }>,
): SupabaseClient {
  function makeBuilder(table: string) {
    const resp = tableResponses[table] ?? { data: null, error: null }

    const builder: Record<string, unknown> = {}
    const terminal = () => Promise.resolve(resp)
    const chain = () => builder

    builder.select = chain
    builder.eq = chain
    builder.order = chain
    builder.single = terminal
    builder.maybeSingle = terminal
    // insert → select → single (padrão de inserção)
    builder.insert = () => ({
      select: () => ({ single: terminal }),
    })
    // update → eq → eq → terminal
    builder.update = () => ({
      eq: () => ({ eq: terminal }),
    })

    return builder
  }

  return { from: (table: string) => makeBuilder(table) } as unknown as SupabaseClient
}

function makeCtx(
  tableResponses: Record<string, { data: unknown; error: unknown }>,
): ApiServiceCtx {
  return {
    admin: makeFakeAdmin(tableResponses),
    accountId: 'acct-test',
    auditUserId: 'user-audit',
  }
}

// ─── resolvePipelineByName ────────────────────────────────────────────────────

describe('resolvePipelineByName', () => {
  it('retorna { id, name } quando o pipeline existe', async () => {
    const ctx = makeCtx({
      pipelines: { data: { id: 'pip-1', name: 'Vendas' }, error: null },
    })
    const pipeline = await resolvePipelineByName(ctx, 'Vendas')
    expect(pipeline).toEqual({ id: 'pip-1', name: 'Vendas' })
  })

  it('lança UnknownPipelineError (422) quando pipeline não existe', async () => {
    const ctx = makeCtx({ pipelines: { data: null, error: null } })
    await expect(resolvePipelineByName(ctx, 'Inexistente')).rejects.toThrow(UnknownPipelineError)
  })

  it('UnknownPipelineError tem status 422 e code unknown_pipeline', async () => {
    const ctx = makeCtx({ pipelines: { data: null, error: null } })
    try {
      await resolvePipelineByName(ctx, 'ghost')
      expect.fail('deveria ter lançado')
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownPipelineError)
      expect((err as UnknownPipelineError).status).toBe(422)
      expect((err as UnknownPipelineError).code).toBe('unknown_pipeline')
    }
  })
})

// ─── resolveStageByName ───────────────────────────────────────────────────────

describe('resolveStageByName', () => {
  it('lança UnknownStageError (422) quando etapa não existe no pipeline', async () => {
    const ctx = makeCtx({ pipeline_stages: { data: null, error: null } })
    await expect(resolveStageByName(ctx, 'pip-1', 'Etapa X')).rejects.toThrow(UnknownStageError)
  })

  it('UnknownStageError tem status 422 e code unknown_stage', async () => {
    const ctx = makeCtx({ pipeline_stages: { data: null, error: null } })
    try {
      await resolveStageByName(ctx, 'pip-1', 'ghost')
      expect.fail('deveria ter lançado')
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownStageError)
      expect((err as UnknownStageError).status).toBe(422)
      expect((err as UnknownStageError).code).toBe('unknown_stage')
    }
  })

  it('retorna { id, name } quando a etapa existe', async () => {
    const ctx = makeCtx({
      pipeline_stages: { data: { id: 'stage-1', name: 'Qualificado' }, error: null },
    })
    const stage = await resolveStageByName(ctx, 'pip-1', 'Qualificado')
    expect(stage).toEqual({ id: 'stage-1', name: 'Qualificado' })
  })
})

// ─── createDeal ───────────────────────────────────────────────────────────────

describe('createDeal — happy path com contact_id', () => {
  it('resolve pipeline → stage → contato, usa currency da conta e insere com status open', async () => {
    const insertSpy = vi.fn().mockReturnValue({
      select: () => ({
        single: () => Promise.resolve({ data: { id: 'deal-new' }, error: null }),
      }),
    })

    // Deal inserido — usado no getDealById final
    const dealRow = {
      id: 'deal-new',
      title: 'Negócio Teste',
      value: 1500,
      currency: 'BRL',
      status: 'open',
      contact_id: 'contact-abc',
      expected_close_date: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      pipeline: { id: 'pip-1', name: 'Vendas' },
      stage: { id: 'stage-1', name: 'Qualificado' },
    }

    let dealsCallCount = 0
    const admin = {
      from: (table: string) => {
        if (table === 'pipelines') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () =>
                    Promise.resolve({ data: { id: 'pip-1', name: 'Vendas' }, error: null }),
                }),
              }),
            }),
          }
        }
        if (table === 'pipeline_stages') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () =>
                    Promise.resolve({ data: { id: 'stage-1', name: 'Qualificado' }, error: null }),
                }),
              }),
            }),
          }
        }
        if (table === 'accounts') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({ data: { default_currency: 'BRL' }, error: null }),
              }),
            }),
          }
        }
        if (table === 'contacts') {
          // getContactById — verifica existência do contact_id
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () =>
                    Promise.resolve({
                      data: {
                        id: 'contact-abc',
                        phone: '+5592999999999',
                        name: 'Cliente',
                        email: null,
                        company: null,
                        created_at: '2026-01-01T00:00:00Z',
                        updated_at: '2026-01-01T00:00:00Z',
                        contact_tags: [],
                        contact_custom_values: [],
                      },
                      error: null,
                    }),
                }),
              }),
            }),
          }
        }
        if (table === 'deals') {
          dealsCallCount++
          if (dealsCallCount === 1) {
            // insert
            return { insert: insertSpy }
          }
          // getDealById — select com joins
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({ data: dealRow, error: null }),
                }),
              }),
            }),
          }
        }
        return {}
      },
    } as unknown as SupabaseClient

    const ctx: ApiServiceCtx = { admin, accountId: 'acct-test', auditUserId: 'user-audit' }
    const result = await createDeal(ctx, {
      contact_id: 'contact-abc',
      pipeline: 'Vendas',
      stage: 'Qualificado',
      title: 'Negócio Teste',
      value: 1500,
    })

    expect(insertSpy).toHaveBeenCalled()
    // Verifica que o payload do insert tem status: 'open'
    const insertArg = insertSpy.mock.calls[0][0] as Record<string, unknown>
    expect(insertArg.status).toBe('open')
    expect(insertArg.currency).toBe('BRL')
    expect(insertArg.account_id).toBe('acct-test')
    expect(insertArg.user_id).toBe('user-audit')

    expect(result.id).toBe('deal-new')
    expect(result.status).toBe('open')
  })
})

describe('createDeal — pipeline inexistente → UnknownPipelineError ANTES do insert', () => {
  it('lança UnknownPipelineError antes de qualquer insert', async () => {
    const insertSpy = vi.fn()

    const admin = {
      from: (table: string) => {
        if (table === 'pipelines') {
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
        if (table === 'deals') {
          return { insert: insertSpy }
        }
        return {}
      },
    } as unknown as SupabaseClient

    const ctx: ApiServiceCtx = { admin, accountId: 'acct-test', auditUserId: 'u-1' }

    await expect(
      createDeal(ctx, {
        contact_id: 'c-1',
        pipeline: 'PipelineFantasma',
        stage: 'Etapa X',
        title: 'Deal',
      }),
    ).rejects.toThrow(UnknownPipelineError)

    expect(insertSpy).not.toHaveBeenCalled()
  })
})

describe('createDeal — currency fallback para USD quando conta não tem default_currency', () => {
  it('usa USD quando default_currency é null', async () => {
    const insertSpy = vi.fn().mockReturnValue({
      select: () => ({
        single: () => Promise.resolve({ data: { id: 'deal-usd' }, error: null }),
      }),
    })

    const dealRow = {
      id: 'deal-usd',
      title: 'Deal USD',
      value: 0,
      currency: 'USD',
      status: 'open',
      contact_id: 'c-1',
      expected_close_date: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      pipeline: { id: 'pip-1', name: 'P1' },
      stage: { id: 's-1', name: 'S1' },
    }

    let dealsCallCount = 0
    const admin = {
      from: (table: string) => {
        if (table === 'pipelines') {
          return {
            select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 'pip-1', name: 'P1' }, error: null }) }) }) }),
          }
        }
        if (table === 'pipeline_stages') {
          return {
            select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 's-1', name: 'S1' }, error: null }) }) }) }),
          }
        }
        if (table === 'accounts') {
          return {
            select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { default_currency: null }, error: null }) }) }),
          }
        }
        if (table === 'contacts') {
          return {
            select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 'c-1', phone: '+55929', name: null, email: null, company: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', contact_tags: [], contact_custom_values: [] }, error: null }) }) }) }),
          }
        }
        if (table === 'deals') {
          dealsCallCount++
          if (dealsCallCount === 1) return { insert: insertSpy }
          return {
            select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: dealRow, error: null }) }) }) }),
          }
        }
        return {}
      },
    } as unknown as SupabaseClient

    const ctx: ApiServiceCtx = { admin, accountId: 'acct-test', auditUserId: 'u-1' }
    await createDeal(ctx, { contact_id: 'c-1', pipeline: 'P1', stage: 'S1', title: 'Deal USD' })

    const insertArg = insertSpy.mock.calls[0][0] as Record<string, unknown>
    expect(insertArg.currency).toBe('USD')
  })
})

// ─── getDealById ──────────────────────────────────────────────────────────────

describe('getDealById', () => {
  it('lança NotFoundError (404) quando deal não existe ou pertence a outra conta', async () => {
    const ctx = makeCtx({ deals: { data: null, error: null } })
    await expect(getDealById(ctx, 'deal-fantasma')).rejects.toThrow(NotFoundError)
  })

  it('NotFoundError tem status 404', async () => {
    const ctx = makeCtx({ deals: { data: null, error: null } })
    try {
      await getDealById(ctx, 'deal-xyz')
      expect.fail('deveria ter lançado')
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError)
      expect((err as NotFoundError).status).toBe(404)
    }
  })

  it('retorna DealResource quando deal existe', async () => {
    const dealRow = {
      id: 'deal-1',
      title: 'Negócio Real',
      value: 500,
      currency: 'BRL',
      status: 'open',
      contact_id: 'c-1',
      expected_close_date: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      pipeline: { id: 'pip-1', name: 'Vendas' },
      stage: { id: 'stage-1', name: 'Qualificado' },
    }
    const ctx = makeCtx({ deals: { data: dealRow, error: null } })
    const result = await getDealById(ctx, 'deal-1')
    expect(result.id).toBe('deal-1')
    expect(result.pipeline).toEqual({ id: 'pip-1', name: 'Vendas' })
    expect(result.stage).toEqual({ id: 'stage-1', name: 'Qualificado' })
  })
})

// ─── updateDeal ───────────────────────────────────────────────────────────────

describe('updateDeal — wrong account → NotFoundError', () => {
  it('lança NotFoundError quando deal não pertence à conta do ctx', async () => {
    // O .select('id,pipeline_id') retorna null → deal de outra conta ou inexistente
    const admin = {
      from: (table: string) => {
        if (table === 'deals') {
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
    await expect(updateDeal(ctx, 'deal-de-outra-conta', { status: 'won' })).rejects.toThrow(NotFoundError)
  })
})

describe('updateDeal — stage resolvida dentro do pipeline do deal', () => {
  it('resolve stage usando o pipeline_id do deal, não um parâmetro externo', async () => {
    const updateSpy = vi.fn().mockReturnValue({
      eq: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
    })

    const dealRow = {
      id: 'deal-1',
      title: 'Deal',
      value: 100,
      currency: 'BRL',
      status: 'open',
      contact_id: 'c-1',
      expected_close_date: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      pipeline: { id: 'pip-1', name: 'Vendas' },
      stage: { id: 'stage-2', name: 'Proposta' },
    }

    let dealsCallCount = 0
    const pipelineStageSpy = vi.fn().mockReturnValue(
      Promise.resolve({ data: { id: 'stage-2', name: 'Proposta' }, error: null }),
    )

    const admin = {
      from: (table: string) => {
        if (table === 'deals') {
          dealsCallCount++
          if (dealsCallCount === 1) {
            // Verificação de ownership — retorna deal com pipeline_id
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: () =>
                      Promise.resolve({ data: { id: 'deal-1', pipeline_id: 'pip-1' }, error: null }),
                  }),
                }),
              }),
            }
          }
          if (dealsCallCount === 2) {
            // update do deal
            return { update: updateSpy }
          }
          // getDealById final
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({ data: dealRow, error: null }),
                }),
              }),
            }),
          }
        }
        if (table === 'pipeline_stages') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: pipelineStageSpy,
                }),
              }),
            }),
          }
        }
        return {}
      },
    } as unknown as SupabaseClient

    const ctx: ApiServiceCtx = { admin, accountId: 'acct-test', auditUserId: 'u-1' }
    const result = await updateDeal(ctx, 'deal-1', { stage: 'Proposta' })

    // A stage foi resolvida via pipeline_stages
    expect(pipelineStageSpy).toHaveBeenCalled()
    expect(updateSpy).toHaveBeenCalled()
    expect(result.id).toBe('deal-1')
  })
})

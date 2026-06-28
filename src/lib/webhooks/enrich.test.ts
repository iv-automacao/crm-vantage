import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildConversationContext, emptyConversationContext } from './enrich'

// ── Fábrica de client admin fake, roteando por nome de tabela ────────────────
// Cada tabela recebe uma "resposta" (data/error). As queries do enrich são:
//   contacts        → maybeSingle()  (contato + tags + custom + referral + ctwa_clid)
//   conversations   → maybeSingle()  (estado escalar, SEM embed de profiles)
//   profiles        → maybeSingle()  (Bloco 2b: nome do agente por user_id)
//   deals           → maybeSingle()  (deal ativo + joins pipeline/stage)
// Mock-chain robusto: QUALQUER método de filtro retorna o próprio builder; os
// terminadores (maybeSingle/single) resolvem com a resposta da tabela. Não
// depende da ORDEM dos .eq() — só do nome da tabela.
function makeAdmin(responses: Record<string, { data: unknown; error: unknown }>) {
  function builderFor(table: string) {
    const resp = responses[table] ?? { data: null, error: null }
    const builder: Record<string, unknown> = {}
    const chain = () => builder
    for (const m of ['select', 'eq', 'is', 'order', 'limit']) builder[m] = vi.fn(chain)
    builder.maybeSingle = vi.fn().mockResolvedValue(resp)
    builder.single = vi.fn().mockResolvedValue(resp)
    return builder
  }
  const from = vi.fn((table: string) => builderFor(table))
  return { from } as unknown as SupabaseClient
}

describe('emptyConversationContext', () => {
  it('retorna um esqueleto seguro (tudo vazio/null/false)', () => {
    const ctx = emptyConversationContext()
    expect(ctx.contact).toEqual({ tags: [], custom_fields: [], referral: null, ctwa_clid: null })
    expect(ctx.deal).toBeNull()
    expect(ctx.state.bot_paused).toBe(false)
    expect(ctx.state.assigned_agent_id).toBeNull()
    expect(ctx.state.assigned_agent_name).toBeNull()
    expect(ctx.state.autoassign_waiting).toBe(false)
    expect(ctx.state.conversation_status).toBe('open')
  })
})

describe('buildConversationContext', () => {
  it('monta contact (tags + custom + referral + ctwa_clid), state escalar + nome do agente (Bloco 2b) e deal', async () => {
    // IMPORTANTE: conversations devolve SÓ colunas escalares (sem embed de
    // profiles — `assigned_agent_id` não tem FK no schema, embed quebraria a
    // query inteira). O nome do agente vem do lookup SEPARADO em `profiles`.
    const admin = makeAdmin({
      contacts: {
        data: {
          ctwa_clid: 'clid-123',
          referral: { source_id: 'ad-9' },
          contact_tags: [{ tags: { name: 'lead' } }, { tags: { name: 'vip' } }],
          contact_custom_values: [
            { value: 'Honda', custom_fields: { field_name: 'modelo' } },
            { value: null, custom_fields: { field_name: 'vazio' } },
          ],
        },
        error: null,
      },
      conversations: {
        data: {
          status: 'pending',
          bot_paused: true,
          assigned_agent_id: 'user-7',
          unread_count: 3,
          last_message_at: '2026-06-28T17:00:00Z',
          autoassign_waiting: false,
          created_at: '2026-06-20T10:00:00Z',
        },
        error: null,
      },
      profiles: { data: { full_name: 'Ana Vendas' }, error: null },
      deals: {
        data: {
          id: 'deal-1',
          title: 'Civic 2020',
          value: 75000,
          currency: 'BRL',
          status: 'active',
          pipelines: { name: 'Vendas' },
          pipeline_stages: { name: 'Negociação' },
        },
        error: null,
      },
    })

    const ctx = await buildConversationContext(admin, 'acc1', 'conv1', 'c1')

    expect(ctx.contact.tags).toEqual(['lead', 'vip'])
    expect(ctx.contact.custom_fields).toEqual([
      { name: 'modelo', value: 'Honda' },
      { name: 'vazio', value: '' },
    ])
    expect(ctx.contact.referral).toEqual({ source_id: 'ad-9' })
    expect(ctx.contact.ctwa_clid).toBe('clid-123')
    expect(ctx.state.conversation_status).toBe('pending')
    expect(ctx.state.bot_paused).toBe(true)
    expect(ctx.state.assigned_agent_id).toBe('user-7')
    // Nome resolvido pelo Bloco 2b (lookup em profiles por user_id), não por embed.
    expect(ctx.state.assigned_agent_name).toBe('Ana Vendas')
    expect(ctx.state.unread_count).toBe(3)
    expect(ctx.state.autoassign_waiting).toBe(false)
    expect(ctx.deal).toEqual({
      id: 'deal-1',
      title: 'Civic 2020',
      value: 75000,
      currency: 'BRL',
      stage: 'Negociação',
      pipeline: 'Vendas',
      status: 'active',
    })
  })

  it('sem agente atribuído → não faz lookup de nome; sem deal → deal:null', async () => {
    const admin = makeAdmin({
      contacts: { data: { ctwa_clid: null, referral: null, contact_tags: [], contact_custom_values: [] }, error: null },
      conversations: {
        data: {
          status: 'open',
          bot_paused: false,
          assigned_agent_id: null,
          unread_count: 0,
          last_message_at: null,
          autoassign_waiting: true,
          created_at: '2026-06-20T10:00:00Z',
        },
        error: null,
      },
      // profiles ausente de propósito: sem assigned_agent_id, o 2b nem roda.
      deals: { data: null, error: null },
    })

    const ctx = await buildConversationContext(admin, 'acc1', 'conv1', 'c1')

    expect(ctx.contact.tags).toEqual([])
    expect(ctx.contact.referral).toBeNull()
    expect(ctx.contact.ctwa_clid).toBeNull()
    expect(ctx.state.assigned_agent_id).toBeNull()
    expect(ctx.state.assigned_agent_name).toBeNull()
    expect(ctx.state.autoassign_waiting).toBe(true)
    expect(ctx.deal).toBeNull()
  })

  it('deal sem conversation_id (criado na UI por contato) → fallback por contact_id', async () => {
    // O 1º lookup (por conversation_id) volta vazio; o fallback (por contact_id)
    // traz o deal. Como o mock roteia só por tabela, `deals` responde nos dois
    // lookups; aqui validamos que o deal é montado a partir da resposta da tabela.
    const admin = makeAdmin({
      contacts: { data: { ctwa_clid: null, referral: null, contact_tags: [], contact_custom_values: [] }, error: null },
      conversations: {
        data: { status: 'open', bot_paused: false, assigned_agent_id: null, unread_count: 0, last_message_at: null, autoassign_waiting: false, created_at: null },
        error: null,
      },
      deals: {
        data: {
          id: 'deal-9',
          title: 'Negócio do contato',
          value: 1000,
          currency: 'BRL',
          status: 'active',
          pipelines: { name: 'Pós-venda' },
          pipeline_stages: { name: 'Aberto' },
        },
        error: null,
      },
    })

    const ctx = await buildConversationContext(admin, 'acc1', 'conv1', 'c1')

    expect(ctx.deal).toEqual({
      id: 'deal-9',
      title: 'Negócio do contato',
      value: 1000,
      currency: 'BRL',
      stage: 'Aberto',
      pipeline: 'Pós-venda',
      status: 'active',
    })
  })

  it('erro na query de contacts → bloco contact degrada vazio; state ainda monta', async () => {
    const admin = makeAdmin({
      contacts: { data: null, error: { message: 'boom' } },
      conversations: {
        data: { status: 'open', bot_paused: false, assigned_agent_id: null, unread_count: 0, last_message_at: null, autoassign_waiting: false, created_at: null },
        error: null,
      },
      deals: { data: null, error: null },
    })

    const ctx = await buildConversationContext(admin, 'acc1', 'conv1', 'c1')

    // contacts falhou → bloco contact volta vazio, mas state ainda monta
    expect(ctx.contact).toEqual({ tags: [], custom_fields: [], referral: null, ctwa_clid: null })
    expect(ctx.state.conversation_status).toBe('open')
  })

  it('erro na query de conversations → state degrada pro esqueleto, sem quebrar o resto', async () => {
    const admin = makeAdmin({
      contacts: { data: { ctwa_clid: 'x', referral: null, contact_tags: [{ tags: { name: 'lead' } }], contact_custom_values: [] }, error: null },
      conversations: { data: null, error: { message: 'PGRST200 ou outro' } },
      deals: { data: null, error: null },
    })

    const ctx = await buildConversationContext(admin, 'acc1', 'conv1', 'c1')

    // conversa falhou → state fica o do esqueleto (defaults seguros), MAS sem
    // forçar bot_paused:false enganoso vindo de um embed que quebrou a query:
    // aqui é genuinamente "não consegui ler" → o n8n vê os defaults seguros.
    expect(ctx.state.bot_paused).toBe(false)
    expect(ctx.state.conversation_status).toBe('open')
    expect(ctx.state.assigned_agent_id).toBeNull()
    // os demais blocos seguem montados normalmente
    expect(ctx.contact.tags).toEqual(['lead'])
    expect(ctx.contact.ctwa_clid).toBe('x')
  })

  it('from() lançando (cliente quebrado) → retorna esqueleto e NÃO lança', async () => {
    const admin = { from: vi.fn(() => { throw new Error('client down') }) } as unknown as SupabaseClient
    await expect(buildConversationContext(admin, 'acc1', 'conv1', 'c1')).resolves.toEqual(
      emptyConversationContext(),
    )
  })
})

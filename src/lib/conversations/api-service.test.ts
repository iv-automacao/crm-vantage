/**
 * Testes unitários do serviço de conversas.
 *
 * Estratégia: fake mínimo do Supabase admin injetado via ctx.
 * Segue o mesmo padrão de src/lib/contacts/api-service.test.ts.
 * Não testa infraestrutura — testa lógica de isolamento de tenant e paginação.
 */

import { describe, expect, it } from 'vitest'
import { NotFoundError } from '@/lib/api/errors'
import {
  getConversationById,
  findConversationsByContact,
  listMessages,
} from './api-service'
import type { ApiServiceCtx } from '@/lib/api/service-context'
import type { SupabaseClient } from '@supabase/supabase-js'

// ─── Helpers de fake ──────────────────────────────────────────────────────────

/** Row de conversa fake para reutilização nos testes. */
function makeConversationRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'conv-1',
    contact_id: 'contact-1',
    status: 'open',
    assigned_agent_id: null,
    last_message_text: 'Olá!',
    last_message_at: '2024-01-10T10:00:00Z',
    unread_count: 2,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-10T10:00:00Z',
    ...overrides,
  }
}

/** Row de mensagem fake. */
function makeMessageRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'msg-1',
    sender_type: 'contact',
    content_type: 'text',
    content_text: 'Olá!',
    media_url: null,
    status: 'delivered',
    created_at: '2024-01-10T10:00:00Z',
    ...overrides,
  }
}

/**
 * Cria ctx com admin fake cujo from('conversations') retorna a resposta configurada.
 * Para cenários que precisam de respostas por tabela, use makeCtxMultiTable.
 */
function makeCtxConversations(response: { data: unknown; error: unknown }): ApiServiceCtx {
  return {
    admin: {
      from: (table: string) => {
        if (table === 'conversations') {
          const builder: Record<string, unknown> = {}
          const terminal = () => Promise.resolve(response)
          const chain = () => builder
          builder.select = chain
          builder.eq = chain
          builder.order = chain
          builder.limit = chain
          builder.lt = chain
          builder.maybeSingle = terminal
          return builder
        }
        return {}
      },
    } as unknown as SupabaseClient,
    accountId: 'acct-123',
    auditUserId: 'user-audit',
  }
}

/**
 * Cria ctx com respostas configuráveis por tabela.
 * Suporta conversations com maybeSingle E array (para listagens).
 */
function makeCtxMultiTable(tableResponses: Record<string, { data: unknown; error: unknown }>): ApiServiceCtx {
  return {
    admin: {
      from: (table: string) => {
        const resp = tableResponses[table] ?? { data: null, error: null }
        const builder: Record<string, unknown> = {}
        const terminal = () => Promise.resolve(resp)
        const chain = () => builder
        builder.select = chain
        builder.eq = chain
        builder.order = chain
        builder.limit = chain
        builder.lt = chain
        builder.maybeSingle = terminal
        // terminal para listagens (sem maybeSingle)
        builder.then = (resolve: (v: unknown) => void) => {
          resolve(resp)
        }
        return builder
      },
    } as unknown as SupabaseClient,
    accountId: 'acct-123',
    auditUserId: 'user-audit',
  }
}

// ─── getConversationById ──────────────────────────────────────────────────────

describe('getConversationById', () => {
  it('retorna ConversationResource quando a conversa existe e pertence à conta', async () => {
    const row = makeConversationRow()
    const ctx = makeCtxConversations({ data: row, error: null })
    const result = await getConversationById(ctx, 'conv-1')

    expect(result.id).toBe('conv-1')
    expect(result.contact_id).toBe('contact-1')
    expect(result.status).toBe('open')
    expect(result.assigned_agent_id).toBeNull()
    expect(result.last_message_text).toBe('Olá!')
    expect(result.unread_count).toBe(2)
  })

  it('lança NotFoundError quando data é null (conversa não existe)', async () => {
    const ctx = makeCtxConversations({ data: null, error: null })
    await expect(getConversationById(ctx, 'conv-inexistente')).rejects.toThrow(NotFoundError)
  })

  it('NotFoundError tem status 404', async () => {
    const ctx = makeCtxConversations({ data: null, error: null })
    try {
      await getConversationById(ctx, 'conv-outra-conta')
      expect.fail('deveria ter lançado')
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError)
      expect((err as NotFoundError).status).toBe(404)
    }
  })

  it('conversa de outra conta retorna NotFoundError (eq account_id filtra)', async () => {
    // O eq('account_id', ctx.accountId) garante que o DB não retorna
    // conversas de outras contas — simulado retornando null
    const ctx = makeCtxConversations({ data: null, error: null })
    await expect(getConversationById(ctx, 'conv-outra-conta')).rejects.toThrow(NotFoundError)
  })
})

// ─── findConversationsByContact ───────────────────────────────────────────────

describe('findConversationsByContact', () => {
  it('retorna array vazio quando não há conversas para o contato', async () => {
    // contacts: retorna o contato (via getContactById chamado internamente)
    // conversations: retorna lista vazia
    const admin = {
      from: (table: string) => {
        if (table === 'contacts') {
          // getContactById → select(...).eq(...).eq(...).maybeSingle()
          const row = {
            id: 'contact-1',
            phone: '+5592999999999',
            name: 'João',
            email: null,
            company: null,
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
            contact_tags: [],
            contact_custom_values: [],
          }
          const builder: Record<string, unknown> = {}
          const chain = () => builder
          builder.select = chain
          builder.eq = chain
          builder.maybeSingle = () => Promise.resolve({ data: row, error: null })
          return builder
        }
        if (table === 'conversations') {
          const builder: Record<string, unknown> = {}
          const chain = () => builder
          // Listagem — resolve via then (await direto no builder)
          const response = { data: [], error: null }
          builder.select = chain
          builder.eq = chain
          builder.order = chain
          builder.then = (resolve: (v: unknown) => void) => resolve(response)
          return builder
        }
        return {}
      },
    } as unknown as SupabaseClient

    const ctx: ApiServiceCtx = { admin, accountId: 'acct-123', auditUserId: 'u-1' }
    const result = await findConversationsByContact(ctx, {
      contact_id: 'contact-1',
    })

    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(0)
  })

  it('lança NotFoundError quando contact_id não pertence à conta', async () => {
    // contacts: maybeSingle retorna null → getContactById lança NotFoundError
    const admin = {
      from: (table: string) => {
        if (table === 'contacts') {
          const builder: Record<string, unknown> = {}
          const chain = () => builder
          builder.select = chain
          builder.eq = chain
          builder.maybeSingle = () => Promise.resolve({ data: null, error: null })
          return builder
        }
        return {}
      },
    } as unknown as SupabaseClient

    const ctx: ApiServiceCtx = { admin, accountId: 'acct-123', auditUserId: 'u-1' }
    await expect(
      findConversationsByContact(ctx, { contact_id: 'contato-de-outra-conta' }),
    ).rejects.toThrow(NotFoundError)
  })

  it('retorna null/[] quando contact_phone não corresponde a nenhum contato', async () => {
    // contacts: LIKE de findExistingContact retorna [] → findContactByPhone retorna null
    let contactCallCount = 0
    const admin = {
      from: (table: string) => {
        if (table === 'contacts') {
          contactCallCount++
          // Chamada do findExistingContact (LIKE)
          return {
            select: () => ({
              eq: () => ({
                like: () => Promise.resolve({ data: [], error: null }),
              }),
            }),
          }
        }
        return {}
      },
    } as unknown as SupabaseClient

    const ctx: ApiServiceCtx = { admin, accountId: 'acct-123', auditUserId: 'u-1' }
    const result = await findConversationsByContact(ctx, { contact_phone: '+5592000000000' })

    // Contato não encontrado → retorna array vazio
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(0)
  })

  it('retorna ConversationResource[] para contato encontrado via contact_id', async () => {
    const convRow = makeConversationRow()
    const contactRow = {
      id: 'contact-1',
      phone: '+5592999999999',
      name: 'Maria',
      email: null,
      company: null,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      contact_tags: [],
      contact_custom_values: [],
    }

    const admin = {
      from: (table: string) => {
        if (table === 'contacts') {
          const builder: Record<string, unknown> = {}
          const chain = () => builder
          builder.select = chain
          builder.eq = chain
          builder.maybeSingle = () => Promise.resolve({ data: contactRow, error: null })
          return builder
        }
        if (table === 'conversations') {
          const response = { data: [convRow], error: null }
          const builder: Record<string, unknown> = {}
          const chain = () => builder
          builder.select = chain
          builder.eq = chain
          builder.order = chain
          builder.then = (resolve: (v: unknown) => void) => resolve(response)
          return builder
        }
        return {}
      },
    } as unknown as SupabaseClient

    const ctx: ApiServiceCtx = { admin, accountId: 'acct-123', auditUserId: 'u-1' }
    const result = await findConversationsByContact(ctx, { contact_id: 'contact-1' })

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('conv-1')
    expect(result[0].contact_id).toBe('contact-1')
  })
})

// ─── listMessages ─────────────────────────────────────────────────────────────

describe('listMessages', () => {
  it('lança NotFoundError quando a conversa pertence a outra conta', async () => {
    // conversations: maybeSingle retorna null → getConversationById lança NotFoundError
    const admin = {
      from: (table: string) => {
        if (table === 'conversations') {
          const builder: Record<string, unknown> = {}
          const chain = () => builder
          builder.select = chain
          builder.eq = chain
          builder.maybeSingle = () => Promise.resolve({ data: null, error: null })
          return builder
        }
        return {}
      },
    } as unknown as SupabaseClient

    const ctx: ApiServiceCtx = { admin, accountId: 'acct-123', auditUserId: 'u-1' }
    await expect(listMessages(ctx, 'conv-outra-conta', { limit: 30 })).rejects.toThrow(NotFoundError)
  })

  it('retorna mensagens em ordem cronológica (antiga → nova) e has_more=false quando ≤ limit', async () => {
    const convRow = makeConversationRow()
    // 2 mensagens retornadas em ordem desc (mais nova primeiro, como o DB retorna)
    const msgRows = [
      makeMessageRow({ id: 'msg-2', created_at: '2024-01-10T11:00:00Z' }),
      makeMessageRow({ id: 'msg-1', created_at: '2024-01-10T10:00:00Z' }),
    ]

    let conversationsCallCount = 0
    const admin = {
      from: (table: string) => {
        if (table === 'conversations') {
          conversationsCallCount++
          // Primeira chamada: getConversationById (maybeSingle)
          const builder: Record<string, unknown> = {}
          const chain = () => builder
          builder.select = chain
          builder.eq = chain
          builder.maybeSingle = () => Promise.resolve({ data: convRow, error: null })
          return builder
        }
        if (table === 'messages') {
          // Retorna as 2 mensagens (menos que limit+1=31)
          const response = { data: msgRows, error: null }
          const builder: Record<string, unknown> = {}
          const chain = () => builder
          builder.select = chain
          builder.eq = chain
          builder.lt = chain
          builder.order = chain
          builder.limit = chain
          builder.then = (resolve: (v: unknown) => void) => resolve(response)
          return builder
        }
        return {}
      },
    } as unknown as SupabaseClient

    const ctx: ApiServiceCtx = { admin, accountId: 'acct-123', auditUserId: 'u-1' }
    const result = await listMessages(ctx, 'conv-1', { limit: 30 })

    // Ordem cronológica: antiga primeiro
    expect(result.messages[0].id).toBe('msg-1')
    expect(result.messages[1].id).toBe('msg-2')
    expect(result.has_more).toBe(false)
    expect(result.next_before).toBeNull()
  })

  it('seta has_more=true e next_before quando há mais mensagens que o limit', async () => {
    const convRow = makeConversationRow()
    const limit = 2
    // Retorna limit+1=3 mensagens (indica que há mais)
    const msgRows = [
      makeMessageRow({ id: 'msg-3', created_at: '2024-01-10T12:00:00Z' }),
      makeMessageRow({ id: 'msg-2', created_at: '2024-01-10T11:00:00Z' }),
      makeMessageRow({ id: 'msg-1', created_at: '2024-01-10T10:00:00Z' }), // excedente
    ]

    const admin = {
      from: (table: string) => {
        if (table === 'conversations') {
          const builder: Record<string, unknown> = {}
          const chain = () => builder
          builder.select = chain
          builder.eq = chain
          builder.maybeSingle = () => Promise.resolve({ data: convRow, error: null })
          return builder
        }
        if (table === 'messages') {
          const response = { data: msgRows, error: null }
          const builder: Record<string, unknown> = {}
          const chain = () => builder
          builder.select = chain
          builder.eq = chain
          builder.lt = chain
          builder.order = chain
          builder.limit = chain
          builder.then = (resolve: (v: unknown) => void) => resolve(response)
          return builder
        }
        return {}
      },
    } as unknown as SupabaseClient

    const ctx: ApiServiceCtx = { admin, accountId: 'acct-123', auditUserId: 'u-1' }
    const result = await listMessages(ctx, 'conv-1', { limit })

    // Só retorna 'limit' mensagens (descarta o excedente)
    expect(result.messages).toHaveLength(limit)
    expect(result.has_more).toBe(true)
    // next_before = created_at da última mensagem da página (msg-2, a mais antiga da página)
    expect(result.next_before).toBe('2024-01-10T11:00:00Z')
    // Ordem cronológica: msg-2 (mais antiga da página) primeiro, msg-3 depois
    expect(result.messages[0].id).toBe('msg-2')
    expect(result.messages[1].id).toBe('msg-3')
  })

  it('retorna MessageResource com campos corretos', async () => {
    const convRow = makeConversationRow()
    const msgRow = makeMessageRow({
      id: 'msg-99',
      sender_type: 'agent',
      content_type: 'image',
      content_text: null,
      media_url: 'https://cdn.example.com/img.jpg',
      status: 'sent',
      created_at: '2024-01-15T09:00:00Z',
    })

    const admin = {
      from: (table: string) => {
        if (table === 'conversations') {
          const builder: Record<string, unknown> = {}
          const chain = () => builder
          builder.select = chain
          builder.eq = chain
          builder.maybeSingle = () => Promise.resolve({ data: convRow, error: null })
          return builder
        }
        if (table === 'messages') {
          const response = { data: [msgRow], error: null }
          const builder: Record<string, unknown> = {}
          const chain = () => builder
          builder.select = chain
          builder.eq = chain
          builder.lt = chain
          builder.order = chain
          builder.limit = chain
          builder.then = (resolve: (v: unknown) => void) => resolve(response)
          return builder
        }
        return {}
      },
    } as unknown as SupabaseClient

    const ctx: ApiServiceCtx = { admin, accountId: 'acct-123', auditUserId: 'u-1' }
    const result = await listMessages(ctx, 'conv-1', { limit: 30 })

    expect(result.messages).toHaveLength(1)
    const msg = result.messages[0]
    expect(msg.id).toBe('msg-99')
    expect(msg.sender_type).toBe('agent')
    expect(msg.content_type).toBe('image')
    expect(msg.content_text).toBeNull()
    expect(msg.media_url).toBe('https://cdn.example.com/img.jpg')
    expect(msg.status).toBe('sent')
    expect(msg.created_at).toBe('2024-01-15T09:00:00Z')
  })
})

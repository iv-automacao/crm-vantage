/**
 * Camada de serviço para conversas via API externa.
 * Todas as operações são account-scoped — nunca acessa dados de outra conta.
 *
 * A tabela `conversations` tem account_id NOT NULL → sempre filtrar por ctx.accountId.
 * A tabela `messages` NÃO tem account_id → escopo via conversa pai (tenant gate).
 */

import { NotFoundError } from '@/lib/api/errors'
import type { ApiServiceCtx } from '@/lib/api/service-context'
import { getContactById, findContactByPhone } from '@/lib/contacts/api-service'
import type { ConversationContactQuery } from '@/lib/api/schemas/conversations'

// ─── Tipos públicos ───────────────────────────────────────────────────────────

export interface ConversationResource {
  id: string
  contact_id: string
  status: string
  assigned_agent_id: string | null
  last_message_text: string | null
  last_message_at: string | null
  unread_count: number
  created_at: string
  updated_at: string
}

export interface MessageResource {
  id: string
  sender_type: string
  content_type: string
  content_text: string | null
  media_url: string | null
  status: string
  created_at: string
}

// ─── Conversores internos ─────────────────────────────────────────────────────

/** Converte linha raw do Supabase para ConversationResource. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toConversationResource(row: any): ConversationResource {
  return {
    id: row.id,
    contact_id: row.contact_id,
    status: row.status,
    assigned_agent_id: row.assigned_agent_id ?? null,
    last_message_text: row.last_message_text ?? null,
    last_message_at: row.last_message_at ?? null,
    unread_count: row.unread_count ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/** Converte linha raw do Supabase para MessageResource. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toMessageResource(row: any): MessageResource {
  return {
    id: row.id,
    sender_type: row.sender_type,
    content_type: row.content_type,
    content_text: row.content_text ?? null,
    media_url: row.media_url ?? null,
    status: row.status,
    created_at: row.created_at,
  }
}

// ─── Campos selecionados ──────────────────────────────────────────────────────

const CONVERSATION_SELECT =
  'id,contact_id,status,assigned_agent_id,last_message_text,last_message_at,unread_count,created_at,updated_at'

// ─── Leituras ─────────────────────────────────────────────────────────────────

/**
 * Busca uma conversa por id.
 * Lança NotFoundError se não existir ou pertencer a outra conta.
 * Sempre filtra por account_id — tenant gate primário.
 */
export async function getConversationById(
  ctx: ApiServiceCtx,
  id: string,
): Promise<ConversationResource> {
  const { data, error } = await ctx.admin
    .from('conversations')
    .select(CONVERSATION_SELECT)
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle()

  if (error) throw error
  if (!data) throw new NotFoundError('Conversa não encontrada')

  return toConversationResource(data)
}

/**
 * Lista conversas de um contato filtradas pela conta.
 * Resolve o contato via contact_phone (retorna [] se não encontrado)
 * ou contact_id (lança NotFoundError se não pertencer à conta).
 * Ordena por last_message_at desc (mais recente primeiro).
 */
export async function findConversationsByContact(
  ctx: ApiServiceCtx,
  q: ConversationContactQuery,
): Promise<ConversationResource[]> {
  let contactId: string

  if (q.contact_id) {
    // getContactById lança NotFoundError se não existir ou for de outra conta
    const contact = await getContactById(ctx, q.contact_id)
    contactId = contact.id
  } else {
    // findContactByPhone retorna null se não encontrar — sem 404, retorna []
    const contact = await findContactByPhone(ctx, q.contact_phone!)
    if (!contact) return []
    contactId = contact.id
  }

  const { data, error } = await ctx.admin
    .from('conversations')
    .select(CONVERSATION_SELECT)
    .eq('account_id', ctx.accountId)
    .eq('contact_id', contactId)
    .order('last_message_at', { ascending: false })

  if (error) throw error
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data ?? []).map((row: any) => toConversationResource(row))
}

/**
 * Lista mensagens de uma conversa com paginação cursor-based (before).
 *
 * TENANT GATE: chama getConversationById ANTES de acessar messages —
 * garante que a conversa pertence à conta. A tabela messages não tem account_id.
 *
 * Paginação: busca limit+1 registros, seta has_more e next_before.
 * Retorna mensagens em ordem cronológica (antiga → nova).
 */
export async function listMessages(
  ctx: ApiServiceCtx,
  conversationId: string,
  opts: { limit: number; before?: string },
): Promise<{ messages: MessageResource[]; has_more: boolean; next_before: string | null }> {
  // Valida tenant — lança NotFoundError se conversa não pertencer à conta
  await getConversationById(ctx, conversationId)

  const { limit, before } = opts

  // Busca limit+1 em ordem decrescente (mais nova primeiro) para detectar has_more
  let q = ctx.admin
    .from('messages')
    .select('id,sender_type,content_type,content_text,media_url,status,created_at')
    .eq('conversation_id', conversationId)

  // Aplica cursor de paginação se fornecido
  if (before) q = q.lt('created_at', before)

  const { data, error } = await q
    .order('created_at', { ascending: false })
    .limit(limit + 1)

  if (error) throw error

  const rows = data ?? []
  const has_more = rows.length > limit
  // Página real: descarta o registro extra se has_more
  const page = has_more ? rows.slice(0, limit) : rows
  // next_before = created_at do último item da página (o mais antigo, pois veio em desc)
  const next_before = has_more ? (page[page.length - 1].created_at as string) : null
  // Inverte para retornar em ordem cronológica: antiga → nova
  const messages = [...page].reverse().map(toMessageResource)

  return { messages, has_more, next_before }
}

import { supabaseAdmin } from '@/lib/automations/admin-client'

// Tipo do cliente Supabase admin (service-role)
type AdminDb = ReturnType<typeof supabaseAdmin>

/**
 * Incrementa `unread_count` da conversa de forma ATÔMICA (via RPC da migration
 * 039) e atualiza `last_message_text`/`last_message_at`/`updated_at`. Substitui
 * o read-modify-write em memória do webhook, que perdia incremento sob 2
 * mensagens distintas concorrentes.
 *
 * Best-effort (paridade com o `.update` anterior, que só logava): não relança.
 */
export async function incrementConversationUnread(
  db: AdminDb,
  conversationId: string,
  lastMessageText: string,
): Promise<void> {
  const { error } = await db.rpc('increment_conversation_unread', {
    p_conversation_id: conversationId,
    p_last_message_text: lastMessageText,
  })
  if (error) console.error('Erro ao incrementar unread da conversa:', error)
}

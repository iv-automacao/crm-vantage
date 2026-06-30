import { supabaseAdmin } from '@/lib/automations/admin-client'

// Tipo do cliente Supabase admin (service-role)
type AdminDb = ReturnType<typeof supabaseAdmin>

/**
 * Espelha a matemática de módulo do SQL `pick_next_agent_round_robin` para
 * testes unitários puros sem banco de dados.
 *
 * Retorna -1 quando o pool está vazio (poolSize <= 0).
 * Caso contrário, retorna cursor % poolSize (assume cursor >= 0).
 */
export function pickIndex(cursor: number, poolSize: number): number {
  if (poolSize <= 0) return -1
  return cursor % poolSize
}

/**
 * Janela de presença: tempo máximo desde o último heartbeat pra contar como
 * "online agora". ESPELHA a janela canônica da migration 038
 * (pick_next_agent_round_robin, INTERVAL '5 minutes') — manter os dois em sincronia.
 */
export const PRESENCE_WINDOW_MS = 5 * 60 * 1000

/**
 * "Online agora" = heartbeat dentro da janela. Só presença real (aba aberta);
 * NÃO considera in_pool nem pausa. Usado pelo painel do ADM (bolinha verde).
 */
export function onlineNow(lastActivityAt: string | null, now: Date): boolean {
  if (lastActivityAt == null) return false
  return now.getTime() - new Date(lastActivityAt).getTime() < PRESENCE_WINDOW_MS
}

/**
 * Predicado de elegibilidade que espelha a lógica SQL (migration 035): agente recebe lead se
 * está no pool, recebendo (is_available) e online (heartbeat dentro da janela).
 */
export function isAvailableNow(
  p: {
    in_pool: boolean
    is_available: boolean
    last_activity_at: string | null
  },
  now: Date,
): boolean {
  if (!p.in_pool) return false
  if (!p.is_available) return false
  return onlineNow(p.last_activity_at, now)
}

/**
 * Chama a RPC Postgres `pick_next_agent_round_robin` pra escolher o próximo
 * agente em rodízio e ATRIBUIR a conversa (por id) de forma atômica (migration 038).
 *
 * A RPC faz tudo numa transação: monta o pool, atribui a conversa só se ela
 * ainda não tem dono (guard `assigned_agent_id IS NULL` por dentro) e só AVANÇA
 * o cursor do rodízio quando a atribuição cola. Assim uma rajada de mensagens
 * do mesmo contato novo na mesma conversa nunca "queima" um agente (cursor +1, não +2).
 *
 * Retorna `{ agentId: null }` quando ninguém está disponível OU quando a
 * conversa já tinha dono. O caller (webhook) faz o fallback de
 * `autoassign_waiting` — no-op se a conversa já tem dono.
 */
export async function assignNextAgent(
  db: AdminDb,
  accountId: string,
  conversationId: string,
): Promise<{ agentId: string | null }> {
  const { data: agentId, error } = await db.rpc('pick_next_agent_round_robin', {
    p_account_id: accountId,
    p_conversation_id: conversationId,
  })

  if (error || !agentId) return { agentId: null }

  return { agentId: agentId as string }
}

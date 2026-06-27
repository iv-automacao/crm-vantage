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
 * "online agora". ESPELHA o INTERVAL do SQL pick_next_agent_round_robin
 * (migration 035) — manter os dois em sincronia.
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
 * Predicado de elegibilidade que espelha a lógica SQL: agente recebe lead se
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
 * Chama a RPC Postgres `pick_next_agent_round_robin` para selecionar o próximo
 * agente disponível em rodízio atômico, e atualiza a conversa correspondente.
 *
 * Retorna `{ agentId: null }` se a RPC não encontrar agente disponível.
 */
export async function assignNextAgent(
  db: AdminDb,
  accountId: string,
  contactId: string,
): Promise<{ agentId: string | null }> {
  // Drift conhecido (aceitável no escopo enxuto): a RPC avança o cursor e o
  // UPDATE abaixo são duas instruções. Se o MESMO contato novo manda duas
  // mensagens em lambdas concorrentes, ambas passam o gate de `null`, a RPC
  // roda duas vezes (cursor +2, escolhe X e Y) mas só o primeiro UPDATE vence
  // o guard `.is(null)` — o lead fica com UM dono (sem duplo-assign), porém Y
  // é pulado no rodízio. Auto-corrige ao longo do tempo. Pra fairness estrita,
  // mover o UPDATE pra dentro da RPC e só avançar o cursor quando afetar linha.
  const { data: agentId, error } = await db.rpc('pick_next_agent_round_robin', {
    p_account_id: accountId,
  })

  if (error || !agentId) return { agentId: null }

  // Guarda condicional: o `.is('assigned_agent_id', null)` impede sobrescrever
  // uma atribuição manual feita pelo usuário via passo `assign_conversation`
  // no modo `specific`. Assim o rodízio não colide com atribuições explícitas.
  await db
    .from('conversations')
    .update({ assigned_agent_id: agentId, autoassign_waiting: false })
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .is('assigned_agent_id', null)

  return { agentId: agentId as string }
}

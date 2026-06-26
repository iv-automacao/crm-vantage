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
 * Predicado de disponibilidade que espelha a lógica SQL:
 * agente está disponível se estiver no pool, marcado como disponível,
 * e com atividade recente (dentro dos últimos 15 minutos).
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
  if (p.last_activity_at == null) return false

  const idleMs = now.getTime() - new Date(p.last_activity_at).getTime()
  return idleMs < 15 * 60 * 1000
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

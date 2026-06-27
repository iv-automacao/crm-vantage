import type { AccountRole } from '@/lib/auth/roles'

/** Só o colaborador (agent) é escopado aos próprios leads. owner/admin/viewer
 *  veem todas as conversas (viewer = auditoria). role nulo (carregando) = não escopa
 *  aqui; quem decide o fail-closed é conversationVisibleTo. */
export function agentSeesOnlyAssigned(role: AccountRole | null): boolean {
  return role === 'agent'
}

/** Uma conversa é visível pra alguém? Quem não é agent vê todas. O agent só vê
 *  as atribuídas a ele (assigned_agent_id === seu userId). fail-closed: agent
 *  sem userId resolvido não vê conversa escopável. */
export function conversationVisibleTo(
  conv: { assigned_agent_id?: string | null },
  role: AccountRole | null,
  userId: string | null | undefined,
): boolean {
  if (!agentSeesOnlyAssigned(role)) return true
  return !!userId && conv.assigned_agent_id === userId
}

import { hasMinRole, type AccountRole } from '@/lib/auth/roles'

/** Papel mínimo pra um item de nav aparecer. */
export type NavGate = AccountRole

/** Filtra itens de nav por papel. Itens sem `minRole` aparecem pra todos.
 *  `role` nulo (perfil carregando / fora do provider) = fail-closed:
 *  esconde qualquer item gated. */
export function visibleNavItems<T extends { minRole?: NavGate }>(
  items: readonly T[],
  role: AccountRole | null,
): T[] {
  return items.filter((item) => {
    if (!item.minRole) return true
    return role != null && hasMinRole(role, item.minRole)
  })
}

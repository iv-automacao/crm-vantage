import { Building2, LayoutGrid, UserCheck, type LucideIcon } from 'lucide-react';

/**
 * Arquitetura de informação do painel interno VANTAGE.
 *
 * URL query param `?tab=` é a fonte de verdade — deep-linkável.
 */
export const ADMIN_SECTIONS = ['overview', 'approvals', 'clients'] as const;

export type AdminSection = (typeof ADMIN_SECTIONS)[number];

export const DEFAULT_ADMIN_SECTION: AdminSection = 'overview';

export interface AdminSectionMeta {
  id: AdminSection;
  label: string;
  icon: LucideIcon;
  group: 'top' | 'manage';
}

export const ADMIN_SECTION_META: Record<AdminSection, AdminSectionMeta> = {
  overview: { id: 'overview', label: 'Visão geral', icon: LayoutGrid, group: 'top' },
  approvals: { id: 'approvals', label: 'Aprovações', icon: UserCheck, group: 'manage' },
  clients: { id: 'clients', label: 'Clientes', icon: Building2, group: 'manage' },
};

export const ADMIN_RAIL_GROUPS: { label: string | null; group: AdminSectionMeta['group'] }[] = [
  { label: null, group: 'top' },
  { label: 'Gestão', group: 'manage' },
];

function isAdminSection(value: string | null): value is AdminSection {
  return !!value && (ADMIN_SECTIONS as readonly string[]).includes(value);
}

/** Resolve um valor bruto `?tab=` para uma seção. Desconhecido → padrão. */
export function resolveAdminSection(raw: string | null): AdminSection {
  if (isAdminSection(raw)) return raw;
  return DEFAULT_ADMIN_SECTION;
}

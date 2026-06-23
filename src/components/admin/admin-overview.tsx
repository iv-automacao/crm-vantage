'use client';

import { SettingsPanelHead } from '@/components/settings/settings-panel-head';
import type { AdminSection } from './admin-sections';

/**
 * Visão geral do painel admin.
 * Stub — implementação completa na Tarefa 5.
 */
export function AdminOverview({ onSelect }: { onSelect: (s: AdminSection) => void }) {
  // onSelect será usado na Tarefa 5 para cards clicáveis por seção.
  void onSelect;

  return (
    <div>
      <SettingsPanelHead
        title="Visão geral"
        description="Resumo da plataforma — contas, aprovações pendentes e status geral."
      />
      <p className="text-sm text-muted-foreground">Em breve.</p>
    </div>
  );
}

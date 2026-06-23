'use client';

import { SettingsPanelHead } from '@/components/settings/settings-panel-head';

/**
 * Painel de aprovações de contas.
 * Stub — implementação completa na Tarefa 5.
 */
export function ApprovalsPanel() {
  return (
    <div>
      <SettingsPanelHead
        title="Aprovações"
        description="Contas aguardando aprovação para acessar o CRM."
      />
      <p className="text-sm text-muted-foreground">Em breve.</p>
    </div>
  );
}

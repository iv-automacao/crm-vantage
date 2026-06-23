'use client';

import { SettingsPanelHead } from '@/components/settings/settings-panel-head';

/**
 * Painel de clientes da plataforma.
 * Stub — implementação completa na Tarefa 5.
 */
export function ClientsPanel() {
  return (
    <div>
      <SettingsPanelHead
        title="Clientes"
        description="Todas as contas ativas na plataforma VANTAGE."
      />
      <p className="text-sm text-muted-foreground">Em breve.</p>
    </div>
  );
}

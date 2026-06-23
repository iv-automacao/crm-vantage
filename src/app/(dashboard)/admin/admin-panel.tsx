'use client';

import { type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { AdminRail } from '@/components/admin/admin-rail';
import { AdminOverview } from '@/components/admin/admin-overview';
import { ApprovalsPanel } from '@/components/admin/approvals-panel';
import { ClientsPanel } from '@/components/admin/clients-panel';
import {
  resolveAdminSection,
  type AdminSection,
} from '@/components/admin/admin-sections';

/**
 * Shell client do painel interno VANTAGE. Gerencia navegação por `?tab=`
 * e renderiza o painel ativo dentro do layout do dashboard.
 */
export function AdminPanel() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // `?tab=` é a fonte de verdade — deep-linkável.
  const section = resolveAdminSection(searchParams.get('tab'));

  const go = (next: AdminSection) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', next);
    router.replace(`/admin?${params.toString()}`, { scroll: false });
  };

  const panel: Record<AdminSection, ReactNode> = {
    overview: <AdminOverview onSelect={go} />,
    approvals: <ApprovalsPanel />,
    clients: <ClientsPanel />,
  };

  return (
    <div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Painel VANTAGE
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Gestão da plataforma — contas, aprovações e clientes.
        </p>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[236px_minmax(0,1fr)] lg:items-start">
        <AdminRail active={section} onSelect={go} />
        <div className="min-w-0">{panel[section]}</div>
      </div>
    </div>
  );
}

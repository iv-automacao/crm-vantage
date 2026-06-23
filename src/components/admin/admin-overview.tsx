'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, PauseCircle, UserCheck, XCircle } from 'lucide-react';

import { SettingsPanelHead } from '@/components/settings/settings-panel-head';
import type { AdminSection } from './admin-sections';

/** Resposta da rota GET /api/admin/accounts/stats */
interface AccountStats {
  pending: number;
  active: number;
  suspended: number;
  rejected: number;
}

/** Card clicável que navega para uma seção do painel admin */
function StatCard({
  label,
  count,
  icon: Icon,
  onClick,
  iconClass,
}: {
  label: string;
  count: number;
  icon: React.ElementType;
  onClick: () => void;
  iconClass: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-start gap-3.5 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-border/80 hover:bg-card/80"
    >
      <span
        className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${iconClass}`}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-foreground">{label}</span>
        <span className="mt-0.5 block text-2xl font-bold tracking-tight text-foreground">
          {count}
        </span>
      </span>
    </button>
  );
}

/**
 * Painel de visão geral do admin.
 * Busca estatísticas de contas e exibe cards clicáveis por status.
 */
export function AdminOverview({ onSelect }: { onSelect: (s: AdminSection) => void }) {
  const [stats, setStats] = useState<AccountStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchStats() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch('/api/admin/accounts/stats', { cache: 'no-store' });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ?? 'Falha ao carregar estatísticas',
          );
        }
        const data: AccountStats = await res.json();
        if (!cancelled) setStats(data);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'Erro desconhecido');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void fetchStats();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title="Visão geral"
        description="Resumo das contas da plataforma."
      />

      {/* Estado de carregamento */}
      {loading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Carregando estatísticas…
        </div>
      )}

      {/* Estado de erro */}
      {!loading && error && (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-600 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-400">
          {error}
        </p>
      )}

      {/* Grid de cards de status — Pendentes vai para aprovações, demais para clientes */}
      {!loading && stats && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Pendentes"
            count={stats.pending}
            icon={UserCheck}
            iconClass="text-amber-500 bg-amber-50 dark:bg-amber-500/10"
            onClick={() => onSelect('approvals')}
          />
          <StatCard
            label="Ativos"
            count={stats.active}
            icon={CheckCircle2}
            iconClass="text-emerald-500 bg-emerald-50 dark:bg-emerald-500/10"
            onClick={() => onSelect('clients')}
          />
          <StatCard
            label="Suspensos"
            count={stats.suspended}
            icon={PauseCircle}
            iconClass="text-primary bg-primary/10"
            onClick={() => onSelect('clients')}
          />
          <StatCard
            label="Reprovados"
            count={stats.rejected}
            icon={XCircle}
            iconClass="text-rose-500 bg-rose-50 dark:bg-rose-500/10"
            onClick={() => onSelect('clients')}
          />
        </div>
      )}
    </section>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { SettingsPanelHead } from '@/components/settings/settings-panel-head';

/** Filtros de status disponíveis no painel de clientes */
const STATUS_FILTERS = [
  { value: 'active', label: 'Ativos' },
  { value: 'pending', label: 'Pendentes' },
  { value: 'suspended', label: 'Suspensos' },
  { value: 'rejected', label: 'Reprovados' },
] as const;

type AccountStatus = (typeof STATUS_FILTERS)[number]['value'];

/** Mapa de exibição para o tipo de conta */
const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  ia_client: 'Cliente de IA',
  self_serve: 'Self-serve',
  internal: 'Interno (VANTAGE)',
};

/** Badge de status da conta */
const STATUS_BADGE: Record<
  AccountStatus,
  { label: string; className: string }
> = {
  active: {
    label: 'Ativo',
    className:
      'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  },
  pending: {
    label: 'Pendente',
    className:
      'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  },
  suspended: {
    label: 'Suspenso',
    className: 'bg-primary/10 text-primary',
  },
  rejected: {
    label: 'Reprovado',
    className: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400',
  },
};

/** Conta retornada pela API */
interface AccountRow {
  id: string;
  name: string;
  status: AccountStatus;
  account_type: string | null;
  created_at: string;
  approved_at: string | null;
  owner_email: string | null;
  owner_name: string | null;
}

/** Formata data ISO para pt-BR */
function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  } catch {
    return '—';
  }
}

/** Card de conta com ações contextuais por status */
function ClientCard({
  account,
  busy,
  rowError,
  onSuspend,
  onReactivate,
  onDelete,
}: {
  account: AccountRow;
  busy: boolean;
  rowError: string | null;
  onSuspend: (id: string) => void;
  onReactivate: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const badge = STATUS_BADGE[account.status] ?? STATUS_BADGE.pending;
  const typeLabel = account.account_type
    ? (ACCOUNT_TYPE_LABELS[account.account_type] ?? account.account_type)
    : '—';

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      {/* Cabeçalho do card */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium text-foreground">{account.name}</p>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}
            >
              {badge.label}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {account.owner_email ?? '—'}
            {account.owner_name ? ` · ${account.owner_name}` : ''}
          </p>
        </div>

        {/* Metadados secundários */}
        <div className="flex shrink-0 flex-col items-end gap-0.5 text-xs text-muted-foreground">
          <span>{typeLabel}</span>
          {account.approved_at && (
            <span>Aprovado em {formatDate(account.approved_at)}</span>
          )}
        </div>
      </div>

      {/* Ações — dependem do status atual */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {/* Suspender: apenas contas ativas */}
        {account.status === 'active' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onSuspend(account.id)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm disabled:opacity-50"
          >
            {busy && <Loader2 className="size-3 animate-spin" />}
            Suspender
          </button>
        )}

        {/* Reativar: contas suspensas ou reprovadas */}
        {(account.status === 'suspended' || account.status === 'rejected') && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onReactivate(account.id)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy && <Loader2 className="size-3 animate-spin" />}
            Reativar
          </button>
        )}

        {/* Deletar: sempre disponível, requer confirmação digitada */}
        <button
          type="button"
          disabled={busy}
          onClick={() => onDelete(account.id)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-sm text-rose-600 hover:bg-rose-100 disabled:opacity-50 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-400"
        >
          {busy && <Loader2 className="size-3 animate-spin" />}
          Deletar
        </button>
      </div>

      {/* Erro por linha */}
      {rowError && (
        <p className="mt-2 text-xs text-rose-500">{rowError}</p>
      )}
    </div>
  );
}

/**
 * Painel de clientes da plataforma.
 * Filtra por status via botão de segmento e exibe cards com ações contextuais.
 */
export function ClientsPanel() {
  const [filter, setFilter] = useState<AccountStatus>('active');
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // ID da conta sendo processada no momento
  const [busyId, setBusyId] = useState<string | null>(null);
  // Erros por linha (chave = id da conta)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  /** Busca contas pelo filtro de status atual */
  async function fetchAccounts(status: AccountStatus) {
    setLoading(true);
    setError(null);
    setRowErrors({});
    try {
      const res = await fetch(`/api/admin/accounts?status=${status}`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? 'Falha ao carregar contas',
        );
      }
      const data = await res.json();
      setAccounts(data.accounts ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro desconhecido');
    } finally {
      setLoading(false);
    }
  }

  // Busca inicial e ao mudar o filtro
  useEffect(() => {
    void fetchAccounts(filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  async function suspend(id: string) {
    if (
      !window.confirm('Suspender esta conta? O acesso será bloqueado.')
    )
      return;

    setBusyId(id);
    setRowErrors((prev) => ({ ...prev, [id]: '' }));
    try {
      const res = await fetch(`/api/admin/accounts/${id}/suspend`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? 'Falha ao suspender');
      }
      // Rebusca a lista para garantir consistência após suspensão
      await fetchAccounts(filter);
    } catch (err) {
      setRowErrors((prev) => ({
        ...prev,
        [id]: err instanceof Error ? err.message : 'Erro ao suspender',
      }));
    } finally {
      setBusyId(null);
    }
  }

  async function reactivate(id: string) {
    setBusyId(id);
    setRowErrors((prev) => ({ ...prev, [id]: '' }));
    try {
      const res = await fetch(`/api/admin/accounts/${id}/reactivate`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? 'Falha ao reativar');
      }
      // Rebusca a lista para garantir consistência após reativação
      await fetchAccounts(filter);
    } catch (err) {
      setRowErrors((prev) => ({
        ...prev,
        [id]: err instanceof Error ? err.message : 'Erro ao reativar',
      }));
    } finally {
      setBusyId(null);
    }
  }

  async function deleteAccount(id: string) {
    // Confirmação digitada — proteção contra deleção acidental
    const typed = window.prompt(
      'Isto APAGA a conta e todos os dados, irreversível. Digite DELETAR para confirmar:',
    );
    if (typed !== 'DELETAR') return;

    setBusyId(id);
    setRowErrors((prev) => ({ ...prev, [id]: '' }));
    try {
      const res = await fetch(`/api/admin/accounts/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? 'Falha ao deletar');
      }
      // Remove da lista de forma otimista após deleção bem-sucedida
      setAccounts((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      setRowErrors((prev) => ({
        ...prev,
        [id]: err instanceof Error ? err.message : 'Erro ao deletar',
      }));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title="Clientes"
        description="Todas as contas da plataforma."
      />

      {/* Controle de segmento para filtrar por status */}
      <div className="mb-5 flex flex-wrap gap-1.5">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setFilter(f.value)}
            className={[
              'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
              filter === f.value
                ? 'bg-primary text-primary-foreground'
                : 'border border-border bg-card text-muted-foreground hover:text-foreground',
            ].join(' ')}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Estado de carregamento */}
      {loading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Carregando contas…
        </div>
      )}

      {/* Erro global ao buscar */}
      {!loading && error && (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-600 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-400">
          {error}
        </p>
      )}

      {/* Estado vazio */}
      {!loading && !error && accounts.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Nenhuma conta com status &ldquo;
          {STATUS_FILTERS.find((f) => f.value === filter)?.label ?? filter}
          &rdquo;.
        </p>
      )}

      {/* Lista de contas */}
      {!loading && accounts.length > 0 && (
        <div className="space-y-3">
          {accounts.map((account) => (
            <ClientCard
              key={account.id}
              account={account}
              busy={busyId === account.id}
              rowError={rowErrors[account.id] ?? null}
              onSuspend={suspend}
              onReactivate={reactivate}
              onDelete={deleteAccount}
            />
          ))}
        </div>
      )}
    </section>
  );
}

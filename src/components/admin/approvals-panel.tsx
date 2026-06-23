'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { SettingsPanelHead } from '@/components/settings/settings-panel-head';

/** Tipos de conta disponíveis para aprovação */
const TYPES = [
  { value: 'ia_client', label: 'Cliente de IA (cortesia)' },
  { value: 'self_serve', label: 'Self-serve (pagante)' },
  { value: 'internal', label: 'Interno (VANTAGE)' },
] as const;

/** Conta pendente retornada pela API */
interface PendingAccount {
  id: string;
  name: string;
  created_at: string;
  owner_email: string | null;
  owner_name: string | null;
}

/** Card de uma conta pendente com ações de aprovar/reprovar */
function ApprovalCard({
  account,
  busy,
  onApprove,
  onReject,
}: {
  account: PendingAccount;
  busy: boolean;
  onApprove: (id: string, accountType: string) => void;
  onReject: (id: string) => void;
}) {
  const [type, setType] = useState<string>('ia_client');

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4">
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">{account.name}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {account.owner_email ?? '—'}
          {account.owner_name ? ` · ${account.owner_name}` : ''}
        </p>
      </div>

      {/* Ações: seletor de tipo + botões de aprovar e reprovar */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          disabled={busy}
          className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm disabled:opacity-50"
        >
          {TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => onApprove(account.id, type)}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy && <Loader2 className="size-3 animate-spin" />}
          Aprovar
        </button>

        <button
          type="button"
          onClick={() => onReject(account.id)}
          disabled={busy}
          className="rounded-lg border border-border px-3 py-1.5 text-sm disabled:opacity-50"
        >
          Reprovar
        </button>
      </div>
    </div>
  );
}

/**
 * Painel de aprovações de contas.
 * Carrega pendentes na montagem e remove cada linha após aprovar/reprovar.
 */
export function ApprovalsPanel() {
  const [accounts, setAccounts] = useState<PendingAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // ID da conta sendo processada no momento — evita duplo clique
  const [busyId, setBusyId] = useState<string | null>(null);
  // Erro por linha (só exibe no card afetado)
  const [rowError, setRowError] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;

    async function fetchPending() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch('/api/admin/accounts?status=pending', {
          cache: 'no-store',
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ?? 'Falha ao carregar aprovações',
          );
        }
        const data = await res.json();
        if (!cancelled) setAccounts(data.accounts ?? []);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'Erro desconhecido');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void fetchPending();
    return () => {
      cancelled = true;
    };
  }, []);

  async function approve(id: string, accountType: string) {
    setBusyId(id);
    setRowError((prev) => ({ ...prev, [id]: '' }));
    try {
      const res = await fetch(`/api/admin/accounts/${id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_type: accountType }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? 'Falha ao aprovar');
      }
      // Remove da lista de forma otimista após aprovação bem-sucedida
      setAccounts((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      setRowError((prev) => ({
        ...prev,
        [id]: err instanceof Error ? err.message : 'Erro ao aprovar',
      }));
    } finally {
      setBusyId(null);
    }
  }

  async function reject(id: string) {
    // Cancelar o prompt encerra o fluxo sem ação
    const reason = window.prompt('Motivo da reprovação (opcional):');
    if (reason === null) return;

    setBusyId(id);
    setRowError((prev) => ({ ...prev, [id]: '' }));
    try {
      const res = await fetch(`/api/admin/accounts/${id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? 'Falha ao reprovar');
      }
      // Remove da lista de forma otimista após reprovação bem-sucedida
      setAccounts((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      setRowError((prev) => ({
        ...prev,
        [id]: err instanceof Error ? err.message : 'Erro ao reprovar',
      }));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title="Aprovações"
        description="Contas aguardando liberação. Aprove (escolha o tipo) ou reprove."
      />

      {/* Estado de carregamento */}
      {loading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Carregando aprovações…
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
        <p className="text-sm text-muted-foreground">Nenhuma conta pendente. 🎉</p>
      )}

      {/* Lista de contas pendentes */}
      {!loading && accounts.length > 0 && (
        <div className="space-y-3">
          {accounts.map((account) => (
            <div key={account.id}>
              <ApprovalCard
                account={account}
                busy={busyId === account.id}
                onApprove={approve}
                onReject={reject}
              />
              {/* Erro por linha — exibido abaixo do card */}
              {rowError[account.id] && (
                <p className="mt-1 px-1 text-xs text-rose-500">{rowError[account.id]}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

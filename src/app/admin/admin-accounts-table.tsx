"use client";

import { useState } from "react";

interface Row {
  id: string;
  name: string;
  created_at: string;
  owner_email: string;
  owner_name: string | null;
}

const TYPES = [
  { value: "ia_client", label: "Cliente de IA (cortesia)" },
  { value: "self_serve", label: "Self-serve (pagante)" },
  { value: "internal", label: "Interno (VANTAGE)" },
] as const;

export function AdminAccountsTable({ initialRows }: { initialRows: Row[] }) {
  const [rows, setRows] = useState<Row[]>(initialRows);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function approve(id: string, accountType: string) {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/accounts/${id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_type: accountType }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Falha ao aprovar");
      setRows((r) => r.filter((x) => x.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro");
    } finally {
      setBusyId(null);
    }
  }

  async function reject(id: string) {
    const reason = window.prompt("Motivo da reprovação (opcional):") ?? "";
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/accounts/${id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Falha ao reprovar");
      setRows((r) => r.filter((x) => x.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro");
    } finally {
      setBusyId(null);
    }
  }

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">Nenhuma conta pendente. 🎉</p>;
  }

  return (
    <div className="space-y-3">
      {error ? <p className="text-sm text-red-500">{error}</p> : null}
      {rows.map((row) => (
        <ApprovalRow
          key={row.id}
          row={row}
          busy={busyId === row.id}
          onApprove={approve}
          onReject={reject}
        />
      ))}
    </div>
  );
}

function ApprovalRow({
  row,
  busy,
  onApprove,
  onReject,
}: {
  row: Row;
  busy: boolean;
  onApprove: (id: string, type: string) => void;
  onReject: (id: string) => void;
}) {
  const [type, setType] = useState<string>("ia_client");
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4">
      <div>
        <p className="font-medium text-foreground">{row.name}</p>
        <p className="text-xs text-muted-foreground">
          {row.owner_email}
          {row.owner_name ? ` · ${row.owner_name}` : ""}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          disabled={busy}
          className="rounded-lg border border-border bg-background px-2 py-1 text-sm"
        >
          {TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <button
          onClick={() => onApprove(row.id, type)}
          disabled={busy}
          className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          Aprovar
        </button>
        <button
          onClick={() => onReject(row.id)}
          disabled={busy}
          className="rounded-lg border border-border px-3 py-1.5 text-sm disabled:opacity-50"
        >
          Reprovar
        </button>
      </div>
    </div>
  );
}

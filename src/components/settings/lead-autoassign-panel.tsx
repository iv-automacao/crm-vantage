'use client';

// ============================================================
// LeadAutoassignPanel — Configurações → Distribuição de leads
//
// Permite que o admin da conta ligue/desligue a distribuição
// automática de leads em rodízio e gerencie quais vendedores
// fazem parte do pool de atribuição.
//
// Segurança: apenas admins (canManageMembers) acessam este painel.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Lock, Shuffle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/hooks/use-auth';
import { SettingsPanelHead } from './settings-panel-head';

// ─── Tipos da resposta do GET /api/account/lead-autoassign ──────────────────

interface RosterEntry {
  user_id: string;
  full_name: string | null;
  email: string | null;
  in_pool: boolean;
  is_available: boolean;
  available_now: boolean;
}

interface AutoassignView {
  is_active: boolean;
  roster: RosterEntry[];
  waiting_count: number;
}

// ─── Componente principal ────────────────────────────────────────────────────

export function LeadAutoassignPanel() {
  const { canManageMembers } = useAuth();

  const [view, setView] = useState<AutoassignView | null>(null);
  const [loading, setLoading] = useState(true);
  // IDs de agentes cujo switch de pool está sendo salvo
  const [savingPool, setSavingPool] = useState<Set<string>>(new Set());
  const [savingActive, setSavingActive] = useState(false);

  // Carrega a view completa do servidor
  const loadView = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/account/lead-autoassign', { cache: 'no-store' });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(payload.error ?? 'Falha ao carregar configuração de distribuição');
        return;
      }
      const data = (await res.json()) as AutoassignView;
      setView(data);
    } catch (err) {
      console.error('[LeadAutoassignPanel] loadView error:', err);
      toast.error('Não foi possível conectar ao servidor');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canManageMembers) {
      void loadView();
    } else {
      setLoading(false);
    }
  }, [canManageMembers, loadView]);

  // Toggle principal: liga/desliga a distribuição automática
  async function handleToggleActive(next: boolean) {
    if (!view) return;

    // Atualização otimista
    setView((prev) => prev ? { ...prev, is_active: next } : prev);
    setSavingActive(true);
    try {
      const res = await fetch('/api/account/lead-autoassign', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: next }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        // Reverte o estado otimista em caso de erro
        setView((prev) => prev ? { ...prev, is_active: !next } : prev);
        toast.error(payload.error ?? 'Falha ao atualizar configuração');
        return;
      }
      const data = (await res.json()) as AutoassignView;
      setView(data);
      toast.success(next ? 'Distribuição automática ligada' : 'Distribuição automática desligada');
    } catch (err) {
      console.error('[LeadAutoassignPanel] handleToggleActive error:', err);
      setView((prev) => prev ? { ...prev, is_active: !next } : prev);
      toast.error('Não foi possível conectar ao servidor');
    } finally {
      setSavingActive(false);
    }
  }

  // Toggle de "no rodízio" por agente
  async function handleTogglePool(userId: string, nextInPool: boolean) {
    if (!view) return;

    // Atualização otimista da lista
    setView((prev) =>
      prev
        ? {
            ...prev,
            roster: prev.roster.map((r) =>
              r.user_id === userId ? { ...r, in_pool: nextInPool } : r,
            ),
          }
        : prev,
    );
    setSavingPool((prev) => new Set(prev).add(userId));
    try {
      const res = await fetch('/api/account/lead-autoassign', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pool: [{ user_id: userId, in_pool: nextInPool }] }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        // Reverte
        setView((prev) =>
          prev
            ? {
                ...prev,
                roster: prev.roster.map((r) =>
                  r.user_id === userId ? { ...r, in_pool: !nextInPool } : r,
                ),
              }
            : prev,
        );
        toast.error(payload.error ?? 'Falha ao atualizar rodízio do agente');
        return;
      }
      const data = (await res.json()) as AutoassignView;
      setView(data);
      toast.success(nextInPool ? 'Agente adicionado ao rodízio' : 'Agente removido do rodízio');
    } catch (err) {
      console.error('[LeadAutoassignPanel] handleTogglePool error:', err);
      setView((prev) =>
        prev
          ? {
              ...prev,
              roster: prev.roster.map((r) =>
                r.user_id === userId ? { ...r, in_pool: !nextInPool } : r,
              ),
            }
          : prev,
      );
      toast.error('Não foi possível conectar ao servidor');
    } finally {
      setSavingPool((prev) => {
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
    }
  }

  // Não-admin: bloqueio igual ao capi-panel
  if (!canManageMembers) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead
          title="Distribuição de leads"
          description="Leads novos são atribuídos automaticamente em rodízio aos vendedores disponíveis."
        />
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-10 text-center">
            <Lock className="size-6 text-muted-foreground" />
            <p className="mt-2 text-sm text-muted-foreground">
              Apenas o dono e administradores da conta podem configurar a distribuição automática de leads.
            </p>
          </CardContent>
        </Card>
      </section>
    );
  }

  return (
    <section className="animate-in fade-in-50 space-y-8 duration-200">
      {/* Cabeçalho da seção */}
      <SettingsPanelHead
        title="Distribuição de leads"
        description="Leads novos são atribuídos automaticamente em rodízio aos vendedores disponíveis. Ligue para ativar; configure o pool de agentes abaixo."
      />

      {/* ── Toggle principal ── */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center gap-3">
            <Shuffle className="size-4 text-primary" />
            <span className="text-sm font-semibold text-foreground">Distribuição automática</span>
          </div>

          <div className="mt-4 flex items-center justify-between">
            <div className="space-y-1">
              <Label htmlFor="autoassign-toggle" className="text-sm font-medium text-foreground">
                {view?.is_active ? 'Ligada' : 'Desligada'}
              </Label>
              <p className="text-xs text-muted-foreground">
                Quando ligada, novos leads sem atribuição entram na fila do rodízio.
              </p>
            </div>

            {loading ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            ) : (
              <Switch
                id="autoassign-toggle"
                checked={view?.is_active ?? false}
                onCheckedChange={(checked) => void handleToggleActive(checked)}
                disabled={savingActive || !view}
              />
            )}
          </div>

          {/* Alerta de leads aguardando atribuição */}
          {(view?.waiting_count ?? 0) > 0 && (
            <p className="mt-4 text-xs font-medium text-amber-400">
              {view!.waiting_count}{' '}
              {view!.waiting_count === 1
                ? 'lead aguardando atribuição'
                : 'leads aguardando atribuição'}
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Roster de agentes ── */}
      <Card>
        <CardContent className="pt-6">
          <div className="mb-4 flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">Pool de atribuição</span>
            <span className="text-xs text-muted-foreground">
              — apenas agentes &quot;no rodízio&quot; recebem leads automaticamente
            </span>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : !view || view.roster.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nenhum agente encontrado nesta conta.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {view.roster.map((agent) => (
                <li key={agent.user_id} className="flex items-center gap-3 py-3">
                  {/* Indicador de disponibilidade real (janela 15 min) */}
                  <span
                    className={`mt-0.5 size-2 shrink-0 rounded-full ${
                      agent.available_now ? 'bg-green-500' : 'bg-muted-foreground/40'
                    }`}
                    title={agent.available_now ? 'Disponível agora' : 'Ausente'}
                  />

                  {/* Nome e email */}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {agent.full_name ?? agent.email ?? agent.user_id}
                    </p>
                    {agent.full_name && agent.email && (
                      <p className="truncate text-xs text-muted-foreground">{agent.email}</p>
                    )}
                    <div className="mt-1 flex items-center gap-2">
                      {/* Status de disponibilidade real */}
                      <span
                        className={`text-[10px] font-medium ${
                          agent.available_now ? 'text-green-400' : 'text-muted-foreground'
                        }`}
                      >
                        {agent.available_now ? 'Disponível agora' : 'Ausente'}
                      </span>
                      {/* Estado do toggle manual do agente */}
                      <Badge
                        variant="outline"
                        className="h-4 px-1 text-[9px] uppercase tracking-wide text-muted-foreground"
                      >
                        {agent.is_available ? 'toggle on' : 'toggle off'}
                      </Badge>
                    </div>
                  </div>

                  {/* Switch "No rodízio" */}
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Switch
                      id={`pool-${agent.user_id}`}
                      checked={agent.in_pool}
                      onCheckedChange={(checked) => void handleTogglePool(agent.user_id, checked)}
                      disabled={savingPool.has(agent.user_id)}
                    />
                    <Label
                      htmlFor={`pool-${agent.user_id}`}
                      className="cursor-pointer text-[10px] text-muted-foreground"
                    >
                      No rodízio
                    </Label>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

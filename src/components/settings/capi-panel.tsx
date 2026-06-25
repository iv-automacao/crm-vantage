'use client';

// ============================================================
// CapiPanel — Configurações → CAPI / Meta
//
// Configura a integração com a Meta Conversions API (CAPI) por
// conta. Devolve eventos de "negócio ganho" para o Meta, fechando
// o loop CRM ↔ anúncios Click-to-WhatsApp.
//
// Duas seções:
//   1. Form de configuração (dataset_id, access_token, event_name,
//      is_active) — GET/PUT /api/account/capi
//   2. Tabela de conversões recentes com botão "Reenviar" por linha
//      — GET /api/account/capi/events + POST /api/account/capi/events/[id]/resend
//
// Segurança: mesmo gate admin do webhooks-panel (canManageMembers).
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Lock, RefreshCw, Target } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/use-auth';
import { SettingsPanelHead } from './settings-panel-head';

// Resposta do GET /api/account/capi — sem access_token, só flag
interface CapiView {
  dataset_id: string | null;
  event_name: string;
  is_active: boolean;
  has_access_token: boolean;
}

// Item retornado pelo GET /api/account/capi/events
interface CapiEvent {
  id: string;
  status: 'pending' | 'sent' | 'skipped' | 'failed';
  event_name: string;
  value: number | null;
  currency: string | null;
  last_error: string | null;
  attempts: number;
  created_at: string;
  sent_at: string | null;
}

// Formata data ISO para pt-BR curto
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Badge colorido por status do evento
function StatusBadge({ status }: { status: CapiEvent['status'] }) {
  const map: Record<CapiEvent['status'], string> = {
    sent: 'bg-primary-soft text-primary border-border',
    pending: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    failed: 'bg-red-500/15 text-red-300 border-red-500/30',
    skipped: 'bg-muted text-muted-foreground border-border',
  };
  const label: Record<CapiEvent['status'], string> = {
    sent: 'Enviado',
    pending: 'Pendente',
    failed: 'Falha',
    skipped: 'Ignorado',
  };
  return (
    <Badge className={`${map[status]} text-[10px] uppercase tracking-wide`}>
      {label[status]}
    </Badge>
  );
}

export function CapiPanel() {
  const { canManageMembers } = useAuth();

  // Estado da configuração
  const [view, setView] = useState<CapiView | null>(null);
  const [datasetId, setDatasetId] = useState('');
  const [token, setToken] = useState('');
  const [eventName, setEventName] = useState('Purchase');
  const [isActive, setIsActive] = useState(false);
  const [saving, setSaving] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);

  // Estado da tabela de eventos
  const [events, setEvents] = useState<CapiEvent[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(true);

  // IDs com reenvio em andamento
  const [resendingIds, setResendingIds] = useState<Set<string>>(new Set());

  // Carrega configuração da conta
  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/account/capi', { cache: 'no-store' });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(payload.error ?? 'Falha ao carregar configuração CAPI');
        return;
      }
      const data = (await res.json()) as CapiView;
      setView(data);
      setDatasetId(data.dataset_id ?? '');
      setEventName(data.event_name);
      setIsActive(data.is_active);
    } catch (err) {
      console.error('[CapiPanel] loadConfig error:', err);
      toast.error('Não foi possível conectar ao servidor');
    }
  }, []);

  // Carrega conversões recentes
  const loadEvents = useCallback(async () => {
    setLoadingEvents(true);
    try {
      const res = await fetch('/api/account/capi/events?limit=50', { cache: 'no-store' });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(payload.error ?? 'Falha ao carregar conversões');
        return;
      }
      const data = (await res.json()) as { events: CapiEvent[] };
      setEvents(data.events ?? []);
    } catch (err) {
      console.error('[CapiPanel] loadEvents error:', err);
      toast.error('Não foi possível conectar ao servidor');
    } finally {
      setLoadingEvents(false);
    }
  }, []);

  useEffect(() => {
    if (canManageMembers) {
      void loadConfig();
      void loadEvents();
    } else {
      setLoadingEvents(false);
    }
  }, [canManageMembers, loadConfig, loadEvents]);

  // Salva configuração via PUT
  async function handleSave() {
    setSaving(true);
    setConfigError(null);
    try {
      const body: Record<string, unknown> = {
        dataset_id: datasetId.trim() || null,
        event_name: eventName.trim() || 'Purchase',
        is_active: isActive,
      };
      // Só envia o token se o usuário digitou algo — campo vazio mantém o salvo
      if (token) body.access_token = token;

      const res = await fetch('/api/account/capi', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        setConfigError(payload.error ?? 'Falha ao salvar');
        return;
      }

      toast.success('Configuração CAPI salva');
      setToken(''); // limpa campo de token após salvar
      await loadConfig();
    } catch (err) {
      console.error('[CapiPanel] handleSave error:', err);
      toast.error('Não foi possível conectar ao servidor');
    } finally {
      setSaving(false);
    }
  }

  // Reenvia um evento de conversão via POST
  async function handleResend(id: string) {
    setResendingIds((prev) => new Set(prev).add(id));
    try {
      const res = await fetch(`/api/account/capi/events/${id}/resend`, { method: 'POST' });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(payload.error ?? 'Falha ao reenviar conversão');
        return;
      }
      toast.success('Conversão reenviada');
      await loadEvents();
    } catch (err) {
      console.error('[CapiPanel] handleResend error:', err);
      toast.error('Não foi possível conectar ao servidor');
    } finally {
      setResendingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  // Não-admin: sem acesso (espelha o requireRole('admin') do servidor)
  if (!canManageMembers) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead
          title="CAPI / Meta"
          description="Devolve conversões de negócios ganhos para o Meta, otimizando seus anúncios Click-to-WhatsApp."
        />
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-10 text-center">
            <Lock className="size-6 text-muted-foreground" />
            <p className="mt-2 text-sm text-muted-foreground">
              Apenas o dono e administradores da conta podem configurar a integração CAPI.
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
        title="CAPI / Meta"
        description="Devolve conversões de negócios ganhos para o Meta, fechando o loop entre o CRM e seus anúncios Click-to-WhatsApp."
      />

      {/* ── Formulário de configuração ── */}
      <Card>
        <CardContent className="space-y-5 pt-6">
          <div className="flex items-center gap-2">
            <Target className="size-4 text-primary" />
            <span className="text-sm font-semibold text-foreground">Configuração da conta</span>
          </div>

          {/* Dataset ID */}
          <div className="space-y-2">
            <Label className="text-muted-foreground">
              Dataset ID <span className="text-red-400">*</span>
            </Label>
            <Input
              placeholder="ex.: 123456789012345"
              value={datasetId}
              onChange={(e) => setDatasetId(e.target.value)}
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>

          {/* Access Token */}
          <div className="space-y-2">
            <Label className="text-muted-foreground">
              Access Token <span className="text-red-400">*</span>
            </Label>
            <Input
              type="password"
              placeholder={
                view?.has_access_token
                  ? '•••••••• (mantém o token salvo)'
                  : 'Cole o token do System User'
              }
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
            {view?.has_access_token && (
              <p className="text-xs text-muted-foreground">
                Token já configurado. Deixe em branco para manter ou cole um novo para substituir.
              </p>
            )}
          </div>

          {/* Evento de conversão */}
          <div className="space-y-2">
            <Label className="text-muted-foreground">Evento de conversão</Label>
            <Input
              placeholder="Purchase"
              value={eventName}
              onChange={(e) => setEventName(e.target.value)}
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
            <p className="text-xs text-muted-foreground">
              Nome do evento padrão para a Meta. Use <code className="font-mono">Purchase</code>{' '}
              para conversões de venda.
            </p>
          </div>

          {/* Toggle ativo */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              role="switch"
              aria-checked={isActive}
              onClick={() => setIsActive((v) => !v)}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                isActive ? 'bg-primary' : 'bg-muted-foreground/30'
              }`}
            >
              <span
                className={`inline-block size-3.5 rounded-full bg-white shadow transition-transform ${
                  isActive ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
            <Label className="cursor-pointer text-muted-foreground" onClick={() => setIsActive((v) => !v)}>
              {isActive ? 'Integração ativa' : 'Integração inativa'}
            </Label>
          </div>

          {/* Erro de validação do servidor (ex.: 422) */}
          {configError && (
            <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {configError}
            </p>
          )}

          {/* Botão salvar */}
          <div className="flex justify-end">
            <Button
              onClick={() => void handleSave()}
              disabled={saving}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Salvando…
                </>
              ) : (
                'Salvar configuração'
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── Tabela de conversões recentes ── */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">Conversões recentes</h3>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadEvents()}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            <RefreshCw className="size-3.5" />
            Atualizar
          </Button>
        </div>

        <Card>
          <CardContent className="p-0">
            {loadingEvents ? (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="size-5 animate-spin text-primary" />
              </div>
            ) : events.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <Target className="size-6 text-muted-foreground" />
                <p className="mt-2 text-sm text-muted-foreground">Nenhuma conversão registrada ainda.</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  As conversões aparecem quando um negócio é marcado como ganho.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left">
                      <th className="px-4 py-3 text-xs font-medium text-muted-foreground">Status</th>
                      <th className="px-4 py-3 text-xs font-medium text-muted-foreground">Evento</th>
                      <th className="px-4 py-3 text-xs font-medium text-muted-foreground">Valor</th>
                      <th className="px-4 py-3 text-xs font-medium text-muted-foreground">Tentativas</th>
                      <th className="px-4 py-3 text-xs font-medium text-muted-foreground">Erro</th>
                      <th className="px-4 py-3 text-xs font-medium text-muted-foreground">Criado em</th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((ev) => (
                      <tr key={ev.id} className="border-t border-border">
                        <td className="px-4 py-3">
                          <StatusBadge status={ev.status} />
                        </td>
                        <td className="px-4 py-3 text-foreground">{ev.event_name}</td>
                        <td className="px-4 py-3 text-foreground">
                          {ev.value != null
                            ? `${ev.currency ?? ''} ${ev.value.toLocaleString('pt-BR')}`
                            : '—'}
                        </td>
                        <td className="px-4 py-3 text-foreground">{ev.attempts}</td>
                        <td className="max-w-[200px] truncate px-4 py-3 text-red-400">
                          {ev.last_error ?? '—'}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{fmtDate(ev.created_at)}</td>
                        <td className="px-4 py-3">
                          {/* Botão de reenvio oculto para eventos já enviados */}
                          {ev.status !== 'sent' && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={resendingIds.has(ev.id)}
                              onClick={() => void handleResend(ev.id)}
                              className="border-border text-muted-foreground hover:bg-muted"
                            >
                              {resendingIds.has(ev.id) ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : (
                                <RefreshCw className="size-3.5" />
                              )}
                              Reenviar
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

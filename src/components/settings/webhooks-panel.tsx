'use client';

// ============================================================
// WebhooksPanel — Settings → Webhooks
//
// Cria e gerencia endpoints de webhook por conta. Quando um
// cliente envia mensagem no WhatsApp, o CRM faz um POST para
// cada endpoint ativo com um token estático no header (x-webhook-token),
// validável pelo Header Auth do n8n.
//
// Segurança / UX
//   - Só admin+ (Dono + Admins) enxerga e gerencia (espelha o
//     gate server-side requireRole('admin')). Não-admin vê aviso.
//   - O token aparece UMA vez (criação e após rotacionar); não há reexibição.
//     Perdeu? Use Rotacionar pra gerar outro.
//   - Deletar é imediato e irreversível.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Copy,
  KeyRound,
  Loader2,
  Lock,
  Plus,
  ToggleLeft,
  ToggleRight,
  Trash2,
  Webhook,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/use-auth';
import { SettingsPanelHead } from './settings-panel-head';

// Tipo retornado pelo GET /api/account/webhooks
interface WebhookEndpoint {
  id: string;
  url: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
}

const MAX_URL_LEN = 2048;
const MAX_DESC_LEN = 255;

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// Caixa de revelação do token — mostrada uma vez (na criação e após rotacionar).
// Inclui o header e a instrução de Header Auth do n8n pra facilitar o setup.
function SecretRevealBox({ secret }: { secret: string }) {
  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copiado`);
    } catch {
      toast.error('Área de transferência bloqueada — copie manualmente');
    }
  }
  return (
    <div className="space-y-3 py-2">
      <div className="space-y-1">
        <Label className="text-muted-foreground">Header</Label>
        <div className="flex gap-2">
          <Input
            readOnly
            value="x-webhook-token"
            className="bg-muted border-border text-foreground font-mono text-xs"
            onFocus={(e) => e.currentTarget.select()}
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => copy('x-webhook-token', 'Header')}
            className="border-border text-muted-foreground hover:bg-muted shrink-0"
          >
            <Copy className="size-4" />
          </Button>
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-muted-foreground">Token</Label>
        <div className="flex gap-2">
          <Input
            readOnly
            value={secret}
            className="bg-muted border-border text-foreground font-mono text-xs"
            onFocus={(e) => e.currentTarget.select()}
          />
          <Button
            type="button"
            onClick={() => copy(secret, 'Token')}
            className="bg-primary hover:bg-primary/90 text-primary-foreground shrink-0"
          >
            <Copy className="size-4" />
            Copiar
          </Button>
        </div>
      </div>
      <div className="rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        No n8n: nó <strong className="text-foreground">Webhook</strong> → Authentication:{' '}
        <strong className="text-foreground">Header Auth</strong> → crie a credencial com{' '}
        Name = <code className="text-foreground">x-webhook-token</code> e Value = este token.
      </div>
      <div className="rounded-md border border-amber-500/50 bg-amber-500/15 px-3 py-2 text-xs text-amber-200">
        <strong className="font-semibold text-amber-100">Salve este token agora.</strong>{' '}
        Não guardamos o texto puro — pra trocar, use o botão Rotacionar.
      </div>
    </div>
  );
}

export function WebhooksPanel() {
  const { canManageMembers } = useAuth();

  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [loading, setLoading] = useState(true);

  // Estado do dialog de criação
  const [createOpen, setCreateOpen] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);

  // Secret retornado uma única vez pelo POST
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);

  // Estado do dialog de confirmação de exclusão
  const [deleting, setDeleting] = useState<WebhookEndpoint | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // Estado do dialog de confirmação de rotação + revelação do novo token
  const [rotating, setRotating] = useState<WebhookEndpoint | null>(null);
  const [rotateBusy, setRotateBusy] = useState(false);
  const [rotatedSecret, setRotatedSecret] = useState<string | null>(null);

  // IDs com toggle em andamento (para desabilitar o botão)
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());

  // Carrega a lista de endpoints da conta
  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/account/webhooks', { cache: 'no-store' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Falha ao carregar webhooks');
        return;
      }
      // A rota GET /api/account/webhooks devolve { endpoints }.
      const data = (await res.json()) as { endpoints: WebhookEndpoint[] };
      setEndpoints(data.endpoints ?? []);
    } catch (err) {
      console.error('[WebhooksPanel] load error:', err);
      toast.error('Não foi possível conectar ao servidor');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canManageMembers) void load();
    else setLoading(false);
  }, [canManageMembers, load]);

  // Cria um novo endpoint via POST
  async function handleCreate() {
    const url = newUrl.trim();
    if (!url) {
      toast.error('Informe a URL do endpoint (ex.: https://seu-n8n.com/webhook/...)');
      return;
    }
    if (!url.startsWith('https://') && !url.startsWith('http://')) {
      toast.error('A URL deve começar com http:// ou https://');
      return;
    }
    setCreating(true);
    try {
      const res = await fetch('/api/account/webhooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, description: newDesc.trim() || undefined }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Falha ao criar o webhook');
        return;
      }
      const data = (await res.json()) as { secret: string };
      setCreatedSecret(data.secret);
      setNewUrl('');
      setNewDesc('');
      void load();
    } catch (err) {
      console.error('[WebhooksPanel] create error:', err);
      toast.error('Não foi possível conectar ao servidor');
    } finally {
      setCreating(false);
    }
  }

  // Alterna is_active via PATCH
  async function handleToggle(endpoint: WebhookEndpoint) {
    setTogglingIds((prev) => new Set(prev).add(endpoint.id));
    try {
      const res = await fetch(`/api/account/webhooks/${endpoint.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !endpoint.is_active }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Falha ao atualizar o webhook');
        return;
      }
      toast.success(endpoint.is_active ? 'Webhook desativado' : 'Webhook ativado');
      void load();
    } catch (err) {
      console.error('[WebhooksPanel] toggle error:', err);
      toast.error('Não foi possível conectar ao servidor');
    } finally {
      setTogglingIds((prev) => {
        const next = new Set(prev);
        next.delete(endpoint.id);
        return next;
      });
    }
  }

  // Exclui o endpoint via DELETE
  async function handleDelete() {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      const res = await fetch(`/api/account/webhooks/${deleting.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Falha ao excluir o webhook');
        return;
      }
      toast.success('Webhook excluído');
      setDeleting(null);
      void load();
    } catch (err) {
      console.error('[WebhooksPanel] delete error:', err);
      toast.error('Não foi possível conectar ao servidor');
    } finally {
      setDeleteBusy(false);
    }
  }

  // Rotaciona o token do endpoint via POST .../rotate
  async function handleRotate() {
    if (!rotating) return;
    setRotateBusy(true);
    try {
      const res = await fetch(`/api/account/webhooks/${rotating.id}/rotate`, {
        method: 'POST',
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Falha ao rotacionar o token');
        return;
      }
      const data = (await res.json()) as { secret: string };
      setRotatedSecret(data.secret); // revela uma vez
    } catch (err) {
      console.error('[WebhooksPanel] rotate error:', err);
      toast.error('Não foi possível conectar ao servidor');
    } finally {
      setRotateBusy(false);
    }
  }

  // Não-admin: sem acesso (espelha o requireRole('admin') do servidor)
  if (!canManageMembers) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead
          title="Webhooks"
          description="Receba um POST no seu n8n quando um cliente mandar mensagem no WhatsApp."
        />
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-10 text-center">
            <Lock className="size-6 text-muted-foreground" />
            <p className="mt-2 text-sm text-muted-foreground">
              Apenas o dono e administradores da conta podem gerenciar webhooks.
            </p>
          </CardContent>
        </Card>
      </section>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
        title="Webhooks"
        description="Receba um POST no seu n8n quando um cliente mandar mensagem no WhatsApp."
        action={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            Novo webhook
          </Button>
        }
      />

      {/* Lista de endpoints */}
      {endpoints.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-10 text-center">
            <Webhook className="size-6 text-muted-foreground" />
            <p className="mt-2 text-sm text-muted-foreground">Nenhum webhook cadastrado ainda.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Clique em <span className="text-muted-foreground">Novo webhook</span> para adicionar
              um endpoint.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y divide-border">
              {endpoints.map((ep) => (
                <li key={ep.id} className="flex items-center gap-4 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {ep.url}
                      </span>
                      {ep.is_active ? (
                        <Badge className="bg-primary-soft text-primary border-border text-[10px] uppercase tracking-wide">
                          Ativo
                        </Badge>
                      ) : (
                        <Badge className="bg-muted text-muted-foreground border-border text-[10px] uppercase tracking-wide">
                          Inativo
                        </Badge>
                      )}
                    </div>
                    {ep.description && (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {ep.description}
                      </p>
                    )}
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Criado em {fmtDate(ep.created_at)}
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    {/* Botão de toggle ativo/inativo */}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={togglingIds.has(ep.id)}
                      onClick={() => handleToggle(ep)}
                      className="border-border text-muted-foreground hover:bg-muted"
                      title={ep.is_active ? 'Desativar' : 'Ativar'}
                    >
                      {togglingIds.has(ep.id) ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : ep.is_active ? (
                        <ToggleRight className="size-4 text-primary" />
                      ) : (
                        <ToggleLeft className="size-4" />
                      )}
                      {ep.is_active ? 'Desativar' : 'Ativar'}
                    </Button>

                    {/* Botão de rotacionar token */}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setRotating(ep)}
                      className="border-border text-muted-foreground hover:bg-muted"
                      title="Gerar um token novo (invalida o atual)"
                    >
                      <KeyRound className="size-4" />
                      Rotacionar
                    </Button>

                    {/* Botão de exclusão */}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setDeleting(ep)}
                      className="border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20 hover:border-red-500/60 hover:text-red-200"
                    >
                      <Trash2 className="size-4" />
                      Excluir
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Dialog: criar webhook / revelar secret */}
      <Dialog
        open={createOpen}
        onOpenChange={(next) => {
          // Ao fechar, descarta campos e o secret — não reexibir.
          if (!next) {
            setNewUrl('');
            setNewDesc('');
            setCreatedSecret(null);
          }
          setCreateOpen(next);
        }}
      >
        <DialogContent className="bg-popover border-border sm:max-w-md">
          {createdSecret ? (
            // Etapa 2: exibir o secret UMA vez após criação bem-sucedida
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-popover-foreground">
                  <Webhook className="size-4 text-primary" />
                  Webhook criado
                </DialogTitle>
                <DialogDescription className="text-muted-foreground">
                  Copie o token agora e configure-o no n8n (Header Auth). Por segurança,
                  não guardamos o valor — assim que fechar, ele desaparece.
                </DialogDescription>
              </DialogHeader>

              <SecretRevealBox secret={createdSecret} />

              <DialogFooter className="bg-popover border-border">
                <Button
                  onClick={() => setCreateOpen(false)}
                  className="bg-primary hover:bg-primary/90 text-primary-foreground"
                >
                  Concluir
                </Button>
              </DialogFooter>
            </>
          ) : (
            // Etapa 1: formulário de criação
            <>
              <DialogHeader>
                <DialogTitle className="text-popover-foreground">Novo webhook</DialogTitle>
                <DialogDescription className="text-muted-foreground">
                  Informe a URL do endpoint que receberá os eventos do WhatsApp.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-2">
                <div className="space-y-2">
                  <Label className="text-muted-foreground">
                    URL <span className="text-red-400">*</span>
                  </Label>
                  <Input
                    placeholder="https://seu-n8n.com/webhook/..."
                    value={newUrl}
                    onChange={(e) => setNewUrl(e.target.value)}
                    maxLength={MAX_URL_LEN}
                    className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !creating) void handleCreate();
                    }}
                  />
                </div>

                <div className="space-y-2">
                  <Label className="text-muted-foreground">Descrição (opcional)</Label>
                  <Input
                    placeholder="ex.: Agente La Fatia — produção"
                    value={newDesc}
                    onChange={(e) => setNewDesc(e.target.value)}
                    maxLength={MAX_DESC_LEN}
                    className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                  />
                </div>
              </div>

              <DialogFooter className="bg-popover border-border">
                <Button
                  variant="outline"
                  onClick={() => setCreateOpen(false)}
                  className="border-border text-muted-foreground hover:bg-muted"
                >
                  Cancelar
                </Button>
                <Button
                  onClick={handleCreate}
                  disabled={creating}
                  className="bg-primary hover:bg-primary/90 text-primary-foreground"
                >
                  {creating ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Criando...
                    </>
                  ) : (
                    'Criar webhook'
                  )}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Dialog: confirmar exclusão */}
      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent className="bg-popover border-border sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-popover-foreground">
              <AlertTriangle className="size-4 text-amber-400" />
              Excluir webhook
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Excluir o endpoint{' '}
              <span className="font-medium text-muted-foreground break-all">
                {deleting?.url}
              </span>
              ? O n8n deixará de receber eventos imediatamente. Não dá pra desfazer.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setDeleting(null)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              Cancelar
            </Button>
            <Button
              onClick={handleDelete}
              disabled={deleteBusy}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {deleteBusy ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Excluindo...
                </>
              ) : (
                'Excluir webhook'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog: rotacionar token (confirmação → revelação uma vez) */}
      <Dialog
        open={rotating !== null}
        onOpenChange={(next) => {
          if (!next) {
            setRotating(null);
            setRotatedSecret(null);
          }
        }}
      >
        <DialogContent className="bg-popover border-border sm:max-w-md">
          {rotatedSecret ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-popover-foreground">
                  <KeyRound className="size-4 text-primary" />
                  Token rotacionado
                </DialogTitle>
                <DialogDescription className="text-muted-foreground">
                  O token antigo foi invalidado. Atualize o valor no n8n (Header Auth)
                  com o novo token abaixo.
                </DialogDescription>
              </DialogHeader>
              <SecretRevealBox secret={rotatedSecret} />
              <DialogFooter className="bg-popover border-border">
                <Button
                  onClick={() => { setRotating(null); setRotatedSecret(null); }}
                  className="bg-primary hover:bg-primary/90 text-primary-foreground"
                >
                  Concluir
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-popover-foreground">
                  <AlertTriangle className="size-4 text-amber-400" />
                  Rotacionar token
                </DialogTitle>
                <DialogDescription className="text-muted-foreground">
                  Gera um token novo para{' '}
                  <span className="font-medium text-muted-foreground break-all">
                    {rotating?.url}
                  </span>{' '}
                  e invalida o atual. O n8n para de validar até você atualizar o token lá.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter className="bg-popover border-border">
                <Button
                  variant="outline"
                  onClick={() => setRotating(null)}
                  className="border-border text-muted-foreground hover:bg-muted"
                >
                  Cancelar
                </Button>
                <Button
                  onClick={handleRotate}
                  disabled={rotateBusy}
                  className="bg-primary hover:bg-primary/90 text-primary-foreground"
                >
                  {rotateBusy ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Rotacionando...
                    </>
                  ) : (
                    'Rotacionar token'
                  )}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

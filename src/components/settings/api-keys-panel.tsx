'use client';

// ============================================================
// ApiKeysPanel — Settings → API / Integrações
//
// Gera e gerencia chaves de API (bearer) por conta, usadas por
// integrações externas (ex: agente de IA no n8n) pra chamar
// POST /api/external/whatsapp/send e devolver respostas pro CRM.
//
// Segurança / UX
//   - Só admin+ (Dono + Admins) enxerga e gerencia (espelha o gate
//     server-side requireRole('admin')). Não-admin vê um aviso.
//   - A chave crua aparece UMA vez, no dialog de criação. Depois só o
//     hash vive no banco — não há como reexibir (igual aos convites).
//   - Revogar é imediato: o endpoint externo só aceita chaves ativas.
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
  ShieldCheck,
  Trash2,
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

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_by_user_id: string | null;
}

const MAX_NAME_LEN = 100;

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function ApiKeysPanel() {
  const { canManageMembers } = useAuth();

  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  // Chave crua recém-criada — exibida UMA vez.
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);

  const endpointUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/external/whatsapp/send`
      : '/api/external/whatsapp/send';

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/account/api-keys', { cache: 'no-store' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Falha ao carregar chaves de API');
        return;
      }
      const data = (await res.json()) as { keys: ApiKey[] };
      setKeys(data.keys);
    } catch (err) {
      console.error('[ApiKeysPanel] load error:', err);
      toast.error('Não foi possível conectar ao servidor');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canManageMembers) void load();
    else setLoading(false);
  }, [canManageMembers, load]);

  async function handleCreate() {
    const name = newName.trim();
    if (!name) {
      toast.error('Dê um nome à chave (ex.: n8n produção)');
      return;
    }
    setCreating(true);
    try {
      const res = await fetch('/api/account/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Falha ao criar a chave');
        return;
      }
      const data = (await res.json()) as { key: string };
      setCreatedKey(data.key);
      setNewName('');
      void load();
    } catch (err) {
      console.error('[ApiKeysPanel] create error:', err);
      toast.error('Não foi possível conectar ao servidor');
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke() {
    if (!revoking) return;
    setRevokeBusy(true);
    try {
      const res = await fetch(`/api/account/api-keys/${revoking.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Falha ao revogar a chave');
        return;
      }
      toast.success('Chave revogada');
      setRevoking(null);
      void load();
    } catch (err) {
      console.error('[ApiKeysPanel] revoke error:', err);
      toast.error('Não foi possível conectar ao servidor');
    } finally {
      setRevokeBusy(false);
    }
  }

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copiado`);
    } catch {
      toast.error('Área de transferência bloqueada — copie manualmente');
    }
  }

  // Não-admin: sem acesso (espelha o requireRole('admin') do servidor).
  if (!canManageMembers) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead
          title="API / Integrações"
          description="Chaves de API para integrações externas."
        />
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-10 text-center">
            <Lock className="size-6 text-muted-foreground" />
            <p className="mt-2 text-sm text-muted-foreground">
              Apenas o dono e administradores da conta podem gerenciar chaves de API.
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
        title="API / Integrações"
        description="Chaves bearer para integrações externas (ex.: agente de IA no n8n) enviarem respostas pelo seu WhatsApp."
        action={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            Nova chave
          </Button>
        }
      />

      {/* Endpoint de envio — pra colar no HTTP Request do n8n. */}
      <Card>
        <CardContent className="space-y-2 py-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">Endpoint de envio</h3>
          </div>
          <p className="text-xs text-muted-foreground">
            No n8n, faça um <span className="font-medium">POST</span> para o endereço abaixo com o
            header <code className="rounded bg-muted px-1 py-0.5 font-mono">Authorization: Bearer &lt;sua-chave&gt;</code>{' '}
            e corpo <code className="rounded bg-muted px-1 py-0.5 font-mono">{'{ conversation_id, message_type: "text", content_text }'}</code>.
          </p>
          <div className="flex gap-2">
            <Input
              readOnly
              value={endpointUrl}
              className="bg-muted border-border text-foreground font-mono text-xs"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => copy(endpointUrl, 'Endpoint')}
              className="shrink-0 border-border text-muted-foreground hover:bg-muted"
            >
              <Copy className="size-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Lista de chaves */}
      {keys.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-10 text-center">
            <KeyRound className="size-6 text-muted-foreground" />
            <p className="mt-2 text-sm text-muted-foreground">Nenhuma chave criada ainda.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Clique em <span className="text-muted-foreground">Nova chave</span> para gerar uma.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y divide-border">
              {keys.map((k) => {
                const revoked = !!k.revoked_at;
                return (
                  <li key={k.id} className="flex items-center gap-4 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`truncate text-sm font-medium ${
                            revoked ? 'text-muted-foreground line-through' : 'text-foreground'
                          }`}
                        >
                          {k.name}
                        </span>
                        {revoked ? (
                          <Badge className="bg-muted text-muted-foreground border-border text-[10px] uppercase tracking-wide">
                            Revogada
                          </Badge>
                        ) : (
                          <Badge className="bg-primary-soft text-primary border-border text-[10px] uppercase tracking-wide">
                            Ativa
                          </Badge>
                        )}
                      </div>
                      <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                        {k.prefix}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Criada em {fmtDate(k.created_at)} ·{' '}
                        {k.last_used_at ? `usada por último em ${fmtDate(k.last_used_at)}` : 'nunca usada'}
                      </p>
                    </div>

                    {!revoked && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setRevoking(k)}
                        className="border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20 hover:border-red-500/60 hover:text-red-200"
                      >
                        <Trash2 className="size-4" />
                        Revogar
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Dialog: criar / revelar chave */}
      <Dialog
        open={createOpen}
        onOpenChange={(next) => {
          // Ao fechar, descarta o nome E a chave crua — não reexibir.
          if (!next) {
            setNewName('');
            setCreatedKey(null);
          }
          setCreateOpen(next);
        }}
      >
        <DialogContent className="bg-popover border-border sm:max-w-md">
          {createdKey ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-popover-foreground">
                  <KeyRound className="size-4 text-primary" />
                  Chave criada
                </DialogTitle>
                <DialogDescription className="text-muted-foreground">
                  Copie agora e cole no n8n. Por segurança, não guardamos o valor —
                  assim que fechar, ele desaparece.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-3 py-2">
                <Label className="text-muted-foreground">Sua chave de API</Label>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={createdKey}
                    className="bg-muted border-border text-foreground font-mono text-xs"
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <Button
                    type="button"
                    onClick={() => copy(createdKey, 'Chave')}
                    className="bg-primary hover:bg-primary/90 text-primary-foreground shrink-0"
                  >
                    <Copy className="size-4" />
                    Copiar
                  </Button>
                </div>
                <div className="rounded-md border border-amber-500/50 bg-amber-500/15 px-3 py-2 text-xs text-amber-200">
                  <strong className="font-semibold text-amber-100">Salve esta chave agora.</strong>{' '}
                  Nunca armazenamos o texto puro — para trocar, revogue esta e crie outra.
                </div>
              </div>

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
            <>
              <DialogHeader>
                <DialogTitle className="text-popover-foreground">Nova chave de API</DialogTitle>
                <DialogDescription className="text-muted-foreground">
                  Dê um nome pra reconhecer onde a chave é usada. Ela poderá apenas{' '}
                  <span className="font-medium">enviar mensagens</span> em conversas desta conta.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-2 py-2">
                <Label className="text-muted-foreground">Nome</Label>
                <Input
                  placeholder="ex.: n8n produção"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  maxLength={MAX_NAME_LEN}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !creating) void handleCreate();
                  }}
                />
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
                    'Gerar chave'
                  )}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Dialog: confirmar revogação */}
      <Dialog open={revoking !== null} onOpenChange={(o) => !o && setRevoking(null)}>
        <DialogContent className="bg-popover border-border sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-popover-foreground">
              <AlertTriangle className="size-4 text-amber-400" />
              Revogar chave
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Revogar{' '}
              <span className="font-medium text-muted-foreground">{revoking?.name}</span>? Qualquer
              integração usando esta chave para de funcionar imediatamente. Não dá pra desfazer.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setRevoking(null)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              Cancelar
            </Button>
            <Button
              onClick={handleRevoke}
              disabled={revokeBusy}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {revokeBusy ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Revogando...
                </>
              ) : (
                'Revogar chave'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

# Token estático no webhook do agente — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) ou superpowers:executing-plans. Steps usam checkbox (`- [ ]`).

**Goal:** Substituir a assinatura HMAC do webhook de saída por um token estático em header (`x-webhook-token`), validável nativamente pelo Header Auth do n8n, + botão de rotacionar o token + UX de config do n8n.

**Architecture:** Reusa o `webhook_endpoints.secret` existente como token estático. `dispatch.ts` manda o secret no header `x-webhook-token` em vez de HMAC; remove o `signature.ts` (dead code do outbound). Nova rota `POST /api/account/webhooks/[id]/rotate` regenera o secret. UI ganha botão Rotacionar + mostra header/token + instrução de Header Auth.

**Tech Stack:** Next.js App Router, Supabase (RLS), TypeScript, Vitest.

## Global Constraints

- Comentários de código em **português**. Nunca `git add -A` — paths explícitos.
- Lint baseline = 3 erros pré-existentes; não adicionar erro novo. `npx tsc --noEmit` limpo.
- Branch: `feat/webhook-agente-n8n` (dobrar no PR #23, já aberto; não criar branch nova).
- Header do token: **`x-webhook-token`** (exato).
- **Sem migration** — reusa a coluna `webhook_endpoints.secret`.
- ⚠️ NÃO tocar em `src/lib/whatsapp/webhook-signature.ts` (assinatura de ENTRADA da Meta — coisa diferente).
- Rotas `account/webhooks*` seguem o padrão: client de sessão (`ctx.supabase`, RLS) + `requireRole('admin')` + rate limit `adminAction` + filtro `.eq('account_id', ctx.accountId)`.

---

### Task 1: Transporte por token estático + remoção do HMAC do outbound

**Files:**
- Modify: `src/lib/webhooks/dispatch.ts`
- Modify: `src/lib/webhooks/dispatch.test.ts`
- Modify: `src/lib/webhooks/secret.ts` (só comentário-doc, Step 4d)
- Modify: `src/app/api/account/webhooks/route.ts` (só comentário-doc, Step 4e)
- Delete: `src/lib/webhooks/signature.ts`, `src/lib/webhooks/signature.test.ts`

**Interfaces:**
- Consumes: `webhook_endpoints.secret` (já existe).
- Produces: o webhook de saída passa a enviar header `x-webhook-token: <secret>` (não mais `x-webhook-signature`).

- [ ] **Step 1: Confirmar que `signature.ts` só é usado no outbound**

Run: `grep -rn "signWebhookPayload\|webhooks/signature" src --include="*.ts" --include="*.tsx"`
(⚠️ globs **entre aspas** — no zsh do usuário `--include=*.ts` sem aspas quebra com "no matches found".)
Expected: ocorrências SOMENTE em `src/lib/webhooks/dispatch.ts`, `src/lib/webhooks/dispatch.test.ts`, `src/lib/webhooks/signature.test.ts` e `src/lib/webhooks/signature.ts` (esta última é a **própria definição** — será deletada no Step 5; essa auto-ocorrência é ESPERADA, **não** dispara NEEDS_CONTEXT). Se aparecer em QUALQUER OUTRO arquivo, PARE e reporte (NEEDS_CONTEXT) — a remoção não é segura.

- [ ] **Step 2: Atualizar o teste (RED) — header `x-webhook-token` no lugar da assinatura**

Em `src/lib/webhooks/dispatch.test.ts`:

(a) Remover a linha 3 (`import { signWebhookPayload } from './signature'`).

(b) Substituir o teste `'1 endpoint ativo → fetch chamado 1x com assinatura e body corretos'` (linhas 57-71) por:

```ts
  it('1 endpoint ativo → fetch chamado 1x com token e body corretos', async () => {
    const secret = 'whsec_test123'
    const admin = makeAdmin([{ id: 'ep1', url: 'https://n8n.example.com/webhook/abc', secret }])

    await dispatchMessageReceived(admin, 'acc1', basePayload)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://n8n.example.com/webhook/abc')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify(basePayload))
    expect(init.headers['x-webhook-token']).toBe(secret)
    expect(init.headers['x-webhook-signature']).toBeUndefined()
  })
```

- [ ] **Step 3: Rodar o teste pra ver o RED**

Run: `npx tsc --noEmit` e depois `npx vitest run src/lib/webhooks/dispatch.test.ts`
Expected: com 2a (remover o import) e 2b (substituir o teste) aplicados **juntos**, o **typecheck fica limpo** (`signature.ts` ainda existe, nenhum símbolo órfão). O **RED é puramente do vitest**: o teste novo FALHA porque `init.headers['x-webhook-token']` é `undefined` (o dispatch ainda manda `x-webhook-signature`).

- [ ] **Step 4: Implementar — `dispatch.ts` manda o token estático**

Em `src/lib/webhooks/dispatch.ts`:

(a) Remover a linha 2 (`import { signWebhookPayload } from './signature'`).

(b) Trocar o JSDoc de `dispatchMessageReceived` (linha 38-39) por:

```ts
/** Entrega best-effort: busca endpoints ativos da conta e faz POST com token
 *  estático no header (x-webhook-token). NUNCA lança (não pode derrubar o
 *  inbound webhook). Nunca loga o secret. */
```

(c) Trocar o header da assinatura (linha 65) — de:

```ts
            'x-webhook-signature': signWebhookPayload(rawBody, ep.secret),
```
para:
```ts
            'x-webhook-token': ep.secret,
```

(d) Corrigir o comentário-doc obsoleto em `src/lib/webhooks/secret.ts` (linhas 5-7). Trocar:
```ts
// devolvido ao admin UMA vez na criação, e armazenado em texto
// simples em `webhook_endpoints.secret` (usado pra assinar os
// payloads com HMAC na entrega — não é um token de autenticação).
```
por:
```ts
// devolvido ao admin UMA vez na criação, e armazenado em texto
// simples em `webhook_endpoints.secret` (enviado como token estático no
// header `x-webhook-token` na entrega; validado pelo Header Auth do n8n).
```

(e) Corrigir o comentário-doc obsoleto em `src/app/api/account/webhooks/route.ts` (linhas 6-8). Trocar:
```ts
// O secret cru só existe na resposta do POST — depois disso, só o
// valor em `webhook_endpoints.secret` vive no banco (usado pra assinar
// payloads na entrega). Espelha o padrão de /api/account/api-keys.
```
por:
```ts
// O secret cru só existe na resposta do POST — depois disso, só o
// valor em `webhook_endpoints.secret` vive no banco (enviado como token
// estático no header `x-webhook-token` na entrega). Espelha o padrão de
// /api/account/api-keys.
```

- [ ] **Step 5: Remover o `signature.ts` (dead code do outbound)**

```bash
git rm src/lib/webhooks/signature.ts src/lib/webhooks/signature.test.ts
```

- [ ] **Step 6: GREEN — typecheck + suíte de webhooks**

Run: `npx tsc --noEmit && npx vitest run src/lib/webhooks/`
Expected: typecheck limpo; testes do dispatch passam (incluindo o novo de `x-webhook-token`); a suíte não referencia mais `signature.test.ts` (removido).

- [ ] **Step 7: Commit**

```bash
git add src/lib/webhooks/dispatch.ts src/lib/webhooks/dispatch.test.ts src/lib/webhooks/secret.ts src/app/api/account/webhooks/route.ts
git commit -m "feat(webhook): token estatico x-webhook-token no lugar do HMAC (remove signature.ts)"
```

> As remoções de `signature.ts`/`signature.test.ts` já foram staged pelo `git rm` do Step 5 — não precisam ser re-adicionadas. O `git add` acima cobre só os arquivos modificados.

---

### Task 2: Rota de rotacionar o token

**Files:**
- Create: `src/app/api/account/webhooks/[id]/rotate/route.ts`

**Interfaces:**
- Consumes: `generateWebhookSecret` (de `@/lib/webhooks/secret`); padrão de auth/rate-limit das rotas `account/webhooks`.
- Produces: `POST /api/account/webhooks/[id]/rotate` → `{ id, secret }` (secret novo, devolvido uma vez). Consumida pela Task 3.

- [ ] **Step 1: Criar a rota**

Conteúdo de `src/app/api/account/webhooks/[id]/rotate/route.ts`:

```ts
// ============================================================
// POST /api/account/webhooks/[id]/rotate — gera um novo secret pro endpoint
// (invalida o antigo). Devolve o secret UMA vez, como o POST de criação.
// Restrito a admin+ via requireRole('admin'); isolado por account_id + RLS.
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { generateWebhookSecret } from "@/lib/webhooks/secret";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("admin");

    const limit = await checkRateLimit(
      `adminAction:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    // Leitura assíncrona dos params — padrão Next 16.
    const { id } = await params;

    // Novo secret — devolvido UMA vez ao admin nesta resposta.
    const secret = generateWebhookSecret();

    // RLS + filtro por account_id garantem isolamento entre contas.
    const { data, error } = await ctx.supabase
      .from("webhook_endpoints")
      .update({ secret })
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .select("id")
      .maybeSingle();

    if (error) {
      console.error("[POST /api/account/webhooks/[id]/rotate] error:", error);
      return NextResponse.json(
        { error: "Falha ao rotacionar o token" },
        { status: 500 },
      );
    }

    // maybeSingle() retorna null quando nenhuma linha corresponde (não encontrado
    // ou pertence a outra conta).
    if (!data) {
      return NextResponse.json(
        { error: "Endpoint não encontrado" },
        { status: 404 },
      );
    }

    // `secret` devolvido UMA vez — o admin copia agora ou rotaciona de novo.
    return NextResponse.json({ id: data.id, secret });
  } catch (err) {
    return toErrorResponse(err);
  }
}
```

- [ ] **Step 2: Verificar typecheck**

Run: `npx tsc --noEmit`
Expected: sem erros.

> Justificativa de teste: as rotas `account/webhooks*` não têm teste unitário no repo (são thin, dependem de auth/RLS). A verificação é typecheck + a integração exercida pela UI (Task 3) + review final. Não inventar teste que só mocka o supabase client.

- [ ] **Step 3: Commit**

```bash
git add "src/app/api/account/webhooks/[id]/rotate/route.ts"
git commit -m "feat(webhook): rota POST /account/webhooks/[id]/rotate (regenera token)"
```

---

### Task 3: UI — botão Rotacionar + config do n8n

**Files:**
- Modify: `src/components/settings/webhooks-panel.tsx`

**Interfaces:**
- Consumes: `POST /api/account/webhooks/[id]/rotate` (Task 2).
- Produces: nada (UI).

**Contexto:** o painel hoje mostra o secret só na criação (dialog `createdSecret`, linhas 349-395) e tem botões Desativar/Excluir por endpoint (linhas 297-327). Vamos: (a) extrair a "caixa de revelação do secret" num componente reusável que também mostra o header e a instrução do n8n; (b) usá-la na criação e numa nova revelação pós-rotate; (c) adicionar botão Rotacionar + dialog de confirmação.

- [ ] **Step 1: Adicionar `KeyRound` aos imports do lucide-react**

Na lista de imports de `lucide-react` (linhas 20-30), adicionar `KeyRound,` (ícone do botão Rotacionar).

- [ ] **Step 2: Criar o componente reusável `SecretRevealBox` (topo do arquivo, antes de `WebhooksPanel`)**

Inserir logo após o `fmtDate` (linha 66), no escopo de módulo:

```tsx
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
```

- [ ] **Step 3: Estado do rotate no `WebhooksPanel`**

Após o estado de exclusão (linhas 84-85), adicionar:

```tsx
  // Estado do dialog de confirmação de rotação + revelação do novo token
  const [rotating, setRotating] = useState<WebhookEndpoint | null>(null);
  const [rotateBusy, setRotateBusy] = useState(false);
  const [rotatedSecret, setRotatedSecret] = useState<string | null>(null);
```

- [ ] **Step 4: Handler `handleRotate`**

Após `handleDelete` (depois da linha 201), adicionar:

```tsx
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
```

- [ ] **Step 5: Botão Rotacionar (entre Desativar e Excluir)**

No grupo de ações por endpoint, inserir ANTES do botão de exclusão (antes da linha 318 `{/* Botão de exclusão */}`):

```tsx
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

```

- [ ] **Step 6: Usar `SecretRevealBox` no dialog de criação**

No dialog de criação, substituir o bloco da revelação (o `<div className="space-y-3 py-2">…</div>` das linhas 363-385, que tem o Label/Input/Copiar/aviso) por:

```tsx
              <SecretRevealBox secret={createdSecret} />
```

E ajustar a `DialogDescription` da etapa de revelação (linhas 357-360) para:

```tsx
                <DialogDescription className="text-muted-foreground">
                  Copie o token agora e configure-o no n8n (Header Auth). Por segurança,
                  não guardamos o valor — assim que fechar, ele desaparece.
                </DialogDescription>
```

⚠️ Depois dessa troca, a função `copy` definida em `WebhooksPanel` (linhas 204-211) fica **sem uso** (seu único caller era o bloco de revelação que virou `SecretRevealBox`). **Remover** a função `copy` do `WebhooksPanel` (o `SecretRevealBox` tem o seu próprio). Confirme com `grep -n "copy(" src/components/settings/webhooks-panel.tsx` que não há outro caller no `WebhooksPanel` antes de remover.

- [ ] **Step 7: Dialog de rotação (confirmação → revelação)**

Após o dialog de exclusão (depois da linha 503 `</Dialog>` do delete, antes do `</section>`), adicionar:

```tsx
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
```

- [ ] **Step 8: Atualizar o comentário do cabeçalho do arquivo**

No bloco de comentário do topo (linhas 6-8), trocar a menção a HMAC:

```tsx
// cliente envia mensagem no WhatsApp, o CRM faz um POST para
// cada endpoint ativo com um token estático no header (x-webhook-token),
// validável pelo Header Auth do n8n.
```
E na seção "Segurança / UX" (linha 13-14), trocar "O secret aparece UMA vez… não há como reexibir." por:
```tsx
//   - O token aparece UMA vez (criação e após rotacionar); não há reexibição.
//     Perdeu? Use Rotacionar pra gerar outro.
```

- [ ] **Step 9: Verificar typecheck + suíte + lint**

Run: `npx tsc --noEmit && npx vitest run && npm run lint`
Expected: typecheck limpo; 737 testes verdes (sem regressão); lint sem erro novo (baseline 3) — `KeyRound`/`SecretRevealBox` usados (sem unused-var).

- [ ] **Step 10: Commit**

```bash
git add src/components/settings/webhooks-panel.tsx
git commit -m "feat(webhook): UI rotacionar token + instrucao Header Auth do n8n"
```

---

## Self-Review

**1. Spec coverage:**
- Transporte token estático + remove HMAC → Task 1. ✅
- Remove `signature.ts` (dead code outbound), preserva inbound Meta → Task 1 (grep guard) + constraint. ✅
- Rota rotate → Task 2. ✅
- UI: botão Rotacionar + reveal + header/token + nota Header Auth + textos → Task 3. ✅
- Sem migration → nenhuma task de migration. ✅

**2. Placeholder scan:** sem TBD; todo step de código traz o código completo. ✅

**3. Type consistency:** a rota rotate devolve `{ id, secret }`; a UI lê `data.secret`. `SecretRevealBox({ secret: string })` recebe `createdSecret`/`rotatedSecret` (ambos `string` quando não-null, garantido pelo `?` guard). `WebhookEndpoint` inalterado. Header `x-webhook-token` idêntico no dispatch, no teste e na UI. ✅

## Notas de risco
- A remoção de `signature.ts` depende do grep do Step 1 (Task 1) não achar outros consumidores. Se achar, vira NEEDS_CONTEXT.
- Endpoints existentes já têm `secret` — viram token estático automaticamente (sem migração). Quem já validava HMAC no n8n (se alguém) precisa trocar pra Header Auth — aceitável (ninguém valida ainda; runbook do #23).
- `SecretRevealBox` define seu próprio `copy` (auto-contido no escopo de módulo); o `copy` do `WebhooksPanel` fica órfão após o Step 6 e é removido lá (com grep de confirmação).
- **Segurança (token em repouso):** diferente do HMAC (que nunca transmite o secret — só uma derivação por payload), o `x-webhook-token` viaja igual em todo request e é **persistido em texto puro** por quem loga headers — em especial o **log de execução do n8n** (o nó Webhook guarda os headers recebidos, visíveis em Executions) e proxies (Easypanel/reverse-proxy). HTTPS protege só o trânsito, não o repouso. Mitigação: retenção curta de execuções no n8n + o botão **Rotacionar** como contramedida se o token vazar. Aceitável pro modelo (n8n próprio), mas é o trade-off real de trocar HMAC por token estático.

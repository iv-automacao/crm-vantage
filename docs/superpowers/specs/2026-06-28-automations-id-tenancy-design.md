# `automations/[id]` — corrigir o modelo de tenancy — Design

**Data:** 2026-06-28
**Contexto:** Item **#4 (P1)** da auditoria `docs/auditoria/2026-06-28-conflitos-webhooks-apis.md`. Segundo item do backlog aberto (depois do #2/CAPI).
**Relacionados:** [[crm-vantage-rbac]], auditoria-mãe.

## Problema

As rotas `src/app/api/automations/[id]/route.ts` (GET/PATCH/DELETE) e `.../[id]/duplicate/route.ts` (POST) usam **`supabaseAdmin()`** (service-role, que **ignora a RLS**) + um filtro manual **`.eq('user_id', user.id)`**. Isso, apesar de a RLS já estar correta e de o próprio `requireRole`/`requireActiveAccount` **já devolver o client de sessão RLS-scoped** (`ctx.supabase`) — que essas rotas descartam.

**RLS atual (017 + 032), já correta:**
- `automations_select` → `is_account_member(account_id)` — **qualquer membro** lê.
- `automations_insert/update/delete` → `is_account_member(account_id, 'admin')` — **admin+** escreve.

**Três furos (auditoria #4):**
1. **Tenancy presa a 1 linha** de filtro num client que ignora RLS — frágil.
2. **Escopo errado: por criador, não por conta.** Admin/owner **não** consegue editar/deletar/duplicar automação criada por um colega (gestão de time quebrada), mesmo a RLS permitindo.
3. **Method drift:** GET usa só `getUser()` cru + filtro `user_id` (não passa pelo modelo de conta); PATCH/DELETE exigem admin.

## Decisões (do brainstorming)

1. **Trocar service-role + `user_id` por `ctx.supabase` (RLS).** A RLS já faz o escopo por conta + o papel; o código só precisa parar de contorná-la. É o "padrão sistêmico" que a auditoria pregou: client de sessão se protege sozinho.
2. **GET = qualquer membro ativo** (`requireActiveAccount()`) — consistente com a LISTA de automações (que já mostra todas da conta a qualquer membro via RLS). Editar/deletar/duplicar segue **admin+**.
3. **Sem migration** — a RLS necessária já existe (017/032). É puro alinhamento de código.
4. **Helpers de steps (`loadStepsTree`/`replaceSteps`/`insertSteps`) ficam como estão** (service-role internos) — só rodam **depois** de a RLS confirmar que a automação pertence à conta do caller. Refatorá-los está fora de escopo.
5. **`automations/[id]/duplicate` passa 100% por `ctx.supabase`** (origem, cópia e cópia dos steps) — `automation_steps_modify` exige `agent`, e admin passa. Remove `supabaseAdmin` da rota.
6. **`automations/route.ts` (lista) fica fora** — o GET-lista já usa client de sessão (RLS), está account-scoped corretamente. Seu único pendente é o muro de conta-ativa, que é o **#7** (outro item).

## Arquitetura

### `src/app/api/automations/[id]/route.ts`

Remove o helper `requireUser()` e o import de `supabaseAdmin`.

**GET** — `requireActiveAccount()`; lê a automação via `ctx.supabase` (RLS = membro da conta); 404 se a RLS não devolver. Carrega steps via `loadStepsTree(id)` (inalterado), só após a verificação.
```ts
export async function GET(_req, { params }) {
  try {
    const { supabase } = await requireActiveAccount()
    const { id } = await params
    const { data: automation, error } = await supabase
      .from('automations').select('*').eq('id', id).maybeSingle()
    if (error) return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    if (!automation) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const steps = await loadStepsTree(id)
    return NextResponse.json({ automation, steps })
  } catch (err) { return toErrorResponse(err) }
}
```

**PATCH** — `requireRole('admin')` (entrega `ctx.supabase`). Verifica `existing` via `ctx.supabase` (404 se a RLS esconder — não-admin ou outra conta). Mantém a lógica de validação-na-ativação. `update` via `ctx.supabase`. `replaceSteps` inalterado. **Sem** `requireUser()`, **sem** `.eq('user_id', ...)`.

**DELETE** — `requireRole('admin')`; `ctx.supabase.from('automations').delete().eq('id', id).select('id')`; se voltar vazio → **404** (a RLS impediu / não existe). **Sem** filtro `user_id`.

### `src/app/api/automations/[id]/duplicate/route.ts`

`requireRole('admin')` (entrega `ctx.supabase` + `accountId`). Origem via `ctx.supabase` (404 se RLS esconder). Cópia: `insert({ account_id: ctx.accountId, user_id: ctx.userId, ... })` via `ctx.supabase`. Cópia dos steps (mesmo remap de `parent_step_id` com idMap) via `ctx.supabase`. Remove import de `supabaseAdmin`.

### Sem mudança

`automations/route.ts` (lista/criar), os helpers de steps, a RLS, e o cron. Nenhuma migration.

## Componentes e responsabilidades

| Arquivo | Mudança |
|---|---|
| `src/app/api/automations/[id]/route.ts` | GET/PATCH/DELETE via `ctx.supabase`; GET ganha `requireActiveAccount()`; remove `requireUser`/`supabaseAdmin`/filtros `user_id`; DELETE 404 quando 0 linhas |
| `src/app/api/automations/[id]/duplicate/route.ts` | tudo via `ctx.supabase`; remove `supabaseAdmin` |
| `src/app/api/automations/[id]/route.test.ts` | **novo** — GET/PATCH/DELETE |
| `src/app/api/automations/[id]/duplicate/route.test.ts` | **novo** — POST duplicate |

## Verificação

- **Unit (vitest):** mock de `@/lib/auth/account` (`requireActiveAccount`/`requireRole` devolvem ctx com `supabase` fake RLS-aware), mock de `@/lib/automations/steps-tree` (loadStepsTree/replaceSteps) e de `@/lib/automations/validate`. **Guard forte:** mockar `@/lib/automations/admin-client` `supabaseAdmin` pra **lançar se chamado** — qualquer uso acidental de service-role quebra o teste.
  - GET: 200 com `{automation, steps}` quando o fake devolve a linha; **404** quando devolve null; `requireActiveAccount` foi chamado; `supabaseAdmin` **não** foi chamado; nenhum `.eq('user_id', …)` aplicado.
  - PATCH: 404 quando `existing` é null (RLS esconde); 200 + update aplicado via `ctx.supabase` quando admin; gate admin (requireRole) presente.
  - DELETE: 404 quando o `delete().select('id')` volta vazio; 200 quando volta a linha; sem filtro `user_id`.
  - duplicate: 404 quando a origem é null; 201 com a cópia quando admin; `supabaseAdmin` não chamado.
- **Guardrail:** `route-auth-guard.test.ts` segue verde (GET usa `requireActiveAccount` = AUTH_MARKER; mutações usam `requireRole` = STRONG_ROLE_MARKER).
- **Typecheck/lint:** `npx tsc --noEmit`, `npm run lint` (sem novos problemas), suíte completa verde.
- **Manual:** com 2 usuários admin na mesma conta, A cria automação, B abre/edita/deleta/duplica → funciona (antes: 404). Viewer/agent vê o detalhe (GET) mas recebe 403 ao editar.

## Fora de escopo (YAGNI)

- Muro de conta-ativa no GET-**lista** e nos GETs de flows/templates (#7).
- Refatorar os helpers de steps pra client de sessão (funcionam pós-verificação).
- Mexer na RLS / qualquer migration.
- Rate-limit nas mutações de automations (#11).

## Restrições

- Comentários em **português**. Nunca `git add -A`. PRs → `iv-automacao/crm-vantage`. `tsc` limpo; lint sem novos problemas (baseline 3 errors / ~25 problems pré-existentes).
- **Nenhuma migration** — não tocar em banco.
- Ordem **verificar-antes-de-steps** preservada (loadStepsTree/replaceSteps só após a RLS confirmar a automação).

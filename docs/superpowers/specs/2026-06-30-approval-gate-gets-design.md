# Gate de aprovação nos GETs de flows/automations — Design

**Data:** 2026-06-30
**Contexto:** Item **#7 (P2)** da auditoria `docs/auditoria/2026-06-28-conflitos-webhooks-apis.md`. Sinérgico com o #4 (mesmo padrão de gate).
**Relacionados:** [[crm-vantage-account-approval-gate]], [[crm-vantage-rbac]], auditoria-mãe.

## Problema

O muro de aprovação de conta (conta nasce `pending`; super admin aprova; pode virar `suspended`) só existe onde as rotas usam `requireActiveAccount()`/`requireRole()`. **Cinco handlers GET** usam `supabase.auth.getUser()` cru — que só confirma login, **não** o status da conta — então uma conta `pending`/`suspended` consegue **ler** dados por eles:

| Handler GET | Gate atual | Lê |
|---|---|---|
| `automations/route.ts` (lista) | `auth.getUser()` cru | `automations` (RLS) |
| `flows/route.ts` (lista) | helper `requireUser()` (getUser cru) | `flows` (RLS) |
| `flows/[id]/route.ts` | helper `requireOwnership()` (getUser cru) | `flows`+`flow_nodes` (RLS) |
| `flows/[id]/runs/route.ts` | `auth.getUser()` cru | `flow_runs`+eventos (RLS) |
| `flows/templates/route.ts` | `auth.getUser()` cru | galeria estática (sem DB) |

Severidade P2: o escopo por conta (RLS) continua valendo (só veria dados da própria conta) e **escrever já é bloqueado** (mutações usam `requireRole('admin')`). É fechar a fresta de **ler antes de aprovado**.

## Decisões (do brainstorming)

1. **Trocar `getUser()` cru por `requireActiveAccount()`** nos 5 GETs. Conta `pending`/`suspended` → **403** (`AccountPendingError`, já existe). Reusa o `ctx.supabase` que o helper devolve — é o **mesmo client de sessão SSR**, então **zero mudança no escopo RLS**, só adiciona o muro na frente.
2. **Sem mudança de papel:** `requireActiveAccount` não exige papel mínimo → viewer/agent **ativos** seguem lendo (sem regressão). Só pending/suspended bloqueia.
3. **Mutações intocadas** (POST/PUT/DELETE já usam `requireRole('admin')`, que por sua vez chama `requireActiveAccount`).
4. **Incluir a lista de `flows`** (o audit citou os sub-recursos, mas a lista tem o mesmo furo — consistência).
5. **Padrão:** `try { const ctx = await requireActiveAccount(); ... } catch (err) { return toErrorResponse(err) }`, usando `ctx.supabase`. Drop do `createClient` local quando o GET era o único uso.
6. **Sem migration.**

## Fora de escopo (YAGNI)

- `whatsapp/config` GET e `whatsapp/config/verify-registration` também usam `getUser()` cru, mas **não foram citados no #7** — follow-up (mesma correção de 1 linha quando se quiser).
- `invitations/[token]/redeem` usa `getUser()` por design (convidado sem conta ativa ainda) — **não** tocar.
- Mudar escopo RLS de flows (user vs account) — fora; o gate não altera isso.

## Arquitetura

Cada GET afetado: substituir o gate fraco pelo `requireActiveAccount()` e usar `ctx.supabase`.

- **`automations/route.ts` GET:** `requireActiveAccount()` → `ctx.supabase.from('automations').select('*').order('created_at',{ascending:false})`. Remove o `createClient` local (e o import, se virar órfão). POST intocado.
- **`flows/route.ts` GET:** idem com `flows`. O helper `requireUser()` permanece (usado pelo POST).
- **`flows/[id]/route.ts` GET:** `requireActiveAccount()` → `Promise.all([flows.eq(id).maybeSingle(), flow_nodes.eq(flow_id).order()])`; 404 se flow null (RLS). O helper `requireOwnership()` permanece (PUT/DELETE).
- **`flows/[id]/runs/route.ts` GET:** `requireActiveAccount()` → mantém a lógica (flow existence 404 → runs → events). Drop `createClient`.
- **`flows/templates/route.ts` GET:** `requireActiveAccount()` (ignora `ctx.supabase` — galeria estática). Drop `createClient`.

## Componentes e responsabilidades

| Arquivo | Mudança |
|---|---|
| `src/app/api/automations/route.ts` | GET via `requireActiveAccount` + `ctx.supabase` |
| `src/app/api/flows/route.ts` | GET via `requireActiveAccount` + `ctx.supabase` |
| `src/app/api/flows/[id]/route.ts` | GET via `requireActiveAccount` + `ctx.supabase` |
| `src/app/api/flows/[id]/runs/route.ts` | GET via `requireActiveAccount` + `ctx.supabase` |
| `src/app/api/flows/templates/route.ts` | GET via `requireActiveAccount` |
| `*/route.test.ts` (5, novos) | pending → 403; conta ativa → 200 (+ dados) |

## Verificação

- **Unit (vitest):** por rota, mockar `@/lib/auth/account` (`requireActiveAccount` rejeita `AccountPendingError(403)` no caso pending; resolve ctx com `supabase` fake no caso ativo) + `toErrorResponse` (mapeia `err.status`). Asserts: pending → **403**; ativo → **200** com o shape esperado (`{automations}`/`{flows}`/`{flow,nodes}`/`{flow,runs,events}`/`{templates}`).
- **Guardrail:** `route-auth-guard.test.ts` segue verde (todos passam a ter `requireActiveAccount` = AUTH_MARKER).
- **Typecheck/lint:** `npx tsc --noEmit`, `npm run lint` (sem novos problemas), suíte completa verde.
- **Manual:** com uma conta `pending`, abrir flows/automações → 403 (frontend redireciona pro muro `/pending`); conta ativa (qualquer papel) → lê normal.

## Restrições

- Comentários em **português**. Nunca `git add -A`. PRs → `iv-automacao/crm-vantage`. `tsc` limpo; lint sem novos problemas (baseline 3 errors / ~25 problems).
- **Nenhuma migration.** Mesmo client de sessão (RLS), só o gate na frente — sem mudança de escopo de dados.
- Mutações e helpers `requireUser`/`requireOwnership` (usados por elas) **não** mudam.

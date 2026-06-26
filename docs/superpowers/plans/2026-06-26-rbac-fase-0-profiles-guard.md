# RBAC Fase 0 — Guard de escalonamento em `profiles` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Impedir que um membro qualquer (viewer/agent) se auto-promova a `owner` editando `account_role` direto pela RLS de `profiles`.

**Architecture:** Trigger `BEFORE UPDATE` em `public.profiles` que rejeita qualquer mudança de `account_role` ou `account_id` quando o `current_user` é um papel de client (`authenticated`/`anon`). Todos os caminhos legítimos de mudança de papel são funções `SECURITY DEFINER OWNER TO postgres` (rodam com `current_user = postgres`), então passam intactas; só o `UPDATE` direto vindo do PostgREST sob a sessão do usuário é barrado.

**Tech Stack:** PostgreSQL (Supabase), migrations SQL versionadas em `supabase/migrations/`.

## Global Constraints

- Comentários de código/SQL em **português** (regra do projeto).
- **Nunca aplicar migration em banco de produção de cliente.** Alvo = projeto Supabase **dedicado do CRM**.
- **MCP do Supabase sem permissão de escrita neste projeto** — migrations são aplicadas **manualmente pelo Iago no SQL Editor** (ver `docs/superpowers/specs/2026-06-23-account-approval-gate-design.md:183`). Não existe stack Supabase local nem harness de teste SQL; a verificação é SQL rodada manualmente no SQL Editor.
- Migration **idempotente**: `CREATE OR REPLACE FUNCTION` + `DROP TRIGGER IF EXISTS` antes de `CREATE TRIGGER`.
- Próximo número de migration livre = **031** (a última é `030_lead_autoassign.sql`).
- Os 5 writers legítimos de `account_role`/`account_id` que NÃO podem ser quebrados (todos `SECURITY DEFINER OWNER TO postgres`):
  - `handle_new_user` (`017:609`) — INSERT no signup (não afetado por trigger de UPDATE)
  - `set_member_role` (`018:37`) — UPDATE `account_role`
  - `remove_account_member` (`018:127`) — reatribui `account_id` + `account_role`
  - `transfer_account_ownership` (`018:217`) — UPDATE `account_role`
  - `redeem_invitation` (`019:125`) — UPDATE `account_id` + `account_role` (`019:216-219`)

---

### Task 1: Migration `031` — guard de mudança de papel em `profiles`

**Files:**
- Create: `supabase/migrations/031_profiles_role_guard.sql`

**Interfaces:**
- Consumes: tabela `public.profiles` com colunas `account_role account_role_enum` e `account_id UUID` (criadas em `017_account_sharing.sql:122,176`).
- Produces: função `public.guard_profile_role_change()` (trigger fn, RETURNS TRIGGER) + trigger `trg_guard_profile_role_change BEFORE UPDATE ON public.profiles`. Nenhuma outra task depende destes símbolos.

- [ ] **Step 1: Demonstrar o furo (RED) — rodar no SQL Editor ANTES da migration**

Rodar este bloco no SQL Editor do projeto **dedicado** do CRM. Ele simula a sessão de um usuário autenticado tentando se auto-promover:

```sql
BEGIN;
-- finge ser o usuário dono da 1ª linha de profiles
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', (SELECT user_id FROM public.profiles ORDER BY user_id LIMIT 1),
    'role', 'authenticated'
  )::text,
  true
);
SET LOCAL ROLE authenticated;

UPDATE public.profiles
SET account_role = 'owner'
WHERE user_id = (current_setting('request.jwt.claims', true)::json ->> 'sub')::uuid;
ROLLBACK;
```

Esperado **ANTES** da migration: `UPDATE 1` (o furo existe — o membro conseguiu se promover). Isto é o teste vermelho.

- [ ] **Step 2: Escrever a migration**

Criar `supabase/migrations/031_profiles_role_guard.sql`:

```sql
-- ============================================================
-- 031 — Guard de escalonamento de privilégio em profiles
--
-- Contexto: a policy profiles_update (017:564-566) é self-scoped
-- (auth.uid() = user_id) SEM restrição de coluna. Como account_role
-- mora em profiles, qualquer membro (viewer/agent) conseguia rodar
--   update profiles set account_role='owner' where user_id = <eu>
-- pelo PostgREST e virar owner da própria conta, driblando a rota
-- admin-only de membros e os RPCs SECURITY DEFINER.
--
-- Fix: trigger BEFORE UPDATE que rejeita mudança de account_role OU
-- account_id quando o current_user é um papel de client
-- (authenticated/anon). Os caminhos legítimos — set_member_role,
-- remove_account_member, transfer_account_ownership, redeem_invitation,
-- handle_new_user — são SECURITY DEFINER OWNER TO postgres, então
-- rodam com current_user = postgres e passam intactos. Writes via
-- service_role (backend admin client) também passam.
-- ============================================================

CREATE OR REPLACE FUNCTION public.guard_profile_role_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER          -- precisa enxergar o current_user REAL de quem faz o UPDATE
SET search_path = public
AS $$
BEGIN
  IF (NEW.account_role IS DISTINCT FROM OLD.account_role
      OR NEW.account_id IS DISTINCT FROM OLD.account_id)
     AND current_user IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION
      'account_role/account_id só podem ser alterados via RPC autorizado (set_member_role, transfer_account_ownership, redeem_invitation)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.guard_profile_role_change() OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_guard_profile_role_change ON public.profiles;
CREATE TRIGGER trg_guard_profile_role_change
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_profile_role_change();
```

- [ ] **Step 3: Aplicar a migration manualmente (Iago, SQL Editor)**

Colar o conteúdo de `031_profiles_role_guard.sql` no SQL Editor do projeto **dedicado** do CRM e executar. Esperado: `Success. No rows returned`.

- [ ] **Step 4: Verificar o bloqueio + os caminhos legítimos (GREEN) — rodar no SQL Editor**

**(a) Auto-promoção pelo client agora é barrada** — repetir o bloco do Step 1:

```sql
BEGIN;
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', (SELECT user_id FROM public.profiles ORDER BY user_id LIMIT 1),
    'role', 'authenticated'
  )::text,
  true
);
SET LOCAL ROLE authenticated;
UPDATE public.profiles
SET account_role = 'owner'
WHERE user_id = (current_setting('request.jwt.claims', true)::json ->> 'sub')::uuid;
ROLLBACK;
```

Esperado **DEPOIS**: `ERROR: account_role/account_id só podem ser alterados via RPC autorizado ...` (SQLSTATE `42501`). Teste verde.

**(b) Editar campo próprio não-sensível continua funcionando** sob `authenticated`:

```sql
BEGIN;
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', (SELECT user_id FROM public.profiles ORDER BY user_id LIMIT 1),
    'role', 'authenticated'
  )::text,
  true
);
SET LOCAL ROLE authenticated;
UPDATE public.profiles
SET full_name = full_name           -- não toca account_role/account_id
WHERE user_id = (current_setting('request.jwt.claims', true)::json ->> 'sub')::uuid;
ROLLBACK;
```

Esperado: `UPDATE 1` (guard permite — colunas sensíveis intactas).

**(c) Caminho definer/servidor continua podendo mudar papel** — rodar como `postgres` (papel padrão do SQL Editor, sem `SET ROLE`):

```sql
BEGIN;
UPDATE public.profiles
SET account_role = account_role     -- no-op de valor, mas exercita a coluna sensível como postgres
WHERE user_id = (SELECT user_id FROM public.profiles ORDER BY user_id LIMIT 1);
ROLLBACK;
```

Esperado: `UPDATE 1` (current_user = postgres → guard permite; prova que os RPCs SECURITY DEFINER não quebram).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/031_profiles_role_guard.sql
git commit -m "$(cat <<'EOF'
fix(rbac): guard contra auto-promoção a owner via update direto em profiles

Trigger BEFORE UPDATE rejeita mudança de account_role/account_id quando
current_user é papel de client (authenticated/anon). RPCs SECURITY DEFINER
(set_member_role, transfer_account_ownership, redeem_invitation,
remove_account_member) rodam como postgres e passam intactos.

Fecha o escalonamento de privilégio achado na auditoria de RBAC
(profiles_update self-scoped sem column-guard, 017:564-566).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage:** A Fase 0 do spec (`docs/superpowers/specs/2026-06-26-rbac-crm-design.md`) pede exatamente "política/trigger column-scoped em `profiles` rejeitando UPDATE de `account_role`/`account_id` fora dos RPCs" + teste de que membro não se auto-promove, edição de nome/avatar continua, RPCs seguem funcionando. Coberto pela Task 1, Steps 2 e 4(a/b/c). ✅

**2. Placeholder scan:** Sem TBD/TODO. Todo SQL está completo e executável. ✅

**3. Type consistency:** `account_role_enum`, `account_id UUID`, `current_user`, `guard_profile_role_change()`, `trg_guard_profile_role_change` consistentes entre a migration e os passos de verificação. O trigger é `SECURITY INVOKER` (não DEFINER) de propósito — precisa do `current_user` real. ✅

**Nota de risco:** se o projeto usar nomes de papel Supabase fora do padrão (`authenticated`/`anon`), ajustar a lista no `IN (...)`. Os nomes são convenção estável do Supabase; nenhum sinal de customização no repo.

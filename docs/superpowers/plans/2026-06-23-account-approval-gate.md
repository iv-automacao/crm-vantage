# Account Approval Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Toda conta nova nasce bloqueada (`pending`) e só acessa o CRM depois que um admin de plataforma (Iago) aprova num painel `/admin`; o bloqueio vive na RLS do Supabase, não só na UI.

**Architecture:** Adiciona `status`/`account_type` em `accounts` (default `pending`), grandfather das contas existentes, e enraíza o gate na RLS redefinindo `is_account_member()` para exigir `status='active'` — fechando todas as tabelas de dados de uma vez. Leitura da própria `accounts`/`profiles` continua liberada (via helper status-agnóstico) pra renderizar o muro `/pending`. Por cima: gate no backend (`requireRole` lança 403) e no frontend (layout redireciona). Super admin é uma allowlist por env var; aprovação dispara aviso por e-mail via webhook n8n.

**Tech Stack:** Next.js 16 (App Router, `after()` de `next/server`), Supabase (Postgres + RLS, SSR client), TypeScript, Vitest.

## Global Constraints

- **Banco alvo:** Supabase dedicado do CRM `mgmokvpjswtjxhqhnyps`. NUNCA aplicar em banco de cliente (guard-rail VANTAGE). MCP do Supabase não tem permissão neste projeto — a migration é aplicada **manualmente pelo Iago no SQL Editor**.
- **Migrations idempotentes:** padrão das 017–024 (`IF NOT EXISTS`, `DROP POLICY IF EXISTS`, `CREATE OR REPLACE`). Seguro rodar 2x.
- **Comentários de código em português** (regra VANTAGE).
- **Segredos novos NÃO vão pro Preview da Vercel** junto com prod (mesma decisão de `crm-vantage-n8n-agent-loop`). Apenas no ambiente Production.
- **Valores de `account_type`:** exatamente `'ia_client' | 'self_serve' | 'internal'`.
- **Valores de `account_status_enum`:** exatamente `'pending' | 'active' | 'suspended' | 'rejected'`.
- **Prefixo de env do super admin:** `PLATFORM_ADMIN_EMAILS` (CSV). Webhook de aviso: `APPROVAL_NOTIFY_WEBHOOK_URL`.
- **Test runner:** `npx vitest run <arquivo>` (config já existe; ver `src/lib/auth/api-keys.test.ts`).
- **Toda escrita admin em `accounts` usa service role** (`supabaseAdmin()`), porque o platform admin NÃO é membro da conta-alvo e a policy `accounts_update` exige membership admin.

---

## File Structure

**Novos:**
- `supabase/migrations/025_account_approval.sql` — schema + grandfather + RLS gate.
- `src/lib/auth/platform-admin.ts` — allowlist por env + `requirePlatformAdmin()`.
- `src/lib/auth/platform-admin.test.ts` — testes da allowlist.
- `src/lib/notify/approval.ts` — `notifyAccountApproved()` (webhook n8n best-effort).
- `src/app/pending/page.tsx` — muro "conta em análise".
- `src/app/admin/page.tsx` — painel de contas (server component).
- `src/app/admin/admin-accounts-table.tsx` — tabela client com ações aprovar/reprovar.
- `src/app/api/admin/accounts/route.ts` — GET lista por status.
- `src/app/api/admin/accounts/[accountId]/approve/route.ts` — POST aprovar.
- `src/app/api/admin/accounts/[accountId]/reject/route.ts` — POST reprovar.

**Modificados:**
- `src/lib/auth/account.ts` — `status`/`accountType` no contexto, `AccountPendingError`, gate em `requireRole`.
- `src/hooks/use-auth.tsx` — expõe `account.status` / `account.account_type`.
- `src/app/(dashboard)/layout.tsx` — vira async, redireciona pending → `/pending`.
- `src/middleware.ts` — adiciona `/pending` e `/admin` aos protected paths.
- `.env.example` (se existir) / envs da Vercel — documenta os 2 envs novos.

---

## Task 1: Migration 025 — schema, grandfather e gate de RLS

**Files:**
- Create: `supabase/migrations/025_account_approval.sql`

**Interfaces:**
- Produces (SQL): coluna `accounts.status account_status_enum`, `accounts.account_type TEXT`, `accounts.approved_at`, `accounts.approved_by_user_id`, `accounts.status_reason`; função `is_account_member()` redefinida (membership + `status='active'`); função nova `is_account_member_any_status(UUID) RETURNS BOOLEAN`; policy `accounts_select` trocada pra status-agnóstica.

- [ ] **Step 1: Escrever a migration completa**

Create `supabase/migrations/025_account_approval.sql`:

```sql
-- ============================================================
-- 025_account_approval.sql — Gate de aprovação de contas
--
-- Toda conta nova nasce 'pending' e não acessa nada do CRM até um
-- admin de plataforma aprovar. O bloqueio vive na RLS: redefinimos
-- is_account_member() pra exigir accounts.status='active', o que
-- fecha TODAS as tabelas de dados de uma vez (elas já usam o helper).
--
-- Exceção cirúrgica: a leitura da PRÓPRIA accounts continua liberada
-- (helper status-agnóstico) — senão a conta pending nem conseguiria
-- ler o próprio status pra renderizar a tela "/pending".
--
-- Idempotente — seguro rodar múltiplas vezes.
-- Banco alvo: Supabase dedicado do CRM (mgmokvpjswtjxhqhnyps).
-- ============================================================

-- 1) Enum de status da conta.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'account_status_enum') THEN
    CREATE TYPE account_status_enum AS ENUM ('pending', 'active', 'suspended', 'rejected');
  END IF;
END$$;

-- 2) Colunas novas em accounts.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS status account_status_enum NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS account_type TEXT
    CHECK (account_type IS NULL OR account_type IN ('ia_client', 'self_serve', 'internal')),
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS status_reason TEXT;

-- 3) GRANDFATHER — tudo que já existe vira 'active'/'internal' ANTES
--    de qualquer enforcement, senão o Iago e as contas atuais ficam
--    trancados pra fora. Só toca quem ainda está no default.
UPDATE accounts
   SET status = 'active',
       account_type = COALESCE(account_type, 'internal'),
       approved_at = COALESCE(approved_at, NOW())
 WHERE status = 'pending';

-- 4) Índice quente: listar pendentes no painel /admin.
CREATE INDEX IF NOT EXISTS idx_accounts_status_pending
  ON accounts(status)
  WHERE status = 'pending';

-- 5) Helper status-agnóstico — membership SEM checar status.
--    Usado só onde a leitura precisa funcionar enquanto pending
--    (a própria accounts). SECURITY DEFINER pra evitar RLS recursiva.
CREATE OR REPLACE FUNCTION is_account_member_any_status(
  target_account_id UUID
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
  );
$$;
ALTER FUNCTION is_account_member_any_status(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION is_account_member_any_status(UUID) TO authenticated, service_role;

-- 6) Redefine is_account_member pra exigir status='active'.
--    Como TODAS as policies de dados já chamam este helper, o gate
--    entra em vigor em todas elas de uma vez. SECURITY DEFINER lê
--    accounts/profiles sem RLS (sem recursão).
CREATE OR REPLACE FUNCTION is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    JOIN accounts a ON a.id = p.account_id
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
      AND a.status = 'active'
      AND CASE p.account_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
        >=
          CASE min_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
  );
$$;
ALTER FUNCTION is_account_member(UUID, account_role_enum) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION is_account_member(UUID, account_role_enum) TO authenticated, service_role;

-- 7) accounts_select volta a ser status-agnóstica — o membro lê a
--    própria conta mesmo pending (pra renderizar o muro). As demais
--    policies de accounts (update) seguem gated por is_account_member
--    (active), porque conta pending não deve editar nada.
DROP POLICY IF EXISTS accounts_select ON accounts;
CREATE POLICY accounts_select ON accounts FOR SELECT
  USING (is_account_member_any_status(id));
```

- [ ] **Step 2: Auditar policies que dependem do helper (grep manual)**

Run:
```bash
grep -rn "is_account_member(" supabase/migrations/ | grep -v "any_status"
```
Expected: confirmar que, fora de `accounts_select` (agora trocada), nada que precise rodar **enquanto pending** depende do helper. Casos a verificar à mão:
- `profiles_select` (017:562) → usa `auth.uid() = user_id OR is_account_member(account_id)`. O 1º disjunto cobre a leitura do próprio profile mesmo pending. ✅ não muda.
- `account_invitations_*`, `api_keys_*` → conta pending NÃO deve gerenciar convites/chaves; ok ficarem gated. ✅
- RPCs `peek_invitation`/`redeem_invitation` (019) → fluxo de convite; conta pending não convida. Aceitável. ✅

Documentar o resultado num comentário no PR.

- [ ] **Step 3: Aplicar no Supabase dedicado (Iago, SQL Editor)**

Colar o conteúdo de `025_account_approval.sql` no SQL Editor do projeto `mgmokvpjswtjxhqhnyps` e rodar. (MCP não tem permissão — passo manual.)

- [ ] **Step 4: Verificar — sem lock-out e gate ativo**

Rodar no SQL Editor:
```sql
-- (a) Todas as contas existentes viraram active (sem lock-out):
SELECT status, count(*) FROM accounts GROUP BY status;
-- Esperado: só 'active' (nenhuma 'pending') logo após a migration.

-- (b) Simular leitura como uma conta pending — criar conta teste e
--     conferir que ela nasce pending:
--     (feito via signup real no Step de E2E; aqui só valida o default)
SELECT column_default FROM information_schema.columns
 WHERE table_name='accounts' AND column_name='status';
-- Esperado: default = 'pending'::account_status_enum
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/025_account_approval.sql
git commit -m "feat(accounts): migration do gate de aprovação (status + RLS active)"
```

---

## Task 2: `platform-admin.ts` — allowlist do super admin

**Files:**
- Create: `src/lib/auth/platform-admin.ts`
- Test: `src/lib/auth/platform-admin.test.ts`

**Interfaces:**
- Produces: `parsePlatformAdminEmails(raw: string | undefined): Set<string>`, `isPlatformAdmin(email: string | null | undefined): boolean`, `requirePlatformAdmin(): Promise<{ supabase: SupabaseClient; userId: string; email: string }>` (lança `ForbiddenError`/`UnauthorizedError` de `./account`).

- [ ] **Step 1: Escrever os testes da lógica pura**

Create `src/lib/auth/platform-admin.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { parsePlatformAdminEmails, isPlatformAdminWith } from "./platform-admin";

describe("parsePlatformAdminEmails", () => {
  it("faz split por vírgula, normaliza lowercase e trim", () => {
    const set = parsePlatformAdminEmails(" Iago@Vantage.com , dev@vantage.com ");
    expect(set.has("iago@vantage.com")).toBe(true);
    expect(set.has("dev@vantage.com")).toBe(true);
    expect(set.size).toBe(2);
  });

  it("ignora entradas vazias e retorna set vazio pra undefined", () => {
    expect(parsePlatformAdminEmails(undefined).size).toBe(0);
    expect(parsePlatformAdminEmails("").size).toBe(0);
    expect(parsePlatformAdminEmails("a@b.com,,").size).toBe(1);
  });
});

describe("isPlatformAdminWith", () => {
  const allow = parsePlatformAdminEmails("iago@vantage.com");
  it("é case-insensitive", () => {
    expect(isPlatformAdminWith(allow, "IAGO@vantage.com")).toBe(true);
  });
  it("rejeita e-mail fora da lista, null e vazio", () => {
    expect(isPlatformAdminWith(allow, "outro@x.com")).toBe(false);
    expect(isPlatformAdminWith(allow, null)).toBe(false);
    expect(isPlatformAdminWith(allow, "")).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar o teste pra ver falhar**

Run: `npx vitest run src/lib/auth/platform-admin.test.ts`
Expected: FAIL — "Failed to resolve import './platform-admin'".

- [ ] **Step 3: Implementar `platform-admin.ts`**

Create `src/lib/auth/platform-admin.ts`:

```typescript
// ============================================================
// Super admin de plataforma (VANTAGE) — allowlist por env.
//
// Por que env e não tabela: o admin de plataforma fica IMUTÁVEL sem
// acesso de deploy. Uma tabela poderia ser escrita por um service-role
// vazado ou falha de RLS; o env não. Checagem 100% server-side; o
// e-mail (já verificado pelo Supabase) nunca decide nada no client.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { ForbiddenError, UnauthorizedError } from "./account";

/** Faz parse do CSV `PLATFORM_ADMIN_EMAILS` em um set normalizado. */
export function parsePlatformAdminEmails(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0),
  );
}

/** Versão pura/injetável (testável sem env). */
export function isPlatformAdminWith(
  allow: Set<string>,
  email: string | null | undefined,
): boolean {
  if (!email) return false;
  return allow.has(email.trim().toLowerCase());
}

/** Lê a allowlist do ambiente e checa o e-mail. */
export function isPlatformAdmin(email: string | null | undefined): boolean {
  return isPlatformAdminWith(
    parsePlatformAdminEmails(process.env.PLATFORM_ADMIN_EMAILS),
    email,
  );
}

/**
 * Exige que o caller seja super admin de plataforma. Lança
 * `UnauthorizedError` (sem sessão) ou `ForbiddenError` (não é admin /
 * e-mail não confirmado). Retorna o client SSR + identidade.
 */
export async function requirePlatformAdmin(): Promise<{
  supabase: SupabaseClient;
  userId: string;
  email: string;
}> {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) throw new UnauthorizedError();

  // E-mail tem que estar confirmado — senão alguém poderia cadastrar
  // um e-mail da allowlist sem provar posse e cair como admin.
  if (!user.email || !user.email_confirmed_at) {
    throw new ForbiddenError("Acesso restrito");
  }
  if (!isPlatformAdmin(user.email)) {
    throw new ForbiddenError("Acesso restrito");
  }

  return { supabase, userId: user.id, email: user.email };
}
```

- [ ] **Step 4: Rodar o teste pra ver passar**

Run: `npx vitest run src/lib/auth/platform-admin.test.ts`
Expected: PASS (5 testes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/platform-admin.ts src/lib/auth/platform-admin.test.ts
git commit -m "feat(auth): allowlist de super admin de plataforma por env"
```

---

## Task 3: Gate de status no backend (`account.ts`)

**Files:**
- Modify: `src/lib/auth/account.ts`

**Interfaces:**
- Consumes: `AccountContext` (existente), `toErrorResponse` (existente).
- Produces: `AccountContext.account` ganha `status: AccountStatus` e `accountType: string | null`; novo tipo `AccountStatus`; classe `AccountPendingError` (status 403); `requireRole` passa a lançar `AccountPendingError` se a conta não está `active`; `toErrorResponse` mapeia `AccountPendingError`.

- [ ] **Step 1: Adicionar o tipo e a classe de erro**

In `src/lib/auth/account.ts`, after the `ForbiddenError` class (line 55), add:

```typescript
export type AccountStatus = "pending" | "active" | "suspended" | "rejected";

/**
 * Conta autenticada mas ainda não aprovada (ou suspensa/reprovada).
 * 403 com código estável pra o frontend detectar e redirecionar ao
 * muro `/pending`.
 */
export class AccountPendingError extends Error {
  readonly status = 403 as const;
  readonly code = "account_pending" as const;
  constructor(public readonly accountStatus: AccountStatus) {
    super("Account is not active");
    this.name = "AccountPendingError";
  }
}
```

- [ ] **Step 2: Mapear o erro novo em `toErrorResponse`**

In `src/lib/auth/account.ts`, replace the body of `toErrorResponse` (lines 69-75) with:

```typescript
export function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof AccountPendingError) {
    return NextResponse.json(
      { error: err.message, code: err.code, status: err.accountStatus },
      { status: err.status },
    );
  }
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("[toErrorResponse] uncategorized error:", err);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}
```

- [ ] **Step 3: Carregar status/account_type no contexto**

In `src/lib/auth/account.ts`, update the `AccountContext` interface `account` field (lines 90-91) to:

```typescript
  /** Lightweight account meta — id + name + status + type. */
  account: { id: string; name: string; status: AccountStatus; accountType: string | null };
```

Then in `getCurrentAccount`, change the select (line 124) to include the new columns:

```typescript
    .select("account_id, account_role, account:accounts!inner(id, name, status, account_type)")
```

And update the returned `account` object (lines 149-155) to:

```typescript
  return {
    supabase,
    userId: user.id,
    accountId: data.account_id,
    role: data.account_role,
    account: {
      id: accountRow.id,
      name: accountRow.name,
      status: accountRow.status as AccountStatus,
      accountType: accountRow.account_type ?? null,
    },
  };
```

> Nota: `getCurrentAccount` **não** lança em pending — é o loader base usado também pelo muro/layout pra LER o status. Quem barra é `requireRole`/`requireActiveAccount`.

- [ ] **Step 4: Barrar pending em `requireRole` + exportar `requireActiveAccount`**

In `src/lib/auth/account.ts`, replace `requireRole` (lines 165-173) with:

```typescript
/**
 * Resolve o contexto e exige que a conta esteja `active` (lança
 * `AccountPendingError` caso contrário). Use em rotas que não precisam
 * de papel mínimo mas exigem conta aprovada.
 */
export async function requireActiveAccount(): Promise<AccountContext> {
  const ctx = await getCurrentAccount();
  if (ctx.account.status !== "active") {
    throw new AccountPendingError(ctx.account.status);
  }
  return ctx;
}

export async function requireRole(min: AccountRole): Promise<AccountContext> {
  const ctx = await requireActiveAccount();
  if (!hasMinRole(ctx.role, min)) {
    throw new ForbiddenError(
      `This action requires the '${min}' role or higher`,
    );
  }
  return ctx;
}
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (sem erros novos). Se algum consumidor de `ctx.account` quebrar por causa dos campos novos, ele só ganhou campos — não deve quebrar.

- [ ] **Step 6: Commit**

```bash
git add src/lib/auth/account.ts
git commit -m "feat(auth): gate de conta pending no backend (requireRole 403)"
```

---

## Task 4: Expor status no client (`use-auth.tsx`)

**Files:**
- Modify: `src/hooks/use-auth.tsx`

**Interfaces:**
- Consumes: `AccountSummary` (existente neste arquivo).
- Produces: `AccountSummary` ganha `status: string | null` e `account_type: string | null`, populados via o select do `fetchProfile`.

- [ ] **Step 1: Adicionar os campos ao `AccountSummary`**

In `src/hooks/use-auth.tsx`, update the `AccountSummary` interface (lines 39-45) to add:

```typescript
interface AccountSummary {
  id: string;
  name: string;
  default_currency: string;
  /** Status de aprovação da conta. Null enquanto carrega. */
  status: string | null;
  /** Origem/tipo da conta ('ia_client' | 'self_serve' | 'internal'). */
  account_type: string | null;
}
```

- [ ] **Step 2: Incluir as colunas no select e no mapeamento**

In `fetchProfile` (line 139), change the embedded account select to:

```typescript
          "id, full_name, email, avatar_url, role, beta_features, account_id, account_role, account:accounts!inner(id, name, default_currency, status, account_type)",
```

Then update the `accountRaw` cast (lines 161-165) and the `accountRow` build (lines 169-175):

```typescript
          : (data.account as {
              id: string;
              name: string;
              default_currency: string | null;
              status: string | null;
              account_type: string | null;
            } | null);
        const accountRow: AccountSummary | null = accountRaw
          ? {
              id: accountRaw.id,
              name: accountRaw.name,
              default_currency: accountRaw.default_currency ?? DEFAULT_CURRENCY,
              status: accountRaw.status ?? null,
              account_type: accountRaw.account_type ?? null,
            }
          : null;
```

- [ ] **Step 3: Atualizar o fallback do `useAuth` fora do provider**

In `src/hooks/use-auth.tsx`, the fallback `account: null` (line 354) já é `null` — nada a fazer (status só existe quando `account` existe). Confirmar visualmente que o objeto de fallback continua com `account: null`.

- [ ] **Step 4: Typecheck + build**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/use-auth.tsx
git commit -m "feat(auth): expor status/tipo da conta no contexto do client"
```

---

## Task 5: Página `/pending` (muro)

**Files:**
- Create: `src/app/pending/page.tsx`

**Interfaces:**
- Consumes: `getCurrentAccount` de `@/lib/auth/account`, `redirect` de `next/navigation`.

- [ ] **Step 1: Implementar a página**

Create `src/app/pending/page.tsx`:

```tsx
// Muro mostrado a contas ainda não aprovadas. Server component: lê o
// próprio status (accounts_select é status-agnóstica) e decide. Conta
// já ativa cai pro dashboard; sem sessão, pro login.
import { redirect } from "next/navigation";

import { getCurrentAccount, UnauthorizedError } from "@/lib/auth/account";

export const metadata = {
  robots: { index: false, follow: false },
};

export default async function PendingPage() {
  let status: string;
  let statusReason: string | null = null;
  try {
    const ctx = await getCurrentAccount();
    status = ctx.account.status;
  } catch (err) {
    if (err instanceof UnauthorizedError) redirect("/login");
    // Profile sem conta / erro de contexto: manda pro login pra refazer.
    redirect("/login");
  }

  if (status === "active") redirect("/dashboard");

  const isRejected = status === "rejected";

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center">
        <h1 className="text-xl font-semibold text-foreground">
          {isRejected ? "Conta não aprovada" : "Sua conta está em análise"}
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          {isRejected
            ? "O acesso a esta conta não foi liberado. Se acha que é um engano, fale com a equipe VANTAGE."
            : "Recebemos seu cadastro. A equipe VANTAGE precisa aprovar o acesso antes de você entrar no CRM — você será avisado por e-mail assim que for liberado."}
        </p>
        {statusReason ? (
          <p className="mt-2 text-xs text-muted-foreground">{statusReason}</p>
        ) : null}
        <a
          href="/login"
          className="mt-6 inline-block text-sm text-primary hover:underline"
        >
          Voltar ao login
        </a>
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Verificar build**

Run: `npx next build` (ou `npx tsc --noEmit` pra checagem rápida de tipos)
Expected: a rota `/pending` compila sem erro.

- [ ] **Step 3: Commit**

```bash
git add src/app/pending/page.tsx
git commit -m "feat(accounts): pagina /pending (muro de conta em analise)"
```

---

## Task 6: Redirect de pending no layout do dashboard + middleware

**Files:**
- Modify: `src/app/(dashboard)/layout.tsx`
- Modify: `src/middleware.ts`

**Interfaces:**
- Consumes: `getCurrentAccount`, `UnauthorizedError`, `ForbiddenError` de `@/lib/auth/account`.

- [ ] **Step 1: Tornar o layout async e redirecionar pending**

Replace `src/app/(dashboard)/layout.tsx` entirely with:

```tsx
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getCurrentAccount, UnauthorizedError } from "@/lib/auth/account";
import { DashboardShell } from "./dashboard-shell";

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false, noimageindex: true },
  },
};

// Gate server-side: nenhuma página do dashboard renderiza pra uma conta
// que não está 'active'. Defesa em profundidade por cima da RLS — aqui
// é só UX (redireciona ao muro); a RLS é quem realmente esconde os dados.
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  try {
    const ctx = await getCurrentAccount();
    if (ctx.account.status !== "active") redirect("/pending");
  } catch (err) {
    if (err instanceof UnauthorizedError) redirect("/login");
    // Profile sem conta vinculada — manda pro muro/login.
    redirect("/pending");
  }

  return <DashboardShell>{children}</DashboardShell>;
}
```

> Atenção: `redirect()` lança internamente (`NEXT_REDIRECT`); não envolver a chamada de `redirect` em try/catch que engula o erro. No código acima o `redirect` do sucesso está FORA do try, e os do catch são as últimas instruções — ok.

Corrigir o detalhe acima: mover o `redirect("/pending")` do sucesso pra fora do try. Versão final do corpo:

```tsx
  let status: string | null = null;
  try {
    const ctx = await getCurrentAccount();
    status = ctx.account.status;
  } catch (err) {
    if (err instanceof UnauthorizedError) redirect("/login");
    redirect("/pending");
  }
  if (status !== "active") redirect("/pending");

  return <DashboardShell>{children}</DashboardShell>;
```

- [ ] **Step 2: Adicionar `/pending` e `/admin` aos protected paths do middleware**

In `src/middleware.ts`, update the `protectedPaths` array (line 56) to:

```typescript
  const protectedPaths = ['/dashboard', '/inbox', '/contacts', '/pipelines', '/broadcasts', '/automations', '/settings', '/pending', '/admin']
```

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(dashboard)/layout.tsx" src/middleware.ts
git commit -m "feat(accounts): redireciona conta pending para /pending"
```

---

## Task 7: Aviso de aprovação + APIs admin (approve / reject / list)

**Files:**
- Create: `src/lib/notify/approval.ts`
- Create: `src/app/api/admin/accounts/route.ts`
- Create: `src/app/api/admin/accounts/[accountId]/approve/route.ts`
- Create: `src/app/api/admin/accounts/[accountId]/reject/route.ts`

**Interfaces:**
- Consumes: `requirePlatformAdmin` (Task 2), `toErrorResponse` (Task 3), `supabaseAdmin` de `@/lib/flows/admin-client`, `after` de `next/server`, `checkRateLimit`/`rateLimitResponse`/`RATE_LIMITS` de `@/lib/rate-limit`.
- Produces: `notifyAccountApproved(input: { accountId: string; email: string; name: string }): Promise<void>`.

- [ ] **Step 1: Implementar o notificador (webhook n8n, best-effort)**

Create `src/lib/notify/approval.ts`:

```typescript
// ============================================================
// Aviso de aprovação de conta — só e-mail, via webhook do n8n.
// Best-effort: falha aqui NÃO derruba a aprovação (apenas loga). O
// n8n monta e envia o e-mail "sua conta foi liberada".
// ============================================================

interface ApprovalNotifyInput {
  accountId: string;
  email: string;
  name: string;
}

export async function notifyAccountApproved(
  input: ApprovalNotifyInput,
): Promise<void> {
  const url = process.env.APPROVAL_NOTIFY_WEBHOOK_URL;
  if (!url) {
    console.warn("[notify/approval] APPROVAL_NOTIFY_WEBHOOK_URL ausente — pulando aviso");
    return;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "account_approved",
        account_id: input.accountId,
        owner_email: input.email,
        owner_name: input.name,
      }),
    });
    if (!res.ok) {
      console.error(`[notify/approval] webhook respondeu ${res.status}`);
    }
  } catch (err) {
    console.error("[notify/approval] falha ao chamar webhook:", err);
  }
}
```

- [ ] **Step 2: Implementar GET lista de contas**

Create `src/app/api/admin/accounts/route.ts`:

```typescript
// GET /api/admin/accounts?status=pending — lista contas pro painel
// de super admin. Service role pra enxergar TODAS as contas (o admin
// de plataforma não é membro delas). Gate por requirePlatformAdmin.
import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/auth/account";
import { requirePlatformAdmin } from "@/lib/auth/platform-admin";
import { supabaseAdmin } from "@/lib/flows/admin-client";

const VALID_STATUS = ["pending", "active", "suspended", "rejected"] as const;

export async function GET(request: Request) {
  try {
    await requirePlatformAdmin();

    const url = new URL(request.url);
    const statusParam = url.searchParams.get("status");
    const status =
      statusParam && (VALID_STATUS as readonly string[]).includes(statusParam)
        ? statusParam
        : "pending";

    const { data, error } = await supabaseAdmin()
      .from("accounts")
      .select(
        "id, name, status, account_type, created_at, approved_at, owner_user_id, owner:profiles!profiles_account_id_fkey(email, full_name)",
      )
      .eq("status", status)
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) {
      console.error("[GET /api/admin/accounts] erro:", error);
      return NextResponse.json(
        { error: "Falha ao listar contas" },
        { status: 500 },
      );
    }

    return NextResponse.json({ accounts: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
```

> Se o embed `owner:profiles!...` não resolver pela ambiguidade de FK, trocar por buscar o owner via `profiles` num segundo passo (map por `owner_user_id`). Validar no Step 5.

- [ ] **Step 3: Implementar POST approve**

Create `src/app/api/admin/accounts/[accountId]/approve/route.ts`:

```typescript
// POST /api/admin/accounts/[accountId]/approve — aprova uma conta:
// status='active', carimba account_type/approved_at/approved_by e
// dispara o aviso por e-mail (fire-and-forget). Idempotente: só age
// em conta 'pending' (evita re-disparar e-mail).
import { NextResponse, after } from "next/server";

import { toErrorResponse } from "@/lib/auth/account";
import { requirePlatformAdmin } from "@/lib/auth/platform-admin";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { notifyAccountApproved } from "@/lib/notify/approval";

const VALID_TYPES = ["ia_client", "self_serve", "internal"] as const;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> },
) {
  try {
    const admin = await requirePlatformAdmin();

    const limit = checkRateLimit(
      `adminAction:${admin.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { accountId } = await params;
    const body = await request.json().catch(() => null);
    const accountType =
      typeof body?.account_type === "string" ? body.account_type : "";
    if (!(VALID_TYPES as readonly string[]).includes(accountType)) {
      return NextResponse.json(
        { error: "account_type inválido (ia_client | self_serve | internal)" },
        { status: 400 },
      );
    }

    const db = supabaseAdmin();

    // Atualiza só se ainda está pending → idempotência (retorna a linha).
    const { data: updated, error } = await db
      .from("accounts")
      .update({
        status: "active",
        account_type: accountType,
        approved_at: new Date().toISOString(),
        approved_by_user_id: admin.userId,
        status_reason: null,
      })
      .eq("id", accountId)
      .eq("status", "pending")
      .select("id, owner_user_id")
      .maybeSingle();

    if (error) {
      console.error("[POST approve] erro:", error);
      return NextResponse.json({ error: "Falha ao aprovar" }, { status: 500 });
    }
    if (!updated) {
      // Já aprovada/reprovada ou inexistente — no-op, sem re-disparar e-mail.
      return NextResponse.json(
        { success: true, already: true },
        { status: 200 },
      );
    }

    // Busca e-mail/nome do owner pro aviso.
    const { data: owner } = await db
      .from("profiles")
      .select("email, full_name")
      .eq("user_id", updated.owner_user_id)
      .maybeSingle();

    if (owner?.email) {
      after(() =>
        notifyAccountApproved({
          accountId: updated.id,
          email: owner.email,
          name: owner.full_name ?? "",
        }),
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
```

- [ ] **Step 4: Implementar POST reject**

Create `src/app/api/admin/accounts/[accountId]/reject/route.ts`:

```typescript
// POST /api/admin/accounts/[accountId]/reject — reprova: status='rejected'
// + motivo opcional. Sem aviso por e-mail nesta v1.
import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/auth/account";
import { requirePlatformAdmin } from "@/lib/auth/platform-admin";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> },
) {
  try {
    const admin = await requirePlatformAdmin();

    const limit = checkRateLimit(
      `adminAction:${admin.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { accountId } = await params;
    const body = await request.json().catch(() => null);
    const reason =
      typeof body?.reason === "string" ? body.reason.trim().slice(0, 500) : null;

    const { data: updated, error } = await supabaseAdmin()
      .from("accounts")
      .update({ status: "rejected", status_reason: reason })
      .eq("id", accountId)
      .in("status", ["pending", "active", "suspended"])
      .select("id")
      .maybeSingle();

    if (error) {
      console.error("[POST reject] erro:", error);
      return NextResponse.json({ error: "Falha ao reprovar" }, { status: 500 });
    }
    if (!updated) {
      return NextResponse.json(
        { error: "Conta não encontrada" },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
```

- [ ] **Step 5: Verificar build + o embed de owner**

Run: `npx tsc --noEmit`
Expected: PASS. Se o `owner:profiles!profiles_account_id_fkey(...)` no GET der erro de relacionamento em runtime, ajustar pra buscar owners num segundo query e mapear por `owner_user_id` (cada conta tem o profile owner com `account_id = accounts.id` e `account_role='owner'`).

- [ ] **Step 6: Commit**

```bash
git add src/lib/notify/approval.ts src/app/api/admin/accounts/
git commit -m "feat(admin): APIs de aprovar/reprovar/listar contas + aviso por e-mail"
```

---

## Task 8: Painel `/admin`

**Files:**
- Create: `src/app/admin/page.tsx`
- Create: `src/app/admin/admin-accounts-table.tsx`

**Interfaces:**
- Consumes: `requirePlatformAdmin` (Task 2), as APIs da Task 7.

- [ ] **Step 1: Server page gated por platform admin**

Create `src/app/admin/page.tsx`:

```tsx
// Painel de super admin (VANTAGE). Server component gated por
// requirePlatformAdmin: e-mail fora da allowlist nunca vê o conteúdo.
import { redirect } from "next/navigation";

import {
  requirePlatformAdmin,
} from "@/lib/auth/platform-admin";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { AdminAccountsTable } from "./admin-accounts-table";

export const metadata = { robots: { index: false, follow: false } };

export default async function AdminPage() {
  try {
    await requirePlatformAdmin();
  } catch (err) {
    if (err instanceof UnauthorizedError) redirect("/login");
    if (err instanceof ForbiddenError) redirect("/dashboard");
    throw err;
  }

  const { data: pending } = await supabaseAdmin()
    .from("accounts")
    .select("id, name, status, account_type, created_at, owner_user_id")
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(200);

  // Enriquecer com e-mail do owner (profile com account_role='owner').
  const ownerIds = (pending ?? []).map((a) => a.owner_user_id);
  const { data: owners } = ownerIds.length
    ? await supabaseAdmin()
        .from("profiles")
        .select("user_id, email, full_name")
        .in("user_id", ownerIds)
    : { data: [] as { user_id: string; email: string; full_name: string | null }[] };

  const ownerById = new Map(
    (owners ?? []).map((o) => [o.user_id, o]),
  );
  const rows = (pending ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    created_at: a.created_at,
    owner_email: ownerById.get(a.owner_user_id)?.email ?? "—",
    owner_name: ownerById.get(a.owner_user_id)?.full_name ?? null,
  }));

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="text-2xl font-semibold text-foreground">
        Contas pendentes de aprovação
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Aprove para liberar o CRM (o lead recebe um e-mail) ou reprove.
      </p>
      <div className="mt-6">
        <AdminAccountsTable initialRows={rows} />
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Tabela client com ações aprovar/reprovar**

Create `src/app/admin/admin-accounts-table.tsx`:

```tsx
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
```

- [ ] **Step 3: Verificar build**

Run: `npx tsc --noEmit`
Expected: PASS. Conferir que as classes Tailwind usadas (`bg-card`, `text-muted-foreground`, `bg-primary`, etc.) existem no design system do projeto; se não, trocar pelos tokens equivalentes do tema (ver `src/app/(auth)/login/page.tsx` pra referência de cores).

- [ ] **Step 4: Commit**

```bash
git add src/app/admin/
git commit -m "feat(admin): painel /admin de aprovacao de contas"
```

---

## Task 9: Envs, documentação e checklist E2E

**Files:**
- Modify: `.env.example` (se existir; senão criar nota no README do projeto)

**Interfaces:** nenhuma — task de configuração e verificação final.

- [ ] **Step 1: Documentar os envs novos**

Se existir `.env.example`, adicionar:

```bash
# Super admin de plataforma — CSV de e-mails que acessam /admin.
# Comece só com o seu. Imutável sem deploy (por segurança).
PLATFORM_ADMIN_EMAILS=vantage.agencia@gmail.com

# Webhook do n8n que envia o e-mail "conta liberada" ao aprovar.
APPROVAL_NOTIFY_WEBHOOK_URL=
```

- [ ] **Step 2: Setar os envs na Vercel (Production apenas)**

Run (Iago, ou via CLI):
```bash
vercel env add PLATFORM_ADMIN_EMAILS production
vercel env add APPROVAL_NOTIFY_WEBHOOK_URL production
```
> NÃO adicionar ao Preview (regra de segurança — segredos de prod não vão pro Preview).

- [ ] **Step 3: Checklist E2E (manual, pós-deploy)**

- [ ] Conta do Iago continua acessando tudo (grandfather ok, sem lock-out).
- [ ] Signup novo → `/pending` ao logar; não acessa `/dashboard`, `/inbox` etc.
- [ ] **RLS:** com o JWT da conta pending, `GET` direto no PostgREST em `/rest/v1/contacts` → vazio/negado. `GET` em `/rest/v1/accounts?id=eq.<próprio>` → retorna a linha (renderiza o muro).
- [ ] Rota de API escopada com sessão pending → `403` com `code:"account_pending"`.
- [ ] `/admin` com e-mail na allowlist → abre; e-mail fora → redirect/403.
- [ ] Aprovar (escolhendo tipo) → conta vira `active`, acessa o CRM; e-mail de aviso dispara no n8n.
- [ ] Aprovar 2x a mesma conta → `already:true`, sem segundo e-mail.
- [ ] Reprovar → muro "Conta não aprovada"; sem acesso.

- [ ] **Step 4: Commit (se houve mudança de arquivo)**

```bash
git add .env.example
git commit -m "docs(accounts): documenta envs do gate de aprovacao"
```

---

## Self-Review

- **Spec coverage:** schema+grandfather (Task 1) ✓ · RLS gate (Task 1) ✓ · super admin env (Task 2) ✓ · backend gate (Task 3) ✓ · client status (Task 4) ✓ · /pending (Task 5) ✓ · layout redirect (Task 6) ✓ · APIs admin + aviso e-mail (Task 7) ✓ · painel /admin (Task 8) ✓ · account_type (Tasks 1,7,8) ✓ · envs + E2E (Task 9) ✓. Todos os itens do spec têm task.
- **Decisões do spec respeitadas:** muro total ✓ · allowlist env ✓ · só painel /admin (sem ping de entrada) ✓ · RLS+backend+frontend ✓ · só e-mail ✓ · account_type agora ✓.
- **Type consistency:** `AccountStatus` definido em Task 3 e reusado; `account.status`/`account.accountType` (camelCase no server `account.ts`) vs `account.status`/`account.account_type` (snake no client `use-auth`, que reflete a coluna) — proposital, são contextos diferentes (server context vs row do client). `notifyAccountApproved` assinatura igual em Task 7 (def) e uso. `requirePlatformAdmin` retorno `{ supabase, userId, email }` consistente entre Tasks 2/7/8.
- **Placeholder scan:** sem TBD/TODO; todo passo de código tem o código completo.
```

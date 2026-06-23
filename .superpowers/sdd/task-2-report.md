# Task 2 Report — isPlatformAdmin no client + mensagem de conta suspensa

## Status
CONCLUÍDO

## Commit SHA
b727ab0

## tsc result
Limpo — zero erros.

## vitest result
60 testes passaram, 0 falhas (suite `src/lib/auth/`).

## O que foi feito

### A. `src/lib/auth/account.ts`
- Adicionado `email: string | null` à interface `AccountContext`.
- `getCurrentAccount()` agora retorna `email: user.email ?? null` no objeto de contexto.

### B. `src/app/(dashboard)/layout.tsx`
- Importado `isPlatformAdmin` de `@/lib/auth/platform-admin`.
- Declarado `let email: string | null = null` junto ao `let status`.
- Dentro do try, atribuído `email = ctx.email` (preservando toda a lógica de redirect existente).
- Após o guard `if (status !== "active") redirect("/pending")`, computado `const platformAdmin = isPlatformAdmin(email)`.
- Passado `isPlatformAdmin={platformAdmin}` para `<DashboardShell>`.

### C. `src/app/(dashboard)/dashboard-shell.tsx`
- `DashboardShell` aceita prop `isPlatformAdmin?: boolean` (default `false`).
- Repassa para `<AuthProvider isPlatformAdmin={isPlatformAdmin}>`.

### D. `src/hooks/use-auth.tsx`
- `AuthContextValue` tem novo campo `isPlatformAdmin: boolean` (documentado como UX-only).
- `AuthProvider` aceita prop `isPlatformAdmin?: boolean` (default `false`) e a inclui no value do provider como prop estática (fora do memo `derived`).
- Fallback de `useAuth()` fora do provider retorna `isPlatformAdmin: false`.

### E. `src/app/pending/page.tsx`
- Adicionado `const isSuspended = status === "suspended"`.
- Heading: "Conta não aprovada" | "Conta suspensa" | "Sua conta está em análise".
- Body: mensagem específica para suspended ("O acesso a esta conta foi suspenso. Fale com a equipe VANTAGE para reativar.").

## Observações
- A checagem de `isPlatformAdmin` no layout é exclusivamente para UX (exibir o item Admin na sidebar). A guarda real permanece server-side nos route handlers/server actions do painel admin.
- Nenhum comportamento de throw/redirect foi alterado em `layout.tsx`.
- O valor não é derivado de nenhum fetch client-side — vem do servidor como prop estática.

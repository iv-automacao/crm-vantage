# Spec — Gate de aprovação de contas (VANTAGE CRM)

**Data:** 2026-06-23
**Status:** Aprovado (brainstorming) — pronto pra plano de implementação
**Banco alvo:** Supabase dedicado do CRM `mgmokvpjswtjxhqhnyps` (NUNCA banco de cliente — guard-rail VANTAGE)

---

## Problema

Hoje qualquer pessoa que abre `crm.vantagemanaus.com.br` e clica em "Criar conta" ganha um CRM ativo na hora. O cadastro dispara o trigger `handle_new_user()` (`supabase/migrations/017_account_sharing.sql:609`) que cria automaticamente o `accounts` + o `profiles` como `owner`, no nível do Supabase Auth — sem passar por nenhuma rota nossa. Não existe coluna de `status` nem qualquer conceito de "super admin". O portão está aberto.

Queremos que a VANTAGE controle quem entra: a pessoa se cadastra normalmente (fluxo self-serve da landing page continua vivo), mas a conta nasce **bloqueada** até um admin de plataforma (Iago) aprovar. Esse mesmo mecanismo vira a fundação do billing futuro (cliente de IA = CRM cortesia; cliente da LP = assinatura mensal).

## Objetivos

1. Toda conta nova nasce `pending` e não acessa nada do CRM até ser aprovada.
2. Um "super admin" (Iago) aprova/reprova contas num painel `/admin`.
3. O bloqueio é **seguro de verdade** — vive na RLS do Supabase, não só na UI.
4. A arquitetura encaixa no billing futuro sem migration dolorosa.
5. O lead é avisado por e-mail quando a conta é aprovada (pra voltar e usar).

## Não-objetivos (fora de escopo desta entrega)

- Cobrança / integração de pagamento (LP → assinatura). Fica pra fase de billing; este spec só prepara o terreno (`status`, `account_type`).
- Notificação ao Iago a cada novo signup (decidido: só painel `/admin`, sem ping de entrada).
- Aviso de aprovação por WhatsApp (decidido: só e-mail nesta entrega).
- Auto-aprovação por regra/domínio. Toda aprovação é manual nesta v1.
- Fluxo de "recurso/reapelação" de conta reprovada.

---

## Decisões travadas (brainstorming)

| Tema | Decisão | Por quê |
|------|---------|---------|
| Comportamento da conta pending | **Muro total** — loga mas só vê "conta em análise", zero acesso ao CRM | Mais simples e seguro que preview desabilitado |
| Identidade do super admin | **Allowlist por env** (`PLATFORM_ADMIN_EMAILS`) | Imutável sem acesso de deploy; não dá pra forjar via DB/service-role comprometido. Mais seguro que tabela |
| Fluxo de aprovação | **Só painel `/admin`** (sem notificação de entrada) | Iago confere o painel; menos infra agora |
| Profundidade do gate | **RLS + backend + frontend** | Frontend lê muito via browser Supabase client → a fronteira real é a RLS; gate só no backend seria cosmético |
| Aviso de aprovação | **Só e-mail**, via webhook n8n | Fecha o ciclo (lead volta) reusando infra n8n existente |
| Tipo de conta | **Campo `account_type` já nesta migration** | Separa cortesia de pagante; evita migration futura no billing |

---

## Arquitetura

```
Signup (self-serve) → trigger handle_new_user() → accounts.status = 'pending' (default)
                                                        │
                          ┌─────────────────────────────┘
                          ▼
  Usuário loga ──► gate em 3 camadas:
     1. RLS (Supabase): is_account_member() exige status='active'
        → tabelas de dados invisíveis enquanto pending (mesmo via JWT direto)
        → EXCEÇÃO: leitura da própria accounts/profiles continua liberada (renderiza o muro)
     2. Backend (Next API): getCurrentAccount/requireRole lançam 403 AccountPending
     3. Frontend: layout do dashboard redireciona pending → /pending ("conta em análise")

  Iago (platform admin) ──► /admin (gated por requirePlatformAdmin via env allowlist)
     ├─ Aprovar  → status='active', account_type escolhido, approved_at/by carimbados
     │             └─ fire-and-forget: webhook n8n → e-mail "conta liberada" pro lead
     └─ Reprovar → status='rejected', status_reason
```

**Anti-lock-out:** a migration faz grandfather de todas as contas existentes (`status='active'`, `account_type='internal'`) antes de qualquer enforcement entrar em vigor, senão o Iago e as contas atuais ficariam trancados pra fora.

---

## Componentes

### 1. Migration (nova, ex: `025_account_approval.sql`)

Idempotente, no padrão das migrations existentes (`IF NOT EXISTS`, `DROP POLICY IF EXISTS`).

- **Enum** `account_status_enum AS ENUM ('pending','active','suspended','rejected')`.
- **Colunas em `accounts`:**
  - `status account_status_enum NOT NULL DEFAULT 'pending'`
  - `account_type TEXT` (nullable; valores esperados `'ia_client' | 'self_serve' | 'internal'`, carimbado na aprovação)
  - `approved_at TIMESTAMPTZ`
  - `approved_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL`
  - `status_reason TEXT` (motivo da reprovação/suspensão)
- **Grandfather:** `UPDATE accounts SET status='active', account_type='internal' WHERE status IS NULL OR status='pending';` rodado **dentro da migration**, antes do enforcement.
- **Redefinição de `is_account_member()`:** adiciona `AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = target_account_id AND a.status = 'active')`. Como é `SECURITY DEFINER STABLE`, isso fecha todas as policies de dados que já usam o helper de uma vez.
- **Exceção cirúrgica:** garantir que as policies de **SELECT da própria `accounts`** e do **próprio `profiles`** NÃO dependam do status (predicado por `auth.uid()` / `owner_user_id = auth.uid()` / membership sem status). Sem isso a conta pending não consegue ler o próprio status pra renderizar `/pending`.
- **Índice:** `CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status) WHERE status = 'pending';` (lista quente do painel).

> **Auditoria obrigatória na implementação:** fazer grep de **todas** as policies/funções que chamam `is_account_member()` e confirmar que nenhuma leitura necessária-enquanto-pending (além de accounts/profiles próprios) quebra. Casos a verificar explicitamente: leitura do próprio profile no `use-auth`, RPCs de convite (`peek_invitation`/`redeem_invitation`), policies de `account_invitations`.

### 2. Super admin — `src/lib/auth/platform-admin.ts` (novo)

- Lê `PLATFORM_ADMIN_EMAILS` (CSV, normalizado lowercase/trim).
- `isPlatformAdmin(email)` — checagem pura.
- `requirePlatformAdmin()` — pega o usuário da sessão (server-side), confere e-mail **verificado** ∈ allowlist; lança `403` se não. Espelha o padrão de `requireRole` em `src/lib/auth/account.ts`.
- 100% server-side; o e-mail nunca vai pro client decidir nada.

### 3. Enforcement backend — `src/lib/auth/account.ts` (modificado)

- `getCurrentAccount()`/`requireRole()` passam a carregar `accounts.status`.
- Novo erro tipado `AccountPendingError` (mapeado pra `403` em `toErrorResponse`) quando `status !== 'active'`.
- Como praticamente toda rota de API escopada por conta passa por esse gargalo, é a segunda camada que protege chamadas diretas às nossas rotas Next.

### 4. Enforcement frontend

- **`/pending`** (`src/app/pending/page.tsx`, novo): tela "Sua conta está em análise". Lê o próprio status; se já `active`, redireciona pra `/dashboard`. Se `rejected`, mostra mensagem apropriada (+ `status_reason` se houver).
- **Layout autenticado do dashboard** (server component): lê o status uma vez e redireciona `pending`/`rejected`/`suspended` → `/pending`. `active` segue normal.
- `use-auth` (`src/hooks/use-auth.tsx`): expõe `account.status` no contexto pra UI condicional, sem virar a fonte de verdade do gate.

### 5. Painel `/admin`

- **Páginas** (`src/app/admin/...`, server components gated por `requirePlatformAdmin()`):
  - Lista de contas com filtro por status (default: `pending`). Mostra name, e-mail do owner, created_at, status, account_type.
  - Ações: **Aprovar** (dropdown pra escolher `account_type`: `ia_client`/`self_serve`) e **Reprovar** (campo de motivo).
- **APIs** (gated por `requirePlatformAdmin()` + service role pra escrever):
  - `POST /api/admin/accounts/[accountId]/approve` — `status='active'`, `account_type` recebido, `approved_at=now()`, `approved_by_user_id`. Dispara o webhook de aviso (item 6) via `after()`.
  - `POST /api/admin/accounts/[accountId]/reject` — `status='rejected'`, `status_reason`.
  - `GET /api/admin/accounts?status=` — lista paginada (ou leitura direta no server component).
- Rate limit nas ações admin reusando `checkRateLimit`/`RATE_LIMITS.adminAction`.

### 6. Aviso de aprovação — só e-mail via n8n

- Env `APPROVAL_NOTIFY_WEBHOOK_URL` (URL de um webhook no n8n da VANTAGE).
- No `approve`, depois de gravar o status, dispara **fire-and-forget dentro de `after()`** um `POST` pro webhook com `{ account_id, owner_email, owner_name }`.
- O n8n monta e envia o e-mail "sua conta foi liberada" + link de login. Mantém a infra de e-mail fora do CRM.
- Falha do webhook **não** derruba a aprovação (best-effort, logada).

---

## Tratamento de erros

- Conta `pending` batendo em rota de API escopada → `403 AccountPending` (corpo JSON claro).
- Conta `pending`/`rejected` no frontend → redirect pra `/pending` (sem erro visível, é o muro esperado).
- Não-platform-admin tentando `/admin` ou as APIs admin → `403` (página: not found / sem acesso).
- Webhook de aprovação fora do ar → aprovação persiste, erro logado, sem retry nesta v1.
- `approve` numa conta que não está `pending` → idempotente/no-op com resposta clara (evita re-disparar e-mail).

## Segurança

- Gate primário na **RLS** — resiste a JWT direto no PostgREST, não só à nossa UI.
- Super admin por **env allowlist** — não escalável via DB comprometido; muda só com deploy.
- APIs admin **sempre** revalidam `requirePlatformAdmin()` no server (nunca confiam no client).
- Grandfather roda antes do enforcement — sem janela de lock-out.
- Segredos de aprovação (webhook URL, allowlist) só em env server-side; **não** vão pro Preview da Vercel junto com segredos de produção (consistente com a decisão registrada em [[crm-vantage-n8n-agent-loop]]).

## Testes / verificação (E2E)

1. Aplicar a migration no Supabase dedicado via SQL Editor (MCP não tem permissão neste projeto — Iago roda).
2. Conta existente (Iago) continua `active` e acessa tudo — **sem lock-out** (valida grandfather).
3. Signup novo → cai em `pending` → loga e vê só `/pending`.
4. **RLS:** com o JWT da conta pending, bater direto no PostgREST do Supabase numa tabela de dados (ex: `contacts`) → retorna vazio/negado. Ler a própria `accounts` → funciona (renderiza o muro).
5. **Backend:** rota de API escopada com sessão pending → `403 AccountPending`.
6. **Admin:** e-mail na allowlist acessa `/admin`; e-mail fora → `403`. Aprovar → conta vira `active`, acessa o CRM; `account_type` gravado; `approved_at/by` carimbados.
7. Reprovar → `status='rejected'`, muro com mensagem; sem acesso.
8. Aviso: aprovar dispara o webhook n8n e o e-mail chega ao lead.
9. Idempotência: aprovar duas vezes não re-dispara e-mail nem corrompe carimbos.
10. Testes unitários: `platform-admin.ts` (parsing da allowlist, case-insensitive, e-mail não-verificado rejeitado) e o gate de status em `account.ts`.

## Arquivos

**Novos:**
- `supabase/migrations/025_account_approval.sql`
- `src/lib/auth/platform-admin.ts` (+ teste)
- `src/app/pending/page.tsx`
- `src/app/admin/...` (página(s) do painel)
- `src/app/api/admin/accounts/[accountId]/approve/route.ts`
- `src/app/api/admin/accounts/[accountId]/reject/route.ts`
- `src/app/api/admin/accounts/route.ts` (GET lista) — ou leitura direta no server component

**Modificados:**
- `src/lib/auth/account.ts` (carregar status + `AccountPendingError`)
- `src/hooks/use-auth.tsx` (expor `account.status`)
- layout autenticado do dashboard (redirect pending)
- `.env` / Vercel envs: `PLATFORM_ADMIN_EMAILS`, `APPROVAL_NOTIFY_WEBHOOK_URL`

## Reuso (não reinventar)

`requireRole`/`getCurrentAccount`/`toErrorResponse` (`src/lib/auth/account.ts`) · padrão de erro tipado · `checkRateLimit`/`RATE_LIMITS` (`src/lib/rate-limit.ts`) · `supabaseAdmin()` (`src/lib/flows/admin-client.ts`) · `after()` do `next/server` pro webhook fire-and-forget · padrão de migration idempotente das migrations 017–024 · `is_account_member()` como ponto único de gate de RLS.

## Riscos / pontos de atenção

- **Quebra de RLS por efeito colateral:** redefinir `is_account_member()` afeta todas as policies que o usam. Mitigação: auditoria por grep + teste E2E #2/#4 antes de dar deploy.
- **Leitura do próprio profile/account enquanto pending:** se alguma policy necessária depender do helper com status, o muro quebra. Mitigação: exceção cirúrgica + verificação explícita dos casos listados.
- **MCP do Supabase sem permissão** neste projeto: migration aplicada manualmente pelo Iago no SQL Editor.
- **Env no Preview da Vercel:** não copiar os novos segredos pro Preview junto com prod (mesma regra de [[crm-vantage-n8n-agent-loop]]).

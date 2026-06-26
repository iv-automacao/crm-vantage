# RBAC Fase 1a — Enforcement de backend (guards de rota + RLS) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer valer a matriz de papéis no backend — colaborador (`agent`) e viewer não podem mais criar template, editar config do WhatsApp, disparar broadcast, mexer em automações/flows, nem deletar contato/deal.

**Architecture:** Duas camadas. (1) Guard de app: `requireRole(...)` no topo de cada rota hand-rolled hoje sem papel — usa a escada owner>admin>agent>viewer de `src/lib/auth/roles.ts` e já valida conta ativa. (2) RLS: subir o DELETE de `contacts`/`deals` pra admin+ (única defesa, pois são escritos direto do browser) e alinhar broadcasts/automations/flows pra admin+ (consistência). O CI guardrail é endurecido pra exigir papel em rota mutante — e serve de teste RED→GREEN.

**Tech Stack:** Next.js App Router (route handlers), TypeScript, Supabase (Postgres + RLS), Vitest.

## Global Constraints

- Comentários de código/SQL em **português**.
- **Nunca aplicar migration em banco de produção de cliente.** Alvo = projeto Supabase **dedicado do CRM**. MCP do Supabase **sem permissão de escrita** — migrations aplicadas **manualmente pelo Iago no SQL Editor**; verificação é SQL manual.
- **Nunca `git add -A`** — adicionar só os arquivos da task. PRs → `iv-automacao/crm-vantage`.
- Próximo número de migration livre = **032** (a última é `031_profiles_role_guard.sql`).
- **Fonte única de papel:** `src/lib/auth/roles.ts` (`requireRole` em `src/lib/auth/account.ts:222` usa `hasMinRole`). Não comparar string de papel inline.
- **IDOR (automations/flows):** os writes usam `supabaseAdmin()` (service role, bypassa RLS) e os UPDATE/DELETE filtram só por `.eq('id')`, confiando no ownership checado antes. O guard de papel entra como **primeira instrução do handler, SOMADO** ao ownership existente — **nunca substituindo** `requireUser`/`requireOwnership`/`.eq('user_id')`.
- **Service role que deve PERMANECER:** `config/route.ts:217-222` (SELECT de unicidade cross-account) e `send-message.ts:326-328` (`flow_runs` update best-effort). Não trocar esses pelo client de sessão.
- **Matriz (papel mínimo por rota desta fase):** config=admin · broadcast=admin · templates(submit/[id]/sync)=admin · automations(todas)=admin · flows(todas)=admin · send=agent · react=agent · presence(PUT/POST)=agent · media GET=qualquer membro ativo (leitura).
- **Fora de escopo desta fase (1a):** predicados novos + gates de UI (Fase 1b); migração de automations/flows pro client de sessão (spec próprio); modelo por-`user_id` de automations/flows (pré-existente, não mexer).

## Padrão canônico do guard (rotas com client de SESSÃO)

As rotas de templates e whatsapp-ops resolvem hoje `auth.getUser()` + `profiles.account_id` inline, sob o client de sessão. Trocar por `requireRole` DRY-fica isso e adiciona papel + status:

```ts
import { requireRole, toErrorResponse } from '@/lib/auth/account'

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')   // papel + conta ativa; lança Forbidden/Unauthorized/AccountPending
    const supabase = ctx.supabase            // client de SESSÃO (RLS)
    const accountId = ctx.accountId
    // ... resto do handler, usando supabase/accountId já resolvidos ...
  } catch (err) {
    return toErrorResponse(err)              // funil único → 401/403/422/500
  }
}
```

Para rotas que JÁ têm `try/catch`, basta trocar o bloco `auth.getUser()` + lookup de `profiles` pela linha `const ctx = await requireRole(<papel>)` e usar `ctx.supabase`/`ctx.accountId`. Onde havia `user.id`, usar `ctx.userId`.

---

### Task 1: Endurecer o CI guardrail (define o RED de toda a fase)

**Files:**
- Modify: `src/app/api/route-auth-guard.test.ts`

**Interfaces:**
- Consumes: o teste já varre `src/app/api/**/route.ts` e checa markers textuais (`AUTH_MARKERS`, `PUBLIC_ROUTES`).
- Produces: nova checagem `mutating route ⇒ marker FORTE de papel`. Nenhuma outra task depende de símbolos daqui, mas todas as tasks 2-5 re-rodam este teste como verde.

- [ ] **Step 1: Escrever a checagem mais estrita (RED)**

Adicionar ao teste um segundo gate: todo arquivo `route.ts` que exporta um método **mutante** (`POST`/`PATCH`/`PUT`/`DELETE`) precisa conter um marker **forte** de autorização por papel/identidade — `requireRole`, `defineRoute`, `resolveApiKey`, `requirePlatformAdmin`, `AUTOMATION_CRON_SECRET` ou o marker de webhook — e **não** apenas `auth.getUser`/`requireActiveAccount`/`getCurrentAccount`. Manter um allowlist explícito `MUTATING_EXCEPTIONS: Map<relPath, motivo>` (no estilo do `PUBLIC_ROUTES` existente) pra exceções legítimas, começando vazio.

```ts
// Markers que provam decisão de PAPEL/identidade (não só "tem sessão").
const STRONG_ROLE_MARKERS = [
  'requireRole',
  'defineRoute',          // carrega minRole/scope/platformAdmin no AuthSpec
  'resolveApiKey',
  'requirePlatformAdmin',
  'AUTOMATION_CRON_SECRET',
]
// Rotas mutantes que legitimamente NÃO usam papel (preencher com motivo).
const MUTATING_EXCEPTIONS = new Map<string, string>([
  // Convidado ainda NÃO tem papel na conta-alvo ao redimir; a autorização
  // vive no RPC redeem_invitation (SECURITY DEFINER, migration 019).
  ['invitations/[token]/redeem/route.ts', 'autz no RPC redeem_invitation; convidado sem papel ainda'],
])
const MUTATING_RE = /export\s+(async\s+function|const)\s+(POST|PATCH|PUT|DELETE)\b/

function isMutating(src: string): boolean {
  return MUTATING_RE.test(src)
}
```

E um novo `it(...)`:

```ts
it('toda rota MUTANTE tem guard de papel forte (não só auth.getUser)', () => {
  const offenders: string[] = []
  for (const file of findRouteFiles(API_DIR)) {
    const rel = relative(API_DIR, file)
    if (PUBLIC_ROUTES.has(rel) || MUTATING_EXCEPTIONS.has(rel)) continue
    const src = readFileSync(file, 'utf8')
    if (!isMutating(src)) continue
    const hasStrong = STRONG_ROLE_MARKERS.some((m) => src.includes(m))
    if (!hasStrong) offenders.push(rel)
  }
  expect(offenders, `rotas mutantes sem guard de papel:\n${offenders.join('\n')}`).toEqual([])
})
```

(Reusar os helpers/constantes já existentes no arquivo: `findRouteFiles`, `API_DIR`, `relative`, `readFileSync`, `PUBLIC_ROUTES`.)

- [ ] **Step 2: Rodar e confirmar que FALHA listando as rotas-alvo (RED)**

Run: `npx vitest run src/app/api/route-auth-guard.test.ts`
Expected: FAIL. A mensagem lista os offenders — devem aparecer: `whatsapp/config/route.ts`, `whatsapp/broadcast/route.ts`, `whatsapp/send/route.ts`, `whatsapp/react/route.ts`, `whatsapp/templates/submit/route.ts`, `whatsapp/templates/[id]/route.ts`, `whatsapp/templates/sync/route.ts`, `automations/route.ts`, `automations/[id]/route.ts`, `automations/[id]/duplicate/route.ts`, `automations/engine/route.ts`, `flows/route.ts`, `flows/[id]/route.ts`, `flows/[id]/activate/route.ts`, `account/presence/route.ts` (15 rotas). `invitations/[token]/redeem/route.ts` NÃO deve aparecer (está no `MUTATING_EXCEPTIONS`). Anotar a lista completa — é o escopo das tasks 2-5. Qualquer offender inesperado que seja legítimo (mutação sem papel por design) vai pro `MUTATING_EXCEPTIONS` com motivo, NÃO ignorado.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/route-auth-guard.test.ts
git commit -m "test(rbac): guardrail exige papel forte em rota mutante (RED da Fase 1a)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Guards do cluster WhatsApp Ops

**Files:**
- Modify: `src/app/api/whatsapp/config/route.ts` (POST `:166`, DELETE `:445` → admin)
- Modify: `src/app/api/whatsapp/broadcast/route.ts` (POST `:61` → admin)
- Modify: `src/app/api/whatsapp/send/route.ts` (POST `:6` → agent)
- Modify: `src/app/api/whatsapp/react/route.ts` (POST `:21` → agent)
- Modify: `src/app/api/whatsapp/media/[mediaId]/route.ts` (GET `:6` → membro ativo)

**Interfaces:**
- Consumes: `requireRole`, `toErrorResponse` de `@/lib/auth/account`; padrão canônico acima.
- Produces: rotas guardadas. Re-roda o guardrail da Task 1.

- [ ] **Step 1: `config/route.ts` — POST e DELETE com `requireRole('admin')`**

Em POST (`:166`) e DELETE (`:445`): trocar o bloco `auth.getUser()` (`:170-173`/`:449-452`) + `resolveAccountId` (`:179`/`:458`) por `const ctx = await requireRole('admin')` e usar `ctx.supabase`/`ctx.accountId`. **GET (`:63`) fica como está** (leitura, qualquer membro — opcionalmente `requireActiveAccount`). **MANTER** o `supabaseAdmin()` do unique-check (`:40`, `:217-222`) — é o único service role legítimo. Os writes (`:374`,`:391`,`:466`) continuam no client de sessão (agora `ctx.supabase`).

- [ ] **Step 2: `broadcast/route.ts` — POST com `requireRole('admin')`**

Trocar `auth.getUser()` (`:65-68`) + lookup de `profiles` (`:86-91`) por `const ctx = await requireRole('admin')`. Manter o `checkRateLimit('broadcast:'+ctx.userId, ...)` (`:77`). A rota não escreve em DB — o guard é a única barreira contra disparo em massa (custo/ban). Usar `ctx.supabase`/`ctx.accountId` nos SELECTs de config/template.

- [ ] **Step 3: `send/route.ts` e `react/route.ts` — `requireRole('agent')`**

`send` POST (`:6`): trocar `auth.getUser()` (`:10-13`) + lookup `profiles` (`:29-34`) por `const ctx = await requireRole('agent')`; passar `ctx.supabase`/`ctx.accountId` pro `sendMessageToConversation` (`:51`). Manter `checkRateLimit('send:'+ctx.userId,...)`. **Não** mexer no `supabaseAdmin()` interno do helper (`send-message.ts:326`).
`react` POST (`:21`): trocar `auth.getUser()` (`:25-28`) + lookup (`:41-46`) por `const ctx = await requireRole('agent')`; usar `ctx.userId` no `actor_id` (`:149`/`:170`) e `ctx.accountId` na validação de conversa (`:87-92`).

- [ ] **Step 4: `media/[mediaId]/route.ts` — `requireActiveAccount()`**

GET (`:6`): trocar `auth.getUser()` (`:22-25`) + lookup (`:38-43`) por `const ctx = await requireActiveAccount()` (leitura; qualquer membro ativo, sem papel). Importar `requireActiveAccount` de `@/lib/auth/account`. Usar `ctx.supabase`/`ctx.accountId`. (Isto fecha o gap de status sem exigir papel.)

- [ ] **Step 5: typecheck + guardrail**

Run: `npm run typecheck`
Expected: sem erros.
Run: `npx vitest run src/app/api/route-auth-guard.test.ts`
Expected: os 5 arquivos do cluster saem da lista de offenders (sobram só os das tasks 3-5).

- [ ] **Step 6: Commit**

```bash
git add src/app/api/whatsapp/config/route.ts src/app/api/whatsapp/broadcast/route.ts src/app/api/whatsapp/send/route.ts src/app/api/whatsapp/react/route.ts "src/app/api/whatsapp/media/[mediaId]/route.ts"
git commit -m "feat(rbac): guards de papel no cluster WhatsApp (config/broadcast=admin, send/react=agent, media=membro)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Guards do cluster Templates (admin+)

**Files:**
- Modify: `src/app/api/whatsapp/templates/submit/route.ts` (POST `:89`)
- Modify: `src/app/api/whatsapp/templates/[id]/route.ts` (PATCH `:47`, DELETE `:233`)
- Modify: `src/app/api/whatsapp/templates/sync/route.ts` (POST `:125`)

**Interfaces:**
- Consumes: padrão canônico; `requireRole('admin')`.
- Produces: 3 rotas guardadas. Re-roda o guardrail.

- [ ] **Step 1: Aplicar `requireRole('admin')` nas 3 rotas**

Em cada handler mutante, trocar `supabase.auth.getUser()` + o lookup inline de `profiles.account_id` (`submit:` resolve em `:107`; `[id]:` em `:96`/`:273`; `sync:` em `:140-145`) por `const ctx = await requireRole('admin')`, usando `ctx.supabase`/`ctx.accountId`. Todas já usam client de sessão — o write continua sob RLS. **Atenção:** os writes do `[id]` filtram só por `.eq('id', id)` (`:180`,`:203`,`:306-309`) — manter o lookup prévio que valida `account_id` (`:96`/`:273`), agora via `ctx.supabase`/`ctx.accountId`; o guard de papel não substitui essa validação de tenant.

- [ ] **Step 2: typecheck + guardrail**

Run: `npm run typecheck`
Expected: sem erros.
Run: `npx vitest run src/app/api/route-auth-guard.test.ts`
Expected: os 3 arquivos de templates saem dos offenders.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/whatsapp/templates/submit/route.ts "src/app/api/whatsapp/templates/[id]/route.ts" src/app/api/whatsapp/templates/sync/route.ts
git commit -m "feat(rbac): templates (submit/editar/deletar/sync) exigem admin

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Guards do cluster Automations + Flows (admin+, ALÉM do ownership)

**Files:**
- Modify: `src/app/api/automations/route.ts` (POST `:29`)
- Modify: `src/app/api/automations/[id]/route.ts` (PATCH `:45`, DELETE `:123`)
- Modify: `src/app/api/automations/[id]/duplicate/route.ts` (POST `:5`)
- Modify: `src/app/api/flows/route.ts` (POST `:47`)
- Modify: `src/app/api/flows/[id]/route.ts` (PUT `:89`, DELETE `:178`)
- Modify: `src/app/api/flows/[id]/activate/route.ts` (POST `:20`)
- Modify: `src/app/api/automations/engine/route.ts` (POST `:11` → admin)

**Interfaces:**
- Consumes: `requireRole`, `toErrorResponse`.
- Produces: rotas guardadas. **Regra inviolável: o guard SOMA, não substitui.**

> **`automations/engine/route.ts`** (descoberto no RED da Task 1): POST que dispara a engine de automações da conta ("trigger manual pra testes/integrações externas"). Hoje usa `requireActiveAccount()` (`:14`, qualquer membro ativo). Disparar a engine não é operação de colaborador — trocar por `const ctx = await requireRole('admin')` e usar `ctx.accountId`. Mesmo padrão dos outros; sem ownership por-recurso aqui.

- [ ] **Step 1: Inserir `requireRole('admin')` como primeira instrução de cada handler MUTANTE**

Para cada método mutante listado, adicionar `await requireRole('admin')` (dentro de `try { ... } catch (err) { return toErrorResponse(err) }`) **ANTES** de qualquer lógica existente, e **MANTER intactos** os helpers e checagens de ownership atuais (`requireUser` local em `automations/[id]/route.ts:14` e `flows/route.ts:16`; `requireOwnership` em `flows/[id]/route.ts:20`; os `.eq('user_id', user.id)` e a comparação `existing.user_id !== user.id`). Os writes continuam via `supabaseAdmin()` — **não trocar o client**. O GET de cada arquivo NÃO muda.
- `automations/route.ts` POST (`:29`), `automations/[id]/route.ts` PATCH (`:45`)/DELETE (`:123`), `automations/[id]/duplicate/route.ts` POST (`:5`), `automations/engine/route.ts` POST (`:11`), `flows/route.ts` POST (`:47`), `flows/[id]/route.ts` PUT (`:89`)/DELETE (`:178`), `flows/[id]/activate/route.ts` POST (`:20`).
- Onde o handler hoje faz `auth.getUser()` inline puro (`automations/route.ts`, `duplicate`, `activate`), o `requireRole('admin')` pode substituir o `auth.getUser()` (ambos resolvem o user) — mas a checagem de ownership por `user_id`/RLS que vem depois permanece. `automations/engine/route.ts` hoje usa `requireActiveAccount()` — trocar por `requireRole('admin')` (sem ownership por-recurso ali).

- [ ] **Step 2: typecheck + guardrail**

Run: `npm run typecheck`
Expected: sem erros.
Run: `npx vitest run src/app/api/route-auth-guard.test.ts`
Expected: os 7 arquivos de automations/flows (incl. `automations/engine/route.ts`) saem dos offenders. Sobra só `account/presence/route.ts` (Task 5).

- [ ] **Step 3: Commit**

```bash
git add src/app/api/automations/route.ts "src/app/api/automations/[id]/route.ts" "src/app/api/automations/[id]/duplicate/route.ts" src/app/api/automations/engine/route.ts src/app/api/flows/route.ts "src/app/api/flows/[id]/route.ts" "src/app/api/flows/[id]/activate/route.ts"
git commit -m "feat(rbac): automations e flows exigem admin (guard somado ao ownership, sem IDOR)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `presence` — papel agent + rejeitar `in_pool`

**Files:**
- Modify: `src/app/api/account/presence/route.ts` (PUT `:36`, POST `:76`)

**Interfaces:**
- Consumes: `requireRole`.
- Produces: rota guardada (último offender do guardrail).

- [ ] **Step 1: Trocar `requireActiveAccount()` por `requireRole('agent')` em PUT e POST**

PUT (`:38`) e POST (`:78`) hoje usam `requireActiveAccount()` (sem papel). Trocar por `requireRole('agent')` — presença é self-service do colaborador; viewer não tem presença. GET (`:11`) pode ficar em `requireActiveAccount` (leitura).

- [ ] **Step 2: PUT deve IGNORAR `body.in_pool`**

Remover a linha que aplica `in_pool` ao patch (`:52`: `if (typeof body.in_pool === 'boolean') patch.in_pool = ...`). A gestão de pool é exclusiva do admin via `lead-autoassign` (`requireRole('admin')`, `lead-autoassign/route.ts:121`). O self-service só altera `is_available` (`:51`). Adicionar comentário em PT explicando que `in_pool` é admin-only.

- [ ] **Step 3: typecheck + guardrail VERDE**

Run: `npm run typecheck`
Expected: sem erros.
Run: `npx vitest run src/app/api/route-auth-guard.test.ts`
Expected: **PASS** — zero offenders (todas as rotas mutantes agora têm papel forte).

- [ ] **Step 4: Commit**

```bash
git add src/app/api/account/presence/route.ts
git commit -m "fix(rbac): presence exige agent e ignora in_pool (pool é admin-only)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Migration 032 — RLS de DELETE admin+ (contacts/deals) + consistência

**Files:**
- Create: `supabase/migrations/032_rbac_delete_and_consistency.sql`

**Interfaces:**
- Consumes: policies existentes da `017` (texto exato nas linhas citadas).
- Produces: policies de DELETE admin+ em `contacts`/`deals`; write policies admin+ em broadcasts/automations/flows.

- [ ] **Step 1: Escrever a migration (idempotente)**

`contacts`/`deals` são escritos DIRETO do browser (sem rota) — a RLS é a ÚNICA defesa, e hoje o DELETE é `agent` (`017:339`,`:395`). Subir DELETE pra admin+. E alinhar broadcasts/automations/flows (hoje `agent`, `017:400-402`/`:407-409`/`:423-425`) pra admin+ por consistência com a matriz (mesmo que os writes dessas rotas hoje passem por service role — é seguro barato pra futuros caminhos por sessão / scopes /v1).

```sql
-- ============================================================
-- 032 — RBAC: DELETE admin+ em contacts/deals + consistência
--        de broadcasts/automations/flows (agent -> admin)
--
-- contacts/deals são escritos direto do browser (client de sessão),
-- sem rota de app — a RLS é a única defesa. A matriz põe DELETE em
-- admin+, mas a 017 deixou em agent. Aqui separamos o DELETE.
-- broadcasts/automations/flows sobem pra admin+ por consistência com
-- a matriz (guard de app é a barreira efetiva hoje, mas a RLS passa a
-- concordar — defesa em profundidade pra caminhos futuros).
-- ============================================================

-- contacts: DELETE agora exige admin (INSERT/UPDATE seguem agent)
DROP POLICY IF EXISTS contacts_delete ON contacts;
CREATE POLICY contacts_delete ON contacts FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- deals: idem
DROP POLICY IF EXISTS deals_delete ON deals;
CREATE POLICY deals_delete ON deals FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- broadcasts: write admin+ (consistência)
DROP POLICY IF EXISTS broadcasts_insert ON broadcasts;
CREATE POLICY broadcasts_insert ON broadcasts FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS broadcasts_update ON broadcasts;
CREATE POLICY broadcasts_update ON broadcasts FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS broadcasts_delete ON broadcasts;
CREATE POLICY broadcasts_delete ON broadcasts FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- automations: write admin+ (consistência)
DROP POLICY IF EXISTS automations_insert ON automations;
CREATE POLICY automations_insert ON automations FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS automations_update ON automations;
CREATE POLICY automations_update ON automations FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS automations_delete ON automations;
CREATE POLICY automations_delete ON automations FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- flows: write admin+ (consistência)
DROP POLICY IF EXISTS flows_insert ON flows;
CREATE POLICY flows_insert ON flows FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS flows_update ON flows;
CREATE POLICY flows_update ON flows FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS flows_delete ON flows;
CREATE POLICY flows_delete ON flows FOR DELETE
  USING (is_account_member(account_id, 'admin'));
```

> **Atenção:** confirmar os nomes EXATOS das policies na `017` antes de dropar (o `DROP ... IF EXISTS` é seguro, mas o nome precisa bater pra recriar a mesma). A ficha cita o padrão `<tabela>_<op>`. Se algum nome divergir, ajustar o `DROP`/`CREATE`.

- [ ] **Step 2: Aplicar manualmente (Iago, SQL Editor)** — colar e rodar no projeto dedicado. Esperado: `Success`.

- [ ] **Step 3: Verificar (GREEN, SQL Editor)** — simular um `agent` tentando deletar contato:

```sql
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"<USER_ID_DE_UM_AGENT>","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DELETE FROM public.contacts WHERE id = (SELECT id FROM public.contacts WHERE account_id = (SELECT account_id FROM public.profiles WHERE user_id = '<USER_ID_DE_UM_AGENT>') LIMIT 1);
ROLLBACK;
```
Esperado: `DELETE 0` (RLS de DELETE admin+ não enxerga a linha pro agent). Trocar `<USER_ID_DE_UM_AGENT>` por um profile com `account_role='agent'`. Repetir com um `admin` → `DELETE 1`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/032_rbac_delete_and_consistency.sql
git commit -m "feat(rbac): RLS DELETE admin+ em contacts/deals + write admin+ em broadcasts/automations/flows

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Migration 033 + código — chave de template por conta (`onConflict`)

**Files:**
- Create: `supabase/migrations/033_message_templates_account_unique.sql`
- Modify: `src/app/api/whatsapp/templates/submit/route.ts` (`onConflict` `:70`)
- Modify: `src/lib/whatsapp/send-message.ts` (lookup `:192-199`)
- Modify: `src/app/api/whatsapp/templates/sync/route.ts` (lookup `:257-263`)

**Interfaces:**
- Consumes: índice único legado `message_templates_user_name_language_key` (`014:190-191`); guard de duplicatas estilo `014:155-188`.
- Produces: unicidade por `(account_id, name, language)`; lookups de envio robustos a duplicata residual.

- [ ] **Step 1: Migration — trocar índice único user→account (com guard de duplicatas)**

```sql
-- ============================================================
-- 033 — Template é único por CONTA, não por usuário
--
-- Habilitar templates como admin+ permite vários admins na mesma
-- conta. O índice único legado é (user_id, name, language) (014:190),
-- mas o ENVIO resolve por (account_id, name, language). Dois admins
-- com o mesmo (name, language) criavam linhas distintas e quebravam o
-- disparo (PostgREST "multiple rows"). Aqui a unicidade passa a ser
-- por (account_id, name, language).
-- ============================================================

-- 1. Aborta se já houver duplicata (account_id, name, language) — limpar manual e re-rodar.
DO $$
DECLARE v_dups text;
BEGIN
  SELECT string_agg(format('%s / %s / %s (%s linhas)', account_id, name, COALESCE(language,'(null)'), c), E'\n  ')
  INTO v_dups
  FROM (
    SELECT account_id, name, language, count(*) AS c
    FROM message_templates
    GROUP BY account_id, name, language
    HAVING count(*) > 1
  ) d;
  IF v_dups IS NOT NULL THEN
    RAISE EXCEPTION E'Não dá pra criar UNIQUE(account_id, name, language) — duplicatas:\n  %\nDelete as linhas indesejadas e re-rode.', v_dups;
  END IF;
END $$;

-- 2. Troca o índice.
DROP INDEX IF EXISTS message_templates_user_name_language_key;
CREATE UNIQUE INDEX IF NOT EXISTS message_templates_account_name_language_key
  ON message_templates (account_id, name, language);
```

- [ ] **Step 2: `submit/route.ts` — `onConflict` por conta**

Trocar `.upsert(row, { onConflict: 'user_id,name,language' })` (`:70`) por `.upsert(row, { onConflict: 'account_id,name,language' })`. `user_id` segue gravado como auditoria (autor), só deixa de ser chave.

- [ ] **Step 3: Lookups de envio robustos a duplicata residual**

Em `send-message.ts` (`:192-199`) e `sync/route.ts` (`:257-263`), os SELECT por `(account_id, name, language)` usam `.maybeSingle()` sem `.limit(1)`. Adicionar `.order('last_submitted_at', { ascending: false, nullsFirst: false }).limit(1)` antes do `.maybeSingle()` em ambos, pra um eventual estado duplicado residual não derrubar o envio (pega o mais recente). (Defesa de cinto; o índice único já previne o caso novo.)

- [ ] **Step 4: Aplicar migration (Iago, SQL Editor)** — colar/rodar. Se abortar por duplicata, listar/limpar e re-rodar. Esperado final: `Success`.

- [ ] **Step 5: typecheck + commit**

Run: `npm run typecheck`
Expected: sem erros.

```bash
git add supabase/migrations/033_message_templates_account_unique.sql src/app/api/whatsapp/templates/submit/route.ts src/lib/whatsapp/send-message.ts src/app/api/whatsapp/templates/sync/route.ts
git commit -m "fix(rbac): template único por conta (account_id,name,language) + lookup de envio robusto

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage (Fase 1 do `2026-06-26-rbac-crm-design.md`, parte backend):**
- Guards de rota (templates, config, broadcast, automations, flows, send/react/media) → Tasks 2-4. ✅
- `presence` rejeita `in_pool` → Task 5. ✅
- DELETE contacts/deals admin+ → Task 6. ✅
- `ALTER POLICY` broadcasts/automations/flows admin+ (consistência) → Task 6. ✅
- Migration `onConflict` de templates → Task 7. ✅
- CI guardrail exige papel em rota mutante → Task 1. ✅
- Gap de status (pending/suspended) → fechado de brinde por `requireRole`/`requireActiveAccount` (Tasks 2-5). ✅
- Predicados novos + gates de UI → **fora de escopo (Fase 1b)**, registrado nas Global Constraints. ✅
- Migração de automations/flows pro client de sessão → **fora de escopo** (decisão do Iago: deferida). ✅

**2. Placeholder scan:** Sem TBD/TODO. SQL e diffs concretos. Únicos `<...>` são valores de runtime que o Iago preenche na verificação manual (USER_ID), explicitados como tal. ✅

**3. Type/símbolo consistency:** `requireRole`/`requireActiveAccount`/`toErrorResponse` de `@/lib/auth/account` (assinaturas conferidas na ficha plumbing). `ctx.supabase`/`ctx.accountId`/`ctx.userId`/`ctx.role` = campos reais de `AccountContext`. Markers do guardrail batem com os existentes no teste. ✅

**Riscos registrados:** (a) IDOR em automations/flows se o guard substituir o ownership — mitigado por instrução explícita "soma, não substitui" (Task 4). (b) Nomes de policy na 017 podem divergir do padrão — Task 6 manda confirmar antes de dropar. (c) Migration 033 pode achar duplicatas pré-existentes — aborta com mensagem clara pra limpeza manual.

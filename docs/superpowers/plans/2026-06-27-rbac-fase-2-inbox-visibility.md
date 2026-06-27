# RBAC Fase 2 — Visibilidade da inbox (app-layer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Colaborador (`agent`) vê na inbox só as conversas atribuídas a ele (`assigned_agent_id = seu user id`); owner/admin/viewer continuam vendo todas.

**Architecture:** Filtro **app-layer** (não RLS) — decisão do Iago: é privacidade intra-empresa, não fronteira de segurança. Um predicado puro único (`agentSeesOnlyAssigned` / `conversationVisibleTo`) governa: (1) a query de listagem da inbox, (2) o filtro em memória (cobre realtime), (3) o badge de não-lidas. Sem migration, sem mexer em RLS/dashboard/autoassign.

**Tech Stack:** Next.js client components, React, Supabase JS client, TypeScript, Vitest.

## Global Constraints

- Comentários em **português**.
- **Nunca `git add -A`**. PRs → `iv-automacao/crm-vantage`. Branch: `feat/rbac-fase-2-inbox-visibility`.
- **Escopo = SÓ conversas da inbox.** NÃO escopar contatos/deals/dashboard (decisão: começar leve). NÃO mexer em RLS nem migrations.
- **Só o papel `agent` é escopado.** `owner`/`admin`/`viewer` veem todas (viewer = auditoria, vê tudo). Predicado: `agentSeesOnlyAssigned(role) = role === 'agent'`.
- **Fonte do user id:** `useAuth()` expõe `user` (`user.id` = auth.uid()) e `accountRole`. `conversations.assigned_agent_id` referencia o auth user id (`001:145`) — comparar com `user.id`.
- **Lint baseline = 3 erros pré-existentes** (no-explicit-any) — não adicionar erro novo.
- **Limitação aceita e documentada:** sendo app-layer (não RLS), um agent ainda consegue abrir a conversa de um colega por **URL direta** (`/inbox?c=<id>`) ou via API. Isso é privacidade da listagem, não fronteira dura — coerente com a decisão. Se um dia precisar de fronteira real, é um passo RLS separado.
- **Autoassign é imune** (round-robin/webhook/cron/engine usam service role) — confirmado no levantamento; nada a fazer lá.

---

### Task 1: Predicado puro de visibilidade (+ teste)

**Files:**
- Create: `src/lib/leads/visibility.ts`
- Test: `src/lib/leads/visibility.test.ts`

**Interfaces:**
- Produces: `agentSeesOnlyAssigned(role)` e `conversationVisibleTo(conv, role, userId)`. Consumidos pelas Tasks 2 e 3.

- [ ] **Step 1: Escrever o teste (RED)**

```ts
// src/lib/leads/visibility.test.ts
import { describe, it, expect } from 'vitest'
import { agentSeesOnlyAssigned, conversationVisibleTo } from './visibility'

describe('agentSeesOnlyAssigned', () => {
  it('só agent é escopado', () => {
    expect(agentSeesOnlyAssigned('agent')).toBe(true)
    expect(agentSeesOnlyAssigned('admin')).toBe(false)
    expect(agentSeesOnlyAssigned('owner')).toBe(false)
    expect(agentSeesOnlyAssigned('viewer')).toBe(false)
    expect(agentSeesOnlyAssigned(null)).toBe(false)
  })
})

describe('conversationVisibleTo', () => {
  const mine = { assigned_agent_id: 'u1' }
  const others = { assigned_agent_id: 'u2' }
  const orphan = { assigned_agent_id: null }
  it('admin/owner/viewer veem todas', () => {
    for (const r of ['admin', 'owner', 'viewer'] as const) {
      expect(conversationVisibleTo(others, r, 'u1')).toBe(true)
      expect(conversationVisibleTo(orphan, r, 'u1')).toBe(true)
    }
  })
  it('agent vê só as atribuídas a ele', () => {
    expect(conversationVisibleTo(mine, 'agent', 'u1')).toBe(true)
    expect(conversationVisibleTo(others, 'agent', 'u1')).toBe(false)
    expect(conversationVisibleTo(orphan, 'agent', 'u1')).toBe(false)
  })
  it('fail-closed: agent sem userId não vê nada escopável', () => {
    expect(conversationVisibleTo(mine, 'agent', null)).toBe(false)
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/lib/leads/visibility.test.ts`
Expected: FAIL ("Cannot find module './visibility'").

- [ ] **Step 3: Implementar**

```ts
// src/lib/leads/visibility.ts
import type { AccountRole } from '@/lib/auth/roles'

/** Só o colaborador (agent) é escopado aos próprios leads. owner/admin/viewer
 *  veem todas as conversas (viewer = auditoria). role nulo (carregando) = não escopa
 *  aqui; quem decide o fail-closed é conversationVisibleTo. */
export function agentSeesOnlyAssigned(role: AccountRole | null): boolean {
  return role === 'agent'
}

/** Uma conversa é visível pra alguém? Quem não é agent vê todas. O agent só vê
 *  as atribuídas a ele (assigned_agent_id === seu userId). fail-closed: agent
 *  sem userId resolvido não vê conversa escopável. */
export function conversationVisibleTo(
  conv: { assigned_agent_id?: string | null },
  role: AccountRole | null,
  userId: string | null | undefined,
): boolean {
  if (!agentSeesOnlyAssigned(role)) return true
  return !!userId && conv.assigned_agent_id === userId
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/lib/leads/visibility.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/leads/visibility.ts src/lib/leads/visibility.test.ts
git commit -m "feat(rbac): predicado puro de visibilidade da inbox (agent só vê leads atribuídos)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Escopar a lista da inbox

**Files:**
- Modify: `src/components/inbox/conversation-list.tsx` (fetch `:90-93`, `filtered` memo `:121`)

**Interfaces:**
- Consumes: `agentSeesOnlyAssigned`, `conversationVisibleTo` (Task 1); `useAuth()` (`user`, `accountRole`).

- [ ] **Step 1: Filtrar a query de fetch pro agent**

Em `conversation-list.tsx`, importar `useAuth` (`@/hooks/use-auth`) e os predicados. No componente: `const { user, accountRole } = useAuth()`. Na query (`:90-93`), aplicar o `.eq` condicional ANTES de await:

```ts
let query = supabase
  .from("conversations")
  .select("*, contact:contacts(*)")
  .order("last_message_at", { ascending: false });
// Fase 2: colaborador só vê as conversas atribuídas a ele.
if (agentSeesOnlyAssigned(accountRole) && user) {
  query = query.eq("assigned_agent_id", user.id);
}
const { data, error } = await query;
```

Adicionar `accountRole`/`user?.id` ao array de deps do `useEffect` da fetch (junto de `resyncToken`) pra refazer a fetch quando o papel/usuário resolver (evita carregar tudo antes do perfil chegar).

- [ ] **Step 2: Filtrar o `filtered` memo (defesa p/ realtime)**

No `filtered` useMemo (`:121`), começar o `result` já filtrado por visibilidade (cobre conversas que o realtime do parent injete em `conversations`):

```ts
const filtered = useMemo(() => {
  let result = conversations.filter((c) =>
    conversationVisibleTo(c, accountRole, user?.id),
  );
  // ... resto do filtro existente (unread/status) opera sobre `result` ...
}, [conversations, filter, /* ...existentes..., */ accountRole, user?.id]);
```

(Incluir `accountRole` e `user?.id` nas deps do memo.)

- [ ] **Step 3: typecheck + lint + build-check**

Run: `npm run typecheck` → limpo.
Run: `npm run lint` → "errors" continua 3 (baseline).
Run: `npx vitest run` → tudo verde.

- [ ] **Step 4: Commit**

```bash
git add src/components/inbox/conversation-list.tsx
git commit -m "feat(rbac): inbox lista só as conversas atribuídas pro colaborador (app-layer)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Escopar o badge de não-lidas

**Files:**
- Modify: `src/hooks/use-total-unread.ts` (query inicial `:29-31`, realtime `:50-62`)

**Interfaces:**
- Consumes: `agentSeesOnlyAssigned`, `conversationVisibleTo` (Task 1); `useAuth()`.

- [ ] **Step 1: Escopar a contagem inicial + o realtime**

Em `use-total-unread.ts`: importar `useAuth` + os predicados. `const { user, accountRole } = useAuth()`. Corrigir o comentário enganoso de `:26-27` (a RLS escopa por CONTA, não por usuário). Na query inicial (`:29-31`), adicionar `.eq("assigned_agent_id", user.id)` quando `agentSeesOnlyAssigned(accountRole) && user`. No handler de realtime (`:50-62`), antes de `map.set(row.id, ...)` pra INSERT/UPDATE, ignorar a linha se `!conversationVisibleTo(row, accountRole, user?.id)` (não contar conversa que o agent não enxerga). DELETE segue removendo do map normalmente.

Adicionar `user?.id` e `accountRole` às deps do `useEffect` (a subscription/contagem deve refazer quando resolverem). Garantir cleanup do canal anterior ao refazer.

- [ ] **Step 2: typecheck + lint**

Run: `npm run typecheck` → limpo.
Run: `npm run lint` → "errors" continua 3 (baseline).
Run: `npx vitest run` → verde.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/use-total-unread.ts
git commit -m "feat(rbac): badge de não-lidas conta só as conversas do colaborador

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:** Fase 2 do spec = "agent vê só os leads dele (conversations.assigned_agent_id)". Esta versão (decisão do Iago) faz isso **app-layer, só na inbox**: lista (Task 2) + badge (Task 3), com predicado único testado (Task 1). Owner/admin/viewer veem tudo. Contatos/deals/dashboard NÃO escopados (decisão consciente de começar leve) — registrado nas constraints. ✅

**2. Placeholder scan:** Sem TBD. Código completo. `file:line` do levantamento — implementer deve LER os arquivos antes de editar (linhas podem variar) e localizar pelos trechos descritos.

**3. Consistência:** o mesmo predicado `conversationVisibleTo` governa lista, realtime e badge — fonte única, sem regra de papel espalhada. `assigned_agent_id` comparado a `user.id` (auth uid), que é o que o autoassign grava.

**Riscos:** (a) deps de `useEffect`/`useMemo` — incluir `accountRole`/`user?.id` pra não fixar o estado pré-perfil (senão o agent carrega tudo antes do papel resolver). (b) Limitação app-layer (URL direta) documentada e aceita. (c) Realtime do parent (inbox/page) pode injetar conversa não-atribuída em `conversations`; o filtro do `filtered` memo (Task 2) é a rede que garante que não apareça.

# RBAC Fase 1b — Gates de UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refletir a matriz de papéis na UI — colaborador (agent) e viewer não veem (nav) nem clicam (botões) nas ações que a Fase 1a tornou admin-only, evitando 403 na cara.

**Architecture:** Abordagem **híbrida** (decisão do Iago): (1) **esconder** da sidebar as áreas que só servem ao admin (Disparos, Automações, Fluxos, Configurações); (2) **desabilitar + tooltip** ("Requer admin") os botões soltos dentro de telas que o agent usa (deletar contato/deal). Reusa a plumbing existente: hook `useCan(action)` / `useAuth()` (fail-closed) + componente `GatedButton` (desabilita + tooltip via wrapper span). **Sem predicados novos** — `edit-settings` (admin+) e `send-messages` (agent+) cobrem tudo.

**Tech Stack:** Next.js App Router (client components), React, TypeScript, Vitest.

## Global Constraints

- Comentários em **português**.
- **Nunca `git add -A`** — só os arquivos da task. PRs → `iv-automacao/crm-vantage`. Branch: `feat/rbac-fase-1b-ui-gates`.
- **Reusar gates existentes, sem criar predicado novo:** admin+ → `useCan('edit-settings')` (ou `useAuth().canEditSettings`); agent+ → `useCan('send-messages')`. (Desvio consciente do spec, que sugeria `canBroadcast`/etc. — seriam duplicatas de `canEditSettings`. DRY.)
- **`GatedButton`** (`src/components/ui/gated-button.tsx`): passar `canAct={...}` + `gateReason="Requer admin"` (ou similar em PT) → renderiza desabilitado com tooltip. Usar para botões soltos.
- **Reconciliação CRÍTICA (corrigir gates errados, não só adicionar):** a Fase 1a tornou **broadcast, automações e flows = admin+** no backend. Vários controles de UI desses estão hoje gateados em `send-messages` (agent+) — nível ERRADO. Esta fase **sobe esses para `edit-settings` (admin+)**. Mapa de papel da UI = espelho do backend da Fase 1a:
  - **admin+ (`edit-settings`):** broadcast (criar/enviar/rascunho/excluir), templates (novo/sync/editar/reenviar/excluir), automações (criar/editar/toggle/duplicar/excluir/salvar), flows (criar/editar/ativar/salvar/excluir), config WhatsApp (salvar/reset), estrutura (tag/pipeline/stage/campo criar/editar/excluir), **deletar contato (single+bulk)**, **deletar deal**, painéis admin (membros/api-keys/webhooks/CAPI/lead-autoassign).
  - **agent+ (`send-messages`):** criar/editar contato, mover deal, enviar/reagir mensagem (a maioria já correta — NÃO mexer).
  - **ler:** todos.
- **Hide vs disable:** nav de área admin → **esconder** (sidebar). Botão solto em tela de agent → **desabilitar + tooltip** (`GatedButton`).
- Cada task: `npm run typecheck` + `npm run lint` limpos antes do commit. Verificação visual real (logar como agent) é manual do Iago no fim.
- **Fora de escopo:** Fase 2 (visibilidade do agent por `assigned_agent_id`).

---

### Task 1: Filtrar a sidebar por papel (esconder áreas admin)

**Files:**
- Modify: `src/components/layout/sidebar.tsx` (navItems `:89-100`, render `:206`)
- Create: `src/components/layout/nav-visibility.ts` (lógica pura testável)
- Test: `src/components/layout/nav-visibility.test.ts`

**Interfaces:**
- Produces: `visibleNavItems(items, role)` — função pura que filtra os itens por papel. Consumida pelo sidebar.

- [ ] **Step 1: Escrever o teste da lógica pura (RED)**

```ts
// src/components/layout/nav-visibility.test.ts
import { describe, it, expect } from 'vitest'
import { visibleNavItems, type NavGate } from './nav-visibility'

const ITEMS: { href: string; minRole?: NavGate }[] = [
  { href: '/dashboard' }, { href: '/inbox' }, { href: '/contacts' }, { href: '/pipelines' },
  { href: '/broadcasts', minRole: 'admin' }, { href: '/automations', minRole: 'admin' },
  { href: '/flows', minRole: 'admin' }, { href: '/settings', minRole: 'admin' },
]

describe('visibleNavItems', () => {
  it('admin vê tudo', () => {
    expect(visibleNavItems(ITEMS, 'admin').map((i) => i.href)).toContain('/broadcasts')
    expect(visibleNavItems(ITEMS, 'owner').length).toBe(ITEMS.length)
  })
  it('agent NÃO vê broadcasts/automations/flows/settings', () => {
    const hrefs = visibleNavItems(ITEMS, 'agent').map((i) => i.href)
    expect(hrefs).toEqual(['/dashboard', '/inbox', '/contacts', '/pipelines'])
  })
  it('viewer idem agent (só itens sem minRole)', () => {
    const hrefs = visibleNavItems(ITEMS, 'viewer').map((i) => i.href)
    expect(hrefs).not.toContain('/settings')
  })
  it('role nulo (carregando) esconde os gated (fail-closed)', () => {
    const hrefs = visibleNavItems(ITEMS, null).map((i) => i.href)
    expect(hrefs).not.toContain('/broadcasts')
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/components/layout/nav-visibility.test.ts`
Expected: FAIL ("Cannot find module './nav-visibility'").

- [ ] **Step 3: Implementar a função pura**

```ts
// src/components/layout/nav-visibility.ts
import { hasMinRole, type AccountRole } from '@/lib/auth/roles'

/** Papel mínimo pra um item de nav aparecer. */
export type NavGate = AccountRole

/** Filtra itens de nav por papel. Itens sem `minRole` aparecem pra todos.
 *  `role` nulo (perfil carregando / fora do provider) = fail-closed:
 *  esconde qualquer item gated. */
export function visibleNavItems<T extends { minRole?: NavGate }>(
  items: readonly T[],
  role: AccountRole | null,
): T[] {
  return items.filter((item) => {
    if (!item.minRole) return true
    return role != null && hasMinRole(role, item.minRole)
  })
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/components/layout/nav-visibility.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Plugar no sidebar**

Em `src/components/layout/sidebar.tsx`: (a) adicionar `minRole?: AccountRole` ao tipo `NavItem` e marcar `{ href: '/broadcasts', ..., minRole: 'admin' }`, idem `/automations`, `/flows`, `/settings` (`:94-100`). (b) Importar `visibleNavItems` e, no render (`:206`), trocar `navItems.map(...)` por `visibleNavItems(navItems, accountRole).map(...)` (já há `accountRole` de `useAuth()` em `:111`). O botão/atalho de "Configurações" no rodapé (`:388-391`) também deve sumir pra não-admin — envolver em `{canEditSettings && (...)}` (canEditSettings vem do mesmo `useAuth()`).

- [ ] **Step 6: typecheck + lint + commit**

Run: `npm run typecheck && npm run lint`
Expected: limpos.

```bash
git add src/components/layout/sidebar.tsx src/components/layout/nav-visibility.ts src/components/layout/nav-visibility.test.ts
git commit -m "feat(rbac-ui): esconde nav admin-only (disparos/automações/fluxos/config) de agent/viewer

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Gates de Broadcasts (corrigir agent+→admin+ e adicionar faltantes)

**Files:**
- Modify: `src/app/(dashboard)/broadcasts/page.tsx` (botões "Novo disparo" `:187,:205`)
- Modify: `src/app/(dashboard)/broadcasts/new/page.tsx` (submit `:184,:218`; entry `:23`)
- Modify: `src/app/(dashboard)/broadcasts/[id]/page.tsx` (excluir `:332-347`)

**Interfaces:**
- Consumes: `useCan('edit-settings')` (admin+), `GatedButton`.

- [ ] **Step 1: Corrigir os botões "Novo disparo" (list page)**

Em `broadcasts/page.tsx:187,:205`: os botões hoje usam `useCan('send-messages')` (agent+) — **trocar para `useCan('edit-settings')`** (broadcast é admin+ na Fase 1a). Manter o `GatedButton` com `gateReason="Apenas administradores podem disparar campanhas"`.

- [ ] **Step 2: Gate no wizard de criação**

Em `broadcasts/new/page.tsx`: os botões "Enviar disparo" e "Salvar como rascunho" (`:184,:218`) estão SEM gate → envolver em `GatedButton canAct={canEditSettings}` (obter `const canEditSettings = useCan('edit-settings')`). E no topo da página (`:23`), se `!canEditSettings`, mostrar um aviso "Apenas administradores podem criar disparos" e não renderizar o wizard (ou redirecionar pra `/broadcasts`). Como a nav já esconde a área de agent (Task 1), isto é defesa adicional pra acesso por URL direta.

- [ ] **Step 3: Gate no botão Excluir (detail)**

Em `broadcasts/[id]/page.tsx:332-347`: o "Excluir" está sem gate → `GatedButton canAct={useCan('edit-settings')} gateReason="Apenas administradores podem excluir disparos"`.

- [ ] **Step 4: typecheck + lint + commit**

Run: `npm run typecheck && npm run lint` → limpos.

```bash
git add "src/app/(dashboard)/broadcasts/page.tsx" "src/app/(dashboard)/broadcasts/new/page.tsx" "src/app/(dashboard)/broadcasts/[id]/page.tsx"
git commit -m "feat(rbac-ui): broadcasts = admin+ (corrige gate agent+ e cobre wizard/excluir)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Gates de Templates (admin+)

**Files:**
- Modify: `src/components/settings/template-manager.tsx` (novo `:521-524`, sync `:512-520`, editar/reenviar/excluir `:596-643`)
- Modify: `src/components/settings/settings-sections.ts` (`:60`) e/ou a página de settings — gating da seção "Modelos"

**Interfaces:**
- Consumes: `useCan('edit-settings')`, `GatedButton`.

- [ ] **Step 1: Gatear os botões do template-manager**

Em `template-manager.tsx`: obter `const canEditSettings = useCan('edit-settings')`. Envolver/desabilitar via `GatedButton canAct={canEditSettings} gateReason="Apenas administradores gerenciam modelos"`: "Novo modelo" (`:521-524`), "Sincronizar da Meta" (`:512-520`), e os "Editar"/"Reenviar"/ícone de excluir por linha (`:596-643`). Botões de leitura (ver detalhe) ficam livres.

- [ ] **Step 2: Esconder a seção "Modelos" das settings pra não-admin**

A aba/seção "Modelos" (`settings-sections.ts:60`) é workspace-wide (admin+). Como toda a área de Configurações já é escondida da nav do agent (Task 1), esta seção fica inacessível por nav; mas se as settings tiverem navegação interna visível, filtrar a seção "Modelos" por `canEditSettings`. Se a estrutura de settings só renderiza conteúdo gated internamente, confirmar que o conteúdo de Modelos não vaza pra não-admin e seguir.

- [ ] **Step 3: typecheck + lint + commit**

Run: `npm run typecheck && npm run lint` → limpos.

```bash
git add src/components/settings/template-manager.tsx src/components/settings/settings-sections.ts
git commit -m "feat(rbac-ui): templates = admin+ (novo/sync/editar/excluir desabilitados p/ não-admin)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Gates de Automações + Flows (corrigir agent+→admin+ e cobrir mutações)

**Files:**
- Modify: `src/app/(dashboard)/automations/page.tsx` (criar `:168-176`, toggle `:326-330`, editar `:340-342`, duplicar `:344-346`, excluir `:353-356`)
- Modify: `src/components/automations/automation-builder.tsx` (salvar `:578-585`)
- Modify: `src/app/(dashboard)/flows/page.tsx` (criar `:217-224`, editar via card `:407-410`)
- Modify: `src/components/flows/header.tsx` (ativar/pausar `:107-140`, salvar `:141-148`, excluir `:98-106`)

**Interfaces:**
- Consumes: `useCan('edit-settings')`, `GatedButton`.

- [ ] **Step 1: Corrigir o gate de "criar" (agent+ → admin+)**

Em `automations/page.tsx:168-176` e `flows/page.tsx:217-224`: os `GatedButton` de criar hoje usam `useCan('send-messages')` (agent+). **Trocar para `useCan('edit-settings')`** (automações/flows são admin+ na Fase 1a). `gateReason="Apenas administradores gerenciam automações"` / `"...fluxos"`.

- [ ] **Step 2: Cobrir as mutações sem gate (admin+)**

Adicionar `useCan('edit-settings')` (uma const `canManage` no componente) e gatear/desabilitar:
- Automations: toggle ativar/pausar (`:326-330` — desabilitar o `Switch` com `disabled={!canManage}`), editar (`:340-342`), duplicar (`:344-346`), excluir (`:353-356` — itens de dropdown: condicionar com `{canManage && <DropdownMenuItem .../>}` ou desabilitar), salvar no builder (`automation-builder.tsx:578-585` via `GatedButton`).
- Flows: editar via card (`flows/page.tsx:407-410`), ativar/pausar (`header.tsx:107-140`), salvar (`:141-148`), excluir (`:98-106`) — `GatedButton canAct={canManage}` / `disabled`.

Para itens de `DropdownMenuItem` (que não são `GatedButton`), usar render condicional `{canManage && (...)}` ou `disabled` + tooltip no item.

- [ ] **Step 3: typecheck + lint + commit**

Run: `npm run typecheck && npm run lint` → limpos.

```bash
git add "src/app/(dashboard)/automations/page.tsx" src/components/automations/automation-builder.tsx "src/app/(dashboard)/flows/page.tsx" src/components/flows/header.tsx
git commit -m "feat(rbac-ui): automações e flows = admin+ (corrige criar + cobre toggle/editar/duplicar/excluir/salvar/ativar)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Gates de Config WhatsApp + Estrutura + Painéis admin

**Files:**
- Modify: `src/components/settings/whatsapp-config.tsx` (salvar `:695`, reset `:727`)
- Modify: `src/components/settings/tag-manager.tsx` (form add `:234-246`, excluir `:186-193`)
- Modify: `src/components/pipelines/pipeline-settings.tsx` (editar/excluir pipeline/stage)
- Modify: painéis que renderizam form sem gate: `src/components/settings/*` de api-keys/webhooks/CAPI/lead-autoassign (envolver render em `canManageMembers`/`canEditSettings`)

**Interfaces:**
- Consumes: `useCan('edit-settings')`, `useCan('manage-members')`, `GatedButton`.

- [ ] **Step 1: WhatsApp config**

Em `whatsapp-config.tsx`: `const canEditSettings = useCan('edit-settings')`. "Salvar" (`:695`) e "Reset/Desconectar" (`:727`) → `GatedButton canAct={canEditSettings} gateReason="Apenas administradores editam a conexão do WhatsApp"`. Idealmente desabilitar também os inputs do form pra não-admin (read-only).

- [ ] **Step 2: Estrutura (tags + pipelines)**

`tag-manager.tsx`: esconder o form de adicionar tag (`:234-246`) e o botão de excluir (`:186-193`) quando `!canEditSettings` (`{canEditSettings && (...)}`) — tags = admin+. `pipeline-settings.tsx`: o dialog de settings já só abre pra admin (confirmado no mapeamento); confirmar e, por garantia, desabilitar os botões de criar/editar/excluir stage/pipeline dentro do dialog com `canEditSettings`.

- [ ] **Step 3: Painéis admin (api-keys/webhooks/CAPI/lead-autoassign)**

Esses painéis carregam dados gated em `canManageMembers`, mas renderizam o form/botões pra todos (falham só no submit). Envolver a renderização do form/ações em `{canManageMembers && (...)}` (api-keys/webhooks/membros) ou `{canEditSettings && (...)}` (CAPI/lead-autoassign) — coerente com o backend (`requireRole('admin')`). Como toda a área de Settings já some da nav do agent (Task 1), isto é defesa adicional para acesso direto.

- [ ] **Step 4: typecheck + lint + commit**

Run: `npm run typecheck && npm run lint` → limpos.

```bash
git add src/components/settings/whatsapp-config.tsx src/components/settings/tag-manager.tsx src/components/pipelines/pipeline-settings.tsx src/components/settings/
git commit -m "feat(rbac-ui): config WhatsApp + estrutura + painéis admin gated p/ admin+

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Gates de deletar Contato/Deal (admin+)

**Files:**
- Modify: `src/app/(dashboard)/contacts/page.tsx` (delete single `:500-507`, bulk `:345-351`)
- Modify: `src/components/contacts/contact-detail-view.tsx` (delete contato, se houver)
- Modify: `src/components/pipelines/deal-form.tsx` (delete deal `:471-478`)

**Interfaces:**
- Consumes: `useCan('edit-settings')`, `GatedButton`.

- [ ] **Step 1: Deletar contato (single + bulk)**

Em `contacts/page.tsx`: o delete single (`:500-507`) está sem gate, e o bulk (`:345-351`) está gateado em `canEdit` (agent+) — **ambos devem ser admin+**. Trocar/adicionar para `canEditSettings` (`const canDelete = useCan('edit-settings')`): desabilitar o item de excluir (single, dropdown → `{canDelete && ...}` ou disabled) e o botão de excluir em massa (`GatedButton canAct={canDelete} gateReason="Apenas administradores podem excluir contatos"`). **Não** mexer em criar/editar contato (agent+, já correto).

- [ ] **Step 2: Deletar deal**

Em `deal-form.tsx:471-478`: o "Excluir" do deal está sem gate → `GatedButton canAct={useCan('edit-settings')} gateReason="Apenas administradores podem excluir negócios"`. **Não** mexer em criar/editar/mover deal (agent+).

- [ ] **Step 3: typecheck + lint + commit**

Run: `npm run typecheck && npm run lint` → limpos.

```bash
git add "src/app/(dashboard)/contacts/page.tsx" src/components/contacts/contact-detail-view.tsx src/components/pipelines/deal-form.tsx
git commit -m "feat(rbac-ui): deletar contato/deal = admin+ (corrige bulk agent+ e cobre single/deal)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:** A Fase 1b do spec pede "esconder/desabilitar botões das ações bloqueadas". Coberto: nav admin escondida (Task 1); broadcast/templates/automations/flows/config/estrutura/painéis admin → admin+ (Tasks 2-5); deletar contato/deal → admin+ (Task 6); send/react/criar-editar-contato/mover-deal seguem agent+ (não tocados). ✅ Desvio registrado: reusa `edit-settings`/`send-messages` em vez de criar predicados novos (DRY).

**2. Placeholder scan:** Sem TBD. Os `file:line` vêm do mapeamento; o implementer deve LER cada arquivo antes de editar (linhas podem ter mudado levemente) e localizar o controle pelo texto/handler descrito.

**3. Consistência de papel (o ponto mais fácil de errar):** TODA ação que a Fase 1a tornou admin+ no backend usa `edit-settings` na UI — broadcast, automações, flows, templates, config, estrutura, deletar contato/deal. Gates legados em `send-messages` (agent+) nesses são **corrigidos** (Tasks 2 e 4). Só criar/editar contato, mover deal e enviar/reagir ficam em `send-messages` (agent+). Bate com o backend da Fase 1a.

**Risco:** alguns controles são `DropdownMenuItem`/`Switch` (não `GatedButton`) — usar render condicional `{canManage && ...}` ou `disabled` + tooltip nesses, conforme o componente. Verificação visual real (logar como agent) é manual e fica pro fim da fase.

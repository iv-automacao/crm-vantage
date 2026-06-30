# Rodízio Atômico (cursor condicional + janela canônica) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar o avanço do cursor do rodízio condicional (só gira quando a atribuição do lead cola) movendo a atribuição da conversa — endereçada por `conversation_id` — pra dentro da RPC `pick_next_agent_round_robin`, e fixar a janela de presença de 5min como fonte canônica.

**Architecture:** A RPC passa a receber `p_conversation_id`, atribuir a conversa por dentro numa única transação (peek do cursor com `FOR UPDATE` → `UPDATE conversations WHERE id = p_conversation_id AND assigned_agent_id IS NULL` → avança o cursor só se afetou linha). O TS `assignNextAgent` vira um wrapper fino (3º param = `conversationId`) e os 3 callers passam o id da conversa. A migration 038 vira a definição canônica (5min) e **coexiste** com a de 1 arg (sem drop, pra não abrir janela de deploy); 030/035 ganham comentário SUPERSEDED.

**Tech Stack:** PostgreSQL (plpgsql, Supabase), TypeScript, Vitest.

## Global Constraints

- Comentários de código em **português**.
- Nunca `git add -A` — adicionar arquivos explicitamente.
- `npx tsc --noEmit` limpo; `npm run lint` sem **novos** problemas (baseline ~2 errors / ~24 problems pré-existentes — não regredir).
- **Migration = aplicação MANUAL pelo Iago** no SQL Editor (banco dedicado `mgmokvpjswtjxhqhnyps`), **antes/junto do merge**. O implementer **NÃO** aplica a migration nem roda comandos contra o banco.
- A RPC é `SECURITY DEFINER` (dona `postgres`) com `EXECUTE` só pra `service_role` — **grants inalterados**.
- Janela de presença canônica = **5 minutos**, espelhada em `PRESENCE_WINDOW_MS` (TS).
- A 038 **não dropa** a função de 1 arg (coexistência → sem janela de incompatibilidade no deploy).
- PRs → `iv-automacao/crm-vantage`.

---

### Task 1: Migration 038 — RPC atômica (por conversation_id) + janela canônica + SUPERSEDED nas antigas

**Files:**
- Create: `supabase/migrations/038_round_robin_atomic.sql`
- Modify: `supabase/migrations/030_lead_autoassign.sql` (comentário SUPERSEDED na função)
- Modify: `supabase/migrations/035_presence_auto.sql` (comentário SUPERSEDED na função)

**Interfaces:**
- Consumes: tabelas `agent_presence`, `profiles`, `lead_autoassign_settings` (`account_id`, `cursor BIGINT`, `updated_at`), `conversations` (`id`, `account_id`, `assigned_agent_id`, `autoassign_waiting`) — todas já existentes (030/035).
- Produces: `public.pick_next_agent_round_robin(p_account_id UUID, p_conversation_id UUID) RETURNS UUID` — escolhe o `user_id` do agente, **atribui a conversa de id `p_conversation_id`** só se ela ainda não tem dono, e avança o cursor **só** quando atribui. Retorna `NULL` quando ninguém disponível **ou** quando a conversa já tinha dono. A versão de 1 arg **continua existindo** (coexistência).

- [ ] **Step 1: Criar a migration 038 com a RPC atômica**

Criar `supabase/migrations/038_round_robin_atomic.sql` com exatamente este conteúdo:

```sql
-- 038: Rodízio atômico — cursor condicional + janela canônica.
-- Acrescenta a assinatura de 2 args (p_account_id, p_conversation_id) da
-- pick_next_agent_round_robin. A função agora:
--   (a) recebe p_conversation_id e faz a ATRIBUIÇÃO da conversa por dentro,
--       endereçada por id (1 linha exata; conversations NÃO tem UNIQUE em
--       account_id+contact_id, então atribuir por contato varreria N linhas);
--   (b) só AVANÇA o cursor quando a atribuição COLA (não queima vendedor em corrida);
--   (c) é a FONTE CANÔNICA da janela de presença (INTERVAL '5 minutes').
--
-- COEXISTÊNCIA: NÃO dropamos a versão de 1 arg (pick_next_agent_round_robin(UUID)).
-- As duas assinaturas convivem (PostgREST resolve por nome de argumento), pra
-- não abrir janela onde o código no ar chame uma assinatura inexistente.
-- A de 1 arg fica órfã após esta release — remover numa migration futura.
-- ORDEM: aplicar esta migration ANTES/JUNTO do merge do código TS.
-- RLS/grants inalterados. SECURITY DEFINER (postgres) / EXECUTE só service_role.
-- Aplicada MANUALMENTE no SQL Editor (banco dedicado).

CREATE OR REPLACE FUNCTION public.pick_next_agent_round_robin(
  p_account_id UUID,
  p_conversation_id UUID
)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pool     UUID[];
  v_idx      BIGINT;
  v_agent    UUID;
  v_affected INT;
BEGIN
  -- 1) Pool elegível: no rodízio, recebendo, e online (heartbeat < janela).
  --    Janela CANÔNICA = 5 minutos (espelhada em PRESENCE_WINDOW_MS no TS).
  SELECT array_agg(ap.user_id ORDER BY pr.created_at, ap.user_id)
  INTO v_pool
  FROM agent_presence ap
  JOIN profiles pr ON pr.user_id = ap.user_id AND pr.account_id = ap.account_id
  WHERE ap.account_id = p_account_id
    AND ap.in_pool
    AND ap.is_available
    AND ap.last_activity_at > NOW() - INTERVAL '5 minutes';
    -- gate de turno futuro: AND <turno aberto agora>

  IF v_pool IS NULL OR array_length(v_pool, 1) = 0 THEN
    RETURN NULL;  -- ninguém disponível -> caller faz o fallback do ADM
  END IF;

  -- 2) Garante a linha de settings SEM girar o cursor.
  INSERT INTO lead_autoassign_settings (account_id, cursor)
  VALUES (p_account_id, 0)
  ON CONFLICT (account_id) DO NOTHING;

  -- 3) Trava a linha do cursor pra serializar chamadas concorrentes da conta.
  SELECT cursor INTO v_idx
  FROM lead_autoassign_settings
  WHERE account_id = p_account_id
  FOR UPDATE;
  IF v_idx IS NULL THEN
    RETURN NULL;  -- defensivo: nunca deve acontecer após o INSERT acima.
  END IF;

  -- 4) Peek do candidato com o cursor ATUAL (ainda não gira). Arrays são 1-based.
  v_agent := v_pool[(v_idx % array_length(v_pool, 1)) + 1];

  -- 5) Atribui só se a conversa (por id) ainda não tem dono. UPDATE de 1 linha
  --    exata -> GET DIAGNOSTICS confiável.
  UPDATE conversations
  SET assigned_agent_id = v_agent, autoassign_waiting = false
  WHERE id = p_conversation_id
    AND account_id = p_account_id
    AND assigned_agent_id IS NULL;
  GET DIAGNOSTICS v_affected = ROW_COUNT;

  -- 6) Nada colou (a conversa já tinha dono) -> NÃO gira o cursor.
  IF v_affected = 0 THEN
    RETURN NULL;
  END IF;

  -- 7) Atribuição colou -> só agora avança o cursor.
  UPDATE lead_autoassign_settings
  SET cursor = cursor + 1, updated_at = NOW()
  WHERE account_id = p_account_id;

  RETURN v_agent;
END; $$;
ALTER FUNCTION public.pick_next_agent_round_robin(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.pick_next_agent_round_robin(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pick_next_agent_round_robin(UUID, UUID) TO service_role;
```

- [ ] **Step 2: Carimbar a função antiga em 030 como SUPERSEDED**

Em `supabase/migrations/030_lead_autoassign.sql`, o bloco de cabeçalho da seção 4 passa a ser (adiciona as 3 linhas de aviso, mantendo o resto):

```sql
-- 4) Seleção atômica do rodízio -----------------------------------------
-- ⚠️ SUPERSEDED pela migration 038 (assinatura de 2 args com p_conversation_id;
--    janela canônica = 5min; cursor condicional). Esta versão (1 arg, 15min)
--    fica órfã após o release do código novo — ver 038_round_robin_atomic.sql.
-- Devolve o próximo agente disponível, avançando o cursor da conta na MESMA
-- instrução, pra invocações concorrentes de webhook nunca colidirem.
CREATE OR REPLACE FUNCTION public.pick_next_agent_round_robin(p_account_id UUID)
```

- [ ] **Step 3: Carimbar a função em 035 como SUPERSEDED**

Em `supabase/migrations/035_presence_auto.sql`, o bloco de cabeçalho da seção 3 passa a ser:

```sql
-- 3) Janela de presença do rodízio: 15min -> 5min -------------------------
-- ⚠️ SUPERSEDED pela migration 038 (recria a função com a assinatura de 2 args
--    p_conversation_id + cursor condicional). A janela canônica de 5min mora
--    agora na 038. Esta assinatura de 1 arg fica órfã após o release.
-- Espelha PRESENCE_WINDOW_MS em round-robin.ts. Predicado inalterado.
CREATE OR REPLACE FUNCTION public.pick_next_agent_round_robin(p_account_id UUID)
```

- [ ] **Step 4: Revisar o SQL contra o checklist (sem rodar — migration é manual)**

Não há suíte automatizada pra SQL. Verificar à mão:
- A assinatura nova é `(p_account_id UUID, p_conversation_id UUID)` e **NÃO** há `DROP FUNCTION` (coexistência preservada).
- O `UPDATE conversations` filtra por `id = p_conversation_id AND account_id = p_account_id AND assigned_agent_id IS NULL` (1 linha exata).
- Ordem: pool → `INSERT ON CONFLICT DO NOTHING` → `SELECT ... FOR UPDATE` + guarda `v_idx IS NULL` → peek → `UPDATE conversations` → `GET DIAGNOSTICS` → `IF v_affected = 0 RETURN NULL` → avança cursor → `RETURN v_agent`.
- Janela `INTERVAL '5 minutes'`. `GRANT/REVOKE/OWNER` presentes pra a assinatura de 2 args. Comentários em português.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/038_round_robin_atomic.sql supabase/migrations/030_lead_autoassign.sql supabase/migrations/035_presence_auto.sql
git commit -m "feat(leads): RPC de rodízio atômica por conversation_id (cursor condicional + janela canônica)"
```

---

### Task 2: TS — `assignNextAgent` enxuto (por conversationId) + 3 callers + testes

**Files:**
- Modify: `src/lib/leads/round-robin.ts`
- Test: `src/lib/leads/round-robin.test.ts`
- Modify: `src/app/api/whatsapp/webhook/route.ts`
- Modify: `src/app/api/automations/cron/route.ts`
- Modify: `src/lib/automations/engine.ts`

**Interfaces:**
- Consumes: `public.pick_next_agent_round_robin(p_account_id UUID, p_conversation_id UUID)` da Task 1 — via `db.rpc('pick_next_agent_round_robin', { p_account_id, p_conversation_id })`, retorna `{ data: <uuid|null>, error }`.
- Produces: `assignNextAgent(db, accountId, conversationId): Promise<{ agentId: string | null }>` — 3º param agora é o **id da conversa**; só delega pra RPC (sem `UPDATE` separado).

- [ ] **Step 1: Escrever os testes falhando pra `assignNextAgent`**

Em `src/lib/leads/round-robin.test.ts`, trocar a primeira linha de import por (adiciona `vi`):

```ts
import { describe, it, expect, vi } from 'vitest'
```

e a linha de import do módulo por (adiciona `assignNextAgent`):

```ts
import { pickIndex, isAvailableNow, onlineNow, assignNextAgent } from './round-robin'
```

No fim do arquivo, adicionar este bloco:

```ts
describe('assignNextAgent', () => {
  const ACCOUNT = 'acc-1'
  const CONVERSATION = 'conv-1'

  // `db` fake: `.rpc` controlável; `.from` é um chainable no-op. A impl NOVA não
  // deve chamar `.from` (a atribuição mora na RPC) — mas o chainable garante que,
  // contra a impl ANTIGA, o teste RED falhe pela ASSERÇÃO e não por TypeError.
  function fakeDb(rpcResult: { data?: unknown; error?: unknown }) {
    const chain: Record<string, unknown> = {}
    chain.update = vi.fn(() => chain)
    chain.eq = vi.fn(() => chain)
    chain.is = vi.fn(() => chain)
    return {
      rpc: vi.fn().mockResolvedValue(rpcResult),
      from: vi.fn(() => chain),
    }
  }
  type DbArg = Parameters<typeof assignNextAgent>[0]

  // RED real (falham por asserção na impl atual):
  it('chama a RPC com p_account_id E p_conversation_id', async () => {
    const db = fakeDb({ data: 'agent-9' })
    await assignNextAgent(db as unknown as DbArg, ACCOUNT, CONVERSATION)
    expect(db.rpc).toHaveBeenCalledWith('pick_next_agent_round_robin', {
      p_account_id: ACCOUNT,
      p_conversation_id: CONVERSATION,
    })
  })

  it('NÃO faz UPDATE separado em conversations (atribuição mora na RPC)', async () => {
    const db = fakeDb({ data: 'agent-9' })
    await assignNextAgent(db as unknown as DbArg, ACCOUNT, CONVERSATION)
    expect(db.from).not.toHaveBeenCalled()
  })

  // Regression-guards (já verdes; travam o contrato de retorno):
  it('retorna o agentId quando a RPC devolve um id', async () => {
    const db = fakeDb({ data: 'agent-9' })
    const res = await assignNextAgent(db as unknown as DbArg, ACCOUNT, CONVERSATION)
    expect(res).toEqual({ agentId: 'agent-9' })
  })

  it('retorna agentId null quando a RPC devolve null (ninguém ou já atribuído)', async () => {
    const db = fakeDb({ data: null })
    const res = await assignNextAgent(db as unknown as DbArg, ACCOUNT, CONVERSATION)
    expect(res).toEqual({ agentId: null })
  })

  it('retorna agentId null quando a RPC dá erro', async () => {
    const db = fakeDb({ error: { message: 'boom' } })
    const res = await assignNextAgent(db as unknown as DbArg, ACCOUNT, CONVERSATION)
    expect(res).toEqual({ agentId: null })
  })
})
```

- [ ] **Step 2: Rodar os testes e confirmar o RED**

Run: `npx vitest run src/lib/leads/round-robin.test.ts`
Expected: **2 FAIL, resto PASS.** Os dois RED reais falham **por asserção** (não por crash, graças ao `from` chainable):
- `chama a RPC com p_account_id E p_conversation_id` → a impl atual chama `db.rpc('pick_next_agent_round_robin', { p_account_id })` (1 chave) → `toHaveBeenCalledWith` com 2 chaves falha.
- `NÃO faz UPDATE separado em conversations` → a impl atual chama `db.from('conversations')` → `not.toHaveBeenCalled()` falha.
Os 3 regression-guards (retorno feliz/null/erro) **já passam** na impl atual (o contrato de retorno não muda). Os mirrors `pickIndex`/`onlineNow`/`isAvailableNow` continuam passando.

- [ ] **Step 3: Enxugar `assignNextAgent` e atualizar o comentário da janela**

Em `src/lib/leads/round-robin.ts`, substituir o bloco do comentário de `PRESENCE_WINDOW_MS` (atualmente o JSDoc acima da constante + a própria constante) por:

```ts
/**
 * Janela de presença: tempo máximo desde o último heartbeat pra contar como
 * "online agora". ESPELHA a janela canônica da migration 038
 * (pick_next_agent_round_robin, INTERVAL '5 minutes') — manter os dois em sincronia.
 */
export const PRESENCE_WINDOW_MS = 5 * 60 * 1000
```

E substituir TODA a função `assignNextAgent` (do JSDoc `/**` acima dela até o `}` final) por:

```ts
/**
 * Chama a RPC Postgres `pick_next_agent_round_robin` pra escolher o próximo
 * agente em rodízio e ATRIBUIR a conversa (por id) de forma atômica (migration 038).
 *
 * A RPC faz tudo numa transação: monta o pool, atribui a conversa só se ela
 * ainda não tem dono (guard `assigned_agent_id IS NULL` por dentro) e só AVANÇA
 * o cursor do rodízio quando a atribuição cola. Assim uma rajada de mensagens
 * do mesmo contato novo na mesma conversa nunca "queima" um agente (cursor +1, não +2).
 *
 * Retorna `{ agentId: null }` quando ninguém está disponível OU quando a
 * conversa já tinha dono. O caller (webhook) faz o fallback de
 * `autoassign_waiting` — no-op se a conversa já tem dono.
 */
export async function assignNextAgent(
  db: AdminDb,
  accountId: string,
  conversationId: string,
): Promise<{ agentId: string | null }> {
  const { data: agentId, error } = await db.rpc('pick_next_agent_round_robin', {
    p_account_id: accountId,
    p_conversation_id: conversationId,
  })

  if (error || !agentId) return { agentId: null }

  return { agentId: agentId as string }
}
```

- [ ] **Step 4: Rodar os testes do módulo e confirmar verde**

Run: `npx vitest run src/lib/leads/round-robin.test.ts`
Expected: PASS — todos (mirrors + `assignNextAgent`).

- [ ] **Step 5: Atualizar o caller do webhook pra passar `conversation.id`**

Em `src/app/api/whatsapp/webhook/route.ts`, na chamada (~linha 681), trocar o 3º argumento de `contactRecord.id` por `conversation.id`:

```ts
      const { agentId } = await assignNextAgent(supabaseAdmin(), accountId, conversation.id)
```

(O fallback logo abaixo já é por `.eq('id', conversation.id).is('assigned_agent_id', null)` — não muda.)

- [ ] **Step 6: Atualizar o caller do cron pra passar `c.id`**

Em `src/app/api/automations/cron/route.ts`: no `select` da fila de espera (~linha 89) trocar `'id, account_id, contact_id'` por `'id, account_id'` (o `contact_id` deixa de ser usado), e na chamada (~linha 100) trocar o 3º argumento de `c.contact_id as string` por `c.id as string`:

```ts
  const { data: waiting } = await admin
    .from('conversations')
    .select('id, account_id')
    .eq('autoassign_waiting', true)
    .order('created_at', { ascending: true })
    .limit(100)
  for (const c of waiting ?? []) {
    const { data: s } = await admin
      .from('lead_autoassign_settings')
      .select('is_active')
      .eq('account_id', c.account_id as string)
      .maybeSingle()
    if (!s?.is_active) continue
    const { agentId } = await assignNextAgent(admin, c.account_id as string, c.id as string)
    if (agentId) assigned++
  }
```

- [ ] **Step 7: Atualizar o caller do engine pra resolver e passar `conversationId`**

Em `src/lib/automations/engine.ts`, no case `assign_conversation` modo `round_robin` (~linha 434-437), substituir por:

```ts
      // Rodízio real via RPC atômica do Postgres — atribui a conversa (por id)
      // e avança o cursor só se colar (migration 038). Resolve o id da conversa
      // pelo mesmo helper usado no send_template.
      if (cfg.mode === 'round_robin') {
        const conversationId = await resolveConversationId(args)
        const { agentId } = await assignNextAgent(db, args.automation.account_id, conversationId)
        return agentId
          ? `assigned to ${agentId} (round-robin)`
          : 'round-robin: nada a atribuir (sem agente livre ou já atribuído)'
      }
```

- [ ] **Step 8: Typecheck, lint e suíte completa**

Run: `npx tsc --noEmit && npm run lint && npx vitest run`
Expected: `tsc` sem erros; lint sem **novos** problemas (baseline ~2 errors / ~24 problems); suíte completa verde (o teste do cron mocka `assignNextAgent` e a fila está vazia, então não quebra com a mudança de argumento).

- [ ] **Step 9: Commit**

```bash
git add src/lib/leads/round-robin.ts src/lib/leads/round-robin.test.ts src/app/api/whatsapp/webhook/route.ts src/app/api/automations/cron/route.ts src/lib/automations/engine.ts
git commit -m "refactor(leads): assignNextAgent por conversationId via RPC atômica + callers"
```

---

## Verificação E2E manual (pós-aplicar a 038 — OBRIGATÓRIA, feita pelo Iago)

É a **única** verificação do invariante de cursor condicional (não dá pra unit-testar SQL sem banco).

1. Conta com toggle ON + ≥2 agentes no pool, online (heartbeat < 5min), recebendo.
2. Contato novo manda 1 msg → atribui a A; `lead_autoassign_settings.cursor` +1.
3. Próximo contato novo → atribui a B; `cursor` +1 (rodízio justo).
4. **Rajada na mesma conversa:** 2 mensagens quase simultâneas do mesmo contato novo → conversa fica com **um** dono; `cursor` avança **exatamente 1** (não 2).
5. Ninguém online → RPC retorna NULL → `autoassign_waiting=true`; quando um agente fica online, o cron atribui o mais antigo.

## Notas de não-regressão

- **Assinatura de `assignNextAgent`:** o 3º parâmetro muda de `contactId` pra `conversationId` — todos os 3 callers são atualizados na Task 2 (mesma feature-branch).
- **Webhook:** fallback `autoassign_waiting=true` guardado por `.is('assigned_agent_id', null)` segue correto (no-op se já tem dono).
- **Engine:** numa conversa já-atribuída o cursor deixa de girar (melhoria de fairness, não regressão) e a string de retorno fica honesta.
- **Cron:** contador `assigned` pode subnotificar numa corrida "já atribuído" (só telemetria; sem control flow); edge "assigned + waiting=true stale" já existia (não é regressão).
- **Deploy:** aplicar a 038 antes/junto do merge; a função de 1 arg coexiste (sem janela de incompatibilidade).
- **Fora de escopo:** bug de conversa duplicada (`findOrCreateConversation`), modo `specific` do engine (UPDATE por contato), janela parametrizada.

# Contador de Não-Lidas Atômico Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar o incremento de `conversations.unread_count` no inbound do webhook atômico (via RPC Postgres), eliminando a perda de incremento sob 2 mensagens distintas concorrentes.

**Architecture:** Nova RPC `increment_conversation_unread` (padrão das migrations 007/012) faz `unread_count = unread_count + 1` + set de `last_message_text/last_message_at/updated_at` numa instrução. Um wrapper fino TS (`incrementConversationUnread`) chama a RPC; o webhook troca o read-modify-write em memória pela chamada ao wrapper.

**Tech Stack:** PostgreSQL (Supabase, `LANGUAGE sql`), TypeScript, Vitest.

## Global Constraints

- Comentários de código em **português**.
- Nunca `git add -A` — adicionar arquivos explicitamente.
- `npx tsc --noEmit` limpo; `npm run lint` sem **novos** problemas (baseline ~2 errors / ~24 problems pré-existentes — não regredir).
- **Migration = aplicação MANUAL pelo Iago** no SQL Editor (banco dedicado `mgmokvpjswtjxhqhnyps`). O implementer **NÃO** aplica a migration nem roda comandos contra o banco.
- A RPC é `SECURITY DEFINER` com `EXECUTE` só pra `service_role` (`REVOKE` de PUBLIC/anon/authenticated) — igual à 007.
- A 039 só ADICIONA uma função nova (nenhum código antigo a chama) → sem janela de incompatibilidade no deploy.
- PRs → `iv-automacao/crm-vantage`.

---

### Task 1: Migration 039 — RPC `increment_conversation_unread`

**Files:**
- Create: `supabase/migrations/039_conversation_unread_increment.sql`

**Interfaces:**
- Consumes: tabela `conversations` (colunas `id`, `unread_count`, `last_message_text`, `last_message_at`, `updated_at`) — já existentes.
- Produces: `public.increment_conversation_unread(p_conversation_id UUID, p_last_message_text TEXT) RETURNS VOID` — incrementa `unread_count` em +1 de forma atômica e atualiza `last_message_text` (param), `last_message_at`/`updated_at` (= `NOW()`) da conversa.

- [ ] **Step 1: Criar a migration 039**

Criar `supabase/migrations/039_conversation_unread_increment.sql` com exatamente este conteúdo:

```sql
-- ============================================================
-- 039_conversation_unread_increment.sql
--
-- Incremento ATÔMICO de conversations.unread_count no inbound + refresh de
-- last_message_text / last_message_at / updated_at. Chamada via RPC PostgREST
-- pelo webhook (service-role).
--
-- Antes disto, o webhook fazia read-modify-write em memória:
--   UPDATE conversations SET unread_count = <cache + 1> WHERE id = ...
-- então 2 entregas de mensagens DISTINTAS concorrentes liam N e escreviam
-- N+1, perdendo um incremento. (O gate 23505 do #1 só cobre a reentrega do
-- MESMO message_id.) Aqui o "+1" é resolvido pelo Postgres na própria
-- instrução — entregas concorrentes contam ambas.
--
-- Idempotente — seguro re-rodar. Aplicada MANUALMENTE no SQL Editor.
-- ============================================================

CREATE OR REPLACE FUNCTION increment_conversation_unread(
  p_conversation_id UUID,
  p_last_message_text TEXT
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE conversations
  SET
    unread_count = unread_count + 1,
    last_message_text = p_last_message_text,
    last_message_at = NOW(),
    updated_at = NOW()
  WHERE id = p_conversation_id;
$$;

-- Só o service role chama (o webhook usa o client service-role). Bloqueia
-- anon / authenticated explicitamente pra um usuário não turbinar contador
-- alheio via RPC.
REVOKE ALL ON FUNCTION increment_conversation_unread(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION increment_conversation_unread(UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION increment_conversation_unread(UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION increment_conversation_unread(UUID, TEXT) TO service_role;
```

- [ ] **Step 2: Revisar o SQL contra o checklist (sem rodar — migration é manual)**

Não há suíte automatizada de SQL. Verificar à mão:
- Assinatura `(p_conversation_id UUID, p_last_message_text TEXT) RETURNS VOID`, `LANGUAGE sql`, `SECURITY DEFINER`, `SET search_path = public`.
- `unread_count = unread_count + 1` (não usa valor de fora); `last_message_at = NOW()`, `updated_at = NOW()`, `last_message_text = p_last_message_text`; `WHERE id = p_conversation_id`.
- `REVOKE` de PUBLIC/anon/authenticated + `GRANT EXECUTE ... TO service_role` presentes.
- Comentários em português. Segue o padrão de `007_automations_increment_counter.sql`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/039_conversation_unread_increment.sql
git commit -m "feat(inbox): RPC de incremento atômico do unread_count da conversa"
```

---

### Task 2: Wrapper `incrementConversationUnread` + teste + call site do webhook

**Files:**
- Create: `src/lib/conversations/increment-unread.ts`
- Test: `src/lib/conversations/increment-unread.test.ts`
- Modify: `src/app/api/whatsapp/webhook/route.ts`

**Interfaces:**
- Consumes: `public.increment_conversation_unread(p_conversation_id UUID, p_last_message_text TEXT)` da Task 1 — via `db.rpc('increment_conversation_unread', { p_conversation_id, p_last_message_text })`, retorna `{ error }`.
- Produces: `incrementConversationUnread(db: AdminDb, conversationId: string, lastMessageText: string): Promise<void>` — best-effort (loga em erro, não relança).

- [ ] **Step 1: Escrever o teste falhando do wrapper**

Criar `src/lib/conversations/increment-unread.test.ts` com este conteúdo:

```ts
import { describe, it, expect, vi } from 'vitest'
import { incrementConversationUnread } from './increment-unread'

const CONVERSATION = 'conv-1'
const TEXT = 'Olá, tudo bem?'

// `db` fake: `.rpc` controlável; `.from` é um mock que devolve um objeto vazio.
// O wrapper NÃO deve chamar `.from` (o incremento mora na RPC) — a asserção
// `not.toHaveBeenCalled` trava isso (se alguém regredir pro read-modify-write,
// a asserção falha).
function fakeDb(rpcResult: { error?: unknown }) {
  return {
    rpc: vi.fn().mockResolvedValue(rpcResult),
    from: vi.fn(() => ({})),
  }
}
type DbArg = Parameters<typeof incrementConversationUnread>[0]

describe('incrementConversationUnread', () => {
  it('chama a RPC increment_conversation_unread com conversationId e texto', async () => {
    const db = fakeDb({ error: null })
    await incrementConversationUnread(db as unknown as DbArg, CONVERSATION, TEXT)
    expect(db.rpc).toHaveBeenCalledWith('increment_conversation_unread', {
      p_conversation_id: CONVERSATION,
      p_last_message_text: TEXT,
    })
  })

  it('NÃO faz UPDATE em memória via db.from (incremento é atômico na RPC)', async () => {
    const db = fakeDb({ error: null })
    await incrementConversationUnread(db as unknown as DbArg, CONVERSATION, TEXT)
    expect(db.from).not.toHaveBeenCalled()
  })

  it('repassa o texto exatamente como recebido (fallback mora no call site, não no wrapper)', async () => {
    const db = fakeDb({ error: null })
    await incrementConversationUnread(db as unknown as DbArg, CONVERSATION, '')
    expect(db.rpc).toHaveBeenCalledWith('increment_conversation_unread', {
      p_conversation_id: CONVERSATION,
      p_last_message_text: '',
    })
  })

  it('best-effort: não relança quando a RPC devolve erro', async () => {
    const db = fakeDb({ error: { message: 'boom' } })
    await expect(
      incrementConversationUnread(db as unknown as DbArg, CONVERSATION, TEXT),
    ).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run src/lib/conversations/increment-unread.test.ts`
Expected: FAIL — o arquivo `./increment-unread` ainda não existe → erro de import/resolução do módulo (todos os testes falham por não achar `incrementConversationUnread`).

- [ ] **Step 3: Criar o wrapper**

Criar `src/lib/conversations/increment-unread.ts` com este conteúdo:

```ts
import { supabaseAdmin } from '@/lib/automations/admin-client'

// Tipo do cliente Supabase admin (service-role)
type AdminDb = ReturnType<typeof supabaseAdmin>

/**
 * Incrementa `unread_count` da conversa de forma ATÔMICA (via RPC da migration
 * 039) e atualiza `last_message_text`/`last_message_at`/`updated_at`. Substitui
 * o read-modify-write em memória do webhook, que perdia incremento sob 2
 * mensagens distintas concorrentes.
 *
 * Best-effort (paridade com o `.update` anterior, que só logava): não relança.
 */
export async function incrementConversationUnread(
  db: AdminDb,
  conversationId: string,
  lastMessageText: string,
): Promise<void> {
  const { error } = await db.rpc('increment_conversation_unread', {
    p_conversation_id: conversationId,
    p_last_message_text: lastMessageText,
  })
  if (error) console.error('Erro ao incrementar unread da conversa:', error)
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npx vitest run src/lib/conversations/increment-unread.test.ts`
Expected: PASS — 4/4.

- [ ] **Step 5: Trocar o call site no webhook**

Em `src/app/api/whatsapp/webhook/route.ts`:

(a) Adicionar o import perto dos outros imports de `@/lib/...` (por exemplo logo após o import de `assignNextAgent`):

```ts
import { incrementConversationUnread } from '@/lib/conversations/increment-unread'
```

(b) Remover EXATAMENTE este bloco (webhook `route.ts`, ~648-661 — o comentário `// Update conversation`, o `const { error: convError } = ...` e o `if (convError) {...}`):

```ts
  // Update conversation
  const { error: convError } = await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: contentText || `[${message.type}]`,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  if (convError) {
    console.error('Error updating conversation:', convError)
  }
```

e colocar no lugar:

```ts
  // Incremento ATÔMICO do unread_count + refresh dos campos de resumo (RPC da
  // migration 039). Substitui o read-modify-write em memória, que perdia
  // incremento sob 2 mensagens distintas concorrentes.
  await incrementConversationUnread(
    supabaseAdmin(),
    conversation.id,
    contentText || `[${message.type}]`,
  )
```

(`npx tsc --noEmit` no Step 6 pega qualquer órfão — `convError` não-usado ou import faltando.)

- [ ] **Step 6: Typecheck, lint e suíte completa**

Run: `npx tsc --noEmit && npm run lint && npx vitest run`
Expected: `tsc` sem erros; lint sem **novos** problemas (baseline ~2 errors / ~24 problems); suíte completa verde (o webhook não tem teste unitário do call site — o único novo é o do wrapper).

- [ ] **Step 7: Commit**

```bash
git add src/lib/conversations/increment-unread.ts src/lib/conversations/increment-unread.test.ts src/app/api/whatsapp/webhook/route.ts
git commit -m "refactor(inbox): webhook usa RPC atômica pro unread_count (sem read-modify-write)"
```

---

## Verificação E2E manual (pós-aplicar a 039 — feita pelo Iago)

1. Conversa com `unread_count = 0`.
2. Simular 2 inbounds de mensagens DISTINTAS quase simultâneas do mesmo contato → `unread_count` vira **2** (não 1).
3. Abrir a conversa → reseta pra 0 (comportamento inalterado).

## Notas de não-regressão

- O único incremento server-side de `unread_count` é o do webhook (grep confirmou) — nenhum outro call site muda.
- `last_message_at`/`updated_at` continuam = hora de processamento (`NOW()` ≈ `new Date()` de antes); `last_message_text` continua last-write-wins. Comportamento observável inalterado, exceto o `unread_count` que deixa de perder incremento.
- Best-effort preservado: erro da RPC loga e não derruba o processamento do inbound (igual ao `convError` antigo).
- A 039 só adiciona função → aplicar antes ou depois do merge; sem janela de incompatibilidade.
- Fora de escopo: `last_message_at` da Meta / reordenação (mitigado pelo #1), versão outbound×inbound, corrida reset(0)×increment.

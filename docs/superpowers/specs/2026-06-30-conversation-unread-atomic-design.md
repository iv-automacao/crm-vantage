# Contador de não-lidas atômico — Design

**Data:** 2026-06-30
**Contexto:** Item **#9 (P2)** da auditoria `docs/auditoria/2026-06-28-conflitos-webhooks-apis.md`.
**Relacionados:** [[crm-vantage-auditoria-backlog]], [[crm-vantage-webhook-agent-feed]], auditoria-mãe.

## Problema

No inbound do webhook (`whatsapp/webhook/route.ts:649-657`), a conversa é atualizada com um **read-modify-write em memória** do contador de não-lidas:

```ts
.from('conversations')
.update({
  last_message_text: contentText || `[${message.type}]`,
  last_message_at: new Date().toISOString(),
  unread_count: (conversation.unread_count || 0) + 1,   // ← lê da cópia em memória, soma 1, escreve
  updated_at: new Date().toISOString(),
})
.eq('id', conversation.id)
```

`(conversation.unread_count || 0) + 1` usa o valor que veio no objeto `conversation` carregado mais cedo no handler. **Duas entregas de mensagens DISTINTAS concorrentes** (lambdas paralelas) leem o mesmo `N`, ambas escrevem `N+1` → um incremento se perde. O gate de idempotência do #1 (migration 036, `23505`) só elimina o double-count da **reentrega do MESMO `message_id`** (sai antes desta atualização); o race de mensagens **distintas** concorrentes **permanece**.

## Escopo (decidido no brainstorming)

**Lean — só o contador atômico.** O único chamador que incrementa `unread_count` no servidor é este ponto do webhook (confirmado por grep; o cliente `inbox/page.tsx` faz `+1` otimista de UI e `message-thread.tsx` reseta pra 0 — nenhum é a corrida-alvo). A auditoria resume o fix como "RPC `increment`".

**Fora de escopo (consciente):**
- **(b) `last_message_at` da hora de processamento em vez do timestamp da Meta / reordenação da inbox por reentrega:** já mitigado pelo **#1** — reentrega do mesmo `message_id` agora dá no-op (retorna antes de tocar a conversa, `route.ts:636-637`). Sobra só o caso raro de mensagens distintas fora de ordem; valor baixo. Mantém `NOW()` (hora de processamento, comportamento atual).
- **(c) outbound × inbound em last-write-wins, sem versão:** exigiria coluna de versão + optimistic concurrency; peso desproporcional. `last_message_text`/`last_message_at` continuam last-write-wins (igual hoje).
- **Corrida reset(0) × increment** ao abrir a conversa (`message-thread.tsx:431` seta `unread_count: 0`): pré-existente, marginal, outra natureza (set vs increment).

## Decisões

### 1. RPC atômica (migration 039)

Nova função no padrão das migrations 007/012 (`increment_automation_execution_count`, `increment_flow_execution_count`):

```sql
CREATE OR REPLACE FUNCTION increment_conversation_unread(
  p_conversation_id UUID,
  p_last_message_text TEXT
)
RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE conversations
  SET unread_count = unread_count + 1,
      last_message_text = p_last_message_text,
      last_message_at = NOW(),
      updated_at = NOW()
  WHERE id = p_conversation_id;
$$;
REVOKE ALL ON FUNCTION increment_conversation_unread(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION increment_conversation_unread(UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION increment_conversation_unread(UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION increment_conversation_unread(UUID, TEXT) TO service_role;
```

- `unread_count = unread_count + 1` é resolvido **pelo Postgres na própria instrução** → entregas concorrentes contam ambas (sem incremento perdido).
- `last_message_at = NOW()` e `updated_at = NOW()` preservam o comportamento atual (hora de processamento ≈ `new Date()` do app). O param de timestamp fica de fora (decisão lean).
- `last_message_text` continua vindo do app (`contentText || '[<tipo>]'`) — last-write-wins, igual hoje.
- `SECURITY DEFINER` + `service_role` apenas: o webhook usa `supabaseAdmin()` (service-role); anon/authenticated bloqueados pra ninguém "turbinar" contador alheio via RPC (igual 007).

### 2. Wrapper fino testável

Novo `src/lib/conversations/increment-unread.ts`:

```ts
import { supabaseAdmin } from '@/lib/automations/admin-client'

type AdminDb = ReturnType<typeof supabaseAdmin>

/**
 * Incrementa unread_count da conversa de forma ATÔMICA (via RPC da migration
 * 039) e atualiza last_message_text/last_message_at/updated_at. Substitui o
 * read-modify-write em memória do webhook, que perdia incremento sob 2
 * mensagens distintas concorrentes.
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
  // Best-effort (paridade com o .update anterior, que só logava): não relança.
  if (error) console.error('Erro ao incrementar unread da conversa:', error)
}
```

Existe como wrapper (não inline no webhook) pra ser **unit-testável em isolamento** — o teste trava que o webhook usa a RPC atômica e NÃO um read-modify-write. Mesma filosofia do `assignNextAgent` (#6).

### 3. Webhook chama o wrapper

Em `whatsapp/webhook/route.ts`, o bloco `.from('conversations').update({...}).eq('id', conversation.id)` (com o tratamento de `convError`) vira:

```ts
await incrementConversationUnread(
  supabaseAdmin(),
  conversation.id,
  contentText || `[${message.type}]`,
)
```

Remove a leitura de `conversation.unread_count` em memória. O `import` do wrapper é adicionado no topo.

## Arquitetura / Componentes

| Arquivo | Mudança |
|---|---|
| `supabase/migrations/039_conversation_unread_increment.sql` | **novo** — RPC `increment_conversation_unread(UUID, TEXT)`. `REVOKE` PUBLIC/anon/authenticated + `GRANT` service_role. **Aplicação MANUAL** no SQL Editor. |
| `src/lib/conversations/increment-unread.ts` | **novo** — wrapper `incrementConversationUnread(db, conversationId, lastMessageText)`. |
| `src/lib/conversations/increment-unread.test.ts` | **novo** — chama a RPC com os params certos; **não** faz `.from(...).update`; erro da RPC não relança (best-effort, igual ao update atual que só logava). |
| `src/app/api/whatsapp/webhook/route.ts` | troca o `.update` inline pela chamada ao wrapper + import. |

## Verificação

- **Unit (vitest):** fake `db` com `.rpc` controlável e `.from` chainable no-op (pro RED falhar por asserção, não TypeError). Asserts:
  - **RED (falha na ausência do wrapper — arquivo novo):** `incrementConversationUnread` chama `db.rpc('increment_conversation_unread', { p_conversation_id, p_last_message_text })`; **não** chama `db.from`.
  - Best-effort: com `db.rpc` resolvendo `{ error }`, o wrapper **não relança** (loga via `console.error`). Usar `mockResolvedValue({ error })` (sem `mockRejectedValue`, evita a armadilha Vitest 4). Asserção: `await expect(...).resolves.toBeUndefined()` (não lança).
- **A atomicidade do SQL não dá pra unit-testar sem banco** — verificada por revisão adversarial da 039 + E2E manual.
- **Typecheck/lint:** `npx tsc --noEmit`, `npm run lint` (sem novos problemas; baseline ~2 errors / ~24 problems), suíte completa verde.
- **E2E manual (pós-aplicar a 039):**
  1. Conversa com `unread_count = 0`.
  2. Simular 2 inbounds de mensagens DISTINTAS quase simultâneas do mesmo contato → `unread_count` vira **2** (não 1).
  3. Abrir a conversa → reseta pra 0 (comportamento inalterado).

## Nota de best-effort (comportamento de erro)

O `.update` atual é best-effort: em erro, só faz `console.error('Error updating conversation:', convError)` e segue. O wrapper preserva isso — captura `{ error }`, loga via `console.error('Erro ao incrementar unread da conversa:', error)` e **não relança**. O call site do webhook não precisa de try/catch novo (o `if (convError)` antigo sai junto com o `.update`).

## Restrições

- Comentários em **português**. Nunca `git add -A`. PRs → `iv-automacao/crm-vantage`. `tsc` limpo; lint sem novos problemas.
- **Migration = aplicação MANUAL** pelo Iago no SQL Editor (banco dedicado `mgmokvpjswtjxhqhnyps`). Como a 039 só ADICIONA uma função nova (nenhum código antigo a chama), não há janela de incompatibilidade no deploy — pode aplicar antes ou depois do merge; ideal antes/junto.
- A atualização do DOC da auditoria (#9 → ✅) viaja no working tree e entra no commit da feature-branch.

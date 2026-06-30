# Rodízio: cursor condicional + janela canônica — Design

**Data:** 2026-06-30
**Contexto:** Item **#6 (P2)** da auditoria `docs/auditoria/2026-06-28-conflitos-webhooks-apis.md`.
**Relacionados:** [[crm-vantage-lead-autoassign]], [[crm-vantage-auditoria-backlog]], auditoria-mãe.
**Revisão:** corrigido após revisão adversarial (4 lentes) — ver "Correções da revisão" no fim.

## Problema

O #6 são dois defeitos colados no mesmo item:

**(A) Cursor do rodízio "queima" vendedor.** A RPC `pick_next_agent_round_robin(p_account_id)` (`030`/`035`) escolhe o agente **e já avança o cursor**. Só **depois**, em TS (`round-robin.ts:78-84`), um `UPDATE conversations ... WHERE assigned_agent_id IS NULL` tenta colar a atribuição. São duas instruções separadas. Se o **mesmo contato novo** manda duas mensagens em rajada e elas caem em lambdas concorrentes na MESMA conversa, a RPC roda duas vezes (cursor +2), mas só o primeiro `UPDATE` vence o guard. O lead fica com um dono (sem double-assign), nenhum lead se perde, porém o segundo agente **foi pulado no rodízio sem receber nada** — injustiça de fairness.

**(B) Janela de presença sem fonte única de verdade.** A regra "online se `last_activity_at` dentro da janela" vive em três lugares: `round-robin.ts:23` (`PRESENCE_WINDOW_MS = 5min`), `035.sql:50` (`5 minutes`, **no ar**) e `030.sql:81` (`15 minutes`, **órfão no repo**). No ar está correto (035 foi a última). Mas a `030` ainda **mente 15min**. Falta marcar a fonte canônica.

## Escopo (decidido no brainstorming)

**Conserto completo:** resolver (A) tornando o avanço do cursor **condicional** (só gira quando a atribuição cola) + (B) marcando a fonte canônica da janela. O usuário escolheu explicitamente o escopo completo (a auditoria recomenda os dois).

## Decisões

### 1. RPC passa a atribuir por dentro (atômico), endereçando a conversa por ID

Nova assinatura: `pick_next_agent_round_robin(p_account_id UUID, p_conversation_id UUID) RETURNS UUID`. Tudo numa transação plpgsql (`SECURITY DEFINER`, dona `postgres`, `GRANT EXECUTE` só pra `service_role` — igual hoje):

1. Monta `v_pool` (mesmo `array_agg(... ORDER BY pr.created_at, ap.user_id)`, mesmo predicado `in_pool AND is_available AND last_activity_at > NOW() - INTERVAL '5 minutes'`). Pool vazio → `RETURN NULL`.
2. `INSERT INTO lead_autoassign_settings (account_id, cursor) VALUES (p_account_id, 0) ON CONFLICT (account_id) DO NOTHING;` — garante a linha **sem girar**.
3. `SELECT cursor INTO v_idx FROM lead_autoassign_settings WHERE account_id = p_account_id FOR UPDATE;` — **trava a linha** (serializa chamadas concorrentes da mesma conta). `IF v_idx IS NULL THEN RETURN NULL;` (defensivo — custo zero).
4. `v_agent := v_pool[(v_idx % array_length(v_pool, 1)) + 1];` — peek do candidato com o cursor **atual** (sem girar). Espelha `pickIndex(cursor, poolSize) = cursor % poolSize`.
5. `UPDATE conversations SET assigned_agent_id = v_agent, autoassign_waiting = false WHERE id = p_conversation_id AND account_id = p_account_id AND assigned_agent_id IS NULL;` + `GET DIAGNOSTICS v_affected = ROW_COUNT;`
6. `IF v_affected = 0 THEN RETURN NULL; END IF;` — nada colou (já tinha dono) → cursor **não gira**.
7. `UPDATE lead_autoassign_settings SET cursor = cursor + 1, updated_at = NOW() WHERE account_id = p_account_id;` → `RETURN v_agent;`

**Por que por `id` e não por `(account_id, contact_id)`:** **não existe** UNIQUE em `conversations(account_id, contact_id)` (só PK em `id`), e `findOrCreateConversation` pode criar **duas** conversas pro mesmo contato sob corrida. Endereçar por `(account_id, contact_id)` faria o `UPDATE` varrer **múltiplas linhas** (mesmo agente em 2 conversas, ou varrer uma conversa antiga sem dono), e `GET DIAGNOSTICS` (que assume 1 linha) ficaria não-confiável. Por `id` o `UPDATE` é estritamente **1 linha** → o cursor condicional fica correto.

**Correção de concorrência (por que funciona):** duas chamadas pra mesma conta serializam no `FOR UPDATE` (passo 3). Na MESMA conversa: a 1ª atribui (`id` match), gira, commita, libera; a 2ª então adquire a trava, mas seu `UPDATE WHERE id=... AND assigned_agent_id IS NULL` acha 0 linhas → `RETURN NULL`, cursor intocado. Um dono, um clique. Conversas **diferentes** (inclusive duplicatas do mesmo contato): cada uma cola na sua linha → cada uma gira 1× serializado → rodízio justo, sem queimar.

**Nota de comportamento (consciente):** o ponto de partida do rodízio desloca 1 slot vs o código antigo (peek do cursor atual em vez de pós-incremento). Fairness ao longo do tempo é idêntica. O mirror `pickIndex` (`cursor % poolSize`) segue válido.

### 2. Coexistência das assinaturas (sem janela de deploy)

A `038` **NÃO dropa** a versão de 1 arg (`pick_next_agent_round_robin(UUID)`). As duas assinaturas coexistem (PostgREST resolve por nome de argumento). Motivo: se a `038` for aplicada e o código novo (que chama 2 args) só subir depois — ou vice-versa — não há janela em que o código no ar chame uma assinatura inexistente (`PGRST202` → distribuição cairia silenciosamente). **Ordem recomendada:** aplicar a `038` **antes (ou junto)** do merge → zero downtime (código velho usa 1 arg até o deploy; código novo usa 2 args depois). A função de 1 arg fica **órfã** após esta release — removível numa migration futura de limpeza.

### 3. TS vira wrapper fino + callers passam `conversation_id`

`assignNextAgent(db, accountId, conversationId)` — **terceiro parâmetro passa a ser `conversationId`** (era `contactId`). Corpo:
```ts
const { data: agentId, error } = await db.rpc('pick_next_agent_round_robin', {
  p_account_id: accountId,
  p_conversation_id: conversationId,
})
if (error || !agentId) return { agentId: null }
return { agentId: agentId as string }
```
O `UPDATE conversations` separado **sai** (migrou pra dentro da RPC). Os 3 callers passam o **id da conversa**:
- **webhook** (`whatsapp/webhook/route.ts:681`): passa `conversation.id` (já em escopo; o fallback `autoassign_waiting=true` já é por `.eq('id', conversation.id).is('assigned_agent_id', null)`). null → seta waiting (no-op se já tem dono).
- **cron** (`automations/cron/route.ts:100`): passa `c.id` (o select já traz `id`). null → `continue`.
- **engine** (`automations/engine.ts:435`): resolve via `const conversationId = await resolveConversationId(args)` (padrão já usado no `send_template` do mesmo arquivo) e passa. A string de retorno vira honesta: `'round-robin: nada a atribuir (sem agente livre ou já atribuído)'` (a RPC colapsa "ninguém disponível" e "já atribuído" em null).

**Melhoria de fairness no engine (consciente):** hoje uma automação `round_robin` numa conversa já-atribuída **queima** um slot do cursor (gira +1 à toa); no novo modelo o cursor não gira nesse caso. É melhoria alinhada ao objetivo, não regressão.

### 4. Janela canônica (fonte única de verdade)

A **038 vira a definição canônica** da função (2 args), carregando `INTERVAL '5 minutes'`. No repo, `030` e `035` ganham comentário `-- ⚠️ SUPERSEDED por 038` na definição da função antiga (sem reescrever literais históricos — preserva fidelidade; o replay ordenado termina em 038). `PRESENCE_WINDOW_MS` no TS continua o espelho da camada de app, com comentário "casar com 038". Fonte única conceitual = a última migration (038) + o espelho TS marcado.

## Fora de escopo (consciente)

- **Bug de conversa duplicada** (`findOrCreateConversation` sem UNIQUE/ON CONFLICT): defeito **separado e pré-existente**. Endereçar por `id` torna o rodízio correto perante quaisquer conversas que existam; consertar a duplicação em si é outro item.
- **Janela parametrizada** (coluna/config lida pela RPC): over-engineering pra negócio local com um valor só.
- **Modo `specific` do engine** (`engine.ts:442-447`, `UPDATE` por `account_id+contact_id`): mesma limitação multi-linha, mas é outro caminho (não-rodízio) e fora do #6. Follow-up.
- Edge "assigned + waiting=true (stale)": **já existia** (o `UPDATE` TS antigo também tinha `.is(null)`); não é regressão; auto-heala.

## Arquitetura / Componentes

| Arquivo | Mudança |
|---|---|
| `supabase/migrations/038_round_robin_atomic.sql` | **novo** — `CREATE OR REPLACE FUNCTION pick_next_agent_round_robin(UUID, UUID)` com peek+trava+atribuição condicional por `id`+cursor condicional (5min). **NÃO dropa** a de 1 arg. `REVOKE`/`GRANT` pra a nova assinatura. **Aplicação MANUAL** no SQL Editor, **antes/junto do merge**. |
| `src/lib/leads/round-robin.ts` | `assignNextAgent` enxuto (3º param `conversationId`; chama RPC com `p_conversation_id`; sem `UPDATE` separado); comentário de `PRESENCE_WINDOW_MS` aponta pra 038. |
| `src/lib/leads/round-robin.test.ts` | +testes do `assignNextAgent` (fake `db` com `from` chainable no-op; RED = passa `p_conversation_id` + não chama `from`; regression-guards = retorno feliz/null/erro). Mirrors inalterados. |
| `src/app/api/whatsapp/webhook/route.ts` | caller passa `conversation.id`. |
| `src/app/api/automations/cron/route.ts` | caller passa `c.id` (trim `contact_id` do select). |
| `src/lib/automations/engine.ts` | caller resolve `conversationId` via `resolveConversationId(args)` + string de retorno honesta. |
| `supabase/migrations/030_lead_autoassign.sql` + `035_presence_auto.sql` | +comentário SUPERSEDED na função. |

## Verificação

- **Unit (vitest):** fake `db` com `.rpc` controlável e `.from` chainable no-op. Asserts no `assignNextAgent`:
  - **RED (falham por asserção na impl atual):** chama `db.rpc('pick_next_agent_round_robin', { p_account_id, p_conversation_id })`; **não** chama `db.from`.
  - **Regression-guards (já verdes; travam o contrato):** `data` → `{ agentId }`; `data:null` → `{ agentId: null }`; `error` → `{ agentId: null }`.
  - Mirrors `pickIndex`/`onlineNow`/`isAvailableNow` inalterados.
- **A atomicidade do SQL não dá pra unit-testar sem banco** — verificada por revisão adversarial + E2E manual.
- **Typecheck/lint:** `npx tsc --noEmit`, `npm run lint` (sem novos problemas; baseline ~2 errors / ~24 problems), suíte completa verde.
- **E2E manual (pós-aplicar a 038 — OBRIGATÓRIO, é a única verificação do invariante de cursor condicional):**
  1. Conta com toggle ON + ≥2 agentes no pool, online (<5min), recebendo.
  2. Contato novo → atribui a A; `cursor` +1. Próximo contato → atribui a B; `cursor` +1.
  3. **Rajada na mesma conversa:** 2 mensagens quase simultâneas do mesmo contato novo → conversa com **um** dono; `cursor` avança **exatamente 1** (não 2). Conferir `lead_autoassign_settings.cursor`.
  4. Ninguém online → RPC NULL → `autoassign_waiting=true`; o cron atribui o mais antigo quando alguém fica online.

## Restrições

- Comentários em **português**. Nunca `git add -A`. PRs → `iv-automacao/crm-vantage`. `tsc` limpo; lint sem novos problemas.
- **Migration = aplicação MANUAL** pelo Iago no SQL Editor (banco dedicado `mgmokvpjswtjxhqhnyps`), **antes/junto do merge**. A função é `SECURITY DEFINER`/`service_role` — grants inalterados.
- A atualização do DOC da auditoria (#6 → ✅) viaja no working tree e entra no commit da feature-branch.

## Correções da revisão adversarial

1. **CRÍTICO:** endereçar a conversa por `id` (não `account_id,contact_id`) — sem UNIQUE, o `UPDATE` varreria múltiplas linhas e quebraria o cursor condicional.
2. **Importante:** não dropar o overload de 1 arg na 038 (evita janela de incompat. no deploy); aplicar antes/junto do merge.
3. **Importante:** engine resolve `conversation_id` + string de retorno honesta (não mais "no agent available" enganoso).
4. **Importante:** testes — `from` chainable no-op pra o RED falhar por asserção (não TypeError); reclassificar RED vs regression-guards.
5. **Minor:** guarda defensiva `IF v_idx IS NULL THEN RETURN NULL`.

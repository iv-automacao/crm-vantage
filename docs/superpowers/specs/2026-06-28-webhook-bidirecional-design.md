# Webhook bidirecional (in/out) + payload enriquecido — Design

**Data:** 2026-06-28
**Contexto:** Evolução do feed do agente n8n. Continuação de `2026-06-28-webhook-agente-n8n-design.md` e `2026-06-28-webhook-token-estatico-design.md`. Plano de design aprovado: `~/.claude/plans/imperative-squishing-zebra.md`.
**Relacionados:** [[crm-vantage-webhook-agent-feed]], [[crm-vantage-n8n-agent-loop]], [[crm-vantage-agent-session-isolation]].

## Problema

Hoje o CRM só dispara webhook no **inbound** (`message.received`). Quando a IA, um humano ou um bot/automação **responde**, nada dispara — o n8n fica cego pra metade da conversa e a memória/contexto dele desincroniza (ex.: humano assume e responde; o agente n8n não sabe e pode responder por cima). Também falta no payload o contexto de negócio (tags, deal, agente, origem) pra o agente decidir melhor.

## Decisões (do brainstorming)

1. **Disparar TODO outbound** (humano via inbox + agente n8n via API + bots de automação/flow), cada um com um bloco **`sender`** identificando origem. O **n8n filtra os próprios envios** (por `sender.api_key_id`/`sender.via`) — não suprimimos no servidor. Evita loop sem perder o registro completo.
2. **Fontes de saída:** inbox (humano) + API (agente) + automações + flows. **Broadcasts e reações ficam de fora** (massa / não-conversacional).
3. **Modelo aditivo, não-quebra:** novo evento **`message.sent`** + campo **`direction: "in"|"out"`** nos dois eventos. O `message.received` atual continua funcionando (campos só somam).
4. **Timestamp:** todo evento carrega `timestamp` (ISO 8601) + o horário da mensagem.
5. **Enriquecimento:** tags, nome do agente atribuído + metadados da conversa, custom fields, deal/pipeline, origem CTWA. Extras (notas internas, presença, histórico de mensagens) **fora do MVP**.
6. **Sem subscrição por evento** no `webhook_endpoints` — todo endpoint recebe todos os eventos; o n8n separa por `x-webhook-event`/`direction`.
7. **Sem migration** — a origem (`sender`) é passada em memória no momento do disparo; o enriquecimento lê tabelas existentes.

## Arquitetura

### 1. Helper de enriquecimento (novo) — `src/lib/webhooks/enrich.ts`
`buildConversationContext(admin, accountId, conversationId, contactId)` retorna:
- `contact`: `tags[]`, `custom_fields[{name,value}]`, `referral{ctwa_clid,...}|null`
- `state`: `bot_paused`, `conversation_status`, `assigned_agent_id`, **`assigned_agent_name`**, `unread_count`, `last_message_at`, `autoassign_waiting`, `created_at`
- `deal`: `{id,title,value,currency,stage,pipeline,status}|null` (deal ativo da conversa/contato)

Reusa padrões de query existentes: nested select de tags/custom fields como em `src/lib/contacts/api-service.ts:85-86`; agente via JOIN `profiles`; deal via `deals`+`pipelines`+`pipeline_stages`. **Best-effort:** try/catch por bloco; falha degrada (retorna o que tem) e NUNCA derruba o envio nem o webhook. Minimizar queries (idealmente 1 select aninhado contato + 1 conversa/agente + 1 deal).

### 2. Dispatch generalizado — `src/lib/webhooks/dispatch.ts`
Builder/dispatcher único pra evento de mensagem, com `event`, `direction`, `timestamp`, `sender`, contexto enriquecido, bloco `message` normalizado e (só inbound) `meta` cru. Header `x-webhook-event` reflete o evento. Reusa a entrega atual (lookup de `webhook_endpoints` ativos, `isValidWebhookUrl`, `redirect:'manual'`, timeout, header `x-webhook-token`), best-effort/nunca-lança.

**Payload:**
```jsonc
{
  "event": "message.sent",            // | "message.received"
  "direction": "out",                 // | "in"
  "timestamp": "2026-06-28T17:00:00Z",
  "account_id": "...", "conversation_id": "...",
  "sender": { "type": "agent|bot|customer", "via": "inbox|api|automation|flow|meta",
              "actor_id": "<userId|apiKeyId|null>", "actor_name": "<nome|null>",
              "api_key_id": "<id|null>" },
  "contact": { "id","phone","name","tags":[...],"custom_fields":[{name,value}],"referral":{...}|null },
  "state": { "bot_paused","conversation_status","assigned_agent_id","assigned_agent_name",
             "unread_count","last_message_at","autoassign_waiting","created_at" },
  "deal": { "id","title","value","currency","stage","pipeline","status" } | null,
  "message": { "id","whatsapp_message_id","content_type","content_text","created_at" },
  "meta": { "message":{...}, "contact":{...}, "metadata":{...} }   // só inbound
}
```
**Filtro de loop no n8n (documentar):** ignorar quando `direction==='out' && sender.via==='api' && sender.api_key_id === <sua chave>`.

### 3. Pontos de disparo do outbound
- `src/lib/whatsapp/send-message.ts` (`sendMessageToConversation`, insert ~:289): +param `source:{via,actor_id,actor_name,api_key_id?}`; após insert OK, dispara `message.sent` (best-effort, não-bloqueante).
  - `src/app/api/whatsapp/send/route.ts`: `source={via:'inbox', actor_id: ctx.userId, actor_name}`.
  - `src/app/api/v1/messages/send/route.ts`: `source={via:'api', actor_id: apiKeyId, api_key_id: apiKeyId, actor_name: apiKey.name?}`.
- `src/lib/automations/meta-send.ts` e `src/lib/flows/meta-send.ts` (sends `sender_type:'bot'`): após o send, dispara `message.sent` com `source={via:'automation'|'flow'}`.
- Broadcasts e react: **NÃO** disparam.

### 4. Inbound — `src/app/api/whatsapp/webhook/route.ts` (~:788)
Estende o disparo atual: +`direction:'in'`, +`sender:{type:'customer',via:'meta'}`, +`timestamp`, +enriquecimento (reusa o helper). Mantém `meta` cru e campos atuais (aditivo).

### 5. `webhook_endpoints` — sem mudança
Todo endpoint recebe ambos os eventos; n8n filtra por header/`direction`/`sender`.

## Componentes e responsabilidades

| Arquivo | Mudança |
|---|---|
| `src/lib/webhooks/enrich.ts` | **novo** — `buildConversationContext` |
| `src/lib/webhooks/dispatch.ts` | generaliza payload/dispatch (direction/sender/timestamp/enriquecimento) |
| `src/lib/webhooks/dispatch.test.ts` | testes: `message.sent`, direction, sender, enriquecimento; inbound segue válido |
| `src/lib/whatsapp/send-message.ts` | +param `source`; dispara outbound |
| `src/app/api/whatsapp/send/route.ts` | passa `source` (inbox) |
| `src/app/api/v1/messages/send/route.ts` | passa `source` (api) |
| `src/lib/automations/meta-send.ts` | dispara outbound (automation) |
| `src/lib/flows/meta-send.ts` | dispara outbound (flow) |
| `src/app/api/whatsapp/webhook/route.ts` | inbound: +direction/sender/timestamp/enriquecimento |

## Fora de escopo (YAGNI)
- Histórico de mensagens no payload (redundante com a memória do n8n + os eventos out; pesado).
- Notas internas, presença do agente (fáceis de adicionar depois).
- Eventos de status (sent/delivered/read) como webhook próprio (`message.status`) — futuro.
- Broadcasts/react como eventos.
- Subscrição de eventos por endpoint; migration; persistir `source` em `messages`.

## Restrições
- Comentários em **português**. Nunca `git add -A`. PRs → `iv-automacao/crm-vantage`. Lint baseline = 3; `tsc` limpo.
- Enriquecimento e dispatch **best-effort** — nunca derrubam o envio nem o inbound.
- Filtro de loop é responsabilidade do n8n (documentar no manual): `direction==='out' && sender.via==='api' && sender.api_key_id===<chave>`.

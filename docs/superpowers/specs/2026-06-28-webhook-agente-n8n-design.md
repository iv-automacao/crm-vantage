# Webhook do agente n8n — disparo, pausa & idempotência — Design

**Data:** 2026-06-28
**Contexto:** Saída da auditoria de webhooks/APIs (`docs/auditoria/2026-06-28-conflitos-webhooks-apis.md`). Foca **só** no feed inbound → agente n8n. O restante da auditoria é backlog separado.
**Relacionados:** `crm-vantage-n8n-agent-loop`, `crm-vantage-agent-session-isolation`, `crm-vantage-lead-autoassign`.

## Problema

O CRM tem **dois** mecanismos de webhook de saída, e hoje há confusão sobre qual usar pro agente:

1. **Configurações → Webhooks** (`message.received`, `lib/webhooks/dispatch.ts`): dispara em **toda** mensagem de entrada, payload **rico** (objeto Meta cru + identidade), **assinado** (HMAC), timeout 10s. É `await`-ado no pipeline (`whatsapp/webhook/route.ts:636`), **antes** do autoassign.
2. **Ação de automação "Enviar webhook"** (`lib/automations/engine.ts:529`): condicional, payload **fraco** (7 placeholders interpolados, sem mídia/`message.id`/tipo/timestamp), **não assinado**, **sem timeout**.

Problemas concretos:
- **Não está claro qual é o canal canônico do agente** — o payload da ação de automação é fraco demais pra um agente real (precisa de `message.id`, mídia, tipo).
- O webhook dispara **mesmo quando um humano está atendendo** → o bot responderia por cima do vendedor.
- **Reentrega da Meta** (at-least-once) **re-dispara o webhook** (e todo o resto), porque `messages.message_id` **não é UNIQUE** (auditoria P0 #1).
- A ação de automação faz `fetch` **sem timeout** (pode pendurar) e nenhum dos caminhos valida a URL contra SSRF (auditoria #3).

## Decisões (do brainstorming)

1. **Canal canônico do agente = Caminho A** (Configurações → Webhooks). Payload completo + assinado. O Caminho B fica pra **notificações condicionais**; o payload dele **não** será reforçado.
2. **Disparo: sempre** (todo inbound), como hoje.
3. **Pausa do bot: botão explícito por conversa** ("Pausar bot" / "Bot ativo").
4. **Bot pausado: ainda dispara, com flag.** O CRM enriquece o payload com `bot_paused` + dono; o **n8n decide** responder. A regra de negócio fica no n8n.
5. **Garantia de entrega: best-effort endurecido** (1 tentativa, sem outbox/retry). Aceitável porque o n8n é infra própria estável. Mas **idempotente**, **não-bloqueante** e **SSRF-safe**.

## Arquitetura

### 1. Contrato de disparo (payload enriquecido)

`MessageReceivedPayload` ganha um bloco `state`:

```jsonc
{
  "event": "message.received",
  "account_id": "...",
  "conversation_id": "...",
  "contact": { "id": "...", "phone": "...", "name": "..." },
  "state": {                          // NOVO
    "bot_paused": false,
    "assigned_agent_id": null,        // dono pós-autoassign
    "conversation_status": "open"     // open | pending | closed
  },
  "meta": { "message": { /* Meta cru — inclui message.id */ }, "contact": {…}, "metadata": {…} }
}
```

- O n8n usa `state.bot_paused` pra decidir responder, e `meta.message.id` pra deduplicar do seu lado.
- O bloco `state` é montado **após o autoassign** (pra `assigned_agent_id` vir fresco) e lendo `conversations.bot_paused`.

### 2. Pausa do bot (`conversations.bot_paused`)

- **Migration:** `ALTER TABLE conversations ADD COLUMN bot_paused boolean NOT NULL DEFAULT false;`
- **UI:** botão no header da thread (`message-thread.tsx`) alternando "Pausar bot" ⇄ "Bot ativo".
- **Mutação:** `supabase.from('conversations').update({ bot_paused }).eq('id', …)` **direto pelo client** (RLS já cobre member→update), **mesmo padrão** do `.update({ unread_count: 0 })` que já existe em `message-thread.tsx:421-423`. Sem rota nova.
- Default `false` = bot ativo (coerente com "bot 24/7").

### 3. Idempotência (keystone — auditoria P0 #1)

- **Migration:**
  - **Contar duplicatas primeiro** (`SELECT message_id, count(*) … GROUP BY message_id HAVING count(*)>1`). No banco dedicado (poucos dados de teste) o esperado é **zero**.
  - Se houver duplicatas: deduplicar respeitando FKs — `message_actions` e `message_reactions` referenciam `messages.id` (UUID interno), então **não** dá pra deletar a linha cegamente. Estratégia: manter a mais antiga, repontar filhos pra ela (ou só deletar dups sem filhos). Se a contagem for zero, pular direto pro índice.
  - `CREATE UNIQUE INDEX … ON messages(message_id) WHERE message_id IS NOT NULL;` (parcial — `message_id` é null em notas internas/mensagens sem wamid).
- **Webhook:** o insert da mensagem inbound passa a tratar **violação de unique (`23505`) como reentrega** — mesmo padrão de `findOrCreateContact` (`webhook/route.ts:983`). Se for duplicata → **`return` cedo, pulando TODOS os efeitos**: dispatch do webhook, automações, CAPI/referral, autoassign, `first_inbound`, contadores.
- Efeitos colaterais grátis: elimina o double-count de `unread_count` (#9) e o double-fire do webhook de saída na reentrega.

### 4. Não-bloqueante & ordem

- Mover `dispatchMessageReceived` pra **depois do autoassign** e **executar por último, sem `await` no caminho crítico** (fire-and-forget best-effort, como já é a natureza dele — nunca lança).
- Resultado: o dispatch não serializa mais autoassign/contadores; o `state.assigned_agent_id` reflete o dono já atribuído.

### 5. Hardening SSRF (auditoria #3) — nos dois caminhos

- `isValidWebhookUrl` (`lib/webhooks/secret.ts`): além de exigir `http(s)`, **rejeitar** hosts que resolvem/são loopback, privados, link-local e metadata (`127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`, `fc00::/7`, `fe80::/10`). Bloquear IP literal nessas faixas.
- `fetch(..., { redirect: 'manual' })` em `dispatch.ts` (A) e `engine.ts` (B) — impede redirect→interno.
- **Caminho B:** adicionar `AbortSignal.timeout(10_000)` ao `fetch` de `engine.ts:533` (hoje sem timeout).
- Aplicação: validar a URL **no cadastro** (rota de webhooks) **e** no momento do disparo (defesa em profundidade).

### 6. Tempo de resposta (recap, sem mudança de modelo)

- **POST CRM→n8n:** rápido, não-bloqueante; n8n responde 200 e processa async.
- **Resposta do agente n8n→cliente:** assíncrona via `/api/external/whatsapp/send`. O CRM não espera resposta síncrona.

## Componentes e responsabilidades

| Arquivo | Responsabilidade | Mudança |
|---|---|---|
| `supabase/migrations/036_*.sql` | dedup + UNIQUE parcial `messages.message_id`; `conversations.bot_paused` | **novo** |
| `src/app/api/whatsapp/webhook/route.ts` | gate de idempotência (23505→return); reordenar dispatch p/ depois do autoassign, sem await; ler `bot_paused` | modifica |
| `src/lib/webhooks/dispatch.ts` | payload `state`; `redirect:'manual'`; usar `isValidWebhookUrl` no disparo | modifica |
| `src/lib/webhooks/secret.ts` | `isValidWebhookUrl` rejeita IPs privados/loopback/metadata | modifica |
| `src/lib/automations/engine.ts` | `send_webhook`: timeout + `redirect:'manual'` + `isValidWebhookUrl` | modifica |
| `src/components/inbox/message-thread.tsx` | botão "Pausar bot" + update `bot_paused` via client | modifica |
| (rota de cadastro de webhook) `account/webhooks/route.ts` | validar URL contra SSRF no cadastro | modifica |

## Fora de escopo (YAGNI / backlog separado)

- Reforçar o payload da ação de automação "Enviar webhook" (Caminho B continua pra notificações).
- Outbox durável / retry / observabilidade de entrega (decidido best-effort).
- Auto-resume do bot (pausa é manual nos dois sentidos por enquanto).
- Demais achados da auditoria: CAPI claim (#2), tenancy automations (#4), divergência sends (#5), cursor/janela rodízio (#6), gate aprovação GET (#7), media IDOR (#8), robustez crons (#10), rate-limit cobertura (#11). Cada um terá seu próprio brainstorm.

## Restrições

- Comentários em **português**. Nunca `git add -A`. PRs → `iv-automacao/crm-vantage`.
- Migration aplicada **manualmente pelo Iago no SQL Editor** (MCP sem escrita). Verificação por SQL estrutural. A dedup + UNIQUE deve ser aplicada **antes/junto** do deploy (senão o gate de idempotência no código não tem o índice por trás — o insert ainda duplicaria).
- Lint baseline = 3 erros pré-existentes; não adicionar erro novo.
- Stack: Next.js App Router + Supabase (RLS), multi-tenant por `account_id`.

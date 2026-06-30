# Auditoria de conflitos — Webhooks & APIs (CRM-VANTAGE)

**Data:** 2026-06-28
**Método:** 5 auditorias paralelas (webhook de entrada · crons · caminhos de envio · auth/tenancy · webhooks de saída/CAPI) + verificação manual na fonte de todos os achados de severidade alta.
**Status:** descoberta concluída + **parcialmente endereçada** (ver "STATUS de execução" abaixo). Backlog vivo.

> Convenção: 🔁 = achado corroborado por mais de uma auditoria independente (sinal forte). ✅ = verificado no código pelo orquestrador.

---

## STATUS de execução (2026-06-28)

**✅ FEITO — no ar em produção** (`crm.vantagemanaus.com.br`):
- **#1 (P0) Idempotência do inbound** — `UNIQUE` parcial em `messages.message_id` (migration 036, aplicada/verificada) + gate `23505` no webhook → reentrega da Meta vira no-op. (PR #23)
- **#2 (P1) CAPI duplo-envio** — claim atômico por linha (`UPDATE ... claimed_at WHERE status IN (pending,failed) AND claimed_at IS NULL/expirado RETURNING`) com TTL de 5min auto-expirável (reaper embutido) + resend guard (409 se `pending`/em-voo). Migration 037 (`claimed_at`) aplicada. (PR #25)
- **#3 (P1) SSRF nos webhooks de saída** — `isValidWebhookUrl` bloqueia loopback/privado/link-local/metadata + IPv4-mapped `::ffff:`; `redirect:'manual'` + timeout no dispatch **e** na ação `send_webhook`; validação no cadastro. (PR #23)
- **#4 (P1) `automations/[id]` tenancy** — rotas usam o client de sessão RLS-scoped (`ctx.supabase`) em vez de service-role + filtro `user_id`; GET=`requireActiveAccount`, mutações=`requireRole('admin')`. Qualquer admin gerencia automação de colega; DELETE dá 404 real. Sem migration. (PR #26)
- **#5 (P2) divergência dos caminhos de envio (Opção 1)** — o broadcast **v1 (API)** passou a persistir `broadcasts` + `broadcast_recipients` (com `whatsapp_message_id`, via service-role) → status webhook + analytics funcionam pro v1; a rota de broadcast **interna** rejeita 422 template não-APPROVED. Sem migration. Unificação total (tirar persistência do client hook) fica como follow-up. (PR #27)
- **Extra (mesma área, fora da lista original):** feed do agente n8n (payload `state`, **Pausar bot**), **token estático** `x-webhook-token` + **Rotacionar**, e **webhook bidirecional** (`message.sent`, `direction`, `sender`, enriquecimento: tags/deal/agente/CTWA/timestamp) — PRs #23 + #24 + filtro anti-loop no n8n (`vantage-crm-agente`).

**⏳ PARCIAL:**
- **#9 (P2)** — o gate 23505 elimina o double-count de `unread_count` **só na reentrega do mesmo `message_id`**. O race de 2 mensagens DISTINTAS concorrentes (read-modify-write em `route.ts:660`) **PERMANECE** → precisa de RPC atômica/`increment`.
- **#6 (P2)** — a janela de presença já é 5min no ar (035 aplicada), MAS a `030.sql` no repo ainda tem `INTERVAL '15 minutes'` (drift se re-aplicar) e o **cursor do rodízio ainda avança incondicional** (fairness). Aberto.
- **#12 (P3)** — `signature.ts` (HMAC outbound) removido; mas o **token CAPI/WhatsApp legado em texto plano** ainda é tolerado (sem job de migração forçada).

**⬜ BACKLOG ABERTO — próximos (ordem sugerida pra retomar):**
1. **#7 (P2) gate de aprovação furado** — GET de flows/automations usa `getUser()` cru (conta pending/suspended lê).
2. **#8 (P2) `media/[mediaId]`** — sem checagem de posse da mídia + sem rate limit (qualquer role).
3. **#6 (P2)** — cursor do rodízio incondicional + remover a `030` com 15min (fonte única da janela).
4. **#9 (P2)** — contadores atômicos (RPC `increment`).
5. **#10 (P3)** — robustez dos crons (reaper de `running` órfão; `maxDuration`; backoff CAPI). *(Nota: o reaper do CAPI já saiu de graça no #2 via TTL do `claimed_at`.)*
6. **#11 (P3)** — rate limit no `resend` CAPI + cobertura em mutações de flows/automations.
7. **#12 (P3)** — job de migração forçada dos tokens legados em texto plano.

> **Pra retomar (pós-/compact):** o próximo natural é o **#7 (gate de aprovação furado em GETs)** — P2, e tem sinergia com o que já foi feito no #4 (mesmo padrão de gate). Cada item segue o mesmo fluxo do projeto: brainstorm → spec → plano → revisão adversarial → subagent-driven → PR. Specs/planos já entregues em `docs/superpowers/`. Migrations: **aplicação MANUAL** pelo Iago no SQL Editor (banco dedicado `mgmokvpjswtjxhqhnyps`).

---

## Placar

| Severidade | Qtde | Itens |
|---|---|---|
| 🔴 P0 Crítico | 1 | #1 |
| 🟠 P1 Alto | 3 | #2, #3, #4 |
| 🟡 P2 Médio | 5 | #5, #6, #7, #8, #9 |
| 🟢 P3 Baixo | 3 | #10, #11, #12 |

As 13 rotas `/api/v1/*` (defineRoute), os webhooks de saída (assinatura/tenancy) e a auth dos crons estão **sólidos**. O risco se concentra no **webhook de entrada (idempotência)** e nas **rotas ad-hoc com service-role**.

---

## 🔴 P0 — Crítico

### #1 — `messages.message_id` não é UNIQUE → reentrega da Meta duplica todo o pipeline 🔁🔁🔁 ✅
- **Onde:** `supabase/migrations/001_initial_schema.sql:178` (só `CREATE INDEX`, sem UNIQUE/ON CONFLICT). `009.sql:8` já admite "Meta IDs aren't unique".
- **Conflito:** a Meta entrega webhooks *at-least-once* e re-tenta em qualquer timeout/erro. Sem dedup por `message.id`, a reentrega refaz a cadeia: 2ª linha em `messages` (`webhook/route.ts:613`), automação + CAPI enqueue + captura `ctwa_clid` de novo (`:636,652,672`), webhook de saída re-disparado, `first_inbound_message` 2× (`:606` COUNT-antes-do-INSERT não-atômico).
- **Defesa atual:** só o flow runner deduplica (`engine.ts:285 isDuplicateInbound`). Todo o resto está desprotegido.
- **Por que é raiz:** resolver isto (porteiro único por `message.id` no topo do webhook) derruba metade da lista (#2 parcial, #9, parte do caminho de saída).

---

## 🟠 P1 — Alto

### #2 — CAPI manda conversão dobrada pra Meta 🔁 ✅
- **Onde:** `lib/capi/dispatch.ts:40-43` (`SELECT pending/failed → loop → update(status:'sent')` no fim, **sem claim atômico**). Resend: `account/capi/events/[id]/resend/route.ts:30` reseta `status:'pending'` **sem rate limit e sem checar status atual**.
- **Conflito:** dois crons sobrepostos — ou cron + resend manual — pegam a mesma linha e enviam 2×. Única defesa = `event_id` (=`deal_id`) deduplicado pela Meta, que falha quando `deal_id` é null (usa `id` da linha, instável) ou o deal é re-ganho (`029.sql:33` won→lost→won re-enfileira).
- **Padrão correto já existe no repo:** claim atômico de `automation_pending` (`UPDATE ... WHERE status='pending' RETURNING`). Falta aplicar ao CAPI.

### #3 — SSRF nos webhooks de saída 🔁 ✅
- **Onde:** `lib/webhooks/secret.ts:35` (`isValidWebhookUrl` só faz `startsWith("http://")`). `lib/webhooks/dispatch.ts:46` faz `fetch` direto, **sem bloquear** IPs privados/loopback/link-local/metadata (`169.254.169.254`) e **seguindo redirects** (`redirect:'manual'` ausente).
- **Conflito:** multi-tenant + URL controlada pelo cliente + fetch server-side = SSRF clássico (alcança rede interna / metadata de cloud).
- **Nota:** mesma falha vale pra ação de automação "Enviar webhook" (`engine.ts:533`), que além disso **não tem timeout** nem assinatura.

### #4 — `automations/[id]` viola o modelo de tenancy ✅
- **Onde:** `automations/[id]/route.ts:31` `supabaseAdmin()` (service-role, bypassa RLS) + `:36/:138` `.eq('user_id', user.id)`. `duplicate/route.ts:23` idem.
- **Conflito:** não é vazamento cross-tenant (o filtro `user_id` te prende às suas linhas), mas (a) **conflita com a RLS account-scoped** (017/032) — admin/owner não consegue editar/deletar automação criada por colega (gestão quebrada); (b) toda a segurança depende de **uma linha** de filtro num client que ignora RLS; (c) **method drift**: GET exige só login, PATCH/DELETE exigem `admin`.

---

## 🟡 P2 — Médio

### #5 — Três caminhos de envio divergiram 🔁 ✅
- **Onde:** `whatsapp/send` (1:1) vs `whatsapp/broadcast` (interno) vs `v1/broadcasts` (API pública).
- **Conflito:** persistência incompatível — o 1:1 grava `messages`/inbox; o broadcast interno cria `broadcasts`/`recipients` **no client hook** (`use-broadcast-sending.ts`); o broadcast v1 **não grava nada** (`broadcasts/api-service.ts:121`). O v1 dispara sem rastro em histórico/inbox/analytics e o webhook de status (casa por `whatsapp_message_id` em `broadcast_recipients`) nunca acha a linha. Validação de `APPROVED` só no v1 (`api-service.ts:111`), não no interno (`broadcast/route.ts:135`). Pausa de flow e auto-correção de telefone só no 1:1.

### #6 — Rodízio: cursor queima agente + janela de presença dessincronizada 🔁 ✅
- **Onde:** RPC `pick_next_agent_round_robin` avança cursor incondicionalmente; `round-robin.ts:69-83`. Janela: `030.sql:81` = **15min (ainda no repo)** vs `035.sql:50` = **5min** vs `round-robin.ts:23` = 5min.
- **Conflito:** o cron da fila de espera é um 2º chamador do RPC (além do webhook) → cursor pula agentes em corrida (dono nunca duplica, só fairness). E re-aplicar a `030` por último volta a janela pra 15min sem o TS saber. **Falta fonte única de verdade da janela.**

### #7 — Gate de aprovação (pending/suspended) furado em leituras ✅
- **Onde:** GET de `flows/[id]`, `flows/[id]/runs`, `flows/templates` e `automations` (lista) usam `getUser()` cru, **sem `requireActiveAccount()`**.
- **Conflito:** conta `pending`/`suspended` consegue ler dados. O muro de aprovação só existe onde se usa `requireRole`/`requireActiveAccount`.

### #8 — `whatsapp/media/[mediaId]`: sem posse + sem rate limit ✅
- **Onde:** `whatsapp/media/[mediaId]/route.ts:40` `getMediaUrl({ mediaId })` com o token da conta, **sem confirmar** que a mídia pertence a uma mensagem da conta; liberado a qualquer role (até viewer); **sem rate limit**.
- **Conflito:** cross-tenant é limitado pela Meta (token escopado por WABA), mas dentro da conta é over-permissão + exfiltração sem throttle.

### #9 — Contadores de conversa em corrida (inbound × outbound) 🔁 ✅
- **Onde:** `webhook/route.ts:660` `unread_count: (conversation.unread_count||0)+1` (read-modify-write em memória); `last_message_at: new Date().toISOString()` (hora de processamento, não timestamp da Meta).
- **Conflito:** 2 entregas concorrentes perdem incremento; reentrega tardia reordena a inbox; outbound e inbound escrevem a mesma conversa em last-write-wins, sem versão.

---

## 🟢 P3 — Baixo

### #10 — Robustez dos crons ✅
- Sem **reaper**: linha claimada como `running` que crashe fica presa pra sempre (`automations/cron:54`). CAPI sem `maxDuration` coerente (50 eventos × timeout 10s ≫ 60s → lote cortado; já-enviados podem reentrar por causa do #2). Retry CAPI sem backoff (`next_retry_at` ausente).

### #11 — Rate limit: fail-open + cobertura desigual ✅
- `rate-limit.ts:99` fail-open (Upstash cai → tudo passa, aceito no hardening). Mas mutações de flows/automations não têm rate limit nenhum; o `resend` CAPI (ação mais perigosa) também não.

### #12 — Dívidas menores ✅
- Token CAPI/WhatsApp legado em texto plano tolerado pra sempre (sem job de migração forçada). `react/route.ts:46` SELECT em `messages` sem `account_id` (RLS protege — só inconsistência de estilo, **não** é IDOR; resolvido entre auditores).

---

## Padrões sistêmicos (a lição de fundo)

1. **Idempotência só foi resolvida no flow runner.** Falta um porteiro único por `message.id` no topo do webhook (UNIQUE + `ON CONFLICT DO NOTHING` + "a linha foi mesmo inserida?" como gate de todos os efeitos).
2. **A linha de risco é o client Supabase, não a pasta.** Client de **sessão** (RLS) se protege sozinho; **`supabaseAdmin()`** (service-role) exige re-filtrar `account_id` à mão — e é aí (`automations/[id]`, `flows/[id]`, `whatsapp/media`) que aparecem os furos.
3. **`defineRoute` (v1) é o padrão a replicar** — auth + rate-limit + Zod + `accountId`-do-contexto uniformes. As rotas ad-hoc esquecem pelo menos um dos três.
4. **Read-modify-write em memória** repetido onde o repo já provou que precisa de RPC atômica (`unread_count`, `first_inbound`, gate de autoassign).
5. **"Best-effort" sem claim atômico** na fila CAPI — o padrão de lock já existe no repo, falta aplicar.

---

## Apêndice — Arquitetura de disparo de webhooks (foco do brainstorming)

Existem **dois caminhos distintos** de webhook de saída, e eles servem propósitos diferentes:

### Caminho A — Configurações → Webhooks (evento `message.received`)
- **Tabela/registro:** `webhook_endpoints` (por conta, `is_active`). UI: Configurações → Webhooks.
- **Quando dispara:** em **toda** mensagem de entrada do cliente — `webhook/route.ts:636` `dispatchMessageReceived(...)`, logo após inserir a mensagem. Sem filtro (todo inbound vai pro n8n).
- **Payload (RICO):** `{ event:'message.received', account_id, conversation_id, contact:{id,phone,name}, meta:{ message (Meta cru), contact (cru), metadata (cru) } }` (`webhooks/dispatch.ts`).
- **Segurança:** **assinado** (HMAC `x-webhook-signature`, secret por endpoint). Timeout 10s. Best-effort, nunca lança.
- **Lacunas (auditoria):** SSRF (#3), sem idempotência/`event_id`/retry, `await`-ado no pipeline (até 10s de bloqueio), dispara mesmo com humano no atendimento.

### Caminho B — Ação de automação "Enviar webhook"
- **Onde:** passo de uma automação (gatilho "Nova mensagem" → ação "Enviar webhook") — `engine.ts:529`.
- **Quando dispara:** condicional, conforme as regras da automação (seletivo).
- **Payload (FRACO):** `cfg.body_template` interpolado, com só 7 placeholders (`{{message.text}}`, `{{vars.X}}`, `{{conversation.id}}`, `{{contact.phone}}`, `{{contact.name}}`, `{{contact.id}}`, `{{account.id}}`); placeholder desconhecido → string vazia. Sem template → despeja `args.context` cru. **Sem mensagem Meta crua, sem mídia, sem message id/type/timestamp.**
- **Segurança:** **não assinado**, **sem timeout** (`fetch` sem `AbortSignal` → pode pendurar). Headers customizáveis.

### Questões em aberto (brainstorming)
- Qual é o **canal canônico** para alimentar o agente n8n? (recomendação inicial: Caminho A — payload rico e assinado.)
- Caminho B deve ser **reforçado** (payload completo) ou **rebaixado** a notificações simples?
- O webhook do agente deve disparar **sempre** ou **só quando a conversa está sem dono humano** (interação com autoassign/presença)?
- **Tempo de resposta:** modelo é assíncrono (n8n responde via `/api/external/whatsapp/send`), então o POST deve ser rápido (enfileirar) e não esperar a resposta do agente.

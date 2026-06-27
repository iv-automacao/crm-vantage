# Presença automática de vendedor + Pausar leads — Design

**Data:** 2026-06-26
**Contexto:** Evolução do PR #18 (distribuição de leads em rodízio + presença). Spec relacionado: `2026-06-26-rbac-crm-design.md`.

## Problema

Hoje a disponibilidade do vendedor depende de **três sinais independentes** em `agent_presence`:

- `in_pool` — "No rodízio" (controle do ADM).
- `is_available` — toggle manual "Disponível" no header (default `false`); vira o pill "TOGGLE ON/OFF" no painel.
- `last_activity_at` — heartbeat (ping a cada 4min com a aba visível; janela de 15min).

Elegibilidade pra receber lead = `in_pool AND is_available AND heartbeat < 15min` (SQL `pick_next_agent_round_robin`, espelhado em `round-robin.ts:isAvailableNow`).

**Bug observado:** uma conta aparece "Disponível agora" mesmo sem ninguém usando, porque (1) `is_available` é um booleano persistido que o logout **não** desliga, e (2) o logout/fechar aba **não** dispara nenhum sinal de saída — então o último heartbeat fica "fresco" por até ~15min. O estado não reflete a realidade ("tô com o CRM aberto agora").

## Decisões (do brainstorming)

1. **"Online" = aba ativa (heartbeat), não toggle manual.** Abriu o CRM → online; fechou/deslogou/idle → ausente.
2. **Botão "Pausar leads" (opt-out, default recebendo).** Vendedor online pode pausar o recebimento sem ficar ausente nem deslogar (call/almoço).
3. **`in_pool` ("No rodízio") continua do ADM** — ortogonal à presença.

## Arquitetura

Reaproveita a infra existente. **Não cria tabela nova.** Muda semântica + default de uma coluna, adiciona um beacon de saída, encurta a janela e troca a UI do toggle por um botão de pausa. O predicado central de elegibilidade fica intacto — então rodízio em tempo real e cron da fila de espera herdam o comportamento sem mexer neles.

### 1. Modelo de dados — `agent_presence`

| Coluna | Antes | Depois |
|---|---|---|
| `in_pool` | "No rodízio" (ADM) | **inalterado** |
| `is_available` | toggle manual, default `false` | semântica **"recebendo leads"** (= não pausado), default **`true`**, controlado pelo botão Pausar |
| `last_activity_at` | heartbeat | **fonte única de "online agora"** |

**Migration:**
- `ALTER TABLE agent_presence ALTER COLUMN is_available SET DEFAULT true;`
- Backfill: `UPDATE agent_presence SET is_available = true;` — só `is_available` (todos passam a "recebendo"). **Não** mexer em `in_pool` dos existentes: quem o ADM já configurou no rodízio (PR #18) continua como está.
- Atualizar o trigger `autoassign_sync_agent_pool` pra inserir `in_pool = false, is_available = true` (agente novo nasce **fora** do pool, mas "recebendo"). Mantém `ON CONFLICT DO NOTHING` (preserva opt-out existente). O nome do trigger fica (renomear é churn), mas o comentário passa a refletir "cria a linha de presença do agente fora do rodízio".
- Atualizar `pick_next_agent_round_robin`: trocar a janela de `INTERVAL '15 minutes'` → `INTERVAL '5 minutes'`. Predicado (`in_pool AND is_available AND last_activity_at > now - janela`) **mantém a estrutura**.

> **Decisão (resolvida no spec review):** agente novo nasce **fora** do pool (`in_pool = false`) e "recebendo" (`is_available = true`). Só entra no rodízio depois que o ADM ligar o "No rodízio" dele — controle explícito por contratação. Inverte o auto-join do PR #18 (uma linha no INSERT do trigger). Agentes **já existentes** mantêm o `in_pool` atual.

### 2. Presença automática (heartbeat + beacon de saída)

Casa do heartbeat continua sendo o componente do header, montado pra `agent` em toda página do dashboard.

- **Online:** ping imediato no mount + a cada **2min** enquanto a aba está **visível** (`visibilitychange` controla o intervalo, como hoje).
- **Saída imediata (novo):** `pagehide` (fechar aba/navegar pra fora) e o **logout** (`use-auth.tsx:signOut`) disparam um beacon que zera `last_activity_at` → ausente na hora.
  - `pagehide` → `navigator.sendBeacon` (carrega cookie de sessão same-origin).
  - logout → `fetch(..., { keepalive: true })` **antes** de `supabase.auth.signOut()` (depois do signOut o cookie some e daria 401).
- **Trocar de aba (não fechar):** NÃO dispara beacon — só pausa o ping; o vendedor cai por expiração da janela (~5min). Buffer pra evitar piscar online/offline em troca rápida de aba.
- **Janela de 5min** com ping de 2min: tolera um ping perdido com folga. O número vive em **dois lugares que andam juntos**: o `INTERVAL` do SQL e a constante de `round-robin.ts`.

**Sinal de "offline" no backend:** estender o `POST /api/account/presence` (heartbeat) pra aceitar corpo opcional `{ offline: true }` → seta `last_activity_at = null`. Sem corpo (ou `offline` ausente) = heartbeat normal (seta `last_activity_at = now`). Mantém um único endpoint, compatível com `sendBeacon` (POST com Blob JSON).

### 3. Botão "Pausar leads" (header, só `agent`)

Repropósito de `availability-toggle.tsx` (mesmo lugar, mesma casa do heartbeat):

- Estado default **recebendo** (verde, "Recebendo leads"); ação → **"Pausado"** (cinza).
- Pausar = `PUT /api/account/presence { is_available: false }`; retomar = `{ is_available: true }`. (Endpoint já aceita `is_available`.)
- Remove a ideia de "ligar disponibilidade" — você já está disponível por estar online; o botão só pausa.
- Atualização otimista + rollback em erro (igual ao toggle atual).

### 4. Painel do ADM (`lead-autoassign-panel.tsx` + `lead-autoassign/route.ts`)

- Bolinha verde / "Online agora" / "Ausente" passa a refletir **só o heartbeat** (presença real). Novo campo `online_now` no roster = `last_activity_at` dentro da janela (independe de `in_pool`/pausa).
- Badge **"Pausado"** aparece só quando `is_available = false` (some o pill "TOGGLE ON/OFF").
- Switch **"No rodízio"** inalterado.
- `round-robin.ts` ganha um helper `onlineNow(last_activity_at, now)` (só frescor) ao lado de `isAvailableNow` (elegibilidade completa, que segue mirror do SQL pra qualquer consumidor/teste).

### 5. Distribuição e fila de espera

**Sem mudança de código.** O RPC `pick_next_agent_round_robin` é a fonte única; rodízio em tempo real (`whatsapp/webhook`) e cron da fila (`automations/cron/route.ts:80-102`) chamam o mesmo RPC. Pausa e presença automática valem pros dois de graça. Ninguém recebendo/online → lead fica `autoassign_waiting = true`, ADM vê o contador, cron atribui o mais antigo quando alguém volta a ficar elegível.

## Componentes e responsabilidades

| Arquivo | Responsabilidade | Mudança |
|---|---|---|
| `supabase/migrations/035_presence_auto.sql` | default + backfill `is_available`, trigger insert, janela do RPC | **novo** |
| `src/app/api/account/presence/route.ts` | GET própria presença; PUT pausa; POST heartbeat **+ offline** | estende POST |
| `src/components/layout/availability-toggle.tsx` | botão Pausar + heartbeat + beacon | repropósito |
| `src/hooks/use-auth.tsx` | beacon de offline no `signOut` | +1 chamada antes do signOut |
| `src/lib/leads/round-robin.ts` | predicados + janela | janela 5min; +`onlineNow` |
| `src/lib/leads/round-robin.test.ts` | testes dos predicados | +casos de `onlineNow`/janela |
| `src/app/api/account/lead-autoassign/route.ts` | view do painel | +`online_now` no roster |
| `src/components/settings/lead-autoassign-panel.tsx` | UI do painel | dot=online_now; badge "Pausado" |

## Fora de escopo (YAGNI)

- Detecção de idle real (mouse/teclado) — presença é por aba visível, não por atividade fina.
- Turnos/horário de trabalho (o `030.sql` já deixa o gancho `AND <turno aberto>` comentado).
- Pausa automática por tempo (auto-away após N min de inatividade dentro da aba).
- Histórico/auditoria de presença.

## Restrições

- Comentários em **português**. Nunca `git add -A`. PRs → `iv-automacao/crm-vantage`.
- Migration aplicada **manualmente pelo Iago no SQL Editor** (MCP sem escrita). Verificação por SQL estrutural.
- A janela (5min) vive em SQL **e** TS — manter os dois em sincronia (já há comentário de espelhamento em `round-robin.ts`).
- Lint baseline = 3 erros pré-existentes; não adicionar erro novo.

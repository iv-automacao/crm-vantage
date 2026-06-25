# Design — CRM → Meta Conversions API (CAPI) para conversões de CTWA

**Data:** 2026-06-25 · **Status:** aprovado no brainstorming, aguardando review do spec

## Contexto

O CRM já recebe da Meta (inbound webhook) e já devolve o evento `message.received` pro n8n (PR #13). Falta o elo de **maior valor de negócio**: devolver **conversões reais** pra Meta via a **Conversions API (CAPI)**, pra que a Meta otimize a entrega dos anúncios **Click-to-WhatsApp (CTWA)** com base em quem virou cliente de verdade — não só em quem iniciou conversa. Quase nenhum CRM faz isso; pro gestor de tráfego e pro diretor de marketing, fecha o ciclo anúncio → conversa → venda.

O insumo já chega: quando um lead clica num anúncio CTWA e manda mensagem, a primeira mensagem inbound traz um objeto `referral` com o **`ctwa_clid`** (click-id do anúncio). Hoje esse dado só passa de raspão no payload cru do webhook — **não é persistido em lugar nenhum**. Este projeto captura e persiste o click-id e, quando um negócio fecha, devolve a conversão pro anúncio certo.

## Decisões travadas (brainstorming)

- **Evento inicial:** `deal.won` (negócio ganho) → evento de conversão na Meta (default `Purchase`, com o valor do deal). É o sinal de maior valor. **Config-driven e extensível** — adicionar "lead qualificado"/"lead novo" depois é estender o mapeamento, sem refazer.
- **Credenciais por conta, painel próprio (admin):** cada conta cola **Dataset ID + Access Token + evento + liga/desliga** numa nova seção Configurações → CAPI/Meta. Independente do token do WhatsApp (o token de Ads costuma ser outro System User). Multi-tenant: conta sem CAPI ativo = no-op silencioso.
- **Entrega com log + retry:** cada conversão vira uma linha em `capi_events` (`pending`→`sent`/`skipped`/`failed`). Trilha de auditoria + reenvio manual no painel. `deal.won` é raro e de alto valor → vale a robustez.
- **Detecção do `deal.won` via trigger no Postgres:** a UI marca deal como `won` **client-side** (kanban e `contact-detail-view.tsx` escrevem direto na tabela `deals` via RLS); só a API passa pelo servidor. Não há ponto único no servidor. Um trigger `AFTER UPDATE ON deals` pega **todos** os caminhos (kanban, contact-detail, API, automações) de uma vez.
- **Captura do `ctwa_clid` sempre-on:** persistir no contato a cada inbound com `referral.ctwa_clid` é só um write de coluna (sem chamada externa) — liga pra todas as contas desde já, então leads antigos já têm o click-id quando o CAPI for ativado.

## Fatos do código (grounding)

- **Inbound webhook:** `src/app/api/whatsapp/webhook/route.ts` — `processMessage(...)` (linha ~511) roda dentro do `after()`. Tem em mãos o `message` cru da Meta (logo `message.referral?.ctwa_clid` quando o lead veio de anúncio) e o `contactRecord` (id + account). É onde o PR #13 já engatou o `dispatchMessageReceived` após o insert da mensagem.
- **Tabela `deals`** (`001` + `002` + `017`): tem `account_id UUID NOT NULL`, `contact_id UUID NOT NULL`, `value NUMERIC(12,2) NOT NULL DEFAULT 0`, `currency TEXT`, `status TEXT CHECK (status IN ('open','won','lost'))`. O trigger tem tudo (`NEW.account_id/contact_id/value/currency`) sem precisar de join.
- **Tabela `contacts`** (`017`): tem `account_id UUID NOT NULL`. Recebe as colunas novas de referral.
- **Cron existente:** `src/app/api/automations/cron/route.ts` — autentica via header `x-cron-secret` comparado com `AUTOMATION_CRON_SECRET` (timing-safe). Padrão a espelhar para o cron do CAPI.
- **Convenções de tabela** (migration manual no SQL Editor; ver `026_webhook_endpoints.sql`): `account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE`, RLS via `is_account_member(account_id, 'admin')`, índice parcial, `created_by_user_id`, timestamps idempotentes.
- **Padrão de painel admin:** `src/components/settings/webhooks-panel.tsx` (admin-only, gera/mostra secret 1x, lista/cria/toggle/deleta) — espelhar para o painel CAPI. Rotas de sessão admin: `src/app/api/account/webhooks/route.ts` + `[id]/route.ts` (`requireRole('admin')`).
- **Assinatura/secret:** `webhook_endpoints.secret` é guardado em texto (admin-only RLS) porque é usado para assinar. O `access_token` do CAPI segue a mesma postura (texto, admin-only, nunca em log, mascarado no GET).

## Arquitetura

```
supabase/migrations/027_contact_referral.sql      # colunas ctwa_clid/referral/referral_captured_at em contacts (manual)
supabase/migrations/028_capi_settings.sql         # tabela capi_settings (config por conta) (manual)
supabase/migrations/029_capi_events.sql           # tabela capi_events + trigger AFTER UPDATE ON deals (manual)

src/app/api/whatsapp/webhook/route.ts             # (modificar) no processMessage, persiste ctwa_clid/referral do inbound
src/lib/capi/settings.ts                          # leitura/escrita de capi_settings (service-role, account-scoped)
src/lib/capi/client.ts                            # sendConversionEvent(...) — POST pro Graph API /{dataset_id}/events
src/lib/capi/dispatch.ts                          # processPendingCapiEvents(admin, limit) — resolve config+clid, envia, atualiza status
src/app/api/capi/cron/route.ts                    # cron (x-cron-secret) que chama processPendingCapiEvents
src/app/api/account/capi/route.ts                 # GET (config, token mascarado) + PUT (upsert) — admin, sessão
src/app/api/account/capi/events/route.ts          # GET (lista eventos recentes) — admin
src/app/api/account/capi/events/[id]/resend/route.ts  # POST (volta evento pra pending) — admin
src/components/settings/capi-panel.tsx            # painel Configurações → CAPI/Meta
src/components/settings/settings-sections.ts      # +seção 'capi' no rail de Configurações (admin-only)
```

### Migration 027 — captura no contato (manual)
```sql
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ctwa_clid TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS referral JSONB;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS referral_captured_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_contacts_ctwa_clid ON contacts(ctwa_clid) WHERE ctwa_clid IS NOT NULL;
```
Hook no `processMessage`: quando `message.referral?.ctwa_clid` está presente, `UPDATE contacts SET ctwa_clid=..., referral=<referral cru>, referral_captured_at=now() WHERE id=<contactRecord.id>`. **Sempre o anúncio mais recente ganha** (sobrescreve). Best-effort: nunca derruba o inbound (try/catch, igual ao dispatch do webhook). Sem `referral` → não toca no contato.

### Migration 028 — config por conta `capi_settings` (manual)
```sql
CREATE TABLE IF NOT EXISTS capi_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  dataset_id TEXT,
  access_token TEXT,                     -- texto (usado p/ chamar a Graph API); admin-only RLS; nunca em log/GET
  event_name TEXT NOT NULL DEFAULT 'Purchase',
  is_active BOOLEAN NOT NULL DEFAULT false,
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE capi_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY capi_settings_select ON capi_settings FOR SELECT USING (is_account_member(account_id, 'admin'));
CREATE POLICY capi_settings_modify ON capi_settings FOR ALL
  USING (is_account_member(account_id, 'admin')) WITH CHECK (is_account_member(account_id, 'admin'));
```
> `is_active=true` exige `dataset_id` e `access_token` preenchidos (validado na rota PUT, não no banco).

### Migration 029 — fila + trigger `capi_events` (manual)
```sql
CREATE TABLE IF NOT EXISTS capi_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  event_name TEXT NOT NULL DEFAULT 'Purchase',
  value NUMERIC(12,2),
  currency TEXT,
  status TEXT NOT NULL DEFAULT 'pending',     -- pending | sent | skipped | failed
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  meta_response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_capi_events_pending ON capi_events(status) WHERE status IN ('pending','failed');
CREATE INDEX IF NOT EXISTS idx_capi_events_account ON capi_events(account_id, created_at DESC);
ALTER TABLE capi_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY capi_events_select ON capi_events FOR SELECT USING (is_account_member(account_id, 'admin'));
-- writes só via service-role (cron/trigger); sem policy de INSERT/UPDATE p/ membros.

CREATE OR REPLACE FUNCTION enqueue_capi_event_on_deal_won() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'won' AND (OLD.status IS DISTINCT FROM 'won') THEN
    INSERT INTO capi_events (account_id, deal_id, contact_id, value, currency)
    VALUES (NEW.account_id, NEW.id, NEW.contact_id, NEW.value, NEW.currency);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_capi_event_on_deal_won ON deals;
CREATE TRIGGER trg_capi_event_on_deal_won
  AFTER UPDATE OF status ON deals
  FOR EACH ROW EXECUTE FUNCTION enqueue_capi_event_on_deal_won();
```
> O trigger é **dumb**: só enfileira identidade + valor. Não resolve credencial nem `ctwa_clid` (decisão no cron, em código). `event_name` fica no DEFAULT da linha; o cron usa o `event_name` da config da conta no momento do envio.

### Cliente CAPI (`src/lib/capi/client.ts`)
```ts
export interface ConversionEvent {
  datasetId: string
  accessToken: string
  eventName: string          // ex.: 'Purchase'
  eventId: string            // capi_events.id — dedup na Meta
  eventTimeUnix: number
  ctwaClid: string
  wabaId: string | null      // de whatsapp_config.waba_id, quando disponível
  value: number | null
  currency: string | null
}
// POST https://graph.facebook.com/v21.0/{datasetId}/events. Retorna { ok, status, body }.
// Nunca lança por erro HTTP — devolve ok=false p/ o dispatch decidir. Token nunca em log. Timeout 10s.
export async function sendConversionEvent(e: ConversionEvent): Promise<{ ok: boolean; status: number; body: unknown }>
```
Corpo enviado:
```json
{ "data": [{
    "event_name": "<eventName>", "event_time": <eventTimeUnix>,
    "action_source": "business_messaging", "messaging_channel": "whatsapp",
    "user_data": { "ctwa_clid": "<ctwaClid>", "whatsapp_business_account_id": "<wabaId>" },
    "custom_data": { "currency": "<currency>", "value": "<value>" },
    "event_id": "<eventId>" }],
  "access_token": "<accessToken>" }
```
> `custom_data` só inclui `value`/`currency` quando há valor (> 0). `whatsapp_business_account_id` omitido se `wabaId` nulo.

### Dispatch (`src/lib/capi/dispatch.ts`)
`processPendingCapiEvents(admin, limit = 50)`: busca `capi_events` com `status IN ('pending','failed')` ordenado por `created_at`. Para cada um:
1. Carrega `capi_settings` da conta. Sem config **ativa** (`is_active` + `dataset_id` + `access_token`) → `status='skipped'`, `last_error='capi_inactive'`.
2. Carrega `contacts.ctwa_clid`/`referral` do `contact_id`. Sem `ctwa_clid` → `status='skipped'`, `last_error='no_ctwa_clid'` (deal não veio de anúncio CTWA).
3. Resolve `waba_id` da conta (via `whatsapp_config`, best-effort — pode ser nulo).
4. `attempts += 1`; chama `sendConversionEvent`. `ok` → `status='sent'`, `sent_at=now()`, `meta_response`=corpo. `!ok` → `status='failed'`, `last_error`=resumo, `meta_response`=corpo (retry no próximo cron).

`event_name` usado = o da `capi_settings` da conta (não o DEFAULT da linha), pra refletir mudança de config.

### Cron (`src/app/api/capi/cron/route.ts`)
Espelha `automations/cron`: `x-cron-secret` vs `AUTOMATION_CRON_SECRET` (timing-safe), 401 se não bater. Chama `processPendingCapiEvents(supabaseAdmin())`. Retorna `{ processed, sent, skipped, failed }`. Agendado no Vercel cron (ex.: a cada 5 min). `maxDuration` adequado.

### Gestão — painel + rotas de sessão (admin-only)
- `GET /api/account/capi` → `{ dataset_id, event_name, is_active, has_access_token: boolean }` (**token nunca volta**, só um booleano de presença). `PUT /api/account/capi` → upsert (`dataset_id`, `access_token?` — só atualiza se enviado não-vazio —, `event_name`, `is_active`). `requireRole('admin')`, rate limit `adminAction`. Validação: `is_active=true` exige `dataset_id` + token presente (no body ou já salvo) → senão 422.
- `GET /api/account/capi/events?limit=` → últimas conversões da conta (`id, status, event_name, value, currency, last_error, created_at, sent_at`).
- `POST /api/account/capi/events/[id]/resend` → seta `status='pending'`, `last_error=null` (só eventos da conta; ownership via `account_id`). 404 se não for da conta.
- `capi-panel.tsx` espelha `webhooks-panel.tsx`: form de config (Dataset ID, Access Token com placeholder mascarado se já existe, evento, toggle ativo) + tabela de eventos recentes com botão "reenviar". Nova seção `capi` em `settings-sections.ts` (grupo workspace, ícone tipo `Target`/`TrendingUp`), admin-only.

### Erros / segurança
- Rotas de gestão: contrato de erro existente; `requireRole('admin')` (403 a não-admin). `dataset_id` e `event_name` validados (não-vazios; `event_name` num conjunto conhecido + custom).
- `access_token` nunca volta em GET/list/log; mascarado no painel; guardado em texto (admin-only RLS, igual `webhook_endpoints.secret`).
- Dispatch best-effort por evento: um evento que falha não derruba o lote; `sendConversionEvent` nunca lança por HTTP; timeout 10s.
- Captura no inbound nunca derruba o webhook (try/catch).
- Multi-tenant: tudo filtrado por `account_id`; trigger usa `NEW.account_id`; cron e rotas nunca cruzam contas.

## Fora de escopo (próximas rodadas)
- Outros eventos/gatilhos (lead qualificado por etapa; lead novo na primeira resposta) — o mapeamento já é extensível.
- Hash de telefone/e-mail como sinal extra de match (advanced matching) além do `ctwa_clid`.
- Criptografar `access_token` em repouso (hoje texto, admin-only — igual ao secret do webhook).
- Backoff exponencial / limite de tentativas com dead-letter (hoje retry simples a cada cron).
- Dedup avançado além do `event_id` que a Meta já usa.
- Janela de atribuição / expiração do `ctwa_clid` no nosso lado (a Meta resolve a atribuição).

## Verificação (E2E)
1. `typecheck` limpo, `npm test` verde, `build` exit 0.
2. Migrations 027/028/029 aplicadas (manual). 
3. **Captura:** lead manda mensagem via anúncio CTWA (payload com `referral.ctwa_clid`) → `contacts.ctwa_clid`/`referral`/`referral_captured_at` preenchidos. Segundo anúncio → sobrescreve. Mensagem sem `referral` → contato intocado.
4. **Config:** painel CAPI (admin) salva Dataset ID + token + evento + ativo; GET nunca devolve o token (só `has_access_token`); `is_active=true` sem dataset/token → 422.
5. **Conversão (caminho feliz):** deal vira `won` (pelo kanban) → trigger enfileira `capi_events` pending → cron envia → `sent` + `sent_at` + `meta_response`; o anúncio recebe a conversão `Purchase` com valor/moeda e `event_id`.
6. **Skips:** deal won de contato **sem** `ctwa_clid` → `skipped`/`no_ctwa_clid`. Deal won de conta **sem CAPI ativo** → `skipped`/`capi_inactive`. Nenhum POST à Meta nesses casos.
7. **Retry/reenvio:** token inválido → `failed` + `last_error`; próximo cron tenta de novo; botão "reenviar" no painel volta pra `pending`.
8. **Isolamento/segurança:** cron sem `x-cron-secret` correto → 401. Não-admin → 403 no painel/rotas. Evento de outra conta nunca aparece/reenvia.
9. **Não-regressão:** API `PATCH /api/v1/deals/{id}` marcando `won` também dispara o trigger (mesmo caminho de banco). Inbound sem referral segue 200 normal.

## Pós-implementação
- Atualizar memória `crm-vantage-api-foundation` (ou nova entrada CAPI): captura de `ctwa_clid` no inbound, `capi_settings` por conta (painel admin), trigger `deal.won` → `capi_events` → cron envia pra Graph API; o loop CRM↔Meta fechado (recebe ad → conversa → devolve conversão). Linkar `[[crm-vantage-api-foundation]]`.

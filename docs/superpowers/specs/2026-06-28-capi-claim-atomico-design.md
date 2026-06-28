# CAPI — claim atômico contra duplo-envio + resend guard — Design

**Data:** 2026-06-28
**Contexto:** Item **#2 (P1)** da auditoria `docs/auditoria/2026-06-28-conflitos-webhooks-apis.md`. Primeiro item do backlog aberto após os webhooks (PRs #23/#24).
**Relacionados:** [[crm-vantage-capi]], auditoria-mãe `2026-06-28-conflitos-webhooks-apis.md`.

## Problema

A fila `capi_events` devolve conversões de Click-to-WhatsApp pra Meta. O processador (`lib/capi/dispatch.ts`) hoje faz:

```
SELECT pending/failed  →  for (ev) { POST pra Meta  →  UPDATE status:'sent' no fim }
```

**Não há claim atômico.** Se dois processos concorrentes pegam a mesma linha, ela é enviada **2×** e a Meta conta a **mesma conversão em dobro** (inflando os números do anúncio e enviesando a otimização). Dois cenários reais:

1. **Cron sobreposto** — um lote de 50 eventos × timeout de 10s pode estourar o `maxDuration=60s` (`capi/cron/route.ts:11`); o próximo ping externo (n8n) entra antes do anterior terminar e relê as mesmas linhas `pending`/`failed`.
2. **Cron + resend manual** — `account/capi/events/[id]/resend/route.ts:28-31` reseta a linha pra `pending` (`attempts:0`) **sem checar o status atual** — pode reenfileirar uma linha que o cron está processando naquele instante.

Única defesa hoje = dedup da Meta por `event_id` (=`deal_id`). Frágil: cai pro `id` da linha quando `deal_id` é null e só vale dentro da janela de dedup da Meta.

## Decisões (do brainstorming)

1. **Escopo enxuto: núcleo + resend guard.** Sem rate-limit no resend (fica pro #11) e sem backoff de retry (fica pro #10).
2. **Mecanismo do claim = lock por `claimed_at` que auto-expira** (sem novo valor de status). Escolhido sobre (B) status `'sending'` — que recria o orphan do #10: crash no meio deixa a linha presa pra sempre — e (C) `SELECT ... FOR UPDATE SKIP LOCKED` — cujo lock de transação não sobrevive ao POST HTTP, exigindo um marcador durável mesmo assim. O `claimed_at` que expira é o padrão two-step UPDATE-by-id já usado no repo (`automations/cron`), **melhorado** com auto-recuperação.
3. **`claimed_at` expira em 5 minutos** → linha presa por crash no meio do POST volta elegível sozinha (reaper embutido; resolve a parte do #10 que mais importa sem puxar escopo).
4. **Sem migration de status** — `capi_events.status` é TEXT livre (sem CHECK em 029), então não mexemos em valores/índices de status. A única mudança de schema é **uma coluna nova** `claimed_at`.
5. **SELECT do lote permanece igual** — a correção é 100% no claim por linha. O lote pode conter linhas que outro worker já pegou; o claim atômico simplesmente as pula. Tradeoff aceito (volume baixo; linhas em voo liberam em segundos).

## Arquitetura

### 1. Migration — `supabase/migrations/037_capi_claim.sql` (novo)

```sql
-- 037: claim atômico da fila CAPI. Lock por claimed_at que expira sozinho,
-- evitando duplo-envio quando dois processos pegam a mesma linha.
ALTER TABLE capi_events ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
```

Sem índice novo: o claim é por `id` (PK). Aplicação **manual** pelo Iago no SQL Editor (banco dedicado), antes do merge/deploy — mesmo gating da 036.

### 2. Claim atômico — `src/lib/capi/dispatch.ts`

Constante: `export const CAPI_CLAIM_TTL_MS = 5 * 60 * 1000`.

No início de cada iteração do loop, **antes** de qualquer trabalho, faz o claim compare-and-set:

```ts
const cutoff = new Date(Date.now() - CAPI_CLAIM_TTL_MS).toISOString()
const { data: claimed } = await admin
  .from('capi_events')
  .update({ claimed_at: new Date().toISOString() })
  .eq('id', id)
  .in('status', ['pending', 'failed'])
  .or(`claimed_at.is.null,claimed_at.lt.${cutoff}`)
  .select('id')
  .maybeSingle()
if (!claimed) continue   // outro worker já pegou (ou em voo) → pula, sem contar
```

Por que é atômico: sob READ COMMITTED, o 2º `UPDATE ... WHERE` concorrente bloqueia no lock de linha do 1º; quando o 1º commita (`claimed_at = now()`), o 2º **re-avalia o predicado** contra a versão nova (EvalPlanQual), não casa mais (claimed_at recente) → 0 linhas → `claimed` é null → pula. Compare-and-set clássico.

`result.processed++` move pra **depois** do claim bem-sucedido (processed = linhas que realmente possuímos e trabalhamos).

Nas atualizações terminais, ajusta `claimed_at`:
- **sent:** mantém o update atual (`status:'sent', sent_at, attempts, meta_response, last_error:null`). Não precisa zerar `claimed_at` (linha terminal, fora do SELECT).
- **failed:** acrescenta `claimed_at: null` → linha volta elegível no próximo lote (respeitando o teto `attempts < MAX_CAPI_ATTEMPTS`). Sem backoff (fora de escopo).
- **skipped (inactive / no_ctwa_clid):** mantém como está (terminal, fora do SELECT — `claimed_at` residual é inócuo).

`attempts` continua incrementado no **send-time** (não no claim) — assim um `skipped` não queima tentativa, preservando a semântica e os testes atuais.

### 3. Resend guard — `src/app/api/account/capi/events/[id]/resend/route.ts`

O SELECT de ownership passa a trazer também `status, claimed_at`. Guarda **antes** de reenfileirar:

- `status === 'pending'` → **409** `{ error: 'Evento já está na fila' }` (nada a fazer).
- linha **em voo** (`claimed_at` não-null **e** `claimed_at > now()-5min`) → **409** `{ error: 'Evento em processamento, tente novamente em alguns minutos' }`.
- caso contrário (`failed` / `skipped` / `sent`, sem claim ativo) → reenfileira: `status:'pending', attempts:0, last_error:null, claimed_at:null`.

Mantém o gate `requireRole('admin')` e o 404 cross-account já existentes. **Permite** reenfileirar um `sent` (resend forçado consciente; a Meta dedupa por `event_id` na janela dela). **Sem rate-limit** (escopo #11).

### 4. Sem mudança em outros caminhos

Cron (`capi/cron/route.ts`) e cliente (`capi/client.ts`) intactos — o claim mora no dispatch, chamado por ambos os caminhos (cron + futuro). Trigger de enqueue (029) intacto.

## Componentes e responsabilidades

| Arquivo | Mudança |
|---|---|
| `supabase/migrations/037_capi_claim.sql` | **novo** — `ADD COLUMN claimed_at` |
| `src/lib/capi/dispatch.ts` | claim atômico por linha; `processed++` pós-claim; `claimed_at:null` no failed; const `CAPI_CLAIM_TTL_MS` |
| `src/lib/capi/dispatch.test.ts` | fake admin claim-aware; testes: claim ok, contenção (claim null → não envia), stale reclamado, failed zera claimed_at |
| `src/app/api/account/capi/events/[id]/resend/route.ts` | SELECT +`status,claimed_at`; guard 409 (pending / em-voo); reset com `claimed_at:null` |
| `src/app/api/account/capi/events/[id]/resend/route.test.ts` | **novo** — 409 pending, 409 em-voo, reset failed/sent ok, 404 cross-account |

## Verificação

- **Unit (vitest):**
  - `dispatch.test.ts`: happy-path com claim retornando linha (`processed:1, sent:1`); **contenção** (claim retorna null → `sendConversionEvent` NÃO chamado, `processed:0`); **stale** (claimed_at antigo → claim casa → envia); **failed** grava `claimed_at:null`. Os 4 testes atuais seguem verdes (claim default = sucesso).
  - `resend/route.test.ts`: pending→409; em-voo (claimed_at recente)→409; failed→reset ok (`claimed_at:null, attempts:0`); sent→reset ok; cross-account→404.
- **Typecheck/lint:** `npx tsc --noEmit`, `npm run lint` (baseline 3), suíte verde.
- **Manual (pós-deploy + migration 037):** ganhar um deal com `ctwa_clid` → ver `capi_events` ir a `sent` 1×; bater o cron 2× em paralelo → sem 2º envio; resend de um `sent` → reenfileira; resend de um `pending` → 409.

## Fora de escopo (YAGNI)

- Rate-limit no resend (#11).
- Backoff de retry / `next_retry_at` (#10).
- Reaper genérico de crons (#10) — o `claimed_at` que expira já cobre o orphan do CAPI.
- Estabilizar `event_id` quando `deal_id` é null (deal_id raramente é null; SET NULL só em delete de deal).
- Filtrar linhas claimadas já no SELECT do lote (otimização; volume baixo não justifica).

## Restrições

- Comentários em **português**. Nunca `git add -A`. PRs → `iv-automacao/crm-vantage`. Lint baseline = 3; `tsc` limpo.
- Migration aplicada **manualmente** pelo Iago no SQL Editor (MCP sem escrita) **antes** do merge/deploy.
- Claim **best-effort** dentro do dispatch: erro no claim não derruba o lote (mesmo contrato atual).

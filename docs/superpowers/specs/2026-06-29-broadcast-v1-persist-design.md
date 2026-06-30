# Broadcast v1 persiste + selo APPROVED no interno — Design

**Data:** 2026-06-29
**Contexto:** Item **#5 (P2)** da auditoria `docs/auditoria/2026-06-28-conflitos-webhooks-apis.md` — os 3 caminhos de envio divergiram. **Escopo escolhido (Opção 1):** o broadcast v1 (API pública) passa a persistir, e a rota de broadcast interna ganha o guard de template APPROVED. **Sem** unificação total (não mexe no client hook/UI).
**Relacionados:** [[crm-vantage-api-foundation]], auditoria-mãe.

## Problema

Dos 3 caminhos de envio:
- **1:1 (inbox):** persiste `messages` no servidor. OK.
- **Broadcast interno (UI):** cria `broadcasts` + `broadcast_recipients` **no client hook** (`use-broadcast-sending.ts`), envia via `/api/whatsapp/broadcast` (fan-out), atualiza recipients com `whatsapp_message_id`. O status webhook acha a linha. **Mas** a rota interna valida só `isMessageTemplate` (malformado), **não** checa `status === 'APPROVED'`.
- **Broadcast v1 (API):** `sendBroadcast` (`broadcasts/api-service.ts`) valida APPROVED, faz fan-out e **retorna `results[]` sem persistir nada**. → sem analytics/histórico, e o status webhook (`webhook/route.ts:357`, casa `broadcast_recipients` por `whatsapp_message_id`) **nunca acha a linha** → todo sent/delivered/read/failed do v1 é perdido. **Bug-mãe.**

## Fatos do schema (destravam o design — sem migration)

- `broadcasts`: `account_id` NOT NULL (017), `user_id` NOT NULL (FK auth.users), `name`/`template_name` NOT NULL, `status` CHECK in (draft|scheduled|sending|sent|failed), counts. Trigger 003 recomputa counts a partir de `broadcast_recipients`.
- `broadcast_recipients`: `contact_id` **NULLABLE** (004 tirou o NOT NULL; FK `ON DELETE SET NULL`). **Sem coluna `phone`.** `whatsapp_message_id` (003, índice único parcial). `status` CHECK in (pending|sent|delivered|read|replied|failed).
- `ApiServiceCtx` (contexto da API key) traz `admin` (service-role), `accountId`, `auditUserId` (= `createdByUserId ?? ownerUserId`) → temos `user_id` pra `broadcasts`.
- Status webhook casa por `whatsapp_message_id` (não precisa de `contact_id`); trigger conta por `status`.

## Decisões (do brainstorming)

1. **v1 persiste via service-role (`ctx.admin`)** — espelha no servidor o que o client hook faz pro interno. Cria `broadcasts` + insere `broadcast_recipients` (1 por destinatário) com o `whatsapp_message_id`, e finaliza o status. O status webhook + trigger passam a funcionar pro v1.
2. **`contact_id` best-effort:** 1 lookup de contatos da conta por telefone → linka quando existe; `null` quando não (sem **criar** contato — não polui a base; respeita a intenção do caller da API). **Limitação aceita:** recipient de telefone que não é contato fica anônimo (sem `phone` próprio na tabela) — contado no agregado, mas não individualmente identificável. Coluna `phone` em `broadcast_recipients` fica como follow-up se incomodar.
3. **Criação do `broadcasts` falha alto (500)** — se não dá pra rastrear, não envia (estado consistente). Já o lookup de contatos e os inserts de recipient/finalização são **best-effort** (a mensagem já saiu; não derrubar por erro de tracking).
4. **Selo no interno:** a rota `whatsapp/broadcast` rejeita (**422**) quando a linha local do template existe e `status !== 'APPROVED'`. Não mexe no caso "template não sincronizado localmente" (templateRow null segue como hoje).
5. **`name` opcional no body do v1** (aditivo): `body.name ?? "API: {template_name}"`.
6. **Não muda:** client hook (UI), status webhook, trigger, RLS. **Sem migration.**

## Arquitetura

### 1. `src/lib/api/schemas/broadcasts.ts`
Adiciona campo opcional ao `BroadcastSendBody`: `name: z.string().min(1).max(120).optional()`.

### 2. `src/lib/broadcasts/api-service.ts` (`sendBroadcast`)
Depois da validação de config + template APPROVED (inalterada), **antes** do fan-out:
- Cria `broadcasts` via `ctx.admin.insert({...}).select('id').single()`:
  `account_id: ctx.accountId`, `user_id: ctx.auditUserId`, `name: body.name ?? ` `` `API: ${body.template_name}` `` , `template_name`, `template_language: body.template_language`, `audience_filter: { type: 'api' }`, `status: 'sending'`, `total_recipients: body.recipients.length`. Se erro → `ApiError(500, ...)`.
- Best-effort: sanitiza os telefones, faz 1 `ctx.admin.from('contacts').select('id, phone').eq('account_id', ctx.accountId).in('phone', sanitizedPhones)` → mapa `phone→id` (em erro, mapa vazio; nunca lança).

No loop de fan-out (existente), pra cada destinatário, **após** computar o resultado (sent+messageId ou failed+error), insere a linha:
- `ctx.admin.from('broadcast_recipients').insert({ broadcast_id, contact_id: map.get(sanitized) ?? null, status: messageId ? 'sent' : 'failed', sent_at: messageId ? <nowIso> : null, whatsapp_message_id: messageId ?? null, error_message: messageId ? null : lastError })` — best-effort (erro só `console.error`; a mensagem já saiu).

Depois do loop: `ctx.admin.from('broadcasts').update({ status: sent === 0 ? 'failed' : 'sent' }).eq('id', broadcastId)` (best-effort). Counts são do trigger.

Retorno: `{ sent, failed, results, broadcast_id }` (campo `broadcast_id` aditivo).

### 3. `src/app/api/whatsapp/broadcast/route.ts`
Após carregar `rawTemplateRow`, antes do `isMessageTemplate`/fan-out: se `rawTemplateRow && rawTemplateRow.status !== 'APPROVED'` → `NextResponse.json({ error: 'Template não está aprovado pela Meta.' }, { status: 422 })`. Mantém tudo o mais.

## Componentes e responsabilidades

| Arquivo | Mudança |
|---|---|
| `src/lib/api/schemas/broadcasts.ts` | +`name` opcional no `BroadcastSendBody` |
| `src/lib/broadcasts/api-service.ts` | `sendBroadcast` cria `broadcasts` + insere `broadcast_recipients` + finaliza status; retorna `broadcast_id` |
| `src/lib/broadcasts/api-service.test.ts` | estende o fake admin (insert/in/update) + testes de persistência |
| `src/app/api/whatsapp/broadcast/route.ts` | guard 422 quando template local não-APPROVED |
| `src/app/api/whatsapp/broadcast/route.test.ts` | **novo** — guard APPROVED + happy path |

## Verificação

- **Unit (vitest):**
  - `api-service.test.ts` (estendido): cria `broadcasts` com `account_id`/`user_id: auditUserId`/`status:'sending'`/`total_recipients`; insere 1 `broadcast_recipients` por destinatário com o `whatsapp_message_id` quando enviado, `status:'failed'`+`error_message` quando falhou; `contact_id` linkado quando o telefone casa um contato, `null` quando não; finaliza `broadcasts.status` (`sent`/`failed`); erro ao criar `broadcasts` → 500; os ~14 testes atuais seguem verdes.
  - `whatsapp/broadcast/route.test.ts` (novo): template PENDING/REJECTED → 422 sem fan-out; template APPROVED → envia; gate `requireRole('admin')`.
  - `schemas/broadcasts.test.ts`: `name` opcional aceito/omitido (se o arquivo já cobre o schema).
- **Typecheck/lint:** `npx tsc --noEmit`, `npm run lint` (sem novos problemas), suíte completa verde.
- **Regressão:** `src/app/api/v1/broadcasts/route.test.ts` — se assertar o shape exato da resposta, ajustar pro campo aditivo `broadcast_id`.
- **Manual:** disparar broadcast via API v1 → conferir linha em `broadcasts` (analytics) + `broadcast_recipients` com `whatsapp_message_id`; status da Meta (delivered/read) reflete nos counts. Broadcast interno com template não-aprovado → 422.

## Fora de escopo (YAGNI)

- Unificação total (core server-side compartilhado; tirar persistência do client hook) — Opção 3, follow-up.
- Coluna `phone` em `broadcast_recipients` (identificar recipient não-contato) — follow-up se incomodar.
- **Criar** contatos a partir de telefones da API (como o CSV faz) — decisão consciente de não poluir a base.
- flow-pause / auto-correção de telefone em broadcast (apropriadamente só no 1:1).
- Idempotência de broadcast (chave de idempotência por request) — #10/futuro.

## Restrições

- Comentários em **português**. Nunca `git add -A`. PRs → `iv-automacao/crm-vantage`. `tsc` limpo; lint sem novos problemas (baseline 3 errors / ~25 problems).
- **Nenhuma migration** — `contact_id` já é nullable (004), `account_id` já existe (017). Tudo via service-role (`ctx.admin`), RLS não se aplica.
- Persistência do `broadcasts` falha alto (500); recipients/finalização best-effort (não derrubar envio já feito).

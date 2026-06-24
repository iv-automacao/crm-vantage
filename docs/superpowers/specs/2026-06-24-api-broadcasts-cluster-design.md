# Design — API pública do cluster Broadcasts (disparo em massa)

**Data:** 2026-06-24 · **Status:** aprovado no brainstorming, aguardando review do spec

## Contexto

Quarto cluster da API pública (`/api/v1`), sobre a fundação `defineRoute` + Zod + OpenAPI e o padrão de serviço account-scoped (ver `crm-vantage-api-foundation`; contatos/deals/conversas já no ar — PRs #9/#10/#11). Objetivo: dar ao agente n8n / terceiros a capacidade de **disparar campanhas por template aprovado** (remarketing, follow-up em massa) via API, e **listar os templates aprovados** disponíveis. É o cluster "saída em escala".

**Consumidor:** agente n8n interno **e** terceiros — robusto desde já. **Cluster sensível:** custa dinheiro por mensagem e mexe com a qualidade/tier do número no WhatsApp → guarda-corpos são parte do design.

## Decisões travadas (brainstorming)

- **Disparo inline com cap.** A API envia na hora (reusa o mecanismo da rota interna) e retorna resultado por destinatário. **Cap de 200 destinatários/chamada.** Assíncrono (fila + status) fica pra evolução futura.
- **Destinatários:** lista explícita `[{phone, params}]`. Audiência por tag/segmento fica pra depois.
- **Um scope:** `broadcasts:send` cobre disparar + listar templates aprovados.

## Fatos do código (grounding)

- `message_templates`: `account_id` (017), `status` enum cru da Meta (`'DRAFT'|'PENDING'|'APPROVED'|'REJECTED'|...`, migration 014). Aprovados = `status='APPROVED'`. Colunas relevantes: `name, language, category, status, body_text, header_type, footer_text, buttons`.
- `whatsapp_config`: account-scoped (`account_id` único), tem `phone_number_id` e `access_token` (criptografado — usar `decrypt` de `@/lib/whatsapp/encryption`).
- Mecanismo de envio (reuso): `sendTemplateMessage(args)` em `src/lib/whatsapp/meta-api.ts` — `args = { phoneNumberId, accessToken, to, templateName, language, params?: string[], template?: row, messageParams? }` → `MetaSendResult` (tem `.messageId`). Lança em erro.
- Helpers de telefone (`@/lib/whatsapp/phone-utils`): `sanitizePhoneForMeta`, `isValidE164`, `phoneVariants` (retry de variante de trunk), `isRecipientNotAllowedError`. Guard de template local: `isMessageTemplate` (`@/lib/whatsapp/template-row-guard`).
- A rota interna `src/app/api/whatsapp/broadcast/route.ts` já faz exatamente esse fan-out inline (carrega config + template uma vez, loop por destinatário com retry de variante) — a camada de serviço da API replica esse núcleo com client service-role + guard de `account_id`.
- Reuso de fundação: `apiKeyServiceCtx`/`ApiServiceCtx` (`@/lib/api/service-context`), `resolveApiKey`, `defineRoute`. Erros tipados `ApiError` (`@/lib/api/errors`).

## Arquitetura (espelha os clusters anteriores)

```
src/lib/api/schemas/broadcasts.ts    # Zod: BroadcastSendBody (recipients .max(200))
src/lib/broadcasts/api-service.ts     # listApprovedTemplates + sendBroadcast, account-scoped
src/lib/auth/api-keys.ts              # +SCOPE_BROADCASTS_SEND em ALL_SCOPES + API_KEY_SCOPE_META
src/lib/api/errors.ts                 # +TemplateNotApprovedError (422), WhatsappNotConfiguredError (409)
src/app/api/v1/broadcasts/route.ts            # POST (disparar) — maxDuration=300
src/app/api/v1/templates/route.ts             # GET (listar aprovados)
src/lib/api/openapi/spec.ts           # registra os 2 endpoints
src/lib/rate-limit.ts                 # preset broadcastSend (apertado, por conta)
```

### Scope
`broadcasts:send` em `ALL_SCOPES` + `API_KEY_SCOPE_META`. Checkboxes do painel já renderizam. Chave sem o scope → 403.

### Endpoints

| Método | Rota | Scope | Ação |
|---|---|---|---|
| GET | `/api/v1/templates` | `broadcasts:send` | Lista templates `APPROVED` da conta |
| POST | `/api/v1/broadcasts` | `broadcasts:send` | Dispara campanha (template + destinatários) |

### Schemas (Zod, `src/lib/api/schemas/broadcasts.ts`)
- `BroadcastSendBody`: `{ template_name: string (min 1), template_language?: string (default 'en_US'), recipients: Array<{ phone: string (min 5), params?: string[] }> (min 1, max 200) }`.
- Respostas:
  - `TemplateResource = { name, language, category: string|null, status, body_text: string|null, variables_count: number }` (variables_count = nº de `{{n}}` no body_text).
  - Disparo: `{ sent: number, failed: number, results: Array<{ phone, status: 'sent'|'failed', whatsapp_message_id?: string, error?: string }> }`.

### Lógica de negócio (`src/lib/broadcasts/api-service.ts`, recebe `ApiServiceCtx`)
- `listApprovedTemplates(ctx)` → `admin.from('message_templates').select('name,language,category,status,body_text').eq('account_id', accountId).eq('status', 'APPROVED').order('name')`. Mapeia pra `TemplateResource[]` (conta `{{n}}` no body com regex `/\{\{\s*\d+\s*\}\}/g`).
- `sendBroadcast(ctx, body)`:
  1. Carrega `whatsapp_config` por `account_id`; ausente → lança `WhatsappNotConfiguredError` (409). `decrypt(config.access_token)`.
  2. Carrega o template por `account_id`+`name`+`language`; ausente OU `status !== 'APPROVED'` → lança `TemplateNotApprovedError(name)` (422). Se a linha existe mas é malformada (`!isMessageTemplate`) → lança `ApiError(500,...)` genérico (loga).
  3. Fan-out inline (igual a rota interna): pra cada destinatário — `sanitizePhoneForMeta` → `isValidE164` (inválido → entrada `failed`, segue) → `phoneVariants` retry chamando `sendTemplateMessage({ phoneNumberId, accessToken, to: variant, templateName, language, params, template })`; sucesso → `{phone, status:'sent', whatsapp_message_id}`; erro → `{phone, status:'failed', error}` (mensagem sanitizada, sem vazar token). Acumula `sent`/`failed`.
  4. Retorna `{ sent, failed, results }`.
- **Tenant:** config/template lidos por `account_id` da chave. Não persiste broadcast (MVP). Identidade sempre da chave.

### Erros (contrato `{ error, code?, details? }`)
- Template não aprovado/inexistente → 422 `template_not_approved`.
- WhatsApp não configurado → 409 `whatsapp_not_configured`.
- `recipients` vazio/>200, `template_name` ausente → 422 (Zod).
- Scope faltando → 403; conta suspensa → 403 `account_pending`; sem Bearer → 401.
- Falha de um destinatário individual NÃO derruba o lote (vira `failed` no `results`).

### Guarda-corpos
- **Cap 200** destinatários (Zod). `export const maxDuration = 300` na rota de broadcast (fan-out sequencial).
- **Rate limit apertado:** preset `broadcastSend` (ex.: `{ limit: 10, windowMs: 60_000 }`) por conta — teto de custo/abuso.
- Compliance (opt-in/opt-out) é responsabilidade do operador; documentar na descrição OpenAPI.

## Fora de escopo (próximas rodadas)
- Persistir `broadcasts`/`broadcast_recipients` + tracking de entrega (status via webhook) e endpoint de status.
- Audiência por tag/segmento; agendamento (`scheduled_at`).
- Disparo assíncrono (fila + worker) pra listas grandes.
- CRUD/submissão de templates via API (só leitura dos aprovados nesta rodada).
- Orquestração (disparar flow + webhooks de saída) — próximos clusters.

## Verificação (E2E)
1. `typecheck` limpo, `npm test` verde, `build` exit 0.
2. Chave com `broadcasts:send` → `GET /api/v1/templates` lista os aprovados; `POST /api/v1/broadcasts {template_name, recipients:[{phone, params:['João']}]}` envia e retorna `{sent:1, failed:0, results:[...]}`.
3. Template não aprovado → 422 `template_not_approved`. WhatsApp não configurado → 409. `recipients` com 201 itens → 422. Chave só com `contacts:read` → 403. Sem Bearer → 401.
4. Telefone inválido no lote → entra como `failed` no `results`, os válidos seguem.
5. `/docs` mostra a tag "Broadcasts"; `/api/openapi.json` inclui os schemas.
6. Isolamento multi-tenant: config/template de outra conta nunca alcançável (guard de `account_id`).

## Pós-implementação
- Atualizar memória `crm-vantage-api-foundation`: cluster Broadcasts no ar, scope `broadcasts:send`, inline+cap 200, persistência/tracking como evolução futura.

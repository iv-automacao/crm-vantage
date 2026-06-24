# Design — API pública do cluster Conversas/Mensagens (leitura)

**Data:** 2026-06-24 · **Status:** aprovado no brainstorming, aguardando review do spec

## Contexto

Terceiro cluster da API pública (`/api/v1`), sobre a fundação `defineRoute` + Zod + OpenAPI e o padrão de serviço account-scoped (ver `crm-vantage-api-foundation`; contatos via PR #9, deals via PR #10 — ambos no ar). Objetivo: dar ao agente n8n / terceiros a capacidade de **ler o contexto da conversa** — histórico de mensagens, status e dados da conversa — pra responder com contexto sem depender só da memória própria do agente, ou pra um terceiro montar painel/relatório. Casa com o loop n8n existente (memória por `conversation_id`, ver `crm-vantage-agent-session-isolation`).

**Consumidor:** agente n8n interno **e** terceiros — robusto desde já.

## Decisões travadas (brainstorming)

- **Read-only nesta rodada.** Sem fechar/reabrir/atribuir (ficam pra próxima — atribuir exige expor membros, ainda não feito).
- **Escopo de leitura:** achar a conversa do contato (por telefone/id) + ver status + ler mensagens (paginado). Sem listagem geral de conversas da conta.
- **Um scope só:** `conversations:read` cobre ler conversa + histórico.

## Fatos do código (grounding)

- `conversations`: `account_id NOT NULL` (017), RLS por `is_account_member`. Colunas: `id, user_id, account_id, contact_id, status ('open'|'pending'|'closed'), assigned_agent_id, last_message_text, last_message_at, unread_count, created_at, updated_at`.
- `messages`: **sem `account_id`** — RLS via conversa pai (igual `contact_tags`/`pipeline_stages`). Colunas: `id, conversation_id, sender_type ('customer'|'agent'|'bot'), sender_id, content_type ('text'|'image'|'document'|'audio'|'video'|'location'|'template'), content_text, media_url, template_name, message_id (id da Meta), status ('sending'|'sent'|'delivered'|'read'|'failed'), created_at`. Index `idx_messages_conversation` em `conversation_id`.
- Reuso: `findContactByPhone`/`getContactById` (`src/lib/contacts/api-service.ts`) pra resolver o contato; helper `apiKeyServiceCtx`/`ApiServiceCtx` (`src/lib/api/service-context.ts`); `resolveApiKey` já traz auditoria. Service-role admin client com guard de `account_id`.

## Arquitetura (espelha os clusters anteriores)

```
src/lib/api/schemas/conversations.ts   # Zod: ConversationContactQuery (xor), MessageListQuery (limit/before)
src/lib/conversations/api-service.ts    # findConversationsByContact/getConversationById/listMessages, account-scoped
src/lib/auth/api-keys.ts                # +SCOPE_CONVERSATIONS_READ em ALL_SCOPES + API_KEY_SCOPE_META
src/app/api/v1/conversations/route.ts              # GET (?contact_phone=/?contact_id=)
src/app/api/v1/conversations/[id]/route.ts         # GET (por id)
src/app/api/v1/conversations/[id]/messages/route.ts # GET (histórico paginado)
src/lib/api/openapi/spec.ts             # registra os 3 endpoints
src/lib/rate-limit.ts                   # preset conversationsRead
```

### Scope
`conversations:read` adicionado a `ALL_SCOPES` + `API_KEY_SCOPE_META` (label PT). Checkboxes do painel já renderizam de `ALL_SCOPES`. Chave sem o scope → 403.

### Endpoints

| Método | Rota | Scope | Ação |
|---|---|---|---|
| GET | `/api/v1/conversations?contact_phone=` (ou `?contact_id=`) | `conversations:read` | Conversa(s) do contato |
| GET | `/api/v1/conversations/{id}` | `conversations:read` | Conversa por id |
| GET | `/api/v1/conversations/{id}/messages?limit=&before=` | `conversations:read` | Histórico paginado |

### Schemas (Zod, `src/lib/api/schemas/conversations.ts`)
- `ConversationContactQuery`: `{ contact_phone?: string, contact_id?: string }` — refine: exatamente um.
- `MessageListQuery`: `{ limit?: number (coerce, 1..100, default 30), before?: string (datetime ISO) }`.
- Respostas:
  - `ConversationResource = { id, contact_id, status, assigned_agent_id: string|null, last_message_text: string|null, last_message_at: string|null, unread_count, created_at, updated_at }`.
  - `MessageResource = { id, sender_type, content_type, content_text: string|null, media_url: string|null, status, created_at }`.
  - Lista de mensagens: `{ messages: MessageResource[], has_more: boolean, next_before: string|null }`.

### Lógica de negócio (`src/lib/conversations/api-service.ts`, recebe `ApiServiceCtx`)
- `findConversationsByContact(ctx, q)` → resolve contato (reusa helpers) → `conversations WHERE account_id AND contact_id` (ordena por `last_message_at desc`). Retorna `ConversationResource[]` (geralmente 1).
- `getConversationById(ctx, id)` → `conversations WHERE id AND account_id` → null lança `NotFoundError`.
- `listMessages(ctx, conversationId, { limit, before })` → **valida a conversa ∈ conta primeiro** (`getConversationById`, lança 404 se não); depois `messages WHERE conversation_id`, `created_at < before` (se houver), `ORDER BY created_at DESC LIMIT limit+1` (pega 1 a mais pra saber `has_more`); inverte pra cronológico (antiga→nova); `next_before` = `created_at` da mensagem mais antiga retornada quando `has_more`.

### Erros (contrato `{ error, code?, details? }`)
- Conversa/contato não encontrado → 404 `not_found`.
- `before` inválido / `limit` fora de faixa → 422 (Zod).
- Scope faltando → 403; conta suspensa → 403 `account_pending`; sem Bearer → 401.

### Rate limit
`conversationsRead` (240/min por conta) em `RATE_LIMITS`; key por `account_id`.

## Fora de escopo (próximas rodadas)
- Escrita: fechar/reabrir, atribuir a membro, marcar como lida.
- Listagem geral de conversas (com filtro por status/paginação).
- Conteúdo rico de mensagem (reações, reply_to, interactive payloads) além dos campos do core.
- Clusters de broadcasts e orquestração.

## Verificação (E2E)
1. `typecheck` limpo, `npm test` verde, `build` exit 0.
2. Chave com `conversations:read` → `GET /api/v1/conversations?contact_phone=` retorna a conversa; `GET /conversations/{id}/messages?limit=10` retorna as 10 mais recentes em ordem cronológica + `has_more`/`next_before`; paginar com `before` traz as anteriores.
3. Conversa de outra conta → 404. Chave só com `contacts:read` → 403. Sem Bearer → 401. `before` inválido → 422.
4. `/docs` mostra a tag "Conversations" com os 3 endpoints; `/api/openapi.json` inclui os schemas.
5. Isolamento multi-tenant: conversa/mensagem de outra conta nunca alcançável (conversa validada ∈ conta antes de ler mensagens; mensagens só por `conversation_id` já validado).

## Pós-implementação
- Atualizar memória `crm-vantage-api-foundation`: cluster Conversas (leitura) no ar, scope `conversations:read`.

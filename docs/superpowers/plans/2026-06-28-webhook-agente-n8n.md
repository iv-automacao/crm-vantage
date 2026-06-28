# Webhook do agente n8n — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar o feed inbound → agente n8n sólido: payload enriquecido com estado da conversa, idempotente contra reentrega da Meta, com pausa do bot por conversa e dispatch não-bloqueante + SSRF-safe.

**Architecture:** O Caminho A (Configurações → Webhooks, `message.received`) é o feed canônico do agente. Adiciona-se um bloco `state` ao payload, um `UNIQUE` parcial em `messages.message_id` (com o handler do webhook tratando `23505` como reentrega e saindo antes dos efeitos), uma coluna `conversations.bot_paused` com botão na inbox, e hardening SSRF (validação de URL + `redirect:'manual'` + timeout) nos dois caminhos de webhook de saída.

**Tech Stack:** Next.js App Router, Supabase (RLS, service-role no webhook), TypeScript, Vitest. Multi-tenant por `account_id`.

## Global Constraints

- Comentários de código em **português**.
- Nunca `git add -A` — sempre `git add <paths explícitos>`.
- Migration aplicada **MANUALMENTE pelo Iago no SQL Editor** (MCP sem escrita). A task da migration só **cria o arquivo** + bloco de verificação estrutural; o índice/coluna devem existir no banco **antes do deploy** do código (senão o insert ainda duplica e o `update bot_paused` falha).
- Blocos de verificação SQL devem ser **SQL puro** (sem prosa misturada) pra não dar erro `42601` no SQL Editor.
- Lint baseline = 3 erros pré-existentes; **não adicionar erro novo**. Rodar `npx tsc --noEmit` limpo.
- PRs → `iv-automacao/crm-vantage`.
- Best-effort: o dispatch do webhook **nunca lança** (não pode derrubar o inbound).
- A janela/segredos e o modelo assíncrono do agente (n8n responde via `/api/external/whatsapp/send`) **não mudam**.

---

### Task 1: Migration 036 — UNIQUE message_id + coluna bot_paused

**Files:**
- Create: `supabase/migrations/036_webhook_idempotency_bot_pause.sql`

**Interfaces:**
- Consumes: schema existente (`messages.message_id TEXT` com índice não-único em `001:178`; `conversations` alterada em 017/030).
- Produces: índice `idx_messages_message_id_unique` (UNIQUE parcial) e coluna `conversations.bot_paused boolean NOT NULL DEFAULT false`. As Tasks 4 e 6 dependem disso no banco (mas o código lê `bot_paused` defensivamente com `?? false`, então typecheck/testes passam sem aplicar).

**Contexto:** toda FK pra `messages.id` é `ON DELETE SET NULL`/`CASCADE` (009/010) → deduplicar mensagens é seguro, os filhos cuidam de si. No banco dedicado o esperado é **zero duplicatas**.

- [ ] **Step 1: Criar o arquivo da migration**

Conteúdo de `supabase/migrations/036_webhook_idempotency_bot_pause.sql`:

```sql
-- 036: Idempotência do inbound + pausa do bot por conversa.
-- Aplicada MANUALMENTE no SQL Editor (banco dedicado). Ver
-- docs/superpowers/specs/2026-06-28-webhook-agente-n8n-design.md
--
-- Contexto: a Meta entrega webhooks at-least-once e re-tenta em timeout/erro.
-- Sem UNIQUE em messages.message_id, a reentrega cria linha duplicada e
-- re-dispara todos os efeitos. Este índice faz o reinsert falhar com 23505,
-- que o handler trata como reentrega (idempotência). message_id pode ser
-- null (nota interna) -> índice PARCIAL.

-- 1) Diagnóstico — rode estes SELECTs em execução SEPARADA, ANTES de aplicar o
--    resto do arquivo (são comentários; o SQL Editor não força a ordem).
--    Esperado: 0 linhas nos dois. Se o 2º vier > 0, decida repontar as reações
--    antes de deletar (senão o CASCADE as remove junto).
-- SELECT message_id, count(*) FROM messages
-- WHERE message_id IS NOT NULL GROUP BY message_id HAVING count(*) > 1;
-- SELECT count(*) FROM message_reactions WHERE message_id IN (
--   SELECT id FROM (
--     SELECT id, row_number() OVER (PARTITION BY message_id ORDER BY created_at, id) AS rn
--     FROM messages WHERE message_id IS NOT NULL
--   ) r WHERE rn > 1);

-- 2) Dedup defensivo: mantém a linha mais antiga por message_id.
--    FKs pra messages.id: reply_to_message_id (009) e flows.last_prompt_message_id
--    (010) são ON DELETE SET NULL (seguro). message_reactions.message_id (009) é
--    ON DELETE CASCADE NOT NULL — se uma duplicata tiver reações, elas somem
--    junto (silenciosamente). No banco dedicado o esperado é ZERO duplicatas
--    (o diagnóstico do passo 1 confirma antes de rodar).
WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY message_id ORDER BY created_at, id) AS rn
  FROM messages
  WHERE message_id IS NOT NULL
)
DELETE FROM messages WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- 3) Índice único parcial — a partir daqui, reentrega = 23505 no insert.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_message_id_unique
  ON messages (message_id) WHERE message_id IS NOT NULL;

-- 4) Pausa do bot por conversa (default false = bot ativo, modelo "bot 24/7").
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS bot_paused boolean NOT NULL DEFAULT false;
```

- [ ] **Step 2: Adicionar o bloco de verificação estrutural (SQL puro, no fim do MESMO arquivo)**

```sql
-- ===== VERIFICAÇÃO (rodar após aplicar; espera-se tudo true) =====
SELECT
  EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_messages_message_id_unique'
  ) AS idx_unique_existe,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'conversations' AND column_name = 'bot_paused'
  ) AS coluna_bot_paused_existe,
  (SELECT count(*) FROM (
     SELECT message_id FROM messages
     WHERE message_id IS NOT NULL
     GROUP BY message_id HAVING count(*) > 1
   ) d) = 0 AS sem_duplicatas;
```

- [ ] **Step 3: Verificar typecheck/suite continuam intactos (a migration não toca TS)**

Run: `npx tsc --noEmit`
Expected: sem erros novos.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/036_webhook_idempotency_bot_pause.sql
git commit -m "feat(webhook): migration 036 — UNIQUE message_id + conversations.bot_paused"
```

> **NOTA pro orquestrador:** após o commit, pausar pra o Iago APLICAR a migration no SQL Editor e colar o resultado da verificação (`idx_unique_existe`, `coluna_bot_paused_existe`, `sem_duplicatas` = todos true) ANTES do merge/deploy. As Tasks 2-6 podem prosseguir em paralelo (não dependem da aplicação, só do banco no deploy).

---

### Task 2: Hardening SSRF em `isValidWebhookUrl`

**Files:**
- Modify: `src/lib/webhooks/secret.ts:33-36`
- Modify: `src/app/api/account/webhooks/route.ts:61-64` (mensagem de erro — Step 5)
- Test: `src/lib/webhooks/secret.test.ts:36-66`

**Interfaces:**
- Consumes: nada novo (função pura).
- Produces: `isValidWebhookUrl(url: unknown): url is string` — agora rejeita também hosts loopback/privados/link-local/metadata e exige host parseável. Consumida por `dispatch.ts` (Task 3), `engine.ts` (Task 5) e já por `account/webhooks/route.ts`.

- [ ] **Step 1: Atualizar os testes (RED) — virar o caso localhost e adicionar bloqueios SSRF**

> Nota: o teste existente `it("aceita URLs http://", …)` que afirma `http://localhost:5678/webhook` → `true` (`secret.test.ts:42-44`) **será removido** na substituição abaixo — era o comportamento OLD (localhost agora é bloqueado). É esperado deletar um teste que hoje passa.

Substituir o `describe("isValidWebhookUrl", …)` inteiro (`secret.test.ts:36-66`) por:

```ts
describe("isValidWebhookUrl", () => {
  it("aceita URLs https:// públicas", () => {
    expect(isValidWebhookUrl("https://example.com/hook")).toBe(true);
    expect(isValidWebhookUrl("https://hooks.vantagemanaus.com.br/webhook/x")).toBe(true);
  });

  it("aceita http:// pra host público (incluindo IP público literal)", () => {
    expect(isValidWebhookUrl("http://example.com/webhook")).toBe(true);
    expect(isValidWebhookUrl("http://203.0.113.5/webhook")).toBe(true);
  });

  it("rejeita string vazia / só espaços", () => {
    expect(isValidWebhookUrl("")).toBe(false);
    expect(isValidWebhookUrl("   ")).toBe(false);
  });

  it("rejeita outros protocolos", () => {
    expect(isValidWebhookUrl("ftp://example.com")).toBe(false);
    expect(isValidWebhookUrl("ws://example.com")).toBe(false);
    expect(isValidWebhookUrl("javascript:alert(1)")).toBe(false);
  });

  it("rejeita valores não-string", () => {
    expect(isValidWebhookUrl(null)).toBe(false);
    expect(isValidWebhookUrl(undefined)).toBe(false);
    expect(isValidWebhookUrl(42)).toBe(false);
    expect(isValidWebhookUrl({})).toBe(false);
  });

  it("rejeita URL não-parseável", () => {
    expect(isValidWebhookUrl("http://")).toBe(false);
    expect(isValidWebhookUrl("not a url")).toBe(false);
  });

  it("bloqueia localhost e domínios internos (SSRF)", () => {
    expect(isValidWebhookUrl("http://localhost:5678/webhook")).toBe(false);
    expect(isValidWebhookUrl("http://foo.local/x")).toBe(false);
    expect(isValidWebhookUrl("http://api.localhost/x")).toBe(false);
  });

  it("bloqueia IPv4 privado / loopback / link-local / metadata (SSRF)", () => {
    expect(isValidWebhookUrl("http://127.0.0.1/x")).toBe(false);
    expect(isValidWebhookUrl("https://10.1.2.3/x")).toBe(false);
    expect(isValidWebhookUrl("http://192.168.0.1/x")).toBe(false);
    expect(isValidWebhookUrl("http://172.16.5.4/x")).toBe(false);
    expect(isValidWebhookUrl("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isValidWebhookUrl("http://0.0.0.0/x")).toBe(false);
  });

  it("NÃO bloqueia IPv4 público fora das faixas privadas", () => {
    expect(isValidWebhookUrl("http://172.32.5.4/x")).toBe(true); // 172.32 não é privado
    expect(isValidWebhookUrl("http://8.8.8.8/x")).toBe(true);
  });

  it("bloqueia IPv6 loopback / ULA / link-local / unspecified (SSRF)", () => {
    expect(isValidWebhookUrl("http://[::1]/x")).toBe(false);
    expect(isValidWebhookUrl("http://[fc00::1]/x")).toBe(false);
    expect(isValidWebhookUrl("http://[fe80::1]/x")).toBe(false);
    expect(isValidWebhookUrl("http://[::]/x")).toBe(false);
  });

  it("bloqueia IPv4-mapped IPv6 (bypass SSRF ::ffff:)", () => {
    expect(isValidWebhookUrl("http://[::ffff:127.0.0.1]/x")).toBe(false);
    expect(isValidWebhookUrl("http://[::ffff:10.0.0.1]/x")).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar os testes pra confirmar que falham (RED)**

Run: `npx vitest run src/lib/webhooks/secret.test.ts`
Expected: FAIL — vários casos novos falham (ex.: `http://localhost…` ainda retorna `true`; IPs internos retornam `true`).

- [ ] **Step 3: Implementar — substituir `isValidWebhookUrl` em `secret.ts:33-36`**

```ts
/**
 * Valida a URL de destino do webhook.
 * Exige http(s) e um host parseável, e REJEITA hosts internos
 * (loopback, privado, link-local, metadata de cloud) — hardening SSRF.
 * Limitação conhecida: validação síncrona só pega IP literal; um hostname
 * que resolva pra IP interno via DNS não é coberto aqui (mitigado por
 * `redirect:'manual'` no dispatch). Suficiente pro nosso modelo (n8n é
 * infra própria com domínio público).
 */
export function isValidWebhookUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.trim().length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (!parsed.hostname) return false;
  return !isInternalHost(parsed.hostname);
}

/** True se o host é loopback/privado/link-local/metadata (não deve receber webhook). */
function isInternalHost(rawHost: string): boolean {
  // Remove colchetes de IPv6 (ex.: "[::1]" -> "::1") e normaliza caixa.
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, "");

  // Nomes internos comuns.
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return true;
  }

  // IPv6 literal (contém ":") — bloqueia faixas internas conhecidas.
  if (host.includes(":")) {
    if (host === "::1" || host === "::") return true;        // loopback / unspecified
    if (host.startsWith("fc") || host.startsWith("fd")) return true; // ULA fc00::/7
    if (host.startsWith("fe80")) return true;               // link-local
    if (host.startsWith("::ffff:")) return true;            // IPv4-mapped (ex.: ::ffff:127.0.0.1) — bypass SSRF
    return false; // IPv6 público (ex.: 2001:db8::1) é permitido
  }

  // IPv4 literal?
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 127) return true;                       // loopback 127.0.0.0/8
    if (a === 10) return true;                        // privado 10.0.0.0/8
    if (a === 0) return true;                         // "this network" 0.0.0.0/8
    if (a === 169 && b === 254) return true;          // link-local + metadata 169.254/16
    if (a === 172 && b >= 16 && b <= 31) return true; // privado 172.16.0.0/12
    if (a === 192 && b === 168) return true;          // privado 192.168.0.0/16
  }

  return false;
}
```

- [ ] **Step 4: Rodar os testes (GREEN)**

Run: `npx vitest run src/lib/webhooks/secret.test.ts`
Expected: PASS — todos os casos (incluindo os SSRF e o localhost agora `false`).

- [ ] **Step 5: Atualizar a mensagem de erro do cadastro de webhook**

A função agora rejeita hosts internos, mas `account/webhooks/route.ts:62` ainda diz "informe uma URL começando com http:// ou https://" (enganoso). Substituir o objeto de erro (`route.ts:61-64`) por:

```ts
      return NextResponse.json(
        { error: "URL inválida — use http(s) com host público (localhost/IPs internos são bloqueados)" },
        { status: 400 },
      );
```

- [ ] **Step 6: Rodar a suíte de webhooks + typecheck (GREEN)**

Run: `npx vitest run src/lib/webhooks/secret.test.ts && npx tsc --noEmit`
Expected: PASS (todos os casos, incluindo SSRF/`::ffff:`/localhost agora `false`), sem erro de tipo.

- [ ] **Step 7: Commit**

```bash
git add src/lib/webhooks/secret.ts src/lib/webhooks/secret.test.ts src/app/api/account/webhooks/route.ts
git commit -m "feat(webhook): isValidWebhookUrl bloqueia hosts internos + msg de cadastro (SSRF #3)"
```

---

### Task 3: Payload `state` + hardening do dispatch de saída

**Files:**
- Modify: `src/lib/webhooks/dispatch.ts`
- Test: `src/lib/webhooks/dispatch.test.ts`

**Interfaces:**
- Consumes: `isValidWebhookUrl` (Task 2).
- Produces:
  - `MessageReceivedPayload` agora tem `state: { bot_paused: boolean; assigned_agent_id: string | null; conversation_status: string }`.
  - `buildMessageReceivedPayload(args)` agora exige `args.state` (mesmo shape). Consumida pela Task 4.

> **Nota (evita confusão na edição):** `dispatch.ts:54` **já tem** `signal: AbortSignal.timeout(10_000)`. As adições REAIS aqui são o guard `isValidWebhookUrl(ep.url)` e `redirect: 'manual'`. O bloco do Step 3 substitui o corpo INTEIRO do `Promise.all` (por isso re-inclui o timeout que já existia) — não é timeout novo.

- [ ] **Step 1: Atualizar testes (RED) — `state` no payload, guard de URL e redirect**

Em `dispatch.test.ts`: (a) adicionar `state` ao `basePayload` (linha 16-22); (b) atualizar o teste de `buildMessageReceivedPayload` (linha 24-39); (c) adicionar testes do guard de URL interna e do `redirect:'manual'`.

Substituir o `basePayload` (linhas 16-22) por:

```ts
const basePayload: MessageReceivedPayload = {
  event: 'message.received',
  account_id: 'acc1',
  conversation_id: 'conv1',
  contact: baseContact,
  state: { bot_paused: false, assigned_agent_id: null, conversation_status: 'open' },
  meta: { message: { text: 'oi' }, contact: {}, metadata: {} },
}
```

Substituir o teste `buildMessageReceivedPayload` (linhas 24-40) por:

```ts
describe('buildMessageReceivedPayload', () => {
  it('monta o objeto com event message.received e bloco state', () => {
    const result = buildMessageReceivedPayload({
      accountId: 'acc1',
      conversationId: 'conv1',
      contact: baseContact,
      state: { bot_paused: true, assigned_agent_id: 'agent-9', conversation_status: 'pending' },
      metaMessage: { text: 'oi' },
      metaContact: {},
      metaMetadata: {},
    })
    expect(result.event).toBe('message.received')
    expect(result.account_id).toBe('acc1')
    expect(result.conversation_id).toBe('conv1')
    expect(result.contact).toEqual(baseContact)
    expect(result.state).toEqual({ bot_paused: true, assigned_agent_id: 'agent-9', conversation_status: 'pending' })
    expect(result.meta).toEqual({ message: { text: 'oi' }, contact: {}, metadata: {} })
  })
})
```

Adicionar, dentro do `describe('dispatchMessageReceived', …)`, dois testes novos:

```ts
  it('endpoint com URL interna (SSRF) → fetch NÃO é chamado pra ele', async () => {
    const admin = makeAdmin([{ id: 'epbad', url: 'http://169.254.169.254/latest', secret: 's' }])

    await dispatchMessageReceived(admin, 'acc1', basePayload)

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetch é chamado com redirect:manual (não segue redirect pra interno)', async () => {
    const admin = makeAdmin([{ id: 'ep1', url: 'https://n8n.example.com/webhook/abc', secret: 's' }])

    await dispatchMessageReceived(admin, 'acc1', basePayload)

    const [, init] = fetchMock.mock.calls[0]
    expect(init.redirect).toBe('manual')
  })
```

- [ ] **Step 2: Rodar os testes (RED)**

Run: `npx tsc --noEmit` e depois `npx vitest run src/lib/webhooks/dispatch.test.ts`
Expected: o RED aqui é **erro de compilação TypeScript** (TS2322/TS2353 — falta `state` em `MessageReceivedPayload` e no arg de `buildMessageReceivedPayload`); após o tipo compilar, os 2 testes novos (guard de URL interna e `redirect:'manual'`) falham.

- [ ] **Step 3: Implementar — interface, build e dispatch em `dispatch.ts`**

Substituir a interface `MessageReceivedPayload` e a função `buildMessageReceivedPayload`:

```ts
export interface MessageReceivedPayload {
  event: 'message.received'
  account_id: string
  conversation_id: string
  contact: { id: string; phone: string; name: string | null }
  // Estado da conversa pro n8n decidir se responde (bot 24/7 + pausa manual).
  state: {
    bot_paused: boolean
    assigned_agent_id: string | null
    conversation_status: string
  }
  meta: { message: unknown; contact: unknown; metadata: unknown }
}

export function buildMessageReceivedPayload(args: {
  accountId: string
  conversationId: string
  contact: { id: string; phone: string; name: string | null }
  state: { bot_paused: boolean; assigned_agent_id: string | null; conversation_status: string }
  metaMessage: unknown
  metaContact: unknown
  metaMetadata: unknown
}): MessageReceivedPayload {
  return {
    event: 'message.received',
    account_id: args.accountId,
    conversation_id: args.conversationId,
    contact: args.contact,
    state: args.state,
    meta: { message: args.metaMessage, contact: args.metaContact, metadata: args.metaMetadata },
  }
}
```

Adicionar o import no topo (junto do `signWebhookPayload`):

```ts
import { isValidWebhookUrl } from './secret'
```

Substituir o corpo do `Promise.all(endpoints.map(...))` dentro de `dispatchMessageReceived` por (mantendo o resto da função igual):

```ts
    await Promise.all(endpoints.map(async (ep: { id: string; url: string; secret: string }) => {
      // Hardening SSRF (#3): não dispara pra host interno/loopback/metadata.
      if (!isValidWebhookUrl(ep.url)) {
        console.warn(`[webhooks] endpoint ${ep.id} URL inválida/bloqueada — pulando`)
        return
      }
      try {
        const res = await fetch(ep.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-webhook-event': 'message.received',
            'x-webhook-signature': signWebhookPayload(rawBody, ep.secret),
          },
          body: rawBody,
          redirect: 'manual', // não seguir redirect pra rede interna
          signal: AbortSignal.timeout(10_000),
        })
        if (!res.ok) console.warn(`[webhooks] endpoint ${ep.id} retornou ${res.status}`)
      } catch (e) {
        console.warn(`[webhooks] endpoint ${ep.id} falhou:`, e instanceof Error ? e.message : e)
      }
    }))
```

- [ ] **Step 4: Rodar os testes (GREEN)**

Run: `npx vitest run src/lib/webhooks/dispatch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/webhooks/dispatch.ts src/lib/webhooks/dispatch.test.ts
git commit -m "feat(webhook): payload state + guard SSRF/redirect no dispatch de saida"
```

---

### Task 4: Wiring no webhook de entrada — idempotência + dispatch reordenado com state

**Files:**
- Modify: `src/app/api/whatsapp/webhook/route.ts` (bloco `:629-632`, bloco `:634-647`, e fim do `processMessage` ~`:781`)

**Interfaces:**
- Consumes: `isUniqueViolation` — o import na **linha 6** (`import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'`) JÁ cobre o novo uso; **não adicionar import**. `buildMessageReceivedPayload`/`dispatchMessageReceived` com o novo `state` (Task 3); coluna `conversations.bot_paused` (Task 1, lida via re-SELECT fresco).
- Produces: nada novo (mudança interna do handler).

**Contexto:** hoje o `dispatchMessageReceived` está em `:636` (ANTES do autoassign, `await`-ado, serializando contadores **e** o flow runner/automações que vêm depois). Com o `UNIQUE` da Task 1, o reinsert duplicado falha com 23505 e o `if (msgError) return` já pula os efeitos — precisamos **silenciar o log** (reentrega é esperada) e **mover o dispatch pro FIM do `processMessage`** (por último, depois de autoassign/flow runner/automações), com o `state` lido fresco do banco. Continua `await`-ado: todo o handler roda dentro de `after()` (`:193`), onde um promise solto pode ser cortado antes de completar — o ganho de "não-bloqueante" vem de rodar **por último**, não de remover o `await`. **Não tocar** no bloco de autoassign nem nos blocos intermediários.

- [ ] **Step 1: Idempotência — tratar 23505 como reentrega (silenciosa)**

Substituir o bloco `if (msgError) { … }` (`route.ts:629-632`) por:

```ts
  if (msgError) {
    // Reentrega da Meta (at-least-once): com o índice único parcial em
    // messages(message_id) (migration 036), reinserir a MESMA mensagem
    // falha com 23505. Isso é ESPERADO — tratamos como duplicata e saímos
    // ANTES de qualquer efeito colateral (dispatch, CAPI, autoassign,
    // contadores), tornando o processamento idempotente.
    if (isUniqueViolation(msgError)) {
      return
    }
    console.error('Error inserting message:', msgError)
    return
  }
```

- [ ] **Step 2: Remover APENAS o dispatch antigo (linhas 634-647)**

Apagar **só** o bloco `route.ts:634-647` — o comentário "Webhook de saída (best-effort)…" + a chamada `await dispatchMessageReceived(...)` inteira (até o `)` que fecha `buildMessageReceivedPayload({...})`). **NÃO tocar** em mais nada: `captureCtwaReferral` (`:649-652`), o update da conversa/`unread_count` (`:655-667`), `flagBroadcastReplyIfAny` (`:672`) e o **bloco de autoassign inteiro** (`:674-698`) ficam **intactos**. O `captureCtwaReferral` passa a vir logo após o `if (msgError)`.

- [ ] **Step 3: Adicionar o dispatch POR ÚLTIMO, no fim do `processMessage`, com state fresco**

NÃO mexer no bloco de autoassign. Adicionar o dispatch **logo antes do `}` que fecha `processMessage`** — depois do `for (const triggerType of automationTriggers) { … }` (~`:781`). Re-lê a conversa pra o `state` ficar fresco (o autoassign já gravou `assigned_agent_id`; o vendedor pode ter mudado `bot_paused` no meio):

```ts
  // Webhook de saída do agente (best-effort, Caminho A): reencaminha o payload
  // completo da Meta + o estado FRESCO da conversa (bot_paused, dono, status)
  // pros endpoints da conta, pro n8n decidir se responde. Roda POR ÚLTIMO
  // (depois de autoassign, flow runner e automações) pra não serializar o
  // caminho crítico; AWAITED porque dentro do after() um promise solto pode ser
  // cortado antes de completar. Re-lê a conversa pra o state não vir stale
  // (assigned_agent_id pós-autoassign; bot_paused mudado no meio). Nunca lança.
  const { data: freshConv } = await supabaseAdmin()
    .from('conversations')
    .select('status, assigned_agent_id, bot_paused')
    .eq('id', conversation.id)
    .maybeSingle()
  await dispatchMessageReceived(
    supabaseAdmin(),
    accountId,
    buildMessageReceivedPayload({
      accountId,
      conversationId: conversation.id,
      contact: { id: contactRecord.id, phone: contactRecord.phone, name: contactRecord.name ?? null },
      state: {
        bot_paused: freshConv?.bot_paused ?? false,
        assigned_agent_id: (freshConv?.assigned_agent_id as string | null) ?? null,
        conversation_status: String(freshConv?.status ?? conversation.status ?? 'open'),
      },
      metaMessage: message,
      metaContact: contact,
      metaMetadata: metaMetadata,
    }),
  )
```

- [ ] **Step 4: Verificar typecheck + suite completa**

Run: `npx tsc --noEmit`
Expected: sem erros.

Run: `npx vitest run`
Expected: PASS (suite inteira verde; nenhuma regressão).

> Justificativa de teste: `processMessage` é um handler grande não-exportado; um teste unitário exigiria mock pesado de Supabase/Meta e re-asseguraria peças já testadas (`isUniqueViolation`, `buildMessageReceivedPayload`). A verificação aqui é typecheck + suite verde + a revisão final de branch. Não inventar teste que só duplica mocks.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/whatsapp/webhook/route.ts
git commit -m "feat(webhook): inbound idempotente (23505) + dispatch por ultimo com state fresco"
```

---

### Task 5: Hardening do `send_webhook` (ação de automação — Caminho B)

**Files:**
- Modify: `src/lib/automations/engine.ts:1-15` (import) e `:529-540` (case `send_webhook`)

**Interfaces:**
- Consumes: `isValidWebhookUrl` (Task 2).
- Produces: nada novo.

**Contexto:** o `fetch` do `send_webhook` hoje não tem timeout (pode pendurar) nem validação de URL (auditoria #3). Payload do Caminho B **fica como está** (é pra notificação) — só segurança.

- [ ] **Step 1: Adicionar o import de `isValidWebhookUrl` no topo de `engine.ts`**

Adicionar junto aos demais imports (ex.: após os imports de `@/types`):

```ts
import { isValidWebhookUrl } from '@/lib/webhooks/secret'
```

- [ ] **Step 2: Endurecer o case `send_webhook` (`engine.ts:529-540`)**

Substituir o `case 'send_webhook': { … }` por:

```ts
    case 'send_webhook': {
      const cfg = step.step_config as SendWebhookStepConfig
      if (!cfg.url) throw new Error('send_webhook needs url')
      // Hardening SSRF (#3): rejeita host interno/loopback/metadata + exige http(s).
      if (!isValidWebhookUrl(cfg.url)) throw new Error('send_webhook: URL inválida ou bloqueada')
      const body = cfg.body_template ? interpolate(cfg.body_template, args) : JSON.stringify(args.context)
      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.headers ?? {}) },
        body,
        redirect: 'manual',                  // não seguir redirect pra interno
        signal: AbortSignal.timeout(10_000), // antes NÃO havia timeout (podia pendurar)
      })
      if (!res.ok) throw new Error(`webhook returned ${res.status}`)
      return `webhook ${res.status}`
    }
```

- [ ] **Step 3: Verificar typecheck + suite**

Run: `npx tsc --noEmit`
Expected: sem erros.

Run: `npx vitest run src/lib/automations/engine.test.ts`
Expected: PASS (sem regressão; o erro é lançado e capturado como os demais do engine).

> Justificativa de teste: a guarda reaproveita `isValidWebhookUrl` (já testada na Task 2) dentro de `executeStepsFrom` (não-exportada). Um teste de integração via `runAutomationsForTrigger` exigiria montar uma automação inteira só pra reafirmar a função já testada — desproporcional. Verificação por typecheck + suite.

- [ ] **Step 4: Commit**

```bash
git add src/lib/automations/engine.ts
git commit -m "feat(automations): send_webhook com timeout + SSRF guard (#3)"
```

---

### Task 6: Botão "Pausar bot" na conversa

**Files:**
- Modify: `src/types/index.ts:147-159` (tipo `Conversation`)
- Modify: `src/components/inbox/message-thread.tsx` (import de ícone, estado local, handler, botão no header)

**Interfaces:**
- Consumes: coluna `conversations.bot_paused` (Task 1); padrão de update direto via `createClient()` já usado em `message-thread.tsx` (ex.: `handleStatusChange` `:561-574`).
- Produces: nada (UI).

- [ ] **Step 1: Adicionar `bot_paused` ao tipo `Conversation`**

Em `src/types/index.ts`, dentro de `interface Conversation` (após `assigned_agent_id?: string;`, linha 152):

```ts
  bot_paused?: boolean;
```

- [ ] **Step 2: Importar o ícone `Bot`**

Em `message-thread.tsx`, adicionar `Bot` à lista de imports do `lucide-react` (linhas 16-26), ex. após `RefreshCw,`:

```ts
  Bot,
```

- [ ] **Step 3: Estado local + sincronização com a conversa selecionada**

Logo após os outros `useState` do componente (junto do topo da função, antes dos efeitos), adicionar:

```ts
  // Pausa do bot do agente nesta conversa (otimista; espelha conversations.bot_paused).
  const [botPaused, setBotPaused] = useState<boolean>(conversation?.bot_paused ?? false);

  useEffect(() => {
    setBotPaused(conversation?.bot_paused ?? false);
  }, [conversation?.id, conversation?.bot_paused]);
```

- [ ] **Step 4: Handler de toggle (update direto via client, otimista + rollback)**

Adicionar junto aos outros `useCallback` (ex.: após `handleStatusChange`, `:574`):

```ts
  const handleToggleBot = useCallback(async () => {
    if (!conversation) return;
    const next = !botPaused;
    setBotPaused(next); // otimista
    const supabase = createClient();
    const { error } = await supabase
      .from("conversations")
      .update({ bot_paused: next })
      .eq("id", conversation.id);
    if (error) {
      setBotPaused(!next); // rollback
      toast.error("Não foi possível alterar o bot.");
    }
  }, [conversation, botPaused]);
```

- [ ] **Step 5: Botão no header**

No grupo de ações do header (`<div className="flex items-center gap-2">`, `:855`), adicionar ANTES do bloco "Manual refresh" (`:888`):

```tsx
          {/* Pausar/ativar o bot do agente nesta conversa. Pausado → o n8n
              recebe o webhook com state.bot_paused:true e decide não
              responder, deixando o atendimento pro humano. */}
          <button
            type="button"
            onClick={handleToggleBot}
            aria-pressed={botPaused}
            aria-label={botPaused ? "Ativar bot nesta conversa" : "Pausar bot nesta conversa"}
            title={botPaused ? "Bot pausado — clique pra reativar" : "Bot ativo — clique pra pausar"}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs transition-colors hover:bg-muted",
              botPaused ? "text-amber-500" : "text-primary",
            )}
          >
            <Bot className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{botPaused ? "Bot pausado" : "Bot ativo"}</span>
          </button>
```

- [ ] **Step 6: Verificar typecheck + build + lint**

Run: `npx tsc --noEmit`
Expected: sem erros.

Run: `npx vitest run`
Expected: PASS (sem regressão).

Run: `npm run lint`
Expected: sem erro novo (baseline 3). É a 1ª vez que o lint roda no branch — se aparecer > 3 erros, algo novo entrou. O commit do Step 7 inclui o import `Bot` (Step 2) JUNTO com o uso (Step 5) — commitar o import sem o uso quebraria `no-unused-vars`.

> Justificativa de teste: os componentes da inbox não têm testes unitários no repo; o handler reaproveita o padrão de `handleStatusChange` (update direto via `createClient()`). Verificação por typecheck/build/lint + conferência manual no header.

- [ ] **Step 7: Commit**

```bash
git add src/types/index.ts src/components/inbox/message-thread.tsx
git commit -m "feat(inbox): botao Pausar bot por conversa (conversations.bot_paused)"
```

---

## Self-Review

**1. Spec coverage:**
- Contrato de disparo (payload `state`) → Task 3 (build) + Task 4 (wiring). ✅
- Pausa do bot (`conversations.bot_paused` + botão) → Task 1 (coluna) + Task 6 (UI). ✅
- Idempotência (UNIQUE message_id + gate 23505) → Task 1 (índice) + Task 4 (gate). ✅
- Não-bloqueante & ordem (dispatch pós-autoassign) → Task 4. ✅
- Hardening SSRF (A e B) + timeout no B → Task 2 (função) + Task 3 (A) + Task 5 (B). ✅
- Tempo de resposta (modelo assíncrono) → sem mudança de código (recap na spec). ✅
- Fora de escopo (Caminho B payload, outbox, demais achados) → não há tasks (correto). ✅

**2. Placeholder scan:** sem TBD/TODO; todo step de código traz o código completo. ✅

**3. Type consistency:** `MessageReceivedPayload.state` e o arg `state` de `buildMessageReceivedPayload` têm o MESMO shape `{ bot_paused: boolean; assigned_agent_id: string | null; conversation_status: string }` (Tasks 3 e 4). `Conversation.bot_paused?: boolean` (Task 6) lido como `conversation.bot_paused ?? false` (Task 4). `isValidWebhookUrl` mesma assinatura em todos os consumidores (Tasks 2/3/5). `assignedAgentId: string | null` consistente com `state.assigned_agent_id`. ✅

## Notas de risco / atenção pro executor

- **Ordem de aplicação:** a migration 036 precisa estar no banco ANTES do deploy do código da Task 4/6 (senão o insert duplica e o `update bot_paused` falha por coluna inexistente). O código é defensivo no read (`?? false`), mas o write da Task 6 exige a coluna.
- **`conversation` no webhook é linha `select('*')`** (untyped) — `conversation.bot_paused`/`.status` existem em runtime pós-migration; pré-migration `bot_paused` é `undefined` → `?? false`.
- **Re-fetch de mídia em reentrega:** o gate 23505 ocorre no insert (após `parseMessageContent`, que pode buscar mídia na Meta). Numa reentrega, a mídia é buscada de novo antes do 23505 — ineficiência aceita (lean), não afeta correção.
- **Limitação SSRF:** validação síncrona pega IP literal (incluindo IPv4-mapped `::ffff:`); hostname que resolve pra IP interno via DNS não é coberto (mitigado por `redirect:'manual'`). Aceito pro modelo (n8n público).
- **Runbook de deploy:** (1) aplicar a migration 036 ANTES do deploy do código; (2) rodar `SELECT id, url FROM webhook_endpoints WHERE is_active;` e desativar/corrigir qualquer URL interna/localhost — com a Task 2, esses endpoints passam a ser **pulados** no dispatch (com `console.warn`), silenciosamente.
- **Race de 2 conversas (NÃO tratado, fora de escopo):** `findOrCreateConversation` (`route.ts:999-1034`) não tem catch de 23505 nem índice único em `conversations(account_id, contact_id)` — 2 mensagens concorrentes do MESMO contato novo podem criar 2 conversas (auditoria #3). O gate de `message_id` **não** resolve isso. Permanece conhecido e fora desta fatia (lean).
- **Idempotência cobre reentrega, não o race de #9:** o gate 23505 mata o double-count de `unread_count` APENAS na reentrega do mesmo `message_id`; o race de 2 mensagens DISTINTAS concorrentes (read-modify-write em `route.ts:660`) permanece (fora de escopo).

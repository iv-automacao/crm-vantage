# RBAC do CRM VANTAGE — matriz de papéis e endurecimento de autorização

> Status: **aprovado pra implementação** (2026-06-26). Desenho validado por auditoria
> multi-agente contra o código real (31 agentes, 24 achados confirmados). Implementação
> em 3 fases: **Fase 0 (P0 de segurança)**, **Fase 1 (write/guards)**, **Fase 2 (visibilidade)**.

## Objetivo

Delimitar e **fazer valer** o que cada papel de conta pode fazer no CRM. Hoje existe a
fundação (`src/lib/auth/roles.ts` + `requireRole` em `src/lib/auth/account.ts`), mas várias
rotas operacionais sensíveis estão **sem guard de papel** — qualquer membro autenticado cria
template, edita config do WhatsApp, dispara broadcast, mexe em automações/flows. Além disso a
auditoria achou um **escalonamento de privilégio ao vivo**: qualquer membro vira `owner` da
própria conta via update direto em `profiles`.

Este documento fixa a política (matriz papel × ação) e o plano de enforcement em camadas
(guard de app + RLS), faseado por risco.

## Modelo de papéis (mantido)

Enum `account_role_enum` (migration `017_account_sharing.sql:53`), hierarquia ordinal espelhada
em `src/lib/auth/roles.ts` e na função SQL `is_account_member(account_id, min_role)`:

| Papel | Rank | Papel no negócio |
|-------|:----:|------------------|
| `owner` | 4 | dono da conta — tudo, incl. deletar conta e transferir posse |
| `admin` | 3 | gestor — config da conta, membros, ações estruturais e de alto impacto |
| `agent` | 2 | colaborador/vendedor — operação 1:1 do dia a dia |
| `viewer` | 1 | leitura/auditoria |

Não criamos papéis novos. `platform-admin` (super-admin VANTAGE, `PLATFORM_ADMIN_EMAILS`) é um
sistema **paralelo e ortogonal** ao enum — governa `/api/admin/*` via `requirePlatformAdmin`, não
entra nesta matriz (documentado aqui só pra evitar que alguém tente mapeá-lo a `owner`).

## Matriz de permissões (política final)

| Ação | viewer | agent | admin | owner |
|------|:---:|:---:|:---:|:---:|
| **Ler** contatos/conversas/deals | ✅¹ | ✅² | ✅ | ✅ |
| Mandar mensagem 1:1 (inbox) | ❌ | ✅² | ✅ | ✅ |
| Reagir a mensagem | ❌ | ✅² | ✅ | ✅ |
| Baixar mídia de anexo | ✅¹ | ✅² | ✅ | ✅ |
| Criar/editar contato | ❌ | ✅² | ✅ | ✅ |
| Mover/editar deal | ❌ | ✅² | ✅ | ✅ |
| **Deletar** contato/deal | ❌ | ❌ | ✅ | ✅ |
| Disparo em massa (broadcast) | ❌ | ❌ | ✅ | ✅ |
| Criar/editar/duplicar automações | ❌ | ❌ | ✅ | ✅ |
| Criar/editar/ativar flows | ❌ | ❌ | ✅ | ✅ |
| Criar/submeter/editar/deletar/sincronizar template | ❌ | ❌ | ✅ | ✅ |
| Estrutura: pipelines/tags/campos personalizados | ❌ | ❌ | ✅ | ✅ |
| Editar config do WhatsApp (número/token) | ❌ | ❌ | ✅ | ✅ |
| Distribuição de leads (toggle ADM do rodízio + `in_pool`) | ❌ | ❌ | ✅ | ✅ |
| Toggle "Disponível" (própria presença, `is_available`) | ❌ | ✅ | ✅ | ✅ |
| Gerenciar membros / convites / API keys / webhooks / CAPI | ❌ | ❌ | ✅ | ✅ |
| Deletar conta / transferir posse | ❌ | ❌ | ❌ | ✅ |

¹ **viewer vê TUDO da conta** (read-only de auditoria) — sem escopo por dono.
² **agent é escopado por dono** na Fase 2: só vê/opera `conversations.assigned_agent_id = uid`.
Até a Fase 2 entrar, agent lê tudo da conta (limitação documentada — ver Fase 2).

**Decisão registrada (broadcast/automações/flows = admin+):** o código atual trata essas ações como
`agent+` (`roles.ts:88` docstring "run broadcasts, edit automations"; RLS `017:400-409,423-425`). A
matriz **deliberadamente sobe pra admin+** — colaborador é vendedor, não opera infraestrutura do bot
nem dispara campanha (risco de ban/custo). Isso **exige `ALTER POLICY`** (não é "espelhar").

## Achados da auditoria que moldaram o plano

Fatos verificados no código (com evidência) que mudaram premissas do rascunho inicial:

1. **🔴 Escalonamento ao vivo (P0).** `profiles_update` (`017:564-566`) é
   `USING (auth.uid()=user_id) WITH CHECK (auth.uid()=user_id)` — **sem restrição de coluna**.
   `account_role` mora em `profiles`. Qualquer membro roda
   `supabase.from('profiles').update({account_role:'owner'}).eq('user_id', uid)` e vira owner,
   driblando a rota admin-only de membros e os RPCs `SECURITY DEFINER`. Nenhuma migration posterior
   corrige.
2. **"Só espelhar a RLS" é falso pra alto-impacto.** broadcasts/automations/flows têm RLS em `agent+`
   (`017:400-402,407-409,423-425`); subir pra admin+ é `ALTER POLICY`, não espelhamento.
3. **RLS não é rede onde mais importa.** `automations` POST (`automations/route.ts:100`) e `flows`
   POST (`flows/route.ts:89,100,149`) escrevem via `supabaseAdmin()` (service role) — **RLS é
   ignorada**. Hoje até viewer escreve. O guard de app será a **única** defesa nessas rotas.
4. **Broadcast é especial.** `/api/whatsapp/broadcast` **não escreve na tabela `broadcasts`** —
   chama a Meta direto (`route.ts:203`). RLS de `broadcasts` é irrelevante pro disparo; só
   `requireRole('admin')` na rota barra custo/ban.
5. **Contatos/deals não passam por rota de API.** O dashboard escreve direto do browser via Supabase
   client RLS-scoped. Não há "guard de app" pra plugar — **só a RLS protege**. E
   `contacts_delete`/`deals_delete` são `agent+` (`017:339,395`), divergindo da matriz (delete=admin+).
6. **`external/whatsapp/send` não é rota de papel** — é `export { POST } from 'v1/messages/send'`
   (apiKey+scope `messages:send`). Fica fora da matriz de papéis.
7. **Templates admin+ piora o bug do `onConflict`.** Multi-admin submetendo o mesmo `name+language`
   cria linhas duplicadas (índice único é `(user_id,name,language)`, `014:190`); os lookups de envio
   usam `.maybeSingle()` sem `limit(1)` → PostgREST lança "multiple rows" → **disparo quebra**.
8. **`presence` PUT deixa o agent setar `in_pool`** (`account/presence/route.ts:52`) — colide com a
   matriz (pool = admin+). Self-service deve ser só `is_available`.
9. **Sem ação (confirmado seguro):** auto-promoção via API de membros está fechada (guard + RPC
   self-check, `018`); lockout de last-owner/last-admin é impossível por construção.

## Faseamento

### 🔴 Fase 0 — P0 de segurança (isolada, shippável sozinha)

Estanca o escalonamento do achado #1 **antes** de qualquer guard de rota (sem isso, o resto é teatro).

- Política/trigger column-scoped em `profiles`: rejeitar `UPDATE` que altere `account_role` ou
  `account_id` quando vier do client (fora dos RPCs `SECURITY DEFINER`). Abordagem preferida:
  trigger `BEFORE UPDATE` que, se `NEW.account_role <> OLD.account_role` ou
  `NEW.account_id <> OLD.account_id`, levanta exceção a menos que esteja num contexto de RPC
  autorizado (ou comparar `current_setting`/role). Alternativa: separar a policy de update de perfil
  (nome/avatar) da mudança de papel via coluna.
- Teste: membro `agent`/`viewer` tentando self-promote a `owner` deve falhar; update de nome/avatar
  próprio continua funcionando; RPCs de membros continuam mudando papel normalmente.

### 🟠 Fase 1 — Endurecimento de write/ações (Abordagem 1: guard de app + RLS)

**Predicados (fonte única em `roles.ts`):**
- Adicionar `canBroadcast` (admin+), `canManageAutomations` (admin+), `canManageStructure` (admin+),
  `canManageTemplates` (admin+) — em vez de reusar `canEditSettings` para tudo (semântica clara,
  matriz executável).
- Adicionar helper de ownership `canActOnConversation(role, conv, uid)` para ações escopadas
  (mensagem 1:1, mover deal do próprio lead) — papel é só o 1º gate; o 2º é `assigned_agent_id`.
  Em uso pleno na Fase 2, mas o helper já nasce aqui pra a regra não espalhar inline.

**Guards de app (rotas nomeadas — não rótulo genérico):**

| Rota | Hoje | Guard a aplicar |
|------|------|-----------------|
| `whatsapp/templates/submit` POST | auth-only | `canManageTemplates` (admin+) |
| `whatsapp/templates/[id]` PATCH, DELETE | auth-only | admin+ |
| `whatsapp/templates/sync` POST | auth-only | admin+ |
| `whatsapp/config` POST/PATCH/DELETE | auth-only | `canEditSettings` (admin+) |
| `whatsapp/broadcast` POST | auth-only | `canBroadcast` (admin+) — **P0 da fase** |
| `automations` POST | auth-only | `canManageAutomations` (admin+) |
| `automations/[id]` PATCH, DELETE | auth-only | admin+ |
| `automations/[id]/duplicate` POST | auth-only | admin+ |
| `flows` POST | auth-only | admin+ |
| `flows/[id]` PUT, DELETE | auth-only | admin+ |
| `flows/[id]/activate` POST | auth-only | admin+ |
| `whatsapp/send` POST | auth-only | `canSendMessages` (agent+) |
| `whatsapp/react` POST | auth-only | `canSendMessages` (agent+) |
| `whatsapp/media/[mediaId]` GET | auth-only | viewer+ (qualquer membro) |
| `account/presence` PUT | sem role | aceitar só `is_available`; **ignorar/rejeitar `in_pool`** |

`external/whatsapp/send` **não** entra (apiKey+scope). `/v1/*` continua governado por scope (não por
papel) — documentar que `broadcasts:send`/`contacts:write` via API key = equivalente a admin.

**RLS (mudanças reais de policy — não "espelhamento"):**
- `ALTER POLICY` `agent → admin` em `broadcasts`, `automations`, `flows` (insert/update/delete).
- Policies de `DELETE` separadas em `admin+` para `contacts` e `deals` (hoje agent+).
- Migrar escritas de `automations`/`flows` do `supabaseAdmin()` pro client de sessão
  (`ctx.supabase` do `requireRole`), pra a RLS voltar a ser rede real. Manter service role só onde
  comprovadamente necessário (ex.: unique-check cross-account em `whatsapp/config`).

**Embrulhado junto (dependência dura do achado #7):**
- Migration que troca o índice único de templates para `(account_id, name, language)` + `onConflict`
  correspondente em `submit/route.ts`, com guard de dedup no estilo da `014` (aborta ou deduplica
  antes de criar o índice). Sem isso, habilitar templates multi-admin quebra o disparo.

**CI:** estender o guardrail de auth (`route-auth-guard.test.ts`) para exigir que rota **mutante**
tenha `requireRole`/predicado, não só `auth.getUser`.

**Fora de escopo / limpeza de matriz:**
- Remover "deletar conversa" da matriz (não existe endpoint nem UI; `conversations_delete` RLS é
  agent+ e fica como está até existir caso de uso).

### 🟡 Fase 2 — Visibilidade do agent (spec próprio, logo em seguida)

Não entra na Fase 1 por ser a mudança mais arriscada (mexe em `SELECT` dos caminhos quentes e encosta
no autoassign do PR #18). Escopo:
- Opção A (recomendada, sem schema change): RLS de `SELECT` de `conversations` escopada por
  `assigned_agent_id = uid` para `agent`; `admin+` e `viewer` veem tudo.
- Decidir visibilidade de leads órfãos (`assigned_agent_id IS NULL` / `autoassign_waiting=true`) →
  `admin+` (já coberto); agent não vê até receber.
- Decidir a inconsistência "agent vê a ficha do contato mas não a conversa" (contacts/deals SELECT é
  account-wide hoje). Opções: deixar contacts/deals account-wide (transparência) ou derivar de
  conversation.
- **Não** introduzir `contacts.owner_user_id` sem definir semântica de reatribuição (o round-robin
  reescreve `assigned_agent_id`; um owner duplicado divergiria).
- Teste dedicado contra o fluxo de autoassign (PR #18) antes de apertar o SELECT.

De-risco confirmado pela auditoria: o autoassign **nunca reatribui** lead já atribuído (só age em
`assigned_agent_id IS NULL` — `webhook/route.ts:680`, `round-robin.ts:71`, `cron/route.ts:90`), então
não há "handoff quebra histórico". Vendedor indisponível só para de **receber novos**.

## Princípio de manutenção

`src/lib/auth/roles.ts` é a **fonte única** ("what can this role do?"). Tanto guards de rota quanto
gates de UI chamam os predicados — nunca comparam string de papel inline. Mudança de política = diff
de um arquivo. Ações escopadas (1:1, deal próprio) combinam predicado de papel **+**
`canActOnConversation` (ownership), nunca ownership inline por rota.

## Riscos

- **Migrar automations/flows pro client de sessão** pode esbarrar em lógica que dependia do service
  role (ex.: leitura cross-tabela). Mitigar: migrar incrementalmente, manter service role pontual
  onde a RLS bloquear legitimamente, com teste por rota.
- **`ALTER POLICY` em produção** (banco dedicado do CRM, nunca produção de cliente — ver guard-rail
  de setup). Aplicar via migration versionada, validar com `agent`/`admin` reais.
- **Dedup de templates** pode encontrar duplicatas pré-existentes — a migration precisa abortar com
  mensagem clara (estilo `014`) ou deduplicar deterministicamente antes do índice único.

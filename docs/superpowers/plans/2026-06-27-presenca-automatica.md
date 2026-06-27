# Presença automática + Pausar leads — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Presença do vendedor passa a ser automática (online = CRM aberto via heartbeat; logout/fechar aba = ausente na hora), e o toggle manual vira um botão "Pausar leads" (opt-out, default recebendo).

**Architecture:** Reaproveita a infra do PR #18. `agent_presence.is_available` muda de "toggle manual" pra "recebendo leads" (default true). "Online agora" vira função pura do heartbeat (`last_activity_at`). Saída imediata via beacon (`sendBeacon`/`keepalive`) no `pagehide`/logout. Janela do rodízio 15min→5min. O predicado central do RPC mantém a estrutura, então rodízio em tempo real e cron da fila herdam tudo.

**Tech Stack:** Next.js App Router, React client components, Supabase JS, PostgreSQL (plpgsql), TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-26-presenca-automatica-design.md`

## Global Constraints

- Comentários em **português**.
- **Nunca `git add -A`** — adicionar arquivos explicitamente. PRs → `iv-automacao/crm-vantage`. Branch: `feat/presenca-automatica` (já criada, spec já commitado).
- **Migration aplicada MANUALMENTE pelo Iago no SQL Editor** (MCP sem escrita). Verificação por SQL estrutural (single SELECT).
- **Janela de presença = 5min, em DOIS lugares que andam juntos:** `INTERVAL '5 minutes'` no SQL (`pick_next_agent_round_robin`) e `PRESENCE_WINDOW_MS = 5 * 60 * 1000` em `round-robin.ts`. Manter sincronizados.
- **Lint baseline = 3 erros pré-existentes** (no-explicit-any) — não adicionar erro novo.
- `is_available` agora significa **"recebendo leads"** (= não pausado). Default `true`.
- **Agente novo nasce FORA do pool** (`in_pool=false`); o ADM libera no "No rodízio". Agentes existentes mantêm o `in_pool` atual.

---

### Task 1: Migration 035 — modelo de dados (default + backfill + trigger + janela)

**Files:**
- Create: `supabase/migrations/035_presence_auto.sql`

**Interfaces:**
- Produces: coluna `agent_presence.is_available` com default `true`; trigger `autoassign_sync_agent_pool` inserindo `in_pool=false, is_available=true`; RPC `pick_next_agent_round_robin` com janela de 5min. Consumido em runtime pela rota de presença e pelo rodízio.

**Contexto:** Esta task é SQL puro. Não há teste unitário; a verificação é a aplicação manual do Iago + um SELECT estrutural. O implementer apenas cria o arquivo com o conteúdo exato abaixo e para — NÃO tenta aplicar a migration (MCP sem escrita).

- [ ] **Step 1: Criar a migration**

Criar `supabase/migrations/035_presence_auto.sql` com EXATAMENTE este conteúdo:

```sql
-- 035: Presença automática + Pausar leads.
-- is_available passa a significar "recebendo leads" (default true; pausa = false).
-- "Online agora" vira função pura do heartbeat (last_activity_at) na camada de app.
-- Agente novo nasce FORA do pool (in_pool=false; ADM libera). Janela 15min -> 5min.
-- RLS/guards (030/034) inalterados. Aplicada MANUALMENTE no SQL Editor.

-- 1) is_available agora é "recebendo leads", default true -----------------
ALTER TABLE agent_presence ALTER COLUMN is_available SET DEFAULT true;

-- Backfill: todos os agentes existentes passam a "recebendo".
-- NÃO mexe em in_pool: quem o ADM já configurou no rodízio continua.
UPDATE agent_presence SET is_available = true WHERE is_available = false;

-- 2) Trigger de presença: agente novo nasce FORA do pool, recebendo -------
-- Inverte o auto-join do PR #18 (antes entrava no pool automaticamente).
CREATE OR REPLACE FUNCTION public.autoassign_sync_agent_pool()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.account_role = 'agent' THEN
    -- Cria a linha de presença do agente FORA do rodízio; o ADM libera
    -- ligando "No rodízio". is_available=true (recebendo por padrão).
    INSERT INTO agent_presence (account_id, user_id, in_pool, is_available)
    VALUES (NEW.account_id, NEW.user_id, false, true)
    ON CONFLICT (account_id, user_id) DO NOTHING;  -- nunca sobrescreve config existente
  END IF;
  RETURN NEW;
END; $$;
ALTER FUNCTION public.autoassign_sync_agent_pool() OWNER TO postgres;

-- 3) Janela de presença do rodízio: 15min -> 5min -------------------------
-- Espelha PRESENCE_WINDOW_MS em round-robin.ts. Predicado inalterado.
CREATE OR REPLACE FUNCTION public.pick_next_agent_round_robin(p_account_id UUID)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pool UUID[];
  v_idx  BIGINT;
BEGIN
  SELECT array_agg(ap.user_id ORDER BY pr.created_at, ap.user_id)
  INTO v_pool
  FROM agent_presence ap
  JOIN profiles pr ON pr.user_id = ap.user_id AND pr.account_id = ap.account_id
  WHERE ap.account_id = p_account_id
    AND ap.in_pool
    AND ap.is_available
    AND ap.last_activity_at > NOW() - INTERVAL '5 minutes';
    -- gate de turno futuro: AND <turno aberto agora>

  IF v_pool IS NULL OR array_length(v_pool, 1) = 0 THEN
    RETURN NULL;  -- ninguém disponível -> caller faz o fallback do ADM
  END IF;

  INSERT INTO lead_autoassign_settings (account_id, cursor)
  VALUES (p_account_id, 1)
  ON CONFLICT (account_id) DO UPDATE SET cursor = lead_autoassign_settings.cursor + 1
  RETURNING cursor INTO v_idx;

  RETURN v_pool[(v_idx % array_length(v_pool, 1)) + 1];  -- arrays são 1-based
END; $$;
ALTER FUNCTION public.pick_next_agent_round_robin(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.pick_next_agent_round_robin(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pick_next_agent_round_robin(UUID) TO service_role;
```

- [ ] **Step 2: Verificação estrutural (manual do Iago no SQL Editor)**

Esta é uma instrução pro Iago, não pro implementer. Depois de colar e rodar a migration, rodar ESTE único SELECT (o editor só mostra o resultado da última statement):

```sql
SELECT
  (SELECT column_default FROM information_schema.columns
     WHERE table_name = 'agent_presence' AND column_name = 'is_available') AS default_is_available,
  pg_get_functiondef('public.pick_next_agent_round_robin(uuid)'::regprocedure) LIKE '%5 minutes%' AS rpc_janela_5min,
  pg_get_functiondef('public.autoassign_sync_agent_pool()'::regprocedure) LIKE '%false, true%' AS trigger_fora_do_pool;
```

Expected: `default_is_available = true`, `rpc_janela_5min = true`, `trigger_fora_do_pool = true`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/035_presence_auto.sql
git commit -m "feat(presenca): migration 035 — is_available=recebendo (default true), agente novo fora do pool, janela 5min

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `round-robin.ts` — janela 5min + helper `onlineNow` (TDD)

**Files:**
- Modify: `src/lib/leads/round-robin.ts` (`isAvailableNow` `:23-37`)
- Modify (overwrite): `src/lib/leads/round-robin.test.ts`

**Interfaces:**
- Produces: `export const PRESENCE_WINDOW_MS = 5 * 60 * 1000`; `export function onlineNow(lastActivityAt: string | null, now: Date): boolean`. `isAvailableNow` mantém a assinatura atual (`(p, now)`). `onlineNow` é consumido pela Task 6.

- [ ] **Step 1: Escrever os testes (RED)** — sobrescrever `src/lib/leads/round-robin.test.ts` inteiro:

```ts
import { describe, it, expect } from 'vitest'
import { pickIndex, isAvailableNow, onlineNow } from './round-robin'

// Data/hora fixa para todos os testes de disponibilidade
const NOW = new Date('2026-06-25T12:00:00Z')

// Helper: retorna um timestamp relativo a NOW em milissegundos
function msAgo(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString()
}

const MIN = 60 * 1000

describe('pickIndex', () => {
  it('retorna -1 quando pool está vazia (size 0)', () => {
    expect(pickIndex(0, 0)).toBe(-1)
  })

  it('retorna -1 quando size é negativo', () => {
    expect(pickIndex(5, -1)).toBe(-1)
  })

  it('faz rodízio correto com size 3: 0,1,2,0,1', () => {
    expect(pickIndex(0, 3)).toBe(0)
    expect(pickIndex(1, 3)).toBe(1)
    expect(pickIndex(2, 3)).toBe(2)
    expect(pickIndex(3, 3)).toBe(0) // wrap A→B→C→A
    expect(pickIndex(4, 3)).toBe(1)
  })

  it('size 1 sempre retorna 0 independente do cursor', () => {
    expect(pickIndex(0, 1)).toBe(0)
    expect(pickIndex(99, 1)).toBe(0)
    expect(pickIndex(1000, 1)).toBe(0)
  })
})

describe('onlineNow', () => {
  it('true quando o heartbeat é recente (2min)', () => {
    expect(onlineNow(msAgo(2 * MIN), NOW)).toBe(true)
  })

  it('false quando o heartbeat passou da janela (8min > 5min)', () => {
    expect(onlineNow(msAgo(8 * MIN), NOW)).toBe(false)
  })

  it('false no limite exato da janela (5min)', () => {
    expect(onlineNow(msAgo(5 * MIN), NOW)).toBe(false)
  })

  it('false quando last_activity_at é null', () => {
    expect(onlineNow(null, NOW)).toBe(false)
  })
})

describe('isAvailableNow', () => {
  it('true quando in_pool + recebendo + heartbeat recente (2min)', () => {
    const p = { in_pool: true, is_available: true, last_activity_at: msAgo(2 * MIN) }
    expect(isAvailableNow(p, NOW)).toBe(true)
  })

  it('false quando is_available (recebendo) é false — agente pausado', () => {
    const p = { in_pool: true, is_available: false, last_activity_at: msAgo(2 * MIN) }
    expect(isAvailableNow(p, NOW)).toBe(false)
  })

  it('false quando in_pool é false', () => {
    const p = { in_pool: false, is_available: true, last_activity_at: msAgo(2 * MIN) }
    expect(isAvailableNow(p, NOW)).toBe(false)
  })

  it('false quando o heartbeat passou da janela (8min)', () => {
    const p = { in_pool: true, is_available: true, last_activity_at: msAgo(8 * MIN) }
    expect(isAvailableNow(p, NOW)).toBe(false)
  })

  it('false quando last_activity_at é null', () => {
    const p = { in_pool: true, is_available: true, last_activity_at: null }
    expect(isAvailableNow(p, NOW)).toBe(false)
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/lib/leads/round-robin.test.ts`
Expected: FAIL — `onlineNow` não existe (import quebra) e os casos de janela de 5min falham contra a janela de 15min atual.

- [ ] **Step 3: Implementar** — em `src/lib/leads/round-robin.ts`, substituir o bloco do `isAvailableNow` (`:18-37`) por:

```ts
/**
 * Janela de presença: tempo máximo desde o último heartbeat pra contar como
 * "online agora". ESPELHA o INTERVAL do SQL pick_next_agent_round_robin
 * (migration 035) — manter os dois em sincronia.
 */
export const PRESENCE_WINDOW_MS = 5 * 60 * 1000

/**
 * "Online agora" = heartbeat dentro da janela. Só presença real (aba aberta);
 * NÃO considera in_pool nem pausa. Usado pelo painel do ADM (bolinha verde).
 */
export function onlineNow(lastActivityAt: string | null, now: Date): boolean {
  if (lastActivityAt == null) return false
  return now.getTime() - new Date(lastActivityAt).getTime() < PRESENCE_WINDOW_MS
}

/**
 * Predicado de elegibilidade que espelha a lógica SQL: agente recebe lead se
 * está no pool, recebendo (is_available) e online (heartbeat dentro da janela).
 */
export function isAvailableNow(
  p: {
    in_pool: boolean
    is_available: boolean
    last_activity_at: string | null
  },
  now: Date,
): boolean {
  if (!p.in_pool) return false
  if (!p.is_available) return false
  return onlineNow(p.last_activity_at, now)
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/lib/leads/round-robin.test.ts`
Expected: PASS (todos).

- [ ] **Step 5: typecheck**

Run: `npm run typecheck`
Expected: limpo.

- [ ] **Step 6: Commit**

```bash
git add src/lib/leads/round-robin.ts src/lib/leads/round-robin.test.ts
git commit -m "feat(presenca): janela de presença 5min + helper onlineNow (heartbeat puro)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Rota de presença — POST aceita `{ offline: true }`

**Files:**
- Modify: `src/app/api/account/presence/route.ts` (POST `:76-101`; comentário do topo `:1-3`)

**Interfaces:**
- Produces: `POST /api/account/presence` com corpo opcional `{ offline: true }` → zera `last_activity_at`. Sem corpo = heartbeat normal. Consumido pelas Tasks 4 (sendBeacon) e 5 (logout).

**Contexto:** Não há testes de rota neste projeto (as rotas dependem de sessão Supabase). Verificação = typecheck + teste manual descrito. A rota já usa `requireRole('agent')` e rate limit `presence`; manter.

- [ ] **Step 1: Estender o POST** — substituir a função `POST` inteira por:

```ts
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')

    // Rate limit compartilhado com o PUT — heartbeat, offline e toggle no mesmo bucket.
    const rl = await checkRateLimit(`presence:${ctx.userId}`, RATE_LIMITS.presence)
    if (!rl.success) return rateLimitResponse(rl)

    // Corpo opcional: { offline: true } marca saída imediata (logout/fechar aba),
    // zerando last_activity_at -> ausente na hora. Sem corpo = heartbeat normal.
    // Compatível com navigator.sendBeacon (POST com Blob JSON).
    const body = (await request.json().catch(() => null)) as { offline?: boolean } | null
    const goingOffline = body?.offline === true

    const now = new Date().toISOString()
    const patch = goingOffline
      ? { last_activity_at: null, updated_at: now }
      : { last_activity_at: now, updated_at: now }

    const { error } = await ctx.supabase
      .from('agent_presence')
      .update(patch)
      .eq('account_id', ctx.accountId)
      .eq('user_id', ctx.userId)

    if (error) {
      console.error('[POST /api/account/presence] erro no heartbeat:', error)
      return NextResponse.json({ error: 'Falha no heartbeat' }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
```

E atualizar o comentário do topo do arquivo (`:1-3`) para:

```ts
// GET  — retorna presença própria do vendedor (in_pool, is_available).
// PUT  — pausa/retoma recebimento (is_available) com rate limit por usuário.
// POST — heartbeat (last_activity_at = now); corpo { offline: true } zera a presença.
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck`
Expected: limpo.

- [ ] **Step 3: Teste manual (descrição — executar quando o app estiver rodando)**

Logado como `agent`, no console do navegador:
`fetch('/api/account/presence',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({offline:true})}).then(r=>r.json())` → `{ok:true}`. No painel do ADM, o agente cai pra "Ausente". Um `POST` sem corpo volta a marcar online.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/account/presence/route.ts
git commit -m "feat(presenca): POST /presence aceita { offline: true } pra saída imediata

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Botão "Pausar leads" + heartbeat (2min) + beacon de saída

**Files:**
- Modify (reescrever): `src/components/layout/availability-toggle.tsx`
- Modify: `src/components/layout/header.tsx` (import `:20`, uso `:75`)

**Interfaces:**
- Consumes: `POST /api/account/presence` com `{ offline: true }` (Task 3); `GET`/`PUT` existentes; `useAuth()` (`profile.account_role`).
- Produces: componente `LeadAvailabilityControl` (renomeado de `AvailabilityToggle`).

**Contexto:** Componente client; verificação = typecheck + lint + teste manual. O componente continua sendo a casa do heartbeat (montado no header pra todo `agent`). Mudanças vs. hoje: intervalo 4min→2min; `pagehide` dispara beacon offline; UI vira "Recebendo leads / Pausado" (switch ON = recebendo); export renomeado.

- [ ] **Step 1: Reescrever o componente** — substituir TODO o conteúdo de `src/components/layout/availability-toggle.tsx` por:

```tsx
'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { useAuth } from '@/hooks/use-auth'
import { Switch } from '@/components/ui/switch'

// Intervalo do heartbeat (deve ser bem menor que a janela de presença de 5min
// do backend, pra tolerar um ping perdido).
const PING_INTERVAL_MS = 2 * 60_000

/**
 * Controle de disponibilidade do vendedor (papel 'agent').
 * - Presença automática: enquanto a aba está visível, pinga a presença a cada
 *   2min. Fechar a aba / sair dispara um beacon que zera a presença na hora.
 * - Botão "Pausar leads": online por padrão (recebendo); pode pausar o
 *   recebimento sem ficar ausente nem deslogar.
 * Visível apenas para 'agent' — admin/owner/viewer não recebem leads.
 */
export function LeadAvailabilityControl() {
  const { profile } = useAuth()
  // Renderiza só para agentes (após o hook do contexto, sem hook próprio antes).
  if (profile?.account_role !== 'agent') return null
  return <LeadAvailabilityControlInner />
}

/**
 * Componente interno separado para evitar hooks após return condicional.
 */
function LeadAvailabilityControlInner() {
  // is_available = "recebendo leads". null = carregando (desabilita o switch).
  const [receiving, setReceiving] = useState<boolean | null>(null)

  // Carrega o estado inicial de "recebendo" no mount.
  useEffect(() => {
    fetch('/api/account/presence')
      .then((r) => r.json())
      .then((data: { is_available?: boolean }) => {
        setReceiving(data.is_available ?? true)
      })
      .catch(() => {
        // Falha silenciosa: assume recebendo (default do modelo).
        setReceiving(true)
      })
  }, [])

  // Heartbeat enquanto a aba está VISÍVEL + beacon de saída imediata.
  useEffect(() => {
    const ping = () =>
      fetch('/api/account/presence', { method: 'POST' }).catch(() => {})

    // Saída imediata: zera a presença ao fechar a aba / navegar pra fora.
    // sendBeacon carrega o cookie de sessão same-origin e sobrevive ao unload.
    const goOffline = () => {
      const blob = new Blob([JSON.stringify({ offline: true })], {
        type: 'application/json',
      })
      navigator.sendBeacon('/api/account/presence', blob)
    }

    let interval: ReturnType<typeof setInterval> | null = null
    const start = () => {
      if (interval) return
      ping() // ping imediato ao (re)tornar visível
      interval = setInterval(ping, PING_INTERVAL_MS)
    }
    const stop = () => {
      if (interval) {
        clearInterval(interval)
        interval = null
      }
    }

    const onVisibility = () => {
      // Trocar de aba só PAUSA o ping (não dispara beacon) — o vendedor cai por
      // expiração da janela de 5min. Evita piscar online/offline em troca rápida.
      if (document.visibilityState === 'visible') start()
      else stop()
    }

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', goOffline)

    // Só inicia se a aba já está visível no mount.
    if (document.visibilityState === 'visible') start()

    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', goOffline)
    }
  }, [])

  const handleToggle = async (nextReceiving: boolean) => {
    // Atualização otimista.
    setReceiving(nextReceiving)
    try {
      const res = await fetch('/api/account/presence', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_available: nextReceiving }),
      })
      if (!res.ok) throw new Error('Falha ao atualizar recebimento')
    } catch {
      // Rollback.
      setReceiving(!nextReceiving)
      toast.error('Não foi possível atualizar o recebimento de leads.')
    }
  }

  const loaded = receiving !== null

  return (
    <div className="flex items-center gap-1.5">
      <Switch
        checked={receiving ?? true}
        disabled={!loaded}
        onCheckedChange={handleToggle}
        aria-label={receiving ? 'Recebendo leads' : 'Pausado'}
      />
      {/* Label oculta em telas muito pequenas para caber no header de 56px. */}
      <span
        className={[
          'hidden sm:inline text-xs font-medium select-none',
          loaded && receiving
            ? 'text-green-600 dark:text-green-400'
            : 'text-muted-foreground',
        ].join(' ')}
      >
        {loaded && receiving ? 'Recebendo leads' : 'Pausado'}
      </span>
    </div>
  )
}
```

- [ ] **Step 2: Atualizar o header** — em `src/components/layout/header.tsx`:

Linha 20, trocar:
```tsx
import { AvailabilityToggle } from "@/components/layout/availability-toggle";
```
por:
```tsx
import { LeadAvailabilityControl } from "@/components/layout/availability-toggle";
```

Linha 75, trocar `<AvailabilityToggle />` por `<LeadAvailabilityControl />`.

- [ ] **Step 3: typecheck + lint**

Run: `npm run typecheck` → limpo.
Run: `npm run lint` → "errors" continua 3 (baseline); sem erro novo.

- [ ] **Step 4: Teste manual (descrição)**

Logado como `agent`: abrir o CRM → no painel do ADM (outra sessão) o agente aparece "Online agora" (verde) em até 2min. Clicar no switch pra OFF → label "Pausado"; no painel, badge "Pausado". Fechar a aba → em segundos o agente cai pra "Ausente" no painel (beacon).

- [ ] **Step 5: Commit**

```bash
git add src/components/layout/availability-toggle.tsx src/components/layout/header.tsx
git commit -m "feat(presenca): botão Pausar leads + heartbeat 2min + beacon de saída

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Beacon de offline no logout

**Files:**
- Modify: `src/hooks/use-auth.tsx` (`signOut` `:301-308`)

**Interfaces:**
- Consumes: `POST /api/account/presence` com `{ offline: true }` (Task 3).

**Contexto:** O `signOut` real é o `useCallback` em `:301` (o de `:372` é fallback sem provider — NÃO mexer nele). O beacon precisa rodar ANTES do `supabase.auth.signOut()` (depois o cookie some e a rota daria 401). `keepalive: true` garante o envio durante a navegação pra `/login`. Roda pra qualquer papel; não-agente recebe 403 da rota (`requireRole('agent')`) e cai no catch — inofensivo.

- [ ] **Step 1: Adicionar o beacon** — substituir o `signOut` (`:301-308`) por:

```tsx
  const signOut = useCallback(async () => {
    const supabase = createClient();
    // Marca a presença como offline ANTES do signOut — depois o cookie some e a
    // rota daria 401. keepalive garante o envio durante a navegação pra /login.
    // Best-effort: o beacon de pagehide e a janela de 5min cobrem qualquer falha.
    try {
      await fetch("/api/account/presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offline: true }),
        keepalive: true,
      });
    } catch {
      // ignora — saída de presença é best-effort
    }
    await supabase.auth.signOut();
    setUser(null);
    setProfile(null);
    setAccount(null);
    window.location.href = "/login";
  }, []);
```

- [ ] **Step 2: typecheck + lint**

Run: `npm run typecheck` → limpo.
Run: `npm run lint` → "errors" continua 3 (baseline).

- [ ] **Step 3: Teste manual (descrição)**

Logado como `agent`, abrir o CRM (fica "Online agora" no painel do ADM). Clicar em Sair → na sessão do ADM, o agente cai pra "Ausente" imediatamente (sem esperar a janela).

- [ ] **Step 4: Commit**

```bash
git add src/hooks/use-auth.tsx
git commit -m "feat(presenca): marca offline no logout antes do signOut (saída imediata)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Painel do ADM — `online_now` + badge "Pausado"

**Files:**
- Modify: `src/app/api/account/lead-autoassign/route.ts` (`RosterEntry` `:11-18`, `buildView` merge `:65-84`, import `:7`)
- Modify: `src/components/settings/lead-autoassign-panel.tsx` (`RosterEntry` `:26-33`, dot `:268-273`, status/badge `:283-299`)

**Interfaces:**
- Consumes: `onlineNow` (Task 2).
- Produces: campo `online_now: boolean` no roster (presença pura). Substitui `available_now` na view.

**Contexto:** Há DUAS interfaces `RosterEntry` duplicadas (rota e painel) — atualizar as duas. A bolinha verde passa a refletir só o heartbeat (`online_now`); o badge "Pausado" aparece só quando `is_available=false` (some o pill "TOGGLE ON/OFF"). `isAvailableNow` (elegibilidade, mirror do SQL) continua exportado e testado, mesmo que `buildView` não o chame mais.

- [ ] **Step 1: Rota — trocar `available_now` por `online_now`**

Em `src/app/api/account/lead-autoassign/route.ts`:

Import (`:7`), trocar:
```ts
import { isAvailableNow } from '@/lib/leads/round-robin'
```
por:
```ts
import { onlineNow } from '@/lib/leads/round-robin'
```

Interface `RosterEntry` (`:11-18`), trocar `available_now: boolean` por `online_now: boolean`:
```ts
interface RosterEntry {
  user_id: string
  full_name: string | null
  email: string | null
  in_pool: boolean
  is_available: boolean
  online_now: boolean
}
```

No merge do roster (`:67-84`), trocar o objeto retornado por:
```ts
      return {
        user_id: p.user_id as string,
        full_name: (profile.full_name as string | null) ?? null,
        email: (profile.email as string | null) ?? null,
        in_pool: Boolean(p.in_pool),
        is_available: Boolean(p.is_available),
        // "Online agora" = só heartbeat (presença real); pausa/pool são separados.
        online_now: onlineNow(p.last_activity_at as string | null, now),
      }
```

- [ ] **Step 2: Painel — interface + dot + status/badge**

Em `src/components/settings/lead-autoassign-panel.tsx`:

Interface `RosterEntry` (`:26-33`), trocar `available_now: boolean` por `online_now: boolean`:
```ts
interface RosterEntry {
  user_id: string;
  full_name: string | null;
  email: string | null;
  in_pool: boolean;
  is_available: boolean;
  online_now: boolean;
}
```

Bolinha de presença (`:268-273`), trocar por:
```tsx
                  {/* Presença real (heartbeat, janela 5min) — independe de pausa/pool */}
                  <span
                    className={`mt-0.5 size-2 shrink-0 rounded-full ${
                      agent.online_now ? 'bg-green-500' : 'bg-muted-foreground/40'
                    }`}
                    title={agent.online_now ? 'Online agora' : 'Ausente'}
                  />
```

Bloco de status + badge (`:283-299`), trocar por:
```tsx
                    <div className="mt-1 flex items-center gap-2">
                      {/* Presença real */}
                      <span
                        className={`text-[10px] font-medium ${
                          agent.online_now ? 'text-green-400' : 'text-muted-foreground'
                        }`}
                      >
                        {agent.online_now ? 'Online agora' : 'Ausente'}
                      </span>
                      {/* Badge "Pausado" só quando o vendedor pausou o recebimento */}
                      {!agent.is_available && (
                        <Badge
                          variant="outline"
                          className="h-4 px-1 text-[9px] uppercase tracking-wide text-amber-400"
                        >
                          Pausado
                        </Badge>
                      )}
                    </div>
```

- [ ] **Step 3: typecheck + lint + testes**

Run: `npm run typecheck` → limpo.
Run: `npm run lint` → "errors" continua 3 (baseline).
Run: `npx vitest run` → tudo verde (nada quebrou).

- [ ] **Step 4: Teste manual (descrição)**

Como ADM, abrir Configurações → Distribuição de leads. Um agente com o CRM aberto aparece "Online agora" (verde). Se ele pausar, surge o badge "Pausado" mas a bolinha continua verde (está online, só não recebe). Se ele fechar/deslogar, cai pra "Ausente" (cinza). O pill "TOGGLE ON/OFF" não existe mais.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/account/lead-autoassign/route.ts src/components/settings/lead-autoassign-panel.tsx
git commit -m "feat(presenca): painel mostra online_now (heartbeat) + badge Pausado

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Modelo de dados (default true, backfill, trigger fora do pool, janela 5min) → Task 1. ✅
- Presença automática (heartbeat 2min, beacon pagehide, janela 5min) → Tasks 2 (janela/onlineNow) + 4 (heartbeat/beacon). ✅
- Saída imediata (offline backend + logout) → Tasks 3 (POST offline) + 5 (logout). ✅
- Botão Pausar → Task 4. ✅
- Painel (online_now + Pausado, some pill) → Task 6. ✅
- Distribuição/cron sem mudança → coberto por Task 1 (predicado central); nenhuma task toca webhook/cron, por design. ✅
- Decisão "agente novo fora do pool" → Task 1 (trigger `false, true`). ✅

**2. Placeholder scan:** Sem TBD/TODO. Todo passo de código tem o código. Verificações manuais estão descritas como instrução (rotas/UI não têm teste unitário neste projeto) — não são placeholders, são o método de verificação real aqui.

**3. Type consistency:** `onlineNow(lastActivityAt: string | null, now: Date)` definido na Task 2, consumido com essa assinatura na Task 6. `PRESENCE_WINDOW_MS` (Task 2) = 5min, espelha `INTERVAL '5 minutes'` (Task 1). `is_available` tratado como "recebendo" em todas as tasks. `online_now` substitui `available_now` consistentemente nas DUAS `RosterEntry` (Task 6). Export `LeadAvailabilityControl` (Task 4) casa com o import no header (Task 4 Step 2).

**Riscos / notas:**
- (a) **Janela em dois lugares:** Task 1 (SQL) e Task 2 (TS) precisam ambos dizer 5min. Constraint global registra.
- (b) **Migration manual:** o comportamento de runtime (default true, janela 5min, agente novo fora do pool) só vale DEPOIS do Iago aplicar a 035. Até lá, a UI da janela (5min) pode divergir do SQL (15min). Aplicar antes de mergear.
- (c) **sendBeacon + cookie:** depende do cookie de sessão same-origin (Supabase SSR). O logout (Task 5) usa `keepalive` ANTES do signOut justamente porque o `pagehide` rodaria sem cookie.
- (d) **available_now removido:** `isAvailableNow` deixa de ser chamado por `buildView`, mas continua exportado e testado como mirror do SQL — não é dead code (cobre o predicado do rodízio em teste).

/**
 * Rate limiter com backend distribuído via Upstash Redis.
 *
 * Estratégia: fixed-window por chave.
 * - Quando UPSTASH_REDIS_REST_URL + TOKEN estão configurados, usa o
 *   Upstash (distribuído, funciona sob Vercel fan-out/multi-região).
 * - Caso contrário, cai no fallback local em Map (dev/test/CI).
 * - Fail-open: qualquer erro do Upstash emite warn e deixa a requisição
 *   passar — rate limit é proteção, não pode derrubar tráfego legítimo.
 *
 * Memory (fallback local): entradas ~50 bytes cada. Com LIGHT_SWEEP, chaves
 * expiradas são limpas a cada ~1.000 chamadas sem timer de background —
 * compatível com edge runtimes que não mantêm timers vivos entre requests.
 */

import { NextResponse } from 'next/server';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

export interface RateLimitOptions {
  /** Máximo de requisições permitidas em `windowMs`. */
  limit: number;
  /** Tamanho da janela, em milissegundos. */
  windowMs: number;
}

export interface RateLimitResult {
  success: boolean;
  /** Requisições ainda permitidas na janela atual. */
  remaining: number;
  /** Unix ms quando o bucket recarrega. */
  reset: number;
  limit: number;
}

// ───────────── Fallback local (Map em memória) ─────────────
// Usado quando o Upstash não está configurado (dev/test/CI). Em produção
// na Vercel, o Map é por-instância e NÃO segura sob fan-out — por isso o
// Upstash. Mantido como fallback que nunca derruba o app.
interface Entry { count: number; resetAt: number; }
const buckets = new Map<string, Entry>();
const LIGHT_SWEEP_EVERY = 1000;
let callsSinceSweep = 0;

function sweepExpired(now: number) {
  for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
}

function checkRateLimitLocal(key: string, { limit, windowMs }: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  if (++callsSinceSweep >= LIGHT_SWEEP_EVERY) { callsSinceSweep = 0; sweepExpired(now); }
  const entry = buckets.get(key);
  if (!entry || entry.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { success: true, remaining: limit - 1, reset: now + windowMs, limit };
  }
  if (entry.count >= limit) return { success: false, remaining: 0, reset: entry.resetAt, limit };
  entry.count += 1;
  return { success: true, remaining: limit - entry.count, reset: entry.resetAt, limit };
}

// ───────────── Backend Upstash (distribuído) ─────────────
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const upstashEnabled = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

let redis: Redis | null = null;
const limiterCache = new Map<string, Ratelimit>();

function getLimiter(opts: RateLimitOptions): Ratelimit {
  if (!redis) redis = new Redis({ url: UPSTASH_URL!, token: UPSTASH_TOKEN! });
  const cacheKey = `${opts.limit}:${opts.windowMs}`;
  let rl = limiterCache.get(cacheKey);
  if (!rl) {
    rl = new Ratelimit({
      redis,
      limiter: Ratelimit.fixedWindow(opts.limit, `${opts.windowMs} ms`),
      prefix: 'vtg-rl',
      analytics: false,
    });
    limiterCache.set(cacheKey, rl);
  }
  return rl;
}

/**
 * Verifica e consome 1 do orçamento de `key`. Distribuído via Upstash quando
 * configurado; senão, Map local. Fail-open: qualquer erro do Upstash deixa
 * passar (warn) — o rate limit é proteção, não pode derrubar tráfego legítimo.
 */
export async function checkRateLimit(
  key: string,
  opts: RateLimitOptions,
): Promise<RateLimitResult> {
  if (!upstashEnabled) return checkRateLimitLocal(key, opts);
  try {
    const r = await getLimiter(opts).limit(key);
    return { success: r.success, remaining: r.remaining, reset: r.reset, limit: r.limit };
  } catch {
    console.warn('[rate-limit] Upstash indisponível — fail-open');
    return { success: true, remaining: opts.limit - 1, reset: Date.now() + opts.windowMs, limit: opts.limit };
  }
}

/**
 * Resposta 429 padrão com os headers que os clientes esperam (RFC 6585 +
 * draft-ietf-httpapi-ratelimit-headers). Callers apenas fazem `return` disso.
 */
export function rateLimitResponse(result: RateLimitResult): NextResponse {
  const retryAfterSec = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
  return NextResponse.json(
    {
      error: 'Rate limit exceeded',
      retry_after_seconds: retryAfterSec,
    },
    {
      status: 429,
      headers: {
        'Retry-After': String(retryAfterSec),
        'X-RateLimit-Limit': String(result.limit),
        'X-RateLimit-Remaining': String(result.remaining),
        'X-RateLimit-Reset': String(Math.ceil(result.reset / 1000)),
      },
    },
  );
}

/** Orçamentos pré-configurados — ajustar aqui, não nos call sites. */
export const RATE_LIMITS = {
  /** Envio individual de mensagem. 60/min por usuário = um por segundo
   *  sustentado, confortável para um humano digitando ao vivo. */
  send: { limit: 60, windowMs: 60_000 },
  /** Disparo de broadcast. 5/min por usuário — mesmo um broadcast de 1.000
   *  destinatários é uma chamada; isso limita a taxa de lançamento de
   *  campanhas, não as mensagens dentro de uma. */
  broadcast: { limit: 5, windowMs: 60_000 },
  /** Adicionar/trocar/remover reação. Mais permissivo que send — usuários
   *  mexem muito em reações e um "swap" são duas chamadas (remove + add). */
  react: { limit: 120, windowMs: 60_000 },
  /** Peek de convite (público, por IP). 30/min permite retentativas sob
   *  conectividade instável sem habilitar brute-force de tokens. */
  invitationPeek: { limit: 30, windowMs: 60_000 },
  /** Redeem de convite (autenticado, por IP+user). Mais restrito que peek —
   *  um redeem muta dois perfis e uma linha de convite. */
  invitationRedeem: { limit: 10, windowMs: 60_000 },
  /** Ações admin de conta/membros: criar/revogar convite, renomear conta,
   *  alterar papel, remover membro, transferir ownership. 30/min por usuário
   *  está acima de qualquer uso legítimo e ainda limita abuso acidental. */
  adminAction: { limit: 30, windowMs: 60_000 },
  /** Envio via API key externa (agente n8n respondendo). Bucket por CONTA,
   *  não por usuário — a key autentica uma conta e um agente pode fan out
   *  várias respostas. 120/min é generoso para bot conversacional. */
  apiSend: { limit: 120, windowMs: 60_000 },
  /** Escrita de contatos via API (upsert/patch). Por conta. */
  contactsWrite: { limit: 120, windowMs: 60_000 },
  /** Leitura de contatos/tags/campos via API. Mais folgado. */
  contactsRead: { limit: 240, windowMs: 60_000 },
  /** Escrita de negócios via API. Por conta. */
  dealsWrite: { limit: 120, windowMs: 60_000 },
  /** Leitura de negócios/pipelines via API. Mais folgado. */
  dealsRead: { limit: 240, windowMs: 60_000 },
  /** Leitura de conversas/mensagens via API. Por conta. */
  conversationsRead: { limit: 240, windowMs: 60_000 },
  /** Download de mídia do WhatsApp pelo proxy. Por usuário — humano no inbox
   *  carrega várias mídias ao abrir conversa (e elas ficam em cache no
   *  navegador, então re-render não reconta). 240/min trava download em massa
   *  sem atrapalhar uso normal. */
  media: { limit: 240, windowMs: 60_000 },
  /** Disparo de broadcast via API. APERTADO (custa $) — por conta. */
  broadcastSend: { limit: 10, windowMs: 60_000 },
  /** Presença do vendedor: toggle Disponível + heartbeat de atividade.
   *  Por usuário. O heartbeat bate a cada ~4min; 30/min cobre bursts de
   *  foco/aba sem custo. */
  presence: { limit: 30, windowMs: 60_000 },
} as const;

/** Helper exclusivo para testes. Limpa o estado em memória para que testes
 *  unitários não vazem buckets entre arquivos. Não usado em produção. */
export function __resetRateLimitForTests() {
  buckets.clear();
  callsSinceSweep = 0;
}

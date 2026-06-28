// ============================================================
// Utilitários de webhook secret — puro, server-side, sem Supabase.
//
// Mesmo padrão de `api-keys.ts`: o secret é gerado com CSPRNG,
// devolvido ao admin UMA vez na criação, e armazenado em texto
// simples em `webhook_endpoints.secret` (enviado como token estático no
// header `x-webhook-token` na entrega; validado pelo Header Auth do n8n).
//
// Formato: `whsec_<base64url(32 bytes)>`
//   - prefixo `whsec_` facilita detecção em secret scanners.
//   - 32 bytes = 256 bits de entropia.
// ============================================================

import { randomBytes } from "node:crypto";

/** Prefixo fixo de todo webhook secret emitido. */
export const WEBHOOK_SECRET_PREFIX = "whsec_";

/**
 * Gera um novo webhook secret: prefixo + 32 bytes aleatórios em base64url.
 * Chamar uma vez por endpoint criado; o valor vai pro banco e pro admin
 * (devolto UMA vez na resposta do POST).
 */
export function generateWebhookSecret(): string {
  return WEBHOOK_SECRET_PREFIX + randomBytes(32).toString("base64url");
}

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

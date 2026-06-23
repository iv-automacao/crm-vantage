// ============================================================
// API key utilities — pure, server-side, no Supabase.
//
// Mesma filosofia de `invitations.ts`: a chave crua é gerada com
// CSPRNG, devolvida ao criador UMA vez, e só o SHA-256 (`token_hash`)
// é persistido em `api_keys`. Um snapshot vazado do banco não rende
// uma chave usável.
//
// Formato da chave: `vtg_sk_<base64url(32 bytes)>`
//   - prefixo `vtg_sk_` (VANTAGE secret key) facilita detecção em
//     secret scanners e deixa óbvio o que é a string num log.
//   - 32 bytes de entropia = padrão pra tokens opacos (256 bits).
// ============================================================

import { createHash, randomBytes } from "node:crypto";

/** Prefixo fixo de toda chave emitida. */
export const API_KEY_PREFIX = "vtg_sk_";

/** Escopo mínimo (e único, no v1) que uma chave pode ter. */
export const SCOPE_MESSAGES_SEND = "messages:send";

export interface GeneratedApiKey {
  /** Chave crua — mostrar ao criador UMA vez, nunca persistir. */
  key: string;
  /** SHA-256 hex da chave. Persistir em `api_keys.token_hash`. */
  tokenHash: string;
  /** Trecho exibível pra a UI reconhecer a chave (`api_keys.prefix`). */
  prefix: string;
}

/**
 * Gera uma nova chave + hash + prefixo de exibição. Chamar uma vez
 * por criação; a crua vai pro usuário, o hash pro banco.
 */
export function generateApiKey(): GeneratedApiKey {
  const key = API_KEY_PREFIX + randomBytes(32).toString("base64url");
  return {
    key,
    tokenHash: hashApiKey(key),
    prefix: displayPrefix(key),
  };
}

/**
 * SHA-256 determinístico da chave crua. Usado no login externo pra
 * achar a linha de `api_keys` por `token_hash`. Função pura.
 */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Trecho mascarado pra exibição: prefixo + primeiros 4 chars do
 * segredo + "…" + últimos 4. Não permite reconstruir a chave.
 *   vtg_sk_a1b2…wxyz
 */
export function displayPrefix(key: string): string {
  const secret = key.startsWith(API_KEY_PREFIX)
    ? key.slice(API_KEY_PREFIX.length)
    : key;
  const head = secret.slice(0, 4);
  const tail = secret.slice(-4);
  return `${API_KEY_PREFIX}${head}…${tail}`;
}

/**
 * Extrai o bearer token do header Authorization. Retorna null se
 * ausente ou malformado. Pura — não toca em rede/DB.
 */
export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

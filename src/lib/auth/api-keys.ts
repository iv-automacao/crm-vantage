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

/** Escopo de leitura de contatos. */
export const SCOPE_CONTACTS_READ = "contacts:read";

/** Escopo de escrita/gerenciamento de contatos. */
export const SCOPE_CONTACTS_WRITE = "contacts:write";

/** Escopo de leitura de negócios (deals/funil). */
export const SCOPE_DEALS_READ = "deals:read";

/** Escopo de escrita/gerenciamento de negócios (deals/funil). */
export const SCOPE_DEALS_WRITE = "deals:write";

/** Escopo de leitura de conversas e histórico de mensagens. */
export const SCOPE_CONVERSATIONS_READ = "conversations:read";

/** Escopo de envio de broadcasts (campanhas) via template aprovado. */
export const SCOPE_BROADCASTS_SEND = "broadcasts:send";

/** Todos os scopes que uma chave pode ter. Fonte da verdade. */
export const ALL_SCOPES = [
  SCOPE_MESSAGES_SEND,
  SCOPE_CONTACTS_READ,
  SCOPE_CONTACTS_WRITE,
  SCOPE_DEALS_READ,
  SCOPE_DEALS_WRITE,
  SCOPE_CONVERSATIONS_READ,
  SCOPE_BROADCASTS_SEND,
] as const;

/** Metadados pra UI (checkboxes) — label/descrição em português. */
export const API_KEY_SCOPE_META: Record<string, { label: string; description: string }> = {
  [SCOPE_MESSAGES_SEND]: { label: "Enviar mensagens", description: "Enviar mensagens em conversas desta conta." },
  [SCOPE_CONTACTS_READ]: { label: "Ler contatos", description: "Buscar contatos e listar tags/campos." },
  [SCOPE_CONTACTS_WRITE]: { label: "Gerenciar contatos", description: "Criar/atualizar contatos e aplicar tags/campos." },
  [SCOPE_DEALS_READ]: { label: "Ler negócios", description: "Ler negócios e listar pipelines." },
  [SCOPE_DEALS_WRITE]: { label: "Gerenciar negócios", description: "Criar e atualizar negócios no funil." },
  [SCOPE_CONVERSATIONS_READ]: { label: "Ler conversas", description: "Ler conversas e histórico de mensagens." },
  [SCOPE_BROADCASTS_SEND]: { label: "Disparar campanhas", description: "Enviar broadcasts por template e listar templates aprovados." },
};

/**
 * Normaliza scopes vindos do cliente: mantém só os válidos, dedup,
 * e cai pra ['messages:send'] se nada válido sobrar.
 */
export function sanitizeScopes(input: unknown): string[] {
  const valid = new Set<string>(ALL_SCOPES);
  const arr = Array.isArray(input) ? input.filter((s): s is string => typeof s === "string") : [];
  const kept = [...new Set(arr)].filter((s) => valid.has(s));
  return kept.length > 0 ? kept : [SCOPE_MESSAGES_SEND];
}

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

// ============================================================
// Utilitários de webhook secret — puro, server-side, sem Supabase.
//
// Mesmo padrão de `api-keys.ts`: o secret é gerado com CSPRNG,
// devolvido ao admin UMA vez na criação, e armazenado em texto
// simples em `webhook_endpoints.secret` (usado pra assinar os
// payloads com HMAC na entrega — não é um token de autenticação).
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
 * Aceita somente http:// e https:// — rejeita strings vazias,
 * outros protocolos e entradas não-string.
 */
export function isValidWebhookUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.trim().length === 0) return false;
  return url.startsWith("http://") || url.startsWith("https://");
}

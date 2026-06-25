// src/lib/capi/crypto.ts
// Cifra/decifra o access_token do CAPI em repouso, reusando o AES-256-GCM
// do WhatsApp. A leitura é tolerante a legado: tokens salvos em texto plano
// (antes deste hardening) continuam funcionando e são cifrados no próximo save.
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'

/** Cifra o token CAPI (AES-256-GCM). Sempre produz formato cifrado. */
export function encryptCapiToken(plaintext: string): string {
  return encrypt(plaintext)
}

/**
 * Decifra o token CAPI. Se o valor não estiver no formato cifrado (token
 * plano legado), `decrypt` lança e devolvemos o valor cru + um aviso
 * genérico (nunca logando o token). O re-save no painel passa a cifrar.
 */
export function decryptCapiToken(stored: string): string {
  try {
    return decrypt(stored)
  } catch {
    console.warn(
      '[capi] access_token em formato legado (texto plano) — re-salve a config do CAPI para cifrar em repouso',
    )
    return stored
  }
}

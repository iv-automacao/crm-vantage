import crypto from 'node:crypto'

/** Assina o corpo cru com HMAC-SHA256. Mesma forma que verifyMetaWebhookSignature compara. */
export function signWebhookPayload(rawBody: string, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
}

import { expect, it } from 'vitest'
import { signWebhookPayload } from './signature'
import crypto from 'node:crypto'

it('assina HMAC-SHA256 com prefixo sha256=', () => {
  const body = '{"a":1}', secret = 'whsec_test'
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
  expect(signWebhookPayload(body, secret)).toBe(expected)
})
it('muda quando o corpo muda', () => {
  expect(signWebhookPayload('{"a":1}', 's')).not.toBe(signWebhookPayload('{"a":2}', 's'))
})

// src/lib/rate-limit.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const OPTS = { limit: 3, windowMs: 1000 }

// Mock do @upstash/ratelimit. `limitImpl` é trocado por teste.
let limitImpl: (id: string) => Promise<unknown> = async () => ({
  success: true, limit: 3, remaining: 2, reset: Date.now() + 1000,
})
vi.mock('@upstash/ratelimit', () => ({
  Ratelimit: class {
    static fixedWindow() { return {} }
    limit(id: string) { return limitImpl(id) }
  },
}))
vi.mock('@upstash/redis', () => ({ Redis: class {} }))

async function freshModule() {
  vi.resetModules()
  return await import('./rate-limit')
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('checkRateLimit — fallback local (sem env Upstash)', () => {
  beforeEach(() => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '')
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '')
  })

  it('permite dentro do limite e bloqueia ao estourar', async () => {
    const { checkRateLimit } = await freshModule()
    expect((await checkRateLimit('user:1', OPTS)).success).toBe(true)
    expect((await checkRateLimit('user:1', OPTS)).success).toBe(true)
    expect((await checkRateLimit('user:1', OPTS)).success).toBe(true)
    expect((await checkRateLimit('user:1', OPTS)).success).toBe(false)
  })

  it('isola buckets por key', async () => {
    const { checkRateLimit } = await freshModule()
    await checkRateLimit('user:1', OPTS)
    await checkRateLimit('user:1', OPTS)
    await checkRateLimit('user:1', OPTS)
    expect((await checkRateLimit('user:2', OPTS)).success).toBe(true)
  })
})

describe('checkRateLimit — Upstash (com env)', () => {
  beforeEach(() => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://x.upstash.io')
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'tok')
  })

  it('mapeia a resposta do Upstash pro RateLimitResult', async () => {
    const reset = Date.now() + 5000
    limitImpl = async () => ({ success: false, limit: 3, remaining: 0, reset })
    const { checkRateLimit } = await freshModule()
    const r = await checkRateLimit('user:1', OPTS)
    expect(r).toEqual({ success: false, remaining: 0, reset, limit: 3 })
  })

  it('fail-open quando o Upstash lança', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    limitImpl = async () => { throw new Error('rede caiu') }
    const { checkRateLimit } = await freshModule()
    const r = await checkRateLimit('user:1', OPTS)
    expect(r.success).toBe(true) // deixou passar
    expect(warn).toHaveBeenCalled()
  })
})

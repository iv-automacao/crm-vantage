/**
 * Testes do gate de autenticação em GET /api/automations/cron.
 *
 * Foco: validar que o secret errado é rejeitado (401) e o certo
 * passa do gate — sem bater em banco. Segue o padrão de test fino
 * descrito no brief da Task 2.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------
// Mock do supabaseAdmin e do engine pra não bater em banco/rede.
// ---------------------------------------------------------------

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          lte: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        }),
      }),
    }),
  }),
}))

vi.mock('@/lib/automations/engine', () => ({
  resumePendingExecution: vi.fn().mockResolvedValue(undefined),
}))

// ---------------------------------------------------------------
// Import pós-mocks
// ---------------------------------------------------------------

import { GET } from './route'

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

const SECRET = 'segredo-cron-teste-123'

function makeReq(secretHeader?: string): NextRequest {
  const headers: Record<string, string> = {}
  if (secretHeader !== undefined) {
    headers['x-cron-secret'] = secretHeader
  }
  return new NextRequest('http://localhost/api/automations/cron', { headers })
}

// ---------------------------------------------------------------
// Suite
// ---------------------------------------------------------------

describe('GET /api/automations/cron — gate de autenticação', () => {
  const originalEnv = process.env.AUTOMATION_CRON_SECRET

  beforeEach(() => {
    process.env.AUTOMATION_CRON_SECRET = SECRET
  })

  afterEach(() => {
    process.env.AUTOMATION_CRON_SECRET = originalEnv
  })

  it('sem variável de ambiente → 503 cron not configured', async () => {
    delete process.env.AUTOMATION_CRON_SECRET
    const res = await GET(makeReq('qualquer'))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toBe('cron not configured')
  })

  it('secret errado → 401 Unauthorized', async () => {
    const res = await GET(makeReq('secret-errado'))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Unauthorized')
  })

  it('header ausente → 401 Unauthorized', async () => {
    const res = await GET(makeReq(undefined))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Unauthorized')
  })

  it('secret correto → passa do gate (200 com processed)', async () => {
    const res = await GET(makeReq(SECRET))
    // Pode ser 200 com processed: 0 (nenhuma linha pendente no mock)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.processed).toBe('number')
  })
})

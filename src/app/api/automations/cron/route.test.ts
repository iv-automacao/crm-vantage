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
// Mock flexível do supabaseAdmin — qualquer sequência de query-builder
// resolve para { data: [], error: null }. Necessário porque o cron
// agora faz múltiplas chains diferentes (pending drain + waiting queue).
// ---------------------------------------------------------------

function chain() {
  const obj: any = {}
  const methods = ['from', 'select', 'eq', 'lte', 'order', 'limit', 'update', 'maybeSingle', 'single', 'insert', 'is']
  for (const m of methods) obj[m] = vi.fn(() => obj)
  // Thenable: permite await direto na chain sem .limit() explícito
  obj.then = (resolve: any) => resolve({ data: [], error: null })
  return obj
}

vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: vi.fn(() => chain()) }))

vi.mock('@/lib/automations/engine', () => ({
  resumePendingExecution: vi.fn().mockResolvedValue(undefined),
}))

// assignNextAgent não é chamado quando a fila de espera está vazia (mock
// retorna []), mas o módulo precisa existir para o import no route.ts.
vi.mock('@/lib/leads/round-robin', () => ({
  assignNextAgent: vi.fn().mockResolvedValue({ agentId: null }),
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

  it('secret correto → passa do gate (200 com processed e assigned)', async () => {
    const res = await GET(makeReq(SECRET))
    // Pode ser 200 com processed: 0 e assigned: 0 (nenhuma linha pendente no mock)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.processed).toBe('number')
    expect(typeof body.assigned).toBe('number')
  })

  it('secret correto → resposta inclui assigned', async () => {
    const res = await GET(makeReq(SECRET))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.assigned).toBe(0)
  })
})

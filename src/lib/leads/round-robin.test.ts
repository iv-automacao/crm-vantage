import { describe, it, expect, vi } from 'vitest'
import { pickIndex, isAvailableNow, onlineNow, assignNextAgent } from './round-robin'

// Data/hora fixa para todos os testes de disponibilidade
const NOW = new Date('2026-06-25T12:00:00Z')

// Helper: retorna um timestamp relativo a NOW em milissegundos
function msAgo(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString()
}

const MIN = 60 * 1000

describe('pickIndex', () => {
  it('retorna -1 quando pool está vazia (size 0)', () => {
    expect(pickIndex(0, 0)).toBe(-1)
  })

  it('retorna -1 quando size é negativo', () => {
    expect(pickIndex(5, -1)).toBe(-1)
  })

  it('faz rodízio correto com size 3: 0,1,2,0,1', () => {
    expect(pickIndex(0, 3)).toBe(0)
    expect(pickIndex(1, 3)).toBe(1)
    expect(pickIndex(2, 3)).toBe(2)
    expect(pickIndex(3, 3)).toBe(0) // wrap A→B→C→A
    expect(pickIndex(4, 3)).toBe(1)
  })

  it('size 1 sempre retorna 0 independente do cursor', () => {
    expect(pickIndex(0, 1)).toBe(0)
    expect(pickIndex(99, 1)).toBe(0)
    expect(pickIndex(1000, 1)).toBe(0)
  })
})

describe('onlineNow', () => {
  it('true quando o heartbeat é recente (2min)', () => {
    expect(onlineNow(msAgo(2 * MIN), NOW)).toBe(true)
  })

  it('false quando o heartbeat passou da janela (8min > 5min)', () => {
    expect(onlineNow(msAgo(8 * MIN), NOW)).toBe(false)
  })

  it('false no limite exato da janela (5min)', () => {
    expect(onlineNow(msAgo(5 * MIN), NOW)).toBe(false)
  })

  it('false quando last_activity_at é null', () => {
    expect(onlineNow(null, NOW)).toBe(false)
  })
})

describe('isAvailableNow', () => {
  it('true quando in_pool + recebendo + heartbeat recente (2min)', () => {
    const p = { in_pool: true, is_available: true, last_activity_at: msAgo(2 * MIN) }
    expect(isAvailableNow(p, NOW)).toBe(true)
  })

  it('false quando is_available (recebendo) é false — agente pausado', () => {
    const p = { in_pool: true, is_available: false, last_activity_at: msAgo(2 * MIN) }
    expect(isAvailableNow(p, NOW)).toBe(false)
  })

  it('false quando in_pool é false', () => {
    const p = { in_pool: false, is_available: true, last_activity_at: msAgo(2 * MIN) }
    expect(isAvailableNow(p, NOW)).toBe(false)
  })

  it('false quando o heartbeat passou da janela (8min)', () => {
    const p = { in_pool: true, is_available: true, last_activity_at: msAgo(8 * MIN) }
    expect(isAvailableNow(p, NOW)).toBe(false)
  })

  it('false quando last_activity_at é null', () => {
    const p = { in_pool: true, is_available: true, last_activity_at: null }
    expect(isAvailableNow(p, NOW)).toBe(false)
  })
})

describe('assignNextAgent', () => {
  const ACCOUNT = 'acc-1'
  const CONVERSATION = 'conv-1'

  // `db` fake: `.rpc` controlável; `.from` é um chainable no-op. A impl NOVA não
  // deve chamar `.from` (a atribuição mora na RPC) — mas o chainable garante que,
  // contra a impl ANTIGA, o teste RED falhe pela ASSERÇÃO e não por TypeError.
  function fakeDb(rpcResult: { data?: unknown; error?: unknown }) {
    const chain: Record<string, unknown> = {}
    chain.update = vi.fn(() => chain)
    chain.eq = vi.fn(() => chain)
    chain.is = vi.fn(() => chain)
    return {
      rpc: vi.fn().mockResolvedValue(rpcResult),
      from: vi.fn(() => chain),
    }
  }
  type DbArg = Parameters<typeof assignNextAgent>[0]

  // RED real (falham por asserção na impl atual):
  it('chama a RPC com p_account_id E p_conversation_id', async () => {
    const db = fakeDb({ data: 'agent-9' })
    await assignNextAgent(db as unknown as DbArg, ACCOUNT, CONVERSATION)
    expect(db.rpc).toHaveBeenCalledWith('pick_next_agent_round_robin', {
      p_account_id: ACCOUNT,
      p_conversation_id: CONVERSATION,
    })
  })

  it('NÃO faz UPDATE separado em conversations (atribuição mora na RPC)', async () => {
    const db = fakeDb({ data: 'agent-9' })
    await assignNextAgent(db as unknown as DbArg, ACCOUNT, CONVERSATION)
    expect(db.from).not.toHaveBeenCalled()
  })

  // Regression-guards (já verdes; travam o contrato de retorno):
  it('retorna o agentId quando a RPC devolve um id', async () => {
    const db = fakeDb({ data: 'agent-9' })
    const res = await assignNextAgent(db as unknown as DbArg, ACCOUNT, CONVERSATION)
    expect(res).toEqual({ agentId: 'agent-9' })
  })

  it('retorna agentId null quando a RPC devolve null (ninguém ou já atribuído)', async () => {
    const db = fakeDb({ data: null })
    const res = await assignNextAgent(db as unknown as DbArg, ACCOUNT, CONVERSATION)
    expect(res).toEqual({ agentId: null })
  })

  it('retorna agentId null quando a RPC dá erro', async () => {
    const db = fakeDb({ error: { message: 'boom' } })
    const res = await assignNextAgent(db as unknown as DbArg, ACCOUNT, CONVERSATION)
    expect(res).toEqual({ agentId: null })
  })
})

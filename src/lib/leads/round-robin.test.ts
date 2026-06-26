import { describe, it, expect } from 'vitest'
import { pickIndex, isAvailableNow } from './round-robin'

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

describe('isAvailableNow', () => {
  it('retorna true quando agente está completamente disponível (atividade há 5min)', () => {
    const p = {
      in_pool: true,
      is_available: true,
      last_activity_at: msAgo(5 * MIN),
    }
    expect(isAvailableNow(p, NOW)).toBe(true)
  })

  it('retorna false quando is_available é false', () => {
    const p = {
      in_pool: true,
      is_available: false,
      last_activity_at: msAgo(5 * MIN),
    }
    expect(isAvailableNow(p, NOW)).toBe(false)
  })

  it('retorna false quando in_pool é false', () => {
    const p = {
      in_pool: false,
      is_available: true,
      last_activity_at: msAgo(5 * MIN),
    }
    expect(isAvailableNow(p, NOW)).toBe(false)
  })

  it('retorna false quando atividade é antiga (há 20min — acima do limite de 15min)', () => {
    const p = {
      in_pool: true,
      is_available: true,
      last_activity_at: msAgo(20 * MIN),
    }
    expect(isAvailableNow(p, NOW)).toBe(false)
  })

  it('retorna false quando last_activity_at é null', () => {
    const p = {
      in_pool: true,
      is_available: true,
      last_activity_at: null,
    }
    expect(isAvailableNow(p, NOW)).toBe(false)
  })
})

import { describe, it, expect } from 'vitest'
import { agentSeesOnlyAssigned, conversationVisibleTo } from './visibility'

describe('agentSeesOnlyAssigned', () => {
  it('só agent é escopado', () => {
    expect(agentSeesOnlyAssigned('agent')).toBe(true)
    expect(agentSeesOnlyAssigned('admin')).toBe(false)
    expect(agentSeesOnlyAssigned('owner')).toBe(false)
    expect(agentSeesOnlyAssigned('viewer')).toBe(false)
    expect(agentSeesOnlyAssigned(null)).toBe(false)
  })
})

describe('conversationVisibleTo', () => {
  const mine = { assigned_agent_id: 'u1' }
  const others = { assigned_agent_id: 'u2' }
  const orphan = { assigned_agent_id: null }
  it('admin/owner/viewer veem todas', () => {
    for (const r of ['admin', 'owner', 'viewer'] as const) {
      expect(conversationVisibleTo(others, r, 'u1')).toBe(true)
      expect(conversationVisibleTo(orphan, r, 'u1')).toBe(true)
    }
  })
  it('agent vê só as atribuídas a ele', () => {
    expect(conversationVisibleTo(mine, 'agent', 'u1')).toBe(true)
    expect(conversationVisibleTo(others, 'agent', 'u1')).toBe(false)
    expect(conversationVisibleTo(orphan, 'agent', 'u1')).toBe(false)
  })
  it('fail-closed: agent sem userId não vê nada escopável', () => {
    expect(conversationVisibleTo(mine, 'agent', null)).toBe(false)
  })
})

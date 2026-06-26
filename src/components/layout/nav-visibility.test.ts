import { describe, it, expect } from 'vitest'
import { visibleNavItems, type NavGate } from './nav-visibility'

const ITEMS: { href: string; minRole?: NavGate }[] = [
  { href: '/dashboard' }, { href: '/inbox' }, { href: '/contacts' }, { href: '/pipelines' },
  { href: '/broadcasts', minRole: 'admin' }, { href: '/automations', minRole: 'admin' },
  { href: '/flows', minRole: 'admin' }, { href: '/settings', minRole: 'admin' },
]

describe('visibleNavItems', () => {
  it('admin vê tudo', () => {
    expect(visibleNavItems(ITEMS, 'admin').map((i) => i.href)).toContain('/broadcasts')
    expect(visibleNavItems(ITEMS, 'owner').length).toBe(ITEMS.length)
  })
  it('agent NÃO vê broadcasts/automations/flows/settings', () => {
    const hrefs = visibleNavItems(ITEMS, 'agent').map((i) => i.href)
    expect(hrefs).toEqual(['/dashboard', '/inbox', '/contacts', '/pipelines'])
  })
  it('viewer idem agent (só itens sem minRole)', () => {
    const hrefs = visibleNavItems(ITEMS, 'viewer').map((i) => i.href)
    expect(hrefs).not.toContain('/settings')
  })
  it('role nulo (carregando) esconde os gated (fail-closed)', () => {
    const hrefs = visibleNavItems(ITEMS, null).map((i) => i.href)
    expect(hrefs).not.toContain('/broadcasts')
  })
})

// src/lib/capi/crypto.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encryptCapiToken, decryptCapiToken } from './crypto'

afterEach(() => vi.restoreAllMocks())

describe('crypto do token CAPI', () => {
  it('round-trip: decryptCapiToken(encryptCapiToken(x)) === x', () => {
    const token = 'EAAGtoken_secreto_123'
    const cifrado = encryptCapiToken(token)
    expect(cifrado).not.toContain(token) // não vaza o plano
    expect(cifrado.split(':').length).toBe(3) // formato GCM iv:ct:tag
    expect(decryptCapiToken(cifrado)).toBe(token)
  })

  it('tolerante a legado: token plano (sem formato cifrado) volta cru', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const plano = 'EAAGtoken_plano_legado'
    expect(decryptCapiToken(plano)).toBe(plano)
    expect(warn).toHaveBeenCalled()
  })

  it('o aviso de legado nunca inclui o valor do token', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const plano = 'EAAGtoken_super_secreto'
    decryptCapiToken(plano)
    const loggedArgs = warn.mock.calls.flat().join(' ')
    expect(loggedArgs).not.toContain(plano)
  })
})

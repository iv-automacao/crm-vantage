import { describe, expect, it } from 'vitest'
import { validateCapiInput } from './settings'

const current = { dataset_id: null, has_token: false, event_name: 'Purchase', is_active: false }

describe('validateCapiInput', () => {
  it('aceita config válida e monta o patch (token só quando enviado)', () => {
    const r = validateCapiInput({ dataset_id: 'ds_1', access_token: 'tok', event_name: 'Lead', is_active: true }, current)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.patch).toMatchObject({ dataset_id: 'ds_1', access_token: 'tok', event_name: 'Lead', is_active: true })
    }
  })

  it('não inclui access_token no patch quando vazio/omitido', () => {
    const r = validateCapiInput({ dataset_id: 'ds_1', is_active: false }, current)
    expect(r.ok).toBe(true)
    if (r.ok) expect('access_token' in r.patch).toBe(false)
  })

  it('rejeita ativar sem dataset_id', () => {
    const r = validateCapiInput({ is_active: true, access_token: 'tok' }, current)
    expect(r).toEqual({ ok: false, error: expect.any(String) })
  })

  it('rejeita ativar sem token (nem novo nem salvo)', () => {
    const r = validateCapiInput({ dataset_id: 'ds_1', is_active: true }, current)
    expect(r.ok).toBe(false)
  })

  it('aceita ativar usando token já salvo', () => {
    const r = validateCapiInput({ dataset_id: 'ds_1', is_active: true }, { ...current, has_token: true })
    expect(r.ok).toBe(true)
  })
})

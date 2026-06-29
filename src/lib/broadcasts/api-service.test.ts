/**
 * Testes unitários de broadcasts/api-service.ts.
 *
 * Estratégia: fake do Supabase admin (service-role) injetado via ctx,
 * agora ciente de insert/in/update além de select/eq/order/maybeSingle.
 * sendTemplateMessage e decrypt mockados para isolar a lógica.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { TemplateNotApprovedError, WhatsappNotConfiguredError } from '@/lib/api/errors'
import { listApprovedTemplates, sendBroadcast } from './api-service'
import type { ApiServiceCtx } from '@/lib/api/service-context'

vi.mock('@/lib/whatsapp/meta-api', () => ({ sendTemplateMessage: vi.fn() }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: vi.fn((v: string) => `decrypted:${v}`) }))

import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'

interface Recorders {
  eqCalls?: Record<string, Array<[string, unknown]>>
  inserts?: Record<string, unknown[]>
  updates?: Record<string, unknown[]>
}

/**
 * Fake admin com respostas configuráveis por tabela. Chaves de resposta:
 *  - '<tabela>'           → select chains (.eq/.in/.order/.maybeSingle/.single)
 *  - '<tabela>:insert'    → .insert(...) (await direto OU .select().single())
 *  - '<tabela>:update'    → .update(...).eq(...) (await)
 */
function makeFakeAdmin(
  tableResponses: Record<string, { data: unknown; error: unknown }>,
  rec: Recorders = {},
): SupabaseClient {
  function makeBuilder(table: string) {
    const selectResp = tableResponses[table] ?? { data: null, error: null }
    let verb: 'select' | 'insert' | 'update' = 'select'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder: any = {}
    const thenableOf = (resp: { data: unknown; error: unknown }) => ({
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(resp).then(resolve),
      catch: (reject: (e: unknown) => unknown) => Promise.resolve(resp).catch(reject),
      maybeSingle: () => Promise.resolve(resp),
      single: () => Promise.resolve(resp),
    })
    builder.select = () => builder
    builder.eq = (column: string, value: unknown) => {
      if (rec.eqCalls) (rec.eqCalls[table] ??= []).push([column, value])
      if (verb === 'update') {
        return Promise.resolve(tableResponses[`${table}:update`] ?? { error: null })
      }
      return builder
    }
    builder.in = () => thenableOf(selectResp)
    builder.order = () => thenableOf(selectResp)
    builder.maybeSingle = () => Promise.resolve(selectResp)
    builder.single = () => Promise.resolve(selectResp)
    builder.insert = (payload: unknown) => {
      if (rec.inserts) (rec.inserts[table] ??= []).push(payload)
      verb = 'insert'
      const insResp = tableResponses[`${table}:insert`] ?? { data: null, error: null }
      return {
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(insResp).then(resolve),
        catch: (reject: (e: unknown) => unknown) => Promise.resolve(insResp).catch(reject),
        select: () => ({
          single: () => Promise.resolve(insResp),
          maybeSingle: () => Promise.resolve(insResp),
        }),
      }
    }
    builder.update = (payload: unknown) => {
      if (rec.updates) (rec.updates[table] ??= []).push(payload)
      verb = 'update'
      return builder
    }
    return builder
  }
  return { from: (table: string) => makeBuilder(table) } as unknown as SupabaseClient
}

function makeCtx(
  tableResponses: Record<string, { data: unknown; error: unknown }>,
  rec: Recorders = {},
): ApiServiceCtx {
  return { admin: makeFakeAdmin(tableResponses, rec), accountId: 'acct-test', auditUserId: 'user-audit' }
}

const FAKE_CONFIG = { account_id: 'acct-test', phone_number_id: 'phone-id-1', access_token: 'encrypted-token' }
const FAKE_TEMPLATE = {
  id: 'tpl-1', user_id: 'user-1', account_id: 'acct-test', name: 'promo', language: 'pt_BR',
  category: 'MARKETING', status: 'APPROVED', body_text: 'Oi {{1}}, seu pedido {{2}} chegou!',
  buttons: null, header_type: null, header_text: null, sample_values: null, meta_template_id: null,
  created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
}
// Resposta padrão da criação do broadcast (sucesso) — usada no happy path.
const OK_PERSIST = {
  whatsapp_config: { data: FAKE_CONFIG, error: null },
  message_templates: { data: FAKE_TEMPLATE, error: null },
  'broadcasts:insert': { data: { id: 'bc-1' }, error: null },
  contacts: { data: [], error: null },
}

beforeEach(() => vi.clearAllMocks())

describe('listApprovedTemplates', () => {
  it('retorna lista vazia quando não há templates aprovados', async () => {
    const ctx = makeCtx({ message_templates: { data: [], error: null } })
    expect(await listApprovedTemplates(ctx)).toEqual([])
  })

  it('mapeia os campos corretamente incluindo variables_count', async () => {
    const templates = [{ name: 'promo', language: 'pt_BR', category: 'MARKETING', status: 'APPROVED', body_text: 'Oi {{1}}, seu pedido {{2}} chegou!' }]
    const ctx = makeCtx({ message_templates: { data: templates, error: null } })
    const result = await listApprovedTemplates(ctx)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('promo')
    expect(result[0].variables_count).toBe(2)
  })

  it('variables_count = 0 quando body_text é null', async () => {
    const ctx = makeCtx({ message_templates: { data: [{ name: 'x', language: 'en_US', category: null, status: 'APPROVED', body_text: null }], error: null } })
    expect((await listApprovedTemplates(ctx))[0].variables_count).toBe(0)
  })

  it('propaga erro do Supabase', async () => {
    const ctx = makeCtx({ message_templates: { data: null, error: new Error('DB error') } })
    await expect(listApprovedTemplates(ctx)).rejects.toThrow('DB error')
  })
})

describe('sendBroadcast — configuração/template inválidos', () => {
  it('WhatsappNotConfiguredError (409) quando config ausente', async () => {
    const ctx = makeCtx({ whatsapp_config: { data: null, error: null } })
    await expect(sendBroadcast(ctx, { template_name: 'promo', template_language: 'pt_BR', recipients: [{ phone: '5592999999999' }] }))
      .rejects.toBeInstanceOf(WhatsappNotConfiguredError)
  })

  it('TemplateNotApprovedError (422) quando template PENDING', async () => {
    const ctx = makeCtx({ whatsapp_config: { data: FAKE_CONFIG, error: null }, message_templates: { data: { ...FAKE_TEMPLATE, status: 'PENDING' }, error: null } })
    await expect(sendBroadcast(ctx, { template_name: 'promo', template_language: 'pt_BR', recipients: [{ phone: '5592999999999' }] }))
      .rejects.toBeInstanceOf(TemplateNotApprovedError)
  })

  it('propaga erro do banco em whatsapp_config sem mascarar', async () => {
    const ctx = makeCtx({ whatsapp_config: { data: null, error: { message: 'DB down' } }, message_templates: { data: FAKE_TEMPLATE, error: null } })
    await expect(sendBroadcast(ctx, { template_name: 'promo', template_language: 'pt_BR', recipients: [{ phone: '5592999999999' }] }))
      .rejects.toMatchObject({ message: 'DB down' })
  })
})

describe('sendBroadcast — segurança/comportamento preservados', () => {
  it('filtra whatsapp_config e message_templates pelo account_id (scoping por tenant)', async () => {
    vi.mocked(sendTemplateMessage).mockResolvedValue({ messageId: 'm' })
    const eqCalls: Record<string, Array<[string, unknown]>> = {}
    const ctx = makeCtx(OK_PERSIST, { eqCalls })
    await sendBroadcast(ctx, { template_name: 'promo', template_language: 'pt_BR', recipients: [{ phone: '5592999999991' }] })
    expect(eqCalls['whatsapp_config']).toContainEqual(['account_id', 'acct-test'])
    expect(eqCalls['message_templates']).toContainEqual(['account_id', 'acct-test'])
  })

  it('descriptografa o access_token da config', async () => {
    vi.mocked(sendTemplateMessage).mockResolvedValue({ messageId: 'm' })
    const ctx = makeCtx(OK_PERSIST)
    await sendBroadcast(ctx, { template_name: 'promo', template_language: 'pt_BR', recipients: [{ phone: '5592999999991' }] })
    expect(decrypt).toHaveBeenCalledWith('encrypted-token')
  })

  it('faz retry de variante em erro "not allowed" e envia', async () => {
    vi.mocked(sendTemplateMessage)
      .mockRejectedValueOnce(new Error('Error 131030: not in allowed list'))
      .mockResolvedValueOnce({ messageId: 'msg-variant' })
    const ctx = makeCtx(OK_PERSIST)
    const result = await sendBroadcast(ctx, { template_name: 'promo', template_language: 'pt_BR', recipients: [{ phone: '5592999999997' }] })
    expect(vi.mocked(sendTemplateMessage).mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(result.results[0]).toMatchObject({ status: 'sent', whatsapp_message_id: 'msg-variant' })
  })
})

describe('sendBroadcast — happy path + persistência', () => {
  it('envia para 2 destinatários e retorna sent=2, failed=0, broadcast_id', async () => {
    vi.mocked(sendTemplateMessage).mockResolvedValueOnce({ messageId: 'msg-1' }).mockResolvedValueOnce({ messageId: 'msg-2' })
    const ctx = makeCtx(OK_PERSIST)
    const result = await sendBroadcast(ctx, {
      template_name: 'promo', template_language: 'pt_BR',
      recipients: [{ phone: '5592999999991', params: ['João', 'ORD-001'] }, { phone: '5592999999992', params: ['Maria', 'ORD-002'] }],
    })
    expect(result.sent).toBe(2)
    expect(result.failed).toBe(0)
    expect(result.broadcast_id).toBe('bc-1')
    expect(result.results[0]).toMatchObject({ phone: '5592999999991', status: 'sent', whatsapp_message_id: 'msg-1' })
  })

  it('cria a linha broadcasts com account_id, user_id (auditUserId), status sending e total_recipients', async () => {
    vi.mocked(sendTemplateMessage).mockResolvedValue({ messageId: 'm' })
    const inserts: Record<string, unknown[]> = {}
    const ctx = makeCtx(OK_PERSIST, { inserts })
    await sendBroadcast(ctx, { template_name: 'promo', template_language: 'pt_BR', name: 'Campanha X', recipients: [{ phone: '5592999999991' }, { phone: '5592999999992' }] })
    expect(inserts['broadcasts'][0]).toMatchObject({
      account_id: 'acct-test', user_id: 'user-audit', name: 'Campanha X',
      template_name: 'promo', template_language: 'pt_BR', status: 'sending', total_recipients: 2,
    })
  })

  it('insere 1 broadcast_recipients por destinatário com whatsapp_message_id', async () => {
    vi.mocked(sendTemplateMessage).mockResolvedValueOnce({ messageId: 'msg-1' }).mockResolvedValueOnce({ messageId: 'msg-2' })
    const inserts: Record<string, unknown[]> = {}
    const ctx = makeCtx(OK_PERSIST, { inserts })
    await sendBroadcast(ctx, { template_name: 'promo', template_language: 'pt_BR', recipients: [{ phone: '5592999999991' }, { phone: '5592999999992' }] })
    const recps = inserts['broadcast_recipients']
    expect(recps).toHaveLength(2)
    expect(recps[0]).toMatchObject({ broadcast_id: 'bc-1', status: 'sent', whatsapp_message_id: 'msg-1' })
    expect(recps[1]).toMatchObject({ broadcast_id: 'bc-1', status: 'sent', whatsapp_message_id: 'msg-2' })
  })

  it('linka contact_id quando o telefone casa um contato existente; null quando não', async () => {
    vi.mocked(sendTemplateMessage).mockResolvedValueOnce({ messageId: 'msg-1' }).mockResolvedValueOnce({ messageId: 'msg-2' })
    const inserts: Record<string, unknown[]> = {}
    const ctx = makeCtx(
      { ...OK_PERSIST, contacts: { data: [{ id: 'c-1', phone: '5592999999991' }], error: null } },
      { inserts },
    )
    await sendBroadcast(ctx, { template_name: 'promo', template_language: 'pt_BR', recipients: [{ phone: '5592999999991' }, { phone: '5592999999992' }] })
    const recps = inserts['broadcast_recipients'] as Array<{ contact_id: string | null }>
    expect(recps[0].contact_id).toBe('c-1')
    expect(recps[1].contact_id).toBeNull()
  })

  it('finaliza broadcasts.status = sent quando ao menos 1 enviou', async () => {
    vi.mocked(sendTemplateMessage).mockResolvedValue({ messageId: 'm' })
    const updates: Record<string, unknown[]> = {}
    const ctx = makeCtx(OK_PERSIST, { updates })
    await sendBroadcast(ctx, { template_name: 'promo', template_language: 'pt_BR', recipients: [{ phone: '5592999999991' }] })
    expect(updates['broadcasts'][0]).toMatchObject({ status: 'sent' })
  })

  it('falha do envio vira recipient failed + error_message, sem derrubar o lote', async () => {
    vi.mocked(sendTemplateMessage).mockRejectedValueOnce(new Error('Meta 500')).mockResolvedValueOnce({ messageId: 'msg-ok' })
    const inserts: Record<string, unknown[]> = {}
    const ctx = makeCtx(OK_PERSIST, { inserts })
    const result = await sendBroadcast(ctx, { template_name: 'promo', template_language: 'pt_BR', recipients: [{ phone: '5592999999995' }, { phone: '5592999999996' }] })
    expect(result.sent).toBe(1)
    expect(result.failed).toBe(1)
    const recps = inserts['broadcast_recipients'] as Array<{ status: string; error_message: string | null }>
    expect(recps[0]).toMatchObject({ status: 'failed', error_message: 'Meta 500' })
    expect(recps[1]).toMatchObject({ status: 'sent' })
  })

  it('erro ao criar broadcasts → 500 (ApiError), sem enviar', async () => {
    const ctx = makeCtx({ ...OK_PERSIST, 'broadcasts:insert': { data: null, error: { message: 'insert fail' } } })
    await expect(sendBroadcast(ctx, { template_name: 'promo', template_language: 'pt_BR', recipients: [{ phone: '5592999999991' }] }))
      .rejects.toMatchObject({ status: 500 })
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })
})

/**
 * Testes unitários de broadcasts/api-service.ts.
 *
 * Estratégia: fake mínimo do Supabase admin injetado via ctx.
 * sendTemplateMessage e decrypt são mockados para isolar a lógica de negócio.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { TemplateNotApprovedError, WhatsappNotConfiguredError } from '@/lib/api/errors'
import { listApprovedTemplates, sendBroadcast } from './api-service'
import type { ApiServiceCtx } from '@/lib/api/service-context'

// ─── Mocks de módulos externos ────────────────────────────────────────────────

vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTemplateMessage: vi.fn(),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn((v: string) => `decrypted:${v}`),
}))

import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'

// ─── Fake query builder ───────────────────────────────────────────────────────

/**
 * Cria fake do Supabase admin com respostas configuráveis por tabela.
 * Suporta chamadas encadeadas de select/eq/order/maybeSingle.
 * eqCalls registra todos os pares (column, value) passados a .eq() por tabela.
 */
function makeFakeAdmin(
  tableResponses: Record<string, { data: unknown; error: unknown }>,
  eqCalls?: Record<string, Array<[string, unknown]>>,
): SupabaseClient {
  function makeBuilder(table: string) {
    const resp = tableResponses[table] ?? { data: null, error: null }
    const builder: Record<string, unknown> = {}
    // order() é terminal no listApprovedTemplates (sem maybeSingle depois)
    const terminal = () => Promise.resolve(resp)
    const chain = () => builder
    builder.select = chain
    // Registra chamadas a .eq() para validação de scoping por tenant
    builder.eq = (column: string, value: unknown) => {
      if (eqCalls) {
        if (!eqCalls[table]) eqCalls[table] = []
        eqCalls[table].push([column, value])
      }
      return builder
    }
    // order() pode ser usado como terminal (list queries) ou encadeado
    builder.order = () => {
      // Retorna thenable — funciona como terminal E como encadeável
      const thenable = {
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(resp).then(resolve),
        catch: (reject: (e: unknown) => unknown) => Promise.resolve(resp).catch(reject),
        maybeSingle: terminal,
        single: terminal,
      }
      return thenable
    }
    builder.maybeSingle = terminal
    builder.single = terminal
    return builder
  }
  return { from: (table: string) => makeBuilder(table) } as unknown as SupabaseClient
}

function makeCtx(
  tableResponses: Record<string, { data: unknown; error: unknown }>,
  eqCalls?: Record<string, Array<[string, unknown]>>,
): ApiServiceCtx {
  return {
    admin: makeFakeAdmin(tableResponses, eqCalls),
    accountId: 'acct-test',
    auditUserId: 'user-audit',
  }
}

// ─── Template de config e template padrão para testes ────────────────────────

const FAKE_CONFIG = {
  account_id: 'acct-test',
  phone_number_id: 'phone-id-1',
  access_token: 'encrypted-token',
}

// Template mínimo válido para isMessageTemplate (id, user_id, name, body_text como string)
const FAKE_TEMPLATE = {
  id: 'tpl-1',
  user_id: 'user-1',
  account_id: 'acct-test',
  name: 'promo',
  language: 'pt_BR',
  category: 'MARKETING',
  status: 'APPROVED',
  body_text: 'Oi {{1}}, seu pedido {{2}} chegou!',
  buttons: null,
  header_type: null,
  header_text: null,
  sample_values: null,
  meta_template_id: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ─── listApprovedTemplates ────────────────────────────────────────────────────

describe('listApprovedTemplates', () => {
  it('retorna lista vazia quando não há templates aprovados', async () => {
    const ctx = makeCtx({ message_templates: { data: [], error: null } })
    const result = await listApprovedTemplates(ctx)
    expect(result).toEqual([])
  })

  it('mapeia os campos corretamente incluindo variables_count', async () => {
    const templates = [
      {
        name: 'promo',
        language: 'pt_BR',
        category: 'MARKETING',
        status: 'APPROVED',
        body_text: 'Oi {{1}}, seu pedido {{2}} chegou!',
      },
    ]
    const ctx = makeCtx({ message_templates: { data: templates, error: null } })
    const result = await listApprovedTemplates(ctx)

    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('promo')
    expect(result[0].language).toBe('pt_BR')
    expect(result[0].category).toBe('MARKETING')
    expect(result[0].status).toBe('APPROVED')
    // Conta {{1}} e {{2}} = 2
    expect(result[0].variables_count).toBe(2)
  })

  it('variables_count = 0 quando body_text é null', async () => {
    const templates = [
      { name: 'sem_var', language: 'en_US', category: null, status: 'APPROVED', body_text: null },
    ]
    const ctx = makeCtx({ message_templates: { data: templates, error: null } })
    const result = await listApprovedTemplates(ctx)
    expect(result[0].variables_count).toBe(0)
  })

  it('variables_count correto para body_text com espaços em {{  1  }}', async () => {
    const templates = [
      { name: 'espacos', language: 'en_US', category: null, status: 'APPROVED', body_text: 'Olá {{  1  }}, bem vindo!' },
    ]
    const ctx = makeCtx({ message_templates: { data: templates, error: null } })
    const result = await listApprovedTemplates(ctx)
    expect(result[0].variables_count).toBe(1)
  })

  it('propaga erro do Supabase', async () => {
    const ctx = makeCtx({ message_templates: { data: null, error: new Error('DB error') } })
    await expect(listApprovedTemplates(ctx)).rejects.toThrow('DB error')
  })
})

// ─── sendBroadcast — erros de configuração ────────────────────────────────────

describe('sendBroadcast — configuração ausente', () => {
  it('lança WhatsappNotConfiguredError quando whatsapp_config não existe', async () => {
    const ctx = makeCtx({
      whatsapp_config: { data: null, error: null },
      message_templates: { data: FAKE_TEMPLATE, error: null },
    })
    await expect(
      sendBroadcast(ctx, {
        template_name: 'promo',
        template_language: 'pt_BR',
        recipients: [{ phone: '5592999999999' }],
      })
    ).rejects.toThrow(WhatsappNotConfiguredError)
  })

  it('WhatsappNotConfiguredError tem status 409', async () => {
    const ctx = makeCtx({ whatsapp_config: { data: null, error: null } })
    try {
      await sendBroadcast(ctx, { template_name: 'promo', template_language: 'pt_BR', recipients: [{ phone: '5592999999999' }] })
      expect.fail('deveria ter lançado')
    } catch (err) {
      expect(err).toBeInstanceOf(WhatsappNotConfiguredError)
      expect((err as WhatsappNotConfiguredError).status).toBe(409)
    }
  })
})

// ─── sendBroadcast — erros de template ───────────────────────────────────────

describe('sendBroadcast — template inválido', () => {
  it('lança TemplateNotApprovedError quando template não existe', async () => {
    const ctx = makeCtx({
      whatsapp_config: { data: FAKE_CONFIG, error: null },
      message_templates: { data: null, error: null },
    })
    await expect(
      sendBroadcast(ctx, { template_name: 'inexistente', template_language: 'pt_BR', recipients: [{ phone: '5592999999999' }] })
    ).rejects.toThrow(TemplateNotApprovedError)
  })

  it('lança TemplateNotApprovedError quando template está PENDING', async () => {
    const pendingTemplate = { ...FAKE_TEMPLATE, status: 'PENDING' }
    const ctx = makeCtx({
      whatsapp_config: { data: FAKE_CONFIG, error: null },
      message_templates: { data: pendingTemplate, error: null },
    })
    await expect(
      sendBroadcast(ctx, { template_name: 'promo', template_language: 'pt_BR', recipients: [{ phone: '5592999999999' }] })
    ).rejects.toThrow(TemplateNotApprovedError)
  })

  it('TemplateNotApprovedError tem status 422', async () => {
    const ctx = makeCtx({
      whatsapp_config: { data: FAKE_CONFIG, error: null },
      message_templates: { data: null, error: null },
    })
    try {
      await sendBroadcast(ctx, { template_name: 'promo', template_language: 'pt_BR', recipients: [{ phone: '5592999999999' }] })
      expect.fail('deveria ter lançado')
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateNotApprovedError)
      expect((err as TemplateNotApprovedError).status).toBe(422)
    }
  })
})

// ─── sendBroadcast — propagação de erros do banco ────────────────────────────

describe('sendBroadcast — erros de banco de dados', () => {
  it('propaga erro do Supabase em whatsapp_config sem lançar WhatsappNotConfiguredError', async () => {
    const dbError = { message: 'DB down', code: '08006' }
    const ctx = makeCtx({
      whatsapp_config: { data: null, error: dbError },
      message_templates: { data: FAKE_TEMPLATE, error: null },
    })
    // Deve rejeitar com o erro do banco, não com WhatsappNotConfiguredError
    await expect(
      sendBroadcast(ctx, { template_name: 'promo', template_language: 'pt_BR', recipients: [{ phone: '5592999999999' }] })
    ).rejects.toMatchObject({ message: 'DB down' })
    // Garante que não foi mascarado como erro de negócio (409)
    await expect(
      sendBroadcast(ctx, { template_name: 'promo', template_language: 'pt_BR', recipients: [{ phone: '5592999999999' }] })
    ).rejects.not.toBeInstanceOf(WhatsappNotConfiguredError)
  })

  it('propaga erro do Supabase em message_templates sem lançar TemplateNotApprovedError', async () => {
    const dbError = { message: 'connection timeout', code: '08001' }
    const ctx = makeCtx({
      whatsapp_config: { data: FAKE_CONFIG, error: null },
      message_templates: { data: null, error: dbError },
    })
    // Deve rejeitar com o erro do banco, não com TemplateNotApprovedError
    await expect(
      sendBroadcast(ctx, { template_name: 'promo', template_language: 'pt_BR', recipients: [{ phone: '5592999999999' }] })
    ).rejects.toMatchObject({ message: 'connection timeout' })
    // Garante que não foi mascarado como erro de negócio (422)
    await expect(
      sendBroadcast(ctx, { template_name: 'promo', template_language: 'pt_BR', recipients: [{ phone: '5592999999999' }] })
    ).rejects.not.toBeInstanceOf(TemplateNotApprovedError)
  })
})

// ─── sendBroadcast — happy path ───────────────────────────────────────────────

describe('sendBroadcast — happy path', () => {
  it('envia para 2 destinatários válidos e retorna sent=2, failed=0', async () => {
    const mockSend = vi.mocked(sendTemplateMessage)
    mockSend
      .mockResolvedValueOnce({ messageId: 'msg-1' })
      .mockResolvedValueOnce({ messageId: 'msg-2' })

    const ctx = makeCtx({
      whatsapp_config: { data: FAKE_CONFIG, error: null },
      message_templates: { data: FAKE_TEMPLATE, error: null },
    })

    const result = await sendBroadcast(ctx, {
      template_name: 'promo',
      template_language: 'pt_BR',
      recipients: [
        { phone: '5592999999991', params: ['João', 'ORD-001'] },
        { phone: '5592999999992', params: ['Maria', 'ORD-002'] },
      ],
    })

    expect(result.sent).toBe(2)
    expect(result.failed).toBe(0)
    expect(mockSend).toHaveBeenCalledTimes(2)
    expect(result.results[0]).toMatchObject({ phone: '5592999999991', status: 'sent', whatsapp_message_id: 'msg-1' })
    expect(result.results[1]).toMatchObject({ phone: '5592999999992', status: 'sent', whatsapp_message_id: 'msg-2' })
  })

  it('filtra whatsapp_config e message_templates pelo account_id da conta (scoping por tenant)', async () => {
    const mockSend = vi.mocked(sendTemplateMessage)
    mockSend.mockResolvedValueOnce({ messageId: 'msg-scope' })

    // eqCalls registra todos os pares (column, value) passados a .eq() por tabela
    const eqCalls: Record<string, Array<[string, unknown]>> = {}
    const ctx = makeCtx(
      {
        whatsapp_config: { data: FAKE_CONFIG, error: null },
        message_templates: { data: FAKE_TEMPLATE, error: null },
      },
      eqCalls,
    )

    await sendBroadcast(ctx, {
      template_name: 'promo',
      template_language: 'pt_BR',
      recipients: [{ phone: '5592999999998' }],
    })

    // Ambas as queries devem filtrar pelo account_id do contexto
    expect(eqCalls['whatsapp_config']).toContainEqual(['account_id', 'acct-test'])
    expect(eqCalls['message_templates']).toContainEqual(['account_id', 'acct-test'])
  })

  it('chama decrypt no access_token da config', async () => {
    const mockSend = vi.mocked(sendTemplateMessage)
    mockSend.mockResolvedValueOnce({ messageId: 'msg-x' })
    const mockDecrypt = vi.mocked(decrypt)

    const ctx = makeCtx({
      whatsapp_config: { data: FAKE_CONFIG, error: null },
      message_templates: { data: FAKE_TEMPLATE, error: null },
    })

    await sendBroadcast(ctx, {
      template_name: 'promo',
      template_language: 'pt_BR',
      recipients: [{ phone: '5592999999993' }],
    })

    expect(mockDecrypt).toHaveBeenCalledWith('encrypted-token')
  })
})

// ─── sendBroadcast — falhas parciais ─────────────────────────────────────────

describe('sendBroadcast — falhas parciais', () => {
  it('telefone inválido vira entry failed sem derrubar os outros', async () => {
    const mockSend = vi.mocked(sendTemplateMessage)
    mockSend.mockResolvedValueOnce({ messageId: 'msg-ok' })

    const ctx = makeCtx({
      whatsapp_config: { data: FAKE_CONFIG, error: null },
      message_templates: { data: FAKE_TEMPLATE, error: null },
    })

    const result = await sendBroadcast(ctx, {
      template_name: 'promo',
      template_language: 'pt_BR',
      recipients: [
        { phone: 'invalido' },           // deve falhar — não é E.164
        { phone: '5592999999994' },      // deve passar
      ],
    })

    expect(result.sent).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.results[0]).toMatchObject({ phone: 'invalido', status: 'failed' })
    expect(result.results[1]).toMatchObject({ phone: '5592999999994', status: 'sent', whatsapp_message_id: 'msg-ok' })
  })

  it('erro do sendTemplateMessage vira failed sem derrubar os outros destinatários', async () => {
    const mockSend = vi.mocked(sendTemplateMessage)
    mockSend
      .mockRejectedValueOnce(new Error('Meta API error: 500'))   // primeiro falha
      .mockResolvedValueOnce({ messageId: 'msg-ok' })            // segundo ok

    const ctx = makeCtx({
      whatsapp_config: { data: FAKE_CONFIG, error: null },
      message_templates: { data: FAKE_TEMPLATE, error: null },
    })

    const result = await sendBroadcast(ctx, {
      template_name: 'promo',
      template_language: 'pt_BR',
      recipients: [
        { phone: '5592999999995' },
        { phone: '5592999999996' },
      ],
    })

    expect(result.sent).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.results[0]).toMatchObject({ phone: '5592999999995', status: 'failed', error: 'Meta API error: 500' })
    expect(result.results[1]).toMatchObject({ phone: '5592999999996', status: 'sent', whatsapp_message_id: 'msg-ok' })
  })

  it('erro "not in allowed list" faz retry com variante de telefone', async () => {
    const mockSend = vi.mocked(sendTemplateMessage)
    // Primeira chamada (variante original) falha com "not in allowed list"
    mockSend
      .mockRejectedValueOnce(new Error('Error 131030: not in allowed list'))
      .mockResolvedValueOnce({ messageId: 'msg-variant' })

    const ctx = makeCtx({
      whatsapp_config: { data: FAKE_CONFIG, error: null },
      message_templates: { data: FAKE_TEMPLATE, error: null },
    })

    const result = await sendBroadcast(ctx, {
      template_name: 'promo',
      template_language: 'pt_BR',
      recipients: [{ phone: '5592999999997' }],
    })

    // Deve ter tentado ao menos 2x (original + variante) e enviado com sucesso
    expect(mockSend.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(result.sent).toBe(1)
    expect(result.results[0].status).toBe('sent')
    expect(result.results[0].whatsapp_message_id).toBe('msg-variant')
  })
})

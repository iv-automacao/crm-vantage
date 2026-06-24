import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { validationError, errorEnvelope, ApiError, UnknownTagError, UnknownFieldError, NotFoundError, UnknownPipelineError, UnknownStageError, TemplateNotApprovedError, WhatsappNotConfiguredError } from './errors'
import { toErrorResponse } from '@/lib/auth/account'

describe('errorEnvelope', () => {
  it('retorna NextResponse com status e corpo corretos', async () => {
    const res = errorEnvelope('bad_request', 'Corpo JSON inválido', 400)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Corpo JSON inválido')
    expect(body.code).toBe('bad_request')
  })

  it('inclui details quando fornecido', async () => {
    const details = [{ field: 'nome', message: 'obrigatório' }]
    const res = errorEnvelope('validation_error', 'Falha', 422, details)
    const body = await res.json()
    expect(body.details).toEqual(details)
  })

  it('omite details quando não fornecido', async () => {
    const res = errorEnvelope('unauthorized', 'Sem acesso', 401)
    const body = await res.json()
    expect(body.details).toBeUndefined()
  })
})

describe('validationError', () => {
  it('mapeia issues de ZodError em detalhes 422', async () => {
    // Schema com dois campos obrigatórios para gerar múltiplos issues
    const schema = z.object({
      nome: z.string(),
      idade: z.number().int().min(0),
    })
    const result = schema.safeParse({ nome: 42, idade: -1 })
    expect(result.success).toBe(false)

    const res = validationError((result as { success: false; error: z.ZodError }).error)
    expect(res.status).toBe(422)

    const body = await res.json()
    expect(body.error).toBe('Falha na validação dos dados enviados')
    expect(body.code).toBe('validation_error')
    expect(Array.isArray(body.details)).toBe(true)

    const fields = (body.details as Array<{ field: string; message: string }>).map((d) => d.field)
    expect(fields).toContain('nome')
    expect(fields).toContain('idade')
  })

  it('campo raiz usa "(root)" como field quando path está vazio', async () => {
    // Schema que falha na raiz (não em campo específico)
    const schema = z.string()
    const result = schema.safeParse(42)
    expect(result.success).toBe(false)

    const res = validationError((result as { success: false; error: z.ZodError }).error)
    const body = await res.json()
    const rootIssue = (body.details as Array<{ field: string }>).find((d) => d.field === '(root)')
    expect(rootIssue).toBeDefined()
  })

  it('message de cada detalhe é a mensagem do issue zod', async () => {
    const schema = z.object({ email: z.string().email() })
    const result = schema.safeParse({ email: 'nao-é-email' })
    expect(result.success).toBe(false)

    const res = validationError((result as { success: false; error: z.ZodError }).error)
    const body = await res.json()
    expect(body.details[0].message).toBeTruthy()
  })
})

describe('ApiError e subclasses', () => {
  it('ApiError expõe status, code e message', () => {
    const err = new ApiError(400, 'bad_request', 'Dados inválidos')
    expect(err.status).toBe(400)
    expect(err.code).toBe('bad_request')
    expect(err.message).toBe('Dados inválidos')
    expect(err.name).toBe('ApiError')
  })

  it('UnknownTagError tem status 422 e code unknown_tag', () => {
    const err = new UnknownTagError('quente')
    expect(err.status).toBe(422)
    expect(err.code).toBe('unknown_tag')
    expect(err.details?.[0].field).toBe('tags')
  })

  it('UnknownFieldError tem status 422 e code unknown_field', () => {
    const err = new UnknownFieldError('modelo')
    expect(err.status).toBe(422)
    expect(err.code).toBe('unknown_field')
    expect(err.details?.[0].field).toBe('custom_fields')
  })

  it('NotFoundError tem status 404 e code not_found', () => {
    const err = new NotFoundError()
    expect(err.status).toBe(404)
    expect(err.code).toBe('not_found')
  })

  it('UnknownPipelineError tem status 422 e code unknown_pipeline', () => {
    const err = new UnknownPipelineError('Vendas')
    expect(err.status).toBe(422)
    expect(err.code).toBe('unknown_pipeline')
    expect(err.details?.[0].field).toBe('pipeline')
  })

  it('UnknownStageError tem status 422 e code unknown_stage', () => {
    const err = new UnknownStageError('Proposta')
    expect(err.status).toBe(422)
    expect(err.code).toBe('unknown_stage')
    expect(err.details?.[0].field).toBe('stage')
  })

  it('TemplateNotApprovedError tem status 422, code template_not_approved e details.field template_name', () => {
    const err = new TemplateNotApprovedError('promo')
    expect(err.status).toBe(422)
    expect(err.code).toBe('template_not_approved')
    expect(err.details?.[0].field).toBe('template_name')
    expect(err.message).toContain('promo')
  })

  it('WhatsappNotConfiguredError tem status 409 e code whatsapp_not_configured', () => {
    const err = new WhatsappNotConfiguredError()
    expect(err.status).toBe(409)
    expect(err.code).toBe('whatsapp_not_configured')
  })
})

describe('toErrorResponse com ApiError', () => {
  it('toErrorResponse mapeia ApiError (422 unknown_tag)', async () => {
    const res = toErrorResponse(new UnknownTagError('quente'))
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.code).toBe('unknown_tag')
    expect(body.details[0].field).toBe('tags')
  })

  it('toErrorResponse mapeia NotFoundError (404)', async () => {
    const res = toErrorResponse(new NotFoundError('Contato não encontrado'))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('not_found')
    expect(body.error).toBe('Contato não encontrado')
  })

  it('toErrorResponse omite details quando ApiError não tem details', async () => {
    const res = toErrorResponse(new NotFoundError())
    const body = await res.json()
    expect(body.details).toBeUndefined()
  })
})

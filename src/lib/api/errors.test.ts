import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { validationError, errorEnvelope } from './errors'

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

import { describe, it, expect, beforeEach } from 'vitest'
// Importa o schema para garantir que SendMessageBody entre no globalRegistry do Zod.
import '@/lib/api/schemas/messages'
import { buildOpenApiDocument, registerOperation, __resetOperationsForTests } from './registry'

describe('buildOpenApiDocument', () => {
  // Limpa as operações registradas antes de cada teste para evitar vazamentos.
  beforeEach(() => __resetOperationsForTests())

  it('emite OpenAPI 3.1 com security scheme apiKey', () => {
    const doc = buildOpenApiDocument()
    expect(doc.openapi).toBe('3.1.0')
    expect(doc.components.securitySchemes.apiKey).toMatchObject({ type: 'http', scheme: 'bearer' })
  })

  it('inclui SendMessageBody em components.schemas', () => {
    const doc = buildOpenApiDocument()
    expect(doc.components.schemas).toHaveProperty('SendMessageBody')
  })

  it('monta o path da operação registrada com $ref pro body', () => {
    registerOperation({
      method: 'post',
      path: '/api/v1/messages/send',
      summary: 'x',
      security: 'apiKey',
      requestBodySchemaId: 'SendMessageBody',
    })
    const doc = buildOpenApiDocument()
    const op = (doc.paths['/api/v1/messages/send'] as Record<string, unknown>).post as {
      security: unknown[]
      requestBody: { content: { 'application/json': { schema: { $ref: string } } } }
    }
    expect(op.security).toEqual([{ apiKey: [] }])
    expect(op.requestBody.content['application/json'].schema.$ref)
      .toBe('#/components/schemas/SendMessageBody')
  })
})

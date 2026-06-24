import { z } from 'zod'

// Uma operação documentada = método HTTP + caminho + metadados OpenAPI.
export interface RegisteredOperation {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete'
  path: string                       // ex: '/api/v1/messages/send'
  summary: string
  tags?: string[]
  operationId?: string
  security?: 'apiKey' | 'none'
  requestBodySchemaId?: string       // id de um schema registrado (ex: 'SendMessageBody')
  // Descrição simples para resposta de sucesso (v1 não precisa modelar todos os shapes).
  successDescription?: string
}

const operations: RegisteredOperation[] = []

// Registra uma operação na lista global.
export function registerOperation(op: RegisteredOperation) {
  operations.push(op)
}

// Limpa o estado — só para testes não vazarem entre suítes.
export function __resetOperationsForTests() {
  operations.length = 0
}

// Monta o documento OpenAPI 3.1 completo.
// NOTA DE IMPORTAÇÃO: o spec.ts é importado pelo route handler ANTES de chamar
// esta função — garante que todas as operações e schemas estejam registrados.
// NÃO importamos spec.ts aqui para evitar efeito colateral duplo nos testes.
export function buildOpenApiDocument() {
  // components.schemas vem de TODOS os schemas Zod com .meta({ id }) registrados
  // no globalRegistry do zod (efeito colateral dos imports em spec.ts).
  //
  // ATENÇÃO (testes): z.globalRegistry é GLOBAL de processo e NÃO é resetado por
  // __resetOperationsForTests() (que só limpa `operations`). Hoje é inofensivo
  // (só existe SendMessageBody). Se um futuro arquivo de teste registrar outros
  // schemas no mesmo worker do vitest, eles também apareceriam aqui — isole com
  // worker separado ou um helper de reset do registry se isso virar problema.
  const { schemas } = z.toJSONSchema(z.globalRegistry, { target: 'openapi-3.0' }) as {
    schemas: Record<string, unknown>
  }

  const paths: Record<string, Record<string, unknown>> = {}
  for (const op of operations) {
    paths[op.path] ??= {}
    paths[op.path][op.method] = {
      summary: op.summary,
      ...(op.tags && { tags: op.tags }),
      ...(op.operationId && { operationId: op.operationId }),
      ...(op.security === 'apiKey' && { security: [{ apiKey: [] }] }),
      ...(op.requestBodySchemaId && {
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: `#/components/schemas/${op.requestBodySchemaId}` },
            },
          },
        },
      }),
      responses: {
        '200': { description: op.successDescription ?? 'Sucesso' },
        '401': { description: 'Não autenticado (Bearer ausente/inválido)' },
        '403': { description: 'Sem permissão / conta inativa' },
        '422': { description: 'Falha de validação' },
        '429': { description: 'Rate limit excedido' },
      },
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'VANTAGE CRM API',
      version: '1.0.0',
      description:
        'API pública do CRM VANTAGE. Autenticação por chave (Authorization: Bearer <chave>). ' +
        'A rota /api/external/whatsapp/send está DEPRECADA — use /api/v1/messages/send.',
    },
    servers: [
      { url: process.env.NEXT_PUBLIC_SITE_URL || 'https://crm.vantagemanaus.com.br' },
    ],
    components: {
      schemas,
      securitySchemes: {
        apiKey: {
          type: 'http',
          scheme: 'bearer',
          description: 'Chave de API VANTAGE no header Authorization: Bearer <chave>.',
        },
      },
    },
    paths,
  }
}

// Registro manual das rotas públicas (revisável a cada nova rota).
// Importa os schemas para garantir que entrem no globalRegistry do Zod,
// e registra as operações correspondentes.
//
// IDEMPOTÊNCIA: este módulo é importado SOMENTE pelo route handler
// (src/app/api/openapi.json/route.ts). Não é importado de dentro de
// registry.ts nem de outros lugares — assim registerOperation() roda
// exatamente uma vez em produção. Nos testes, o __resetOperationsForTests()
// limpa o array antes de cada teste, mas o import deste módulo não é usado
// diretamente (o teste importa registry e schemas separadamente).
import '@/lib/api/schemas/messages'        // efeito colateral: registra SendMessageBody no globalRegistry
import '@/lib/api/schemas/contacts'        // efeito colateral: registra ContactUpsertBody e ContactPatchBody no globalRegistry
import '@/lib/api/schemas/deals'           // efeito colateral: registra DealCreateBody e DealPatchBody no globalRegistry
import { registerOperation } from './registry'

registerOperation({
  method: 'post',
  path: '/api/v1/messages/send',
  summary: 'Enviar mensagem WhatsApp',
  tags: ['Messages'],
  operationId: 'sendMessage',
  security: 'apiKey',
  requestBodySchemaId: 'SendMessageBody',
  successDescription: 'Mensagem enfileirada/enviada. Retorna message_id e whatsapp_message_id.',
})

registerOperation({
  method: 'post',
  path: '/api/v1/contacts',
  summary: 'Criar/atualizar contato',
  tags: ['Contacts'],
  operationId: 'upsertContact',
  security: 'apiKey',
  requestBodySchemaId: 'ContactUpsertBody',
  successDescription: 'Contato criado/atualizado.',
})

registerOperation({
  method: 'get',
  path: '/api/v1/contacts',
  summary: 'Buscar contato por telefone',
  tags: ['Contacts'],
  operationId: 'findContactByPhone',
  security: 'apiKey',
})

registerOperation({
  method: 'get',
  path: '/api/v1/contacts/{id}',
  summary: 'Obter contato',
  tags: ['Contacts'],
  operationId: 'getContact',
  security: 'apiKey',
})

registerOperation({
  method: 'patch',
  path: '/api/v1/contacts/{id}',
  summary: 'Atualizar contato',
  tags: ['Contacts'],
  operationId: 'patchContact',
  security: 'apiKey',
  requestBodySchemaId: 'ContactPatchBody',
})

registerOperation({
  method: 'get',
  path: '/api/v1/tags',
  summary: 'Listar tags',
  tags: ['Contacts'],
  operationId: 'listTags',
  security: 'apiKey',
})

registerOperation({
  method: 'get',
  path: '/api/v1/custom-fields',
  summary: 'Listar campos customizados',
  tags: ['Contacts'],
  operationId: 'listCustomFields',
  security: 'apiKey',
})

registerOperation({
  method: 'post',
  path: '/api/v1/deals',
  summary: 'Criar negócio',
  tags: ['Deals'],
  operationId: 'createDeal',
  security: 'apiKey',
  requestBodySchemaId: 'DealCreateBody',
  successDescription: 'Negócio criado.',
})

registerOperation({
  method: 'get',
  path: '/api/v1/deals',
  summary: 'Listar negócios de um contato',
  tags: ['Deals'],
  operationId: 'listDealsByContact',
  security: 'apiKey',
})

registerOperation({
  method: 'get',
  path: '/api/v1/deals/{id}',
  summary: 'Obter negócio',
  tags: ['Deals'],
  operationId: 'getDeal',
  security: 'apiKey',
})

registerOperation({
  method: 'patch',
  path: '/api/v1/deals/{id}',
  summary: 'Atualizar negócio (etapa/status/valor/título)',
  tags: ['Deals'],
  operationId: 'patchDeal',
  security: 'apiKey',
  requestBodySchemaId: 'DealPatchBody',
})

registerOperation({
  method: 'get',
  path: '/api/v1/pipelines',
  summary: 'Listar pipelines e etapas',
  tags: ['Deals'],
  operationId: 'listPipelines',
  security: 'apiKey',
})

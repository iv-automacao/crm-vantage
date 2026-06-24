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

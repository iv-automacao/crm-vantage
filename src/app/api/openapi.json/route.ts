// Importa spec.ts ANTES de buildOpenApiDocument para garantir que:
// 1) O schema SendMessageBody esteja no globalRegistry do Zod.
// 2) A operação sendMessage esteja registrada no array de operations.
// O efeito colateral do import acontece uma vez em tempo de execução.
import '@/lib/api/openapi/spec'
import { buildOpenApiDocument } from '@/lib/api/openapi/registry'

// NOTA Next.js 16: `dynamic = 'force-static'` é removido quando cacheComponents
// está habilitado no next.config. Neste projeto cacheComponents NÃO está ativado,
// então o export é válido. O next.config.ts já aplica Cache-Control: no-store em
// /api/*, portanto o force-static aqui instrui o build a pré-renderizar o JSON
// mas a resposta de rede não será cacheada no edge (header do config prevalece).
export const dynamic = 'force-static'

export function GET() {
  return Response.json(buildOpenApiDocument())
}

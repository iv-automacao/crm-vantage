// Página pública de documentação (Scalar via CDN). Route handler que
// devolve HTML cru — evita aninhar <html> dentro do root layout do app
// e não adiciona nenhuma dependência npm (Scalar carrega do jsdelivr).
//
// NOTA Next.js 16: `dynamic = 'force-static'` foi verificado como suportado
// neste projeto (cacheComponents não está habilitado em next.config.ts).
// Caso o build reclame de conflito entre force-static e Response custom,
// remova esta linha — a casca HTML é imutável de qualquer forma e o CDN
// do Scalar não precisa de invalidação. Removemos o force-static preventivamente
// pois o next.config.ts já aplica s-maxage=300 para rotas não-API.
const HTML = `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>VANTAGE CRM API — Documentação</title>
  </head>
  <body>
    <script id="api-reference" data-url="/api/openapi.json"></script>
    <!-- Versão pinada (minor travado, recebe patches) — evita um major novo
         do Scalar quebrar a página sem aviso. -->
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.61"></script>
  </body>
</html>`

export function GET() {
  return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
}

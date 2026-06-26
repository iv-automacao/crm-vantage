// src/app/api/route-auth-guard.test.ts
// Guardrail de defesa-em-profundidade: toda rota de API precisa ter um
// mecanismo de autenticação OU estar na allowlist explícita de rotas
// públicas. O middleware NÃO protege /api/account|admin|v1|... — cada
// handler se protege. Este teste garante que nenhuma rota futura esqueça.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const API_DIR = join(process.cwd(), 'src/app/api')

// Markers de auth aceitos (qualquer um presente no arquivo basta).
const AUTH_MARKERS = [
  'requireRole',
  'requireActiveAccount',
  'getCurrentAccount',
  'requirePlatformAdmin',
  'resolveApiKey',
  'defineRoute',
  'AUTOMATION_CRON_SECRET', // crons: auth via header x-cron-secret
  'auth.getUser', // rotas que exigem sessão direto via supabase.auth.getUser() + 401
]

// Rotas públicas POR DESIGN — cada entrada justificada. Caminhos relativos
// a src/app/api, com barras normais.
const PUBLIC_ROUTES = new Set<string>([
  'whatsapp/webhook/route.ts',          // webhook da Meta; verificado por HMAC/verify_token internamente
  'openapi.json/route.ts',              // spec OpenAPI pública
  'external/whatsapp/send/route.ts',    // alias `export { POST } from` da rota v1 (autenticada lá)
  'invitations/[token]/peek/route.ts',  // público por design: token + rate limit por IP, sem sessão
])

function findRouteFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...findRouteFiles(full))
    else if (entry.name === 'route.ts') out.push(full)
  }
  return out
}

describe('guardrail de auth das rotas de API', () => {
  const routeFiles = findRouteFiles(API_DIR)

  it('encontra um conjunto não-trivial de rotas (sanidade do glob)', () => {
    expect(routeFiles.length).toBeGreaterThan(20)
  })

  it('toda rota tem um marker de auth ou está na allowlist pública', () => {
    const offenders: string[] = []
    for (const file of routeFiles) {
      const rel = relative(API_DIR, file).split('\\').join('/')
      const src = readFileSync(file, 'utf8')
      const hasAuth = AUTH_MARKERS.some((m) => src.includes(m))
      if (!hasAuth && !PUBLIC_ROUTES.has(rel)) offenders.push(rel)
    }
    expect(
      offenders,
      `Rotas sem auth nem allowlist:\n${offenders.join('\n')}\n` +
        'Adicione um gate (requireRole/getCurrentAccount/defineRoute/...) ou, ' +
        'se for pública por design, registre em PUBLIC_ROUTES com justificativa.',
    ).toEqual([])
  })

  it('a allowlist não tem entradas mortas (toda pública existe e segue sem auth)', () => {
    const relSet = new Set(
      routeFiles.map((f) => relative(API_DIR, f).split('\\').join('/')),
    )
    for (const pub of PUBLIC_ROUTES) {
      expect(relSet.has(pub), `Allowlist aponta para rota inexistente: ${pub}`).toBe(true)
    }
  })

  // Markers que provam decisão de PAPEL/identidade (não só "tem sessão").
  const STRONG_ROLE_MARKERS = [
    'requireRole',
    'defineRoute',          // carrega minRole/scope/platformAdmin no AuthSpec
    'resolveApiKey',
    'requirePlatformAdmin',
    'AUTOMATION_CRON_SECRET',
  ]
  // Rotas mutantes que legitimamente NÃO usam papel (preencher com motivo).
  const MUTATING_EXCEPTIONS = new Map<string, string>([
    // ex: ['whatsapp/webhook/route.ts', 'pública, validada por assinatura'],
    ['invitations/[token]/redeem/route.ts', 'autz no RPC redeem_invitation; convidado sem papel ainda'],
  ])
  const MUTATING_RE = /export\s+(async\s+function|const)\s+(POST|PATCH|PUT|DELETE)\b/

  function isMutating(src: string): boolean {
    return MUTATING_RE.test(src)
  }

  it('toda rota MUTANTE tem guard de papel forte (não só auth.getUser)', () => {
    const offenders: string[] = []
    for (const file of findRouteFiles(API_DIR)) {
      const rel = relative(API_DIR, file).split('\\').join('/')
      if (PUBLIC_ROUTES.has(rel) || MUTATING_EXCEPTIONS.has(rel)) continue
      const src = readFileSync(file, 'utf8')
      if (!isMutating(src)) continue
      const hasStrong = STRONG_ROLE_MARKERS.some((m) => src.includes(m))
      if (!hasStrong) offenders.push(rel)
    }
    expect(offenders, `rotas mutantes sem guard de papel:\n${offenders.join('\n')}`).toEqual([])
  })
})

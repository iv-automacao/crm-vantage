import { NextResponse } from 'next/server'
import { listFlowTemplates } from '@/lib/flows/templates'
import { requireActiveAccount, toErrorResponse } from '@/lib/auth/account'

/**
 * GET /api/flows/templates — galeria estática de templates (slug + name +
 * description + icon + node_count) pro diálogo de novo flow. Exige conta
 * ativa (sem leitura de banco — só o muro de aprovação).
 */
export async function GET() {
  try {
    await requireActiveAccount()
    const templates = listFlowTemplates().map((t) => ({
      slug: t.slug,
      name: t.name,
      description: t.description,
      icon: t.icon,
      trigger_type: t.trigger_type,
      node_count: t.nodes.length,
    }))
    return NextResponse.json({ templates })
  } catch (err) {
    return toErrorResponse(err)
  }
}

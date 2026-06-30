import { NextResponse } from 'next/server'
import { requireActiveAccount, toErrorResponse } from '@/lib/auth/account'

/**
 * GET /api/flows/[id]/runs — lista os runs (mais recentes primeiro) de um
 * flow com o timeline de eventos embutido. Exige conta ativa; a RLS faz o
 * escopo de posse (404 se o flow não for visível). Limite de 50 runs.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  try {
    const { supabase } = await requireActiveAccount()

    // Confirma que o flow existe + é visível (RLS) antes da query de runs —
    // 404 limpo em vez de lista vazia.
    const { data: flow } = await supabase
      .from('flows')
      .select('id, name')
      .eq('id', id)
      .maybeSingle()
    if (!flow) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const { data: runs, error: runsErr } = await supabase
      .from('flow_runs')
      .select(
        'id, status, current_node_key, started_at, last_advanced_at, ended_at, end_reason, vars, reprompt_count, contact:contacts(id, name, phone)',
      )
      .eq('flow_id', id)
      .order('started_at', { ascending: false })
      .limit(50)
    if (runsErr) {
      return NextResponse.json({ error: runsErr.message }, { status: 500 })
    }

    const runIds = (runs ?? []).map((r) => (r as { id: string }).id)
    let events: Array<{
      flow_run_id: string
      event_type: string
      node_key: string | null
      payload: Record<string, unknown>
      created_at: string
    }> = []
    if (runIds.length > 0) {
      const { data: evs, error: evsErr } = await supabase
        .from('flow_run_events')
        .select('flow_run_id, event_type, node_key, payload, created_at')
        .in('flow_run_id', runIds)
        .order('created_at', { ascending: true })
      if (evsErr) {
        // Não-fatal — a página ainda mostra os runs sem timeline.
        console.error('[flows-runs] events fetch failed:', evsErr.message)
      } else if (evs) {
        events = evs as typeof events
      }
    }

    return NextResponse.json({ flow, runs: runs ?? [], events })
  } catch (err) {
    return toErrorResponse(err)
  }
}

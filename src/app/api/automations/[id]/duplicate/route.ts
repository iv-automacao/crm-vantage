import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // admin+ da conta. ctx.supabase é o client de sessão RLS-scoped — origem,
    // cópia e steps passam pela RLS (escopo por conta, não por criador).
    const { supabase, userId, accountId } = await requireRole('admin')
    const { id } = await params

    const { data: original, error: origErr } = await supabase
      .from('automations')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    if (origErr) {
      console.error('[POST automations/[id]/duplicate] origin error:', origErr.message)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
    if (!original) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // Cópia na MESMA conta do caller (admin verificado). RLS insert = admin+.
    const { data: copy, error: copyErr } = await supabase
      .from('automations')
      .insert({
        account_id: accountId,
        user_id: userId,
        name: `${original.name} (Copy)`,
        description: original.description,
        trigger_type: original.trigger_type,
        trigger_config: original.trigger_config,
        is_active: false,
      })
      .select()
      .single()
    if (copyErr || !copy) {
      console.error('[POST automations/[id]/duplicate] copy error:', copyErr?.message ?? 'unknown')
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }

    const { data: steps } = await supabase
      .from('automation_steps')
      .select('id, parent_step_id, branch, step_type, step_config, position')
      .eq('automation_id', id)
      .order('position', { ascending: true })

    if (steps && steps.length > 0) {
      // Re-mapeia parent_step_id: monta o mapa old→new id primeiro pra o
      // segundo passe inserir com as referências corretas.
      const idMap = new Map<string, string>()
      const uid = () =>
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : Math.random().toString(36).slice(2) + Date.now().toString(36)
      for (const row of steps) idMap.set(row.id as string, uid())

      const rows = steps.map((row) => ({
        id: idMap.get(row.id as string)!,
        automation_id: copy.id,
        parent_step_id: row.parent_step_id ? idMap.get(row.parent_step_id as string) : null,
        branch: row.branch,
        step_type: row.step_type,
        step_config: row.step_config,
        position: row.position,
      }))
      const { error: insErr } = await supabase.from('automation_steps').insert(rows)
      if (insErr) {
        console.error('[POST automations/[id]/duplicate] steps insert error:', insErr.message)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
      }
    }

    return NextResponse.json({ automation: copy }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}

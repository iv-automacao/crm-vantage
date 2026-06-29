import { NextResponse } from 'next/server'
import {
  loadStepsTree,
  replaceSteps,
  type BuilderStepInput,
} from '@/lib/automations/steps-tree'
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from '@/lib/automations/validate'
import { requireActiveAccount, requireRole, toErrorResponse } from '@/lib/auth/account'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Qualquer membro ativo da conta lê (consistente com a lista). A RLS
    // (automations_select) faz o escopo por conta — sem filtro user_id.
    const { supabase } = await requireActiveAccount()
    const { id } = await params

    const { data: automation, error } = await supabase
      .from('automations')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    if (error) {
      console.error('[GET /api/automations/[id]] DB error:', error.message)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
    if (!automation) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const steps = await loadStepsTree(id)
    return NextResponse.json({ automation, steps })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // admin+ da conta (RLS automations_update = admin). ctx.supabase é o
    // client de sessão RLS-scoped — sem service-role, sem filtro user_id.
    const { supabase } = await requireRole('admin')
    const { id } = await params

    const body = await request.json().catch(() => null)
    if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

    // Ownership pela RLS: se a linha não for visível/editável pra este admin,
    // o SELECT volta vazio → 404. Carrega os campos pra computar o estado
    // "efetivo" pós-patch na validação de ativação.
    const { data: existing } = await supabase
      .from('automations')
      .select('id, is_active, trigger_type, trigger_config')
      .eq('id', id)
      .maybeSingle()
    if (!existing) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const update: Record<string, unknown> = {}
    for (const k of [
      'name',
      'description',
      'trigger_type',
      'trigger_config',
      'is_active',
    ] as const) {
      if (k in body) update[k] = body[k]
    }

    // Se o PATCH deixa a automação ativa (ativando OU editando uma já ativa),
    // valida a config mergeada antes. Rascunhos podem ficar incompletos.
    const willBeActive =
      typeof update.is_active === 'boolean' ? update.is_active : existing.is_active
    if (willBeActive) {
      const mergedTriggerType = (update.trigger_type ?? existing.trigger_type) as string
      const mergedTriggerConfig = update.trigger_config ?? existing.trigger_config
      const mergedSteps = Array.isArray(body.steps)
        ? (body.steps as { step_type: string; step_config: Record<string, unknown> }[])
        : await loadStepsTree(id)
      const issues = [
        ...validateTriggerForActivation(mergedTriggerType, mergedTriggerConfig),
        ...validateStepsForActivation(mergedSteps),
      ]
      if (issues.length > 0) {
        return NextResponse.json(
          { error: 'Cannot keep automation active with invalid configuration', issues },
          { status: 400 },
        )
      }
    }

    if (Object.keys(update).length > 0) {
      const { error: updErr } = await supabase
        .from('automations')
        .update(update)
        .eq('id', id)
      if (updErr) {
        console.error('[PATCH /api/automations/[id]] update error:', updErr.message)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
      }
    }

    if (Array.isArray(body.steps)) {
      const err = await replaceSteps(id, body.steps as BuilderStepInput[])
      if (err) {
        console.error('[PATCH /api/automations/[id]] replaceSteps error:', err)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
      }
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase } = await requireRole('admin')
    const { id } = await params

    // RLS (automations_delete = admin+). .select('id') confirma se algo foi
    // de fato apagado — 0 linhas = inexistente / fora da conta → 404.
    const { data, error } = await supabase
      .from('automations')
      .delete()
      .eq('id', id)
      .select('id')
    if (error) {
      console.error('[DELETE /api/automations/[id]] delete error:', error.message)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
    if (!data || data.length === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

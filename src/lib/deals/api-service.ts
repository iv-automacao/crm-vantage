/**
 * Camada de serviço para deals via API externa.
 * Todas as operações são account-scoped — nunca acessa dados de outra conta.
 */

import { NotFoundError, UnknownPipelineError, UnknownStageError } from '@/lib/api/errors'
import type { ApiServiceCtx } from '@/lib/api/service-context'
import type { DealCreateBody, DealPatchBody, DealContactQuery } from '@/lib/api/schemas/deals'
import { getContactById, findContactByPhone } from '@/lib/contacts/api-service'

// ─── Tipos públicos ───────────────────────────────────────────────────────────

export interface DealResource {
  id: string
  title: string
  value: number
  currency: string
  status: string
  pipeline: { id: string; name: string }
  stage: { id: string; name: string }
  contact_id: string
  expected_close_date: string | null
  created_at: string
  updated_at: string
}

export interface PipelineResource {
  id: string
  name: string
  stages: { id: string; name: string; position: number; color: string | null }[]
}

// ─── Resolvers internos (exportados para testes) ───────────────────────────────

/**
 * Resolve pipeline por nome dentro da conta. Lança UnknownPipelineError (422) se não encontrar.
 * Query sempre filtrada por account_id para não vazar dados entre contas.
 */
export async function resolvePipelineByName(
  ctx: ApiServiceCtx,
  name: string,
): Promise<{ id: string; name: string }> {
  const { data, error } = await ctx.admin
    .from('pipelines')
    .select('id,name')
    .eq('account_id', ctx.accountId)
    .eq('name', name)
    .maybeSingle()

  if (error) throw error
  if (!data) throw new UnknownPipelineError(name)
  return data as { id: string; name: string }
}

/**
 * Resolve etapa por nome dentro de um pipeline já validado.
 * Lança UnknownStageError (422) se não encontrar.
 * Tenant garantido — pipelineId foi resolvido dentro da conta.
 */
export async function resolveStageByName(
  ctx: ApiServiceCtx,
  pipelineId: string,
  name: string,
): Promise<{ id: string; name: string }> {
  const { data, error } = await ctx.admin
    .from('pipeline_stages')
    .select('id,name')
    .eq('pipeline_id', pipelineId)
    .eq('name', name)
    .maybeSingle()

  if (error) throw error
  if (!data) throw new UnknownStageError(name)
  return data as { id: string; name: string }
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

/**
 * Busca a moeda padrão da conta. Retorna 'USD' como fallback.
 */
async function resolveAccountCurrency(ctx: ApiServiceCtx): Promise<string> {
  const { data, error } = await ctx.admin
    .from('accounts')
    .select('default_currency')
    .eq('id', ctx.accountId)
    .maybeSingle()

  if (error) throw error
  return (data as { default_currency: string | null } | null)?.default_currency ?? 'USD'
}

/**
 * Resolve contato pelo telefone ou id. Reutiliza os helpers do cluster de contatos.
 * Lança NotFoundError (404) se não encontrar.
 */
async function resolveContact(
  ctx: ApiServiceCtx,
  q: { contact_phone?: string; contact_id?: string },
): Promise<string> {
  if (q.contact_id) {
    // getContactById lança NotFoundError se não existir
    const contact = await getContactById(ctx, q.contact_id)
    return contact.id
  }
  if (q.contact_phone) {
    const contact = await findContactByPhone(ctx, q.contact_phone)
    if (!contact) throw new NotFoundError(`Contato com telefone ${q.contact_phone} não encontrado`)
    return contact.id
  }
  throw new NotFoundError('Informe contact_id ou contact_phone')
}

/**
 * Monta DealResource a partir de uma linha raw do Supabase (com joins).
 * Normaliza array→objeto para os joins !inner quando necessário.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toDealResource(row: any): DealResource {
  // Supabase pode retornar joins como array (quando usa !inner) ou objeto direto
  const pipeline = Array.isArray(row.pipeline) ? row.pipeline[0] : row.pipeline
  const stage = Array.isArray(row.stage) ? row.stage[0] : row.stage

  return {
    id: row.id,
    title: row.title,
    value: row.value ?? 0,
    currency: row.currency ?? 'USD',
    status: row.status,
    pipeline: { id: pipeline?.id ?? '', name: pipeline?.name ?? '' },
    stage: { id: stage?.id ?? '', name: stage?.name ?? '' },
    contact_id: row.contact_id,
    expected_close_date: row.expected_close_date ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

// ─── Leituras ─────────────────────────────────────────────────────────────────

/**
 * Busca um deal por id. Lança NotFoundError se não existir ou pertencer a outra conta.
 */
export async function getDealById(ctx: ApiServiceCtx, id: string): Promise<DealResource> {
  const { data, error } = await ctx.admin
    .from('deals')
    .select(`
      id, title, value, currency, status, contact_id, expected_close_date, created_at, updated_at,
      pipeline:pipelines(id,name),
      stage:pipeline_stages(id,name)
    `)
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle()

  if (error) throw error
  if (!data) throw new NotFoundError(`Deal ${id} não encontrado`)
  return toDealResource(data)
}

/**
 * Lista deals de um contato. Filtrado sempre por account_id.
 */
export async function listDealsByContact(
  ctx: ApiServiceCtx,
  q: DealContactQuery,
): Promise<DealResource[]> {
  const contactId = await resolveContact(ctx, q)

  const { data, error } = await ctx.admin
    .from('deals')
    .select(`
      id, title, value, currency, status, contact_id, expected_close_date, created_at, updated_at,
      pipeline:pipelines(id,name),
      stage:pipeline_stages(id,name)
    `)
    .eq('account_id', ctx.accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })

  if (error) throw error
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data ?? []).map((row: any) => toDealResource(row))
}

/**
 * Lista todos os pipelines da conta com suas etapas.
 */
export async function listPipelines(ctx: ApiServiceCtx): Promise<PipelineResource[]> {
  const { data, error } = await ctx.admin
    .from('pipelines')
    .select(`
      id, name,
      stages:pipeline_stages(id, name, position, color)
    `)
    .eq('account_id', ctx.accountId)
    .order('name')

  if (error) throw error
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data ?? []).map((row: any) => ({
    id: row.id,
    name: row.name,
    stages: (row.stages ?? []).map(
      (s: { id: string; name: string; position: number; color: string | null }) => ({
        id: s.id,
        name: s.name,
        position: s.position,
        color: s.color ?? null,
      }),
    ),
  }))
}

// ─── Escritas ─────────────────────────────────────────────────────────────────

/**
 * Cria um novo deal.
 *
 * Resolve TODOS os nomes (pipeline → stage → contato) ANTES de inserir
 * para garantir falha rápida (422/404) sem efeitos parciais.
 *
 * Fluxo:
 * 1. Resolve pipeline por nome (lança UnknownPipelineError se não existe)
 * 2. Resolve stage por nome dentro do pipeline (lança UnknownStageError)
 * 3. Resolve contato (lança NotFoundError)
 * 4. Busca currency da conta (fallback USD)
 * 5. Insere o deal com status 'open' explícito (ignora DEFAULT legado 'active')
 * 6. Retorna DealResource completo via getDealById
 */
export async function createDeal(
  ctx: ApiServiceCtx,
  body: DealCreateBody,
): Promise<DealResource> {
  const { admin, accountId, auditUserId } = ctx
  const { pipeline: pipelineName, stage: stageName, title, value, ...contactQuery } = body

  // ── Passo 1-4: resolver todos os nomes antes de qualquer escrita ────────────
  const pipeline = await resolvePipelineByName(ctx, pipelineName)
  const stage = await resolveStageByName(ctx, pipeline.id, stageName)
  const contactId = await resolveContact(ctx, contactQuery)
  const currency = await resolveAccountCurrency(ctx)

  // ── Passo 5: inserir deal ───────────────────────────────────────────────────
  const { data, error } = await admin
    .from('deals')
    .insert({
      account_id: accountId,
      user_id: auditUserId,
      pipeline_id: pipeline.id,
      stage_id: stage.id,
      contact_id: contactId,
      title,
      value: value ?? 0,
      currency,
      status: 'open', // sempre 'open' — o DEFAULT legado do DB é 'active', ignorar
    })
    .select('id')
    .single()

  if (error) throw error
  const insertedId = (data as { id: string }).id

  // ── Passo 6: retornar DealResource completo ─────────────────────────────────
  return getDealById(ctx, insertedId)
}

/**
 * Atualiza campos de um deal existente.
 * Lança NotFoundError se o deal não pertencer à conta.
 * Se patch.stage for informado, resolve a etapa dentro do pipeline DO DEAL (não externo).
 *
 * Allow-list explícita: stage_id, status, value, title + updated_at.
 */
export async function updateDeal(
  ctx: ApiServiceCtx,
  id: string,
  patch: DealPatchBody,
): Promise<DealResource> {
  const { admin, accountId } = ctx

  // ── Verificar existência e obter pipeline_id do deal ───────────────────────
  const { data: deal, error: findError } = await admin
    .from('deals')
    .select('id,pipeline_id')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle()

  if (findError) throw findError
  if (!deal) throw new NotFoundError(`Deal ${id} não encontrado`)

  const existingDeal = deal as { id: string; pipeline_id: string }

  // ── Resolver stage dentro do pipeline do deal (tenant-safe) ────────────────
  const updatePayload: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  }

  if (patch.stage !== undefined) {
    const stage = await resolveStageByName(ctx, existingDeal.pipeline_id, patch.stage)
    updatePayload.stage_id = stage.id
  }

  // Allow-list explícita — nunca spredar patch diretamente
  if (patch.status !== undefined) updatePayload.status = patch.status
  if (patch.value !== undefined) updatePayload.value = patch.value
  if (patch.title !== undefined) updatePayload.title = patch.title

  // ── Atualizar ───────────────────────────────────────────────────────────────
  const { error: updateError } = await admin
    .from('deals')
    .update(updatePayload)
    .eq('id', id)
    .eq('account_id', accountId)

  if (updateError) throw updateError

  return getDealById(ctx, id)
}

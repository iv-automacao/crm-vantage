// Leitura/validação da config CAPI por conta. O token nunca sai daqui pro
// cliente — a view expõe só `has_access_token`.
import type { SupabaseClient } from '@supabase/supabase-js'

export interface CapiSettingsView {
  dataset_id: string | null
  event_name: string
  is_active: boolean
  has_access_token: boolean
}

export interface CapiSettingsInput {
  dataset_id?: string | null
  access_token?: string | null
  event_name?: string
  is_active?: boolean
}

interface CurrentState {
  dataset_id: string | null
  has_token: boolean
  event_name: string
  is_active: boolean
}

/** Lê a config da conta e devolve a view segura (sem token). */
export async function getCapiSettingsView(
  supabase: SupabaseClient,
  accountId: string,
): Promise<CapiSettingsView> {
  const { data } = await supabase
    .from('capi_settings')
    .select('dataset_id, access_token, event_name, is_active')
    .eq('account_id', accountId)
    .maybeSingle()
  return {
    dataset_id: (data?.dataset_id as string | null) ?? null,
    event_name: (data?.event_name as string) ?? 'Purchase',
    is_active: Boolean(data?.is_active),
    has_access_token: Boolean(data?.access_token),
  }
}

/**
 * Valida o input e monta o patch pro upsert. `access_token` só entra no
 * patch quando enviado não-vazio (preserva o token salvo). Ativar exige
 * dataset_id e um token (novo ou já salvo).
 */
export function validateCapiInput(
  input: CapiSettingsInput,
  current: CurrentState,
): { ok: true; patch: Record<string, unknown> } | { ok: false; error: string } {
  const patch: Record<string, unknown> = {}

  const datasetId =
    input.dataset_id !== undefined ? (input.dataset_id?.trim() || null) : current.dataset_id
  if (input.dataset_id !== undefined) patch.dataset_id = datasetId

  const newToken = typeof input.access_token === 'string' ? input.access_token.trim() : ''
  if (newToken) patch.access_token = newToken
  const willHaveToken = Boolean(newToken) || current.has_token

  if (input.event_name !== undefined) {
    const name = input.event_name.trim()
    if (!name) return { ok: false, error: 'event_name não pode ser vazio' }
    patch.event_name = name
  }

  const isActive = input.is_active !== undefined ? input.is_active : current.is_active
  if (input.is_active !== undefined) patch.is_active = isActive

  if (isActive) {
    if (!datasetId) return { ok: false, error: 'Dataset ID é obrigatório para ativar o CAPI' }
    if (!willHaveToken) return { ok: false, error: 'Access Token é obrigatório para ativar o CAPI' }
  }

  return { ok: true, patch }
}

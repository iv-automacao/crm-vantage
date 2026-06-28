import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Enriquecimento de contexto pro webhook bidirecional.
//
// Lê tabelas EXISTENTES (sem migration) pra anexar ao payload o
// contexto de negócio que o agente n8n usa pra decidir: tags do
// contato, custom fields, origem CTWA (referral), estado da conversa
// (incl. NOME do agente atribuído) e o deal ativo (pipeline/stage).
//
// BEST-EFFORT por natureza: cada bloco roda em try/catch isolado; se
// uma query falhar, aquele bloco degrada pro vazio e o resto continua.
// NUNCA lança — não pode derrubar o envio nem o inbound webhook.
// Minimiza queries: 1 contato (tags/custom/referral/ctwa_clid aninhados),
// 1 conversa (só escalares — SEM embed de profiles, ver Bloco 2),
// 0-1 lookup de nome do agente (profiles por user_id) e 1-2 deal
// (conversa; fallback por contato quando o deal não tem conversa).
// ============================================================

/** Bloco enriquecido anexado ao payload do webhook. */
export interface ConversationContext {
  contact: {
    tags: string[]
    custom_fields: { name: string; value: string }[]
    referral: unknown | null
    /** Click-id de CTWA (coluna dedicada, migration 027). Usado pelo CAPI. */
    ctwa_clid: string | null
  }
  state: {
    bot_paused: boolean
    conversation_status: string
    assigned_agent_id: string | null
    assigned_agent_name: string | null
    unread_count: number | null
    last_message_at: string | null
    autoassign_waiting: boolean
    created_at: string | null
  }
  deal:
    | {
        id: string
        title: string
        value: number
        currency: string
        stage: string | null
        pipeline: string | null
        status: string
      }
    | null
}

/** Esqueleto seguro — retornado quando tudo falha. Cada bloco degrada pra cá. */
export function emptyConversationContext(): ConversationContext {
  return {
    contact: { tags: [], custom_fields: [], referral: null, ctwa_clid: null },
    state: {
      bot_paused: false,
      conversation_status: 'open',
      assigned_agent_id: null,
      assigned_agent_name: null,
      unread_count: null,
      last_message_at: null,
      autoassign_waiting: false,
      created_at: null,
    },
    deal: null,
  }
}

// ── Normalizadores de joins aninhados do PostgREST ───────────────────────────
// O PostgREST pode devolver a relação aninhada como objeto OU array (depende da
// cardinalidade inferida). Normalizamos os dois casos de forma defensiva.

function firstOrSelf<T>(rel: unknown): T | null {
  if (rel == null) return null
  if (Array.isArray(rel)) return (rel[0] as T) ?? null
  return rel as T
}

function extractTags(row: Record<string, unknown> | null): string[] {
  if (!row) return []
  const raw = row.contact_tags
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const link of raw as Record<string, unknown>[]) {
    const tag = firstOrSelf<{ name?: unknown }>(link.tags)
    if (tag && typeof tag.name === 'string') out.push(tag.name)
  }
  return out
}

function extractCustomFields(
  row: Record<string, unknown> | null,
): { name: string; value: string }[] {
  if (!row) return []
  const raw = row.contact_custom_values
  if (!Array.isArray(raw)) return []
  const out: { name: string; value: string }[] = []
  for (const cv of raw as Record<string, unknown>[]) {
    const field = firstOrSelf<{ field_name?: unknown }>(cv.custom_fields)
    if (field && typeof field.field_name === 'string') {
      out.push({ name: field.field_name, value: cv.value == null ? '' : String(cv.value) })
    }
  }
  return out
}

// ── Builder principal ────────────────────────────────────────────────────────

export async function buildConversationContext(
  admin: SupabaseClient,
  accountId: string,
  conversationId: string,
  contactId: string,
): Promise<ConversationContext> {
  const result = emptyConversationContext()

  // Bloco 1 — contato: tags + custom fields + referral + ctwa_clid, em 1 select
  // aninhado. `ctwa_clid` é coluna dedicada (migration 027), separada do
  // `referral` jsonb; o CAPI usa o click-id, então expomos ele explicitamente.
  try {
    const { data, error } = await admin
      .from('contacts')
      .select(
        'referral, ctwa_clid, contact_tags ( tags ( name ) ), contact_custom_values ( value, custom_fields ( field_name ) )',
      )
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!error && data) {
      const row = data as Record<string, unknown>
      result.contact = {
        tags: extractTags(row),
        custom_fields: extractCustomFields(row),
        referral: row.referral ?? null,
        ctwa_clid: typeof row.ctwa_clid === 'string' ? row.ctwa_clid : null,
      }
    } else if (error) {
      console.warn('[enrich] contato falhou:', error.message)
    }
  } catch (e) {
    console.warn('[enrich] contato lançou:', e instanceof Error ? e.message : e)
  }

  // Bloco 2 — conversa: SÓ colunas escalares. NÃO embutimos `profiles` aqui de
  // propósito: `conversations.assigned_agent_id` NÃO tem FK no schema (001:145,
  // `assigned_agent_id UUID` sem REFERENCES). Um embed `profiles!...fkey` faria
  // o PostgREST devolver PGRST200 pra REQUISIÇÃO INTEIRA → o `state` degradaria
  // pro esqueleto (perderia bot_paused/assigned_agent_id/status reais) = uma
  // REGRESSÃO silenciosa (o n8n veria bot_paused:false/status:'open' sempre e
  // responderia por cima de humano). O nome do agente vem do Bloco 2b (lookup
  // separado em `profiles` por user_id).
  try {
    const { data, error } = await admin
      .from('conversations')
      .select(
        'status, bot_paused, assigned_agent_id, unread_count, last_message_at, autoassign_waiting, created_at',
      )
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!error && data) {
      const row = data as Record<string, unknown>
      result.state = {
        bot_paused: row.bot_paused === true,
        conversation_status: typeof row.status === 'string' ? row.status : 'open',
        assigned_agent_id: (row.assigned_agent_id as string | null) ?? null,
        // nome resolvido no Bloco 2b (lookup separado).
        assigned_agent_name: null,
        unread_count: typeof row.unread_count === 'number' ? row.unread_count : null,
        last_message_at: (row.last_message_at as string | null) ?? null,
        autoassign_waiting: row.autoassign_waiting === true,
        created_at: (row.created_at as string | null) ?? null,
      }
    } else if (error) {
      console.warn('[enrich] conversa falhou:', error.message)
    }
  } catch (e) {
    console.warn('[enrich] conversa lançou:', e instanceof Error ? e.message : e)
  }

  // Bloco 2b — nome do agente: lookup direto em `profiles` por user_id
  // (`assigned_agent_id` é um user_id). É o ÚNICO caminho pro nome — não há
  // embed no Bloco 2. Best-effort: só roda quando há agente atribuído.
  // `profiles` tem UNIQUE(user_id) GLOBAL (001:22), então o filtro por
  // account_id é redundante e foi omitido (um user_id resolve 1 profile só).
  if (result.state.assigned_agent_id) {
    try {
      const { data, error } = await admin
        .from('profiles')
        .select('full_name')
        .eq('user_id', result.state.assigned_agent_id)
        .maybeSingle()
      if (!error && data && typeof (data as { full_name?: unknown }).full_name === 'string') {
        result.state.assigned_agent_name = (data as { full_name: string }).full_name
      } else if (!error && !data) {
        // Tem agente atribuído mas o profile não foi encontrado (sem erro de query).
        // Provavelmente user_id desincronizado ou profile deletado — diagnóstico.
        console.warn('[enrich] agente sem profile:', result.state.assigned_agent_id)
      }
    } catch (e) {
      console.warn('[enrich] nome do agente lançou:', e instanceof Error ? e.message : e)
    }
  }

  // Bloco 3 — deal ATIVO (1, o mais recente), com pipeline/stage. Primeiro tenta
  // o deal da CONVERSA (`conversation_id`); se não houver, faz fallback pro deal
  // do CONTATO (`deals.conversation_id` é nullable — deals criados na UI de
  // pipelines têm conversation_id null). Ordem determinística (created_at desc).
  const SELECT_DEAL =
    'id, title, value, currency, status, pipelines ( name ), pipeline_stages ( name )'
  // Mapeia a row crua do PostgREST pro shape do payload (joins normalizados).
  const mapDeal = (row: Record<string, unknown>): ConversationContext['deal'] => {
    const pipeline = firstOrSelf<{ name?: unknown }>(row.pipelines)
    const stage = firstOrSelf<{ name?: unknown }>(row.pipeline_stages)
    return {
      id: String(row.id),
      title: typeof row.title === 'string' ? row.title : '',
      value: typeof row.value === 'number' ? row.value : Number(row.value ?? 0),
      currency: typeof row.currency === 'string' ? row.currency : 'BRL',
      stage: stage && typeof stage.name === 'string' ? stage.name : null,
      pipeline: pipeline && typeof pipeline.name === 'string' ? pipeline.name : null,
      status: typeof row.status === 'string' ? row.status : 'active',
    }
  }
  try {
    // 1ª tentativa: deal ativo VINCULADO à conversa.
    const { data: byConv, error: errConv } = await admin
      .from('deals')
      .select(SELECT_DEAL)
      .eq('account_id', accountId)
      .eq('conversation_id', conversationId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!errConv && byConv) {
      result.deal = mapDeal(byConv as Record<string, unknown>)
    } else {
      if (errConv) console.warn('[enrich] deal (conversa) falhou:', errConv.message)
      // Fallback: deal ativo do CONTATO (sem vínculo de conversa).
      const { data: byContact, error: errContact } = await admin
        .from('deals')
        .select(SELECT_DEAL)
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (!errContact && byContact) {
        result.deal = mapDeal(byContact as Record<string, unknown>)
      } else if (errContact) {
        console.warn('[enrich] deal (contato) falhou:', errContact.message)
      }
    }
  } catch (e) {
    console.warn('[enrich] deal lançou:', e instanceof Error ? e.message : e)
  }

  return result
}

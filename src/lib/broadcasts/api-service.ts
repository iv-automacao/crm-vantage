/**
 * Camada de serviço para broadcasts via API externa.
 * Todas as operações são account-scoped — nunca acessa dados de outra conta.
 *
 * Reusa o núcleo de fan-out da rota interna src/app/api/whatsapp/broadcast/route.ts
 * mas aplica os erros tipados da camada de API e scope de segurança.
 */

import type { ApiServiceCtx } from '@/lib/api/service-context'
import { TemplateNotApprovedError, WhatsappNotConfiguredError, ApiError } from '@/lib/api/errors'
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sanitizePhoneForMeta, isValidE164, phoneVariants, isRecipientNotAllowedError } from '@/lib/whatsapp/phone-utils'
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard'
import type { BroadcastSendBody } from '@/lib/api/schemas/broadcasts'

// Regex para contar variáveis {{N}} no body_text do template
const VAR_RE = /\{\{\s*\d+\s*\}\}/g

// ─── Tipos públicos ──────────────────────────────────────────────────────────

export interface TemplateResource {
  name: string
  language: string
  category: string | null
  status: string
  body_text: string | null
  variables_count: number
}

export interface BroadcastRecipientResult {
  phone: string
  status: 'sent' | 'failed'
  whatsapp_message_id?: string
  error?: string
}

export interface BroadcastSendResult {
  sent: number
  failed: number
  results: BroadcastRecipientResult[]
}

// ─── Listagem de templates aprovados ─────────────────────────────────────────

/**
 * Lista todos os templates com status APPROVED da conta.
 * Filtra por account_id para garantir isolamento entre contas.
 */
export async function listApprovedTemplates(ctx: ApiServiceCtx): Promise<TemplateResource[]> {
  const { data, error } = await ctx.admin
    .from('message_templates')
    .select('name,language,category,status,body_text')
    .eq('account_id', ctx.accountId)
    .eq('status', 'APPROVED')
    .order('name')

  if (error) throw error

  return (data ?? []).map((t: any) => ({
    name: t.name,
    language: t.language,
    category: t.category ?? null,
    status: t.status,
    body_text: t.body_text ?? null,
    // Conta todas as ocorrências de {{N}} no body_text
    variables_count: (String(t.body_text ?? '').match(VAR_RE) ?? []).length,
  }))
}

// ─── Envio de broadcast ───────────────────────────────────────────────────────

/**
 * Envia um broadcast para múltiplos destinatários usando um template aprovado.
 *
 * Fluxo:
 * 1. Busca config do WhatsApp da conta — lança WhatsappNotConfiguredError (409) se ausente
 * 2. Valida que o template existe e está APPROVED — lança TemplateNotApprovedError (422) se não
 * 3. Fan-out: itera sobre destinatários com retry de variante de telefone
 *    - Erros por destinatário viram {status:'failed', error} — nunca derrubam o loop
 *    - Retry de variante só ocorre em isRecipientNotAllowedError
 *
 * Nunca expõe o access token em logs ou mensagens de erro.
 */
export async function sendBroadcast(ctx: ApiServiceCtx, body: BroadcastSendBody): Promise<BroadcastSendResult> {
  // 1) Busca config da conta (apenas os campos necessários — evita trazer credenciais desnecessárias)
  const { data: config, error: configError } = await ctx.admin
    .from('whatsapp_config')
    .select('phone_number_id,access_token')
    .eq('account_id', ctx.accountId)
    .maybeSingle()

  // Propaga erro real do banco antes de verificar ausência de dados
  if (configError) throw configError
  if (!config) throw new WhatsappNotConfiguredError()

  // Descriptografa o token — nunca logar este valor
  const accessToken = decrypt(config.access_token as string)

  // 2) Valida que o template existe e está APPROVED
  const { data: rawTemplate, error: templateError } = await ctx.admin
    .from('message_templates')
    .select('*')
    .eq('account_id', ctx.accountId)
    .eq('name', body.template_name)
    .eq('language', body.template_language)
    .maybeSingle()

  // Propaga erro real do banco antes de verificar ausência ou status inválido
  if (templateError) throw templateError
  if (!rawTemplate || rawTemplate.status !== 'APPROVED') {
    throw new TemplateNotApprovedError(body.template_name)
  }

  // Valida estrutura mínima da linha do template antes do fan-out
  if (!isMessageTemplate(rawTemplate)) {
    console.error('[sendBroadcast] template local malformado:', body.template_name)
    throw new ApiError(500, 'internal_error', 'Erro interno ao carregar o template.')
  }

  // 3) Fan-out: itera sobre destinatários com retry de variante de telefone
  const results: BroadcastRecipientResult[] = []
  let sent = 0
  let failed = 0

  for (const r of body.recipients) {
    const sanitized = sanitizePhoneForMeta(r.phone)

    // Valida formato E.164 antes de tentar o envio
    if (!isValidE164(sanitized)) {
      results.push({ phone: r.phone, status: 'failed', error: 'Telefone em formato inválido' })
      failed++
      continue
    }

    let messageId: string | null = null
    let lastError: string | null = null

    // Tenta cada variante de telefone — útil para sandbox com trunk prefix
    for (const variant of phoneVariants(sanitized)) {
      try {
        const res = await sendTemplateMessage({
          phoneNumberId: config.phone_number_id as string,
          accessToken,
          to: variant,
          templateName: body.template_name,
          language: body.template_language,
          template: rawTemplate,
          params: r.params ?? [],
        })
        messageId = res.messageId
        lastError = null
        break
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Erro desconhecido'
        lastError = msg
        // Só faz retry com próxima variante em erro de "not allowed" (sandbox)
        if (!isRecipientNotAllowedError(msg)) break
      }
    }

    if (messageId) {
      results.push({ phone: r.phone, status: 'sent', whatsapp_message_id: messageId })
      sent++
    } else {
      results.push({ phone: r.phone, status: 'failed', error: lastError ?? 'Falha no envio' })
      failed++
    }
  }

  return { sent, failed, results }
}

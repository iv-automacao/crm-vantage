import { NextResponse } from 'next/server'
import type { z } from 'zod'

/** Erro de API com status/código/detalhes — tratado pelo funil toErrorResponse. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: { field: string; message: string }[],
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export class UnknownTagError extends ApiError {
  constructor(name: string) {
    super(422, 'unknown_tag', `A tag '${name}' não existe nesta conta. Crie no CRM primeiro.`, [
      { field: 'tags', message: `tag '${name}' não existe` },
    ])
  }
}

export class UnknownFieldError extends ApiError {
  constructor(name: string) {
    super(422, 'unknown_field', `O campo '${name}' não existe nesta conta. Crie no CRM primeiro.`, [
      { field: 'custom_fields', message: `campo '${name}' não existe` },
    ])
  }
}

export class NotFoundError extends ApiError {
  constructor(message = 'Recurso não encontrado') {
    super(404, 'not_found', message)
  }
}

export class ApiBadRequestError extends ApiError {
  constructor(message: string) {
    super(400, 'bad_request', message)
  }
}

export class UnknownPipelineError extends ApiError {
  constructor(name: string) {
    super(422, 'unknown_pipeline', `O pipeline '${name}' não existe nesta conta. Crie no CRM primeiro.`, [
      { field: 'pipeline', message: `pipeline '${name}' não existe` },
    ])
  }
}

export class UnknownStageError extends ApiError {
  constructor(name: string) {
    super(422, 'unknown_stage', `A etapa '${name}' não existe neste pipeline.`, [
      { field: 'stage', message: `etapa '${name}' não existe` },
    ])
  }
}

export class TemplateNotApprovedError extends ApiError {
  constructor(name: string) {
    super(422, 'template_not_approved', `O template '${name}' não existe ou não está aprovado nesta conta.`, [
      { field: 'template_name', message: `template '${name}' não aprovado` },
    ])
  }
}

export class WhatsappNotConfiguredError extends ApiError {
  constructor() {
    super(409, 'whatsapp_not_configured', 'WhatsApp não está configurado nesta conta. Configure a integração antes de disparar.')
  }
}

// Envelope padrão de erro da API — usado por todos os handlers.
export function errorEnvelope(
  code: string,
  message: string,
  status: number,
  details?: Array<{ field: string; message: string }>,
) {
  return NextResponse.json(
    { error: message, code, ...(details && { details }) },
    { status },
  )
}

// 422 estilo FastAPI a partir de um ZodError.
export function validationError(err: z.ZodError) {
  const details = err.issues.map((i) => ({
    field: i.path.join('.') || '(root)',
    message: i.message,
  }))
  return errorEnvelope('validation_error', 'Falha na validação dos dados enviados', 422, details)
}

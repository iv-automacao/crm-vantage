import { NextResponse } from 'next/server'
import type { z } from 'zod'

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

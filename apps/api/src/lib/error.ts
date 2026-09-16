import type { Context } from "hono"

/** Forma única de error de la API; coincide con ApiErrorShape de ui-patterns. */
export interface ApiErrorBody {
  error: {
    code: string
    message: string
    request_id?: string
  }
}

export function errorBody(c: Context, code: string, message: string): ApiErrorBody {
  const requestId = c.get("requestId") as string | undefined
  return { error: { code, message, ...(requestId ? { request_id: requestId } : {}) } }
}

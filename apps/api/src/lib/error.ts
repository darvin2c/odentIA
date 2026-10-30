import type { Context } from "hono"

/** Forma única de error de la API; coincide con ApiErrorShape de ui-patterns. */
export interface ApiErrorBody {
  error: {
    code: string
    message: string
    request_id?: string
    /**
     * El dato que hay que corregir: su nombre en el cuerpo de la petición
     * (`items[0].price`) → lo que se dice junto a él. La pantalla lo pinta en
     * ese campo; `message` sigue diciendo el primero para quien no los lea.
     */
    fields?: Record<string, string>
  }
}

export function errorBody(
  c: Context,
  code: string,
  message: string,
  fields?: Record<string, string>,
): ApiErrorBody {
  const requestId = c.get("requestId") as string | undefined
  return {
    error: {
      code,
      message,
      ...(requestId ? { request_id: requestId } : {}),
      ...(fields && Object.keys(fields).length > 0 ? { fields } : {}),
    },
  }
}

import type { ApiErrorShape } from "../error-state.js"

/**
 * Lo que una pantalla dice de un envío que falló: lo que es de un campo, junto
 * a ese campo (`fields`, con el nombre del dato en el cuerpo de la petición), y
 * lo que no es de ninguno, junto a los botones (`form`).
 */
export interface SubmitError {
  form: string | null
  fields: Record<string, string>
}

/** El error de la API de cualquier app (`ApiError` de clinic-app, admin, panel). */
interface ApiErrorLike {
  status: number
  shape: ApiErrorShape
}

function isApiErrorLike(error: unknown): error is ApiErrorLike {
  if (typeof error !== "object" || error === null) return false
  const candidate = error as Partial<ApiErrorLike>
  return typeof candidate.status === "number" && typeof candidate.shape === "object" && candidate.shape !== null
}

/** Lo que se dice cuando el servidor no dio un motivo propio. */
export const SUBMIT_ERROR_WORDS = {
  unconfirmed:
    "No pudimos confirmar el resultado. Conservamos los campos; consulta el estado actual antes de volver a guardar para evitar duplicados.",
  session: "Tu sesión venció. Conserva los datos e inicia sesión antes de continuar.",
  forbidden: "No tienes permiso para guardar estos cambios. Solicita acceso a la administración; los campos se conservan.",
  notFound: "El registro ya no está disponible. Consulta la lista actual antes de continuar; los campos se conservan.",
  conflict: "Los datos entran en conflicto con el estado actual. Consulta el registro y revisa los campos antes de guardar.",
  rateLimited: "Hay demasiadas solicitudes. Espera un momento antes de volver a guardar; los campos se conservan.",
  invalid: "No se guardaron los cambios. Revisa los datos marcados.",
} as const

/**
 * Sin respuesta (la red) o con 5xx/408: no se sabe si el servidor llegó a
 * aplicar la operación. Volver a enviar puede duplicarla; quien guarda lo
 * consulta antes.
 */
export function isUnconfirmedSubmit(error: unknown): boolean {
  if (error instanceof TypeError) return true
  return isApiErrorLike(error) && (error.status >= 500 || error.status === 408)
}

/**
 * Los estados con los que la API de odentIA da un motivo para la persona
 * (`ServiceError`, validación): su mensaje y sus `fields` se dicen. Otro
 * estado (un 422 de un proxy, por ejemplo) no viene de ella y su cuerpo puede
 * traer detalles internos: se dice lo de siempre.
 */
const REASONED_STATUS = new Set([400, 403, 404, 409, 413, 429])

/**
 * Lee el error de un envío: los campos que el servidor señaló y, para lo
 * demás, su mensaje (ya en español) o el de su estado. Un error propio del
 * navegador que no es de red dice su mensaje.
 */
export function submitErrorOf(error: unknown): SubmitError {
  if (isUnconfirmedSubmit(error)) return { form: SUBMIT_ERROR_WORDS.unconfirmed, fields: {} }
  if (!isApiErrorLike(error)) {
    const message = error instanceof Error ? error.message.trim() : ""
    return { form: message || SUBMIT_ERROR_WORDS.invalid, fields: {} }
  }
  if (error.status === 401) return { form: SUBMIT_ERROR_WORDS.session, fields: {} }
  if (!REASONED_STATUS.has(error.status)) return { form: SUBMIT_ERROR_WORDS.invalid, fields: {} }
  const fields = error.shape.fields ?? {}
  const message = error.shape.message?.trim() || null
  if (Object.keys(fields).length > 0) {
    // El mensaje general suele repetir el del primer campo; si dice otra cosa
    // («No se subió ninguno…»), también se dice, junto a los botones.
    const repeated = message === null || Object.values(fields).includes(message)
    return { form: repeated ? null : message, fields }
  }
  switch (error.status) {
    case 403:
      return { form: message ?? SUBMIT_ERROR_WORDS.forbidden, fields }
    case 404:
      return { form: message ?? SUBMIT_ERROR_WORDS.notFound, fields }
    case 409:
      return { form: message ?? SUBMIT_ERROR_WORDS.conflict, fields }
    case 429:
      return { form: message ?? SUBMIT_ERROR_WORDS.rateLimited, fields }
    default:
      return { form: message ?? SUBMIT_ERROR_WORDS.invalid, fields }
  }
}

/** Una sola frase para lo que no tiene campo donde decirse (un aviso, un toast). */
export function submitErrorMessage(error: unknown): string {
  const { form, fields } = submitErrorOf(error)
  return form ?? Object.values(fields)[0] ?? SUBMIT_ERROR_WORDS.invalid
}

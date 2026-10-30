/**
 * Mensajes de error de finanzas en lenguaje llano. El cliente vigente vive en
 * `finance-collect.ts`; aquí solo se decide qué texto ve la persona cuando el
 * servidor rechaza algo o la respuesta no llega.
 *
 * Manda el mensaje del servidor (ya es de negocio y está en español). Solo se
 * sustituye cuando es técnico (claves de reintento, textos del validador) o
 * cuando no hay mensaje.
 *
 * Dos usos: `financeErrorMessage` para lo que no es un formulario (una consulta
 * que no cargó, una acción suelta) y `financeFormMessage`/`collectFormMessage`
 * como `formMessage` de `useFormSurface`: solo cambian las palabras de lo que
 * no es de ningún campo; lo que el servidor señala por campo va a su campo.
 */
import { ApiError } from "./api"

/** Códigos cuyo mensaje del servidor es técnico: se explican con palabras de caja. */
const PLAIN_BY_CODE: Record<string, string> = {
  CHARGE_HAS_APPLICATIONS:
    "Este concepto ya tiene pagos: no se puede cambiar ni quitar. Para corregirlo, primero anula el cobro.",
  REQUEST_ID_CONFLICT:
    "Este cobro ya quedó registrado con otros datos. Cierra el panel y revisa la cuenta antes de cobrar otra vez.",
}

/** Textos del validador de entrada (en inglés): no dicen nada a quien cobra. */
const VALIDATOR_TEXT = /^(invalid|too (small|big)|unrecognized|expected|required)\b/i

function isNetworkFailure(err: unknown): boolean {
  return err instanceof TypeError
}

/** Sin respuesta o error del servidor: no se sabe si la operación llegó a aplicarse. */
export function isUnconfirmedError(err: unknown): boolean {
  if (isNetworkFailure(err)) return true
  return err instanceof ApiError && (err.status >= 500 || err.status === 408)
}

/** Mensaje de error en español para mutaciones de caja y finanzas. */
export function financeErrorMessage(err: unknown): string {
  if (isNetworkFailure(err)) {
    return "No hay conexión con el servidor. Revisa tu conexión e inténtalo de nuevo."
  }
  if (err instanceof ApiError) {
    const { code, message } = err.shape
    if (code && PLAIN_BY_CODE[code]) return PLAIN_BY_CODE[code]
    if (err.status === 401) return "Tu sesión venció. Vuelve a iniciar sesión para continuar."
    if (message && !VALIDATOR_TEXT.test(message)) return message
    if (code === "VALIDATION") return "Hay un dato que no es válido. Revísalo e inténtalo de nuevo."
    if (err.status === 403) return "Tu rol no tiene permiso para hacer esto. Pídeselo a quien administra la clínica."
    if (err.status >= 500) return "El servidor no pudo completar la operación. Inténtalo de nuevo."
    if (code) return `No se pudo guardar (${code}). Inténtalo de nuevo.`
    return "No se pudo guardar. Inténtalo de nuevo."
  }
  return err instanceof Error && err.message ? err.message : "No se pudo guardar. Inténtalo de nuevo."
}

/**
 * `formMessage` de un formulario de finanzas: las palabras de caja para los
 * códigos técnicos; `null` deja el mensaje del servidor (o el de su estado).
 */
export function financeFormMessage(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null
  const code = err.shape.code
  return code ? (PLAIN_BY_CODE[code] ?? null) : null
}

/**
 * `formMessage` del cobro. El cobro lleva una clave propia: si la respuesta no
 * llegó, volver a pulsar «Cobrar» sin cambiar nada devuelve el mismo ticket.
 */
export function collectFormMessage(err: unknown): string | null {
  if (isUnconfirmedError(err)) {
    return "No pudimos confirmar si el cobro quedó registrado. Pulsa «Cobrar» otra vez sin cambiar nada: si ya se registró, no se cobra dos veces."
  }
  return financeFormMessage(err)
}

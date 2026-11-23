import { isSigningSecret, SIGNATURE_TOLERANCE_SECONDS, signMessage, verifySignedMessage } from "@odentia/contract/signing"
import { ACCOUNT_EVENT_TYPES } from "@odentia/db/schema/auth"

/**
 * Los avisos de la cuenta a las apps que son otro sistema (ADR 0201), firmados según
 * Standard Webhooks (https://www.standardwebhooks.com, v1): cabeceras `webhook-id`,
 * `webhook-timestamp` (segundos) y `webhook-signature` (`v1,<base64 de HMAC-SHA256>` sobre
 * `id.timestamp.cuerpo`), con un secreto por app de la forma `whsec_<base64>`.
 *
 * El `webhook-id` es el del aviso y no cambia al reintentar: la app lo usa para reconocer
 * un repetido, así que mandarlo otra vez nunca duplica su efecto.
 */
export { ACCOUNT_EVENT_TYPES }
export type AccountEventType = (typeof ACCOUNT_EVENT_TYPES)[number]

/**
 * Lo que llega en cada aviso. `cuenta.cerrada`: la cuenta ya no entra a ninguna app.
 * `cuenta.bloqueada`: no entra hasta `expiresAt` (ISO 8601; nulo, hasta que se reabra; si ya
 * pasó, el bloqueo no frena, igual que en las clínicas).
 * `cuenta.reabierta`: se quitó el bloqueo, también el de un cierre, y vuelve a entrar.
 * Los de una misma cuenta llegan en el orden en que pasaron: el último manda.
 */
export interface AccountEventPayload {
  type: AccountEventType
  /** Cuándo pasó, ISO 8601. */
  timestamp: string
  data: { userId: string; expiresAt?: string | null }
}

/** Cuánto puede diferir la hora de un aviso de la del que lo recibe (lo que sugiere el estándar). */
export const ACCOUNT_EVENT_TOLERANCE_SECONDS = SIGNATURE_TOLERANCE_SECONDS

/**
 * La firma es la del acuerdo (`@odentia/contract/signing`): una sola para los avisos de la
 * cuenta, la revisión de su copia y lo que una app le dice a la administración (ADR 0211).
 * Aquí conservan los nombres con que la cuenta los usa.
 */
export const isAccountEventSecret = isSigningSecret
export const signAccountEvent = signMessage
export { verifySignedMessage }

/**
 * Lo que hace la app que recibe: el aviso es de la cuenta si la firma coincide y su hora
 * está dentro de la tolerancia (un aviso viejo repetido no vale). Devuelve el aviso leído,
 * o null si no es de la cuenta.
 */
export function verifyAccountEvent(input: {
  secret: string
  headers: Headers
  body: string
  now?: Date
}): (AccountEventPayload & { id: string }) | null {
  const id = verifySignedMessage(input)
  if (!id) return null
  try {
    const payload = JSON.parse(input.body) as AccountEventPayload
    if (!(ACCOUNT_EVENT_TYPES as readonly string[]).includes(payload.type)) return null
    if (typeof payload.data?.userId !== "string") return null
    return { ...payload, id }
  } catch {
    return null
  }
}

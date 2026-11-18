import { createHmac, timingSafeEqual } from "node:crypto"
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
export const ACCOUNT_EVENT_TOLERANCE_SECONDS = 5 * 60

const SECRET_PREFIX = "whsec_"

function secretBytes(secret: string): Buffer {
  const raw = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : ""
  const bytes = Buffer.from(raw, "base64")
  // 24 bytes como mínimo (192 bits), lo que pide el estándar.
  if (bytes.length < 24)
    throw new Error("El secreto de los avisos es whsec_ y al menos 24 bytes en base64")
  return bytes
}

export function isAccountEventSecret(secret: string): boolean {
  try {
    secretBytes(secret)
    return true
  } catch {
    return false
  }
}

function signature(secret: string, id: string, timestamp: number, body: string): string {
  return createHmac("sha256", secretBytes(secret))
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64")
}

/** Las cabeceras de un aviso firmado. */
export function signAccountEvent(input: {
  secret: string
  id: string
  body: string
  /** Segundos desde 1970; por omisión, ahora. */
  timestamp?: number
}): Record<"webhook-id" | "webhook-timestamp" | "webhook-signature", string> {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000)
  return {
    "webhook-id": input.id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": `v1,${signature(input.secret, input.id, timestamp, input.body)}`,
  }
}

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
  const id = input.headers.get("webhook-id") ?? ""
  const timestamp = Number(input.headers.get("webhook-timestamp") ?? "")
  const sent = input.headers.get("webhook-signature") ?? ""
  if (!id || !Number.isInteger(timestamp)) return null
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000)
  if (Math.abs(nowSeconds - timestamp) > ACCOUNT_EVENT_TOLERANCE_SECONDS) return null
  const expected = Buffer.from(signature(input.secret, id, timestamp, input.body))
  // Varias firmas separadas por espacio (rotar el secreto): basta una.
  const matches = sent.split(" ").some((one) => {
    const [version, value] = one.split(",", 2)
    if (version !== "v1" || !value) return false
    const got = Buffer.from(value)
    return got.length === expected.length && timingSafeEqual(got, expected)
  })
  if (!matches) return null
  try {
    const payload = JSON.parse(input.body) as AccountEventPayload
    if (!(ACCOUNT_EVENT_TYPES as readonly string[]).includes(payload.type)) return null
    if (typeof payload.data?.userId !== "string") return null
    return { ...payload, id }
  } catch {
    return null
  }
}

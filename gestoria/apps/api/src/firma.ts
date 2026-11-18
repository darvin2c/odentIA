import { createHmac, timingSafeEqual } from "node:crypto"

/**
 * Standard Webhooks v1 (https://www.standardwebhooks.com): lo que la cuenta firma y lo que
 * gestorIA comprueba, y lo que gestorIA firma al preguntarle a la cuenta en la revisión diaria.
 * Es un estándar: gestorIA no importa el código de la cuenta (vive con las clínicas), lo sigue.
 * Cabeceras `webhook-id`, `webhook-timestamp` (segundos) y `webhook-signature`
 * (`v1,<base64 de HMAC-SHA256>` sobre `id.timestamp.cuerpo`); secreto `whsec_<base64>`.
 */

/** Cuánto puede diferir la hora de un mensaje de la de quien lo recibe (lo que sugiere el estándar). */
export const TOLERANCE_SECONDS = 5 * 60

const PREFIX = "whsec_"

function secretBytes(secret: string): Buffer {
  const raw = secret.startsWith(PREFIX) ? secret.slice(PREFIX.length) : ""
  const bytes = Buffer.from(raw, "base64")
  if (bytes.length < 24)
    throw new Error("El secreto de los avisos es whsec_ y al menos 24 bytes en base64")
  return bytes
}

export function isSigningSecret(secret: string): boolean {
  try {
    secretBytes(secret)
    return true
  } catch {
    return false
  }
}

function hmac(secret: string, id: string, timestamp: number, body: string): string {
  return createHmac("sha256", secretBytes(secret))
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64")
}

export function signMessage(input: {
  secret: string
  id: string
  body: string
  timestamp?: number
}): Record<"webhook-id" | "webhook-timestamp" | "webhook-signature", string> {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000)
  return {
    "webhook-id": input.id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": `v1,${hmac(input.secret, input.id, timestamp, input.body)}`,
  }
}

/** El id del mensaje si la firma coincide y su hora está dentro de la tolerancia; si no, null. */
export function verifyMessage(input: {
  secret: string
  headers: Headers
  body: string
  now?: Date
}): string | null {
  const id = input.headers.get("webhook-id") ?? ""
  const timestamp = Number(input.headers.get("webhook-timestamp") ?? "")
  const sent = input.headers.get("webhook-signature") ?? ""
  if (!id || id.length > 200 || !Number.isInteger(timestamp)) return null
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000)
  if (Math.abs(nowSeconds - timestamp) > TOLERANCE_SECONDS) return null
  const expected = Buffer.from(hmac(input.secret, id, timestamp, input.body))
  // Varias firmas separadas por espacio (al rotar el secreto): basta una.
  const matches = sent.split(" ").some((one) => {
    const [version, value] = one.split(",", 2)
    if (version !== "v1" || !value) return false
    const got = Buffer.from(value)
    return got.length === expected.length && timingSafeEqual(got, expected)
  })
  return matches ? id : null
}

import { createHmac, timingSafeEqual } from "node:crypto"

/**
 * La firma de todo lo que se dicen la cuenta, la administración y una app que es otro sistema
 * (ADR 0201 y 0211), según Standard Webhooks (https://www.standardwebhooks.com, v1): cabeceras
 * `webhook-id`, `webhook-timestamp` (segundos) y `webhook-signature` (`v1,<base64 de
 * HMAC-SHA256>` sobre `id.timestamp.cuerpo`), con un secreto por par de la forma `whsec_<base64>`.
 *
 * El `webhook-id` es la clave del mensaje y no cambia al reintentar: quien recibe lo usa para
 * reconocer un repetido, así que mandarlo otra vez nunca duplica su efecto.
 */

/** Cuánto puede diferir la hora de un mensaje de la del que lo recibe (lo que sugiere el estándar). */
export const SIGNATURE_TOLERANCE_SECONDS = 5 * 60

const SECRET_PREFIX = "whsec_"

function secretBytes(secret: string): Buffer {
  const raw = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : ""
  const bytes = Buffer.from(raw, "base64")
  // 24 bytes como mínimo (192 bits), lo que pide el estándar.
  if (bytes.length < 24)
    throw new Error("El secreto de los avisos es whsec_ y al menos 24 bytes en base64")
  return bytes
}

/** ¿Es un secreto válido (`whsec_` y al menos 24 bytes en base64)? */
export function isSigningSecret(secret: string): boolean {
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

/** Las cabeceras de un mensaje firmado. */
export function signMessage(input: {
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
 * La firma de un mensaje: su id si la firma coincide y su hora está dentro de la tolerancia (uno
 * viejo repetido no vale); null si no. Sirve en los dos sentidos, con el mismo secreto.
 */
export function verifySignedMessage(input: {
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
  if (Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return null
  const expected = Buffer.from(signature(input.secret, id, timestamp, input.body))
  // Varias firmas separadas por espacio (rotar el secreto): basta una.
  const matches = sent.split(" ").some((one) => {
    const [version, value] = one.split(",", 2)
    if (version !== "v1" || !value) return false
    const got = Buffer.from(value)
    return got.length === expected.length && timingSafeEqual(got, expected)
  })
  return matches ? id : null
}

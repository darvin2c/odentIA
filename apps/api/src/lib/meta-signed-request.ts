import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

/**
 * El `signed_request` con que Meta llama a las direcciones de «permiso quitado»
 * y de «borrado de datos»: `<firma>.<datos>`, ambos en base64url, firmado con
 * HMAC-SHA256 y la clave secreta de la app (la de Facebook o la de Instagram).
 * https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback
 * Devuelve los datos si alguna de las claves lo firmó; si no, nulo.
 */
export function parseMetaSignedRequest(signedRequest: string, secrets: string[]): { user_id?: string; algorithm?: string } | null {
  const dot = signedRequest.indexOf(".")
  if (dot <= 0) return null
  const signature = Buffer.from(signedRequest.slice(0, dot), "base64url")
  const payload = signedRequest.slice(dot + 1)
  let data: { user_id?: unknown; algorithm?: unknown }
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as typeof data
  } catch {
    return null
  }
  if (typeof data.algorithm === "string" && data.algorithm.toUpperCase() !== "HMAC-SHA256") return null
  const signed = secrets.some((secret) => {
    if (!secret) return false
    const expected = createHmac("sha256", secret).update(payload).digest()
    return expected.length === signature.length && timingSafeEqual(expected, signature)
  })
  if (!signed) return null
  return {
    ...(typeof data.user_id === "string" || typeof data.user_id === "number" ? { user_id: String(data.user_id) } : {}),
    ...(typeof data.algorithm === "string" ? { algorithm: data.algorithm } : {}),
  }
}

/** Un código para que la persona pueda preguntar por su pedido de borrado. */
export function deletionConfirmationCode(): string {
  return randomBytes(6).toString("hex").toUpperCase()
}

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

/**
 * Las credenciales que pone una tienda (las de su link de pago) se guardan cifradas con
 * AES-256-GCM y la llave `GESTORIA_SECRETS_KEY`, que no está en la base: un respaldo o una
 * lectura de la base sola no las revela. Cada secreto va atado a su tienda (`context`): copiado
 * a otra tienda no abre. Nunca vuelven al navegador.
 */

const PREFIX = "v1"

/** La llave de 32 bytes en base64; null si no está (sin ella no se conecta un link de pago). */
export function readSecretsKey(text: string | undefined): Buffer | null {
  if (!text) return null
  const key = Buffer.from(text, "base64")
  if (key.length !== 32) throw new Error("GESTORIA_SECRETS_KEY debe ser 32 bytes en base64")
  return key
}

export function sealSecret(key: Buffer, context: string, plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(Buffer.from(context, "utf8"))
  const sealed = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  return [PREFIX, ...[iv, cipher.getAuthTag(), sealed].map((part) => part.toString("base64"))].join(
    ":",
  )
}

export function openSecret(key: Buffer, context: string, sealed: string): string {
  const [prefix, iv, tag, data] = sealed.split(":")
  if (prefix !== PREFIX || !iv || !tag || !data) throw new Error("secreto con formato desconocido")
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"))
  decipher.setAAD(Buffer.from(context, "utf8"))
  decipher.setAuthTag(Buffer.from(tag, "base64"))
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString(
    "utf8",
  )
}

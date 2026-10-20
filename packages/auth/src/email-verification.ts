import { createEmailVerificationToken } from "better-auth/api"

/**
 * Lo que dura el enlace de «Completa tu cuenta» (recordatorio a los 3 días de
 * registrarse sin verificar). El del registro dura lo que Better Auth trae por
 * defecto, 1 hora, así que a los 3 días ya no sirve: el recordatorio lleva uno
 * nuevo que alcanza para leer el correo con calma. Solo verifica una vez: con
 * la cuenta ya verificada, Better Auth lleva al destino sin abrir sesión.
 */
export const REMINDER_VERIFICATION_TTL_SECONDS = 7 * 24 * 60 * 60

/**
 * Enlace para verificar un correo fuera de una petición a Better Auth (el
 * worker). Es el mismo que arma Better Auth al registrarse: su token firmado
 * con el secreto de la API y su ruta `/verify-email`, que lo canjea, verifica
 * la cuenta, abre la sesión y lleva a `callbackURL`. Un enlace nuevo no anula
 * los anteriores: cada uno sirve hasta que vence.
 */
export async function emailVerificationUrl(input: {
  secret: string
  /** `BETTER_AUTH_URL`: el origen de la API, sin la ruta de Better Auth. */
  authUrl: string
  email: string
  callbackURL: string
  expiresInSeconds: number
}): Promise<string> {
  const token = await createEmailVerificationToken(input.secret, input.email, undefined, input.expiresInSeconds)
  const base = `${input.authUrl.replace(/\/+$/, "")}/api/auth`
  return `${base}/verify-email?token=${token}&callbackURL=${encodeURIComponent(input.callbackURL)}`
}

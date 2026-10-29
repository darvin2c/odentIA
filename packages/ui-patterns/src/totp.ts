/**
 * Lo que una pantalla de verificación en dos pasos muestra del enlace
 * `otpauth://` que entrega Better Auth al activarla (RFC 6238, el formato «Key
 * Uri» que leen todas las apps de autenticación): la administración y Mi perfil
 * del panel (ADR 0106). El enlace nunca se muestra como texto.
 */

/** Extrae el secreto para escribirlo a mano. */
export function totpSecret(uri: string): string {
  const match = /[?&]secret=([^&]+)/i.exec(uri)
  return match?.[1] ? decodeURIComponent(match[1]).toUpperCase() : ""
}

/** El secreto en grupos de 4, como lo piden las apps al escribirlo. */
export function groupedSecret(secret: string): string {
  return (
    secret
      .replace(/\s+/g, "")
      .match(/.{1,4}/g)
      ?.join(" ") ?? ""
  )
}

/** Solo los dígitos de lo escrito o pegado, hasta 6. */
export function totpDigits(value: string): string {
  return value.replace(/\D/g, "").slice(0, 6)
}

/** Las tiendas de Google Authenticator, la app que se recomienda (cualquiera sirve). */
export const AUTHENTICATOR_STORES = {
  iphone: "https://apps.apple.com/app/google-authenticator/id388497605",
  android: "https://play.google.com/store/apps/details?id=com.google.android.apps.authenticator2",
} as const

/**
 * Las apps que se recomiendan a quien aún no tiene una: gratis, en Android y
 * iPhone, y guardan copia en la cuenta, así cambiar de teléfono no deja a
 * nadie fuera. Cualquier otra app de códigos sirve igual.
 */
export const RECOMMENDED_AUTHENTICATORS = ["Google Authenticator", "Microsoft Authenticator"] as const

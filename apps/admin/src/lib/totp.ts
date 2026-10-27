/**
 * Lo que la pantalla de Seguridad de acceso muestra del enlace `otpauth://`
 * que entrega la API al enrolar (RFC 6238, el formato «Key Uri» que leen
 * todas las apps de autenticación). El enlace nunca se muestra como texto.
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

/** El código QR del enlace como imagen SVG (corrección M, margen de 4 módulos de la norma). */
export async function totpQrDataUrl(uri: string): Promise<string> {
  // Importación dinámica: qrcode no debe entrar al bundle inicial.
  const { default: QRCode } = await import("qrcode")
  const svg = await QRCode.toString(uri, { type: "svg", errorCorrectionLevel: "M", margin: 4 })
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** Las tiendas de Google Authenticator, la app que se recomienda (cualquiera sirve). */
export const AUTHENTICATOR_STORES = {
  iphone: "https://apps.apple.com/app/google-authenticator/id388497605",
  android: "https://play.google.com/store/apps/details?id=com.google.android.apps.authenticator2",
} as const

/** El archivo .txt de «Descargar» con los códigos de respaldo. */
export function backupCodesText(email: string, codes: string[]): string {
  return [
    "Códigos de respaldo de la administración",
    `Cuenta: ${email}`,
    "",
    "Cada código sirve una sola vez. Úsalo si no tienes tu app de autenticación.",
    "",
    ...codes,
    "",
  ].join("\n")
}

import type { ConnectionRejectedPart } from "./protocol.js"

/**
 * Una sola versión del Graph API de Meta para todo el producto: el botón de
 * Facebook, WhatsApp, Messenger e Instagram (`META_GRAPH_VERSION`). La API y el
 * worker la fijan al arrancar con su configuración; sin fijar vale la de por
 * defecto, la misma que declaran sus variables de entorno.
 */
export const DEFAULT_META_GRAPH_VERSION = "v25.0"

let version = DEFAULT_META_GRAPH_VERSION

export function configureMetaGraphVersion(value: string | null | undefined): void {
  const clean = value?.trim()
  if (clean && !/^v\d+\.\d+$/.test(clean)) throw new Error(`Versión del Graph API inválida: ${clean} (se espera la forma v25.0)`)
  version = clean || DEFAULT_META_GRAPH_VERSION
}

export function metaGraphVersion(): string {
  return version
}

/**
 * Qué dato de una conexión rechazó el Graph API, por su código de error: 190
 * es la clave (no sirve o venció); 100 y 803, un identificador que no existe o
 * que esa clave no puede ver. Otro código no dice cuál.
 * https://developers.facebook.com/docs/graph-api/guides/error-handling
 */
export function graphRejectedPart(json: unknown): ConnectionRejectedPart | null {
  const error = json && typeof json === "object" && "error" in json ? json.error : null
  const code = error && typeof error === "object" && "code" in error ? error.code : null
  if (code === 190) return "token"
  if (code === 100 || code === 803) return "id"
  return null
}

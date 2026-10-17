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

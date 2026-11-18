import type { ConnectionRejectedPart, MediaDownloadLimits } from "./protocol.js"

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

/** Lo que se pasa a `fetch` para respetar el tiempo límite (nada si no hay topes). */
export function mediaSignal(limits: MediaDownloadLimits | undefined): { signal?: AbortSignal } {
  return limits ? { signal: AbortSignal.timeout(limits.timeoutMs) } : {}
}

/**
 * Lee el cuerpo de una descarga. Con tope, rechaza antes de leer lo que dice
 * pesar más (`content-length`) y lee a trozos, cortando apenas lo pasa: un
 * servidor que miente sobre el tamaño tampoco llena la memoria.
 */
export async function readMediaBody(
  res: Response,
  label: string,
  limits: MediaDownloadLimits | undefined,
): Promise<Uint8Array> {
  if (!limits) return new Uint8Array(await res.arrayBuffer())
  const tooBig = () => new Error(`${label}: el archivo pesa más de ${limits.maxBytes} bytes`)
  const declared = Number(res.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > limits.maxBytes) {
    await res.body?.cancel().catch(() => {})
    throw tooBig()
  }
  if (!res.body) return new Uint8Array(0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limits.maxBytes) {
      await reader.cancel().catch(() => {})
      throw tooBig()
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

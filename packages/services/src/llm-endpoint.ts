import { isIP } from "node:net"
import { validation } from "./errors.js"

/**
 * Reglas de egreso para la URL base de un proveedor LLM configurado por una
 * organización (sin red): única implementación, compartida con la capa del
 * agente, que añade la resolución DNS. `allowInsecure` (dev/e2e) admite http
 * y destinos privados para servidores locales de prueba.
 */
function privateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number)
  if (a === undefined || b === undefined) return true
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  )
}

function privateV6(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (lower === "::" || lower === "::1") return true
  if (lower.startsWith("::ffff:")) {
    const mapped = lower.slice("::ffff:".length)
    return isIP(mapped) === 4 ? privateV4(mapped) : true
  }
  const head = Number.parseInt(lower.split(":")[0] || "0", 16)
  // fc00::/7 (ULA), fe80::/10 (link-local) y ff00::/8 (multicast)
  return (head & 0xfe00) === 0xfc00 || (head & 0xffc0) === 0xfe80 || (head & 0xff00) === 0xff00
}

/** Dirección que no debe recibir tráfico del agente. */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip)
  if (kind === 4) return privateV4(ip)
  if (kind === 6) return privateV6(ip)
  return true
}

/** Host de una URL sin los corchetes de IPv6. */
export function hostnameOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "")
}

/**
 * Validación sintáctica: https, sin credenciales ni fragmento, host público
 * si es literal. Devuelve la URL normalizada (sin barra final).
 */
export function parseLlmBaseUrl(raw: string, opts: { allowInsecure?: boolean } = {}): URL {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw validation("La URL base del proveedor no es válida")
  }
  if (url.protocol !== "https:" && !(opts.allowInsecure && url.protocol === "http:")) {
    throw validation("La URL base del proveedor debe usar https")
  }
  if (url.username || url.password) throw validation("La URL base no puede llevar credenciales")
  if (url.hash) throw validation("La URL base no puede llevar fragmento")
  const host = hostnameOf(url)
  const privateHost =
    host === "localhost" || host.endsWith(".localhost") || (isIP(host) !== 0 && isPrivateAddress(host))
  if (!opts.allowInsecure && privateHost) throw validation("La URL base apunta a una dirección privada")
  return url
}

/** Forma canónica para guardar y comparar. */
export function normalizeLlmBaseUrl(raw: string, opts: { allowInsecure?: boolean } = {}): string {
  return parseLlmBaseUrl(raw, opts).toString().replace(/\/$/, "")
}

import { BASE_DOMAIN } from "./host"

/** Solo redirige a URLs https del dominio base (panel, tenants, admin) o loopback en dev. */
export function safeNext(next: string | undefined): string | null {
  if (!next) return null
  try {
    const url = new URL(next)
    const host = url.hostname
    if (host === "localhost" || host === "127.0.0.1") {
      if (url.protocol !== "http:" && url.protocol !== "https:") return null
      return url.href
    }
    if (url.protocol !== "https:") return null
    if (host !== BASE_DOMAIN && !host.endsWith(`.${BASE_DOMAIN}`)) return null
    return url.href
  } catch {
    return null
  }
}

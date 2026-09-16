import { createIsomorphicFn } from "@tanstack/react-start"
import { getRequestHeaders } from "@tanstack/react-start/server"

export const BASE_DOMAIN = import.meta.env.VITE_BASE_DOMAIN as string

/** Host del request: cabecera en SSR, location en el cliente. */
export const requestHostname = createIsomorphicFn()
  .server(() => getRequestHeaders().get("host")?.split(":")[0] ?? "")
  .client(() => window.location.hostname)

/**
 * Slug de tenant desde el hostname (`<slug>.<base>`).
 * `null` en el apex y en hosts fuera del dominio base.
 */
export function orgSlugFromHostname(hostname: string): string | null {
  const suffix = `.${BASE_DOMAIN}`
  if (!hostname.endsWith(suffix)) return null
  const slug = hostname.slice(0, -suffix.length)
  return slug && !slug.includes(".") ? slug : null
}

export const tenantUrl = (slug: string, path = "/") => `https://${slug}.${BASE_DOMAIN}${path}`

export const panelUrl = (path = "/") => `https://app.${BASE_DOMAIN}${path}`

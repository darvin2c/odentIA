import { createIsomorphicFn } from "@tanstack/react-start"
import { getRequestHeaders } from "@tanstack/react-start/server"

export const BASE_DOMAIN = import.meta.env.VITE_BASE_DOMAIN as string
/**
 * Puerto del proxy cuando no es el estándar (dev detrás de portless en 443 no
 * necesita nada; un entorno de pruebas en otro puerto sí, si no los redirects
 * entre subdominios apuntarían a 443).
 */
const BASE_PORT = import.meta.env.VITE_BASE_PORT ? `:${import.meta.env.VITE_BASE_PORT}` : ""

/** Host del request: cabecera en SSR, location en el cliente. */
export const requestHostname = createIsomorphicFn()
  .server(() => getRequestHeaders().get("host")?.split(":")[0] ?? "")
  .client(() => window.location.hostname)

/**
 * Slug de tenant desde el hostname (`<slug>.<base>`).
 * `null` en el apex, en hosts reservados y fuera del dominio base.
 */
export function orgSlugFromHostname(hostname: string): string | null {
  const suffix = `.${BASE_DOMAIN}`
  if (!hostname.endsWith(suffix)) return null
  const slug = hostname.slice(0, -suffix.length)
  return slug && !slug.includes(".") && !["app", "admin", "api", "www", "storage"].includes(slug) ? slug : null
}

export const tenantUrl = (slug: string, path = "/") =>
  `https://${slug}.${BASE_DOMAIN}${BASE_PORT}${path}`

export const panelUrl = (path = "/") => `https://app.${BASE_DOMAIN}${BASE_PORT}${path}`

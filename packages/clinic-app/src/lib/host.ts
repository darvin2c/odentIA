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

/**
 * El dominio de cada producto (decisión 9 del issue 229): esta app vive en
 * `VITE_BASE_DOMAIN`; una clínica de odentIA abre en `VITE_DENTAL_DOMAIN` y
 * una de latidIA en `VITE_MEDICAL_DOMAIN`. Sin ellos, todo en este.
 */
const PRODUCT_DOMAINS: Record<string, string | undefined> = {
  dental: import.meta.env.VITE_DENTAL_DOMAIN || undefined,
  medical: import.meta.env.VITE_MEDICAL_DOMAIN || undefined,
}

/** El dominio de las clínicas de un producto; sin decir cuál, el de esta app. */
export const domainOf = (product?: string | null): string => (product && PRODUCT_DOMAINS[product]) || BASE_DOMAIN

/** La dirección de una clínica, en el dominio de su producto. */
export const tenantUrl = (slug: string, path = "/", product?: string | null) =>
  `https://${slug}.${domainOf(product)}${BASE_PORT}${path}`

export const panelUrl = (path = "/") => `https://app.${BASE_DOMAIN}${BASE_PORT}${path}`

/** Página de la web de marketing (dominio raíz). */
export const webUrl = (path = "/") => `https://${BASE_DOMAIN}${BASE_PORT}${path}`

/** Los documentos que se aceptan y dónde escribir si no se está de acuerdo. */
export const legalLinks = {
  terms: webUrl("/terminos"),
  privacy: webUrl("/privacidad"),
  agreement: webUrl("/encargo-de-tratamiento"),
  support: webUrl("/contacto"),
}

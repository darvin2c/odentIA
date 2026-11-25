import { type ClinicalProduct, isClinicalProduct } from "@odentia/clinical"
export const BASE_DOMAIN = import.meta.env.VITE_BASE_DOMAIN as string
/**
 * Puerto del proxy cuando no es el estándar (dev detrás de portless en 443 no
 * necesita nada; un entorno de pruebas en otro puerto sí, si no los redirects
 * al tenant apuntarían a 443).
 */
const BASE_PORT = import.meta.env.VITE_BASE_PORT ? `:${import.meta.env.VITE_BASE_PORT}` : ""

/**
 * El dominio de cada producto (decisión 9 del issue 229): el panel vive en
 * `VITE_BASE_DOMAIN`; una clínica de odentIA abre en `VITE_DENTAL_DOMAIN` y
 * una de latidIA en `VITE_MEDICAL_DOMAIN`. Sin ellos, todo en este.
 */
const PRODUCT_DOMAINS: Record<ClinicalProduct, string | undefined> = {
  dental: import.meta.env.VITE_DENTAL_DOMAIN || undefined,
  medical: import.meta.env.VITE_MEDICAL_DOMAIN || undefined,
  optical: import.meta.env.VITE_OPTICAL_DOMAIN || undefined,
}

/** El dominio de las clínicas de un producto; sin decir cuál, el de este panel. */
export const domainOf = (product?: string | null): string => (isClinicalProduct(product) && PRODUCT_DOMAINS[product]) || BASE_DOMAIN

/** Los dominios a los que se puede volver desde el panel: el suyo y el de cada producto. */
export const KNOWN_DOMAINS: readonly string[] = [
  ...new Set([BASE_DOMAIN, ...Object.values(PRODUCT_DOMAINS).filter((domain): domain is string => Boolean(domain))]),
]

/** La dirección de una clínica, en el dominio de su producto; en otro dominio, con el pase. */
export const tenantUrl = (slug: string, path = "/", product?: string | null) =>
  crossDomainHref(`https://${slug}.${domainOf(product)}${BASE_PORT}${path}`)

/**
 * Abrir un lugar de otro dominio del grupo con la misma sesión (ADR 0215): el enlace pasa por
 * el pase de la API de destino, que trae la sesión de este dominio y sigue al lugar. En el mismo
 * dominio, o fuera de los del grupo, la dirección queda igual.
 */
export function crossDomainHref(target: string): string {
  let host: string
  try {
    host = new URL(target).hostname
  } catch {
    return target
  }
  const on = (domain: string) => host === domain || host.endsWith(`.${domain}`)
  if (on(BASE_DOMAIN)) return target
  const destination = KNOWN_DOMAINS.find(on)
  if (!destination) return target
  const pase = new URL(`https://api.${destination}${BASE_PORT}/api/auth/pase/ir`)
  pase.searchParams.set("desde", BASE_DOMAIN)
  pase.searchParams.set("next", target)
  return pase.href
}

/** El propio panel: la página de «Conectar con Facebook» se abre siempre aquí (issue 166). */
export const panelUrl = (path = "/") => `https://app.${BASE_DOMAIN}${BASE_PORT}${path}`

/**
 * La administración es una sola, en el dominio de odentIA (ADR 0091): desde el panel de otro
 * producto se llega con el pase, sin entrar otra vez.
 */
export const adminUrl = (path = "/") =>
  crossDomainHref(`https://admin.${PRODUCT_DOMAINS.dental || BASE_DOMAIN}${BASE_PORT}${path}`)
/** Página de la web de marketing (dominio raíz): términos, privacidad, contacto. */
export const webUrl = (path = "/") => `https://${BASE_DOMAIN}${BASE_PORT}${path}`

/** Los documentos que se aceptan y dónde escribir si no se está de acuerdo. */
export const legalLinks = {
  terms: webUrl("/terminos"),
  privacy: webUrl("/privacidad"),
  agreement: webUrl("/encargo-de-tratamiento"),
  support: webUrl("/contacto"),
}

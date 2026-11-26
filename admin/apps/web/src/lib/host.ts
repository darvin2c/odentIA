import { type ClinicalProduct, isClinicalProduct } from "@odentia/clinical"

const BASE_DOMAIN = import.meta.env.VITE_BASE_DOMAIN as string
const BASE_PORT = import.meta.env.VITE_BASE_PORT ? `:${import.meta.env.VITE_BASE_PORT}` : ""

export const panelUrl = (path = "/") => `https://app.${BASE_DOMAIN}${BASE_PORT}${path}`
export const adminUrl = (path = "/") => `https://admin.${BASE_DOMAIN}${BASE_PORT}${path}`
/**
 * El dominio de cada producto (decisión 9 del issue 229): una clínica de
 * odentIA abre en `VITE_DENTAL_DOMAIN` y una de latidIA en
 * `VITE_MEDICAL_DOMAIN`. Sin ellos, en el de la administración.
 */
const PRODUCT_DOMAINS: Record<ClinicalProduct, string | undefined> = {
  dental: import.meta.env.VITE_DENTAL_DOMAIN || undefined,
  medical: import.meta.env.VITE_MEDICAL_DOMAIN || undefined,
  optical: import.meta.env.VITE_OPTICAL_DOMAIN || undefined,
}
export const domainOf = (product?: string | null): string =>
  (isClinicalProduct(product) && PRODUCT_DOMAINS[product]) || BASE_DOMAIN
/** La dirección de una clínica, en el dominio de su producto. */
export const platformUrl = (slug: string, path = "/", product?: string | null) =>
  `https://${slug}.${domainOf(product)}${BASE_PORT}${path}`
export const loginUrl = () => panelUrl(`/login?next=${encodeURIComponent(adminUrl())}`)
/** Web de marketing (Astro), donde vive el formulario del Libro de Reclamaciones. */
export const webUrl = (path = "/") => `https://www.${BASE_DOMAIN}${BASE_PORT}${path}`
/** La web de un producto, en su dominio: «Llegó desde» abre la guía de la que llegó una solicitud. */
export const siteUrl = (product: string | null | undefined, path = "/") =>
  `https://www.${domainOf(product)}${BASE_PORT}${path}`

/**
 * El dominio de gestorIA (`VITE_GESTORIA_DOMAIN`, gestoria24.com): sus tiendas abren en
 * `app.<dominio>/tiendas/<id>`. Sin él, no hay a dónde abrirlas.
 */
const GESTORIA_DOMAIN: string | undefined = import.meta.env.VITE_GESTORIA_DOMAIN || undefined

/**
 * Abrir un lugar de otro dominio del grupo con la misma sesión (el pase, ADR 0215): el enlace va
 * a `ir` en la API del destino, que trae la sesión de la administración (con su código) y sigue
 * al lugar. Así soporte mira una tienda sin volver a entrar (ADR 0219).
 */
export function crossDomainHref(target: string, destination: string): string {
  const pase = new URL(`https://api.${destination}${BASE_PORT}/api/auth/pase/ir`)
  pase.searchParams.set("desde", BASE_DOMAIN)
  pase.searchParams.set("next", target)
  return pase.href
}

/** «Mirar la tienda (solo mirar)»: la tienda de gestorIA con el pase; sin su dominio, nula. */
export const gestoriaStoreUrl = (storeId: string): string | null =>
  GESTORIA_DOMAIN
    ? crossDomainHref(
        `https://app.${GESTORIA_DOMAIN}${BASE_PORT}/tiendas/${encodeURIComponent(storeId)}`,
        GESTORIA_DOMAIN,
      )
    : null

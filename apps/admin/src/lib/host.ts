const BASE_DOMAIN = import.meta.env.VITE_BASE_DOMAIN as string
const BASE_PORT = import.meta.env.VITE_BASE_PORT ? `:${import.meta.env.VITE_BASE_PORT}` : ""

export const panelUrl = (path = "/") => `https://app.${BASE_DOMAIN}${BASE_PORT}${path}`
export const adminUrl = (path = "/") => `https://admin.${BASE_DOMAIN}${BASE_PORT}${path}`
/**
 * El dominio de cada producto (decisión 9 del issue 229): una clínica de
 * odentIA abre en `VITE_DENTAL_DOMAIN` y una de latidIA en
 * `VITE_MEDICAL_DOMAIN`. Sin ellos, en el de la administración.
 */
const PRODUCT_DOMAINS: Record<string, string | undefined> = {
  dental: import.meta.env.VITE_DENTAL_DOMAIN || undefined,
  medical: import.meta.env.VITE_MEDICAL_DOMAIN || undefined,
}
export const domainOf = (product?: string | null): string => (product && PRODUCT_DOMAINS[product]) || BASE_DOMAIN
/** La dirección de una clínica, en el dominio de su producto. */
export const platformUrl = (slug: string, path = "/", product?: string | null) =>
  `https://${slug}.${domainOf(product)}${BASE_PORT}${path}`
export const loginUrl = () => panelUrl(`/login?next=${encodeURIComponent(adminUrl())}`)
/** Web de marketing (Astro), donde vive el formulario del Libro de Reclamaciones. */
export const webUrl = (path = "/") => `https://www.${BASE_DOMAIN}${BASE_PORT}${path}`

export const BASE_DOMAIN = import.meta.env.VITE_BASE_DOMAIN as string
/**
 * Puerto del proxy cuando no es el estándar (dev detrás de portless en 443 no
 * necesita nada; un entorno de pruebas en otro puerto sí, si no los redirects
 * al tenant apuntarían a 443).
 */
const BASE_PORT = import.meta.env.VITE_BASE_PORT ? `:${import.meta.env.VITE_BASE_PORT}` : ""

export const tenantUrl = (slug: string, path = "/") =>
  `https://${slug}.${BASE_DOMAIN}${BASE_PORT}${path}`

export const adminUrl = (path = "/") => `https://admin.${BASE_DOMAIN}${BASE_PORT}${path}`
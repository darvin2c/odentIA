export const BASE_DOMAIN = import.meta.env.VITE_BASE_DOMAIN as string

export const tenantUrl = (slug: string, path = "/") => `https://${slug}.${BASE_DOMAIN}${path}`

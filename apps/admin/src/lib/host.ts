const BASE_DOMAIN = import.meta.env.VITE_BASE_DOMAIN as string
const BASE_PORT = import.meta.env.VITE_BASE_PORT ? `:${import.meta.env.VITE_BASE_PORT}` : ""

export const panelUrl = (path = "/") => `https://app.${BASE_DOMAIN}${BASE_PORT}${path}`
export const adminUrl = (path = "/") => `https://admin.${BASE_DOMAIN}${BASE_PORT}${path}`
export const platformUrl = (slug: string, path = "/") =>
  `https://${slug}.${BASE_DOMAIN}${BASE_PORT}${path}`
export const loginUrl = () => panelUrl(`/login?next=${encodeURIComponent(adminUrl())}`)

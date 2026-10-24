function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error("Ejecuta pnpm e2e para crear un entorno aislado")
  return value
}

export const RUN_ID = required("E2E_RUN_ID")
const SCHEME = required("E2E_SCHEME")
const BASE_DOMAIN = required("E2E_BASE_DOMAIN")
const PROXY_PORT = required("E2E_PORT")
const PORT = PROXY_PORT === "443" ? "" : `:${PROXY_PORT}`

export function hostUrl(subdomain: string, path = ""): string {
  const host = subdomain ? `${subdomain}.${BASE_DOMAIN}` : BASE_DOMAIN
  return `${SCHEME}://${host}${PORT}${path}`
}

export const API = hostUrl("api")
export const PANEL = hostUrl("app")
export const baseUrl = PANEL
export const tenant = (slug: string, path: string): string => hostUrl(slug, path)
export const tenantPattern = (slug: string, path: string): RegExp =>
  new RegExp(`^${escapeRegExp(tenant(slug, path))}`)
export const panelPattern = (path: string): RegExp =>
  new RegExp(`^${escapeRegExp(hostUrl("app", path))}`)

/**
 * latidIA en su dominio (`latidia.<tld>`, decisión 9 del issue 229): solo
 * cuando la ejecución lo levanta (la suite completa o un recorrido suyo).
 */
export function latidiaUrl(subdomain: string, path = ""): string {
  const domain = process.env.E2E_MEDICAL_DOMAIN
  if (!domain) throw new Error("Esta ejecución no levantó latidIA: corre un recorrido latidia*.spec.ts")
  const host = subdomain ? `${subdomain}.${domain}` : domain
  return `${SCHEME}://${host}${PORT}${path}`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

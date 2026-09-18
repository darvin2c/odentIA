/**
 * URLs del entorno bajo prueba.
 *
 * Por defecto apunta al namespace del harness (`e2e.localhost:4463`), que
 * `playwright.config.ts` levanta con contenedores y servidores propios. Se
 * puede apuntar a otro entorno (p. ej. el stack dev) con `E2E_SCHEME`,
 * `E2E_BASE_DOMAIN` y `E2E_PORT`.
 */
import { HARNESS_DOMAIN, HARNESS_PORT, HARNESS_SCHEME } from "./harness-env"

/**
 * Por defecto apunta al stack dev (`odentia.localhost:443`). Con
 * `E2E_HARNESS=1` el harness publica su namespace (`odentia.e2e.localhost:4463`)
 * y estas variables llegan por env; los defaults siguen ese mismo modo.
 */
const harness = process.env.E2E_HARNESS === "1"
const SCHEME = process.env.E2E_SCHEME ?? (harness ? HARNESS_SCHEME : "https")
const BASE_DOMAIN = process.env.E2E_BASE_DOMAIN ?? (harness ? HARNESS_DOMAIN : "odentia.localhost")
const PROXY_PORT = process.env.E2E_PORT ?? (harness ? HARNESS_PORT : "443")
const PORT = PROXY_PORT === "443" || PROXY_PORT === "" ? "" : `:${PROXY_PORT}`

/** Host de un subdominio del entorno (`""` = dominio base). */
export function hostUrl(subdomain: string, path = ""): string {
  const host = subdomain ? `${subdomain}.${BASE_DOMAIN}` : BASE_DOMAIN
  return `${SCHEME}://${host}${PORT}${path}`
}

export const API = hostUrl("api")
export const PANEL = hostUrl("app")
export const baseUrl = PANEL
export const baseDomain = BASE_DOMAIN

/** Tenant: `https://<slug>.<dominio>[/ruta]`. */
export const tenant = (slug: string, path: string): string => hostUrl(slug, path)

/** Regex de una ruta de tenant para `toHaveURL`. */
export const tenantPattern = (slug: string, path: string): RegExp =>
  new RegExp(`^${SCHEME}://${slug}\\.${BASE_DOMAIN}${PORT}${escapeRegExp(path)}`)

/** Regex de una ruta del panel para `toHaveURL`. */
export const panelPattern = (path: string): RegExp =>
  new RegExp(`^${escapeRegExp(PANEL)}${escapeRegExp(path)}`)

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
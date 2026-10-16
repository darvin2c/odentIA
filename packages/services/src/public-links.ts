import type { Db } from "@odentia/db"
import { organization } from "@odentia/db/schema/auth"
import { eq } from "drizzle-orm"
import { personalLinkRef } from "./personal-link-token.js"

/**
 * Dónde vive la página pública de cada clínica: `https://<clínica>.<dominio>`.
 * La API y el worker lo fijan al arrancar con su configuración (`WEB_URL` y
 * `COOKIE_DOMAIN`), nunca con lo que llega en una petición: los mensajes que
 * llevan «Su enlace» (el aviso de la cita, «Presupuesto listo», «Enviarle su
 * enlace») y la plantilla que se pide a WhatsApp con su botón lo leen de aquí.
 * Sin configurar (pruebas que no lo necesitan) no hay enlace: quien envía no
 * promete uno.
 */
export interface PublicLinkConfig {
  webURL: string
  cookieDomain: string
}

let configured: PublicLinkConfig | null = null

export function configurePublicLinks(config: PublicLinkConfig | null): void {
  configured = config?.webURL && config.cookieDomain ? { ...config } : null
}

export function publicLinksConfigured(): boolean {
  return configured !== null
}

/** Origen público de una clínica por su subdominio, con el esquema y el puerto de la plataforma. */
export function clinicOrigin(slug: string, config: PublicLinkConfig | null = configured): string | null {
  if (!config || !slug) return null
  const url = new URL(config.webURL)
  url.hostname = `${slug}.${config.cookieDomain.replace(/^\./, "")}`
  url.pathname = "/"
  url.search = ""
  url.hash = ""
  return url.origin
}

/** La dirección de «Su enlace» (la página `/reserva`), con su token. */
export function personalLinkAddress(origin: string, token: string): string {
  return `${origin}/reserva?token=${token}`
}

async function slugOf(tx: Db, orgId: string): Promise<string | null> {
  const [row] = await tx.select({ slug: organization.slug }).from(organization).where(eq(organization.id, orgId)).limit(1)
  return row?.slug ?? null
}

/** «Su enlace» de una clínica con su token; nulo si no hay dirección pública configurada. */
export async function personalLinkUrl(tx: Db, orgId: string, token: string): Promise<string | null> {
  const origin = clinicOrigin((await slugOf(tx, orgId)) ?? "")
  return origin ? personalLinkAddress(origin, token) : null
}

/**
 * «Su enlace» como se guarda en un mensaje: con la referencia a su enlace en
 * lugar del token (`personalLinkRef`); el worker pone el token al enviarlo.
 */
export async function personalLinkMessageUrl(tx: Db, orgId: string, linkId: string): Promise<string | null> {
  return personalLinkUrl(tx, orgId, personalLinkRef(linkId))
}

/**
 * La dirección del botón de una plantilla de WhatsApp: fija, con el token como
 * su único dato al final (`{{1}}`), como pide el proveedor. Nula sin dirección pública.
 */
export async function personalLinkButtonUrl(tx: Db, orgId: string): Promise<{ url: string; example: string } | null> {
  const origin = clinicOrigin((await slugOf(tx, orgId)) ?? "")
  if (!origin) return null
  return { url: personalLinkAddress(origin, "{{1}}"), example: personalLinkAddress(origin, "0".repeat(64)) }
}

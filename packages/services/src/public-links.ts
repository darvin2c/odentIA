import { type ClinicalProduct, isClinicalProduct } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { organization } from "@odentia/db/schema/auth"
import { orgProfile } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { personalLinkRef } from "./personal-link-token.js"

/**
 * Dónde vive la página pública de cada clínica: `https://<clínica>.<dominio>`,
 * con el dominio de su producto (odentIA: odentia32.com; latidIA:
 * latidia72.com; decisión 9 del lienzo del issue 229). La API y el worker lo
 * fijan al arrancar con su configuración (`WEB_URL`, `COOKIE_DOMAIN` y
 * `MEDICAL_DOMAIN`), nunca con lo que llega en una petición: los mensajes que
 * llevan «Su enlace» (el aviso de la cita, «Presupuesto listo», «Enviarle su
 * enlace») y la plantilla que se pide a WhatsApp con su botón lo leen de aquí.
 * Sin configurar (pruebas que no lo necesitan) no hay enlace: quien envía no
 * promete uno.
 */
export interface PublicLinkConfig {
  /** El esquema y el puerto de toda dirección pública: los de la plataforma. */
  webURL: string
  /** El dominio de odentIA, y el de todo producto que no tenga el suyo. */
  cookieDomain: string
  /** El dominio de cada otro producto (latidIA: «latidia72.com»). */
  productDomains?: Partial<Record<ClinicalProduct, string>>
}

let configured: PublicLinkConfig | null = null

export function configurePublicLinks(config: PublicLinkConfig | null): void {
  configured = config?.webURL && config.cookieDomain ? { ...config } : null
}

export function publicLinksConfigured(): boolean {
  return configured !== null
}

/** El dominio de un producto: el suyo o, si no tiene, el de odentIA. */
export function productDomainOf(product: ClinicalProduct, config: PublicLinkConfig | null = configured): string | null {
  if (!config) return null
  return (config.productDomains?.[product] ?? config.cookieDomain).replace(/^\./, "")
}

/**
 * Origen público de una clínica por su subdominio, en el dominio de su
 * producto, con el esquema y el puerto de la plataforma.
 */
export function clinicOrigin(
  slug: string,
  product: ClinicalProduct = "dental",
  config: PublicLinkConfig | null = configured,
): string | null {
  const domain = productDomainOf(product, config)
  if (!config || !domain || !slug) return null
  const url = new URL(config.webURL)
  url.hostname = `${slug}.${domain}`
  url.pathname = "/"
  url.search = ""
  url.hash = ""
  return url.origin
}

/**
 * El panel de un producto (`app.` de su dominio): ahí está «Elige tu clínica»
 * y desde ahí se entra a Plan y pagos. odentIA, el de `webURL`; sin
 * configurar, ninguno.
 */
export function panelOrigin(product: ClinicalProduct = "dental", config: PublicLinkConfig | null = configured): string | null {
  if (!config) return null
  const url = new URL(config.webURL)
  const domain = config.productDomains?.[product]
  if (domain && product !== "dental") url.hostname = `app.${domain.replace(/^\./, "")}`
  return url.origin
}

/** La dirección de «Su enlace» (la página `/reserva`), con su token. */
export function personalLinkAddress(origin: string, token: string): string {
  return `${origin}/reserva?token=${token}`
}

/** El subdominio y el producto de una clínica (sin perfil, las de hoy son dentales). */
export async function clinicAddressOf(
  tx: Db,
  orgId: string,
): Promise<{ slug: string; product: ClinicalProduct } | null> {
  const [row] = await tx
    .select({ slug: organization.slug, product: orgProfile.product })
    .from(organization)
    .leftJoin(orgProfile, eq(orgProfile.organizationId, organization.id))
    .where(eq(organization.id, orgId))
    .limit(1)
  if (!row?.slug) return null
  return { slug: row.slug, product: isClinicalProduct(row.product) ? row.product : "dental" }
}

/** Origen público de una clínica por su id; nulo sin dirección pública configurada. */
export async function clinicOriginOf(tx: Db, orgId: string): Promise<string | null> {
  const clinic = await clinicAddressOf(tx, orgId)
  return clinic ? clinicOrigin(clinic.slug, clinic.product) : null
}

/** «Su enlace» de una clínica con su token; nulo si no hay dirección pública configurada. */
export async function personalLinkUrl(tx: Db, orgId: string, token: string): Promise<string | null> {
  const origin = await clinicOriginOf(tx, orgId)
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
  const origin = await clinicOriginOf(tx, orgId)
  if (!origin) return null
  return { url: personalLinkAddress(origin, "{{1}}"), example: personalLinkAddress(origin, "0".repeat(64)) }
}

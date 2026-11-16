import { CLINICAL_PRODUCTS, type ClinicalProduct, isClinicalProduct } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { saasDemo } from "@odentia/db/schema/admin-demos"
import { organization } from "@odentia/db/schema/auth"
import { orgProfile } from "@odentia/db/schema/org"
import { eq, sql } from "drizzle-orm"
import { cloudflareHostsFirewall } from "./cloudflare-waf.js"
import { type PublicLinkConfig, productDomainOf } from "./public-links.js"

/**
 * Solo los subdominios de clínicas reales llegan a las pantallas (ADR 0193). La app de
 * las clínicas entra por una ruta comodín de Cloudflare (`*.<dominio>/*`, ADR 0138), así
 * que cualquier subdominio inventado llegaba al Worker y gastaba una petición del plan
 * gratuito: el 15 nov un robot agotó las 100 000 del día y se cayeron todas las pantallas.
 * Una regla de WAF de cada zona bloquea, antes del Worker, todo host del dominio que no
 * sea del sistema ni de una clínica o demo que exista. La lista la mantiene el sistema:
 * al crear, renombrar o borrar una clínica o una demo, y el worker cada hora.
 */

/**
 * Los subdominios del sistema en cada zona (docs/deployment.md): la web (`www.`), el
 * panel (`app.`), la administración (`admin.`; en el dominio de otro producto, la app de
 * las clínicas lleva a la de odentIA), la API (`api.`) y los archivos de R2 (`media.`).
 * `storage` está reservado como slug, pero nada lo sirve. Un subdominio nuevo con proxy
 * en esas zonas va aquí, o la regla lo bloquea.
 */
export const SYSTEM_SUBDOMAINS = ["www", "app", "admin", "api", "media"] as const

/** Cómo se reconoce la regla del sistema en cada zona: por su descripción, la misma en todas. */
const CLINIC_HOSTS_RULE =
  "Solo los hosts del sistema y de sus clínicas (la mantiene odentIA: no editar a mano)"

/** El tope de la expresión de una regla de Cloudflare: más larga, no se publica. */
export const RULE_EXPRESSION_LIMIT = 4000
/** Desde aquí se avisa en el registro: la lista se acerca al tope. */
export const RULE_EXPRESSION_WARNING = 3200

/** Lo que pasó con la regla de una zona. */
export type HostsRuleOutcome = "creada" | "cambiada" | "igual"

/**
 * El puerto hacia el proveedor: la regla de hosts permitidos de una zona. El adaptador
 * de Cloudflare es `cloudflareHostsFirewall`.
 */
export interface HostsFirewall {
  /**
   * Deja en la zona la regla con esa descripción y esa expresión: la crea (Block,
   * encendida) si no está y, si está, cambia solo su expresión. Nunca toca las demás.
   */
  putRule(
    zoneId: string,
    rule: { description: string; expression: string },
  ): Promise<HostsRuleOutcome>
}

/** Una zona de Cloudflare y el dominio de sus clínicas. */
export interface HostsZone {
  zoneId: string
  domain: string
}

export interface ClinicHosts {
  firewall: HostsFirewall
  /** El dominio de las clínicas de cada producto. */
  domains: Record<ClinicalProduct, string>
  /** Las zonas que se mantienen; un dominio sin zona (vistIA hoy) no tiene regla. */
  zones: HostsZone[]
}

/** Una clínica o demo con subdominio; su producto es null mientras no tiene perfil. */
export interface ClinicHost {
  slug: string
  product: ClinicalProduct | null
}

/** Una etiqueta de DNS: lo que no lo es no se puede abrir como subdominio, y no entra a la expresión. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
/** Los ids de zona de Cloudflare: 32 caracteres hexadecimales. */
const ZONE_ID = /^[0-9a-f]{32}$/

/** Los subdominios de clínicas de una lista, sin repetir ni los del sistema. */
function clinicLabels(slugs: Iterable<string>): Set<string> {
  const system: ReadonlySet<string> = new Set(SYSTEM_SUBDOMAINS)
  const labels = new Set<string>()
  for (const slug of slugs) {
    const label = slug.trim().toLowerCase()
    if (LABEL.test(label) && !system.has(label)) labels.add(label)
  }
  return labels
}

const hostsOf = (domain: string, labels: Iterable<string>): string[] =>
  [...SYSTEM_SUBDOMAINS, ...labels].map((label) => `${label}.${domain}`).sort()

/** Los hosts permitidos de un dominio: los del sistema y uno por clínica, sin repetir y en orden. */
export function allowedHosts(domain: string, slugs: Iterable<string>): string[] {
  return hostsOf(domain, clinicLabels(slugs))
}

/**
 * La expresión de la regla: todo subdominio que no está en la lista. El dominio mismo
 * (`odentia32.com`) no termina en `.odentia32.com`, así que la regla no lo toca.
 */
export function hostsRuleExpression(domain: string, hosts: readonly string[]): string {
  return `ends_with(http.host, ".${domain}") and not http.host in {${hosts.map((host) => `"${host}"`).join(" ")}}`
}

type HostsRulePlan =
  | { ok: true; expression: string; clinics: number }
  | { ok: false; reason: "sin-clinicas" }
  | { ok: false; reason: "muy-larga"; length: number }

/**
 * Lo que se publica en un dominio. Nunca una lista sin clínicas (bloquearía a todas si
 * la lectura vino incompleta) ni una expresión pasada del tope (Cloudflare la rechaza, y
 * recortarla dejaría fuera a las últimas clínicas).
 */
export function planHostsRule(domain: string, slugs: Iterable<string>): HostsRulePlan {
  const labels = clinicLabels(slugs)
  if (labels.size === 0) return { ok: false, reason: "sin-clinicas" }
  const expression = hostsRuleExpression(domain, hostsOf(domain, labels))
  if (expression.length > RULE_EXPRESSION_LIMIT)
    return { ok: false, reason: "muy-larga", length: expression.length }
  return { ok: true, expression, clinics: labels.size }
}

/**
 * Los subdominios de un dominio: los de sus clínicas y los que todavía no dicen su
 * producto (una clínica recién abierta, antes de su perfil), que entran en todos.
 */
export function zoneSlugs(
  domains: Record<ClinicalProduct, string>,
  domain: string,
  clinics: readonly ClinicHost[],
): string[] {
  return clinics
    .filter((clinic) => clinic.product === null || domains[clinic.product] === domain)
    .map((clinic) => clinic.slug)
}

/**
 * Las clínicas con subdominio: todas las de la base, en cualquier estado de su plan (su
 * Plan y pagos se abre siempre), y las demos pedidas, que tienen el suyo antes de que el
 * worker arme su clínica.
 */
async function listClinicHosts(tx: Db): Promise<ClinicHost[]> {
  const clinics = await tx
    .select({ slug: organization.slug, product: orgProfile.product })
    .from(organization)
    .leftJoin(orgProfile, eq(orgProfile.organizationId, organization.id))
  const demos = await tx.select({ slug: saasDemo.slug, product: saasDemo.product }).from(saasDemo)
  return [...clinics, ...demos].map((row) => ({
    slug: row.slug,
    product: isClinicalProduct(row.product) ? row.product : null,
  }))
}

export interface HostsZoneResult {
  domain: string
  outcome: HostsRuleOutcome | "sin-clinicas" | "muy-larga" | "error"
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function publishZone(
  config: ClinicHosts,
  zone: HostsZone,
  clinics: readonly ClinicHost[],
): Promise<HostsZoneResult> {
  const plan = planHostsRule(zone.domain, zoneSlugs(config.domains, zone.domain, clinics))
  if (!plan.ok) {
    if (plan.reason === "sin-clinicas")
      console.warn(
        `clinic-hosts: ${zone.domain} no tiene ninguna clínica en la base; su regla queda como estaba`,
      )
    else
      console.error(
        `clinic-hosts: la regla de ${zone.domain} tendría ${plan.length} caracteres, más de los ${RULE_EXPRESSION_LIMIT} de Cloudflare; queda como estaba. Hay que pasar a otra estrategia: Workers Paid o una ruta por clínica (ADR 0193)`,
      )
    return { domain: zone.domain, outcome: plan.reason }
  }
  if (plan.expression.length >= RULE_EXPRESSION_WARNING)
    console.warn(
      `clinic-hosts: la regla de ${zone.domain} usa ${plan.expression.length} de ${RULE_EXPRESSION_LIMIT} caracteres; pronto habrá que pasar a Workers Paid o a una ruta por clínica (ADR 0193)`,
    )
  try {
    const outcome = await config.firewall.putRule(zone.zoneId, {
      description: CLINIC_HOSTS_RULE,
      expression: plan.expression,
    })
    if (outcome !== "igual")
      console.log(`clinic-hosts: regla de ${zone.domain} ${outcome}, con ${plan.clinics} clínicas`)
    return { domain: zone.domain, outcome }
  } catch (error) {
    console.error(
      `clinic-hosts: Cloudflare no tomó la regla de ${zone.domain}; se reintenta en la reconciliación (${reasonOf(error)})`,
    )
    return { domain: zone.domain, outcome: "error" }
  }
}

/**
 * Pone al día la regla de cada zona con las clínicas de la base. Nunca lanza: lo que
 * falla queda en el registro técnico, la operación que la llamó sigue y la reconciliación
 * del worker lo vuelve a intentar. Sin configuración no hace nada (null).
 *
 * Va una a la vez entre la API y el worker (un candado de la base mientras lee y
 * publica): la que lee después publica después, y ninguna pisa la lista de otra con una
 * lectura anterior. Por eso la transacción, que solo lee, sigue abierta mientras se llama
 * a Cloudflare. Si la lectura falla, no se publica nada.
 */
export async function syncClinicHosts(
  ownerDb: Db,
  config: ClinicHosts | null | undefined,
): Promise<HostsZoneResult[] | null> {
  if (!config) return null
  try {
    return await ownerDb.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '60s'`)
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('clinic-hosts', 0))`)
      const clinics = await listClinicHosts(tx as Db)
      // Las zonas no dependen una de otra: el candado dura lo que tarda la más lenta.
      return await Promise.all(config.zones.map((zone) => publishZone(config, zone, clinics)))
    })
  } catch (error) {
    console.error(
      `clinic-hosts: no se leyeron las clínicas; las reglas de Cloudflare quedan como estaban (${reasonOf(error)})`,
    )
    return null
  }
}

/** Las variables de la lista de hosts permitidos (docs/deployment.md). */
export interface ClinicHostsEnv {
  /** Un token de Cloudflare con «Zone WAF: Edit» solo en las zonas de los productos. */
  CLOUDFLARE_WAF_TOKEN?: string | undefined
  /** La zona del dominio de la plataforma (odentIA, `COOKIE_DOMAIN`). */
  CLOUDFLARE_ZONE_ID?: string | undefined
  /** La de latidIA (`MEDICAL_DOMAIN`). */
  MEDICAL_CLOUDFLARE_ZONE_ID?: string | undefined
  /** La de vistIA (`OPTICAL_DOMAIN`): hoy su dominio no está en Cloudflare. */
  OPTICAL_CLOUDFLARE_ZONE_ID?: string | undefined
}

/** La variable con la zona del dominio de cada producto. */
const ZONE_VARIABLE: Record<ClinicalProduct, keyof ClinicHostsEnv> = {
  dental: "CLOUDFLARE_ZONE_ID",
  medical: "MEDICAL_CLOUDFLARE_ZONE_ID",
  optical: "OPTICAL_CLOUDFLARE_ZONE_ID",
}

/**
 * La lista de hosts permitidos con lo que dice el entorno; null (y lo registra) si falta
 * el token o el id de toda zona: entonces nada se sincroniza y Cloudflare queda como esté.
 */
export function clinicHostsFromEnv(
  env: ClinicHostsEnv,
  links: PublicLinkConfig,
  fetchImpl: typeof fetch = fetch,
): ClinicHosts | null {
  const off = (missing: string) => {
    console.log(
      `clinic-hosts: sin ${missing}; la lista de hosts permitidos de Cloudflare no se mantiene (docs/deployment.md)`,
    )
    return null
  }
  const token = env.CLOUDFLARE_WAF_TOKEN?.trim()
  if (!token) return off("CLOUDFLARE_WAF_TOKEN")
  const domains = Object.fromEntries(
    CLINICAL_PRODUCTS.map((product) => [
      product,
      (productDomainOf(product, links) ?? "").toLowerCase(),
    ]),
  ) as Record<ClinicalProduct, string>
  const zones: HostsZone[] = []
  for (const product of CLINICAL_PRODUCTS) {
    const variable = ZONE_VARIABLE[product]
    const zoneId = env[variable]?.trim().toLowerCase()
    if (!zoneId) continue
    const domain = domains[product]
    if (!ZONE_ID.test(zoneId))
      console.error(
        `clinic-hosts: ${variable} no es un id de zona de Cloudflare (32 caracteres hexadecimales); ${domain} no se mantiene`,
      )
    else if (!DOMAIN.test(domain))
      console.error(`clinic-hosts: ${domain} no es un dominio; ${variable} no se usa`)
    else if (zones.some((zone) => zone.domain === domain))
      console.error(
        `clinic-hosts: ${variable} es de ${domain}, que ya tiene su zona (¿falta el dominio de su producto?); no se usa`,
      )
    else zones.push({ zoneId, domain })
  }
  if (zones.length === 0) return off("el id de ninguna zona (CLOUDFLARE_ZONE_ID…)")
  console.log(
    `clinic-hosts: se mantiene la lista de hosts permitidos de ${zones.map((zone) => zone.domain).join(" y ")}`,
  )
  return { firewall: cloudflareHostsFirewall(token, fetchImpl), domains, zones }
}

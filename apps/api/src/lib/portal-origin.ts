import { type ClinicalProduct, isClinicalProduct } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { organization } from "@odentia/db/schema/auth"
import { orgProfile } from "@odentia/db/schema/org"
import { clinicOrigin, type PublicLinkConfig } from "@odentia/services"
import { eq } from "drizzle-orm"

/**
 * El origen WebAuthn nace de configuración del servidor, nunca de Origin/Host
 * del cliente: el de la clínica, en el dominio de su producto (decisión 9 del
 * issue 229).
 */
export function portalOrigin(config: PublicLinkConfig, org: { slug: string; product: ClinicalProduct }): string {
  return clinicOrigin(org.slug, org.product, config) ?? new URL(config.webURL).origin
}

/** La clínica del portal por su subdominio, con su producto. Con la conexión de dueño: aún no hay clínica en contexto. */
export async function portalOrganization(ownerDb: Db, slug: string) {
  const [org] = await ownerDb
    .select({ id: organization.id, slug: organization.slug, name: organization.name, product: orgProfile.product })
    .from(organization)
    .leftJoin(orgProfile, eq(orgProfile.organizationId, organization.id))
    .where(eq(organization.slug, slug))
    .limit(1)
  if (!org) return null
  return { ...org, product: isClinicalProduct(org.product) ? org.product : ("dental" as const) }
}

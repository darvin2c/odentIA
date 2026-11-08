/**
 * Cómo se presenta la clínica a la persona (decisión 19 de la fase 4): un solo
 * nombre visible, el nombre comercial (`org_profile.trade_name`), y su logo.
 *
 * - El nombre comercial es obligatorio; vacío, la base pone la razón social
 *   (respaldo de datos viejos) y lo copia en `organization.name`, el que leen
 *   las pantallas de la cuenta, el chat web y el registro público: no hay dos
 *   nombres que puedan diferir.
 * - La razón social va solo en el comprobante y en los papeles legales.
 * - El logo es una imagen pública (la ve quien abre el registro o su enlace):
 *   vive en el bucket público, como los avatares, en `organization.logo`.
 * - El color de la marca (ADR 0157) es uno solo para toda la clínica, en
 *   `org_profile.brand_color`: lo ven el equipo, el paciente y la línea del papel.
 */
import { brandPalette, normalizeBrandColor, PRODUCT_BRAND_COLORS } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { organization } from "@odentia/db/schema/auth"
import { auditEvent, orgProfile } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { findClinicName } from "./automation-routing.js"
import { validation } from "./errors.js"

/** El nombre que ve la persona: el comercial (la razón social solo si faltara). */
export async function clinicDisplayName(tx: Db, orgId: string): Promise<string> {
  return (await findClinicName(tx, orgId)) ?? ""
}

export const CLINIC_LOGO_MAX_BYTES = 2 * 1024 * 1024

export const CLINIC_LOGO_MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
}

/** El logo de la clínica (su dirección pública) o null. */
export async function getClinicLogo(tx: Db, orgId: string): Promise<string | null> {
  const [row] = await tx.select({ logo: organization.logo }).from(organization).where(eq(organization.id, orgId)).limit(1)
  return row?.logo ?? null
}

/**
 * Guarda (o quita, con null) el logo ya subido. Devuelve el anterior, para
 * borrarlo del almacenamiento después de confirmar.
 */
export async function setClinicLogo(
  tx: Db,
  orgId: string,
  actorUserId: string,
  url: string | null,
): Promise<{ logo: string | null; previous: string | null }> {
  const previous = await getClinicLogo(tx, orgId)
  await tx.update(organization).set({ logo: url }).where(eq(organization.id, orgId))
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: url ? "org_profile.logo_set" : "org_profile.logo_removed",
    entity: "org_profile",
    entityId: orgId,
    metadata: {},
  })
  return { logo: url, previous }
}

/** El color de la marca y el producto de la clínica (el de fábrica cuando no eligió uno). */
export async function getClinicBrandColor(
  tx: Db,
  orgId: string,
): Promise<{ brandColor: string | null; product: keyof typeof PRODUCT_BRAND_COLORS }> {
  const [row] = await tx
    .select({ brandColor: orgProfile.brandColor, product: orgProfile.product })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .limit(1)
  return { brandColor: row?.brandColor ?? null, product: row?.product === "medical" ? "medical" : "dental" }
}

/**
 * Guarda el color de la marca, o lo quita con null (vuelve al del producto). El de
 * fábrica se guarda como null: elegirlo es volver a como viene. Cualquier otro color
 * vale; si se parece al rojo de los errores, la actividad guarda que se avisó.
 */
export async function setClinicBrandColor(
  tx: Db,
  orgId: string,
  actorUserId: string,
  color: string | null,
): Promise<{ brandColor: string | null }> {
  const normalized = color === null ? null : normalizeBrandColor(color)
  if (color !== null && !normalized)
    throw validation("Escribe 6 cifras o letras después de #, como #1D5FA8", {
      color: "Escribe 6 cifras o letras después de #, como #1D5FA8",
    })
  const { product } = await getClinicBrandColor(tx, orgId)
  const brandColor = normalized === PRODUCT_BRAND_COLORS[product] ? null : normalized
  const [updated] = await tx
    .update(orgProfile)
    .set({ brandColor, updatedAt: new Date() })
    .where(eq(orgProfile.organizationId, orgId))
    .returning({ id: orgProfile.organizationId })
  if (!updated) throw validation("Completa primero los datos de la clínica")
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: brandColor ? "org_profile.brand_color_set" : "org_profile.brand_color_removed",
    entity: "org_profile",
    entityId: orgId,
    metadata: brandColor ? { color: brandColor, ...(brandPalette(brandColor).reddish ? { warnedReddish: true } : {}) } : {},
  })
  return { brandColor }
}

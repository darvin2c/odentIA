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
 */
import type { Db } from "@odentia/db"
import { organization } from "@odentia/db/schema/auth"
import { auditEvent } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { findClinicName } from "./automation-routing.js"

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

/**
 * «Datos de la clínica»: la identidad (razón social, nombre comercial, documento
 * fiscal, dirección fiscal, urgencias), la región, la impresión y la otra moneda.
 * Una sola operación para la pantalla de la clínica (`PUT /org-profile`) y para la
 * carga de su configuración desde la administración (`clinic-setup.ts`).
 *
 * Una clínica que nace (todavía sin ninguna sede) se enciende entera al guardar sus
 * datos (ADR 0141), con sus especialidades y sus consentimientos del país.
 */
import type { ClinicalProduct } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { auditEvent, branch, orgProfile } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { ensureClinicConsents } from "./clinical-forms.js"
import { ensureClinicForms } from "./consultation-forms.js"
import { invalidField } from "./errors.js"
import { refreshSuggestedNotice, setUpNewClinic } from "./new-clinic.js"
import { initialOrgRegion, type UpdateOrgRegionInput, updateOrgRegion } from "./organization-profile.js"
import { ensureClinicSpecialties } from "./specialties.js"

export interface OrgIdentityInput {
  legalName?: string
  tradeName?: string
  fiscalDocType?: string | null
  fiscalDocNumber?: string | null
  fiscalAddress?: string | null
  emergencyPhone?: string | null
}

export type SaveOrgProfileInput = OrgIdentityInput &
  UpdateOrgRegionInput & {
    timezone?: string
    locale?: string
    /** Sin decirlo: al crear el perfil, sí; al cambiarlo, no. */
    applyCountryPreset?: boolean
  }

/**
 * Guarda los datos de la clínica. `product` es el de la clínica que nace (el dominio
 * donde se creó); si el perfil ya existe, no cambia.
 */
export async function saveOrgProfile(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: SaveOrgProfileInput,
  product: ClinicalProduct,
): Promise<typeof orgProfile.$inferSelect> {
  const [current] = await tx
    .select({ id: orgProfile.organizationId })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .for("update")
  const {
    countryCode,
    currency,
    timezone,
    locale,
    receiptWidth,
    sheetSize,
    ticketFooter,
    applyCountryPreset,
    taxes,
    secondCurrency,
    exchangeRate,
    budgetValidDays,
    ...identity
  } = input
  if (current) {
    await tx
        .update(orgProfile)
        .set({ ...identity, updatedAt: new Date() })
        .where(eq(orgProfile.organizationId, orgId))
  } else {
    if (!identity.legalName) throw invalidField("legalName", "Escribe la razón social")
    // El perfil nace con su región explícita: la base no asume ningún país. Y
    // con el producto del dominio donde se creó la clínica, que ya no cambia.
    await tx.insert(orgProfile).values({
      organizationId: orgId,
      product,
      ...identity,
      legalName: identity.legalName,
      ...initialOrgRegion({ countryCode, currency, timezone, locale, sheetSize }),
    })
  }
  const updated = await updateOrgRegion(tx, orgId, actorUserId, {
    countryCode,
    currency,
    timezone,
    locale,
    receiptWidth,
    sheetSize,
    ticketFooter,
    taxes,
    secondCurrency,
    exchangeRate,
    budgetValidDays,
    applyCountryPreset: applyCountryPreset ?? !current,
  })
  // Una clínica que nace (todavía sin ninguna sede, ni archivada) viene con todo encendido, a
  // nombre de quien la crea (ADR 0141, que sustituye al 0026). Vale también para el alta
  // asistida, cuyo perfil ya existía: allí antes no nacía ni «Recordar la cita».
  const [anyBranch] = await tx.select({ id: branch.id }).from(branch).where(eq(branch.organizationId, orgId)).limit(1)
  if (!anyBranch) await setUpNewClinic(tx, orgId, actorUserId)
  // Y su aviso sugerido, mientras nadie lo revisó, dice los datos nuevos (también si el alta
  // se repite antes de crear la sede).
  await refreshSuggestedNotice(tx, orgId, actorUserId)
  // Y nace con las especialidades de su país, que puede renombrar (ADR 0039 y 0069).
  if (!current) await ensureClinicSpecialties(tx, orgId)
  // Y con sus consentimientos activos, para firmar por la web desde el primer día.
  if (!current) await ensureClinicConsents(tx, orgId, actorUserId)
  // Y con las fichas de consulta de su producto, ya en uso (ADR 0117).
  if (!current) await ensureClinicForms(tx, orgId)
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "org_profile.upsert",
    entity: "org_profile",
    entityId: orgId,
    metadata: input,
  })
  return updated
}

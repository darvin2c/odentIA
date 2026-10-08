/**
 * Consentimiento para el tratamiento de datos personales (Ley 29733, ADR 0004):
 * por versión del aviso, con finalidades separadas, quién lo otorga y su
 * revocación. Revocar las comunicaciones da de baja los envíos comerciales.
 */
import type { Db } from "@odentia/db"
import { automationConsent } from "@odentia/db/schema/automation"
import { patient, patientContact, patientDataConsent } from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import { auditEvent, patientRegistrationConfig } from "@odentia/db/schema/org"
import { and, desc, eq } from "drizzle-orm"
import { setConsent } from "./automation.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { requirePatient } from "./patients.js"
import { requireDecisionContact } from "./responsibilities.js"

/** Atención (siempre), recordatorios de citas y controles, comunicaciones comerciales. */
export const DATA_CONSENT_PURPOSES = ["atencion", "recordatorios", "comunicaciones"] as const
export const DATA_CONSENT_CHANNELS = ["presencial", "formulario_publico", "portal"] as const

export type DataConsentRow = typeof patientDataConsent.$inferSelect

export async function listDataConsents(
  tx: Db,
  orgId: string,
  patientId: string,
): Promise<DataConsentRow[]> {
  await requirePatient(tx, orgId, patientId)
  return tx
    .select()
    .from(patientDataConsent)
    .where(
      and(
        eq(patientDataConsent.organizationId, orgId),
        eq(patientDataConsent.patientId, patientId),
      ),
    )
    .orderBy(desc(patientDataConsent.grantedAt))
}

export interface GrantDataConsentInput {
  purposes: string[]
  /** Quien otorga: el propio paciente o su representante legal vigente. */
  grantedByContactId: string
  channel?: string
}

export async function grantDataConsent(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: GrantDataConsentInput,
): Promise<DataConsentRow> {
  const person = await requirePatient(tx, orgId, patientId)
  const purposes = [...new Set(input.purposes)]
  if (!purposes.includes("atencion"))
    throw validation("La finalidad de atención es la base del consentimiento")
  for (const purpose of purposes)
    if (!(DATA_CONSENT_PURPOSES as readonly string[]).includes(purpose))
      throw validation(`Finalidad inválida: ${purpose}`)
  const channel = input.channel ?? "presencial"
  if (!(DATA_CONSENT_CHANNELS as readonly string[]).includes(channel))
    throw validation("Canal inválido")
  // Otorga el propio paciente o su representante legal vigente.
  const grantor = await requireDecisionContact(tx, orgId, patientId, input.grantedByContactId)
  const [config] = await tx
    .select({
      version: patientRegistrationConfig.version,
      privacyNotice: patientRegistrationConfig.privacyNotice,
    })
    .from(patientRegistrationConfig)
    .where(eq(patientRegistrationConfig.organizationId, orgId))
    .limit(1)
  if (!config?.privacyNotice)
    throw new ServiceError(
      "NOTICE_MISSING",
      409,
      "Publica el aviso de privacidad en la configuración del registro antes de registrar consentimientos",
    )
  const [row] = await tx
    .insert(patientDataConsent)
    .values({
      organizationId: orgId,
      patientId,
      noticeVersion: config.version,
      noticeText: config.privacyNotice,
      purposes,
      grantedByContactId: grantor.id,
      grantedByName: grantor.displayName,
      channel,
      recordedBy: actorUserId,
    })
    .returning()
  if (!row) throw new Error("No se pudo registrar el consentimiento")
  if (!person.dataConsentAt) {
    await tx
      .update(patient)
      .set({ dataConsentAt: row.grantedAt, dataConsentBy: actorUserId, updatedAt: new Date() })
      .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
  }
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "patient.data_consent_granted",
    entity: "patient_data_consent",
    entityId: row.id,
    metadata: { patientId, purposes, noticeVersion: config.version },
  })
  return row
}

export async function revokeDataConsent(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  consentId: string,
  input: { reason: string },
): Promise<DataConsentRow> {
  await requirePatient(tx, orgId, patientId)
  const reason = input.reason?.trim()
  if (!reason || reason.length > 2000) throw validation("El motivo debe tener 1–2000 caracteres")
  const [current] = await tx
    .select()
    .from(patientDataConsent)
    .where(
      and(
        eq(patientDataConsent.id, consentId),
        eq(patientDataConsent.organizationId, orgId),
        eq(patientDataConsent.patientId, patientId),
      ),
    )
    .for("update")
  if (!current) throw notFound("Consentimiento")
  if (current.revokedAt)
    throw new ServiceError("ALREADY_REVOKED", 409, "El consentimiento ya fue revocado")
  const [row] = await tx
    .update(patientDataConsent)
    .set({ revokedAt: new Date(), revokedBy: actorUserId, revokeReason: reason })
    .where(eq(patientDataConsent.id, consentId))
    .returning()
  // Revocar retira también el permiso comercial: se da de baja todo envío de
  // marketing a la persona del paciente y se cancelan los pendientes. Para
  // volver a recibirlos hace falta un consentimiento nuevo.
  const [own] = await tx
    .select({ contactId: patientContact.contactId })
    .from(patientContact)
    .innerJoin(
      contact,
      and(eq(contact.id, patientContact.contactId), eq(contact.organizationId, orgId)),
    )
    .where(
      and(
        eq(patientContact.organizationId, orgId),
        eq(patientContact.patientId, patientId),
        eq(patientContact.relationship, "self"),
      ),
    )
    .limit(1)
  if (own) {
    const marketing = await tx
      .select({ channel: automationConsent.channel })
      .from(automationConsent)
      .where(
        and(
          eq(automationConsent.organizationId, orgId),
          eq(automationConsent.contactId, own.contactId),
          eq(automationConsent.purpose, "marketing"),
          eq(automationConsent.status, "granted"),
        ),
      )
    for (const { channel } of marketing) {
      await setConsent(tx, orgId, actorUserId, own.contactId, {
        purpose: "marketing",
        channel,
        granted: false,
        source: "revocacion_datos",
      })
    }
  }
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "patient.data_consent_revoked",
    entity: "patient_data_consent",
    entityId: consentId,
    metadata: { patientId, reason },
  })
  if (!row) throw notFound("Consentimiento")
  return row
}

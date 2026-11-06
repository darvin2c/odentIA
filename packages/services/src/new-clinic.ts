/**
 * Una clínica nueva nace con todo encendido (decisión del 2026-11-05; ADR
 * 0141, que sustituye al 0026): Sofi, Argos y Clío; todas las líneas de Argos;
 * el registro de pacientes con un aviso de privacidad sugerido, sin revisar; el
 * portal con todo su alcance; y el resumen del lunes de quien la crea.
 *
 * - Cada cosa se enciende con la misma operación que usaría una persona, a
 *   nombre de quien crea la clínica y con su registro en Actividad del equipo.
 * - Solo se toca lo que aún no tiene estado: repetir el alta no cambia lo que
 *   alguien ya decidió, y una clínica que ya existía no cambia.
 * - No cambia ningún valor por defecto de la base ni del código: «sin fila =
 *   apagado» sigue valiendo para las clínicas de antes.
 * - El presupuesto del mes nace con la cuota del plan (`setNewClinicSpendCap`).
 * - Siguen apagados, a propósito: la verificación en dos pasos obligatoria
 *   (bloquearía el alta, ADR 0107) y «Sumar solas» las preguntas a Argos
 *   (gastaría sin preguntar, ADR 0085).
 */
import { DEFAULT_REGISTRATION_CONFIG } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { agentConfig } from "@odentia/db/schema/crm"
import { auditEvent, patientRegistrationConfig } from "@odentia/db/schema/org"
import { portalPolicy } from "@odentia/db/schema/portal-access"
import { reportDigest } from "@odentia/db/schema/reports"
import { and, eq } from "drizzle-orm"
import { ADMIN_LINES } from "./admin-lines.js"
import { updateAdminSettings } from "./agent-admin.js"
import { upsertAgentConfig } from "./agentConfig.js"
import { turnOnNewClinicLines } from "./automation.js"
import { savePatientRegistrationConfig } from "./patient-registration.js"
import { noticeClinic, suggestedPrivacyNotice } from "./privacy-notice.js"
import { upsertPortalPolicy } from "./portal-policy.js"
import { setReportDigest } from "./report-digest.js"
import { setNewClinicSpendCap } from "./saas-billing.js"

export { suggestedPrivacyNotice, type SuggestedNoticeClinic } from "./privacy-notice.js"

async function audit(tx: Db, orgId: string, actorUserId: string, action: string, metadata: Record<string, unknown>) {
  await tx.insert(auditEvent).values({ organizationId: orgId, actorUserId, action, entity: "organization", entityId: orgId, metadata })
}

/** El registro de cada aviso sugerido que se publica, en Actividad del equipo. */
export const SUGGESTED_NOTICE_ACTION = "patient-registration.notice_suggested"

/**
 * Mientras el aviso siga siendo el sugerido, sin revisar, se vuelve a armar si cambian los datos
 * de la clínica (razón social, RUC, dirección). Se llama al guardar sus datos.
 */
export async function refreshSuggestedNotice(tx: Db, orgId: string, actorUserId: string): Promise<void> {
  const [row] = await tx.select().from(patientRegistrationConfig).where(eq(patientRegistrationConfig.organizationId, orgId)).limit(1)
  if (!row?.noticeSuggestedAt) return
  const clinic = await noticeClinic(tx, orgId)
  if (!clinic) return
  const notice = suggestedPrivacyNotice(clinic)
  if (notice === row.privacyNotice) return
  await savePatientRegistrationConfig(tx, orgId, actorUserId, {
    expectedVersion: row.version,
    enabled: row.enabled,
    fields: { ...DEFAULT_REGISTRATION_CONFIG.fields, ...row.fields },
    privacyNotice: notice,
    suggested: true,
  })
  await audit(tx, orgId, actorUserId, SUGGESTED_NOTICE_ACTION, { refreshed: true })
}

/**
 * Enciende lo de una clínica que nace. Se llama al terminar el alta, mientras
 * aún no tiene ninguna sede (en los dos caminos: registro propio y alta
 * asistida), a nombre de la dueña.
 */
export async function setUpNewClinic(tx: Db, orgId: string, actorUserId: string): Promise<void> {
  // Todas las líneas de Argos (las del catálogo; las propias las arma la clínica).
  await turnOnNewClinicLines(
    tx,
    orgId,
    actorUserId,
    ADMIN_LINES.map((line) => line.key),
  )

  // Sofi, Clío y Argos: una sola fila de ajustes; si ya existe, alguien ya decidió.
  const [agent] = await tx.select({ id: agentConfig.organizationId }).from(agentConfig).where(eq(agentConfig.organizationId, orgId)).limit(1)
  if (!agent) {
    await upsertAgentConfig(tx, orgId, { enabled: true, clinicalAssistantEnabled: true }, { actorUserId })
    await updateAdminSettings(tx, orgId, actorUserId, { enabled: true })
  }

  // El registro de pacientes en línea, con el aviso sugerido sin revisar.
  const [registration] = await tx
    .select({ id: patientRegistrationConfig.organizationId })
    .from(patientRegistrationConfig)
    .where(eq(patientRegistrationConfig.organizationId, orgId))
    .limit(1)
  if (!registration) {
    const clinic = await noticeClinic(tx, orgId)
    if (clinic) {
      await savePatientRegistrationConfig(tx, orgId, actorUserId, {
        expectedVersion: 0,
        enabled: true,
        fields: { ...DEFAULT_REGISTRATION_CONFIG.fields },
        privacyNotice: suggestedPrivacyNotice(clinic),
        suggested: true,
      })
      await audit(tx, orgId, actorUserId, SUGGESTED_NOTICE_ACTION, {})
    }
  }

  // El portal, con todo su alcance: el acceso sigue siendo por persona y en persona.
  const [portal] = await tx.select({ id: portalPolicy.organizationId }).from(portalPolicy).where(eq(portalPolicy.organizationId, orgId)).limit(1)
  if (!portal) {
    await upsertPortalPolicy(tx, orgId, actorUserId, {
      enabled: true,
      allowedScope: { appointments: true, budgets: true, account: true, documents: true },
    })
    await audit(tx, orgId, actorUserId, "portal.default_on", {})
  }

  // El resumen del lunes, solo de quien crea la clínica (los demás lo piden).
  const [digest] = await tx
    .select({ id: reportDigest.userId })
    .from(reportDigest)
    .where(and(eq(reportDigest.organizationId, orgId), eq(reportDigest.userId, actorUserId)))
    .limit(1)
  if (!digest) {
    await setReportDigest(tx, orgId, actorUserId, true)
    await audit(tx, orgId, actorUserId, "report_digest.default_on", {})
  }

  // Con todo encendido, lo que hacen los agentes no gasta más que la cuota del plan sin que la
  // clínica lo decida: el presupuesto del mes nace con ella (se cambia en Plan y pagos).
  await setNewClinicSpendCap(tx, orgId, actorUserId)
}

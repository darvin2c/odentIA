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
 * - Siguen apagados, a propósito: la verificación en dos pasos obligatoria
 *   (bloquearía el alta, ADR 0107) y «Sumar solas» las preguntas a Argos
 *   (gastaría sin preguntar, ADR 0085).
 */
import { DEFAULT_REGISTRATION_CONFIG } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { agentConfig } from "@odentia/db/schema/crm"
import { auditEvent, orgProfile, patientRegistrationConfig } from "@odentia/db/schema/org"
import { portalPolicy } from "@odentia/db/schema/portal-access"
import { reportDigest } from "@odentia/db/schema/reports"
import { and, eq } from "drizzle-orm"
import { ADMIN_LINES } from "./admin-lines.js"
import { updateAdminSettings } from "./agent-admin.js"
import { upsertAgentConfig } from "./agentConfig.js"
import { findLineRule, setLine } from "./automation.js"
import { savePatientRegistrationConfig } from "./patient-registration.js"
import { upsertPortalPolicy } from "./portal-policy.js"
import { setReportDigest } from "./report-digest.js"

async function audit(tx: Db, orgId: string, actorUserId: string, action: string, metadata: Record<string, unknown>) {
  await tx.insert(auditEvent).values({ organizationId: orgId, actorUserId, action, entity: "organization", entityId: orgId, metadata })
}

/**
 * El aviso de privacidad sugerido, con los datos de la clínica. Lo publica
 * marcado «Sin revisar»: la clínica es la responsable de lo que dice y lo
 * revisa en Configuración › Registro de pacientes. No afirma cumplir ninguna
 * ley: dice para qué se usan los datos y cómo pedir verlos o corregirlos.
 */
export function suggestedPrivacyNotice(clinic: { legalName: string; tradeName: string | null; fiscalDocNumber: string | null }): string {
  const name = clinic.tradeName?.trim() || clinic.legalName.trim()
  const who =
    clinic.legalName.trim() && clinic.legalName.trim() !== name
      ? `${name} (${clinic.legalName.trim()}${clinic.fiscalDocNumber ? `, ${clinic.fiscalDocNumber}` : ""})`
      : `${name}${clinic.fiscalDocNumber ? ` (${clinic.fiscalDocNumber})` : ""}`
  return [
    `${who} usará tus datos solo para registrarte como paciente, atenderte, recordarte tus citas y cobrarte lo atendido.`,
    "No los vende ni los comparte con otros fines.",
    "Puedes pedir verlos, corregirlos o eliminarlos, o que dejen de usarse para algo, escribiendo a la clínica o en recepción.",
  ].join(" ")
}

/** El registro del aviso sugerido: así Configuración sabe que nadie de la clínica lo revisó aún. */
export const SUGGESTED_NOTICE_ACTION = "patient-registration.notice_suggested"

/**
 * Enciende lo de una clínica que nace. Se llama al terminar el alta, mientras
 * aún no tiene ninguna sede (en los dos caminos: registro propio y alta
 * asistida), a nombre de la dueña.
 */
export async function setUpNewClinic(tx: Db, orgId: string, actorUserId: string): Promise<void> {
  // Todas las líneas de Argos (las del catálogo; las propias las arma la clínica).
  for (const line of ADMIN_LINES) {
    if (await findLineRule(tx, orgId, line.key)) continue
    const rule = await setLine(tx, orgId, actorUserId, line.key, { enabled: true })
    await tx.insert(auditEvent).values({
      organizationId: orgId,
      actorUserId,
      action: "admin_line.default_on",
      entity: "automation_rule",
      entityId: rule.id,
      metadata: { key: line.key },
    })
  }

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
    const [profile] = await tx
      .select({ legalName: orgProfile.legalName, tradeName: orgProfile.tradeName, fiscalDocNumber: orgProfile.fiscalDocNumber })
      .from(orgProfile)
      .where(eq(orgProfile.organizationId, orgId))
      .limit(1)
    if (profile) {
      await savePatientRegistrationConfig(tx, orgId, actorUserId, {
        expectedVersion: 0,
        enabled: true,
        fields: { ...DEFAULT_REGISTRATION_CONFIG.fields },
        privacyNotice: suggestedPrivacyNotice(profile),
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
}

import type { Db } from "@odentia/db"
import {
  automationConsent,
  automationJob,
  automationRule,
} from "@odentia/db/schema/automation"
import { and, eq } from "drizzle-orm"

/**
 * Semilla determinista de automatizaciones (idempotente): reglas base
 * DESACTIVADAS y opt-in del contacto principal. Nunca programa trabajos
 * pendientes y ninguna regla queda habilitada, así el worker no dispara
 * envíos desde datos de prueba.
 */
export async function seedAutomation(
  tx: Db,
  input: { orgId: string; ownerUserId: string; contactId: string },
): Promise<void> {
  const { orgId, ownerUserId, contactId } = input
  const existing = await tx
    .select({ id: automationRule.id })
    .from(automationRule)
    .where(and(eq(automationRule.organizationId, orgId), eq(automationRule.kind, "recordatorio_cita")))
    .limit(1)
  if (existing.length === 0) {
    await tx.insert(automationRule).values([
      {
        organizationId: orgId,
        name: "Recordatorio de cita 24h y 3h",
        kind: "recordatorio_cita",
        channel: "whatsapp",
        enabled: false,
        templateName: null,
        templateLanguage: "es_PE",
        config: { hoursBefore: [24, 3], quietStart: "21:00", quietEnd: "08:00" },
        createdBy: ownerUserId,
      },
      {
        organizationId: orgId,
        name: "Seguimiento de presupuesto 48h",
        kind: "seguimiento_presupuesto",
        channel: "whatsapp",
        enabled: false,
        templateName: null,
        templateLanguage: "es_PE",
        config: { delayHours: 48, quietStart: "21:00", quietEnd: "08:00" },
        createdBy: ownerUserId,
      },
      {
        organizationId: orgId,
        name: "Recuperación de inactivos",
        kind: "recuperacion_inactivo",
        channel: "whatsapp",
        enabled: false,
        templateName: null,
        templateLanguage: "es_PE",
        config: { inactiveDays: 180, quietStart: "21:00", quietEnd: "08:00" },
        createdBy: ownerUserId,
      },
    ])
  }
  for (const purpose of ["recordatorio", "seguimiento"] as const) {
    await tx
      .insert(automationConsent)
      .values({
        organizationId: orgId,
        contactId,
        purpose,
        channel: "whatsapp",
        status: "granted",
        source: "semilla",
        createdBy: ownerUserId,
      })
      .onConflictDoNothing({
        target: [
          automationConsent.organizationId,
          automationConsent.contactId,
          automationConsent.purpose,
          automationConsent.channel,
        ],
      })
  }
  // Limpieza defensiva: la semilla nunca deja trabajos pendientes que el worker enviaría.
  await tx
    .delete(automationJob)
    .where(and(eq(automationJob.organizationId, orgId), eq(automationJob.status, "pendiente")))
}

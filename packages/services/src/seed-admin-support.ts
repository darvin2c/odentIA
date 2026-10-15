import type { Db } from "@odentia/db"
import { supportAccessGrant, supportCase, supportMessage } from "@odentia/db/schema/admin-support"

/**
 * Semilla de soporte (dev, datos ficticios): un caso abierto con
 * conversación, nota interna y permiso revocado en historia, y un caso
 * resuelto. Idempotente por ids fijos; recibe org y usuarios existentes.
 */
export async function seedAdminSupport(
  db: Db,
  input: { organizationId: string; userId: string; staffUserId: string },
): Promise<void> {
  const { organizationId, userId, staffUserId } = input
  const openCaseId = "00000000-0000-4000-8000-00000000c501"
  const resolvedCaseId = "00000000-0000-4000-8000-00000000c502"
  await db
    .insert(supportCase)
    .values([
      {
        id: openCaseId,
        organizationId,
        kind: "pregunta",
        question: "¿Dónde se configuran los recordatorios de citas?",
        screen: "/settings",
        role: "Administrador",
        appVersion: "0.0.0-dev",
        dedupeKey: "seed-dedupe-recordatorios",
        status: "en_atencion",
        assigneeStaffId: staffUserId,
        openedBy: userId,
      },
      {
        id: resolvedCaseId,
        organizationId,
        kind: "problema",
        question: "El ticket sale sin el nombre de la clínica",
        screen: "/cash",
        role: "Caja",
        appVersion: "0.0.0-dev",
        dedupeKey: "seed-dedupe-ticket",
        status: "resuelto",
        openedBy: userId,
        resolvedAt: new Date("2026-01-10T12:00:00Z"),
      },
    ])
    .onConflictDoNothing({ target: supportCase.id })
  await db
    .insert(supportMessage)
    .values([
      {
        id: "00000000-0000-4000-8000-00000000c511",
        caseId: openCaseId,
        organizationId,
        authorKind: "staff",
        authorUserId: staffUserId,
        body: "Hola: se configuran en Configuración → Mensajes de la clínica, pestaña Recordatorios.",
      },
      {
        id: "00000000-0000-4000-8000-00000000c512",
        caseId: openCaseId,
        organizationId,
        authorKind: "staff",
        authorUserId: staffUserId,
        body: "Revisar si la sede tiene horario para que el recordatorio tome la hora correcta.",
        isInternal: true,
      },
      {
        id: "00000000-0000-4000-8000-00000000c521",
        caseId: resolvedCaseId,
        organizationId,
        authorKind: "staff",
        authorUserId: staffUserId,
        body: "Listo: el nombre comercial ahora sale en el ticket. Avísanos si ves otro dato incompleto.",
      },
    ])
    .onConflictDoNothing({ target: supportMessage.id })

  // Permiso revocado: muestra la historia sin activar facultades.
  await db
    .insert(supportAccessGrant)
    .values({
      id: "00000000-0000-4000-8000-00000000c531",
      caseId: openCaseId,
      organizationId,
      grantedBy: userId,
      scope: "diagnostico",
      createdAt: new Date("2026-01-09T12:00:00Z"),
      expiresAt: new Date("2026-01-09T12:30:00Z"),
      revokedAt: new Date("2026-01-09T12:10:00Z"),
    })
    .onConflictDoNothing({ target: supportAccessGrant.id })
}

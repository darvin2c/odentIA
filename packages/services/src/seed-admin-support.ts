import type { Db } from "@odentia/db"
import { supportAccessGrant, supportCase, supportMessage, supportNotice } from "@odentia/db/schema/admin-support"

/**
 * Semilla de soporte (dev, datos ficticios): un caso en atención con una
 * respuesta que la clínica aún no vio (el botón de Ayuda la cuenta), nota
 * interna y permiso revocado en historia; un caso resuelto, y una pregunta
 * recién enviada. Avisos por correo: los del caso en atención ya salieron
 * («Caso nuevo» a soporte y «Soporte de odentIA respondió tu caso» a quien
 * preguntó); el de la pregunta nueva está pendiente y lo envía el worker a
 * Mailpit. Idempotente por ids fijos; recibe org y usuarios existentes.
 */
export async function seedAdminSupport(
  db: Db,
  input: { organizationId: string; userId: string; staffUserId: string },
): Promise<void> {
  const { organizationId, userId, staffUserId } = input
  const openCaseId = "00000000-0000-4000-8000-00000000c501"
  const resolvedCaseId = "00000000-0000-4000-8000-00000000c502"
  const newCaseId = "00000000-0000-4000-8000-00000000c503"
  const now = Date.now()
  const answeredAt = new Date(now - 2 * 3_600_000)
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
        createdAt: new Date(now - 3 * 3_600_000),
        lastPublicMessageAt: answeredAt,
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
      {
        id: newCaseId,
        organizationId,
        kind: "pregunta",
        question: "¿Cómo exporto mis pacientes a Excel?",
        screen: "/patients",
        role: "Propietario",
        appVersion: "0.0.0-dev",
        dedupeKey: "seed-dedupe-exportar-pacientes",
        status: "abierto",
        openedBy: userId,
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
        createdAt: answeredAt,
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

  // Avisos por correo: dos ya enviados y uno pendiente. La clave del aviso a
  // quien preguntó es la que usa el worker: no se vuelve a enviar.
  await db
    .insert(supportNotice)
    .values([
      {
        id: "00000000-0000-4000-8000-00000000c541",
        caseId: openCaseId,
        organizationId,
        kind: "caso_nuevo",
        recipientUserId: null,
        dedupeKey: `caso_nuevo:${openCaseId}`,
        emailState: "enviado",
        emailedAt: new Date(now - 3 * 3_600_000),
        createdAt: new Date(now - 3 * 3_600_000),
      },
      {
        id: "00000000-0000-4000-8000-00000000c542",
        caseId: openCaseId,
        organizationId,
        kind: "respuesta",
        recipientUserId: userId,
        dedupeKey: `persona:${openCaseId}:${answeredAt.getTime()}`,
        emailState: "enviado",
        emailedAt: new Date(answeredAt.getTime() + 15 * 60_000),
        createdAt: new Date(answeredAt.getTime() + 15 * 60_000),
      },
      {
        id: "00000000-0000-4000-8000-00000000c543",
        caseId: newCaseId,
        organizationId,
        kind: "caso_nuevo",
        recipientUserId: null,
        dedupeKey: `caso_nuevo:${newCaseId}`,
      },
    ])
    .onConflictDoNothing()
}

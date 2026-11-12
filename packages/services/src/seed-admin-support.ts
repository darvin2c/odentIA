import type { Db } from "@odentia/db"
import {
  supportAccessGrant,
  supportCase,
  supportGuideGap,
  supportMessage,
  supportNotice,
} from "@odentia/db/schema/admin-support"
import { member } from "@odentia/db/schema/auth"
import { and, asc, eq, inArray } from "drizzle-orm"

/**
 * Semilla de soporte (dev, datos ficticios): un caso en atención con una
 * respuesta que la clínica aún no vio (el botón de Ayuda la cuenta), nota
 * interna y permiso revocado en historia; un caso resuelto, y una pregunta
 * recién enviada. Además, un caso que abrió recepción y espera a la clínica
 * porque soporte pidió el acceso de diagnóstico (lo autoriza la propietaria o
 * un administrador), y uno resuelto marcado «Falta en la guía». Avisos por
 * correo: los del caso en atención y los del pedido de acceso ya salieron
 * («Caso nuevo» a soporte, «Soporte de odentIA respondió tu caso» y «necesita
 * algo» a quien corresponde); el de la pregunta nueva está pendiente y lo
 * envía el worker a Mailpit. Idempotente por ids fijos; recibe org y usuarios
 * existentes.
 */
export async function seedAdminSupport(
  db: Db,
  input: { organizationId: string; userId: string; staffUserId: string },
): Promise<void> {
  const { organizationId, userId, staffUserId } = input
  const openCaseId = "00000000-0000-4000-8000-00000000c501"
  const resolvedCaseId = "00000000-0000-4000-8000-00000000c502"
  const newCaseId = "00000000-0000-4000-8000-00000000c503"
  const accessCaseId = "00000000-0000-4000-8000-00000000c504"
  const guideCaseId = "00000000-0000-4000-8000-00000000c505"
  const now = Date.now()
  const answeredAt = new Date(now - 2 * 3_600_000)
  const accessAskedAt = new Date(now - 4 * 3_600_000)
  const guideAnsweredAt = new Date(now - 26 * 3_600_000)
  // Quien atiende en recepción, y quienes autorizan el acceso: la propietaria y los administradores.
  const team = await db
    .select({ userId: member.userId, role: member.role })
    .from(member)
    .where(
      and(
        eq(member.organizationId, organizationId),
        inArray(member.role, ["reception", "owner", "admin"]),
      ),
    )
    .orderBy(asc(member.createdAt))
  const receptionUserId = team.find((row) => row.role === "reception")?.userId ?? null
  const granterIds = team.filter((row) => row.role !== "reception").map((row) => row.userId)
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
      // Su respuesta no está en la Ayuda: soporte lo marcó para llevarlo a la guía.
      {
        id: guideCaseId,
        organizationId,
        kind: "pregunta",
        question: "El ticket me sale con un margen blanco a los lados",
        screen: "/finance",
        role: "Propietario",
        appVersion: "0.0.0-dev",
        dedupeKey: "seed-dedupe-margen-ticket",
        status: "resuelto",
        assigneeStaffId: staffUserId,
        openedBy: userId,
        createdAt: new Date(now - 30 * 3_600_000),
        lastPublicMessageAt: guideAnsweredAt,
        clientSeenAt: new Date(guideAnsweredAt.getTime() + 20 * 60_000),
        resolvedAt: new Date(guideAnsweredAt.getTime() + 30 * 60_000),
      },
      // Lo abrió recepción; soporte pidió el acceso de diagnóstico y espera a que lo autoricen.
      ...(receptionUserId
        ? [
            {
              id: accessCaseId,
              organizationId,
              kind: "problema",
              question: "Sofi no responde por WhatsApp desde esta mañana",
              detail:
                "Los pacientes escriben al WhatsApp de la clínica y Sofi no les contesta desde las 9.",
              screen: "/inbox",
              role: "Recepción",
              appVersion: "0.0.0-dev",
              dedupeKey: "seed-dedupe-sofi-whatsapp",
              status: "esperando_clinica",
              assigneeStaffId: staffUserId,
              openedBy: receptionUserId,
              createdAt: new Date(now - 5 * 3_600_000),
              lastPublicMessageAt: accessAskedAt,
              accessRequestedAt: accessAskedAt,
              // Pide mirar como recepción, 30 minutos: la clínica lo confirma o lo cambia.
              accessRequestedRole: "reception",
              accessRequestedMinutes: 30,
              accessRequestedBy: staffUserId,
            },
          ]
        : []),
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
      {
        id: "00000000-0000-4000-8000-00000000c551",
        caseId: guideCaseId,
        organizationId,
        authorKind: "staff",
        authorUserId: staffUserId,
        body: "Es la ventana de imprimir del navegador: en «Más opciones», elige los márgenes «Ninguno». Así el ticket usa todo el ancho del papel.",
        createdAt: guideAnsweredAt,
      },
      ...(receptionUserId
        ? [
            {
              id: "00000000-0000-4000-8000-00000000c561",
              caseId: accessCaseId,
              organizationId,
              authorKind: "staff",
              authorUserId: staffUserId,
              body: "Para ver qué le pasa al WhatsApp necesitamos mirar tu clínica como Recepción, 30 minutos, sin cambiar nada. Lo autoriza la propietaria o un administrador de la clínica: ya ven este caso en Ayuda, en «Tus casos con soporte». Pueden cambiar el rol o el tiempo, y quitarlo cuando quieran.",
              createdAt: accessAskedAt,
            },
          ]
        : []),
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
      revokedBy: userId,
      endReason: "quitado",
    })
    .onConflictDoNothing({ target: supportAccessGrant.id })

  // «Falta en la guía»: la marca del equipo, de ayer.
  await db
    .insert(supportGuideGap)
    .values({
      caseId: guideCaseId,
      markedBy: staffUserId,
      markedAt: new Date(guideAnsweredAt.getTime() + 25 * 60_000),
    })
    .onConflictDoNothing({ target: supportGuideGap.caseId })

  // Avisos por correo: los ya enviados y uno pendiente. Las claves son las que usa el
  // worker: no se vuelven a enviar.
  const sentAfterAsking = new Date(accessAskedAt.getTime() + 15 * 60_000)
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
      ...(receptionUserId
        ? [
            {
              id: "00000000-0000-4000-8000-00000000c544",
              caseId: accessCaseId,
              organizationId,
              kind: "caso_nuevo",
              recipientUserId: null,
              dedupeKey: `caso_nuevo:${accessCaseId}`,
              emailState: "enviado",
              emailedAt: new Date(now - 5 * 3_600_000),
              createdAt: new Date(now - 5 * 3_600_000),
            },
            // «necesita algo» a quien lo abrió y a cada una de quienes pueden autorizar.
            ...[null, ...granterIds.filter((id) => id !== receptionUserId)].map((granterId) => ({
              caseId: accessCaseId,
              organizationId,
              kind: "necesita_algo",
              recipientUserId: granterId ?? receptionUserId,
              dedupeKey: `persona:${accessCaseId}:${accessAskedAt.getTime()}${granterId ? `:${granterId}` : ""}`,
              emailState: "enviado",
              emailedAt: sentAfterAsking,
              createdAt: sentAfterAsking,
            })),
          ]
        : []),
    ])
    .onConflictDoNothing()
}

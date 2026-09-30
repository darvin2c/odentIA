import type { Db } from "@odentia/db"
import { agentHandoff, agentKnowledgeEntry, agentKnowledgeRevision, agentPolicy, agentProposal, agentRunLedger } from "@odentia/db/schema/agent"
import { appointment, scheduleChair } from "@odentia/db/schema/agenda"
import { patientContact } from "@odentia/db/schema/clinical"
import { conversation } from "@odentia/db/schema/crm"
import { and, asc, eq, gt } from "drizzle-orm"

/** Hora local de Lima (UTC-5 fijo en la semilla) → instante ISO, como en seed-dev. */
const lima = (dayOffset: number, hhmm: string): string => {
  const base = new Date()
  base.setUTCDate(base.getUTCDate() + dayOffset)
  return `${base.toISOString().slice(0, 10)}T${hhmm}:00-05:00`
}

/**
 * Seed del dominio IA: FAQs publicadas deterministas, una en borrador y la
 * política de autonomía por defecto. Idempotente por ids fijos.
 */
export async function seedAgent(
  tx: Db,
  input: { orgId: string; ownerUserId: string; branchId: string; patientId: string; contactId: string },
): Promise<void> {
  const { orgId, ownerUserId, branchId } = input
  const entries = [
    {
      id: "00000000-0000-4000-8000-00000000a601",
      kind: "faq",
      title: "¿Atienden sin cita?",
      body: "Sí, atendemos urgencias sin cita según disponibilidad del día. Para el resto de tratamientos pide tu cita por este chat o en recepción.",
      branchId: null as string | null,
      status: "publicada",
    },
    {
      id: "00000000-0000-4000-8000-00000000a602",
      kind: "faq",
      title: "¿Qué medios de pago aceptan?",
      body: "Aceptamos efectivo, tarjeta, transferencia, Yape y Plin. El detalle de tu tratamiento y su tarifa se confirman en la clínica antes de atenderte.",
      branchId: null,
      status: "publicada",
    },
    {
      id: "00000000-0000-4000-8000-00000000a603",
      kind: "info_sede",
      title: "Horario de atención",
      body: "Coordinar el horario exacto con la sede antes de publicarlo.",
      branchId,
      status: "borrador",
    },
  ]
  for (const entry of entries) {
    await tx
      .insert(agentKnowledgeEntry)
      .values({
        id: entry.id,
        organizationId: orgId,
        kind: entry.kind,
        title: entry.title,
        body: entry.body,
        branchId: entry.branchId,
        status: entry.status,
        version: 1,
        createdBy: ownerUserId,
      })
      .onConflictDoNothing({ target: agentKnowledgeEntry.id })
    await tx
      .insert(agentKnowledgeRevision)
      .values({
        organizationId: orgId,
        entryId: entry.id,
        version: 1,
        title: entry.title,
        body: entry.body,
        createdBy: ownerUserId,
      })
      .onConflictDoNothing({ target: [agentKnowledgeRevision.entryId, agentKnowledgeRevision.version] })
  }
  await tx
    .insert(agentPolicy)
    .values({ organizationId: orgId, modes: {
      enviar_mensaje: "aprobar_equipo", mover_oportunidad: "aprobar_equipo",
      crear_oportunidad: "aprobar_equipo", actualizar_seguimiento: "aprobar_equipo",
      cerrar_oportunidad: "aprobar_equipo",
    }, updatedBy: ownerUserId })
    .onConflictDoNothing({ target: agentPolicy.organizationId })

  // Propuestas pendientes, derivación y corridas para el home y el pulso en
  // dev. Idempotente por ids fijos; sin conversación semilla no hay nada que
  // sembrar en este bloque. Las propuestas se insertan directo como filas
  // legado (sin expected_state: nunca son stale y el antes no se reconstruye).
  const convs = await tx
    .select({ id: conversation.id, contactId: conversation.contactId })
    .from(conversation)
    .where(eq(conversation.organizationId, orgId))
    .limit(2)
  const first = convs[0]
  if (first) {
    // Referencias reales para que aprobar la propuesta en dev ejecute de
    // verdad: sillón de la sede y una cita futura programada (su versión se
    // lee aquí porque el seed purga y recrea la org en cada ejecución).
    const [chair] = await tx
      .select({ id: scheduleChair.id })
      .from(scheduleChair)
      .where(and(eq(scheduleChair.organizationId, orgId), eq(scheduleChair.branchId, branchId)))
      .limit(1)
    const [futureAppointment] = await tx
      .select({ id: appointment.id, version: appointment.version, patientId: appointment.patientId })
      .from(appointment)
      .where(
        and(
          eq(appointment.organizationId, orgId),
          eq(appointment.status, "programada"),
          gt(appointment.startsAt, new Date()),
        ),
      )
      .orderBy(asc(appointment.startsAt))
      .limit(1)
    // La ejecución exige que el contacto de la propuesta esté vinculado al
    // paciente de la cita: se usa su contacto self (si existe).
    const [selfContact] = futureAppointment
      ? await tx
          .select({ contactId: patientContact.contactId })
          .from(patientContact)
          .where(
            and(
              eq(patientContact.organizationId, orgId),
              eq(patientContact.patientId, futureAppointment.patientId),
              eq(patientContact.relationship, "self"),
            ),
          )
          .limit(1)
      : []
    const proposals = [
      {
        id: "00000000-0000-4000-8000-00000000a611",
        conversationId: first.id,
        contactId: input.contactId,
        action: "reservar_cita",
        payload: {
          patientId: input.patientId,
          branchId,
          dentistUserId: ownerUserId,
          chairId: chair?.id,
          durationMin: 30,
          startsAt: lima(2, "15:00"),
        },
        idempotencyKey: "seed:agent:propuesta:1",
      },
      ...(futureAppointment
        ? [
              {
                id: "00000000-0000-4000-8000-00000000a612",
                conversationId: (convs[1] ?? first).id,
                contactId: selfContact?.contactId ?? null,
                action: "reprogramar_cita",
                payload: {
                  appointmentId: futureAppointment.id,
                  expectedVersion: futureAppointment.version,
                  startsAt: lima(3, "16:00"),
                },
                // Evidencia real como la que congela createProposal: sin ella
                // la propuesta no sería ejecutable (nunca vigente falsa).
                expectedState: {
                  appointmentId: futureAppointment.id,
                  appointmentVersion: futureAppointment.version,
                  appointmentStatus: "programada",
                },
                idempotencyKey: "seed:agent:propuesta:2",
              },
            ]
        : []),
    ]
    for (const proposal of proposals) {
      await tx.insert(agentProposal).values({ organizationId: orgId, ...proposal }).onConflictDoNothing({ target: agentProposal.id })
    }
    await tx
      .insert(agentHandoff)
      .values({
        id: "00000000-0000-4000-8000-00000000a620",
        organizationId: orgId,
        conversationId: first.id,
        contactId: first.contactId,
        reason: "La persona pide hablar con un humano",
        summary: "Derivación semilla: la persona prefiere atención humana para su cita.",
        priority: "media",
        createdBy: "agent",
      })
      .onConflictDoNothing({ target: agentHandoff.id })
    // Corridas de los últimos 30 días con mezcla ok/handoff/error.
    const statuses = ["ok", "ok", "handoff", "ok", "error", "ok", "handoff"] as const
    for (let n = 0; n < 30; n++) {
      const startedAt = new Date(Date.now() - n * 86_400_000)
      await tx
        .insert(agentRunLedger)
        .values({
          id: `00000000-0000-4000-8000-00000000c0${String(n).padStart(2, "0")}`,
          organizationId: orgId,
          conversationId: first.id,
          model: "seed-dev",
          status: statuses[n % statuses.length]!,
          startedAt,
          endedAt: new Date(startedAt.getTime() + 1500),
          latencyMs: 1500,
        })
        .onConflictDoNothing({ target: agentRunLedger.id })
    }
  }
}

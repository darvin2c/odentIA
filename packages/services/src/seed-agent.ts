import type { Db } from "@odentia/db"
import { agentAnswerTrace, agentCaseMemory, agentDecisionLog, agentHandoff, agentKnowledgeEntry, agentKnowledgeGap, agentKnowledgeRevision, agentLesson, agentPersonFact, agentPolicy, agentProposal, agentReviewItem, agentRunLedger, agentTestCase } from "@odentia/db/schema/agent"
import { appointment, scheduleChair } from "@odentia/db/schema/agenda"
import { patientContact } from "@odentia/db/schema/clinical"
import { conversation, message } from "@odentia/db/schema/crm"
import { helpRequest } from "@odentia/db/schema/workspace"
import { and, asc, desc, eq, gt } from "drizzle-orm"
import { updateAdvisorSettings } from "./agent-advisor.js"
import { upsertAgentConfig } from "./agentConfig.js"

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
      askForms: ["¿Puedo ir sin reservar?"],
      basicKey: "sin_cita" as string | null,
      validUntil: null as string | null,
    },
    {
      id: "00000000-0000-4000-8000-00000000a602",
      kind: "faq",
      title: "¿Qué medios de pago aceptan?",
      body: "Aceptamos efectivo, tarjeta, transferencia, Yape y Plin. El detalle de tu tratamiento y su tarifa se confirman en la clínica antes de atenderte.",
      branchId: null,
      status: "publicada",
      askForms: ["¿Puedo pagar con Yape?", "¿Aceptan tarjeta?"],
      basicKey: "medios_pago",
      validUntil: null,
    },
    {
      id: "00000000-0000-4000-8000-00000000a603",
      kind: "info_sede",
      title: "Horario de atención",
      body: "Coordinar el horario exacto con la sede antes de publicarlo.",
      branchId,
      status: "borrador",
      askForms: [],
      basicKey: "horario",
      validUntil: null,
    },
    {
      // Publicada pero vencida: se ve en Conocimiento como «Vencida» y el agente ya no la usa.
      id: "00000000-0000-4000-8000-00000000a604",
      kind: "faq",
      title: "Campaña de limpieza de invierno",
      body: "Limpieza dental con evaluación incluida durante la campaña.",
      branchId: null,
      status: "publicada",
      askForms: [],
      basicKey: null,
      validUntil: new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10),
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
        askForms: entry.askForms,
        basicKey: entry.basicKey,
        validUntil: entry.validUntil,
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
    // Corridas de los últimos 30 días con mezcla ok/handoff/error/sin_respuesta.
    const statuses = ["ok", "ok", "handoff", "ok", "error", "sin_respuesta", "handoff"] as const
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
          llmCalls: statuses[n % statuses.length] === "ok" ? 1 : 2,
        })
        .onConflictDoNothing({ target: agentRunLedger.id })
    }
    // Decisiones en sombra de demostración (modelo falso): visibles en Actividad.
    await tx
      .insert(agentDecisionLog)
      .values({
        id: "00000000-0000-4000-8000-00000000d001",
        organizationId: orgId,
        conversationId: first.id,
        point: "triage.v2",
        provider: "fake",
        model: "fake-decision",
        stateHash: "0".repeat(64),
        stateChars: 64,
        answers: [
          { id: "requires_reply", kind: "yesno", probability: 0.92 },
          { id: "handoff", kind: "yesno", probability: 0.08 },
          { id: "urgency", kind: "score", score: 1, probabilities: [0.1, 0.85, 0.05], confidence: 0.8 },
          { id: "intent", kind: "choice", choice: "appointment_request", probabilities: { appointment_request: 0.85, other: 0.15 }, confidence: 0.8 },
          { id: "unsubscribe", kind: "yesno", probability: 0.03 },
        ],
        outcome: { wouldSkipReply: false, wouldHandoff: false, urgencyLevel: 1, intent: "appointment_request", wouldFlagUnsubscribe: false },
        latencyMs: 210,
        inputTokens: 64,
        outputTokens: 0,
      })
      .onConflictDoNothing({ target: agentDecisionLog.id })
    // Memoria del caso de demostración: lo que el agente anotó para sus
    // próximos turnos en ese hilo.
    await tx
      .insert(agentCaseMemory)
      .values({
        organizationId: orgId,
        conversationId: first.id,
        notes: [
          { text: "Pregunta por ortodoncia para ella misma; prefiere las tardes.", at: new Date(Date.now() - 3_600_000).toISOString() },
        ],
      })
      .onConflictDoNothing({ target: [agentCaseMemory.organizationId, agentCaseMemory.conversationId] })
    // Lo que no supo responder: una pregunta pendiente para la pantalla de Conocimiento.
    await tx
      .insert(agentKnowledgeGap)
      .values({
        id: "00000000-0000-4000-8000-00000000f001",
        organizationId: orgId,
        conversationId: first.id,
        question: "¿Tienen estacionamiento para bicicletas?",
        query: "estacionamiento bicicletas",
      })
      .onConflictDoNothing({ target: agentKnowledgeGap.id })
  }
  // En qué se basó la última respuesta del agente en cada hilo sembrado: así
  // la Bandeja muestra «En qué se basó» sin tener que conversar primero.
  const replies = await tx
    .select({ id: message.id, conversationId: message.conversationId, body: message.body, createdAt: message.createdAt })
    .from(message)
    .where(and(eq(message.organizationId, orgId), eq(message.senderKind, "agent"), eq(message.direction, "out")))
    .orderBy(desc(message.createdAt))
    .limit(5)
  for (const [index, reply] of replies.entries()) {
    const time = /\b\d{1,2}:\d{2}(?:\s?[ap]\.?\s?m\.?)?/i.exec(reply.body ?? "")?.[0]
    await tx
      .insert(agentAnswerTrace)
      .values({
        id: `00000000-0000-4000-8000-00000000e0${String(index).padStart(2, "0")}`,
        organizationId: orgId,
        conversationId: reply.conversationId,
        messageId: reply.id,
        outcome: "enviada",
        replyText: reply.body ?? "",
        basis: [{ kind: "persona", label: "Citas, presupuestos y saldo del paciente" }],
        checks: time
          ? [{ kind: "hora", value: time, ok: true, source: "Citas, presupuestos y saldo del paciente" }]
          : [],
        model: "seed-dev",
        createdAt: reply.createdAt,
      })
      .onConflictDoNothing({ target: agentAnswerTrace.id })
  }
  // Aprender: una respuesta por revisar, una lección por aprobar y una ya aprendida con su caso de prueba.
  const [toReview, corrected] = replies
  if (toReview) {
    await tx
      .insert(agentReviewItem)
      .values({
        id: "00000000-0000-4000-8000-00000000f101",
        organizationId: orgId,
        conversationId: toReview.conversationId,
        traceId: "00000000-0000-4000-8000-00000000e000",
        reason: "muestra",
        question: "¿A qué hora es mi cita?",
        reply: toReview.body ?? "",
      })
      .onConflictDoNothing()
  }
  if (corrected) {
    await tx
      .insert(agentReviewItem)
      .values({
        id: "00000000-0000-4000-8000-00000000f102",
        organizationId: orgId,
        conversationId: corrected.conversationId,
        traceId: "00000000-0000-4000-8000-00000000e001",
        reason: "equipo_tomo",
        question: "¿El blanqueamiento me deja los dientes blancos del todo?",
        reply: corrected.body ?? "",
        teamReply: "El resultado depende de cada caso; te lo explica el odontólogo en la evaluación.",
        status: "corregida",
        decidedBy: ownerUserId,
        decidedAt: new Date(),
      })
      .onConflictDoNothing()
  }
  await tx
    .insert(agentLesson)
    .values([
      {
        id: "00000000-0000-4000-8000-00000000f201",
        organizationId: orgId,
        kind: "regla",
        scope: "recepcion",
        title: "No prometer resultados del blanqueamiento",
        question: "¿El blanqueamiento me deja los dientes blancos del todo?",
        body: "No prometas resultados del blanqueamiento: di que depende de cada caso y que lo explica el odontólogo en la evaluación.",
        failure: "tono",
        originalReply: "Sí, quedan perfectos.",
        status: "propuesta",
        reviewItemId: corrected ? "00000000-0000-4000-8000-00000000f102" : null,
        conversationId: corrected?.conversationId ?? null,
        proposedBy: ownerUserId,
      },
      {
        id: "00000000-0000-4000-8000-00000000f202",
        organizationId: orgId,
        kind: "ejemplo",
        scope: "recepcion",
        title: "Cuando preguntan: ¿Cuánto cuesta la ortodoncia?",
        question: "¿Cuánto cuesta la ortodoncia?",
        body: "La ortodoncia empieza con una evaluación. Con eso el odontólogo te da el plan y el costo exacto. ¿Te busco una cita para la evaluación?",
        failure: "tono",
        originalReply: "Depende.",
        status: "activa",
        proposedBy: ownerUserId,
        approvedBy: ownerUserId,
        approvedAt: new Date(Date.now() - 3 * 86_400_000),
        uses: 6,
        lastUsedAt: new Date(Date.now() - 86_400_000),
      },
    ])
    .onConflictDoNothing({ target: agentLesson.id })
  await tx
    .insert(agentTestCase)
    .values({
      id: "00000000-0000-4000-8000-00000000f301",
      organizationId: orgId,
      question: "¿Cuánto cuesta la ortodoncia?",
      expected: "La ortodoncia empieza con una evaluación. Con eso el odontólogo te da el plan y el costo exacto. ¿Te busco una cita para la evaluación?",
      lessonId: "00000000-0000-4000-8000-00000000f202",
      createdBy: ownerUserId,
    })
    .onConflictDoNothing({ target: agentTestCase.id })
  // El asesor encendido: Inicio muestra lo que encuentre en los datos sembrados.
  await updateAdvisorSettings(tx, orgId, ownerUserId, { enabled: true })
  // El asistente clínico encendido: las atenciones en borrador ofrecen «Dictar la atención».
  await upsertAgentConfig(tx, orgId, { clinicalAssistantEnabled: true }, { actorUserId: ownerUserId })
  // Memoria de la persona de demostración: lo que el agente recuerda entre conversaciones.
  await tx
    .insert(agentPersonFact)
    .values([
      {
        id: "00000000-0000-4000-8000-00000000f401",
        organizationId: orgId,
        contactId: input.contactId,
        text: "Prefiere citas por la tarde",
        source: "agente",
        channel: "whatsapp",
        createdAt: new Date(Date.now() - 7 * 86_400_000),
      },
      {
        id: "00000000-0000-4000-8000-00000000f402",
        organizationId: orgId,
        contactId: input.contactId,
        text: "Quiere que le avisen un día antes por WhatsApp",
        source: "equipo",
        createdBy: ownerUserId,
        createdAt: new Date(Date.now() - 2 * 86_400_000),
      },
    ])
    .onConflictDoNothing({ target: agentPersonFact.id })
  // Ayuda: una pregunta que odentIA ya respondió; el botón de Ayuda muestra el aviso.
  await tx
    .insert(helpRequest)
    .values({
      id: "00000000-0000-4000-8000-00000000f501",
      organizationId: orgId,
      userId: ownerUserId,
      question: "¿Cómo exporto mis pacientes a Excel?",
      screen: "/patients",
      role: "Propietario",
      dedupeKey: "seed-exportar-pacientes",
      status: "respondida",
      answer: "Todavía no se puede exportar la lista de pacientes. Lo anotamos para una próxima versión.",
      answeredAt: new Date(Date.now() - 86_400_000),
    })
    .onConflictDoNothing({ target: helpRequest.id })
}

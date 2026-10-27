import { newWebchatSessionId, WEBCHAT_CHANNEL } from "@odentia/channels"
import type { Db } from "@odentia/db"
import {
  agentAnswerTrace,
  agentProposal,
  agentRunLedger,
  type AnswerBasisItem,
  type AnswerCheck,
} from "@odentia/db/schema/agent"
import { appointment, scheduleRoom } from "@odentia/db/schema/agenda"
import { user } from "@odentia/db/schema/auth"
import { patient } from "@odentia/db/schema/clinical"
import { contact, contactIdentity, conversation, message } from "@odentia/db/schema/crm"
import { branch } from "@odentia/db/schema/org"
import { and, asc, desc, eq, sql } from "drizzle-orm"
import { getAgentConfig } from "./agentConfig.js"
import { TEST_KEEP_MS } from "./conversation-state.js"
import { nextPatientNumber } from "./patients.js"
import { proposalPendingSql } from "./proposal-state.js"
import { ensureClinicWebchatConnection } from "./webchat.js"

/**
 * «Probar» (ADR 0094): una conversación real con Sofi, por el mismo recorrido
 * que el chat web (ingesta, cola, worker, la misma corrida), con una persona
 * de prueba ya registrada como paciente. Lo que Sofi hace con el «sí» se crea
 * de verdad y queda marcado «Prueba»: no ocupa horarios reales, no sale hacia
 * afuera ni cuenta en números, y se borra con la prueba o sola a los 7 días.
 * Cada persona del equipo tiene a lo sumo una prueba abierta.
 */

/** Cómo se llama la persona de prueba: no es nadie, y así lo ve el equipo en la Agenda. */
export const PROBAR_PERSON_NAME = "Paciente de prueba"
/** La de «Probar una lección»: su conversación dura lo que tarda en responder. */
export const LESSON_PERSON_NAME = "Prueba de una lección"

export interface ProbarMessage {
  id: string
  from: "paciente" | "sofi" | "equipo"
  text: string
  at: string
}

/** Lo que Sofi hizo con un mensaje (o una ráfaga) del paciente: su corrida. */
export interface ProbarTurn {
  /** El mensaje del paciente que la disparó: el último de la ráfaga. */
  triggerMessageId: string
  status: string
  /** Herramientas que usó, en orden y sin repetir: la ruta las dice en palabras. */
  toolsUsed: string[]
  model: string
  /**
   * Cada respuesta que intentó, salida o no (`enviada`, `pendiente`,
   * `bloqueada` por la comprobación o `fallida`), con en qué se basó.
   */
  answers: Array<{
    outcome: string
    text: string | null
    basis: AnswerBasisItem[]
    checks: AnswerCheck[]
  }>
  error: string | null
}

/** Lo que la prueba creó de verdad y se puede abrir. */
export interface ProbarCreated {
  appointmentId: string
  startsAt: string
  createdAt: string
  status: string
  professionalName: string
  branchName: string
  /** Zona de la sede: la hora se dice como allá. */
  timeZone: string | null
  roomName: string
  serviceName: string | null
}

export interface ProbarState {
  conversationId: string | null
  deletesAt: string | null
  personaName: string
  messages: ProbarMessage[]
  turns: ProbarTurn[]
  /** Lo que espera el «sí» del paciente. */
  waiting: Array<{ id: string; action: string; summary: string | null }>
  created: ProbarCreated[]
  /** Sofi está atendiendo el último mensaje y aún no respondió. */
  typing: boolean
  /** Su corrida del último mensaje aún no termina (puede haber respondido ya): «Lo que hizo» está por llegar. */
  busy: boolean
}

/** La sesión del chat web es el hilo y el remitente de la prueba. */
async function findProbar(tx: Db, orgId: string, userId: string) {
  const [row] = await tx
    .select({
      id: conversation.id,
      sessionId: conversation.externalThreadId,
      connectionId: conversation.channelConnectionId,
      createdAt: conversation.createdAt,
    })
    .from(conversation)
    .innerJoin(
      contact,
      and(
        eq(contact.organizationId, conversation.organizationId),
        eq(contact.id, conversation.contactId),
      ),
    )
    .where(
      and(
        eq(conversation.organizationId, orgId),
        eq(conversation.testByUserId, userId),
        eq(conversation.isTest, true),
        // La de «Probar una lección» es de otra persona de prueba y se borra sola al responder.
        eq(contact.displayName, PROBAR_PERSON_NAME),
      ),
    )
    .orderBy(desc(conversation.createdAt))
    .limit(1)
  return row ?? null
}

/** Borra la prueba de esta persona del equipo con todo lo que creó (`delete_webchat_test`). */
export async function deleteProbar(tx: Db, orgId: string, userId: string): Promise<boolean> {
  const found = await findProbar(tx, orgId, userId)
  if (!found) return false
  await tx.execute(sql`select public.delete_webchat_test(${found.id}::uuid)`)
  return true
}

/**
 * Abre una prueba nueva: borra la anterior de esta persona del equipo y crea
 * la persona de prueba (registrada como paciente, sin historia ni citas), su
 * identidad del chat web y su conversación, todo marcado de prueba.
 */
export async function openProbar(
  tx: Db,
  orgId: string,
  userId: string,
  deps: { secretsKey: Buffer },
): Promise<{ conversationId: string; sessionId: string; connectionId: string }> {
  await deleteProbar(tx, orgId, userId)
  return createTestConversation(tx, orgId, userId, {
    secretsKey: deps.secretsKey,
    personName: PROBAR_PERSON_NAME,
  })
}

/**
 * Una conversación de prueba lista para escribir: su persona de prueba,
 * registrada como paciente y sin nada más, su identidad del chat web y la
 * conversación, fuera de la Bandeja (`test_by_user_id`). La usan «Probar» y
 * «Probar una lección».
 */
export async function createTestConversation(
  tx: Db,
  orgId: string,
  userId: string,
  deps: { secretsKey: Buffer; personName: string },
): Promise<{ conversationId: string; sessionId: string; connectionId: string }> {
  const connectionId = await ensureClinicWebchatConnection(tx, orgId, deps.secretsKey, userId)
  const sessionId = newWebchatSessionId({ test: true })
  const [person] = await tx
    .insert(contact)
    .values({
      organizationId: orgId,
      displayName: deps.personName,
      givenNames: "Paciente",
      familyName: "de prueba",
      isTest: true,
    })
    .returning({ id: contact.id })
  if (!person) throw new Error("No se pudo crear la persona de prueba")
  // Su ficha: el vínculo propio lo crea la base desde `person_id`.
  await tx
    .insert(patient)
    .values({
      organizationId: orgId,
      personId: person.id,
      patientNumber: await nextPatientNumber(tx, orgId, { test: true }),
    })
  const [identity] = await tx
    .insert(contactIdentity)
    .values({
      organizationId: orgId,
      contactId: person.id,
      channel: WEBCHAT_CHANNEL,
      externalUserId: sessionId,
      displayName: deps.personName,
      isPrimary: true,
    })
    .returning({ id: contactIdentity.id })
  const [created] = await tx
    .insert(conversation)
    .values({
      organizationId: orgId,
      contactId: person.id,
      contactIdentityId: identity?.id ?? null,
      channelConnectionId: connectionId,
      externalThreadId: sessionId,
      isTest: true,
      testByUserId: userId,
    })
    .returning({ id: conversation.id })
  if (!created) throw new Error("No se pudo abrir la prueba")
  return { conversationId: created.id, sessionId, connectionId }
}

/** La prueba abierta de esta persona del equipo, para escribirle: nula si no hay. */
export async function probarSession(tx: Db, orgId: string, userId: string) {
  return findProbar(tx, orgId, userId)
}

/** Sofi está atendiendo, como mucho este rato, el último mensaje del paciente. */
const TYPING_MS = 90_000

export async function getProbar(
  tx: Db,
  orgId: string,
  userId: string,
  now: Date = new Date(),
): Promise<ProbarState> {
  const cfg = await getAgentConfig(tx, orgId)
  const empty: ProbarState = {
    conversationId: null,
    deletesAt: null,
    personaName: cfg.personaName,
    messages: [],
    turns: [],
    waiting: [],
    created: [],
    typing: false,
    busy: false,
  }
  const found = await findProbar(tx, orgId, userId)
  if (!found) return empty
  const rows = await tx
    .select({
      id: message.id,
      direction: message.direction,
      senderKind: message.senderKind,
      body: message.body,
      status: message.status,
      createdAt: message.createdAt,
    })
    .from(message)
    .where(
      and(
        eq(message.organizationId, orgId),
        eq(message.conversationId, found.id),
        sql`${message.redactedAt} is null`,
      ),
    )
    .orderBy(asc(message.createdAt), asc(message.id))
    .limit(200)
  const messages: ProbarMessage[] = []
  for (const row of rows) {
    const text = row.body?.trim()
    if (!text) continue
    if (row.direction === "in")
      messages.push({ id: row.id, from: "paciente", text, at: row.createdAt.toISOString() })
    else if (row.status !== "failed" && row.status !== "held")
      messages.push({
        id: row.id,
        from: row.senderKind === "agent" ? "sofi" : "equipo",
        text,
        at: row.createdAt.toISOString(),
      })
  }
  const runs = await tx
    .select({
      triggerMessageId: agentRunLedger.triggerMessageId,
      status: agentRunLedger.status,
      toolsUsed: agentRunLedger.toolsUsed,
      model: agentRunLedger.model,
      error: agentRunLedger.error,
    })
    .from(agentRunLedger)
    .where(
      and(eq(agentRunLedger.organizationId, orgId), eq(agentRunLedger.conversationId, found.id)),
    )
    .orderBy(asc(agentRunLedger.startedAt))
  const traces = await tx
    .select({
      triggerMessageId: agentAnswerTrace.triggerMessageId,
      outcome: agentAnswerTrace.outcome,
      text: agentAnswerTrace.replyText,
      basis: agentAnswerTrace.basis,
      checks: agentAnswerTrace.checks,
    })
    .from(agentAnswerTrace)
    .where(
      and(
        eq(agentAnswerTrace.organizationId, orgId),
        eq(agentAnswerTrace.conversationId, found.id),
      ),
    )
    .orderBy(asc(agentAnswerTrace.createdAt))
  const turns: ProbarTurn[] = []
  for (const run of runs) {
    if (!run.triggerMessageId) continue
    turns.push({
      triggerMessageId: run.triggerMessageId,
      status: run.status,
      toolsUsed: [...new Set(run.toolsUsed)],
      model: run.model,
      answers: traces
        .filter((row) => row.triggerMessageId === run.triggerMessageId)
        .map(({ outcome, text, basis, checks }) => ({
          outcome,
          text,
          basis: (basis ?? []) as AnswerBasisItem[],
          checks: (checks ?? []) as AnswerCheck[],
        })),
      error: run.error,
    })
  }
  const waiting = await tx
    .select({
      id: agentProposal.id,
      action: agentProposal.action,
      summary: agentProposal.afterSummary,
    })
    .from(agentProposal)
    .where(
      and(
        eq(agentProposal.organizationId, orgId),
        eq(agentProposal.conversationId, found.id),
        proposalPendingSql(sql.raw('"agent_proposal"')),
      ),
    )
    .orderBy(asc(agentProposal.createdAt))
  const created = await tx
    .select({
      appointmentId: appointment.id,
      startsAt: appointment.startsAt,
      createdAt: appointment.createdAt,
      status: appointment.status,
      professionalName: user.name,
      branchName: branch.name,
      timeZone: branch.timezone,
      roomName: scheduleRoom.name,
      serviceName: appointment.serviceName,
    })
    .from(appointment)
    .innerJoin(user, eq(user.id, appointment.professionalUserId))
    .innerJoin(branch, eq(branch.id, appointment.branchId))
    .innerJoin(scheduleRoom, eq(scheduleRoom.id, appointment.roomId))
    .where(
      and(
        eq(appointment.organizationId, orgId),
        eq(appointment.conversationId, found.id),
        eq(appointment.isTest, true),
      ),
    )
    .orderBy(asc(appointment.createdAt))
  const last = rows.at(-1)
  const lastInbound = rows.findLast((row) => row.direction === "in")
  const busy =
    !!lastInbound &&
    !runs.some((run) => run.triggerMessageId === lastInbound.id) &&
    now.getTime() - lastInbound.createdAt.getTime() < TYPING_MS
  return {
    conversationId: found.id,
    deletesAt: new Date(found.createdAt.getTime() + TEST_KEEP_MS).toISOString(),
    personaName: cfg.personaName,
    messages,
    turns,
    waiting,
    created: created.map((row) => ({
      ...row,
      startsAt: row.startsAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    })),
    typing: busy && last?.direction === "in",
    busy,
  }
}

import type { Db } from "@odentia/db"
import { isWebchatPlaceholderName } from "@odentia/channels"
import { agentCaseMemory, agentHandoff, agentProposal, type AgentCaseNote } from "@odentia/db/schema/agent"
import { member } from "@odentia/db/schema/auth"
import { automationJob } from "@odentia/db/schema/automation"
import { channelConnection, contact, conversation, crmTask, message } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { and, desc, eq, sql } from "drizzle-orm"
import { claimHandoff } from "./agent-operations.js"
import { type AgentConfig, getAgentConfig } from "./agentConfig.js"
import {
  acceptedOutSql,
  handoffOpenExistsSql,
  lastAcceptedOutSql,
  proposalPendingExistsSql,
  teamLiveSql,
  unansweredSql,
} from "./conversation-state.js"
import { reopenIfClosed, sendOutbound } from "./conversations.js"
import { createContactNote } from "./crm-workspace.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { handoffOpenSql } from "./handoff-state.js"
import { findOrgLocale, formatZoned } from "./locale.js"
import { windowOpen } from "./message-window.js"
import { lastOpportuneAtOrBefore, nextOpportuneFrom, type OpportuneSchedule } from "./opportune-hours.js"
import { isWritingTime, writingScheduleOf } from "./writing-hours.js"
import { proposalPendingSql } from "./proposal-state.js"
import { updateTask } from "./tasks.js"

/**
 * Ninguna conversación queda abierta (ADR 0024): el agente la cierra con una
 * despedida cordial cuando termina o cuando la persona deja de responder, el
 * equipo la resuelve o la cierra, y todo mensaje de la persona la reabre
 * (`reopenIfClosed`, en `conversations.ts`). Aquí viven el cierre, lo que pasa
 * al cerrar, «Tomar» y «Devolver al agente», y el ciclo que insiste y cierra.
 */

export const CONVERSATION_CLOSE_REASONS = ["resuelta", "sin_respuesta", "equipo", "manual"] as const
export type ConversationCloseReason = (typeof CONVERSATION_CLOSE_REASONS)[number]

/** Retraso del ciclo tras el que ya no se da por puntual: pasado esto, una despedida espera al «Horario de recontacto». */
const CARE_LATE_MS = 15 * 60 * 1000

/** Horas desde el último mensaje del agente tras las que insiste, una sola vez por atención. */
export const NUDGE_AFTER_HOURS = 3
/** Límites de `close_after_hours`: la ventana de WhatsApp es de 24 horas. */
export const CLOSE_AFTER_HOURS_MIN = 6
export const CLOSE_AFTER_HOURS_MAX = 23
/**
 * Una atención que terminó con una cita reservada (por Sofi o desde su enlace) no
 * espera nada de la persona: pasado este rato sin mensajes se cierra como
 * resuelta, sin despedida (ADR 0113). Lo que sigue lo dicen sus recordatorios.
 */
export const BOOKED_CLOSE_AFTER_MS = 60 * 60_000
/** Tras insistir, el agente espera al menos esto antes de despedirse. */
const AFTER_NUDGE_MS = 60 * 60_000
const HOUR_MS = 60 * 60_000

/** Canales con ventana para escribir desde el último entrante. */
const WINDOWED_PROVIDERS = new Set(["whatsapp_cloud_api", "messenger", "instagram"])

/** Herramientas con las que el agente ofreció algo en su último turno: una razón para insistir. */
const OFFER_TOOLS = new Set(["proponer_cita", "reprogramar_cita", "cancelar_cita", "enviar_enlace_cita", "buscar_huecos"])

/** Cómo terminó una atención, para la línea que recibe el agente en la siguiente. */
const ENDED_WORDS: Record<ConversationCloseReason, string> = {
  resuelta: "terminó: la persona se despidió y no quedaba nada pendiente",
  sin_respuesta: "la persona dejó de responder y el agente se despidió",
  equipo: "la resolvió el equipo",
  manual: "la cerró una persona del equipo",
}

/* ------------------------------ La voz de la clínica ------------------------------ */

export interface ClinicVoice {
  treatment: "tu" | "usted"
  tone: AgentConfig["tone"]
  emojis: AgentConfig["emojis"]
}

export function clinicVoiceOf(cfg: Pick<AgentConfig, "treatment" | "tone" | "emojis">): ClinicVoice {
  return { treatment: cfg.treatment ?? (cfg.tone === "formal" ? "usted" : "tu"), tone: cfg.tone, emojis: cfg.emojis }
}

/**
 * El nombre de pila con que se le habla, solo si el nombre del contacto parece
 * un nombre: un número de teléfono o un correo no se usan como saludo.
 */
export function greetingName(displayName: string | null | undefined): string | null {
  // «Visitante del chat web» no es su nombre: no se le dice «Hola, Visitante».
  if (isWebchatPlaceholderName(displayName)) return null
  const first = displayName?.trim().split(/\s+/)[0] ?? ""
  if (!first || first.length > 30 || /[\d@+_]/.test(first) || !/\p{L}/u.test(first)) return null
  // «Paciente» (la Agenda lo pone si nadie escribió el nombre) o «Prueba» no son
  // su nombre: «Paciente, cuando desee…» se lee como un trato frío.
  if (NOT_A_NAME.has(first.toLocaleLowerCase("es"))) return null
  return first
}

/** Palabras que ocupan el lugar del nombre sin serlo. */
const NOT_A_NAME = new Set(["paciente", "cliente", "usuario", "usuaria", "prueba", "test", "visitante", "contacto", "sin", "desconocido", "desconocida"])

function withName(name: string | null, sentence: string): string {
  if (!name) return sentence
  // «Ana, cuando quieras…» / «Ana, ¿te reservo…?»: tras el nombre la frase sigue en minúscula.
  const lowered = sentence.startsWith("¿") ? `¿${sentence.charAt(1).toLowerCase()}${sentence.slice(2)}` : `${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`
  return `${name}, ${lowered}`
}

/**
 * La despedida al cerrar, fija y en la voz de la clínica: dice que estamos
 * atentos si quiere contactarnos (nunca «te dejo por ahora»). Si había una
 * cita propuesta sin confirmar (tablero 2c), dice que ese horario quedó libre:
 * así nadie llega a una cita que nunca se reservó.
 */
export function farewellText(voice: ClinicVoice, name: string | null, proposedWhen: string | null = null): string {
  const usted = voice.treatment === "usted"
  if (proposedWhen) {
    const released = `Como no alcanzamos a confirmar, dejé libre el ${proposedWhen}.`
    const next = usted
      ? "Cuando desee una cita, escríbanos y le busco un horario: estamos atentos."
      : "Cuando quieras una cita, escríbenos y te busco un horario: estamos atentos."
    return `${withName(name, released)} ${next}`
  }
  const warm = voice.tone === "cercano"
  const base = usted
    ? warm
      ? "Cuando desee retomar, escríbanos por aquí: estamos atentos para ayudarle."
      : "Cuando desee retomar, escríbanos por aquí: quedamos atentos."
    : warm
      ? "Cuando quieras retomar, escríbenos por aquí: estamos atentos para ayudarte."
      : "Cuando quieras retomar, escríbenos por aquí: quedamos atentos."
  const emoji = voice.emojis === "pocos" && warm ? " 😊" : ""
  return `${withName(name, base)}${emoji}`
}

/**
 * Lo que dice el agente al insistir, fijo y en la voz de la clínica. Con una
 * cita propuesta pregunta por ella; si no, por lo que le comentó.
 */
export function nudgeText(voice: ClinicVoice, name: string | null, proposed: { action: string; when: string } | null): string {
  const usted = voice.treatment === "usted"
  let sentence: string
  if (proposed?.action === "reservar_cita") {
    sentence = usted
      ? `¿Le reservo el ${proposed.when}? Si prefiere otro horario, dígame.`
      : `¿Te reservo el ${proposed.when}? Si prefieres otro horario, dime.`
  } else if (proposed?.action === "reprogramar_cita") {
    sentence = usted
      ? `¿Le cambio la cita al ${proposed.when}? Si prefiere otro horario, dígame.`
      : `¿Te cambio la cita al ${proposed.when}? Si prefieres otro horario, dime.`
  } else {
    sentence = usted
      ? "¿Pudo ver lo que le comenté? Si le queda alguna duda, aquí estoy para ayudarle."
      : "¿Pudiste ver lo que te comenté? Si te queda alguna duda, aquí estoy para ayudarte."
  }
  return withName(name, sentence)
}

/** Día y hora de una propuesta, como se le dice a la persona: «jueves 16 de octubre a las 10:00». */
function proposalWhen(startsAt: unknown, zone: { timezone: string; locale: string }): string | null {
  if (typeof startsAt !== "string") return null
  const date = new Date(startsAt)
  if (Number.isNaN(date.getTime())) return null
  const day = new Intl.DateTimeFormat(zone.locale, { timeZone: zone.timezone, weekday: "long", day: "numeric", month: "long" }).format(date)
  const hour = new Intl.DateTimeFormat(zone.locale, { timeZone: zone.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date)
  return `${day} a las ${hour}`
}

/* ------------------------------ Se puede escribir ------------------------------ */

/**
 * ¿Se le puede escribir ahora sin mensaje aprobado? En WhatsApp, Messenger e
 * Instagram solo dentro de la ventana desde su último entrante (`windowOpen`,
 * la misma regla y el mismo margen que todo envío, ADR 0042); en los demás
 * canales, siempre que la conexión esté activa.
 */
export function canWriteNow(
  thread: { provider: string; connectionStatus: string; lastInboundAt: Date | null },
  now: Date,
): boolean {
  if (thread.connectionStatus !== "active") return false
  if (!WINDOWED_PROVIDERS.has(thread.provider)) return true
  return windowOpen(thread.lastInboundAt, now)
}

/** La cita propuesta que espera el sí de la persona en el hilo, con su día y hora como se le dicen. */
async function proposedAppointmentWhen(tx: Db, orgId: string, id: string): Promise<string | null> {
  const proposed = await pendingProposalOf(tx, id)
  if (proposed?.action !== "reservar_cita") return null
  return proposalWhen(proposed.payload["startsAt"], await findOrgLocale(tx, orgId))
}

/* ------------------------------ Cerrar ------------------------------ */

/** Acción de auditoría de cada cierre; con el agente, la frase dice por qué. */
const CLOSE_ACTION: Record<ConversationCloseReason, string> = {
  manual: "conversation.closed",
  equipo: "conversation.resolved",
  resuelta: "conversation.closed_resuelta",
  sin_respuesta: "conversation.closed_sin_respuesta",
}

/** Nota que queda en la ficha cuando un cierre resuelve los casos derivados del hilo. */
const HANDOFF_CLOSE_NOTE: Partial<Record<ConversationCloseReason, string>> = {
  equipo: "Caso de Sofi resuelto por el equipo al resolver la conversación.",
  manual: "Caso de Sofi cerrado sin resolver: se cerró la conversación.",
}

/**
 * Cierra una conversación con su motivo. Es la única forma de cerrar: con
 * cualquier motivo vencen las propuestas pendientes del hilo, se quita la
 * asignación y el agente vuelve a quedar encendido; las derivaciones abiertas
 * se completan solo si cierra el equipo (`equipo`, `manual`), con nota en la
 * ficha; y las notas del caso de esta atención pasan al historial: la
 * siguiente recibe una sola línea con cómo terminó. No envía nada: la
 * despedida, si corresponde, sale antes. Devuelve false si ya estaba cerrada
 * o si, con `unlessInboundAfter`, la persona escribió algo después de ese
 * mensaje: la despedida le respondía a él y lo nuevo tiene su propia corrida.
 */
export async function closeConversationWith(
  tx: Db,
  orgId: string,
  id: string,
  input: { reason: ConversationCloseReason; byUserId: string | null; now?: Date; unlessInboundAfter?: string; ended?: string },
): Promise<boolean> {
  if (!(CONVERSATION_CLOSE_REASONS as readonly string[]).includes(input.reason)) {
    throw validation(`Motivo de cierre inválido (${CONVERSATION_CLOSE_REASONS.join("|")})`)
  }
  const now = input.now ?? new Date()
  const [row] = await tx
    .select({ id: conversation.id, status: conversation.status, contactId: conversation.contactId })
    .from(conversation)
    .where(and(eq(conversation.id, id), eq(conversation.organizationId, orgId)))
    .for("update")
    .limit(1)
  if (!row) throw notFound("Conversación")
  if (row.status === "closed") return false
  // Con la fila bloqueada, la ingesta (que también la bloquea) ya dejó lo nuevo a la vista
  // o espera a que termine este cierre y reabre: ningún entrante queda en una cerrada (ADR 0024).
  if (input.unlessInboundAfter && (await newerInboundThan(tx, orgId, id, input.unlessInboundAfter))) return false
  // Primero el cierre: lo que se resuelve después (la tarea de una derivación)
  // ve la conversación ya cerrada y no vuelve a cerrarla.
  await tx
    .update(conversation)
    .set({
      status: "closed",
      closedAt: now,
      closedByUserId: input.byUserId,
      closeReason: input.reason,
      assignedUserId: null,
      agentStatus: "on",
      nudgedAt: null,
      updatedAt: now,
    })
    .where(and(eq(conversation.id, id), eq(conversation.organizationId, orgId)))
  const expired = await tx
    .update(agentProposal)
    .set({ status: "expirada", updatedAt: now })
    .where(and(eq(agentProposal.organizationId, orgId), eq(agentProposal.conversationId, id), eq(agentProposal.status, "propuesta")))
    .returning({ id: agentProposal.id })
  let handoffs = 0
  const note = HANDOFF_CLOSE_NOTE[input.reason]
  if (note) {
    const open = await tx
      .select({ taskId: agentHandoff.taskId })
      .from(agentHandoff)
      .where(and(eq(agentHandoff.organizationId, orgId), eq(agentHandoff.conversationId, id), handoffOpenSql(sql.raw('"agent_handoff"'))))
    for (const handoff of open) {
      if (!handoff.taskId) continue
      await updateTask(tx, orgId, handoff.taskId, { status: "done", actorUserId: input.byUserId })
      handoffs++
    }
    if (handoffs > 0) {
      await createContactNote(tx, orgId, row.contactId, { body: note, conversationId: id }, { userId: input.byUserId })
    }
  }
  // Lo que el agente anotó en esta atención no pasa a la siguiente: queda una línea con cómo terminó.
  const zone = await findOrgLocale(tx, orgId)
  const previous: AgentCaseNote = {
    kind: "atencion_anterior",
    text: `Atención anterior: cerrada el ${formatZoned(now, zone)}; ${input.ended ?? ENDED_WORDS[input.reason]}.`,
    at: now.toISOString(),
  }
  await tx
    .insert(agentCaseMemory)
    .values({ organizationId: orgId, conversationId: id, notes: [previous], lookups: {} })
    .onConflictDoUpdate({
      target: [agentCaseMemory.organizationId, agentCaseMemory.conversationId],
      set: { notes: [previous], lookups: {}, updatedAt: now },
    })
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId: input.byUserId,
    action: CLOSE_ACTION[input.reason],
    entity: "conversation",
    entityId: id,
    metadata: {
      reason: input.reason,
      expiredProposals: expired.length,
      handoffs,
      ...(input.byUserId ? {} : { origin: "agent" }),
    },
  })
  await tx.execute(
    sql`select pg_notify('org_events', ${JSON.stringify({ orgId, kind: "conversation.updated", conversationId: id, at: now.toISOString() })})`,
  )
  return true
}

/** Lo que se necesita del hilo para decidir si se le puede escribir y cómo saludarle. */
async function threadForWriting(tx: Db, orgId: string, id: string) {
  const [row] = await tx
    .select({
      id: conversation.id,
      status: conversation.status,
      contactName: contact.displayName,
      provider: channelConnection.provider,
      channel: channelConnection.channel,
      connectionStatus: channelConnection.status,
      lastInboundAt: conversation.lastInboundAt,
    })
    .from(conversation)
    .innerJoin(contact, eq(contact.id, conversation.contactId))
    .innerJoin(channelConnection, eq(channelConnection.id, conversation.channelConnectionId))
    .where(and(eq(conversation.id, id), eq(conversation.organizationId, orgId)))
    .limit(1)
  if (!row) throw notFound("Conversación")
  return row
}

/** Casos abiertos del hilo; `besidesTask` deja fuera el de esa tarea. */
async function countOpenHandoffsOf(tx: Db, orgId: string, id: string, besidesTask?: string): Promise<number> {
  const [row] = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from agent_handoff h
    where h.organization_id = ${orgId} and h.conversation_id = ${id} and ${handoffOpenSql(sql.raw("h"))}
      ${besidesTask ? sql`and h.task_id is distinct from ${besidesTask}::uuid` : sql``}`)
  return row?.n ?? 0
}

async function countPendingProposalsOf(tx: Db, orgId: string, id: string): Promise<number> {
  const [row] = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from agent_proposal p
    where p.organization_id = ${orgId} and p.conversation_id = ${id} and ${proposalPendingSql(sql.raw("p"))}`)
  return row?.n ?? 0
}

export interface ResolvePreview {
  /** Al resolver sale la despedida: falso si se cerró la ventana del último entrante o el canal no deja escribir. */
  farewell: boolean
  farewellText: string | null
  /** Casos derivados abiertos que se dan por resueltos. */
  handoffs: number
  /** Propuestas que esperan el sí del interlocutor y vencen al cerrar. */
  pendingContact: number
}

/** Lo que pasará al pulsar «Resolver», para decirlo antes. */
export async function getResolvePreview(tx: Db, orgId: string, id: string, now = new Date()): Promise<ResolvePreview> {
  const thread = await threadForWriting(tx, orgId, id)
  const cfg = await getAgentConfig(tx, orgId)
  const farewell = thread.status === "open" && canWriteNow(thread, now)
  return {
    farewell,
    farewellText: farewell
      ? farewellText(clinicVoiceOf(cfg), greetingName(thread.contactName), await proposedAppointmentWhen(tx, orgId, id))
      : null,
    handoffs: await countOpenHandoffsOf(tx, orgId, id),
    pendingContact: await countPendingProposalsOf(tx, orgId, id),
  }
}

/**
 * «Resolver»: el equipo da por terminada la atención. Envía la despedida si se
 * puede escribir, completa los casos derivados del hilo, vence las propuestas
 * y cierra con `equipo`. Una ya cerrada queda igual.
 */
export async function resolveConversationByTeam(
  tx: Db,
  orgId: string,
  id: string,
  actorUserId: string | null,
  now = new Date(),
): Promise<void> {
  const preview = await getResolvePreview(tx, orgId, id, now)
  const thread = await threadForWriting(tx, orgId, id)
  if (thread.status === "closed") return
  if (preview.farewell && preview.farewellText) {
    await sendFixed(tx, orgId, id, preview.farewellText, actorUserId ? { senderKind: "user", senderUserId: actorUserId } : { senderKind: "agent" })
  }
  await closeConversationWith(tx, orgId, id, { reason: "equipo", byUserId: actorUserId, now })
}

/** Cerrar sin resolver un caso: no envía despedida; los casos derivados se cierran «sin resolver». */
export async function closeConversation(tx: Db, orgId: string, id: string, actorUserId?: string): Promise<void> {
  await threadForWriting(tx, orgId, id)
  await closeConversationWith(tx, orgId, id, { reason: "manual", byUserId: actorUserId ?? null })
}

/**
 * Completar la tarea de un tema ya no cierra la conversación (ADR 0050): el
 * agente sigue con lo demás y el ciclo la cierra por silencio, como cualquier
 * otra. Se mantienen para quien pregunta qué pasará al completarla: nada.
 */
export async function getTaskResolvePreview(
  _tx: Db,
  _orgId: string,
  _taskId: string,
  _now = new Date(),
): Promise<{ conversationId: string; contactName: string; preview: ResolvePreview } | null> {
  return null
}

/** Tras completar la tarea de un tema: avisa a la Bandeja; la conversación sigue con el agente. */
export async function resolveAfterHandoffTask(tx: Db, orgId: string, taskId: string, _actorUserId: string | null): Promise<boolean> {
  const [handoff] = await tx
    .select({ conversationId: agentHandoff.conversationId })
    .from(agentHandoff)
    .where(and(eq(agentHandoff.organizationId, orgId), eq(agentHandoff.taskId, taskId)))
    .limit(1)
  if (handoff?.conversationId) {
    await tx.execute(
      sql`select pg_notify('org_events', ${JSON.stringify({ orgId, kind: "conversation.updated", conversationId: handoff.conversationId, at: new Date().toISOString() })})`,
    )
  }
  return false
}

/* ------------------------------ Tomar y devolver ------------------------------ */

/**
 * «Tomar»: los temas abiertos del hilo pasan a quien los toma (sin
 * confirmación; se avisa a quien los tenía). El agente no se apaga: sigue con
 * lo demás (ADR 0050). Tomar una cerrada la reabre antes (ADR 0024).
 */
export async function takeConversation(tx: Db, orgId: string, id: string, userId: string): Promise<void> {
  const [membership] = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
    .limit(1)
  if (!membership) throw validation("Solo un miembro de la organización puede tomar la conversación")
  const thread = await threadForWriting(tx, orgId, id)
  if (thread.status === "closed") await reopenIfClosed(tx, orgId, id, { userId, via: "equipo" })
  const now = new Date()
  await tx
    .update(conversation)
    .set({ assignedUserId: userId, updatedAt: now })
    .where(and(eq(conversation.id, thread.id), eq(conversation.organizationId, orgId)))
  const open = await tx
    .select({ id: agentHandoff.id })
    .from(agentHandoff)
    .where(and(eq(agentHandoff.organizationId, orgId), eq(agentHandoff.conversationId, id), handoffOpenSql(sql.raw('"agent_handoff"'))))
  for (const handoff of open) await claimHandoff(tx, orgId, userId, handoff.id, { takeOver: true })
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId: userId,
    action: "conversation.taken",
    entity: "conversation",
    entityId: id,
    metadata: { handoffs: open.length },
  })
  await tx.execute(
    sql`select pg_notify('org_events', ${JSON.stringify({ orgId, kind: "conversation.updated", conversationId: id, at: now.toISOString() })})`,
  )
}

/**
 * Vuelve a encender al agente en el hilo y quita la asignación. Los temas
 * abiertos siguen con su responsable: el agente nunca los responde (ADR 0050).
 */
export async function releaseConversation(tx: Db, orgId: string, id: string, actorUserId: string | null): Promise<void> {
  const thread = await threadForWriting(tx, orgId, id)
  const now = new Date()
  await tx
    .update(conversation)
    .set({ assignedUserId: null, agentStatus: "on", updatedAt: now })
    .where(and(eq(conversation.id, thread.id), eq(conversation.organizationId, orgId)))
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "conversation.released",
    entity: "conversation",
    entityId: id,
    metadata: {},
  })
  await tx.execute(
    sql`select pg_notify('org_events', ${JSON.stringify({ orgId, kind: "conversation.updated", conversationId: id, at: now.toISOString() })})`,
  )
}

/**
 * Por qué el agente no debe cerrar todavía: una propuesta espera el sí del
 * interlocutor o el caso está derivado. Nulo si puede despedirse y cerrar.
 */
export async function closurePendingReason(tx: Db, orgId: string, id: string): Promise<string | null> {
  if ((await countPendingProposalsOf(tx, orgId, id)) > 0) {
    return "Hay una propuesta esperando el sí del interlocutor: no cierres. Responde lo que pidió y, si quiere, que confirme la propuesta."
  }
  if ((await countOpenHandoffsOf(tx, orgId, id)) > 0) {
    return "El caso está con una persona del equipo: no cierres la conversación."
  }
  return null
}

/**
 * Por qué el agente ya no debe enviar lo que redactó: mientras el modelo
 * escribía (puede tardar minutos), una persona tomó la conversación o la
 * cerró. Enviar igual le hablaría encima al equipo y, en una cerrada, la
 * reabriría (`sendOutbound`). Nulo si la conversación sigue siendo del agente.
 */
export async function agentReplyBlockedReason(tx: Db, orgId: string, id: string): Promise<string | null> {
  const [row] = await tx
    .select({ status: conversation.status, agentStatus: conversation.agentStatus })
    .from(conversation)
    .where(and(eq(conversation.id, id), eq(conversation.organizationId, orgId)))
    .limit(1)
  if (!row) return "La conversación ya no existe: no envíes nada."
  if (row.status !== "open") return "El equipo cerró la conversación mientras preparabas la respuesta: no envíes nada."
  if (row.agentStatus !== "on") {
    return "Una persona del equipo apagó el agente en esta conversación mientras preparabas la respuesta: no envíes nada; la sigue ella."
  }
  // Una persona del equipo conversa en vivo: el agente espera (ADR 0050).
  const [live] = await tx.execute<{ live: boolean }>(sql`select ${teamLiveSql(sql.raw("c"))} as live from conversation c
    where c.id = ${id} and c.organization_id = ${orgId}`)
  if (live?.live) {
    return "Una persona del equipo está conversando ahora con esta persona: no envíes nada; el agente vuelve cuando ella deje de escribir."
  }
  return null
}

/**
 * ¿La persona escribió algo después del mensaje que se está respondiendo? En
 * el chat se escribe en pedazos: lo redactado responde a una parte y llegaría
 * viejo. La corrida de su último mensaje responde todo junto (ADR 0097).
 */
export async function newerInboundThan(tx: Db, orgId: string, conversationId: string, messageId: string): Promise<boolean> {
  // Solo cuenta lo que tendrá su propia corrida (en la cola o ya hecha): un botón,
  // «BAJA» o un correo automático no despiertan al agente, y descartar la respuesta
  // por ellos dejaba a la persona sin ninguna.
  const [row] = await tx.execute<{ newer: boolean }>(sql`
    select exists (
      select 1 from message m
      where m.organization_id = ${orgId} and m.conversation_id = ${conversationId}::uuid and m.direction = 'in'
        and m.created_at > (select t.created_at from message t where t.id = ${messageId}::uuid and t.organization_id = ${orgId})
        and (
          exists (select 1 from pgmq.q_agent_runs q where q.message->>'messageId' = m.id::text)
          or exists (select 1 from agent_run_ledger l where l.organization_id = ${orgId} and l.trigger_message_id = m.id)
        )
    ) as newer`)
  return row?.newer === true
}

/* ------------------------------ El ciclo: insistir y cerrar ------------------------------ */

export interface ConversationCareDeps {
  /** Formato del canal (`formatForChannel` del agente): marcas y emojis según el canal y la voz de la clínica. */
  format?: (text: string, channel: string | null, opts: { emojis: "no" | "pocos" }) => string
}

export interface ConversationCareSummary {
  nudged: number
  closed: number
}

/**
 * Cuándo cerrar por silencio: a `closeAfterHours` desde que la persona calló
 * (su último entrante, o el inicio de la atención si fue después) o, si esa
 * hora cae fuera del «Horario de recontacto», en el último momento permitido
 * antes; nunca antes del mínimo ni antes de una hora después de insistir.
 */
export function silenceCloseAt(input: {
  silenceFrom: Date
  nudgedAt: Date | null
  closeAfterHours: number
  schedule: OpportuneSchedule
}): Date {
  const target = new Date(input.silenceFrom.getTime() + input.closeAfterHours * HOUR_MS)
  const floor = Math.max(
    input.silenceFrom.getTime() + CLOSE_AFTER_HOURS_MIN * HOUR_MS,
    input.nudgedAt ? input.nudgedAt.getTime() + AFTER_NUDGE_MS : 0,
  )
  const earlier = lastOpportuneAtOrBefore(target, input.schedule) ?? target
  if (earlier.getTime() >= floor) return earlier
  // Antes del mínimo no se cierra: desde ahí, la primera hora oportuna.
  const from = new Date(floor)
  return nextOpportuneFrom(from, input.schedule) ?? from
}

interface CareRow {
  id: string
  contactName: string
  assignedUserId: string | null
  agentStatus: string
  nudgedAt: Date | null
  attentionStartedAt: Date
  lastInboundAt: Date | null
  lastMessageAt: Date | null
  provider: string
  channel: string
  connectionStatus: string
  unanswered: boolean
  hasAcceptedOut: boolean
  handoffOpen: boolean
  proposalPending: boolean
}

/**
 * Ciclo del worker, sin modelo e idempotente, para una organización con
 * Recepción encendida. Por cada conversación abierta:
 * - con el agente a cargo, sin derivación abierta y respondida: insiste una
 *   vez a las 3 horas de su último mensaje si había algo por responder
 *   (propuesta esperando el sí, una pregunta o una oferta), en horario
 *   oportuno y con ventana para escribir; y a `closeAfterHours` de silencio se
 *   despide y cierra con `sin_respuesta` (sin ventana, cierra sin mensaje);
 * - con una persona a cargo (asignada, agente apagado o canal que el agente no
 *   atiende): no se cierra sola. Pasadas `closeAfterHours` sin mensajes la
 *   muestra «Te espera» (`stillOpenWithPersonSql`), no la campana.
 */
export async function tickConversationCare(
  tx: Db,
  orgId: string,
  now: Date,
  deps: ConversationCareDeps = {},
): Promise<ConversationCareSummary> {
  const summary: ConversationCareSummary = { nudged: 0, closed: 0 }
  const cfg = await getAgentConfig(tx, orgId)
  if (!cfg.enabled) return summary
  const conv = sql.raw('"conversation"')
  // Antes de una hora sin mensajes no hay nada que hacer: ni insistir, ni cerrar, ni
  // dar por terminada la atención que dejó una cita.
  const quietSince = new Date(now.getTime() - BOOKED_CLOSE_AFTER_MS)
  const rows: CareRow[] = await tx
    .select({
      id: conversation.id,
      contactName: contact.displayName,
      assignedUserId: conversation.assignedUserId,
      agentStatus: conversation.agentStatus,
      nudgedAt: conversation.nudgedAt,
      attentionStartedAt: conversation.attentionStartedAt,
      lastInboundAt: conversation.lastInboundAt,
      lastMessageAt: conversation.lastMessageAt,
      provider: channelConnection.provider,
      channel: channelConnection.channel,
      connectionStatus: channelConnection.status,
      unanswered: sql<boolean>`${unansweredSql(conv)}`,
      hasAcceptedOut: sql<boolean>`${lastAcceptedOutSql(conv)} is not null`,
      handoffOpen: sql<boolean>`${handoffOpenExistsSql(conv)}`,
      proposalPending: sql<boolean>`${proposalPendingExistsSql(conv)}`,
    })
    .from(conversation)
    .innerJoin(contact, eq(contact.id, conversation.contactId))
    .innerJoin(channelConnection, eq(channelConnection.id, conversation.channelConnectionId))
    .where(
      and(
        eq(conversation.organizationId, orgId),
        eq(conversation.status, "open"),
        // A quien está en Spam o bloqueado no se le insiste ni se le despide (ADR 0054).
        sql`${contact.screen} is null`,
        sql`coalesce(${conversation.lastMessageAt}, ${conversation.attentionStartedAt}) <= ${quietSince.toISOString()}::timestamptz`,
      ),
    )
  if (rows.length === 0) return summary
  // Insistir y despedirse es escribir por cuenta propia: el «Horario para
  // escribir» de la clínica (ADR 0042), no el horario de atención.
  const schedule = await writingScheduleOf(tx, orgId)
  const zone = await findOrgLocale(tx, orgId)
  const voice = clinicVoiceOf(cfg)
  for (const row of rows) {
    // Cada conversación en su propio punto de guardado: un envío que falla no deshace las demás.
    const outcome = await tx
      .transaction(async (inner) => careFor(inner, row))
      .catch((error: unknown) => {
        if (!(error instanceof ServiceError)) throw error
        return null
      })
    if (outcome === "nudged") summary.nudged++
    if (outcome === "closed") summary.closed++
  }
  return summary

  async function careFor(inner: Db, row: CareRow): Promise<"nudged" | "closed" | null> {
    // Un tema que el equipo ya respondió y por el que la persona no volvió a
    // preguntar se da por resuelto con la misma regla de silencio (ADR 0050).
    if (row.handoffOpen && !(await settleAnsweredTopics(inner, row))) return null
    // Con una persona a cargo no se cierra sola: la muestra «Te espera».
    if (row.assignedUserId !== null || row.agentStatus === "off") return null
    if (row.unanswered || !row.hasAcceptedOut) return null
    // Terminó con su cita y no queda nada por responder: se da por resuelta sin escribirle.
    if (!row.handoffOpen && !row.proposalPending && (await bookedInAttention(inner, orgId, row))) {
      const lastAt = row.lastMessageAt ?? row.attentionStartedAt
      if (now.getTime() - lastAt.getTime() < BOOKED_CLOSE_AFTER_MS) return null
      if (!(await stillQuiet(inner, row))) return null
      await closeConversationWith(inner, orgId, row.id, {
        reason: "resuelta",
        byUserId: null,
        now,
        ended: "terminó con su cita reservada y no quedaba nada pendiente",
      })
      return "closed"
    }
    if (now.getTime() - (row.lastMessageAt ?? row.attentionStartedAt).getTime() < NUDGE_AFTER_HOURS * HOUR_MS) return null
    const silenceFrom = new Date(Math.max(row.lastInboundAt?.getTime() ?? 0, row.attentionStartedAt.getTime()))
    const closeAt = silenceCloseAt({ silenceFrom, nudgedAt: row.nudgedAt, closeAfterHours: cfg.closeAfterHours, schedule })
    const writable = canWriteNow(row, now)
    if (now.getTime() >= closeAt.getTime()) {
      // La despedida nunca sale fuera del «Horario de recontacto». `closeAt` ya
      // cae en él (a veces en su último minuto); si el ciclo llega tarde y el
      // horario cerró, espera a que abra (si para entonces ya no se puede
      // escribir, cierra sin despedida, como cualquier ventana vencida).
      const late = now.getTime() - closeAt.getTime() > CARE_LATE_MS
      if (writable && late && !isWritingTime(now, schedule)) return null
      if (!(await stillQuiet(inner, row))) return null
      if (writable) {
        // Antes de cerrar, porque al cerrar vence la propuesta.
        const proposedWhen = await proposedAppointmentWhen(inner, orgId, row.id)
        await sendFixed(inner, orgId, row.id, format(farewellText(voice, greetingName(row.contactName), proposedWhen), row.channel), {
          senderKind: "agent",
        })
      }
      await closeConversationWith(inner, orgId, row.id, { reason: "sin_respuesta", byUserId: null, now })
      return "closed"
    }
    if (row.nudgedAt || !writable || !isWritingTime(now, schedule)) return null
    const last = await lastMessageOf(inner, row.id)
    if (!last || last.senderKind !== "agent" || last.automatic) return null
    if (now.getTime() - last.createdAt.getTime() < NUDGE_AFTER_HOURS * HOUR_MS) return null
    const proposed = await pendingProposalOf(inner, row.id)
    const offered = await offeredInLastTurn(inner, row.id, last.createdAt)
    const asks = (last.body ?? "").trim().endsWith("?")
    if (!row.proposalPending && !asks && !offered) return null
    const when = proposed ? proposalWhen(proposed.payload["startsAt"], zone) : null
    if (!(await stillQuiet(inner, row))) return null
    const text = nudgeText(voice, greetingName(row.contactName), proposed && when ? { action: proposed.action, when } : null)
    await sendFixed(inner, orgId, row.id, format(text, row.channel), { senderKind: "agent" })
    await inner
      .update(conversation)
      .set({ nudgedAt: now })
      .where(and(eq(conversation.id, row.id), eq(conversation.organizationId, orgId)))
    return "nudged"
  }

  /**
   * Resuelve los temas del hilo que una persona del equipo ya respondió (un
   * saliente suyo aceptado después de crearse el tema y de la última vez que
   * la persona volvió a preguntar) cuando la persona lleva `closeAfterHours`
   * sin escribir. Devuelve si ya no le queda ningún tema abierto.
   */
  async function settleAnsweredTopics(inner: Db, row: CareRow): Promise<boolean> {
    const silentSince = row.lastInboundAt ?? row.attentionStartedAt
    if (now.getTime() - silentSince.getTime() < cfg.closeAfterHours * HOUR_MS) return false
    const answered = await inner.execute<{ task_id: string }>(sql`
      select h.task_id from agent_handoff h
      where h.organization_id = ${orgId} and h.conversation_id = ${row.id} and h.task_id is not null
        and ${handoffOpenSql(sql.raw("h"))}
        and exists (select 1 from message m where m.organization_id = h.organization_id and m.conversation_id = h.conversation_id
          and m.sender_kind = 'user' and ${acceptedOutSql(sql.raw("m"))}
          and m.created_at > greatest(h.created_at, coalesce(h.asked_again_at, '-infinity'::timestamptz)))`)
    for (const item of answered) {
      await updateTask(inner, orgId, item.task_id, { status: "done" })
      await inner
        .update(crmTask)
        .set({ settledReason: "Respondido por el equipo; la persona no volvió a preguntar" })
        .where(and(eq(crmTask.id, item.task_id), eq(crmTask.organizationId, orgId)))
    }
    return (await countOpenHandoffsOf(inner, orgId, row.id)) === 0
  }

  /**
   * La fila se leyó al empezar el ciclo; antes de escribir o cerrar se bloquea
   * y se comprueba que la persona no escribió entretanto ni la cerró alguien.
   * Sin esto, un mensaje que entra en ese momento quedaba en una conversación
   * cerrada y fuera de «Te espera».
   */
  async function stillQuiet(inner: Db, row: CareRow): Promise<boolean> {
    const [fresh] = await inner
      .select({ status: conversation.status, lastInboundAt: conversation.lastInboundAt })
      .from(conversation)
      .where(and(eq(conversation.id, row.id), eq(conversation.organizationId, orgId)))
      .for("update")
    if (!fresh || fresh.status !== "open") return false
    return (fresh.lastInboundAt?.getTime() ?? 0) === (row.lastInboundAt?.getTime() ?? 0)
  }

  function format(text: string, channel: string): string {
    return deps.format ? deps.format(text, channel, { emojis: cfg.emojis }) : text
  }
}

/** ¿Esta atención dejó una cita en pie? La reservada por Sofi o desde el enlace de la conversación. */
async function bookedInAttention(tx: Db, orgId: string, row: Pick<CareRow, "id" | "attentionStartedAt">): Promise<boolean> {
  const [found] = await tx.execute<{ id: string }>(sql`
    select a.id from appointment a
    where a.organization_id = ${orgId} and a.conversation_id = ${row.id}::uuid
      and a.created_at >= ${row.attentionStartedAt.toISOString()}::timestamptz
      and a.status in ('programada', 'confirmada', 'atendida')
    limit 1`)
  return !!found
}

async function lastMessageOf(tx: Db, id: string) {
  const [last] = await tx
    .select({ id: message.id, direction: message.direction, senderKind: message.senderKind, body: message.body, createdAt: message.createdAt, accepted: sql<boolean>`${acceptedOutSql(sql.raw('"message"'))}` })
    .from(message)
    .where(eq(message.conversationId, id))
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(1)
  if (!last || !last.accepted) return null
  // Lo que escribió una línea del Administrador no es un turno del agente.
  const [job] = await tx.select({ id: automationJob.id }).from(automationJob).where(eq(automationJob.sentMessageId, last.id)).limit(1)
  return { ...last, automatic: !!job }
}

async function pendingProposalOf(tx: Db, id: string) {
  const [row] = await tx
    .select({ action: agentProposal.action, payload: agentProposal.payload })
    .from(agentProposal)
    .where(and(eq(agentProposal.conversationId, id), proposalPendingSql(sql.raw('"agent_proposal"'))))
    .orderBy(desc(agentProposal.createdAt))
    .limit(1)
  return row ?? null
}

/** ¿El último turno del agente ofreció algo (horarios, una cita, el enlace)? Se lee del libro de corridas. */
async function offeredInLastTurn(tx: Db, id: string, before: Date): Promise<boolean> {
  const [row] = await tx.execute<{ tools: string[] | null }>(sql`
    select tools_used as tools from agent_run_ledger
    where conversation_id = ${id} and status in ('ok', 'handoff') and started_at <= ${before.toISOString()}::timestamptz
    order by started_at desc limit 1`)
  return (row?.tools ?? []).some((tool) => OFFER_TOOLS.has(tool))
}

/** Un texto fijo por la conversación, sin modelo. */
async function sendFixed(
  tx: Db,
  orgId: string,
  id: string,
  text: string,
  as: { senderKind: "agent" } | { senderKind: "user"; senderUserId: string },
): Promise<void> {
  await sendOutbound(tx, orgId, {
    conversationId: id,
    senderKind: as.senderKind,
    senderUserId: as.senderKind === "user" ? as.senderUserId : null,
    content: { type: "text", text },
  })
}


import type { Db } from "@odentia/db"
import { agentCaseMemory, agentHandoff, agentProposal, type AgentCaseNote } from "@odentia/db/schema/agent"
import { member } from "@odentia/db/schema/auth"
import { automationJob } from "@odentia/db/schema/automation"
import { channelConnection, contact, conversation, message } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { getBranchHours } from "./agent-clinic-info.js"
import { claimHandoff } from "./agent-operations.js"
import { type AgentConfig, getAgentConfig } from "./agentConfig.js"
import {
  acceptedOutSql,
  handoffOpenExistsSql,
  lastAcceptedOutSql,
  proposalPendingExistsSql,
  unansweredSql,
} from "./conversation-state.js"
import { sendOutbound } from "./conversations.js"
import { createContactNote } from "./crm-workspace.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { handoffOpenSql } from "./handoff-state.js"
import { findOrgLocale, formatZoned } from "./locale.js"
import {
  isOpportune,
  lastOpportuneAtOrBefore,
  nextOpportuneFrom,
  type MinuteRange,
  type OpportuneSchedule,
} from "./opportune-hours.js"
import { proposalPendingSql } from "./proposal-state.js"
import { updateTask } from "./tasks.js"
import { createWorkspaceNotification } from "./workspace.js"

/**
 * Ninguna conversación queda abierta (ADR 0024): el agente la cierra con una
 * despedida cordial cuando termina o cuando la persona deja de responder, el
 * equipo la resuelve o la cierra, y todo mensaje de la persona la reabre
 * (`reopenIfClosed`, en `conversations.ts`). Aquí viven el cierre, lo que pasa
 * al cerrar, «Tomar» y «Devolver al agente», y el ciclo que insiste y cierra.
 */

export const CONVERSATION_CLOSE_REASONS = ["resuelta", "sin_respuesta", "equipo", "manual"] as const
export type ConversationCloseReason = (typeof CONVERSATION_CLOSE_REASONS)[number]

/** Horas desde el último mensaje del agente tras las que insiste, una sola vez por atención. */
export const NUDGE_AFTER_HOURS = 3
/** Límites de `close_after_hours`: la ventana de WhatsApp es de 24 horas. */
export const CLOSE_AFTER_HOURS_MIN = 6
export const CLOSE_AFTER_HOURS_MAX = 23
/** Margen para escribir sin mensaje aprobado: WhatsApp corta a las 24 horas del último entrante. */
export const WRITE_WINDOW_HOURS = 23
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
  const first = displayName?.trim().split(/\s+/)[0] ?? ""
  if (!first || first.length > 30 || /[\d@+_]/.test(first) || !/\p{L}/u.test(first)) return null
  return first
}

function withName(name: string | null, sentence: string): string {
  if (!name) return sentence
  // «Ana, cuando quieras…» / «Ana, ¿te reservo…?»: tras el nombre la frase sigue en minúscula.
  const lowered = sentence.startsWith("¿") ? `¿${sentence.charAt(1).toLowerCase()}${sentence.slice(2)}` : `${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`
  return `${name}, ${lowered}`
}

/**
 * La despedida al cerrar, fija y en la voz de la clínica: dice que estamos
 * atentos si quiere contactarnos (nunca «te dejo por ahora»).
 */
export function farewellText(voice: ClinicVoice, name: string | null): string {
  const usted = voice.treatment === "usted"
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
 * Instagram solo dentro de las 23 horas desde su último entrante (margen
 * sobre las 24 del proveedor); en los demás canales, siempre que la conexión
 * esté activa.
 */
export function canWriteNow(
  thread: { provider: string; connectionStatus: string; lastInboundAt: Date | null },
  now: Date,
): boolean {
  if (thread.connectionStatus !== "active") return false
  if (!WINDOWED_PROVIDERS.has(thread.provider)) return true
  return !!thread.lastInboundAt && now.getTime() - thread.lastInboundAt.getTime() < WRITE_WINDOW_HOURS * HOUR_MS
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
  equipo: "Caso derivado resuelto por el equipo al resolver la conversación.",
  manual: "Caso derivado cerrado sin resolver: se cerró la conversación.",
}

/**
 * Cierra una conversación con su motivo. Es la única forma de cerrar: con
 * cualquier motivo vencen las propuestas pendientes del hilo, se quita la
 * asignación y el agente vuelve a quedar encendido; las derivaciones abiertas
 * se completan solo si cierra el equipo (`equipo`, `manual`), con nota en la
 * ficha; y las notas del caso de esta atención pasan al historial: la
 * siguiente recibe una sola línea con cómo terminó. No envía nada: la
 * despedida, si corresponde, sale antes. Devuelve false si ya estaba cerrada.
 */
export async function closeConversationWith(
  tx: Db,
  orgId: string,
  id: string,
  input: { reason: ConversationCloseReason; byUserId: string | null; now?: Date },
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
    text: `Atención anterior: cerrada el ${formatZoned(now, zone)}; ${ENDED_WORDS[input.reason]}.`,
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

async function countOpenHandoffsOf(tx: Db, orgId: string, id: string): Promise<number> {
  const [row] = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from agent_handoff h
    where h.organization_id = ${orgId} and h.conversation_id = ${id} and ${handoffOpenSql(sql.raw("h"))}`)
  return row?.n ?? 0
}

async function countPendingProposalsOf(tx: Db, orgId: string, id: string): Promise<number> {
  const [row] = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from agent_proposal p
    where p.organization_id = ${orgId} and p.conversation_id = ${id} and ${proposalPendingSql(sql.raw("p"))}`)
  return row?.n ?? 0
}

export interface ResolvePreview {
  /** Al resolver sale la despedida: falso si ya pasaron más de 23 horas del último entrante o el canal no deja escribir. */
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
    farewellText: farewell ? farewellText(clinicVoiceOf(cfg), greetingName(thread.contactName)) : null,
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
 * Tras completar la tarea de una derivación: si el hilo sigue abierto y no
 * le queda otra derivación sin resolver, el equipo lo resolvió.
 */
export async function resolveAfterHandoffTask(tx: Db, orgId: string, taskId: string, actorUserId: string | null): Promise<boolean> {
  const [handoff] = await tx
    .select({ conversationId: agentHandoff.conversationId })
    .from(agentHandoff)
    .where(and(eq(agentHandoff.organizationId, orgId), eq(agentHandoff.taskId, taskId)))
    .limit(1)
  const conversationId = handoff?.conversationId
  if (!conversationId) return false
  const [thread] = await tx
    .select({ status: conversation.status })
    .from(conversation)
    .where(and(eq(conversation.id, conversationId), eq(conversation.organizationId, orgId)))
    .limit(1)
  if (thread?.status !== "open") return false
  if ((await countOpenHandoffsOf(tx, orgId, conversationId)) > 0) return false
  await resolveConversationByTeam(tx, orgId, conversationId, actorUserId)
  return true
}

/* ------------------------------ Tomar y devolver ------------------------------ */

/**
 * «Tomar»: la conversación pasa a quien la toma, el agente se apaga en el hilo
 * y las derivaciones abiertas quedan a su nombre.
 */
export async function takeConversation(tx: Db, orgId: string, id: string, userId: string): Promise<void> {
  const [membership] = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
    .limit(1)
  if (!membership) throw validation("Solo un miembro de la organización puede tomar la conversación")
  const thread = await threadForWriting(tx, orgId, id)
  const now = new Date()
  await tx
    .update(conversation)
    .set({ assignedUserId: userId, agentStatus: "off", updatedAt: now })
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
 * «Devolver al agente»: sin asignación y con el agente encendido. Con un caso
 * derivado abierto no se devuelve: antes se resuelve o se deja con el equipo.
 */
export async function releaseConversation(tx: Db, orgId: string, id: string, actorUserId: string | null): Promise<void> {
  const thread = await threadForWriting(tx, orgId, id)
  if ((await countOpenHandoffsOf(tx, orgId, id)) > 0) {
    throw new ServiceError("HANDOFF_OPEN", 409, "Resuelve antes el caso o déjalo con el equipo")
  }
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

/* ------------------------------ El ciclo: insistir y cerrar ------------------------------ */

export interface ConversationCareDeps {
  /** Formato del canal (`formatForChannel` del agente): marcas y emojis según el canal y la voz de la clínica. */
  format?: (text: string, channel: string | null, opts: { emojis: "no" | "pocos" }) => string
}

export interface ConversationCareSummary {
  nudged: number
  closed: number
  noticed: number
}

/** El horario oportuno de la clínica, leído una vez por ciclo. */
export async function opportuneScheduleOf(
  tx: Db,
  orgId: string,
  cfg: Pick<AgentConfig, "activeFromMin" | "activeUntilMin">,
  now: Date,
): Promise<OpportuneSchedule> {
  const zone = await findOrgLocale(tx, orgId)
  const branches = await getBranchHours(tx, orgId, now)
  const week: MinuteRange[][] = Array.from({ length: 7 }, () => [])
  for (const branch of branches) {
    for (const day of branch.week) week[day.weekday]?.push(...day.ranges)
  }
  return {
    timeZone: zone.timezone,
    week,
    agent:
      cfg.activeFromMin !== null && cfg.activeUntilMin !== null
        ? { fromMin: cfg.activeFromMin, untilMin: cfg.activeUntilMin }
        : null,
  }
}

/**
 * Cuándo cerrar por silencio: a `closeAfterHours` desde que la persona calló
 * (su último entrante, o el inicio de la atención si fue después) o, si esa
 * hora no es oportuna, en la última oportuna anterior; nunca antes del
 * mínimo ni antes de una hora después de insistir.
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
 *   atiende) y sin derivación abierta: no se cierra sola; pasadas
 *   `closeAfterHours` sin mensajes, avisa una vez por atención a esa persona o
 *   a recepción.
 */
export async function tickConversationCare(
  tx: Db,
  orgId: string,
  now: Date,
  deps: ConversationCareDeps = {},
): Promise<ConversationCareSummary> {
  const summary: ConversationCareSummary = { nudged: 0, closed: 0, noticed: 0 }
  const cfg = await getAgentConfig(tx, orgId)
  if (!cfg.enabled) return summary
  const conv = sql.raw('"conversation"')
  // Antes de 3 horas sin mensajes no hay nada que hacer: ni insistir ni cerrar.
  const quietSince = new Date(now.getTime() - NUDGE_AFTER_HOURS * HOUR_MS)
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
        sql`coalesce(${conversation.lastMessageAt}, ${conversation.attentionStartedAt}) <= ${quietSince.toISOString()}::timestamptz`,
      ),
    )
  if (rows.length === 0) return summary
  const schedule = await opportuneScheduleOf(tx, orgId, cfg, now)
  const zone = await findOrgLocale(tx, orgId)
  const voice = clinicVoiceOf(cfg)
  const silenceMs = cfg.closeAfterHours * HOUR_MS
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
    if (outcome === "noticed") summary.noticed++
  }
  return summary

  async function careFor(inner: Db, row: CareRow): Promise<"nudged" | "closed" | "noticed" | null> {
    if (row.handoffOpen) return null
    const attended = cfg.channels === null || cfg.channels.includes(row.channel)
    const personInCharge = row.assignedUserId !== null || row.agentStatus === "off" || !attended
    if (personInCharge) {
      const lastActivity = Math.max(row.lastMessageAt?.getTime() ?? 0, row.attentionStartedAt.getTime())
      if (now.getTime() - lastActivity < silenceMs) return null
      return (await noticeInCharge(inner, row)) ? "noticed" : null
    }
    if (row.unanswered || !row.hasAcceptedOut) return null
    const silenceFrom = new Date(Math.max(row.lastInboundAt?.getTime() ?? 0, row.attentionStartedAt.getTime()))
    const closeAt = silenceCloseAt({ silenceFrom, nudgedAt: row.nudgedAt, closeAfterHours: cfg.closeAfterHours, schedule })
    const writable = canWriteNow(row, now)
    if (now.getTime() >= closeAt.getTime()) {
      if (writable) await sendFixed(inner, orgId, row.id, format(farewellText(voice, greetingName(row.contactName)), row.channel), { senderKind: "agent" })
      await closeConversationWith(inner, orgId, row.id, { reason: "sin_respuesta", byUserId: null, now })
      return "closed"
    }
    if (row.nudgedAt || !writable || !isOpportune(now, schedule)) return null
    const last = await lastMessageOf(inner, row.id)
    if (!last || last.senderKind !== "agent" || last.automatic) return null
    if (now.getTime() - last.createdAt.getTime() < NUDGE_AFTER_HOURS * HOUR_MS) return null
    const proposed = await pendingProposalOf(inner, row.id)
    const offered = await offeredInLastTurn(inner, row.id, last.createdAt)
    const asks = (last.body ?? "").trim().endsWith("?")
    if (!row.proposalPending && !asks && !offered) return null
    const when = proposed ? proposalWhen(proposed.payload["startsAt"], zone) : null
    const text = nudgeText(voice, greetingName(row.contactName), proposed && when ? { action: proposed.action, when } : null)
    await sendFixed(inner, orgId, row.id, format(text, row.channel), { senderKind: "agent" })
    await inner
      .update(conversation)
      .set({ nudgedAt: now })
      .where(and(eq(conversation.id, row.id), eq(conversation.organizationId, orgId)))
    return "nudged"
  }

  function format(text: string, channel: string): string {
    return deps.format ? deps.format(text, channel, { emojis: cfg.emojis }) : text
  }

  async function noticeInCharge(inner: Db, row: CareRow): Promise<boolean> {
    const recipients = row.assignedUserId ? [row.assignedUserId] : await receptionUserIds(inner, orgId)
    const name = row.contactName.trim() || "la persona"
    const hours = cfg.closeAfterHours
    for (const userId of recipients) {
      await createWorkspaceNotification(inner, orgId, {
        userId,
        // Una vez por atención: la misma clave no vuelve a avisar.
        dedupeKey: `conversation-open:${row.id}:${row.attentionStartedAt.getTime()}`,
        title: `La conversación con ${name} sigue abierta: ciérrala o continúa`.slice(0, 200),
        body: `Pasaron ${hours} horas sin mensajes. Si ya terminó, ciérrala con «Resolver»; si no, escríbele.`,
        href: `/inbox?conversation=${row.id}`,
        permission: "conversations.read",
      })
    }
    return recipients.length > 0
  }
}

/** A quién avisar si nadie tiene la conversación: recepción; si no hay, quien administra. */
async function receptionUserIds(tx: Db, orgId: string): Promise<string[]> {
  const reception = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.role, "reception")))
    .limit(20)
  if (reception.length) return reception.map((row) => row.userId)
  const admins = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, orgId), inArray(member.role, ["owner", "admin"])))
    .limit(20)
  return admins.map((row) => row.userId)
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


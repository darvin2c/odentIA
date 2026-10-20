import type { Db } from "@odentia/db"
import { appointment } from "@odentia/db/schema/agenda"
import { member, user } from "@odentia/db/schema/auth"
import { patientContact, patient as patientTable, treatmentBudget } from "@odentia/db/schema/clinical"
import {
  channelConnection,
  contact,
  conversation,
  crmTask,
  message,
  pipelineStage,
} from "@odentia/db/schema/crm"
import { agentHandoff, agentProposal } from "@odentia/db/schema/agent"
import { crmNote } from "@odentia/db/schema/crm-workspace"
import { opportunity, opportunityEvent } from "@odentia/db/schema/opportunities"
import { auditEvent, branch, orgProfile } from "@odentia/db/schema/org"
import { and, asc, desc, eq, gt, inArray, or, sql, type SQL, type SQLWrapper } from "drizzle-orm"
import { getAgentConfig } from "./agentConfig.js"
import { getMessagePermissions } from "./automation.js"
import { NEUTRAL_TIMEZONE } from "./locale.js"
import { getContact, requireContact, type ContactFull } from "./contacts.js"
import { notFound, validation } from "./errors.js"
import { agentAttendingSql, handoffOpenExistsSql, proposalPendingExistsSql } from "./conversation-state.js"
import { listOpportunities, type OpportunityListItem } from "./opportunities.js"
import { proposalPendingSql } from "./proposal-state.js"
import type { TaskItem } from "./tasks.js"
import { joinPatientPerson, patientPerson } from "./patient-identity.js"

/* ------------------------------------------------------------------ */
/* Superficie operativa del CRM (paso P1): contexto + actividad +      */
/* notas + presupuestos mínimos. Lee contratos de actividad/contexto.  */
/* Servidor y tenant-safe: todo filtra por organizationId bajo RLS;    */
/* jamás teléfono como identidad, jamás clínica/finanzas completas.    */
/* ------------------------------------------------------------------ */

/** Capacidades derivadas del memberRole en la ruta; jamás del cliente. */
export interface CrmCapabilities {
  conversations: boolean
  tasks: boolean
  agent: boolean
  /** Ve la agenda: recibe la próxima cita de la persona. */
  appointments?: boolean
}

export type CrmActivityKind = "message" | "note" | "task" | "opportunity" | "proposal" | "handoff"

export interface CrmActivityItem {
  id: string
  kind: CrmActivityKind
  at: string
  title: string
  body: string | null
  actorName: string | null
  channel: string | null
  conversationId: string | null
  opportunityId: string | null
  taskId: string | null
  status: string | null
}

export interface CrmAgentState {
  state: "agent" | "human" | "approval" | "handoff" | "closed"
  enabled: boolean
  conversationId: string | null
  reason: string | null
  /** Solo con agent.read; sin permiso informa el estado con lista vacía. */
  pendingProposalIds: string[]
  /** Hay una cita propuesta que espera el sí del interlocutor, sea cual sea el estado. */
  awaitingContact: boolean
}

/** La próxima cita en pie de la persona o de quien ella lleva, para «Contexto». */
export interface CrmNextAppointment {
  id: string
  patientId: string
  patientName: string
  startsAt: string
  status: string
  branchName: string
  timeZone: string
  dentistName: string
  serviceName: string | null
}

export interface CrmContactWorkspace {
  contact: ContactFull
  opportunities: { items: OpportunityListItem[]; nextCursor: string | null }
  tasks: TaskItem[]
  agent: CrmAgentState
  activity: { items: CrmActivityItem[]; nextCursor: string | null }
  /** Solo para quien ve la agenda; null si no tiene ninguna por venir. */
  nextAppointment: CrmNextAppointment | null
  /**
   * Lo que dijo de cada tipo de mensaje (null: nunca dijo nada). `recordatorio` y
   * `seguimiento` son parte del servicio: solo cuenta si se dio de baja (false);
   * `novedades` es el único que pide su permiso (ADR 0030).
   */
  messages: { recordatorio: boolean | null; seguimiento: boolean | null; novedades: boolean | null; avisos: boolean | null }
}

/**
 * La próxima cita en pie de los pacientes de esta persona (ella misma o a
 * quien lleva): cuándo, dónde y con quién. Se calcula al leer.
 */
async function nextAppointmentOf(tx: Db, orgId: string, contactId: string): Promise<CrmNextAppointment | null> {
  const [row] = await tx
    .select({
      id: appointment.id,
      patientId: appointment.patientId,
      patientName: patientPerson.displayName,
      startsAt: appointment.startsAt,
      status: appointment.status,
      branchName: branch.name,
      branchZone: branch.timezone,
      orgZone: orgProfile.timezone,
      dentistName: user.name,
      serviceName: appointment.serviceName,
    })
    .from(appointment)
    .innerJoin(
      patientContact,
      and(
        eq(patientContact.patientId, appointment.patientId),
        eq(patientContact.organizationId, orgId),
        eq(patientContact.contactId, contactId),
      ),
    )
    .innerJoin(patientTable, and(eq(patientTable.id, appointment.patientId), eq(patientTable.organizationId, orgId)))
    .innerJoin(patientPerson, joinPatientPerson(patientPerson))
    .innerJoin(branch, and(eq(branch.id, appointment.branchId), eq(branch.organizationId, orgId)))
    .leftJoin(orgProfile, eq(orgProfile.organizationId, appointment.organizationId))
    .innerJoin(user, eq(user.id, appointment.dentistUserId))
    .where(
      and(
        eq(appointment.organizationId, orgId),
        inArray(appointment.status, ["programada", "confirmada"]),
        gt(appointment.startsAt, new Date()),
      ),
    )
    .orderBy(asc(appointment.startsAt), asc(appointment.id))
    .limit(1)
  if (!row) return null
  return {
    id: row.id,
    patientId: row.patientId,
    patientName: row.patientName,
    startsAt: row.startsAt.toISOString(),
    status: row.status,
    branchName: row.branchName,
    timeZone: row.branchZone ?? row.orgZone ?? NEUTRAL_TIMEZONE,
    dentistName: row.dentistName,
    serviceName: row.serviceName,
  }
}

export interface CrmBudgetOption {
  id: string
  title: string
  status: string
}

/** Presupuestos visibles en CRM: presentados o decididos. Nunca borradores (salvo finance.read), nunca importes/líneas/notas. */
const CRM_BUDGET_STATUSES = ["presentado", "aceptado", "parcial", "rechazado", "pospuesto"] as const

const ACTIVITY_DEFAULT_LIMIT = 30
const ACTIVITY_MAX_LIMIT = 100
const NOTE_MAX_LENGTH = 2000

function assertUuid(value: string, mensaje: string): void {
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw validation(mensaje)
}

/** Aviso en vivo (`org_events`): solo `{ orgId, kind, at }`, sin PII. */
async function notify(tx: Db, payload: { orgId: string; kind: string; at: string }): Promise<void> {
  await tx.execute(sql`select pg_notify('org_events', ${JSON.stringify(payload)})`)
}

/* ------------------------- Cursor keyset ------------------------- */

function activityFingerprint(contactId: string, caps: CrmCapabilities): string {
  const m = `${caps.conversations ? 1 : 0}${caps.tasks ? 1 : 0}${caps.agent ? 1 : 0}`
  return JSON.stringify({ c: contactId, m })
}

function encodeActivityCursor(at: string, id: string, fingerprint: string): string {
  return Buffer.from(JSON.stringify({ at, id, f: fingerprint }), "utf8").toString("base64url")
}

function decodeActivityCursor(cursor: string): { at: string; id: string; f: string } | null {
  try {
    const raw: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
    if (!raw || typeof raw !== "object") return null
    const { at, id, f } = raw as Record<string, unknown>
    if (typeof at !== "string" || typeof id !== "string" || typeof f !== "string") return null
    if (!isPreciseTimestamp(at)) return null
    return { at, id, f }
  } catch {
    return null
  }
}

const PRECISE_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/

/** toISOString pierde microsegundos; el cursor exige precisión completa. */
function isPreciseTimestamp(value: string): boolean {
  return PRECISE_TS.test(value) && !Number.isNaN(Date.parse(value))
}

/**
 * `at` con microsegundos en UTC: el driver devuelve Date (solo ms) y
 * toISOString truncaría filas del mismo milisegundo en el keyset.
 */
function atColumn(column: SQLWrapper): SQL<string> {
  return sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
}

/**
 * Predicado keyset global sobre (at DESC, idCombinado DESC), donde
 * idCombinado = `${prefijo}:${uuid}`. Cada fuente pagina en SQL con este
 * predicado: la unión nunca se trunca en memoria sin cursor. El `at` del
 * cursor viaja como texto con microsegundos y se compara en Postgres
 * (Date de JS no tiene esa precisión).
 */
function keysetPredicate(
  at: SQLWrapper,
  mergedId: SQLWrapper,
  cursor: { at: string; id: string },
): SQL {
  if (!isPreciseTimestamp(cursor.at)) throw validation("Cursor inválido")
  return sql`(${at} < ${cursor.at}::timestamptz or (${at} = ${cursor.at}::timestamptz and ${mergedId} < ${cursor.id}))`
}

/** Nombres de miembros de la org (tenant-safe vía join a member). */
async function resolveMemberNames(
  tx: Db,
  orgId: string,
  userIds: Iterable<string | null | undefined>,
): Promise<Map<string, string>> {
  const ids = [...new Set([...userIds].filter((v): v is string => !!v))]
  const out = new Map<string, string>()
  if (ids.length === 0) return out
  const rows = await tx
    .select({ userId: member.userId, name: user.name })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(member.organizationId, orgId), inArray(member.userId, ids)))
  for (const row of rows) out.set(row.userId, row.name)
  return out
}

/* ------------------------- Estado del agente ------------------------- */

async function resolveAgentState(
  tx: Db,
  orgId: string,
  contactId: string,
  conversationIdOpt: string | null,
  caps: CrmCapabilities,
): Promise<CrmAgentState> {
  const cfg = await getAgentConfig(tx, orgId)
  // El nombre del agente de recepción de esta clínica (Sofi, o el que eligió).
  const sofi = cfg.personaName
  let convRow: typeof conversation.$inferSelect | null = null
  if (conversationIdOpt !== null) {
    assertUuid(conversationIdOpt, "Conversación inválida")
    const [found] = await tx
      .select()
      .from(conversation)
      .where(and(eq(conversation.id, conversationIdOpt), eq(conversation.organizationId, orgId)))
      .limit(1)
    if (!found || found.contactId !== contactId) {
      throw validation("La conversación no pertenece al contacto")
    }
    convRow = found
  } else {
    const [latest] = await tx
      .select()
      .from(conversation)
      .where(and(eq(conversation.organizationId, orgId), eq(conversation.contactId, contactId)))
      .orderBy(sql`"last_message_at" desc nulls last`, desc(conversation.id))
      .limit(1)
    convRow = latest ?? null
  }
  if (!convRow) {
    return {
      state: "human",
      enabled: cfg.enabled,
      conversationId: null,
      reason: cfg.enabled ? "Sin conversación vinculada" : `${sofi} no está atendiendo en la clínica`,
      pendingProposalIds: [],
      awaitingContact: false,
    }
  }
  if (convRow.status === "closed") {
    return {
      state: "closed",
      enabled: cfg.enabled,
      conversationId: convRow.id,
      reason: "Conversación cerrada",
      pendingProposalIds: [],
      awaitingContact: false,
    }
  }
  // Lo que espera el hilo, con las mismas reglas que la Bandeja (`conversation-state.ts`).
  const conv = sql.raw('"conversation"')
  const [shared] = await tx
    .select({
      pending: sql<boolean>`${proposalPendingExistsSql(conv)}`,
      handoff: sql<boolean>`${handoffOpenExistsSql(conv)}`,
      attending: sql<boolean>`${agentAttendingSql(conv)}`,
    })
    .from(conversation)
    .where(and(eq(conversation.id, convRow.id), eq(conversation.organizationId, orgId)))
    .limit(1)
  // Estado operativo mínimo: la existencia de pendientes se informa aunque
  // el rol no tenga agent.read; los ids solo con permiso. Viajan con cualquier
  // estado: la cita que espera el sí puede registrarse aunque la lleve una persona.
  const pending = shared?.pending && caps.agent
    ? await tx
        .select({ id: agentProposal.id })
        .from(agentProposal)
        .where(
          and(
            eq(agentProposal.organizationId, orgId),
            eq(agentProposal.conversationId, convRow.id),
            proposalPendingSql(sql.raw('"agent_proposal"')),
          ),
        )
        .limit(10)
    : []
  const pendingProposalIds = pending.map((p) => p.id)
  const awaitingContact = !!shared?.pending
  // El mismo orden que la Bandeja (`conversationWords`): el caso que pasó el
  // agente, después una persona a cargo y luego la cita que espera el sí.
  if (shared?.handoff) {
    return {
      state: "handoff",
      enabled: cfg.enabled,
      conversationId: convRow.id,
      reason: "Te lo pasó el agente; falta resolverlo",
      pendingProposalIds,
      awaitingContact,
    }
  }
  if (convRow.agentStatus === "off" || convRow.assignedUserId !== null) {
    return {
      state: "human",
      enabled: cfg.enabled,
      conversationId: convRow.id,
      reason: "Atiende recepción",
      pendingProposalIds,
      awaitingContact,
    }
  }
  if (awaitingContact) {
    return {
      state: "approval",
      enabled: cfg.enabled,
      conversationId: convRow.id,
      reason: `Propuesta de ${sofi} que espera la confirmación del interlocutor`,
      pendingProposalIds,
      awaitingContact,
    }
  }
  if (!shared?.attending) {
    return {
      state: "human",
      enabled: cfg.enabled,
      conversationId: convRow.id,
      reason: cfg.enabled ? `${sofi} no atiende este canal` : `${sofi} no está atendiendo en la clínica`,
      pendingProposalIds: [],
      awaitingContact: false,
    }
  }
  return {
    state: "agent",
    enabled: true,
    conversationId: convRow.id,
    reason: `Atiende ${sofi}`,
    pendingProposalIds: [],
    awaitingContact: false,
  }
}

/** Notas operativas del interlocutor, sin datos clínicos ni otro contacto. */
export async function listContactNotes(
  tx: Db,
  orgId: string,
  contactId: string,
  opts: { limit?: number; cursor?: string } = {},
): Promise<{ items: { id: string; at: string; body: string }[]; nextCursor: string | null }> {
  await requireContact(tx, orgId, contactId)
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 50))
  const fingerprint = JSON.stringify({ notes: contactId })
  const cursor = opts.cursor ? decodeActivityCursor(opts.cursor) : null
  if (opts.cursor && (!cursor || cursor.f !== fingerprint)) throw validation("Cursor de notas inválido")
  const conditions = [eq(crmNote.organizationId, orgId), eq(crmNote.contactId, contactId)]
  if (cursor) conditions.push(keysetPredicate(crmNote.createdAt, crmNote.id, cursor))
  const rows = await tx.select({ id: crmNote.id, at: atColumn(crmNote.createdAt), body: crmNote.body })
    .from(crmNote).where(and(...conditions))
    .orderBy(desc(crmNote.createdAt), desc(crmNote.id)).limit(limit + 1)
  const items = rows.slice(0, limit)
  const last = items[items.length - 1]
  return {
    items,
    nextCursor: rows.length > limit && last ? encodeActivityCursor(last.at, last.id, fingerprint) : null,
  }
}

/* ------------------------- Actividad unificada ------------------------- */

async function contactConversationIds(tx: Db, orgId: string, contactId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: conversation.id })
    .from(conversation)
    .where(and(eq(conversation.organizationId, orgId), eq(conversation.contactId, contactId)))
  return rows.map((r) => r.id)
}

interface TaskTransition {
  title: string | null
  statusPrev: string | null
  statusNext: string | null
  dueAtPrev: string | null
  dueAtNext: string | null
  contactId: string | null
  conversationId: string | null
  opportunityId: string | null
}

/**
 * Extrae la transición que escribe updateTask (action task.updated), sin
 * inventar valores cuando la auditoría no conserva un dato.
 */
function readTaskTransition(metadata: unknown): TaskTransition {
  const meta = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown> : null
  const text = (key: string): string | null => {
    const value = meta?.[key]
    return typeof value === "string" && value.length > 0 ? value : null
  }
  return {
    title: text("title"),
    statusPrev: text("statusPrev"),
    statusNext: text("statusNext"),
    dueAtPrev: text("dueAtPrev"),
    dueAtNext: text("dueAtNext"),
    contactId: text("contactId"),
    conversationId: text("conversationId"),
    opportunityId: text("opportunityId"),
  }
}

/** Vínculo de la metadata si es uuid válido; si no, el de la fila unida. */
function linkOr(meta: string | null, fallback: string | null): string | null {
  if (meta && /^[0-9a-f-]{36}$/i.test(meta)) return meta
  return fallback
}

/**
 * Título humano de la transición con el estado registrado en el evento
 * (nunca el vigente: la fila pudo cambiar después). Reprogramación =
 * cambio de vencimiento en tarea abierta.
 */
function transitionTitle(
  transition: TaskTransition,
  fallbackTitle: string,
  action: string,
): { title: string; body: string | null } {
  const name = transition.title ?? fallbackTitle
  if (action !== "task.updated") return { title: `Actualización de tarea: ${name}`, body: null }
  if (transition.statusNext === "done" && transition.statusPrev !== "done") {
    return { title: `Tarea completada: ${name}`, body: null }
  }
  if (transition.statusNext === "cancelled" && transition.statusPrev !== "cancelled") {
    return { title: `Tarea cancelada: ${name}`, body: null }
  }
  if ((transition.dueAtPrev ?? null) !== (transition.dueAtNext ?? null)) {
    return {
      title: `Tarea reprogramada: ${name}`,
      body: transition.dueAtNext ? `Nuevo vencimiento: ${transition.dueAtNext}` : "Sin vencimiento",
    }
  }
  return { title: `Tarea actualizada: ${name}`, body: null }
}

const OPPORTUNITY_ACTION_TITLES: Record<string, string> = {
  "opportunity.created": "Oportunidad creada",
  "opportunity.moved": "Etapa actualizada",
  "opportunity.won": "Oportunidad ganada",
  "opportunity.lost": "Oportunidad perdida",
  "opportunity.reopened": "Oportunidad reabierta",
  "opportunity.updated": "Oportunidad actualizada",
}

const PROPOSAL_EVENT_LABEL: Record<string, { title: string; status: string | null }> = {
  "agent.proposal_created": { title: "Propuesta generada", status: null },
  "agent.proposal_approved": { title: "Propuesta aprobada por el equipo", status: "aprobada" },
  "agent.proposal_rejected": { title: "Propuesta rechazada", status: "rechazada" },
  "agent.proposal_confirmed": { title: "Propuesta confirmada por el interlocutor", status: "aprobada" },
  "agent.proposal_executed": { title: "Propuesta ejecutada", status: "ejecutada" },
  "agent.proposal_failed": { title: "Propuesta no ejecutada", status: "fallida" },
}

const PROPOSAL_EVENT_ACTIONS = Object.keys(PROPOSAL_EVENT_LABEL)

export async function listContactActivity(
  tx: Db,
  orgId: string,
  contactId: string,
  input: { cursor?: string; limit?: number; capabilities: CrmCapabilities },
): Promise<{ items: CrmActivityItem[]; nextCursor: string | null }> {
  const own = await requireContact(tx, orgId, contactId)
  const caps = input.capabilities
  const limit = Math.min(Math.max(input.limit ?? ACTIVITY_DEFAULT_LIMIT, 1), ACTIVITY_MAX_LIMIT)
  const fingerprint = activityFingerprint(contactId, caps)
  let cursor: { at: string; id: string } | null = null
  if (input.cursor) {
    const decoded = decodeActivityCursor(input.cursor)
    if (!decoded) throw validation("Cursor inválido")
    if (decoded.f !== fingerprint) throw validation("El cursor no corresponde a los filtros actuales")
    cursor = decoded
  }
  const perSource = limit + 1
  const merged: CrmActivityItem[] = []
  const convIds = await contactConversationIds(tx, orgId, contactId)

  // Mensajes de todos los canales con procedencia (solo con conversations.read).
  if (caps.conversations) {
    const mergedId: SQL = sql`('message:' || ${message.id}::text)`
    const conditions = [
      eq(message.organizationId, orgId),
      eq(conversation.organizationId, orgId),
      eq(conversation.contactId, contactId),
    ]
    if (cursor) conditions.push(keysetPredicate(message.createdAt, mergedId, cursor))
    const rows = await tx
      .select({ msg: message, channel: channelConnection.channel, at: atColumn(message.createdAt) })
      .from(message)
      .innerJoin(conversation, eq(message.conversationId, conversation.id))
      .innerJoin(channelConnection, eq(conversation.channelConnectionId, channelConnection.id))
      .where(and(...conditions))
      .orderBy(desc(message.createdAt), sql`('message:' || ${message.id}::text) desc`)
      .limit(perSource)
    const names = await resolveMemberNames(
      tx,
      orgId,
      rows.map((r) => r.msg.senderUserId),
    )
    for (const { msg, channel, at } of rows) {
      const inbound = msg.direction === "in"
      merged.push({
        id: `message:${msg.id}`,
        kind: "message",
        at,
        title: inbound ? "Mensaje entrante" : "Mensaje saliente",
        body:
          msg.body ??
          (msg.contentType === "template"
            ? `Plantilla ${msg.templateName ?? ""}`.trim()
            : "[adjunto]"),
        actorName: msg.senderUserId
          ? (names.get(msg.senderUserId) ?? null)
          : inbound
            ? own.displayName
            : msg.senderKind === "agent"
              ? "Agente"
              : null,
        channel,
        conversationId: msg.conversationId,
        opportunityId: null,
        taskId: null,
        status: msg.status,
      })
    }
  }

  // Notas operativas nuevas (tabla propia, inmutable).
  {
    const mergedId: SQL = sql`('note:' || ${crmNote.id}::text)`
    const conditions = [eq(crmNote.organizationId, orgId), eq(crmNote.contactId, contactId)]
    if (cursor) conditions.push(keysetPredicate(crmNote.createdAt, mergedId, cursor))
    const rows = await tx
      .select({ note: crmNote, at: atColumn(crmNote.createdAt) })
      .from(crmNote)
      .where(and(...conditions))
      .orderBy(desc(crmNote.createdAt), sql`('note:' || ${crmNote.id}::text) desc`)
      .limit(perSource)
    const names = await resolveMemberNames(
      tx,
      orgId,
      rows.map((r) => r.note.authorUserId),
    )
    for (const { note: row, at } of rows) {
      merged.push({
        id: `note:${row.id}`,
        kind: "note",
        at,
        title: "Nota operativa",
        body: row.body,
        actorName: row.authorUserId ? (names.get(row.authorUserId) ?? null) : null,
        channel: null,
        conversationId: row.conversationId,
        opportunityId: row.opportunityId,
        taskId: null,
        status: null,
      })
    }
  }

  // Tareas del contacto: creaciones (filas) + transiciones (auditoría).
  // La fila emite SOLO la creación; cada cambio vive en auditEvent con
  // action task.updated y metadata
  // {title,statusPrev,statusNext,dueAtPrev:ISO|null,dueAtNext:ISO|null,contactId,conversationId,opportunityId}.
  // El dominio no audita la creación: sin duplicados entre ambas fuentes.
  if (caps.tasks) {
    const taskScope = [eq(crmTask.contactId, contactId)]
    if (convIds.length > 0) taskScope.push(inArray(crmTask.conversationId, convIds))
    const taskMerged: SQL = sql`('task:' || ${crmTask.id}::text)`
    const taskConds = [eq(crmTask.organizationId, orgId), or(...taskScope)!]
    if (cursor) taskConds.push(keysetPredicate(crmTask.createdAt, taskMerged, cursor))
    const taskRows = await tx
      .select({ task: crmTask, at: atColumn(crmTask.createdAt) })
      .from(crmTask)
      .where(and(...taskConds))
      .orderBy(desc(crmTask.createdAt), sql`('task:' || ${crmTask.id}::text) desc`)
      .limit(perSource)
    for (const { task: row, at } of taskRows) {
      merged.push({
        id: `task:${row.id}`,
        kind: "task",
        at,
        title: `Tarea creada: ${row.title}`,
        body: "Creación de tarea",
        actorName: null,
        channel: null,
        conversationId: row.conversationId,
        opportunityId: row.opportunityId,
        taskId: row.id,
        status: null,
      })
    }
    // Transiciones con alcance resuelto en SQL (JOIN a la tarea del
    // contacto o de cualquiera de sus hilos): sin preconsultar ids de
    // tareas ni topes en memoria que pierdan historia.
    const auditMerged: SQL = sql`('task-audit:' || ${auditEvent.id}::text)`
    const auditConds = [
      eq(auditEvent.organizationId, orgId),
      eq(auditEvent.entity, "task"),
      eq(crmTask.organizationId, orgId),
      or(
        eq(crmTask.contactId, contactId),
        sql`${crmTask.conversationId} in (select "id" from "conversation" where "organization_id" = ${orgId} and "contact_id" = ${contactId})`,
      )!,
    ]
    if (cursor) auditConds.push(keysetPredicate(auditEvent.createdAt, auditMerged, cursor))
    const auditRows = await tx
      .select({
        audit: auditEvent,
        at: atColumn(auditEvent.createdAt),
        taskTitle: crmTask.title,
        taskContact: crmTask.contactId,
        taskConversation: crmTask.conversationId,
        taskOpportunity: crmTask.opportunityId,
      })
      .from(auditEvent)
      .innerJoin(crmTask, sql`${auditEvent.entityId} = ${crmTask.id}::text`)
      .where(and(...auditConds))
      .orderBy(desc(auditEvent.createdAt), sql`('task-audit:' || ${auditEvent.id}::text) desc`)
      .limit(perSource)
    const names = await resolveMemberNames(
      tx,
      orgId,
      auditRows.map((r) => r.audit.actorUserId),
    )
    for (const row of auditRows) {
      // La creación ya la emite la fuente de filas: nunca duplicarla aquí.
      if (row.audit.action === "task.created" || row.audit.action === "created") continue
      const transition = readTaskTransition(row.audit.metadata)
      const fallback = {
        title: row.taskTitle,
        contactId: row.taskContact,
        conversationId: row.taskConversation,
        opportunityId: row.taskOpportunity,
      }
      const human = transitionTitle(transition, fallback.title, row.audit.action)
      merged.push({
        id: `task-audit:${row.audit.id}`,
        kind: "task",
        at: row.at,
        title: human.title,
        body: human.body,
        actorName: row.audit.actorUserId ? (names.get(row.audit.actorUserId) ?? null) : null,
        channel: null,
        conversationId: linkOr(transition.conversationId, fallback.conversationId),
        opportunityId: linkOr(transition.opportunityId, fallback.opportunityId),
        taskId: row.audit.entityId,
        status: transition.statusNext,
      })
    }
  }

  // Movimientos de oportunidad (historial, sin importes).
  {
    const mergedId: SQL = sql`('opportunity:' || ${opportunityEvent.id}::text)`
    const conditions = [
      eq(opportunityEvent.organizationId, orgId),
      eq(opportunity.organizationId, orgId),
      eq(opportunity.contactId, contactId),
    ]
    if (cursor) conditions.push(keysetPredicate(opportunityEvent.createdAt, mergedId, cursor))
    const rows = await tx
      .select({ event: opportunityEvent, title: opportunity.title, at: atColumn(opportunityEvent.createdAt) })
      .from(opportunityEvent)
      .innerJoin(opportunity, eq(opportunityEvent.opportunityId, opportunity.id))
      .where(and(...conditions))
      .orderBy(desc(opportunityEvent.createdAt), sql`('opportunity:' || ${opportunityEvent.id}::text) desc`)
      .limit(perSource)
    const stageIds = [
      ...new Set(
        rows.flatMap((r) => [r.event.fromStageId, r.event.toStageId]).filter((v): v is string => !!v),
      ),
    ]
    const stageNames = new Map<string, string>()
    if (stageIds.length > 0) {
      const stages = await tx
        .select({ id: pipelineStage.id, name: pipelineStage.name })
        .from(pipelineStage)
        .where(inArray(pipelineStage.id, stageIds))
      for (const s of stages) stageNames.set(s.id, s.name)
    }
    const names = await resolveMemberNames(
      tx,
      orgId,
      rows.map((r) => r.event.actorUserId),
    )
    for (const { event, title, at } of rows) {
      const from = event.fromStageId ? (stageNames.get(event.fromStageId) ?? null) : null
      const to = event.toStageId ? (stageNames.get(event.toStageId) ?? null) : null
      merged.push({
        id: `opportunity:${event.id}`,
        kind: "opportunity",
        at,
        title: `${OPPORTUNITY_ACTION_TITLES[event.action] ?? "Oportunidad actualizada"} · ${title}`,
        body: event.note ?? (from || to ? `De ${from ?? "—"} a ${to ?? "—"}` : null),
        actorName: event.actorUserId ? (names.get(event.actorUserId) ?? null) : null,
        channel: null,
        conversationId: null,
        opportunityId: event.opportunityId,
        taskId: null,
        status: event.action,
      })
    }
  }

  // Propuestas del agente (timeline completa solo con agent.read).
  if (caps.agent) {
    const scope = [eq(agentProposal.contactId, contactId)]
    if (convIds.length > 0) scope.push(inArray(agentProposal.conversationId, convIds))
    const mergedId: SQL = sql`('proposal:' || ${agentProposal.id}::text)`
    const conditions = [eq(agentProposal.organizationId, orgId), or(...scope)!]
    conditions.push(sql`not exists (
      select 1 from audit_event where organization_id = ${orgId}
        and entity = 'agent_proposal' and action = 'agent.proposal_created'
        and entity_id = ${agentProposal.id}::text
    )`)
    if (cursor) conditions.push(keysetPredicate(agentProposal.createdAt, mergedId, cursor))
    const rows = await tx
      .select({ proposal: agentProposal, at: atColumn(agentProposal.createdAt) })
      .from(agentProposal)
      .where(and(...conditions))
      .orderBy(desc(agentProposal.createdAt), sql`('proposal:' || ${agentProposal.id}::text) desc`)
      .limit(perSource)
    for (const { proposal: row, at } of rows) {
      const payload = (row.payload ?? {}) as Record<string, unknown>
      const linkedOpp =
        typeof payload["opportunityId"] === "string" &&
        /^[0-9a-f-]{36}$/i.test(payload["opportunityId"] as string)
          ? (payload["opportunityId"] as string)
          : null
      merged.push({
        id: `proposal:${row.id}`,
        kind: "proposal",
        at,
        title: row.afterSummary ? `Propuesta: ${row.afterSummary}` : "Propuesta del agente",
        body: row.decidedAt === null ? row.reason : null,
        actorName: row.proposedBy === "agent" ? "Agente" : "Equipo",
        channel: null,
        conversationId: row.conversationId,
        opportunityId: linkedOpp,
        taskId: null,
        status: null,
      })
    }
    const auditMerged = sql`('proposal-audit:' || ${auditEvent.id}::text)`
    const auditConditions = [
      eq(auditEvent.organizationId, orgId), eq(auditEvent.entity, "agent_proposal"),
      eq(agentProposal.organizationId, orgId), or(...scope)!,
      inArray(auditEvent.action, PROPOSAL_EVENT_ACTIONS),
    ]
    if (cursor) auditConditions.push(keysetPredicate(auditEvent.createdAt, auditMerged, cursor))
    const auditRows = await tx.select({
      audit: auditEvent, proposal: agentProposal, at: atColumn(auditEvent.createdAt),
    }).from(auditEvent)
      .innerJoin(agentProposal, sql`${auditEvent.entityId} = ${agentProposal.id}::text`)
      .where(and(...auditConditions))
      .orderBy(desc(auditEvent.createdAt), sql`${auditMerged} desc`).limit(perSource)
    const names = await resolveMemberNames(tx, orgId, auditRows.map(row => row.audit.actorUserId))
    for (const { audit, proposal, at } of auditRows) {
      const event = PROPOSAL_EVENT_LABEL[audit.action]!
      const metadata = audit.metadata as Record<string, unknown> | null
      const payload = proposal.payload as Record<string, unknown>
      const linkedOpp = typeof payload["opportunityId"] === "string" &&
        /^[0-9a-f-]{36}$/i.test(payload["opportunityId"]) ? payload["opportunityId"] : null
      merged.push({
        id: `proposal-audit:${audit.id}`, kind: "proposal", at,
        title: proposal.afterSummary ? `${event.title}: ${proposal.afterSummary}` : event.title,
        body: typeof metadata?.["reason"] === "string" ? metadata["reason"] : null,
        actorName: audit.actorUserId
          ? names.get(audit.actorUserId) ?? (audit.actorUserId === "agent" ? "Agente" : "Equipo")
          : audit.action === "agent.proposal_confirmed" ? own.displayName
          : proposal.proposedBy === "agent" ? "Agente" : "Equipo",
        channel: null, conversationId: proposal.conversationId,
        opportunityId: linkedOpp, taskId: null, status: event.status,
      })
    }
  }

  // Derivaciones al equipo (operativas: visibles con conversaciones).
  if (caps.conversations) {
    const scope = [eq(agentHandoff.contactId, contactId)]
    if (convIds.length > 0) scope.push(inArray(agentHandoff.conversationId, convIds))
    const mergedId: SQL = sql`('handoff:' || ${agentHandoff.id}::text)`
    const conditions = [eq(agentHandoff.organizationId, orgId), or(...scope)!]
    if (cursor) conditions.push(keysetPredicate(agentHandoff.createdAt, mergedId, cursor))
    const rows = await tx
      .select({ handoff: agentHandoff, at: atColumn(agentHandoff.createdAt) })
      .from(agentHandoff)
      .where(and(...conditions))
      .orderBy(desc(agentHandoff.createdAt), sql`('handoff:' || ${agentHandoff.id}::text) desc`)
      .limit(perSource)
    for (const { handoff: row, at } of rows) {
      merged.push({
        id: `handoff:${row.id}`,
        kind: "handoff",
        at,
        title: "Te lo pasó el agente",
        body: row.summary,
        actorName: "Agente",
        channel: null,
        conversationId: row.conversationId,
        opportunityId: null,
        taskId: row.taskId,
        status: row.priority,
      })
    }
  }

  merged.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
  const window = merged.slice(0, limit + 1)
  const page = window.slice(0, limit)
  const last = page[page.length - 1]
  return {
    items: page,
    nextCursor:
      window.length > limit && last ? encodeActivityCursor(last.at, last.id, fingerprint) : null,
  }
}

/* ------------------------- Contexto operativo ------------------------- */

/**
 * Abiertas del contacto (contacto directo o hilos suyos), con nombres
 * resueltos igual que listTasks. Sin límite silencioso: son todas las
 * abiertas del contacto.
 */
async function listContactTasks(tx: Db, orgId: string, contactId: string): Promise<TaskItem[]> {
  const convIds = await contactConversationIds(tx, orgId, contactId)
  const scope = [eq(crmTask.contactId, contactId)]
  if (convIds.length > 0) scope.push(inArray(crmTask.conversationId, convIds))
  const rows = await tx
    .select({
      task: crmTask,
      contactName: contact.displayName,
      opportunityTitle: opportunity.title,
      // La tarea de un caso del agente: completarla muestra antes lo que pasará.
      casePriority: sql<string | null>`(select h.priority from agent_handoff h
        where h.organization_id = ${orgId} and h.task_id = ${crmTask.id} order by h.created_at desc limit 1)`,
    })
    .from(crmTask)
    .leftJoin(
      contact,
      and(eq(contact.id, crmTask.contactId), eq(contact.organizationId, orgId)),
    )
    .leftJoin(
      opportunity,
      and(eq(opportunity.id, crmTask.opportunityId), eq(opportunity.organizationId, orgId)),
    )
    .where(and(eq(crmTask.organizationId, orgId), eq(crmTask.status, "open"), or(...scope)!))
    .orderBy(asc(crmTask.dueAt), desc(crmTask.createdAt))
  return rows.map((r) => ({
    id: r.task.id,
    title: r.task.title,
    contactId: r.task.contactId,
    conversationId: r.task.conversationId,
    opportunityId: r.task.opportunityId,
    patientId: r.task.patientId,
    // El contexto comercial no resuelve nombres de pacientes: eso lo hace la ficha.
    patientName: null,
    assigneeUserId: r.task.assigneeUserId,
    dueAt: r.task.dueAt ? r.task.dueAt.toISOString() : null,
    status: r.task.status,
    createdBy: r.task.createdBy,
    // El contexto comercial muestra la tarea, no a qué área va ni por qué se creó.
    area: null,
    reason: r.task.reason,
    settledReason: r.task.settledReason,
    contactName: r.contactName,
    opportunityTitle: r.opportunityTitle,
    agentCase: r.casePriority ? { priority: r.casePriority } : null,
    createdAt: r.task.createdAt.toISOString(),
    updatedAt: r.task.updatedAt.toISOString(),
  }))
}

export async function getContactWorkspace(
  tx: Db,
  orgId: string,
  contactId: string,
  opts: {
    conversationId?: string | null
    capabilities: CrmCapabilities
    activityLimit?: number
    opportunitiesLimit?: number
  },
): Promise<CrmContactWorkspace> {
  const full = await getContact(tx, orgId, contactId)
  const caps = opts.capabilities
  // El detalle heredado también respeta capacidades: sin tasks.read no hay
  // pendientes; sin conversations.read no hay hilos ni identidades de canal.
  const scoped: ContactFull = {
    ...full,
    openTasks: caps.tasks ? full.openTasks : [],
    conversations: caps.conversations ? full.conversations : [],
    identities: caps.conversations ? full.identities : [],
  }
  // Sin conversations.read no se expone estado de hilos del agente.
  const agentPromise = caps.conversations
    ? resolveAgentState(tx, orgId, contactId, opts.conversationId ?? null, caps)
    : getAgentConfig(tx, orgId).then(
        (cfg): CrmAgentState => ({
          state: "human",
          enabled: cfg.enabled,
          conversationId: null,
          reason: "Sin acceso a conversaciones",
          pendingProposalIds: [],
          awaitingContact: false,
        }),
      )
  const [opps, tasks, agent, activity, nextAppointment, permissions] = await Promise.all([
    listOpportunities(tx, orgId, { contactId, limit: opts.opportunitiesLimit ?? 30 }),
    caps.tasks ? listContactTasks(tx, orgId, contactId) : Promise.resolve([] as TaskItem[]),
    agentPromise,
    listContactActivity(tx, orgId, contactId, {
      limit: opts.activityLimit ?? ACTIVITY_DEFAULT_LIMIT,
      capabilities: caps,
    }),
    caps.appointments ? nextAppointmentOf(tx, orgId, contactId) : Promise.resolve(null),
    getMessagePermissions(tx, orgId, contactId),
  ])
  const granted = (purpose: string) => permissions.find((item) => item.purpose === purpose)?.granted ?? null
  return {
    contact: scoped,
    opportunities: { items: opps.items, nextCursor: opps.nextCursor },
    tasks,
    agent,
    activity,
    nextAppointment,
    messages: {
      recordatorio: granted("recordatorio"),
      seguimiento: granted("seguimiento"),
      novedades: granted("novedades"),
      // `false`: pidió no recibir ningún mensaje de la clínica (ADR 0040).
      avisos: granted("avisos"),
    },
  }
}

/* ------------------------- Notas operativas ------------------------- */

export interface CreateNoteInput {
  body: string
  conversationId?: string | null
  opportunityId?: string | null
}

export async function createContactNote(
  tx: Db,
  orgId: string,
  contactId: string,
  input: CreateNoteInput,
  actor: { userId: string | null },
): Promise<CrmActivityItem> {
  const body = input.body?.trim() ?? ""
  if (!body) throw validation("El cuerpo de la nota es obligatorio")
  if (body.length > NOTE_MAX_LENGTH) throw validation(`La nota supera ${NOTE_MAX_LENGTH} caracteres`)
  await requireContact(tx, orgId, contactId)
  let conversationId: string | null = null
  if (input.conversationId !== undefined && input.conversationId !== null) {
    assertUuid(input.conversationId, "Conversación inválida")
    const [conv] = await tx
      .select({ id: conversation.id, contactId: conversation.contactId })
      .from(conversation)
      .where(and(eq(conversation.id, input.conversationId), eq(conversation.organizationId, orgId)))
      .limit(1)
    if (!conv || conv.contactId !== contactId) {
      throw validation("La conversación no pertenece al contacto")
    }
    conversationId = conv.id
  }
  let opportunityId: string | null = null
  if (input.opportunityId !== undefined && input.opportunityId !== null) {
    assertUuid(input.opportunityId, "Oportunidad inválida")
    const [opp] = await tx
      .select({ id: opportunity.id, contactId: opportunity.contactId })
      .from(opportunity)
      .where(and(eq(opportunity.id, input.opportunityId), eq(opportunity.organizationId, orgId)))
      .limit(1)
    if (!opp || opp.contactId !== contactId) {
      throw validation("La oportunidad no pertenece al contacto")
    }
    opportunityId = opp.id
  }
  const [created] = await tx
    .insert(crmNote)
    .values({
      organizationId: orgId,
      contactId,
      conversationId,
      opportunityId,
      authorUserId: actor.userId,
      body,
    })
    .returning()
  if (!created) throw new Error("No se pudo guardar la nota")
  // Las notas son inmutables: no existen update/delete (ni servicio ni RLS).
  const [stamped] = await tx
    .select({ at: atColumn(crmNote.createdAt) })
    .from(crmNote)
    .where(and(eq(crmNote.organizationId, orgId), eq(crmNote.id, created.id)))
    .limit(1)
  const preciseAt = stamped?.at ?? created.createdAt.toISOString()
  await notify(tx, { orgId, kind: "contact.updated", at: new Date().toISOString() })
  if (opportunityId) {
    await notify(tx, { orgId, kind: "opportunity.updated", at: new Date().toISOString() })
  }
  let actorName: string | null = null
  if (actor.userId) {
    const names = await resolveMemberNames(tx, orgId, [actor.userId])
    actorName = names.get(actor.userId) ?? null
  }
  return {
    id: `note:${created.id}`,
    kind: "note",
    at: preciseAt,
    title: "Nota operativa",
    body: created.body,
    actorName,
    channel: null,
    conversationId,
    opportunityId,
    taskId: null,
    status: null,
  }
}

/* ------------------------- Presupuestos mínimos ------------------------- */

async function requirePatientLink(
  tx: Db,
  orgId: string,
  contactId: string,
  patientId: string,
): Promise<void> {
  assertUuid(patientId, "Paciente inválido")
  const [link] = await tx
    .select({ id: patientContact.id })
    .from(patientContact)
    .where(
      and(
        eq(patientContact.organizationId, orgId),
        eq(patientContact.contactId, contactId),
        eq(patientContact.patientId, patientId),
      ),
    )
    .limit(1)
  if (!link) throw validation("El paciente no está vinculado al contacto")
}

async function budgetOptionsForPatient(
  tx: Db,
  orgId: string,
  patientId: string,
  includeDrafts: boolean,
): Promise<CrmBudgetOption[]> {
  const allowed = includeDrafts ? [...CRM_BUDGET_STATUSES, "borrador"] : [...CRM_BUDGET_STATUSES]
  // Solo cabecera mínima: jamás importes, líneas ni notas clínicas.
  const rows = await tx
    .select({ id: treatmentBudget.id, title: treatmentBudget.title, status: treatmentBudget.status })
    .from(treatmentBudget)
    .where(
      and(
        eq(treatmentBudget.organizationId, orgId),
        eq(treatmentBudget.patientId, patientId),
        inArray(treatmentBudget.status, allowed),
      ),
    )
    .orderBy(desc(treatmentBudget.createdAt), desc(treatmentBudget.id))
  return rows
}

/**
 * Opciones de presupuesto para una oportunidad existente. El paciente de la
 * oportunidad debe estar vinculado al interlocutor (no mezclar economía de
 * dos fichas). Sin finance.read solo presentados/decididos.
 */
export async function listBudgetOptionsForOpportunity(
  tx: Db,
  orgId: string,
  opportunityId: string,
  opts: { includeDrafts: boolean },
): Promise<CrmBudgetOption[]> {
  assertUuid(opportunityId, "Oportunidad inválida")
  const [opp] = await tx
    .select({ id: opportunity.id, contactId: opportunity.contactId, patientId: opportunity.patientId })
    .from(opportunity)
    .where(and(eq(opportunity.id, opportunityId), eq(opportunity.organizationId, orgId)))
    .limit(1)
  if (!opp) throw notFound("Oportunidad")
  if (!opp.patientId) throw validation("La oportunidad no tiene paciente vinculado")
  await requirePatientLink(tx, orgId, opp.contactId, opp.patientId)
  return budgetOptionsForPatient(tx, orgId, opp.patientId, opts.includeDrafts)
}

/**
 * Opciones de presupuesto para crear una oportunidad: paciente explícito
 * vinculado al contacto. Misma visibilidad mínima que la anterior.
 */
export async function listBudgetOptionsForContactPatient(
  tx: Db,
  orgId: string,
  contactId: string,
  patientId: string,
  opts: { includeDrafts: boolean },
): Promise<CrmBudgetOption[]> {
  await requireContact(tx, orgId, contactId)
  const [p] = await tx
    .select({ id: patientTable.id })
    .from(patientTable)
    .where(and(eq(patientTable.id, patientId), eq(patientTable.organizationId, orgId)))
    .limit(1)
  if (!p) throw notFound("Paciente")
  await requirePatientLink(tx, orgId, contactId, patientId)
  return budgetOptionsForPatient(tx, orgId, patientId, opts.includeDrafts)
}

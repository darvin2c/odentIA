/**
 * Agenda operativa: reserva real de citas. La exclusión anti-solapamiento la
 * impone PostgreSQL (EXCLUDE en `0001_base_reglas.sql`); aquí se valida pertenencia al
 * tenant, horario del profesional en la sede, bloqueos/ausencias y se mapea
 * el conflicto. Comparte invariantes con availability.ts (misma validación
 * que usa la consulta de huecos, para que agentes y portal no calculen por
 * su cuenta). Toda función recibe `tx: Db` ya contextualizado.
 */
import type { Db } from "@odentia/db"
import {
  APPOINTMENT_STATUSES,
  type AppointmentStatus,
  appointment,
  scheduleRoom,
} from "@odentia/db/schema/agenda"
import { member, user } from "@odentia/db/schema/auth"
import {
  appointmentPlanItem,
  encounter,
  patient,
  patientContact,
  serviceCatalog,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { auditEvent, branch, orgProfile } from "@odentia/db/schema/org"
import { scheduleBlock } from "@odentia/db/schema/availability"
import { channelConnection, contact, conversation } from "@odentia/db/schema/crm"
import { and, asc, desc, eq, gt, gte, inArray, lt, ne, or, sql } from "drizzle-orm"
import { foldedWordsMatch } from "./search-text.js"
import { alias } from "drizzle-orm/pg-core"
import { appointmentConflict, exclusionTarget, validateAvailability } from "./availability.js"
import { createWorkspaceNotification } from "./workspace.js"
import { TEST_KEEP_MS } from "./conversation-state.js"
import { type PhoneWhatsApp, phoneWhatsAppState } from "./contacts.js"
import {
  appointmentConfirmationPlan,
  cancelPendingForAppointment,
  type ConfirmationPlan,
  enqueueAppointmentNotice,
  invalidateAppointmentTokens,
  preferredContact,
  rescheduleAppointmentReminders,
} from "./automation.js"
import {
  branchNotFound,
  roomNotFound,
  isExclusionViolation,
  invalidField,
  notFound,
  ServiceError,
  validation,
} from "./errors.js"
import { NEUTRAL_TIMEZONE, roomWord } from "./locale.js"
import { advanceForAppointment, returnForCancelledAppointment } from "./opportunities.js"
import { listPatients } from "./patients.js"
import { joinPatientPerson, patientPerson } from "./patient-identity.js"
import { countAgendaUpgrade, countRecoveredAppointment, refreshConversationTier } from "./saas-actions.js"

function conflict(code: string, message: string): ServiceError {
  return new ServiceError(code, 409, message)
}

/** Aviso en vivo para el stream del home (`org_events`): solo `{ orgId, kind, at }`, sin datos clínicos. */
async function notify(tx: Db, payload: { orgId: string; kind: string; at: string }): Promise<void> {
  await tx.execute(sql`select pg_notify('org_events', ${JSON.stringify(payload)})`)
}

/**
 * `appointment.updated` cuando lo que cambia el momento de una cita viene de
 * otra operación (abrir su atención): la Agenda e Inicio se refrescan solos.
 */
export async function notifyAppointmentChanged(tx: Db, orgId: string): Promise<void> {
  await notify(tx, { orgId, kind: "appointment.updated", at: new Date().toISOString() })
}

/**
 * Lo que pasa con la persona en su cita, dicho una sola vez para toda la
 * aplicación (ADR 0032). Sale del estado guardado, de la hora de llegada y de
 * la atención unida a la cita: «llegó» y «en atención» no se guardan como
 * estado. Los nombres en pantalla los pone la interfaz con estas claves.
 */
export const APPOINTMENT_VISITS = [
  "por_confirmar",
  "confirmada",
  "llego",
  "en_atencion",
  "atendida",
  "no_vino",
  "cancelada",
] as const
export type AppointmentVisit = (typeof APPOINTMENT_VISITS)[number]

/**
 * Correspondencia con HL7 FHIR R5, escrita una vez: `Appointment.status`, el
 * `participantStatus` de la persona cuando la cita está reservada y, en
 * atención, `Encounter.status`. «Confirmada» no es un estado de la cita en
 * FHIR sino la respuesta de la persona (`accepted`); se conserva como estado
 * porque recepción trabaja con él a diario. `checked-in` se une a «llegó»: en
 * una clínica no hay un trámite de admisión distinto de llegar.
 */
export const APPOINTMENT_VISIT_FHIR: Record<
  AppointmentVisit,
  { appointment: "booked" | "arrived" | "fulfilled" | "noshow" | "cancelled"; participant?: "needs-action" | "accepted"; encounter?: "in-progress" }
> = {
  por_confirmar: { appointment: "booked", participant: "needs-action" },
  confirmada: { appointment: "booked", participant: "accepted" },
  llego: { appointment: "arrived" },
  en_atencion: { appointment: "arrived", encounter: "in-progress" },
  atendida: { appointment: "fulfilled" },
  no_vino: { appointment: "noshow" },
  cancelada: { appointment: "cancelled" },
}

/** El momento de la cita a partir de lo guardado: estado, llegada y atención unida (no anulada). */
export function appointmentVisit(input: {
  status: string
  arrivedAt: Date | string | null
  encounterStatus: string | null
}): AppointmentVisit {
  if (input.status === "cancelada") return "cancelada"
  if (input.status === "no_asistio") return "no_vino"
  if (input.status === "atendida") return "atendida"
  if (input.encounterStatus === "borrador") return "en_atencion"
  if (input.arrivedAt) return "llego"
  return input.status === "confirmada" ? "confirmada" : "por_confirmar"
}

/**
 * La atención unida a la cita, sin nada de la historia: cuál es, quién la lleva
 * y cuándo empezó o terminó. Es un hecho de la agenda («En atención con la
 * Dra. Ana desde 10:06»): la ve quien ve la agenda.
 */
export interface AppointmentEncounterRef {
  id: string
  status: "borrador" | "finalizada"
  startedAt: string
  endedAt: string | null
  professionalUserId: string
  professionalName: string
}

export interface AppointmentItem {
  id: string
  branchId: string
  patientId: string
  patientName: string
  professionalUserId: string
  professionalName: string
  roomId: string
  roomName: string
  serviceId: string | null
  serviceName: string | null
  startsAt: string
  endsAt: string
  durationMin: number
  status: AppointmentStatus
  reason: string | null
  source: string
  conversationId: string | null
  version: number
  /** Cuándo llegó la persona; null si nadie lo marcó. */
  arrivedAt: string | null
  /** El momento de la cita (`appointmentVisit`). */
  visit: AppointmentVisit
  /** La atención unida a la cita, abierta o cerrada; null sin atención. */
  encounter: AppointmentEncounterRef | null
  /**
   * Solo al reservar, mover o cancelar: si el agente le avisará a la persona
   * («Recordar la cita»). Ausente en las lecturas.
   */
  notice?: { queued: boolean }
  /**
   * Cita de prueba (ADR 0094): de qué prueba salió, quién la hizo en «Probar»
   * (nulo en la del chat web) y cuándo se borra sola. Null en una cita real.
   */
  test: { conversationId: string | null; byUserId: string | null; byName: string | null; deletesAt: string | null } | null
}

export interface ScheduleResources {
  branchId: string
  branchName: string
  timeZone: string
  /** Minutos de una cita regular en la sede (sin servicio). */
  defaultDurationMin: number
  professionals: Array<{ id: string; label: string }>
  rooms: Array<{ id: string; label: string }>
}

/** Sede explícita o la primera activa; la zona es branch ?? organización. */
async function resolveBranch(tx: Db, orgId: string, branchId?: string) {
  const conditions = [eq(branch.organizationId, orgId), eq(branch.isActive, true)]
  if (branchId) conditions.push(eq(branch.id, branchId))
  const [row] = await tx
    .select({
      id: branch.id,
      name: branch.name,
      timezone: branch.timezone,
      orgTimezone: orgProfile.timezone,
      defaultMinutes: branch.appointmentDefaultMinutes,
    })
    .from(branch)
    .leftJoin(orgProfile, eq(orgProfile.organizationId, branch.organizationId))
    .where(and(...conditions))
    .orderBy(asc(branch.createdAt))
    .limit(1)
  if (!row) {
    if (branchId) throw branchNotFound()
    throw new ServiceError("NOT_FOUND", 404, "No hay ninguna sede activa")
  }
  return { ...row, timeZone: row.timezone ?? row.orgTimezone ?? NEUTRAL_TIMEZONE }
}

async function requireProfessional(tx: Db, orgId: string, professionalUserId: string) {
  const [membership] = await tx
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, professionalUserId)))
    .limit(1)
  if (!membership) throw onField(notFound("Profesional"), "professionalUserId")
}

/** El mismo error, dicho junto a su dato del cuerpo (`roomId`, `serviceId`…). */
function onField(error: ServiceError, field: string): ServiceError {
  return new ServiceError(error.code, error.status, error.message, { [field]: error.message })
}

async function requireRoom(tx: Db, orgId: string, roomId: string, branchId?: string) {
  const conditions = [
    eq(scheduleRoom.organizationId, orgId),
    eq(scheduleRoom.id, roomId),
    eq(scheduleRoom.isActive, true),
  ]
  if (branchId) conditions.push(eq(scheduleRoom.branchId, branchId))
  const [row] = await tx
    .select({ id: scheduleRoom.id, branchId: scheduleRoom.branchId })
    .from(scheduleRoom)
    .where(and(...conditions))
    .limit(1)
  if (!row) throw onField(roomNotFound((await roomWord(tx, orgId)).one), "roomId")
  return row
}

async function requireAppointmentPatient(tx: Db, orgId: string, patientId: string) {
  const [row] = await tx
    .select({ id: patient.id })
    .from(patient)
    .where(and(eq(patient.organizationId, orgId), eq(patient.id, patientId)))
    .limit(1)
  if (!row) throw onField(notFound("Paciente"), "patientId")
}

/** Servicio activo del tenant; su nombre se congela en la cita. */
async function requireService(tx: Db, orgId: string, serviceId: string) {
  const [row] = await tx
    .select({
      id: serviceCatalog.id,
      name: serviceCatalog.name,
      durationMin: serviceCatalog.durationMin,
    })
    .from(serviceCatalog)
    .where(
      and(
        eq(serviceCatalog.organizationId, orgId),
        eq(serviceCatalog.id, serviceId),
        eq(serviceCatalog.isActive, true),
      ),
    )
    .limit(1)
  if (!row) throw onField(notFound("Servicio"), "serviceId")
  return row
}

async function requireAppointment(tx: Db, orgId: string, id: string, options: { lock?: boolean } = {}) {
  const query = tx
    .select()
    .from(appointment)
    .where(and(eq(appointment.organizationId, orgId), eq(appointment.id, id)))
    .limit(1)
  const [row] = options.lock ? await query.for("update") : await query
  if (!row) throw notFound("Cita")
  return row
}

/** Zona de la sede de la cita o, si la sede no tiene, la de la clínica. */
async function branchZone(tx: Db, orgId: string, branchId: string): Promise<string> {
  const [row] = await tx
    .select({ timezone: branch.timezone, orgTimezone: orgProfile.timezone })
    .from(branch)
    .leftJoin(orgProfile, eq(orgProfile.organizationId, branch.organizationId))
    .where(and(eq(branch.organizationId, orgId), eq(branch.id, branchId)))
    .limit(1)
  return row?.timezone ?? row?.orgTimezone ?? NEUTRAL_TIMEZONE
}

/** Día local («2026-10-16») de un instante en una zona IANA. */
function localDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at)
}

/** La atención unida a la cita que no está anulada (a lo sumo una), sin nada de la historia. */
async function linkedEncounter(tx: Db, orgId: string, appointmentId: string) {
  const [row] = await tx
    .select({ id: encounter.id, status: encounter.status })
    .from(encounter)
    .where(
      and(
        eq(encounter.organizationId, orgId),
        eq(encounter.appointmentId, appointmentId),
        ne(encounter.status, "anulada"),
      ),
    )
    .limit(1)
  return row ?? null
}

function parseInstant(value: string, field: string): Date {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw validation(`${field} debe ser una fecha ISO válida`)
  return date
}

function assertStatus(status: string): AppointmentStatus {
  if (!(APPOINTMENT_STATUSES as readonly string[]).includes(status)) {
    throw validation(`Estado inválido: ${status}`)
  }
  return status as AppointmentStatus
}

async function audit(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  action: string,
  id: string,
  metadata?: Record<string, unknown>,
) {
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action,
    entity: "appointment",
    entityId: id,
    metadata,
  })
}

/** Quien lleva la atención unida a la cita (otro alias de `user`). */
const encounterProfessional = alias(user, "encounter_professional")
/** La prueba de la que salió una cita de prueba y quién la abrió en «Probar». */
const testConversation = alias(conversation, "test_conversation")
const testAuthor = alias(user, "test_author")

/** La cita con sus nombres y su atención no anulada (a lo sumo una: índice único). */
function appointmentRows(tx: Db, orgId: string) {
  return tx
    .select({
      appointment,
      patientName: patientPerson.displayName,
      professionalName: user.name,
      roomName: scheduleRoom.name,
      encounter: {
        id: encounter.id,
        status: encounter.status,
        startedAt: encounter.startedAt,
        endedAt: encounter.endedAt,
        professionalUserId: encounter.professionalUserId,
      },
      encounterProfessionalName: encounterProfessional.name,
      testCreatedAt: testConversation.createdAt,
      testByUserId: testConversation.testByUserId,
      testByName: testAuthor.name,
    })
    .from(appointment)
    .innerJoin(
      patient,
      and(eq(patient.organizationId, orgId), eq(patient.id, appointment.patientId)),
    )
    .innerJoin(patientPerson, joinPatientPerson(patientPerson))
    .innerJoin(user, eq(user.id, appointment.professionalUserId))
    .innerJoin(scheduleRoom, eq(scheduleRoom.id, appointment.roomId))
    .leftJoin(
      encounter,
      and(
        eq(encounter.organizationId, appointment.organizationId),
        eq(encounter.appointmentId, appointment.id),
        ne(encounter.status, "anulada"),
      ),
    )
    .leftJoin(encounterProfessional, eq(encounterProfessional.id, encounter.professionalUserId))
    .leftJoin(
      testConversation,
      and(
        eq(testConversation.organizationId, appointment.organizationId),
        eq(testConversation.id, appointment.conversationId),
        eq(testConversation.isTest, true),
      ),
    )
    .leftJoin(testAuthor, eq(testAuthor.id, testConversation.testByUserId))
}

export async function getAppointment(tx: Db, orgId: string, id: string): Promise<AppointmentItem> {
  const [row] = await appointmentRows(tx, orgId)
    .where(and(eq(appointment.organizationId, orgId), eq(appointment.id, id)))
    .limit(1)
  if (!row) throw notFound("Cita")
  return toItem(row)
}

/** Lo que el cajón de la cita dice de la persona y de dónde salió la cita. */
export interface AppointmentContext {
  /**
   * A quién se le escribe por esta cita: la persona del paciente o quien
   * habla por él (la misma que recibe los recordatorios).
   */
  person: {
    contactId: string
    name: string
    phone: string | null
    relationship: string
    /** Si su teléfono es su WhatsApp, aún no o no tiene (decisión 23). */
    whatsapp: PhoneWhatsApp
  } | null
  /** De dónde salió: `source` y, si nació en una conversación, cuál, su canal y cuándo. */
  origin: {
    source: string
    conversationId: string | null
    channel: string | null
    at: string
  }
  /** Cuándo le pedirá (o le pidió) el agente confirmar; null si no se lo va a pedir. */
  confirmation: ConfirmationPlan | null
}

export async function getAppointmentContext(tx: Db, orgId: string, id: string): Promise<AppointmentContext> {
  const current = await requireAppointment(tx, orgId, id)
  const contactId = await preferredContact(tx, orgId, current.patientId)
  const [person] = contactId
    ? await tx
        .select({ id: contact.id, name: contact.displayName, phone: contact.phone, relationship: patientContact.relationship })
        .from(contact)
        .innerJoin(
          patientContact,
          and(
            eq(patientContact.contactId, contact.id),
            eq(patientContact.organizationId, orgId),
            eq(patientContact.patientId, current.patientId),
          ),
        )
        .where(and(eq(contact.id, contactId), eq(contact.organizationId, orgId)))
        .limit(1)
    : []
  const [thread] = current.conversationId
    ? await tx
        .select({ channel: channelConnection.channel })
        .from(conversation)
        .innerJoin(channelConnection, eq(channelConnection.id, conversation.channelConnectionId))
        .where(and(eq(conversation.id, current.conversationId), eq(conversation.organizationId, orgId)))
        .limit(1)
    : []
  return {
    person: person
      ? {
          contactId: person.id,
          name: person.name,
          phone: person.phone,
          relationship: person.relationship,
          // Si su teléfono es su WhatsApp: el cajón avisa «Aún no es su WhatsApp» (decisión 23).
          whatsapp: await phoneWhatsAppState(tx, orgId, person.id),
        }
      : null,
    origin: {
      source: current.source,
      conversationId: thread ? current.conversationId : null,
      channel: thread?.channel ?? null,
      at: current.createdAt.toISOString(),
    },
    confirmation: await appointmentConfirmationPlan(tx, orgId, id),
  }
}

/**
 * Si el recordatorio de la cita le llegará a quien lo recibe (la misma persona
 * de `getAppointmentContext`): al reservar, recepción ve «Carmen no recibirá
 * el recordatorio: aún no tiene WhatsApp» (decisión 23, caso 2).
 */
export async function appointmentReminderReach(
  tx: Db,
  orgId: string,
  patientId: string,
): Promise<{ name: string; whatsapp: PhoneWhatsApp; hasEmail: boolean } | null> {
  const contactId = await preferredContact(tx, orgId, patientId)
  if (!contactId) return null
  const [person] = await tx
    .select({ name: contact.displayName, givenNames: contact.givenNames, email: contact.email })
    .from(contact)
    .where(and(eq(contact.id, contactId), eq(contact.organizationId, orgId)))
    .limit(1)
  if (!person) return null
  return {
    name: person.givenNames?.trim().split(/\s+/)[0] || person.name,
    whatsapp: await phoneWhatsAppState(tx, orgId, contactId),
    hasEmail: !!person.email?.trim(),
  }
}

function toItem(row: {
  appointment: typeof appointment.$inferSelect
  patientName: string
  professionalName: string
  roomName: string
  encounter: { id: string; status: string; startedAt: Date; endedAt: Date | null; professionalUserId: string } | null
  encounterProfessionalName: string | null
  testCreatedAt?: Date | null
  testByUserId?: string | null
  testByName?: string | null
}): AppointmentItem {
  const rowAppointment = row.appointment
  const linked = row.encounter?.id ? row.encounter : null
  return {
    id: rowAppointment.id,
    branchId: rowAppointment.branchId,
    patientId: rowAppointment.patientId,
    patientName: row.patientName,
    professionalUserId: rowAppointment.professionalUserId,
    professionalName: row.professionalName,
    roomId: rowAppointment.roomId,
    roomName: row.roomName,
    serviceId: rowAppointment.serviceId,
    serviceName: rowAppointment.serviceName,
    startsAt: rowAppointment.startsAt.toISOString(),
    endsAt: rowAppointment.endsAt.toISOString(),
    durationMin: rowAppointment.durationMin,
    status: assertStatus(rowAppointment.status),
    reason: rowAppointment.reason,
    source: rowAppointment.source,
    conversationId: rowAppointment.conversationId,
    version: rowAppointment.version,
    arrivedAt: rowAppointment.arrivedAt?.toISOString() ?? null,
    test: rowAppointment.isTest
      ? {
          conversationId: row.testCreatedAt ? rowAppointment.conversationId : null,
          byUserId: row.testByUserId ?? null,
          byName: row.testByName ?? null,
          deletesAt: row.testCreatedAt ? new Date(row.testCreatedAt.getTime() + TEST_KEEP_MS).toISOString() : null,
        }
      : null,
    visit: appointmentVisit({
      status: rowAppointment.status,
      arrivedAt: rowAppointment.arrivedAt,
      encounterStatus: linked?.status ?? null,
    }),
    encounter: linked
      ? {
          id: linked.id,
          status: linked.status === "finalizada" ? "finalizada" : "borrador",
          startedAt: linked.startedAt.toISOString(),
          endedAt: linked.endedAt?.toISOString() ?? null,
          professionalUserId: linked.professionalUserId,
          professionalName: row.encounterProfessionalName ?? "",
        }
      : null,
  }
}

export interface ListAppointmentsInput {
  branchId?: string
  /** Rango UTC explícito (ISO con zona); el cliente lo calcula con la zona de la sede. */
  from: string
  to: string
  professionals?: string[]
  rooms?: string[]
  statuses?: string[]
  q?: string
  /** Solo las citas de este paciente (ficha del paciente). */
  patientId?: string
  /** Citas de varios pacientes a la vez (búsqueda de la agenda). */
  patientIds?: string[]
}

export async function listAppointments(
  tx: Db,
  orgId: string,
  input: ListAppointmentsInput,
): Promise<AppointmentItem[]> {
  const from = parseInstant(input.from, "from")
  const to = parseInstant(input.to, "to")
  if (to <= from) throw validation("El rango de agenda es inválido")
  const conditions = [
    eq(appointment.organizationId, orgId),
    lt(appointment.startsAt, to),
    gte(appointment.endsAt, from),
  ]
  if (input.branchId) conditions.push(eq(appointment.branchId, input.branchId))
  if (input.patientId) conditions.push(eq(appointment.patientId, input.patientId))
  // Una historia bloqueada no sale en la agenda (ADR 0080); solo en su ficha.
  else conditions.push(sql`${patientPerson.recordLockedAt} is null`)
  if (input.patientIds?.length) conditions.push(inArray(appointment.patientId, input.patientIds))
  if (input.professionals?.length) {
    conditions.push(inArray(appointment.professionalUserId, input.professionals))
  }
  if (input.rooms?.length) conditions.push(inArray(appointment.roomId, input.rooms))
  if (input.statuses?.length) {
    for (const status of input.statuses) assertStatus(status)
    conditions.push(inArray(appointment.status, input.statuses))
  }
  const query = input.q?.trim()
  if (query) {
    conditions.push(foldedWordsMatch([patientPerson.displayName, appointment.reason, appointment.serviceName], query))
  }
  const rows = await appointmentRows(tx, orgId)
    .where(and(...conditions))
    .orderBy(asc(appointment.startsAt))
  return rows.map(toItem)
}

const SEARCH_PEOPLE = 6
const SEARCH_APPOINTMENTS_PER_PERSON = 3

export interface AgendaSearchPerson {
  patientId: string
  patientName: string
  /** Próximas citas en pie, de la más cercana a la más lejana. */
  appointments: AppointmentItem[]
}

/**
 * «¿Cuándo es mi cita?»: personas que coinciden con lo escrito (nombre,
 * documento o teléfono, la misma búsqueda de Pacientes) y sus próximas citas
 * en pie en cualquier sede.
 */
export async function searchAgendaPatients(
  tx: Db,
  orgId: string,
  input: { q: string; now?: Date },
): Promise<AgendaSearchPerson[]> {
  const q = input.q.trim()
  if (q.length < 2) return []
  const people = await listPatients(tx, orgId, { q, limit: SEARCH_PEOPLE, sort: "name" })
  if (people.items.length === 0) return []
  const now = input.now ?? new Date()
  const upcoming = await listAppointments(tx, orgId, {
    from: now.toISOString(),
    to: new Date(now.getTime() + 366 * 86_400_000).toISOString(),
    statuses: ["programada", "confirmada"],
    patientIds: people.items.map((item) => item.id),
  })
  return people.items.map((item) => ({
    patientId: item.id,
    patientName: item.displayName,
    appointments: upcoming
      .filter((appointment) => appointment.patientId === item.id)
      .slice(0, SEARCH_APPOINTMENTS_PER_PERSON),
  }))
}

/** Profesionales = miembros de la org; unidades dentales = activas de la sede. */
export async function listScheduleResources(
  tx: Db,
  orgId: string,
  input: { branchId?: string },
): Promise<ScheduleResources> {
  const resolved = await resolveBranch(tx, orgId, input.branchId)
  const [professionals, rooms] = await Promise.all([
    tx
      .select({ id: user.id, label: user.name })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(member.organizationId, orgId))
      .orderBy(asc(user.name)),
    tx
      .select({ id: scheduleRoom.id, label: scheduleRoom.name })
      .from(scheduleRoom)
      .where(
        and(
          eq(scheduleRoom.organizationId, orgId),
          eq(scheduleRoom.branchId, resolved.id),
          eq(scheduleRoom.isActive, true),
        ),
      )
      .orderBy(asc(scheduleRoom.name)),
  ])
  return {
    branchId: resolved.id,
    branchName: resolved.name,
    timeZone: resolved.timeZone,
    defaultDurationMin: resolved.defaultMinutes,
    professionals,
    rooms,
  }
}

/** Duraciones que se ofrecen para una cita regular. */
export const APPOINTMENT_DEFAULT_MINUTES = [15, 30, 45, 60, 90, 120] as const

/** Cambia lo que dura una cita regular en la sede: la que se reserva sin servicio. */
export async function setBranchDefaultDuration(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: { branchId: string; minutes: number },
): Promise<{ branchId: string; defaultDurationMin: number }> {
  if (!(APPOINTMENT_DEFAULT_MINUTES as readonly number[]).includes(input.minutes)) {
    throw validation(`La duración debe ser una de: ${APPOINTMENT_DEFAULT_MINUTES.join(", ")} minutos`)
  }
  const [updated] = await tx
    .update(branch)
    .set({ appointmentDefaultMinutes: input.minutes, updatedAt: new Date() })
    .where(and(eq(branch.organizationId, orgId), eq(branch.id, input.branchId)))
    .returning({ id: branch.id })
  if (!updated) throw branchNotFound()
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "branch.appointment_default_minutes",
    entity: "branch",
    entityId: input.branchId,
    metadata: { minutes: input.minutes },
  })
  return { branchId: input.branchId, defaultDurationMin: input.minutes }
}

/**
 * Una cita de prueba se ve, se mueve, se cancela y se borra con su prueba,
 * pero nadie llega a ella ni se atiende (ADR 0094): no hay paciente.
 */
function assertNotAttendingTest(current: { isTest: boolean }, next: string): void {
  if (current.isTest && (next === "atendida" || next === "no_asistio")) {
    throw conflict("TEST_APPOINTMENT", "Es una cita de prueba: no se atiende. Bórrala con su prueba.")
  }
}

/** Paciente de una persona de prueba (ADR 0094): su cita también lo será. */
export async function patientIsTest(tx: Db, orgId: string, patientId: string): Promise<boolean> {
  const [row] = await tx
    .select({ isTest: contact.isTest })
    .from(patient)
    .innerJoin(contact, and(eq(contact.organizationId, patient.organizationId), eq(contact.id, patient.personId)))
    .where(and(eq(patient.organizationId, orgId), eq(patient.id, patientId)))
    .limit(1)
  return row?.isTest ?? false
}

/**
 * Primera unidad dental libre de la sede para ese tramo: quien reserva elige persona y
 * hora, y la unidad dental la pone la agenda.
 */
async function pickFreeRoom(
  tx: Db,
  orgId: string,
  branchId: string,
  professionalUserId: string,
  startsAt: Date,
  endsAt: Date,
  /** Al mover una cita: no cuenta su propia ocupación y, si sigue libre, conserva su unidad dental. */
  moving?: { appointmentId: string; roomId: string },
  /** Cita de prueba (ADR 0094): también evita las otras pruebas; una real, solo las reales. */
  forTest = false,
): Promise<string> {
  const rooms = await tx
    .select({ id: scheduleRoom.id })
    .from(scheduleRoom)
    .where(
      and(
        eq(scheduleRoom.organizationId, orgId),
        eq(scheduleRoom.branchId, branchId),
        eq(scheduleRoom.isActive, true),
      ),
    )
    .orderBy(asc(scheduleRoom.name))
  if (rooms.length === 0) throw validation(`La sede no tiene ${(await roomWord(tx, orgId)).many}: añade una para reservar`)
  const ids = rooms.map((room) => room.id)
  const [taken, blocked] = await Promise.all([
    tx
      .select({ roomId: appointment.roomId })
      .from(appointment)
      .where(
        and(
          eq(appointment.organizationId, orgId),
          inArray(appointment.roomId, ids),
          inArray(appointment.status, ["programada", "confirmada"]),
          lt(appointment.startsAt, endsAt),
          gt(appointment.endsAt, startsAt),
          moving ? ne(appointment.id, moving.appointmentId) : undefined,
          forTest ? undefined : eq(appointment.isTest, false),
        ),
      ),
    tx
      .select({ roomId: scheduleBlock.roomId, professionalUserId: scheduleBlock.professionalUserId })
      .from(scheduleBlock)
      .where(
        and(
          eq(scheduleBlock.organizationId, orgId),
          eq(scheduleBlock.branchId, branchId),
          inArray(scheduleBlock.roomId, ids),
          lt(scheduleBlock.startsAt, endsAt),
          gt(scheduleBlock.endsAt, startsAt),
        ),
      ),
  ])
  const unavailable = new Set<string | null>([
    ...taken.map((row) => row.roomId),
    ...blocked
      .filter((row) => row.professionalUserId === null || row.professionalUserId === professionalUserId)
      .map((row) => row.roomId),
  ])
  const free =
    rooms.find((room) => room.id === moving?.roomId && !unavailable.has(room.id)) ??
    rooms.find((room) => !unavailable.has(room.id))
  // Sin unidad libre la cita no cabe a esa hora: se dice junto a la hora.
  if (!free) throw onField(conflict("NO_ROOM", `No hay una ${(await roomWord(tx, orgId)).one} libre a esa hora`), "startsAt")
  return free.id
}

/**
 * Le avisa al profesional de una excepción que no hizo él: una cita fuera de su
 * horario, sobre un bloqueo o junto a otra. Sin esto podría no enterarse y dejar
 * esperando a la persona. La campana no le avisa a quien la hizo.
 */
async function noticeException(
  tx: Db,
  orgId: string,
  input: { appointmentId: string; professionalUserId: string; actorUserId: string; startsAt: Date; timeZone: string; moved: boolean },
): Promise<void> {
  const when = new Intl.DateTimeFormat("es", {
    timeZone: input.timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(input.startsAt)
  await createWorkspaceNotification(tx, orgId, {
    userId: input.professionalUserId,
    actorUserId: input.actorUserId,
    dedupeKey: `cita-excepcion:${input.appointmentId}:${input.startsAt.toISOString()}`,
    title: input.moved ? "Te movieron una cita fuera de tu agenda habitual" : "Te dieron una cita fuera de tu agenda habitual",
    body: `Es el ${when}. Revísala para que nadie te espere.`,
    href: `/agenda?appointmentId=${input.appointmentId}`,
    permission: "appointments.read",
  })
}

export interface CreateAppointmentInput {
  branchId?: string
  patientId: string
  professionalUserId: string
  /** Sin unidad dental, la agenda pone la primera libre de la sede. */
  roomId?: string
  serviceId?: string
  startsAt: string
  endsAt?: string
  durationMin?: number
  status?: string
  reason?: string
  source?: string
  conversationId?: string
  /** Excepción del equipo: reservar aunque el horario del profesional no cubra esa hora. */
  outsideSchedule?: boolean
  /** Excepción del equipo: reservar sobre un bloqueo, una ausencia u otra cita del profesional. */
  overrideBusy?: boolean
  /**
   * Persona del equipo que figura como autora de la cita. Quien llama lo
   * indica cuando el actor no es un usuario (el agente o el interlocutor que
   * confirmó): `null` deja la cita sin autora y el actor real queda en la
   * auditoría y en `source`. Sin indicar, la autora es `actorUserId`.
   */
  createdByUserId?: string | null
  /**
   * `false`: no se le avisa a la persona porque ya se le dijo donde se reservó
   * (el agente en la conversación, la persona en su enlace). Por defecto se le
   * avisa si «Recordar la cita» está prendida.
   */
  notice?: boolean
  /**
   * Tratamientos aceptados que se agendan con la cita («Agendar» desde el Plan,
   * ADR 0034): la cita sabe qué son y su atención los trae. Del mismo paciente,
   * aceptados y sin terminar.
   */
  planItemIds?: string[]
}

/** Los tratamientos que se agendan con una cita: aceptados, sin terminar y del mismo paciente. */
async function requireSchedulableItems(tx: Db, orgId: string, patientId: string, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))]
  if (unique.length === 0) return []
  if (unique.length > 52) throw validation("Se agendan como máximo 52 tratamientos con una cita")
  const rows = await tx
    .select({ id: treatmentPlanItem.id, decision: treatmentPlanItem.decisionStatus, status: treatmentPlanItem.status })
    .from(treatmentPlanItem)
    .where(
      and(
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
        inArray(treatmentPlanItem.id, unique),
      ),
    )
  if (rows.length !== unique.length) throw notFound("Tratamiento")
  for (const row of rows) {
    if (row.decision !== "aceptado") {
      throw onField(conflict("ITEM_NOT_ACCEPTED", "Solo se agenda lo que la persona aceptó"), "planItemIds")
    }
    if (!["pendiente", "programado", "en_curso"].includes(row.status))
      throw onField(conflict("ITEM_CLOSED", "Ese tratamiento ya no está por hacer"), "planItemIds")
  }
  return unique
}

export async function createAppointment(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: CreateAppointmentInput,
): Promise<AppointmentItem> {
  const startsAt = parseInstant(input.startsAt, "startsAt")
  const service = input.serviceId ? await requireService(tx, orgId, input.serviceId) : null
  const room = input.roomId ? await requireRoom(tx, orgId, input.roomId) : null
  const resolved = await resolveBranch(tx, orgId, input.branchId ?? room?.branchId)
  if (room && room.branchId !== resolved.id) {
    throw invalidField("roomId", `La ${(await roomWord(tx, orgId)).one} no pertenece a la sede de la cita`)
  }

  const duration =
    input.durationMin ??
    service?.durationMin ??
    (input.endsAt
      ? Math.round((parseInstant(input.endsAt, "endsAt").getTime() - startsAt.getTime()) / 60000)
      : resolved.defaultMinutes)
  if (!Number.isInteger(duration) || duration <= 0) {
    throw validation("La duración debe ser un número positivo de minutos")
  }
  const endsAt = input.endsAt
    ? parseInstant(input.endsAt, "endsAt")
    : new Date(startsAt.getTime() + duration * 60000)
  if (endsAt <= startsAt) throw invalidField("endsAt", "La cita debe terminar después de iniciar")
  await requireAppointmentPatient(tx, orgId, input.patientId)
  await requireProfessional(tx, orgId, input.professionalUserId)
  const planItemIds = await requireSchedulableItems(tx, orgId, input.patientId, input.planItemIds ?? [])
  if (input.conversationId) {
    const [linked] = await tx.select({ id: conversation.id }).from(conversation)
      .innerJoin(patientContact, and(
        eq(patientContact.contactId, conversation.contactId),
        eq(patientContact.organizationId, orgId),
        eq(patientContact.patientId, input.patientId),
      ))
      .where(and(eq(conversation.id, input.conversationId), eq(conversation.organizationId, orgId)))
      .limit(1)
    if (!linked) throw invalidField("patientId", "La conversación no corresponde a un interlocutor del paciente")
  }
  const status = assertStatus(input.status ?? "programada")
  const standing = status === "programada" || status === "confirmada"
  // Serializar altas por recurso, siempre profesional → unidad dental. Dos inserciones
  // simultáneas pueden interbloquear las exclusiones antes de devolver 23P01.
  const lockScope = `appointment:${orgId}`
  if (standing) {
    await tx.execute(sql`select pg_advisory_xact_lock(
      hashtext(${lockScope}), hashtext(${"professional:" + input.professionalUserId}))`)
  }
  const forTest = await patientIsTest(tx, orgId, input.patientId)
  const roomId =
    room?.id ??
    (await pickFreeRoom(tx, orgId, resolved.id, input.professionalUserId, startsAt, endsAt, undefined, forTest))
  if (standing) {
    await tx.execute(sql`select pg_advisory_xact_lock(
      hashtext(${lockScope}), hashtext(${"room:" + roomId}))`)
    await validateAvailability(tx, orgId, {
      branchId: resolved.id,
      professionalUserId: input.professionalUserId,
      roomId,
      startsAt,
      endsAt,
      allowOutsideSchedule: input.outsideSchedule === true,
      allowBusy: input.overrideBusy === true,
      forTest,
    })
  }

  // La palabra va antes del intento: si la base lo rechaza, la transacción ya no admite consultas.
  const roomName = (await roomWord(tx, orgId)).one
  try {
    const [created] = await tx
      .insert(appointment)
      .values({
        organizationId: orgId,
        branchId: resolved.id,
        patientId: input.patientId,
        professionalUserId: input.professionalUserId,
        roomId,
        serviceId: service?.id ?? null,
        serviceName: service?.name ?? null,
        startsAt,
        endsAt,
        durationMin: Math.round((endsAt.getTime() - startsAt.getTime()) / 60000),
        status,
        reason: input.reason?.trim() || null,
        source: input.source ?? "recepcion",
        conversationId: input.conversationId ?? null,
        overlapAllowed: input.overrideBusy === true,
        createdBy: input.createdByUserId === undefined ? actorUserId : input.createdByUserId,
      })
      .returning({ id: appointment.id })
    if (!created) throw new Error("No se pudo crear la cita")
    if (planItemIds.length > 0) {
      await tx.insert(appointmentPlanItem).values(
        planItemIds.map((planItemId) => ({
          organizationId: orgId,
          patientId: input.patientId,
          appointmentId: created.id,
          planItemId,
          // Quien reserva desde su enlace o el portal no es del equipo: queda sin autor, como la cita.
          createdBy: input.createdByUserId === undefined ? actorUserId : input.createdByUserId,
        })),
      )
    }
    await audit(tx, orgId, actorUserId, "appointment.created", created.id, {
      patientId: input.patientId,
      professionalUserId: input.professionalUserId,
      roomId,
      startsAt: startsAt.toISOString(),
      ...(input.outsideSchedule ? { outsideSchedule: true } : {}),
      ...(input.overrideBusy ? { overrideBusy: true } : {}),
      ...(planItemIds.length > 0 ? { planItemIds } : {}),
    })
    if (standing && !forTest && (input.outsideSchedule || input.overrideBusy)) {
      await noticeException(tx, orgId, {
        appointmentId: created.id,
        professionalUserId: input.professionalUserId,
        actorUserId,
        startsAt,
        timeZone: resolved.timeZone,
        moved: false,
      })
    }
    // Una cita de prueba no sale hacia afuera: ni aviso ni recordatorios (ADR 0094).
    const notice =
      input.notice === false || !standing || forTest ? null : await enqueueAppointmentNotice(tx, orgId, created.id, "reservada")
    // Su oportunidad «Interesado» pasa sola a «Evaluación agendada» (ADR 0028).
    if (standing && startsAt.getTime() > Date.now()) {
      await advanceForAppointment(tx, orgId, { patientId: input.patientId, serviceId: service?.id ?? null, startsAt, source: input.source })
    }
    // Reservó desde el enlace de Sofi: su conversación de esa ventana pasa a «Gestiona» (ADR 0085).
    if (input.source === "enlace") {
      const [self] = await tx
        .select({ contactId: patientContact.contactId })
        .from(patientContact)
        .where(and(eq(patientContact.organizationId, orgId), eq(patientContact.patientId, input.patientId), eq(patientContact.relationship, "self")))
        .limit(1)
      if (self) await refreshConversationTier(tx, orgId, { contactId: self.contactId, at: new Date() })
    }
    await notify(tx, { orgId, kind: "appointment.updated", at: new Date().toISOString() })
    const item = await getAppointment(tx, orgId, created.id)
    return notice ? { ...item, notice } : item
  } catch (error) {
    if (isExclusionViolation(error)) {
      throw appointmentConflict(exclusionTarget(error), roomName)
    }
    throw error
  }
}

export interface MoveAppointmentInput {
  expectedVersion: number
  startsAt: string
  endsAt?: string
  professionalUserId?: string
  roomId?: string
  /** Excepción del equipo: mover o alargar fuera del horario del profesional. */
  outsideSchedule?: boolean
  /** Excepción del equipo: mover sobre un bloqueo, una ausencia u otra cita del profesional. */
  overrideBusy?: boolean
}

/**
 * Arrastre: nueva hora y recurso de la agrupación activa, con bloqueo
 * optimista. Sus recordatorios pasan a contar desde la hora nueva y, si la
 * fecha cambió, el agente le avisa a la persona (salvo `notice: false`, como
 * en `createAppointment`).
 */
export async function moveAppointment(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  input: MoveAppointmentInput,
  options: { notice?: boolean } = {},
): Promise<AppointmentItem> {
  const current = await requireAppointment(tx, orgId, id)
  // Solo se mueve lo que sigue en pie: lo atendido, cancelado o que no vino ya pasó.
  if (current.status !== "programada" && current.status !== "confirmada") {
    throw conflict("APPOINTMENT_STATUS", "Esta cita ya no se puede mover: solo se mueven las programadas o confirmadas")
  }
  // Con su atención abierta, la cita es la de esa atención: no cambia de hora.
  const linked = await linkedEncounter(tx, orgId, current.id)
  if (linked) {
    throw conflict(
      "APPOINTMENT_IN_ATTENTION",
      "La cita tiene una atención en curso: termínala o anúlala antes de moverla",
    )
  }
  const startsAt = parseInstant(input.startsAt, "startsAt")
  const durationMs = current.endsAt.getTime() - current.startsAt.getTime()
  const endsAt = input.endsAt
    ? parseInstant(input.endsAt, "endsAt")
    : new Date(startsAt.getTime() + durationMs)
  if (endsAt <= startsAt) throw invalidField("endsAt", "La cita debe terminar después de iniciar")
  const professionalUserId = input.professionalUserId ?? current.professionalUserId
  const active = current.status === "programada" || current.status === "confirmada"
  // Sin unidad dental indicada la cita conserva la suya; si a la nueva hora está ocupada, pasa a una libre.
  const roomId =
    input.roomId ??
    (active
      ? await pickFreeRoom(tx, orgId, current.branchId, professionalUserId, startsAt, endsAt, {
          appointmentId: id,
          roomId: current.roomId,
        }, current.isTest)
      : current.roomId)
  if (professionalUserId !== current.professionalUserId) await requireProfessional(tx, orgId, professionalUserId)
  if (roomId !== current.roomId) {
    const room = await requireRoom(tx, orgId, roomId)
    if (room.branchId !== current.branchId) {
      throw invalidField("roomId", `La ${(await roomWord(tx, orgId)).one} no pertenece a la sede de la cita`)
    }
  }
  if (active) {
    await validateAvailability(tx, orgId, {
      branchId: current.branchId,
      professionalUserId,
      roomId,
      startsAt,
      endsAt,
      ignoreAppointmentId: id,
      allowOutsideSchedule: input.outsideSchedule === true,
      allowBusy: input.overrideBusy === true,
      forTest: current.isTest,
    })
  }
  // Llegó hoy: si la cita pasa a otro día, esa llegada ya no es de ella.
  const zone = current.arrivedAt ? await branchZone(tx, orgId, current.branchId) : null
  const arrivalCleared = zone !== null && localDay(startsAt, zone) !== localDay(current.startsAt, zone)
  // La palabra va antes del intento: si la base lo rechaza, la transacción ya no admite consultas.
  const roomName = (await roomWord(tx, orgId)).one
  try {
    const [updated] = await tx
      .update(appointment)
      .set({
        startsAt,
        endsAt,
        durationMin: Math.round((endsAt.getTime() - startsAt.getTime()) / 60000),
        professionalUserId,
        roomId,
        overlapAllowed: input.overrideBusy === true,
        ...(arrivalCleared ? { arrivedAt: null, arrivedBy: null } : {}),
        version: current.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(appointment.organizationId, orgId),
          eq(appointment.id, id),
          eq(appointment.version, input.expectedVersion),
        ),
      )
      .returning({ id: appointment.id })
    if (!updated) {
      throw conflict(
        "STALE_VERSION",
        "La cita cambió mientras la movías; recarga e intenta de nuevo",
      )
    }
    await audit(tx, orgId, actorUserId, "appointment.moved", id, {
      startsAt: startsAt.toISOString(),
      professionalUserId,
      roomId,
      ...(arrivalCleared ? { arrivalCleared: true } : {}),
      ...(input.outsideSchedule ? { outsideSchedule: true } : {}),
      ...(input.overrideBusy ? { overrideBusy: true } : {}),
    })
    await invalidateAppointmentTokens(tx, orgId, id)
    if (active && !current.isTest && (input.outsideSchedule || input.overrideBusy)) {
      await noticeException(tx, orgId, {
        appointmentId: id,
        professionalUserId,
        actorUserId,
        startsAt,
        timeZone: await branchZone(tx, orgId, current.branchId),
        moved: true,
      })
    }
    const moved = startsAt.getTime() !== current.startsAt.getTime()
    if (moved) await rescheduleAppointmentReminders(tx, orgId, id, startsAt)
    const notice =
      moved && active && options.notice !== false ? await enqueueAppointmentNotice(tx, orgId, id, "movida") : null
    await notify(tx, { orgId, kind: "appointment.updated", at: new Date().toISOString() })
    const item = await getAppointment(tx, orgId, id)
    return notice ? { ...item, notice } : item
  } catch (error) {
    if (isExclusionViolation(error)) {
      throw appointmentConflict(exclusionTarget(error), roomName)
    }
    throw error
  }
}

/**
 * Detalles de la cita: motivo, servicio, profesional y unidad dental. El estado no se
 * cambia aquí: tiene sus propias operaciones y efectos (`setAppointmentStatus`,
 * `setAppointmentArrival` y el cierre de la atención).
 */
export interface UpdateAppointmentInput {
  expectedVersion: number
  reason?: string | null
  serviceId?: string | null
  professionalUserId?: string
  roomId?: string
}

export async function updateAppointment(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  input: UpdateAppointmentInput,
): Promise<AppointmentItem> {
  const current = await requireAppointment(tx, orgId, id)
  const set: Partial<typeof appointment.$inferInsert> = {
    version: current.version + 1,
    updatedAt: new Date(),
  }
  if (input.reason !== undefined) set.reason = input.reason?.trim() || null
  let endsAt = current.endsAt
  if (input.serviceId !== undefined) {
    const service = input.serviceId ? await requireService(tx, orgId, input.serviceId) : null
    set.serviceId = service?.id ?? null
    set.serviceName = service?.name ?? null
    // Otro servicio, otra duración: la cita dura lo del servicio nuevo, como al reservarla.
    if (service && service.id !== current.serviceId && service.durationMin) {
      endsAt = new Date(current.startsAt.getTime() + service.durationMin * 60_000)
      set.endsAt = endsAt
      set.durationMin = service.durationMin
    }
  }
  const professionalUserId = input.professionalUserId ?? current.professionalUserId
  if (professionalUserId !== current.professionalUserId) set.professionalUserId = professionalUserId
  const roomId = input.roomId ?? current.roomId
  if (roomId !== current.roomId) {
    const room = await requireRoom(tx, orgId, roomId)
    if (room.branchId !== current.branchId) {
      throw invalidField("roomId", `La ${(await roomWord(tx, orgId)).one} no pertenece a la sede de la cita`)
    }
    set.roomId = roomId
  }
  // «Editar» revisa la agenda igual que «Mover» (`moveAppointment`): quien
  // atiende debe tener horario, y ni un bloqueo ni otra cita pueden pisarla,
  // salvo que la cita ya sea una excepción aceptada por una persona del equipo.
  const active = current.status === "programada" || current.status === "confirmada"
  const changesPlace =
    professionalUserId !== current.professionalUserId || roomId !== current.roomId || endsAt.getTime() !== current.endsAt.getTime()
  if (changesPlace) {
    if (!active) {
      throw conflict("APPOINTMENT_STATUS", "Esta cita ya no se puede cambiar: solo se cambian las programadas o confirmadas")
    }
    if (await linkedEncounter(tx, orgId, current.id)) {
      throw conflict("APPOINTMENT_IN_ATTENTION", "La cita tiene una atención en curso: termínala o anúlala antes de cambiarla")
    }
    await validateAvailability(tx, orgId, {
      branchId: current.branchId,
      professionalUserId,
      roomId,
      startsAt: current.startsAt,
      endsAt,
      ignoreAppointmentId: id,
      allowBusy: current.overlapAllowed,
      forTest: current.isTest,
    })
  }
  // La palabra va antes del intento: si la base lo rechaza, la transacción ya no admite consultas.
  const roomName = (await roomWord(tx, orgId)).one
  try {
    const [updated] = await tx
      .update(appointment)
      .set(set)
      .where(
        and(
          eq(appointment.organizationId, orgId),
          eq(appointment.id, id),
          eq(appointment.version, input.expectedVersion),
        ),
      )
      .returning({ id: appointment.id })
    if (!updated) {
      throw conflict(
        "STALE_VERSION",
        "La cita cambió mientras la editabas; recarga e intenta de nuevo",
      )
    }
    await audit(tx, orgId, actorUserId, "appointment.updated", id, {})
    await notify(tx, { orgId, kind: "appointment.updated", at: new Date().toISOString() })
    return await getAppointment(tx, orgId, id)
  } catch (error) {
    if (isExclusionViolation(error)) {
      throw appointmentConflict(exclusionTarget(error), roomName)
    }
    throw error
  }
}

/** Quién pidió cancelar: lo que recepción anota al liberar el hueco. */
export const APPOINTMENT_CANCEL_REASONS = ["paciente", "clinica", "otro"] as const
export type AppointmentCancelReason = (typeof APPOINTMENT_CANCEL_REASONS)[number]

/**
 * Lo que la cita no admite (ADR 0032): «atendida» solo llega al firmar su
 * atención, una cita atendida ya no cambia, y la que tiene llegada o una
 * atención en curso no se cancela ni se marca «No vino» sin deshacer antes eso.
 */
async function assertStatusTransition(
  tx: Db,
  orgId: string,
  current: typeof appointment.$inferSelect,
  next: AppointmentStatus,
): Promise<void> {
  if (current.status === "atendida") {
    throw conflict("APPOINTMENT_ATTENDED", "La cita ya se atendió: su estado no cambia")
  }
  const linked = await linkedEncounter(tx, orgId, current.id)
  if (next === "atendida") {
    if (linked?.status !== "finalizada") {
      throw conflict(
        "ATTENDED_BY_ENCOUNTER",
        "La cita queda atendida al firmar su atención: ábrela con «Atender»",
      )
    }
    return
  }
  if (linked?.status === "borrador") {
    throw conflict(
      "APPOINTMENT_IN_ATTENTION",
      "La cita tiene una atención en curso: termínala o anúlala antes de cambiar la cita",
    )
  }
  if (current.arrivedAt) {
    throw conflict(
      "APPOINTMENT_ARRIVED",
      next === "no_asistio"
        ? "La persona ya llegó: si fue un error, deshaz la llegada antes de marcar «No vino»"
        : "La persona ya llegó: deshaz la llegada antes de cambiar la cita",
    )
  }
}

/** La cita es de hoy en la zona de su sede. */
async function isToday(tx: Db, orgId: string, row: typeof appointment.$inferSelect, now: Date): Promise<boolean> {
  const zone = await branchZone(tx, orgId, row.branchId)
  return localDay(row.startsAt, zone) === localDay(now, zone)
}

/**
 * «Llegó» (ADR 0032): anota la hora en que llegó la persona y quién lo marcó.
 * Vale para una cita de hoy que sigue en pie o que se marcó «No vino» (llega
 * tarde: la cita se recupera si su hueco sigue libre). Llegar confirma la cita
 * si estaba por confirmar y cancela los recordatorios que faltaban. Deshacer
 * (`arrived: false`) devuelve la cita a como estaba, mientras no haya empezado
 * su atención. La marcan recepción y el odontólogo (`appointments.write`).
 */
export async function setAppointmentArrival(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  arrived: boolean,
  now: Date = new Date(),
): Promise<AppointmentItem> {
  const current = await requireAppointment(tx, orgId, id, { lock: true })
  if (arrived) {
    if (current.arrivedAt) return getAppointment(tx, orgId, id)
    assertNotAttendingTest(current, "atendida")
    if (current.status === "atendida") throw conflict("APPOINTMENT_ATTENDED", "La cita ya se atendió")
    if (current.status === "cancelada") {
      throw conflict("APPOINTMENT_CANCELLED", "La cita está cancelada: reserva otra con «Reagendar»")
    }
    if (!(await isToday(tx, orgId, current, now))) {
      throw conflict("APPOINTMENT_NOT_TODAY", "Solo se marca la llegada de una cita de hoy")
    }
    // La palabra va antes del intento: si la base lo rechaza, la transacción ya no admite consultas.
    const roomName = (await roomWord(tx, orgId)).one
    try {
      // Recuperar una cita «No vino» vuelve a ocupar su hueco: la exclusión de
      // la base dice si sigue libre.
      const [updated] = await tx
        .update(appointment)
        .set({
          status: "confirmada",
          arrivedAt: sql`now()`,
          arrivedBy: actorUserId,
          version: current.version + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(appointment.organizationId, orgId), eq(appointment.id, id)))
        .returning({ id: appointment.id })
      if (!updated) throw notFound("Cita")
    } catch (error) {
      if (isExclusionViolation(error)) {
        throw appointmentConflict(exclusionTarget(error), roomName, "a esa hora: reagenda la cita")
      }
      throw error
    }
    await audit(tx, orgId, actorUserId, "appointment.arrived", id, { from: current.status })
    await cancelPendingForAppointment(tx, orgId, id, "llegó a la cita")
    await invalidateAppointmentTokens(tx, orgId, id)
  } else {
    if (!current.arrivedAt) return getAppointment(tx, orgId, id)
    if (current.status === "atendida" || (await linkedEncounter(tx, orgId, id))) {
      throw conflict(
        "ATTENTION_STARTED",
        "Ya empezó su atención: la llegada no se puede deshacer",
      )
    }
    // Vuelve al estado que tenía antes de llegar: por confirmar o «No vino».
    const [arrival] = await tx
      .select({ metadata: auditEvent.metadata })
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.organizationId, orgId),
          eq(auditEvent.entity, "appointment"),
          eq(auditEvent.entityId, id),
          eq(auditEvent.action, "appointment.arrived"),
        ),
      )
      .orderBy(desc(auditEvent.createdAt))
      .limit(1)
    const before = (arrival?.metadata as { from?: string } | null)?.from
    const status = before === "programada" || before === "no_asistio" ? before : current.status
    const [updated] = await tx
      .update(appointment)
      .set({ status, arrivedAt: null, arrivedBy: null, version: current.version + 1, updatedAt: new Date() })
      .where(and(eq(appointment.organizationId, orgId), eq(appointment.id, id)))
      .returning({ id: appointment.id })
    if (!updated) throw notFound("Cita")
    await audit(tx, orgId, actorUserId, "appointment.arrival_undone", id, { to: status })
  }
  await notify(tx, { orgId, kind: "appointment.updated", at: new Date().toISOString() })
  return getAppointment(tx, orgId, id)
}

/**
 * «Atender» marca la llegada si nadie lo hizo (ADR 0032): a la misma hora en
 * que empieza la atención (`now()` de la transacción), así esa espera queda
 * sin dato. Solo para una cita de hoy que sigue en pie; si ya llegó, no la
 * toca. Devuelve si la marcó.
 */
export async function markArrivedOnAttend(
  tx: Db,
  orgId: string,
  actorUserId: string,
  appointmentId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const current = await requireAppointment(tx, orgId, appointmentId, { lock: true })
  if (current.arrivedAt) return false
  assertNotAttendingTest(current, "atendida")
  if (current.status !== "programada" && current.status !== "confirmada") return false
  if (!(await isToday(tx, orgId, current, now))) return false
  await tx
    .update(appointment)
    .set({
      status: "confirmada",
      arrivedAt: sql`now()`,
      arrivedBy: actorUserId,
      version: current.version + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(appointment.organizationId, orgId), eq(appointment.id, appointmentId)))
  await audit(tx, orgId, actorUserId, "appointment.arrived", appointmentId, { from: current.status, via: "atencion" })
  await cancelPendingForAppointment(tx, orgId, appointmentId, "llegó a la cita")
  await invalidateAppointmentTokens(tx, orgId, appointmentId)
  return true
}

/**
 * Transición explícita; cancelada y no_asistio liberan el recurso en DB. Al
 * cancelar, el motivo y la nota (opcionales) quedan en la auditoría de la cita.
 * El actor es nulo cuando quien confirma o cancela es la propia persona desde
 * su enlace o su conversación; `via` deja dicho por dónde llegó el cambio y
 * `conversationId`, en cuál. Al cancelar una cita por venir el agente le
 * avisa a la persona con la opción de reservar otra (salvo `notice: false`).
 */
export async function setAppointmentStatus(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  id: string,
  status: string,
  detail?: { cancelReason?: string; cancelNote?: string; via?: string; conversationId?: string; notice?: boolean },
): Promise<AppointmentItem> {
  const next = assertStatus(status)
  const current = await requireAppointment(tx, orgId, id, { lock: true })
  if (current.status === next) return getAppointment(tx, orgId, id)
  assertNotAttendingTest(current, next)
  await assertStatusTransition(tx, orgId, current, next)
  const metadata: Record<string, unknown> = { from: current.status }
  if (detail?.via) metadata.via = detail.via
  if (detail?.conversationId) metadata.conversationId = detail.conversationId
  if (next === "cancelada") {
    if (detail?.cancelReason !== undefined) {
      if (!(APPOINTMENT_CANCEL_REASONS as readonly string[]).includes(detail.cancelReason)) {
        throw validation(`Motivo de cancelación inválido: ${detail.cancelReason}`)
      }
      metadata.cancelReason = detail.cancelReason
    }
    const note = detail?.cancelNote?.trim()
    if (note) metadata.cancelNote = note.slice(0, 500)
  }
  // La palabra va antes del intento: si la base lo rechaza, la transacción ya no admite consultas.
  const roomName = (await roomWord(tx, orgId)).one
  try {
    const [updated] = await tx
      .update(appointment)
      .set({ status: next, version: current.version + 1, updatedAt: new Date() })
      .where(and(eq(appointment.organizationId, orgId), eq(appointment.id, id)))
      .returning({ id: appointment.id })
    if (!updated) throw notFound("Cita")
    await audit(tx, orgId, actorUserId, `appointment.status_${next}`, id, metadata)
    // El paciente asistió: si el Administrador lo recuperó, cuenta la cita (ADR 0031).
    // Si no, y la reservó Sofi, su conversación sube de «Gestiona» a «Agenda» (ADR 0085): nunca las dos.
    if (next === "atendida") {
      const at = new Date()
      if (!(await countRecoveredAppointment(tx, orgId, id, at))) await countAgendaUpgrade(tx, orgId, id, at)
    }
    // Confirmar no deja a la persona sin el aviso de poco antes: «Te esperamos» sale
    // igual, ya sin «Confirmar» (ADR 0113). Lo demás termina la cita y sus avisos.
    if (next !== "confirmada") await cancelPendingForAppointment(tx, orgId, id, `cita ${next}`)
    await invalidateAppointmentTokens(tx, orgId, id)
    const notice =
      next === "cancelada" && detail?.notice !== false && !current.isTest
        ? await enqueueAppointmentNotice(tx, orgId, id, "cancelada")
        : null
    // Cancelar la evaluación que llevó su oportunidad a «Evaluación agendada»
    // la devuelve a «Interesado» si no le queda otra cita (ADR 0028).
    if (
      next === "cancelada" &&
      (current.status === "programada" || current.status === "confirmada") &&
      current.startsAt.getTime() > Date.now()
    ) {
      await returnForCancelledAppointment(tx, orgId, { patientId: current.patientId, startsAt: current.startsAt })
    }
    await notify(tx, { orgId, kind: "appointment.updated", at: new Date().toISOString() })
    const item = await getAppointment(tx, orgId, id)
    return notice ? { ...item, notice } : item
  } catch (error) {
    if (isExclusionViolation(error)) {
      throw appointmentConflict(exclusionTarget(error), roomName)
    }
    throw error
  }
}

/** Alta de unidad dental (recepción no la crea; la hace owner/admin en configuración o seed). */
export async function createRoom(
  tx: Db,
  orgId: string,
  input: { branchId: string; name: string },
): Promise<{ id: string }> {
  const name = input.name.trim()
  if (!name) throw invalidField("name", `Escribe el nombre de la ${(await roomWord(tx, orgId)).one}.`)
  await resolveBranch(tx, orgId, input.branchId)
  const [created] = await tx
    .insert(scheduleRoom)
    .values({ organizationId: orgId, branchId: input.branchId, name })
    .returning({ id: scheduleRoom.id })
  if (!created) throw new Error("No se pudo crear la unidad de atención")
  return created
}

/** Una unidad dental tal como la administra Configuración: también las desactivadas. */
export interface RoomItem {
  id: string
  name: string
  isActive: boolean
  /** Citas en pie que aún no terminan en esa unidad dental: no se mueven solas al desactivarla. */
  upcomingAppointments: number
}

/**
 * Unidades dentales de la sede para administrarlas: activas y desactivadas, con las
 * citas en pie que cada uno tiene por delante. La agenda sigue leyendo solo
 * los activos (`listScheduleResources`).
 */
export async function listRooms(
  tx: Db,
  orgId: string,
  input: { branchId: string; now?: Date },
): Promise<RoomItem[]> {
  const resolved = await resolveBranch(tx, orgId, input.branchId)
  const now = input.now ?? new Date()
  const [rooms, standing] = await Promise.all([
    tx
      .select({ id: scheduleRoom.id, name: scheduleRoom.name, isActive: scheduleRoom.isActive })
      .from(scheduleRoom)
      .where(and(eq(scheduleRoom.organizationId, orgId), eq(scheduleRoom.branchId, resolved.id)))
      .orderBy(asc(scheduleRoom.name)),
    tx
      .select({ roomId: appointment.roomId, total: sql<number>`count(*)::int` })
      .from(appointment)
      .where(
        and(
          eq(appointment.organizationId, orgId),
          eq(appointment.branchId, resolved.id),
          inArray(appointment.status, ["programada", "confirmada"]),
          gt(appointment.endsAt, now),
        ),
      )
      .groupBy(appointment.roomId),
  ])
  const upcoming = new Map(standing.map((row) => [row.roomId, row.total]))
  return rooms.map((room) => ({ ...room, upcomingAppointments: upcoming.get(room.id) ?? 0 }))
}

/**
 * Cambia el nombre de una unidad dental o la desactiva y reactiva. Desactivarla la saca
 * de las reservas nuevas; sus citas en pie se conservan en ella y no se mueven
 * solas (quien la desactiva ve cuántas son antes de confirmar).
 */
export async function updateRoom(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  patch: { name?: string; isActive?: boolean },
): Promise<{ id: string; name: string; isActive: boolean }> {
  const set: Partial<typeof scheduleRoom.$inferInsert> = {}
  const fields: string[] = []
  if (patch.name !== undefined) {
    const name = patch.name.trim()
    if (!name || name.length > 120) {
      throw invalidField("name", `El nombre de la ${(await roomWord(tx, orgId)).one} debe tener entre 1 y 120 caracteres.`)
    }
    set.name = name
    fields.push("name")
  }
  if (patch.isActive !== undefined) {
    set.isActive = patch.isActive
    fields.push("isActive")
  }
  if (fields.length === 0) throw validation(`Indica qué cambia de la ${(await roomWord(tx, orgId)).one}`)
  const [updated] = await tx
    .update(scheduleRoom)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(scheduleRoom.organizationId, orgId), eq(scheduleRoom.id, id)))
    .returning({ id: scheduleRoom.id, name: scheduleRoom.name, isActive: scheduleRoom.isActive })
  if (!updated) throw roomNotFound((await roomWord(tx, orgId)).one)
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "schedule_room.updated",
    entity: "schedule_room",
    entityId: id,
    metadata: { fields, ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}) },
  })
  return updated
}

/**
 * Agenda operativa: reserva real de citas. La exclusión anti-solapamiento la
 * impone PostgreSQL (ver migración 0024); aquí se valida pertenencia al
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
  scheduleChair,
} from "@odentia/db/schema/agenda"
import { member, user } from "@odentia/db/schema/auth"
import { patient, patientContact, serviceCatalog } from "@odentia/db/schema/clinical"
import { auditEvent, branch, orgProfile } from "@odentia/db/schema/org"
import { scheduleBlock } from "@odentia/db/schema/availability"
import { conversation } from "@odentia/db/schema/crm"
import { and, asc, eq, gt, gte, ilike, inArray, lt, ne, or, sql } from "drizzle-orm"
import { validateAvailability } from "./availability.js"
import {
  cancelPendingForAppointment,
  invalidateAppointmentTokens,
} from "./automation.js"
import { isExclusionViolation, notFound, ServiceError, validation } from "./errors.js"
import { NEUTRAL_TIMEZONE } from "./locale.js"
import { listPatients } from "./patients.js"

function conflict(code: string, message: string): ServiceError {
  return new ServiceError(code, 409, message)
}

/** Aviso en vivo para el stream del home (`org_events`): solo `{ orgId, kind, at }`, sin datos clínicos. */
async function notify(tx: Db, payload: { orgId: string; kind: string; at: string }): Promise<void> {
  await tx.execute(sql`select pg_notify('org_events', ${JSON.stringify(payload)})`)
}

export interface AppointmentItem {
  id: string
  branchId: string
  patientId: string
  patientName: string
  dentistUserId: string
  dentistName: string
  chairId: string
  chairName: string
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
}

export interface ScheduleResources {
  branchId: string
  branchName: string
  timeZone: string
  /** Minutos de una cita regular en la sede (sin servicio). */
  defaultDurationMin: number
  professionals: Array<{ id: string; label: string }>
  chairs: Array<{ id: string; label: string }>
}

/** Sucursal explícita o la primera activa; la zona es branch ?? organización. */
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
  if (!row) throw notFound(branchId ? "Sucursal" : "Sucursal activa")
  return { ...row, timeZone: row.timezone ?? row.orgTimezone ?? NEUTRAL_TIMEZONE }
}

async function requireDentist(tx: Db, orgId: string, dentistUserId: string) {
  const [membership] = await tx
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, dentistUserId)))
    .limit(1)
  if (!membership) throw notFound("Profesional")
}

async function requireChair(tx: Db, orgId: string, chairId: string, branchId?: string) {
  const conditions = [
    eq(scheduleChair.organizationId, orgId),
    eq(scheduleChair.id, chairId),
    eq(scheduleChair.isActive, true),
  ]
  if (branchId) conditions.push(eq(scheduleChair.branchId, branchId))
  const [row] = await tx
    .select({ id: scheduleChair.id, branchId: scheduleChair.branchId })
    .from(scheduleChair)
    .where(and(...conditions))
    .limit(1)
  if (!row) throw notFound("Sillón")
  return row
}

async function requireAppointmentPatient(tx: Db, orgId: string, patientId: string) {
  const [row] = await tx
    .select({ id: patient.id })
    .from(patient)
    .where(and(eq(patient.organizationId, orgId), eq(patient.id, patientId)))
    .limit(1)
  if (!row) throw notFound("Paciente")
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
  if (!row) throw notFound("Servicio")
  return row
}

async function requireAppointment(tx: Db, orgId: string, id: string) {
  const [row] = await tx
    .select()
    .from(appointment)
    .where(and(eq(appointment.organizationId, orgId), eq(appointment.id, id)))
    .limit(1)
  if (!row) throw notFound("Cita")
  return row
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

export async function getAppointment(tx: Db, orgId: string, id: string): Promise<AppointmentItem> {
  const [row] = await tx
    .select({
      appointment,
      patientName: patient.displayName,
      dentistName: user.name,
      chairName: scheduleChair.name,
    })
    .from(appointment)
    .innerJoin(
      patient,
      and(eq(patient.organizationId, orgId), eq(patient.id, appointment.patientId)),
    )
    .innerJoin(user, eq(user.id, appointment.dentistUserId))
    .innerJoin(scheduleChair, eq(scheduleChair.id, appointment.chairId))
    .where(and(eq(appointment.organizationId, orgId), eq(appointment.id, id)))
    .limit(1)
  if (!row) throw notFound("Cita")
  return toItem(row)
}

function toItem(row: {
  appointment: typeof appointment.$inferSelect
  patientName: string
  dentistName: string
  chairName: string
}): AppointmentItem {
  const rowAppointment = row.appointment
  return {
    id: rowAppointment.id,
    branchId: rowAppointment.branchId,
    patientId: rowAppointment.patientId,
    patientName: row.patientName,
    dentistUserId: rowAppointment.dentistUserId,
    dentistName: row.dentistName,
    chairId: rowAppointment.chairId,
    chairName: row.chairName,
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
  }
}

export interface ListAppointmentsInput {
  branchId?: string
  /** Rango UTC explícito (ISO con zona); el cliente lo calcula con la zona de la sucursal. */
  from: string
  to: string
  professionals?: string[]
  chairs?: string[]
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
  if (input.patientIds?.length) conditions.push(inArray(appointment.patientId, input.patientIds))
  if (input.professionals?.length) {
    conditions.push(inArray(appointment.dentistUserId, input.professionals))
  }
  if (input.chairs?.length) conditions.push(inArray(appointment.chairId, input.chairs))
  if (input.statuses?.length) {
    for (const status of input.statuses) assertStatus(status)
    conditions.push(inArray(appointment.status, input.statuses))
  }
  const query = input.q?.trim()
  if (query) {
    const like = `%${query}%`
    const match = or(
      ilike(patient.displayName, like),
      ilike(appointment.reason, like),
      ilike(appointment.serviceName, like),
    )
    if (match) conditions.push(match)
  }
  const rows = await tx
    .select({
      appointment,
      patientName: patient.displayName,
      dentistName: user.name,
      chairName: scheduleChair.name,
    })
    .from(appointment)
    .innerJoin(
      patient,
      and(eq(patient.organizationId, orgId), eq(patient.id, appointment.patientId)),
    )
    .innerJoin(user, eq(user.id, appointment.dentistUserId))
    .innerJoin(scheduleChair, eq(scheduleChair.id, appointment.chairId))
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

/** Profesionales = miembros de la org; sillones = activos de la sucursal. */
export async function listScheduleResources(
  tx: Db,
  orgId: string,
  input: { branchId?: string },
): Promise<ScheduleResources> {
  const resolved = await resolveBranch(tx, orgId, input.branchId)
  const [professionals, chairs] = await Promise.all([
    tx
      .select({ id: user.id, label: user.name })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(member.organizationId, orgId))
      .orderBy(asc(user.name)),
    tx
      .select({ id: scheduleChair.id, label: scheduleChair.name })
      .from(scheduleChair)
      .where(
        and(
          eq(scheduleChair.organizationId, orgId),
          eq(scheduleChair.branchId, resolved.id),
          eq(scheduleChair.isActive, true),
        ),
      )
      .orderBy(asc(scheduleChair.name)),
  ])
  return {
    branchId: resolved.id,
    branchName: resolved.name,
    timeZone: resolved.timeZone,
    defaultDurationMin: resolved.defaultMinutes,
    professionals,
    chairs,
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
  if (!updated) throw notFound("Sucursal")
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
 * Primer sillón libre de la sede para ese tramo: quien reserva elige persona y
 * hora, y el sillón lo pone la agenda.
 */
async function pickFreeChair(
  tx: Db,
  orgId: string,
  branchId: string,
  dentistUserId: string,
  startsAt: Date,
  endsAt: Date,
  /** Al mover una cita: no cuenta su propia ocupación y, si sigue libre, conserva su sillón. */
  moving?: { appointmentId: string; chairId: string },
): Promise<string> {
  const chairs = await tx
    .select({ id: scheduleChair.id })
    .from(scheduleChair)
    .where(
      and(
        eq(scheduleChair.organizationId, orgId),
        eq(scheduleChair.branchId, branchId),
        eq(scheduleChair.isActive, true),
      ),
    )
    .orderBy(asc(scheduleChair.name))
  if (chairs.length === 0) throw validation("La sede no tiene sillones: añade uno para reservar")
  const ids = chairs.map((chair) => chair.id)
  const [taken, blocked] = await Promise.all([
    tx
      .select({ chairId: appointment.chairId })
      .from(appointment)
      .where(
        and(
          eq(appointment.organizationId, orgId),
          inArray(appointment.chairId, ids),
          inArray(appointment.status, ["programada", "confirmada"]),
          lt(appointment.startsAt, endsAt),
          gt(appointment.endsAt, startsAt),
          moving ? ne(appointment.id, moving.appointmentId) : undefined,
        ),
      ),
    tx
      .select({ chairId: scheduleBlock.chairId, dentistUserId: scheduleBlock.dentistUserId })
      .from(scheduleBlock)
      .where(
        and(
          eq(scheduleBlock.organizationId, orgId),
          eq(scheduleBlock.branchId, branchId),
          inArray(scheduleBlock.chairId, ids),
          lt(scheduleBlock.startsAt, endsAt),
          gt(scheduleBlock.endsAt, startsAt),
        ),
      ),
  ])
  const unavailable = new Set<string | null>([
    ...taken.map((row) => row.chairId),
    ...blocked
      .filter((row) => row.dentistUserId === null || row.dentistUserId === dentistUserId)
      .map((row) => row.chairId),
  ])
  const free =
    chairs.find((chair) => chair.id === moving?.chairId && !unavailable.has(chair.id)) ??
    chairs.find((chair) => !unavailable.has(chair.id))
  if (!free) throw conflict("NO_CHAIR", "No hay un sillón libre a esa hora")
  return free.id
}

export interface CreateAppointmentInput {
  branchId?: string
  patientId: string
  dentistUserId: string
  /** Sin sillón, la agenda pone el primero libre de la sede. */
  chairId?: string
  serviceId?: string
  startsAt: string
  endsAt?: string
  durationMin?: number
  status?: string
  reason?: string
  source?: string
  conversationId?: string
  /** Urgencia: reservar aunque el horario del profesional no cubra esa hora. */
  outsideSchedule?: boolean
  /**
   * Persona del equipo que figura como autora de la cita. Quien llama lo
   * indica cuando el actor no es un usuario (el agente o el interlocutor que
   * confirmó): `null` deja la cita sin autora y el actor real queda en la
   * auditoría y en `source`. Sin indicar, la autora es `actorUserId`.
   */
  createdByUserId?: string | null
}

export async function createAppointment(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: CreateAppointmentInput,
): Promise<AppointmentItem> {
  const startsAt = parseInstant(input.startsAt, "startsAt")
  const service = input.serviceId ? await requireService(tx, orgId, input.serviceId) : null
  const chair = input.chairId ? await requireChair(tx, orgId, input.chairId) : null
  const resolved = await resolveBranch(tx, orgId, input.branchId ?? chair?.branchId)
  if (chair && chair.branchId !== resolved.id) {
    throw validation("El sillón no pertenece a la sucursal de la cita")
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
  if (endsAt <= startsAt) throw validation("La cita debe terminar después de iniciar")
  await requireAppointmentPatient(tx, orgId, input.patientId)
  await requireDentist(tx, orgId, input.dentistUserId)
  if (input.conversationId) {
    const [linked] = await tx.select({ id: conversation.id }).from(conversation)
      .innerJoin(patientContact, and(
        eq(patientContact.contactId, conversation.contactId),
        eq(patientContact.organizationId, orgId),
        eq(patientContact.patientId, input.patientId),
      ))
      .where(and(eq(conversation.id, input.conversationId), eq(conversation.organizationId, orgId)))
      .limit(1)
    if (!linked) throw validation("La conversación no corresponde a un interlocutor del paciente")
  }
  const status = assertStatus(input.status ?? "programada")
  const standing = status === "programada" || status === "confirmada"
  // Serializar altas por recurso, siempre profesional → sillón. Dos inserciones
  // simultáneas pueden interbloquear las exclusiones antes de devolver 23P01.
  const lockScope = `appointment:${orgId}`
  if (standing) {
    await tx.execute(sql`select pg_advisory_xact_lock(
      hashtext(${lockScope}), hashtext(${"dentist:" + input.dentistUserId}))`)
  }
  const chairId =
    chair?.id ??
    (await pickFreeChair(tx, orgId, resolved.id, input.dentistUserId, startsAt, endsAt))
  if (standing) {
    await tx.execute(sql`select pg_advisory_xact_lock(
      hashtext(${lockScope}), hashtext(${"chair:" + chairId}))`)
    await validateAvailability(tx, orgId, {
      branchId: resolved.id,
      dentistUserId: input.dentistUserId,
      chairId,
      startsAt,
      endsAt,
      allowOutsideSchedule: input.outsideSchedule === true,
    })
  }

  try {
    const [created] = await tx
      .insert(appointment)
      .values({
        organizationId: orgId,
        branchId: resolved.id,
        patientId: input.patientId,
        dentistUserId: input.dentistUserId,
        chairId,
        serviceId: service?.id ?? null,
        serviceName: service?.name ?? null,
        startsAt,
        endsAt,
        durationMin: Math.round((endsAt.getTime() - startsAt.getTime()) / 60000),
        status,
        reason: input.reason?.trim() || null,
        source: input.source ?? "recepcion",
        conversationId: input.conversationId ?? null,
        createdBy: input.createdByUserId === undefined ? actorUserId : input.createdByUserId,
      })
      .returning({ id: appointment.id })
    if (!created) throw new Error("No se pudo crear la cita")
    await audit(tx, orgId, actorUserId, "appointment.created", created.id, {
      patientId: input.patientId,
      dentistUserId: input.dentistUserId,
      chairId,
      startsAt: startsAt.toISOString(),
      ...(input.outsideSchedule ? { outsideSchedule: true } : {}),
    })
    await notify(tx, { orgId, kind: "appointment.updated", at: new Date().toISOString() })
    return await getAppointment(tx, orgId, created.id)
  } catch (error) {
    if (isExclusionViolation(error)) {
      throw conflict(
        "APPOINTMENT_CONFLICT",
        "El profesional o el sillón ya están ocupados en ese horario",
      )
    }
    throw error
  }
}

export interface MoveAppointmentInput {
  expectedVersion: number
  startsAt: string
  endsAt?: string
  dentistUserId?: string
  chairId?: string
}

/** Arrastre: nueva hora y recurso de la agrupación activa, con bloqueo optimista. */
export async function moveAppointment(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  input: MoveAppointmentInput,
): Promise<AppointmentItem> {
  const current = await requireAppointment(tx, orgId, id)
  const startsAt = parseInstant(input.startsAt, "startsAt")
  const durationMs = current.endsAt.getTime() - current.startsAt.getTime()
  const endsAt = input.endsAt
    ? parseInstant(input.endsAt, "endsAt")
    : new Date(startsAt.getTime() + durationMs)
  if (endsAt <= startsAt) throw validation("La cita debe terminar después de iniciar")
  const dentistUserId = input.dentistUserId ?? current.dentistUserId
  const active = current.status === "programada" || current.status === "confirmada"
  // Sin sillón indicado la cita conserva el suyo; si a la nueva hora está ocupado, pasa a uno libre.
  const chairId =
    input.chairId ??
    (active
      ? await pickFreeChair(tx, orgId, current.branchId, dentistUserId, startsAt, endsAt, {
          appointmentId: id,
          chairId: current.chairId,
        })
      : current.chairId)
  if (dentistUserId !== current.dentistUserId) await requireDentist(tx, orgId, dentistUserId)
  if (chairId !== current.chairId) {
    const chair = await requireChair(tx, orgId, chairId)
    if (chair.branchId !== current.branchId) {
      throw validation("El sillón no pertenece a la sucursal de la cita")
    }
  }
  if (active) {
    await validateAvailability(tx, orgId, {
      branchId: current.branchId,
      dentistUserId,
      chairId,
      startsAt,
      endsAt,
      ignoreAppointmentId: id,
    })
  }
  try {
    const [updated] = await tx
      .update(appointment)
      .set({
        startsAt,
        endsAt,
        durationMin: Math.round((endsAt.getTime() - startsAt.getTime()) / 60000),
        dentistUserId,
        chairId,
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
      dentistUserId,
      chairId,
    })
    await invalidateAppointmentTokens(tx, orgId, id)
    await notify(tx, { orgId, kind: "appointment.updated", at: new Date().toISOString() })
    return await getAppointment(tx, orgId, id)
  } catch (error) {
    if (isExclusionViolation(error)) {
      throw conflict(
        "APPOINTMENT_CONFLICT",
        "El profesional o el sillón ya están ocupados en ese horario",
      )
    }
    throw error
  }
}

export interface UpdateAppointmentInput {
  expectedVersion: number
  reason?: string | null
  serviceId?: string | null
  dentistUserId?: string
  chairId?: string
  status?: string
}

export async function updateAppointment(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  input: UpdateAppointmentInput,
): Promise<AppointmentItem> {
  const current = await requireAppointment(tx, orgId, id)
  const statusChanged = input.status !== undefined && input.status !== current.status
  const set: Partial<typeof appointment.$inferInsert> = {
    version: current.version + 1,
    updatedAt: new Date(),
  }
  if (input.reason !== undefined) set.reason = input.reason?.trim() || null
  if (input.serviceId !== undefined) {
    const service = input.serviceId ? await requireService(tx, orgId, input.serviceId) : null
    set.serviceId = service?.id ?? null
    set.serviceName = service?.name ?? null
  }
  if (input.dentistUserId !== undefined && input.dentistUserId !== current.dentistUserId) {
    await requireDentist(tx, orgId, input.dentistUserId)
    set.dentistUserId = input.dentistUserId
  }
  if (input.status !== undefined && input.status !== current.status) {
    set.status = assertStatus(input.status)
  }
  if (input.chairId !== undefined && input.chairId !== current.chairId) {
    const chair = await requireChair(tx, orgId, input.chairId)
    if (chair.branchId !== current.branchId) {
      throw validation("El sillón no pertenece a la sucursal de la cita")
    }
    set.chairId = input.chairId
  }
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
    if (statusChanged) {
      await cancelPendingForAppointment(tx, orgId, id, "cita actualizada")
      await invalidateAppointmentTokens(tx, orgId, id)
    }
    await notify(tx, { orgId, kind: "appointment.updated", at: new Date().toISOString() })
    return await getAppointment(tx, orgId, id)
  } catch (error) {
    if (isExclusionViolation(error)) {
      throw conflict(
        "APPOINTMENT_CONFLICT",
        "El profesional o el sillón ya están ocupados en ese horario",
      )
    }
    throw error
  }
}

/** Quién pidió cancelar: lo que recepción anota al liberar el hueco. */
export const APPOINTMENT_CANCEL_REASONS = ["paciente", "clinica", "otro"] as const
export type AppointmentCancelReason = (typeof APPOINTMENT_CANCEL_REASONS)[number]

/**
 * Transición explícita; cancelada y no_asistio liberan el recurso en DB. Al
 * cancelar, el motivo y la nota (opcionales) quedan en la auditoría de la cita.
 * El actor es nulo cuando quien confirma o cancela es la propia persona desde
 * su enlace; `via` deja dicho por dónde llegó el cambio.
 */
export async function setAppointmentStatus(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  id: string,
  status: string,
  detail?: { cancelReason?: string; cancelNote?: string; via?: string },
): Promise<AppointmentItem> {
  const next = assertStatus(status)
  const current = await requireAppointment(tx, orgId, id)
  if (current.status === next) return getAppointment(tx, orgId, id)
  const metadata: Record<string, unknown> = { from: current.status }
  if (detail?.via) metadata.via = detail.via
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
  try {
    const [updated] = await tx
      .update(appointment)
      .set({ status: next, version: current.version + 1, updatedAt: new Date() })
      .where(and(eq(appointment.organizationId, orgId), eq(appointment.id, id)))
      .returning({ id: appointment.id })
    if (!updated) throw notFound("Cita")
    await audit(tx, orgId, actorUserId, `appointment.status_${next}`, id, metadata)
    await cancelPendingForAppointment(tx, orgId, id, `cita ${next}`)
    await invalidateAppointmentTokens(tx, orgId, id)
    await notify(tx, { orgId, kind: "appointment.updated", at: new Date().toISOString() })
    return await getAppointment(tx, orgId, id)
  } catch (error) {
    if (isExclusionViolation(error)) {
      throw conflict(
        "APPOINTMENT_CONFLICT",
        "El profesional o el sillón ya están ocupados en ese horario",
      )
    }
    throw error
  }
}

/** Alta de sillón (recepción no lo crea; lo hace owner/admin en configuración o seed). */
export async function createChair(
  tx: Db,
  orgId: string,
  input: { branchId: string; name: string },
): Promise<{ id: string }> {
  const name = input.name.trim()
  if (!name) throw validation("El nombre del sillón es obligatorio")
  await resolveBranch(tx, orgId, input.branchId)
  const [created] = await tx
    .insert(scheduleChair)
    .values({ organizationId: orgId, branchId: input.branchId, name })
    .returning({ id: scheduleChair.id })
  if (!created) throw new Error("No se pudo crear el sillón")
  return created
}

/** Un sillón tal como lo administra Configuración: también los desactivados. */
export interface ChairItem {
  id: string
  name: string
  isActive: boolean
  /** Citas en pie que aún no terminan en ese sillón: no se mueven solas al desactivarlo. */
  upcomingAppointments: number
}

/**
 * Sillones de la sede para administrarlos: activos y desactivados, con las
 * citas en pie que cada uno tiene por delante. La agenda sigue leyendo solo
 * los activos (`listScheduleResources`).
 */
export async function listChairs(
  tx: Db,
  orgId: string,
  input: { branchId: string; now?: Date },
): Promise<ChairItem[]> {
  const resolved = await resolveBranch(tx, orgId, input.branchId)
  const now = input.now ?? new Date()
  const [chairs, standing] = await Promise.all([
    tx
      .select({ id: scheduleChair.id, name: scheduleChair.name, isActive: scheduleChair.isActive })
      .from(scheduleChair)
      .where(and(eq(scheduleChair.organizationId, orgId), eq(scheduleChair.branchId, resolved.id)))
      .orderBy(asc(scheduleChair.name)),
    tx
      .select({ chairId: appointment.chairId, total: sql<number>`count(*)::int` })
      .from(appointment)
      .where(
        and(
          eq(appointment.organizationId, orgId),
          eq(appointment.branchId, resolved.id),
          inArray(appointment.status, ["programada", "confirmada"]),
          gt(appointment.endsAt, now),
        ),
      )
      .groupBy(appointment.chairId),
  ])
  const upcoming = new Map(standing.map((row) => [row.chairId, row.total]))
  return chairs.map((chair) => ({ ...chair, upcomingAppointments: upcoming.get(chair.id) ?? 0 }))
}

/**
 * Cambia el nombre de un sillón o lo desactiva y reactiva. Desactivarlo lo saca
 * de las reservas nuevas; sus citas en pie se conservan en él y no se mueven
 * solas (quien lo desactiva ve cuántas son antes de confirmar).
 */
export async function updateChair(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  patch: { name?: string; isActive?: boolean },
): Promise<{ id: string; name: string; isActive: boolean }> {
  const set: Partial<typeof scheduleChair.$inferInsert> = {}
  const fields: string[] = []
  if (patch.name !== undefined) {
    const name = patch.name.trim()
    if (!name || name.length > 120) throw validation("El nombre del sillón debe tener entre 1 y 120 caracteres")
    set.name = name
    fields.push("name")
  }
  if (patch.isActive !== undefined) {
    set.isActive = patch.isActive
    fields.push("isActive")
  }
  if (fields.length === 0) throw validation("Indica qué cambia del sillón")
  const [updated] = await tx
    .update(scheduleChair)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(scheduleChair.organizationId, orgId), eq(scheduleChair.id, id)))
    .returning({ id: scheduleChair.id, name: scheduleChair.name, isActive: scheduleChair.isActive })
  if (!updated) throw notFound("Sillón")
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "schedule_chair.updated",
    entity: "schedule_chair",
    entityId: id,
    metadata: { fields, ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}) },
  })
  return updated
}

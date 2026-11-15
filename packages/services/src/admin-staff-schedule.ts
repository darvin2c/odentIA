/**
 * Horarios, ausencias y salas del equipo de Sallca, y las presentaciones que
 * se agendan con ellos (lienzo «Kairós vende», K3–K8). Lo usan la pantalla de
 * Equipo, Hoy y Kairós cuando agenda desde una conversación: la misma
 * operación para todos.
 *
 * Reglas que rigen aquí:
 * - Cada persona marca su horario, su sala y sus ausencias; Administración
 *   puede hacerlo por otra. El servidor lo exige aquí.
 * - Una presentación dura 45 min (`PRESENTATION_MS`) y empieza a las :00 o a
 *   las :30 de Lima, desde 2 h después de ahora y hasta 14 días.
 * - Agendar, mover y pasar a otra persona toman el candado de quien presenta
 *   (`pg_advisory_xact_lock`) y vuelven a mirar el hueco: si otro se lo ganó,
 *   `SLOT_TAKEN` (409). Nada se agenda en una ausencia ni encima de otra
 *   presentación abierta de la misma persona.
 * - Lo que hace Kairós (`actor` nulo) o alguien que no es quien presenta le
 *   deja a quien presenta una tarea en Hoy: nada cambia sin que lo sepa.
 * - Las propuestas de una conversación (`kairos_proposal`) son como las de
 *   Sofi (ADR 0097): la última manda y vencen a las 48 h.
 */
import type { Db } from "@odentia/db"
import {
  type KairosProposalStatus,
  kairosProposal,
  saasChat,
  saasClient,
  saasTask,
} from "@odentia/db/schema/admin-arm"
import { adminStaff, adminStaffAbsence, adminStaffHours } from "@odentia/db/schema/admin-core"
import { user } from "@odentia/db/schema/auth"
import { and, asc, eq, gt, inArray, isNotNull, lt, ne, sql } from "drizzle-orm"
import { type AdminActor, isAdminRole, writeAdminAudit } from "./admin-core.js"
import {
  getClientTask,
  lockPresenter,
  PRESENTATION_MS,
  presentationEndsAt,
  schedulePresentation,
  type TaskRow,
} from "./admin-sales.js"
import {
  mergeSpans,
  type AvailabilitySpan as Span,
  subtractSpans,
  zonedTimeToUtc,
} from "./availability.js"
import { invalidField, notFound, ServiceError } from "./errors.js"
import { limaDate } from "./peru-business-days.js"

const LIMA = "America/Lima"
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** Las presentaciones empiezan a las :00 o a las :30. */
export const PRESENTATION_STEP_MS = 30 * MINUTE
/** Lo mínimo de aviso: no se agenda para dentro de menos de 2 h. */
export const PRESENTATION_LEAD_MS = 2 * HOUR
/** Hasta cuándo se ofrece: 14 días. */
export const PRESENTATION_HORIZON_DAYS = 14
/** Lo que vale una propuesta de Kairós en una conversación. */
export const KAIROS_PROPOSAL_HOURS = 48
const MEETING_URL_MAX = 500
const ABSENCE_REASON_MAX = 200
const HOURS_MAX = 50
const SLOTS_LIMIT = 50
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/* ---------- Guardas ---------- */

function forbidden(message: string): ServiceError {
  return new ServiceError("FORBIDDEN", 403, message)
}

function requireStaffActor(actor: AdminActor): void {
  if (!actor || !isAdminRole(actor.role)) throw forbidden("Solo el equipo de Sallca")
}

/** Lo suyo lo cambia cada persona; lo de otra, solo Administración. */
function requireEditor(actor: AdminActor, userId: string): void {
  requireStaffActor(actor)
  if (actor.role !== "admin" && actor.userId !== userId)
    throw forbidden("Solo Administración cambia el horario de otra persona")
}

interface StaffMember {
  userId: string
  name: string
  role: string
  active: boolean
  meetingUrl: string | null
}

async function staffMember(tx: Db, userId: string): Promise<StaffMember> {
  const [row] = await tx
    .select({
      userId: adminStaff.userId,
      name: user.name,
      role: adminStaff.role,
      active: adminStaff.active,
      meetingUrl: adminStaff.meetingUrl,
    })
    .from(adminStaff)
    .innerJoin(user, eq(user.id, adminStaff.userId))
    .where(eq(adminStaff.userId, userId))
    .limit(1)
  if (!row) throw notFound("Persona del equipo")
  return row
}

function requireDate(field: string, value: Date | null | undefined, what: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw invalidField(field, what)
  return value
}

/** El motivo de una ausencia lo ven quien se ausenta y Administración; el resto, solo el tramo. */
function absenceFor(actor: AdminActor, row: StaffAbsenceRow): StaffAbsenceRow {
  return actor.role === "admin" || actor.userId === row.userId ? row : { ...row, reason: null }
}

/* ---------- Horario y sala ---------- */

/** Una franja del horario: día de la semana en Lima (0 = domingo) y minutos desde la medianoche. */
export interface StaffHourRange {
  weekday: number
  startMin: number
  endMin: number
}

export interface StaffAbsenceRow {
  id: string
  userId: string
  startsAt: Date
  endsAt: Date
  reason: string | null
  createdBy: string | null
  createdAt: Date
}

export interface StaffSchedule {
  userId: string
  name: string
  meetingUrl: string | null
  hours: StaffHourRange[]
  /** Las ausencias que no terminaron. */
  absences: StaffAbsenceRow[]
}

async function hoursOf(tx: Db, userIds: string[]): Promise<Map<string, StaffHourRange[]>> {
  const out = new Map<string, StaffHourRange[]>()
  if (userIds.length === 0) return out
  const found = await tx
    .select({
      userId: adminStaffHours.userId,
      weekday: adminStaffHours.weekday,
      startMin: adminStaffHours.startMin,
      endMin: adminStaffHours.endMin,
    })
    .from(adminStaffHours)
    .where(inArray(adminStaffHours.userId, userIds))
    .orderBy(asc(adminStaffHours.weekday), asc(adminStaffHours.startMin))
  for (const { userId, ...range } of found) {
    const list = out.get(userId) ?? []
    list.push(range)
    out.set(userId, list)
  }
  return out
}

/** El horario, la sala y las ausencias que siguen de una persona. Cualquiera del equipo lo ve. */
export async function getStaffSchedule(
  tx: Db,
  actor: AdminActor,
  userId: string,
  now = new Date(),
): Promise<StaffSchedule> {
  requireStaffActor(actor)
  const member = await staffMember(tx, userId)
  return {
    userId: member.userId,
    name: member.name,
    meetingUrl: member.meetingUrl,
    hours: (await hoursOf(tx, [userId])).get(userId) ?? [],
    absences: await listStaffAbsences(tx, actor, userId, now),
  }
}

/**
 * Reemplaza el horario semanal de una persona. Cada franja dentro del día, de
 * inicio a fin, y sin cruzarse con otra del mismo día (seguidas sí).
 */
export async function setStaffHours(
  tx: Db,
  actor: AdminActor,
  userId: string,
  hours: StaffHourRange[],
  now = new Date(),
): Promise<StaffHourRange[]> {
  requireEditor(actor, userId)
  await staffMember(tx, userId)
  if (!Array.isArray(hours)) throw invalidField("hours", "El horario no es válido")
  if (hours.length > HOURS_MAX) throw invalidField("hours", `Usa como máximo ${HOURS_MAX} franjas`)
  hours.forEach((range, index) => {
    const ok =
      range &&
      Number.isInteger(range.weekday) &&
      range.weekday >= 0 &&
      range.weekday <= 6 &&
      Number.isInteger(range.startMin) &&
      Number.isInteger(range.endMin) &&
      range.startMin >= 0 &&
      range.endMin <= 1440
    if (!ok) throw invalidField(`hours.${index}`, "Elige el día y las horas de la franja")
    if (range.startMin >= range.endMin)
      throw invalidField(`hours.${index}`, "La franja tiene que terminar después de empezar")
  })
  const sorted = hours
    .map((range, index) => ({ ...range, index }))
    .sort((a, b) => a.weekday - b.weekday || a.startMin - b.startMin)
  for (let i = 1; i < sorted.length; i += 1) {
    const before = sorted[i - 1]
    const current = sorted[i]
    if (before && current && before.weekday === current.weekday && current.startMin < before.endMin)
      throw invalidField(`hours.${current.index}`, "Esa franja se cruza con otra del mismo día")
  }
  await tx.delete(adminStaffHours).where(eq(adminStaffHours.userId, userId))
  if (sorted.length > 0) {
    await tx.insert(adminStaffHours).values(
      sorted.map((range) => ({
        userId,
        weekday: range.weekday,
        startMin: range.startMin,
        endMin: range.endMin,
        createdAt: now,
      })),
    )
  }
  await writeAdminAudit(tx, actor, {
    action: "arm.staff_hours_set",
    entityId: userId,
    metadata: { ranges: sorted.length },
  })
  return sorted.map(({ weekday, startMin, endMin }) => ({ weekday, startMin, endMin }))
}

/** La sala fija de videollamada de una persona: un enlace https, o nada. */
export async function setStaffMeetingUrl(
  tx: Db,
  actor: AdminActor,
  userId: string,
  url: string | null,
): Promise<string | null> {
  requireEditor(actor, userId)
  await staffMember(tx, userId)
  const text = (url ?? "").trim()
  let value: string | null = null
  if (text) {
    const words = "Pega el enlace de tu sala: empieza con https://"
    if (text.length > MEETING_URL_MAX || /\s/.test(text)) throw invalidField("meetingUrl", words)
    let parsed: URL
    try {
      parsed = new URL(text)
    } catch {
      throw invalidField("meetingUrl", words)
    }
    if (parsed.protocol !== "https:" || !parsed.hostname || !text.startsWith("https://"))
      throw invalidField("meetingUrl", words)
    value = text
  }
  await tx.update(adminStaff).set({ meetingUrl: value }).where(eq(adminStaff.userId, userId))
  await writeAdminAudit(tx, actor, {
    action: "arm.staff_meeting_url_set",
    entityId: userId,
    metadata: { set: value !== null },
  })
  return value
}

/* ---------- Ausencias ---------- */

/** Las ausencias de una persona que todavía no terminan, de la más próxima a la más lejana. */
export async function listStaffAbsences(
  tx: Db,
  actor: AdminActor,
  userId: string,
  now = new Date(),
): Promise<StaffAbsenceRow[]> {
  requireStaffActor(actor)
  const rows = await tx
    .select()
    .from(adminStaffAbsence)
    .where(and(eq(adminStaffAbsence.userId, userId), gt(adminStaffAbsence.endsAt, now)))
    .orderBy(asc(adminStaffAbsence.startsAt))
  return rows.map((row) => absenceFor(actor, row))
}

/** Una presentación abierta que cae en un tramo de una persona. */
export interface PresentationConflict {
  taskId: string
  clientId: string
  clientName: string
  startsAt: Date
  endsAt: Date
}

const presentationEndSql = sql`coalesce(${saasTask.endsAt}, ${saasTask.dueAt} + interval '45 minutes')`

/** Las presentaciones abiertas de esa persona que caen dentro de una ausencia (nueva o guardada). */
export async function absenceConflicts(
  tx: Db,
  userId: string,
  absence: { startsAt: Date; endsAt: Date },
): Promise<PresentationConflict[]> {
  const found = await tx
    .select({
      taskId: saasTask.id,
      clientId: saasTask.clientId,
      clientName: saasClient.name,
      startsAt: saasTask.dueAt,
      endsAt: sql<string>`${presentationEndSql}`,
    })
    .from(saasTask)
    .innerJoin(saasClient, eq(saasClient.id, saasTask.clientId))
    .where(
      and(
        eq(saasTask.kind, "presentacion"),
        eq(saasTask.status, "abierta"),
        eq(saasTask.assigneeUserId, userId),
        isNotNull(saasTask.dueAt),
        lt(saasTask.dueAt, absence.endsAt),
        sql`${presentationEndSql} > ${absence.startsAt.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(saasTask.dueAt))
  return found.map((row) => ({
    taskId: row.taskId,
    clientId: row.clientId,
    clientName: row.clientName,
    startsAt: row.startsAt as Date,
    endsAt: new Date(row.endsAt),
  }))
}

/**
 * Marca una ausencia (días completos o unas horas). Devuelve también las
 * presentaciones abiertas que caen en ella: nada se mueve solo; Kairós las
 * pone en Hoy («Pasar a…» o «Pedir otra hora»).
 */
export async function addStaffAbsence(
  tx: Db,
  actor: AdminActor,
  userId: string,
  input: { startsAt: Date; endsAt: Date; reason?: string | null },
  now = new Date(),
): Promise<{ absence: StaffAbsenceRow; conflicts: PresentationConflict[] }> {
  requireEditor(actor, userId)
  await staffMember(tx, userId)
  const startsAt = requireDate("startsAt", input.startsAt, "Elige desde cuándo")
  const endsAt = requireDate("endsAt", input.endsAt, "Elige hasta cuándo")
  if (endsAt <= startsAt) throw invalidField("endsAt", "Tiene que terminar después de empezar")
  if (endsAt <= now) throw invalidField("endsAt", "Esa ausencia ya pasó")
  const reason = (input.reason ?? "").trim() || null
  if (reason && reason.length > ABSENCE_REASON_MAX)
    throw invalidField("reason", `Usa como máximo ${ABSENCE_REASON_MAX} caracteres`)
  const [absence] = await tx
    .insert(adminStaffAbsence)
    .values({ userId, startsAt, endsAt, reason, createdBy: actor.userId, createdAt: now })
    .returning()
  if (!absence) throw new ServiceError("INTERNAL", 500, "No se pudo guardar la ausencia")
  const conflicts = await absenceConflicts(tx, userId, { startsAt, endsAt })
  await writeAdminAudit(tx, actor, {
    action: "arm.staff_absence_added",
    entityId: userId,
    metadata: { absenceId: absence.id, conflicts: conflicts.length },
  })
  return { absence, conflicts }
}

export async function removeStaffAbsence(
  tx: Db,
  actor: AdminActor,
  absenceId: string,
): Promise<void> {
  requireStaffActor(actor)
  if (!UUID.test(absenceId)) throw notFound("Ausencia")
  const [row] = await tx
    .select()
    .from(adminStaffAbsence)
    .where(eq(adminStaffAbsence.id, absenceId))
    .limit(1)
    .for("update")
  if (!row) throw notFound("Ausencia")
  requireEditor(actor, row.userId)
  await tx.delete(adminStaffAbsence).where(eq(adminStaffAbsence.id, absenceId))
  await writeAdminAudit(tx, actor, {
    action: "arm.staff_absence_removed",
    entityId: row.userId,
    metadata: { absenceId },
  })
}

/* ---------- Disponibilidad ---------- */

/** Los días de Lima que toca el tramo `[from, to)`. */
function limaDays(from: Date, to: Date): string[] {
  const days: string[] = []
  let day = limaDate(from)
  const last = limaDate(new Date(to.getTime() - 1))
  while (day <= last) {
    days.push(day)
    day = new Date(new Date(`${day}T00:00:00Z`).getTime() + DAY).toISOString().slice(0, 10)
  }
  return days
}

/**
 * Los tramos libres de cada persona en `[from, to)`: su horario semanal en Lima
 * menos sus ausencias y sus presentaciones abiertas (sin `exceptTaskId`, la que
 * se está moviendo).
 */
async function freeSpans(
  tx: Db,
  userIds: string[],
  from: Date,
  to: Date,
  exceptTaskId?: string,
): Promise<Map<string, Span[]>> {
  const out = new Map<string, Span[]>()
  if (userIds.length === 0 || to <= from) return out
  const hours = await hoursOf(tx, userIds)
  const absences = await tx
    .select({
      userId: adminStaffAbsence.userId,
      startsAt: adminStaffAbsence.startsAt,
      endsAt: adminStaffAbsence.endsAt,
    })
    .from(adminStaffAbsence)
    .where(
      and(
        inArray(adminStaffAbsence.userId, userIds),
        lt(adminStaffAbsence.startsAt, to),
        gt(adminStaffAbsence.endsAt, from),
      ),
    )
  const busy = await tx
    .select({
      userId: saasTask.assigneeUserId,
      startsAt: saasTask.dueAt,
      endsAt: sql<string>`${presentationEndSql}`,
    })
    .from(saasTask)
    .where(
      and(
        eq(saasTask.kind, "presentacion"),
        eq(saasTask.status, "abierta"),
        inArray(saasTask.assigneeUserId, userIds),
        isNotNull(saasTask.dueAt),
        lt(saasTask.dueAt, to),
        sql`${presentationEndSql} > ${from.toISOString()}::timestamptz`,
        exceptTaskId ? ne(saasTask.id, exceptTaskId) : undefined,
      ),
    )
  const days = limaDays(from, to)
  for (const userId of userIds) {
    const ranges = hours.get(userId) ?? []
    const open: Span[] = []
    for (const day of days) {
      const weekday = new Date(`${day}T12:00:00Z`).getUTCDay()
      for (const range of ranges) {
        if (range.weekday !== weekday) continue
        open.push([
          zonedTimeToUtc(day, range.startMin, LIMA).getTime(),
          zonedTimeToUtc(day, range.endMin, LIMA).getTime(),
        ])
      }
    }
    const cuts: Span[] = [
      ...absences
        .filter((row) => row.userId === userId)
        .map((row): Span => [row.startsAt.getTime(), row.endsAt.getTime()]),
      ...busy
        .filter((row) => row.userId === userId && row.startsAt)
        .map((row): Span => [(row.startsAt as Date).getTime(), new Date(row.endsAt).getTime()]),
    ]
    const window: Span = [from.getTime(), to.getTime()]
    out.set(
      userId,
      subtractSpans(open, cuts).flatMap(([a, b]): Span[] => {
        const start = Math.max(a, window[0])
        const end = Math.min(b, window[1])
        return end > start ? [[start, end]] : []
      }),
    )
  }
  return out
}

/**
 * Los inicios de 45 min dentro de los tramos libres, a las :00 y las :30. La
 * cuadrícula de 30 min en UTC es la de Lima porque su hora es UTC−5 todo el
 * año, sin horario de verano (una zona con media hora la correría).
 */
function slotStarts(spans: Span[]): number[] {
  const out: number[] = []
  for (const [a, b] of mergeSpans(spans)) {
    let start = Math.ceil(a / PRESENTATION_STEP_MS) * PRESENTATION_STEP_MS
    while (start + PRESENTATION_MS <= b) {
      out.push(start)
      start += PRESENTATION_STEP_MS
    }
  }
  return out
}

/** ¿Cabe `[start, end)` entero en un tramo libre? */
function fits(spans: Span[], start: number, end: number): boolean {
  return spans.some(([a, b]) => a <= start && end <= b)
}

export interface StaffSlot {
  startsAt: Date
  endsAt: Date
  userId: string
  name: string
  /** Es de la persona preferida (el responsable del cliente). */
  preferred: boolean
}

export interface StaffSlotsQuery {
  /** El responsable del cliente: sus horas primero. */
  preferUserId?: string | null
  /**
   * Solo las horas de esta persona (mover una presentación: sigue con quien la presenta). Sin
   * horas suyas, nada: no se ofrece la de otra persona que después no se puede dar.
   */
  onlyUserId?: string | null
  from?: Date | null
  to?: Date | null
  now: Date
  limit?: number
}

/** Quienes presentan: las personas activas del equipo con horario, por nombre. */
async function presenters(tx: Db): Promise<Array<{ userId: string; name: string }>> {
  return tx
    .select({ userId: adminStaff.userId, name: user.name })
    .from(adminStaff)
    .innerJoin(user, eq(user.id, adminStaff.userId))
    .where(
      and(
        eq(adminStaff.active, true),
        sql`exists (select 1 from admin_staff_hours h where h.user_id = ${adminStaff.userId})`,
      ),
    )
    .orderBy(asc(user.name), asc(adminStaff.userId))
}

async function absentAt(tx: Db, userId: string, at: Date): Promise<boolean> {
  const [row] = await tx
    .select({ id: adminStaffAbsence.id })
    .from(adminStaffAbsence)
    .where(
      and(
        eq(adminStaffAbsence.userId, userId),
        sql`${adminStaffAbsence.startsAt} <= ${at.toISOString()}::timestamptz`,
        gt(adminStaffAbsence.endsAt, at),
      ),
    )
    .limit(1)
  return Boolean(row)
}

/**
 * Las horas que se pueden ofrecer para una presentación de 45 min: el horario
 * de cada persona en Lima menos sus ausencias y sus presentaciones abiertas,
 * desde 2 h después de `now` hasta 14 días, a las :00 y las :30.
 *
 * Con persona preferida (el responsable del cliente) activa, con horario y que
 * no está ausente al empezar el tramo: solo sus horas. Si no (ausente, sin
 * horario, sin horas libres): la persona libre más temprana de las demás en
 * cada hora, sin cambiar al responsable. Nunca una persona ausente.
 */
export async function staffSlots(tx: Db, query: StaffSlotsQuery): Promise<StaffSlot[]> {
  const { now } = query
  const earliest = now.getTime() + PRESENTATION_LEAD_MS
  const latest = now.getTime() + PRESENTATION_HORIZON_DAYS * DAY
  const from = new Date(Math.max(query.from?.getTime() ?? earliest, earliest))
  const to = new Date(Math.min(query.to?.getTime() ?? latest, latest))
  const limit = Math.max(1, Math.min(query.limit ?? SLOTS_LIMIT, 200))
  if (to <= from) return []
  const staff = await presenters(tx)
  if (staff.length === 0) return []
  const spans = await freeSpans(
    tx,
    staff.map((person) => person.userId),
    from,
    to,
  )
  const slotOf = (person: { userId: string; name: string }, start: number, preferred: boolean) => ({
    startsAt: new Date(start),
    endsAt: new Date(start + PRESENTATION_MS),
    userId: person.userId,
    name: person.name,
    preferred,
  })
  if (query.onlyUserId) {
    const only = staff.find((person) => person.userId === query.onlyUserId)
    if (!only) return []
    return slotStarts(spans.get(only.userId) ?? [])
      .slice(0, limit)
      .map((start) => slotOf(only, start, true))
  }
  const preferred = query.preferUserId
    ? staff.find((person) => person.userId === query.preferUserId)
    : undefined
  if (preferred && !(await absentAt(tx, preferred.userId, from))) {
    const own = slotStarts(spans.get(preferred.userId) ?? [])
    if (own.length > 0) return own.slice(0, limit).map((start) => slotOf(preferred, start, true))
  }
  const byStart = new Map<number, { userId: string; name: string }>()
  for (const person of staff) {
    if (person.userId === preferred?.userId) continue
    for (const start of slotStarts(spans.get(person.userId) ?? [])) {
      if (!byStart.has(start)) byStart.set(start, person)
    }
  }
  return [...byStart.entries()]
    .sort(([a], [b]) => a - b)
    .slice(0, limit)
    .map(([start, person]) => slotOf(person, start, false))
}

/** La hora vale para agendar: a las :00 o :30 de Lima, con 2 h de aviso y dentro de 14 días. */
function requireBookable(field: string, startsAt: Date, now: Date): void {
  requireDate(field, startsAt, "Elige la hora")
  if (startsAt.getTime() % PRESENTATION_STEP_MS !== 0)
    throw invalidField(field, "La presentación empieza a la hora en punto o a la media")
  if (startsAt.getTime() < now.getTime() + PRESENTATION_LEAD_MS)
    throw invalidField(field, "Elige una hora con al menos 2 horas de aviso")
  if (startsAt.getTime() > now.getTime() + PRESENTATION_HORIZON_DAYS * DAY)
    throw invalidField(
      field,
      `Elige una hora dentro de los próximos ${PRESENTATION_HORIZON_DAYS} días`,
    )
}

function slotTaken(): ServiceError {
  return new ServiceError("SLOT_TAKEN", 409, "Esa hora ya no está libre: elige otra")
}

/** ¿Está libre la persona en `[start, start + 45 min)`? Con su horario, sin ausencias ni otra presentación. */
async function isFree(
  tx: Db,
  userId: string,
  startsAt: Date,
  endsAt: Date,
  exceptTaskId?: string,
): Promise<boolean> {
  const spans = (await freeSpans(tx, [userId], startsAt, endsAt, exceptTaskId)).get(userId) ?? []
  return fits(spans, startsAt.getTime(), endsAt.getTime())
}

/** Quiénes del equipo (activos, con horario) están libres en ese tramo, por nombre. */
export async function freePresenters(
  tx: Db,
  startsAt: Date,
  endsAt: Date,
  options: { except?: string[] } = {},
): Promise<Array<{ userId: string; name: string }>> {
  const staff = (await presenters(tx)).filter((person) => !options.except?.includes(person.userId))
  const spans = await freeSpans(
    tx,
    staff.map((person) => person.userId),
    startsAt,
    endsAt,
  )
  return staff.filter((person) =>
    fits(spans.get(person.userId) ?? [], startsAt.getTime(), endsAt.getTime()),
  )
}

/* ---------- Agendar, mover, cancelar, pasar ---------- */

const ZONE_WORDS = { timeZone: LIMA }

/** «martes 18 de noviembre a las 10:00», en Lima. */
export function presentationWhenWords(at: Date): string {
  const day = new Intl.DateTimeFormat("es-PE", {
    ...ZONE_WORDS,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(at)
  const time = new Intl.DateTimeFormat("es-PE", {
    ...ZONE_WORDS,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at)
  return `${day} a las ${time}`
}

/**
 * Le deja a quien presenta una tarea en Hoy con lo que cambió en su
 * presentación, si no lo hizo esa misma persona.
 */
async function tellPresenter(
  tx: Db,
  actor: AdminActor | null,
  task: { clientId: string; assigneeUserId: string | null },
  title: string,
  now: Date,
): Promise<void> {
  if (!task.assigneeUserId || actor?.userId === task.assigneeUserId) return
  const [row] = await tx
    .insert(saasTask)
    .values({
      clientId: task.clientId,
      kind: "otro",
      title: title.slice(0, 200),
      dueOn: limaDate(now),
      assigneeUserId: task.assigneeUserId,
      createdBy: actor?.userId ?? null,
      byKairos: actor === null,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: saasTask.id })
  await writeAdminAudit(tx, actor, {
    action: actor ? "arm.task_created" : "kairos.task_created",
    entityId: row?.id ?? null,
    metadata: { kind: "otro", clientId: task.clientId, aviso: "presentacion" },
  })
}

export interface BookPresentationInput {
  clientId: string
  contactId?: string | null
  startsAt: Date
  assigneeUserId: string
  /** La conversación en que se agendó: por ahí se le avisa. */
  chatId?: string | null
}

/**
 * Agenda una presentación de 45 min con quien presenta, con su candado: vuelve
 * a mirar que la hora siga libre (su horario, sin ausencia ni otra
 * presentación) y si no, `SLOT_TAKEN`. Es `schedulePresentation` con su fin y su
 * conversación. `actor` nulo es Kairós; un cliente sin responsable queda con
 * quien presenta.
 */
export async function bookPresentation(
  tx: Db,
  actor: AdminActor | null,
  input: BookPresentationInput,
  now = new Date(),
): Promise<TaskRow> {
  if (actor) requireStaffActor(actor)
  requireBookable("startsAt", input.startsAt, now)
  const member = await staffMember(tx, input.assigneeUserId).catch(() => null)
  if (!member?.active)
    throw invalidField("assigneeUserId", "Esa persona no es del equipo de la administración")
  if (input.chatId) {
    if (!UUID.test(input.chatId)) throw notFound("Conversación")
    const [chat] = await tx
      .select({ id: saasChat.id })
      .from(saasChat)
      .where(eq(saasChat.id, input.chatId))
      .limit(1)
    if (!chat) throw notFound("Conversación")
  }
  await lockPresenter(tx, member.userId)
  const endsAt = new Date(input.startsAt.getTime() + PRESENTATION_MS)
  if (!(await isFree(tx, member.userId, input.startsAt, endsAt))) throw slotTaken()
  const task = await schedulePresentation(
    tx,
    actor,
    input.clientId,
    {
      dueOn: limaDate(input.startsAt),
      dueAt: input.startsAt,
      contactId: input.contactId ?? null,
      assigneeUserId: member.userId,
    },
    now,
  )
  if (input.chatId)
    await tx
      .update(saasTask)
      .set({ channelChatId: input.chatId, updatedAt: now })
      .where(eq(saasTask.id, task.id))
  const owned = await tx
    .update(saasClient)
    .set({ ownerUserId: member.userId, updatedAt: now })
    .where(and(eq(saasClient.id, input.clientId), sql`${saasClient.ownerUserId} is null`))
    .returning({ id: saasClient.id, organizationId: saasClient.organizationId })
  if (owned[0])
    await writeAdminAudit(tx, actor, {
      action: actor ? "arm.client_owner_set" : "kairos.client_owner_set",
      organizationId: owned[0].organizationId,
      entityId: input.clientId,
      metadata: { ownerUserId: member.userId, why: "presentacion" },
    })
  if (actor?.userId !== member.userId)
    await tellPresenter(
      tx,
      actor,
      { clientId: input.clientId, assigneeUserId: member.userId },
      `Presentas a ${task.clientName} el ${presentationWhenWords(input.startsAt)}`,
      now,
    )
  return getClientTask(tx, task.id, now)
}

/** La presentación abierta con hora, bloqueada. */
async function lockPresentation(tx: Db, taskId: string) {
  if (!UUID.test(taskId)) throw notFound("Presentación")
  const [task] = await tx
    .select()
    .from(saasTask)
    .where(and(eq(saasTask.id, taskId), eq(saasTask.kind, "presentacion")))
    .limit(1)
    .for("update")
  if (!task) throw notFound("Presentación")
  if (task.status !== "abierta")
    throw new ServiceError(
      "TASK_CLOSED",
      409,
      task.status === "hecha" ? "Esa presentación ya se hizo" : "Esa presentación está cancelada",
    )
  const [client] = await tx
    .select({ name: saasClient.name })
    .from(saasClient)
    .where(eq(saasClient.id, task.clientId))
    .limit(1)
  return { task, clientName: client?.name ?? "la clínica" }
}

/** Mueve una presentación a otra hora libre de la misma persona, con su candado. */
export async function movePresentation(
  tx: Db,
  actor: AdminActor | null,
  taskId: string,
  startsAt: Date,
  now = new Date(),
): Promise<TaskRow> {
  if (actor) requireStaffActor(actor)
  const { task, clientName } = await lockPresentation(tx, taskId)
  requireBookable("startsAt", startsAt, now)
  if (!task.assigneeUserId) throw invalidField("assigneeUserId", "Elige primero quién presenta")
  await lockPresenter(tx, task.assigneeUserId)
  const endsAt = new Date(startsAt.getTime() + PRESENTATION_MS)
  if (!(await isFree(tx, task.assigneeUserId, startsAt, endsAt, task.id))) throw slotTaken()
  await tx
    .update(saasTask)
    .set({
      dueOn: limaDate(startsAt),
      dueAt: startsAt,
      endsAt: presentationEndsAt("presentacion", startsAt),
      needsNewTimeAt: null,
      updatedAt: now,
    })
    .where(eq(saasTask.id, task.id))
  await writeAdminAudit(tx, actor, {
    action: actor ? "arm.presentation_moved" : "kairos.presentation_moved",
    entityId: task.clientId,
    metadata: {
      taskId: task.id,
      from: task.dueAt?.toISOString() ?? null,
      to: startsAt.toISOString(),
    },
  })
  await tellPresenter(
    tx,
    actor,
    task,
    `La presentación de ${clientName} pasó al ${presentationWhenWords(startsAt)}`,
    now,
  )
  return getClientTask(tx, task.id, now)
}

/** Cancela una presentación abierta; quien presenta lo ve en Hoy. */
export async function cancelPresentation(
  tx: Db,
  actor: AdminActor | null,
  taskId: string,
  input: { reason?: string | null } = {},
  now = new Date(),
): Promise<TaskRow> {
  if (actor) requireStaffActor(actor)
  const { task, clientName } = await lockPresentation(tx, taskId)
  const reason = (input.reason ?? "").trim().slice(0, 2000) || "Se canceló la presentación"
  await tx
    .update(saasTask)
    .set({
      status: "cancelada",
      doneAt: now,
      doneBy: actor?.userId ?? null,
      doneNote: reason,
      updatedAt: now,
    })
    .where(eq(saasTask.id, task.id))
  await writeAdminAudit(tx, actor, {
    action: actor ? "arm.presentation_cancelled" : "kairos.presentation_cancelled",
    entityId: task.clientId,
    metadata: { taskId: task.id },
  })
  await tellPresenter(
    tx,
    actor,
    task,
    task.dueAt
      ? `Se canceló la presentación de ${clientName} del ${presentationWhenWords(task.dueAt)}`
      : `Se canceló la presentación de ${clientName}`,
    now,
  )
  return getClientTask(tx, task.id, now)
}

/**
 * Pasa una presentación a otra persona del equipo, solo si está libre a esa
 * hora (su horario, sin ausencia ni otra presentación); si no, `STAFF_BUSY`.
 * El responsable del cliente no cambia. Lo hace Administración o quien la
 * tenía.
 */
export async function reassignPresentation(
  tx: Db,
  actor: AdminActor,
  taskId: string,
  toUserId: string,
  now = new Date(),
): Promise<TaskRow> {
  requireStaffActor(actor)
  const { task, clientName } = await lockPresentation(tx, taskId)
  if (actor.role !== "admin" && actor.userId !== task.assigneeUserId)
    throw forbidden("Solo Administración o quien la tiene pasa una presentación")
  if (!task.dueAt) throw invalidField("taskId", "Esa presentación no tiene hora")
  if (task.assigneeUserId === toUserId) return getClientTask(tx, task.id, now)
  const target = await staffMember(tx, toUserId).catch(() => null)
  if (!target?.active)
    throw invalidField("toUserId", "Esa persona no es del equipo de la administración")
  if (task.adminOnly && target.role !== "admin")
    throw invalidField("toUserId", "Esta presentación es solo de Administración")
  await lockPresenter(tx, toUserId)
  const endsAt = task.endsAt ?? new Date(task.dueAt.getTime() + PRESENTATION_MS)
  if (!(await isFree(tx, toUserId, task.dueAt, endsAt, task.id)))
    throw new ServiceError(
      "STAFF_BUSY",
      409,
      `${target.name} no está libre a esa hora: elige a otra persona o pide otra hora`,
    )
  await tx
    .update(saasTask)
    .set({ assigneeUserId: toUserId, needsNewTimeAt: null, updatedAt: now })
    .where(eq(saasTask.id, task.id))
  await writeAdminAudit(tx, actor, {
    action: "arm.presentation_reassigned",
    entityId: task.clientId,
    metadata: { taskId: task.id, fromUserId: task.assigneeUserId, toUserId },
  })
  await tellPresenter(
    tx,
    actor,
    { clientId: task.clientId, assigneeUserId: toUserId },
    `Ahora presentas tú a ${clientName} el ${presentationWhenWords(task.dueAt)}`,
    now,
  )
  return getClientTask(tx, task.id, now)
}

/* ---------- Lo que Kairós propone en una conversación ---------- */

export interface KairosProposalRow {
  id: string
  chatId: string
  clientId: string | null
  assigneeUserId: string
  startsAt: Date
  status: KairosProposalStatus
  expiresAt: Date
  taskId: string | null
  createdAt: Date
}

function proposalRowOf(row: typeof kairosProposal.$inferSelect): KairosProposalRow {
  return { ...row, status: row.status as KairosProposalStatus }
}

/** Vence lo propuesto que pasó sus 48 h sin confirmarse. Perezoso: antes de proponer o confirmar. */
export async function expireKairosProposals(tx: Db, now = new Date()): Promise<number> {
  const done = await tx
    .update(kairosProposal)
    .set({ status: "vencida", updatedAt: now })
    .where(
      and(
        eq(kairosProposal.status, "pendiente"),
        sql`${kairosProposal.expiresAt} <= ${now.toISOString()}::timestamptz`,
      ),
    )
    .returning({ id: kairosProposal.id })
  return done.length
}

/**
 * Kairós le propone una hora a quien escribe: la última manda, así que la
 * pendiente de esa conversación queda reemplazada. La hora tiene que estar
 * libre ahora (`SLOT_TAKEN` si no); se vuelve a mirar al confirmar.
 */
export async function proposeSlot(
  tx: Db,
  input: { chatId: string; clientId?: string | null; assigneeUserId: string; startsAt: Date },
  now = new Date(),
): Promise<KairosProposalRow> {
  if (!UUID.test(input.chatId)) throw notFound("Conversación")
  const [chat] = await tx
    .select({ id: saasChat.id, clientId: saasChat.clientId })
    .from(saasChat)
    .where(eq(saasChat.id, input.chatId))
    .limit(1)
    .for("update")
  if (!chat) throw notFound("Conversación")
  requireBookable("startsAt", input.startsAt, now)
  const member = await staffMember(tx, input.assigneeUserId).catch(() => null)
  if (!member?.active)
    throw invalidField("assigneeUserId", "Esa persona no es del equipo de la administración")
  const endsAt = new Date(input.startsAt.getTime() + PRESENTATION_MS)
  if (!(await isFree(tx, member.userId, input.startsAt, endsAt))) throw slotTaken()
  const clientId = input.clientId ?? chat.clientId
  if (clientId) {
    const [client] = await tx
      .select({ id: saasClient.id })
      .from(saasClient)
      .where(eq(saasClient.id, clientId))
      .limit(1)
    if (!client) throw notFound("Cliente")
  }
  await expireKairosProposals(tx, now)
  await tx
    .update(kairosProposal)
    .set({ status: "reemplazada", updatedAt: now })
    .where(and(eq(kairosProposal.chatId, chat.id), eq(kairosProposal.status, "pendiente")))
  const [row] = await tx
    .insert(kairosProposal)
    .values({
      chatId: chat.id,
      clientId,
      assigneeUserId: member.userId,
      startsAt: input.startsAt,
      expiresAt: new Date(now.getTime() + KAIROS_PROPOSAL_HOURS * HOUR),
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  if (!row) throw new ServiceError("INTERNAL", 500, "No se pudo guardar la propuesta")
  return proposalRowOf(row)
}

/** La propuesta pendiente de una conversación, si tiene y no venció. */
export async function pendingKairosProposal(
  tx: Db,
  chatId: string,
  now = new Date(),
): Promise<KairosProposalRow | null> {
  if (!UUID.test(chatId)) return null
  const [row] = await tx
    .select()
    .from(kairosProposal)
    .where(
      and(
        eq(kairosProposal.chatId, chatId),
        eq(kairosProposal.status, "pendiente"),
        gt(kairosProposal.expiresAt, now),
      ),
    )
    .limit(1)
  return row ? proposalRowOf(row) : null
}

export type ConfirmProposalResult =
  | { status: "confirmada"; proposal: KairosProposalRow; task: TaskRow }
  | {
      status: "vencida"
      proposal: KairosProposalRow
      error: { code: "SLOT_TAKEN" | "PROPOSAL_EXPIRED"; message: string }
    }

/**
 * Confirma lo propuesto: agenda con `bookPresentation` (candado y choque) y la
 * propuesta queda confirmada con su presentación. Si la hora ya se la ganó
 * otro o pasaron las 48 h, queda vencida y lo devuelve (no lanza: lo vencido
 * se guarda). Sin cliente todavía (falta decir de qué clínica es), 409 y sigue
 * pendiente.
 */
export async function confirmProposal(
  tx: Db,
  proposalId: string,
  now = new Date(),
): Promise<ConfirmProposalResult> {
  if (!UUID.test(proposalId)) throw notFound("Propuesta")
  const [proposal] = await tx
    .select()
    .from(kairosProposal)
    .where(eq(kairosProposal.id, proposalId))
    .limit(1)
    .for("update")
  if (!proposal) throw notFound("Propuesta")
  if (proposal.status !== "pendiente")
    throw new ServiceError("PROPOSAL_CLOSED", 409, "Esa hora ya no está propuesta")
  const expire = async (code: "SLOT_TAKEN" | "PROPOSAL_EXPIRED", message: string) => {
    const [row] = await tx
      .update(kairosProposal)
      .set({ status: "vencida", updatedAt: now })
      .where(eq(kairosProposal.id, proposal.id))
      .returning()
    return {
      status: "vencida" as const,
      proposal: proposalRowOf(row ?? { ...proposal, status: "vencida" }),
      error: { code, message },
    }
  }
  if (proposal.expiresAt <= now)
    return expire("PROPOSAL_EXPIRED", "Pasaron 48 horas desde que se propuso esa hora")
  const [chat] = await tx
    .select({ clientId: saasChat.clientId, contactId: saasChat.contactId })
    .from(saasChat)
    .where(eq(saasChat.id, proposal.chatId))
    .limit(1)
  const clientId = proposal.clientId ?? chat?.clientId ?? null
  if (!clientId)
    throw new ServiceError(
      "CLIENT_REQUIRED",
      409,
      "Falta decir de qué clínica es esta conversación",
    )
  let task: TaskRow
  try {
    task = await tx.transaction((inner) =>
      bookPresentation(
        inner as Db,
        null,
        {
          clientId,
          contactId: chat?.clientId === clientId ? (chat?.contactId ?? null) : null,
          startsAt: proposal.startsAt,
          assigneeUserId: proposal.assigneeUserId,
          chatId: proposal.chatId,
        },
        now,
      ),
    )
  } catch (error) {
    // Ya ocupada, o ya sin las 2 h de aviso: esa hora no se puede dar.
    if (error instanceof ServiceError && (error.code === "SLOT_TAKEN" || error.fields?.startsAt))
      return expire("SLOT_TAKEN", error.message)
    throw error
  }
  const [row] = await tx
    .update(kairosProposal)
    .set({ status: "confirmada", clientId, taskId: task.id, updatedAt: now })
    .where(eq(kairosProposal.id, proposal.id))
    .returning()
  return { status: "confirmada", proposal: proposalRowOf(row ?? proposal), task }
}

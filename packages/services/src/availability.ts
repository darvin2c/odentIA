/**
 * Disponibilidad de agenda: horarios por profesional/sede, bloqueos y
 * ausencias, consulta de huecos con zona IANA y lista de espera.
 * Comparte las invariantes con reserva/movimiento (appointments.ts valida
 * contra estas mismas reglas) para que agentes y portal no calculen
 * huecos por su cuenta. Toda función recibe `tx: Db` ya contextualizado.
 */
import type { Db } from "@odentia/db"
import { appointment, scheduleRoom } from "@odentia/db/schema/agenda"
import {
  SCHEDULE_BLOCK_KINDS,
  professionalSchedule,
  scheduleBlock,
  type ScheduleBlockKind,
} from "@odentia/db/schema/availability"
import { member, user } from "@odentia/db/schema/auth"
import { serviceCatalog } from "@odentia/db/schema/clinical"
import { branch, orgProfile } from "@odentia/db/schema/org"
import { and, asc, eq, gt, gte, inArray, isNull, lt, ne, or } from "drizzle-orm"
import { branchNotFound, roomNotFound, notFound, ServiceError, validation } from "./errors.js"
import { NEUTRAL_TIMEZONE, roomWord } from "./locale.js"
import { type AttendingRule, attendingRule } from "./specialties.js"

// Sin zona en la sede ni en la organización: UTC, nunca la de un país.
const FALLBACK_TZ = NEUTRAL_TIMEZONE
const MAX_RANGE_DAYS = 62
const MAX_SLOTS = 200

function conflict(code: string, message: string): ServiceError {
  return new ServiceError(code, 409, message)
}

function parseInstant(value: string, field: string): Date {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw validation(`${field} debe ser una fecha ISO válida`)
  return date
}

function assertWeekday(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 6) {
    throw validation("El día de semana debe estar entre 0 (domingo) y 6 (sábado)")
  }
}

function assertMinutes(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 1440) {
    throw validation(`${field} debe estar entre 0 y 1440 minutos`)
  }
}
/** Zona válida o error explícito: nunca se asume un huso ante un valor inválido. */
function assertTimeZone(value: string, field: string): string {
  const candidate = value.trim()
  if (!candidate) throw validation(`${field} es obligatoria`)
  try {
    new Intl.DateTimeFormat("en", { timeZone: candidate })
    return candidate
  } catch {
    throw validation(`${field} inválida: ${value}`)
  }
}

/**
 * Zona de la sede: branch.timezone ?? organización, con el valor por defecto
 * del perfil solo ante ausencia heredada (igual que el resto del repo).
 */
function branchTimeZone(branchZone: string | null, orgZone: string | null): string {
  if (branchZone) return assertTimeZone(branchZone, "La zona horaria de la sede")
  if (orgZone) return assertTimeZone(orgZone, "La zona horaria de la organización")
  return FALLBACK_TZ
}

interface ZonedParts {
  year: number
  month: number
  day: number
  weekday: number
  minutes: number
}

/**
 * Un formateador por zona y forma: crearlo cuesta más que usarlo, y una consulta de huecos
 * convierte cada hora candidata de cada profesional y día.
 */
const zoneFormats = new Map<string, Intl.DateTimeFormat>()
function zoneFormat(timeZone: string, withSeconds: boolean): Intl.DateTimeFormat {
  const key = `${withSeconds ? "s" : "m"}|${timeZone}`
  let format = zoneFormats.get(key)
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      ...(withSeconds ? { second: "2-digit" as const } : {}),
      hour12: false,
    })
    zoneFormats.set(key, format)
  }
  return format
}

function zonedPartsOf(instant: Date, timeZone: string): ZonedParts {
  const parts = zoneFormat(timeZone, false).formatToParts(instant)
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value)
  const year = get("year")
  const month = get("month")
  const day = get("day")
  return {
    year,
    month,
    day,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    minutes: get("hour") * 60 + get("minute"),
  }
}

function tzOffsetMs(timeZone: string, instant: Date): number {
  const parts = zoneFormat(timeZone, true).formatToParts(instant)
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value)
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"))
  return asUtc - instant.getTime()
}

/** Fecha local (YYYY-MM-DD) + minutos → instante UTC en la zona indicada. */
export function zonedTimeToUtc(date: string, minutes: number, timeZone: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw validation("La fecha debe tener formato YYYY-MM-DD")
  const [year, month, day] = date.split("-").map(Number) as [number, number, number]
  const guess = Date.UTC(year, (month as number) - 1, day, Math.floor(minutes / 60), minutes % 60)
  const once = new Date(guess - tzOffsetMs(timeZone, new Date(guess)))
  return new Date(guess - tzOffsetMs(timeZone, once))
}

function zonedDayStartUtc(date: string, timeZone: string): Date {
  return zonedTimeToUtc(date, 0, timeZone)
}

function toISODate(year: number, month: number, day: number): string {
  const pad = (value: number): string => String(value).padStart(2, "0")
  return `${year}-${pad(month)}-${pad(day)}`
}

async function requireBranch(tx: Db, orgId: string, branchId: string) {
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
    .where(and(eq(branch.organizationId, orgId), eq(branch.id, branchId), eq(branch.isActive, true)))
    .limit(1)
  if (!row) throw branchNotFound()
  return { ...row, timeZone: branchTimeZone(row.timezone, row.orgTimezone) }
}

async function requireProfessional(tx: Db, orgId: string, professionalUserId: string) {
  const [membership] = await tx
    .select({ id: member.id, name: user.name })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(member.organizationId, orgId), eq(member.userId, professionalUserId)))
    .limit(1)
  if (!membership) throw notFound("Profesional")
  return membership
}

async function requireRoomInBranch(tx: Db, orgId: string, roomId: string, branchId: string) {
  const [row] = await tx
    .select({ id: scheduleRoom.id, name: scheduleRoom.name })
    .from(scheduleRoom)
    .where(
      and(
        eq(scheduleRoom.organizationId, orgId),
        eq(scheduleRoom.id, roomId),
        eq(scheduleRoom.branchId, branchId),
        eq(scheduleRoom.isActive, true),
      ),
    )
    .limit(1)
  if (!row) throw roomNotFound((await roomWord(tx, orgId)).one)
  return row
}

function assertBlockKind(kind: string): ScheduleBlockKind {
  if (!(SCHEDULE_BLOCK_KINDS as readonly string[]).includes(kind)) {
    throw validation(`Tipo de bloqueo inválido: ${kind}`)
  }
  return kind as ScheduleBlockKind
}

/* Horarios semanales */

export interface ScheduleRuleInput {
  weekday: number
  startMin: number
  endMin: number
}

export interface ScheduleRule extends ScheduleRuleInput {
  id: string
  isActive: boolean
}

export interface ProfessionalScheduleView {
  branchId: string
  professionalUserId: string
  timeZone: string
  rules: ScheduleRule[]
  /** Desde qué día (de la sede) vale el horario de hoy; nulo sin horario. */
  validFrom: string | null
}

/** Horario activo de un profesional en una sede (vacío = sin configurar). */
export async function getProfessionalSchedule(
  tx: Db,
  orgId: string,
  branchId: string,
  professionalUserId: string,
): Promise<ProfessionalScheduleView> {
  const resolved = await requireBranch(tx, orgId, branchId)
  await requireProfessional(tx, orgId, professionalUserId)
  const rows = await tx
    .select()
    .from(professionalSchedule)
    .where(
      and(
        eq(professionalSchedule.organizationId, orgId),
        eq(professionalSchedule.branchId, branchId),
        eq(professionalSchedule.professionalUserId, professionalUserId),
        eq(professionalSchedule.isActive, true),
      ),
    )
    .orderBy(asc(professionalSchedule.weekday), asc(professionalSchedule.startMin))
  return {
    branchId,
    professionalUserId,
    timeZone: resolved.timeZone,
    rules: rows.map((row) => ({
      id: row.id,
      weekday: row.weekday,
      startMin: row.startMin,
      endMin: row.endMin,
      isActive: row.isActive,
    })),
    validFrom: rows.reduce<string | null>((first, row) => (first === null || row.validFrom < first ? row.validFrom : first), null),
  }
}

/**
 * Cambia el horario semanal del profesional en la sede desde hoy (día de la
 * sede). El anterior no se borra: se cierra, para que la historia de la
 * agenda sea verdadera (decisión 4 de Reportes; ADR 0060). Lo que empezó hoy
 * mismo se reemplaza: un día no tiene dos horarios. Guardar el mismo horario
 * no deja otra versión. Reglas vacías = sin atención desde hoy.
 */
export async function setProfessionalSchedule(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: { branchId: string; professionalUserId: string; rules: ScheduleRuleInput[] },
): Promise<ProfessionalScheduleView> {
  const resolved = await requireBranch(tx, orgId, input.branchId)
  await requireProfessional(tx, orgId, input.professionalUserId)
  const seen = new Set<string>()
  for (const rule of input.rules) {
    assertWeekday(rule.weekday)
    assertMinutes(rule.startMin, "El inicio")
    assertMinutes(rule.endMin, "El fin")
    if (rule.endMin <= rule.startMin) throw validation("El fin del turno debe ser posterior al inicio")
    const key = `${rule.weekday}:${rule.startMin}:${rule.endMin}`
    if (seen.has(key)) throw validation("Hay turnos duplicados en el horario")
    seen.add(key)
  }
  const scope = and(
    eq(professionalSchedule.organizationId, orgId),
    eq(professionalSchedule.branchId, input.branchId),
    eq(professionalSchedule.professionalUserId, input.professionalUserId),
  )
  const current = await tx
    .select()
    .from(professionalSchedule)
    .where(and(scope, eq(professionalSchedule.isActive, true)))
    .for("update")
  const same =
    current.length === input.rules.length &&
    current.every((row) => seen.has(`${row.weekday}:${row.startMin}:${row.endMin}`))
  if (same) return getProfessionalSchedule(tx, orgId, input.branchId, input.professionalUserId)
  const { year, month, day } = zonedPartsOf(new Date(), resolved.timeZone)
  const today = toISODate(year, month, day)
  // Lo que empezó hoy se reemplaza; lo de antes deja de valer hoy.
  await tx.delete(professionalSchedule).where(and(scope, eq(professionalSchedule.isActive, true), eq(professionalSchedule.validFrom, today)))
  await tx
    .update(professionalSchedule)
    .set({ isActive: false, validUntil: today, updatedAt: new Date() })
    .where(and(scope, eq(professionalSchedule.isActive, true)))
  if (input.rules.length > 0) {
    await tx.insert(professionalSchedule).values(
      input.rules.map((rule) => ({
        organizationId: orgId,
        branchId: input.branchId,
        professionalUserId: input.professionalUserId,
        weekday: rule.weekday,
        startMin: rule.startMin,
        endMin: rule.endMin,
        isActive: true,
        validFrom: today,
        createdBy: actorUserId,
      })),
    )
  }
  return getProfessionalSchedule(tx, orgId, input.branchId, input.professionalUserId)
}

/* Bloqueos y ausencias */

export interface ScheduleBlockItem {
  id: string
  branchId: string
  professionalUserId: string | null
  professionalName: string | null
  roomId: string | null
  kind: ScheduleBlockKind
  reason: string | null
  startsAt: string
  endsAt: string
}

export interface CreateBlockInput {
  branchId: string
  professionalUserId?: string | null
  roomId?: string | null
  kind?: string
  reason?: string
  startsAt: string
  endsAt: string
}

export async function listScheduleBlocks(
  tx: Db,
  orgId: string,
  input: { branchId: string; from: string; to: string },
): Promise<ScheduleBlockItem[]> {
  await requireBranch(tx, orgId, input.branchId)
  const from = parseInstant(input.from, "from")
  const to = parseInstant(input.to, "to")
  if (to <= from) throw validation("El rango de bloqueos es inválido")
  const rows = await tx
    .select({ block: scheduleBlock, professionalName: user.name })
    .from(scheduleBlock)
    .leftJoin(user, eq(user.id, scheduleBlock.professionalUserId))
    .where(
      and(
        eq(scheduleBlock.organizationId, orgId),
        eq(scheduleBlock.branchId, input.branchId),
        lt(scheduleBlock.startsAt, to),
        gte(scheduleBlock.endsAt, from),
      ),
    )
    .orderBy(asc(scheduleBlock.startsAt))
  return rows.map((row) => ({
    id: row.block.id,
    branchId: row.block.branchId,
    professionalUserId: row.block.professionalUserId,
    professionalName: row.professionalName,
    roomId: row.block.roomId,
    kind: assertBlockKind(row.block.kind),
    reason: row.block.reason,
    startsAt: row.block.startsAt.toISOString(),
    endsAt: row.block.endsAt.toISOString(),
  }))
}

export async function createScheduleBlock(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: CreateBlockInput,
): Promise<ScheduleBlockItem> {
  await requireBranch(tx, orgId, input.branchId)
  const startsAt = parseInstant(input.startsAt, "startsAt")
  const endsAt = parseInstant(input.endsAt, "endsAt")
  if (endsAt <= startsAt) throw validation("El bloqueo debe terminar después de iniciar")
  if (input.professionalUserId) await requireProfessional(tx, orgId, input.professionalUserId)
  if (input.roomId) await requireRoomInBranch(tx, orgId, input.roomId, input.branchId)
  // Sin profesional ni unidad dental, el bloqueo cierra la sede completa.
  const kind = assertBlockKind(input.kind ?? "bloqueo")
  const [created] = await tx
    .insert(scheduleBlock)
    .values({
      organizationId: orgId,
      branchId: input.branchId,
      professionalUserId: input.professionalUserId ?? null,
      roomId: input.roomId ?? null,
      kind,
      reason: input.reason?.trim() || null,
      startsAt,
      endsAt,
      createdBy: actorUserId,
    })
    .returning({ id: scheduleBlock.id })
  if (!created) throw new Error("No se pudo crear el bloqueo")
  const [item] = await listScheduleBlocks(tx, orgId, {
    branchId: input.branchId,
    from: new Date(startsAt.getTime() - 1000).toISOString(),
    to: new Date(endsAt.getTime() + 1000).toISOString(),
  }).then((items) => [items.find((entry) => entry.id === created.id)])
  if (!item) throw new Error("No se pudo leer el bloqueo creado")
  return item
}

export async function deleteScheduleBlock(
  tx: Db,
  orgId: string,
  id: string,
): Promise<void> {
  const [deleted] = await tx
    .delete(scheduleBlock)
    .where(and(eq(scheduleBlock.organizationId, orgId), eq(scheduleBlock.id, id)))
    .returning({ id: scheduleBlock.id })
  if (!deleted) throw notFound("Bloqueo")
}

/* Validación de disponibilidad (reserva y movimiento) */

export interface AvailabilityCheck {
  branchId: string
  professionalUserId: string
  roomId: string
  startsAt: Date
  endsAt: Date
  ignoreAppointmentId?: string
  /** Urgencia: se reserva aunque el horario del profesional no cubra ese momento. */
  allowOutsideSchedule?: boolean
  /**
   * Cita de prueba (ADR 0094): choca con todo, como en real. Una real solo
   * choca con las reales: una prueba no ocupa el horario de nadie.
   */
  forTest?: boolean
}

async function overlappingBlocks(
  tx: Db,
  orgId: string,
  check: AvailabilityCheck,
): Promise<typeof scheduleBlock.$inferSelect | undefined> {
  const professionalScope = or(
    isNull(scheduleBlock.professionalUserId),
    eq(scheduleBlock.professionalUserId, check.professionalUserId),
  )
  const roomScope = or(isNull(scheduleBlock.roomId), eq(scheduleBlock.roomId, check.roomId))
  if (!professionalScope || !roomScope) return undefined
  const [row] = await tx
    .select()
    .from(scheduleBlock)
    .where(
      and(
        eq(scheduleBlock.organizationId, orgId),
        eq(scheduleBlock.branchId, check.branchId),
        professionalScope,
        roomScope,
        lt(scheduleBlock.startsAt, check.endsAt),
        gt(scheduleBlock.endsAt, check.startsAt),
      ),
    )
    .limit(1)
  return row
}

async function overlappingAppointment(
  tx: Db,
  orgId: string,
  check: AvailabilityCheck,
): Promise<typeof appointment.$inferSelect | undefined> {
  const conditions = [
    eq(appointment.organizationId, orgId),
    or(
      eq(appointment.professionalUserId, check.professionalUserId),
      eq(appointment.roomId, check.roomId),
    ),
    inArray(appointment.status, ["programada", "confirmada"]),
    lt(appointment.startsAt, check.endsAt),
    gt(appointment.endsAt, check.startsAt),
  ]
  const scope = conditions[1]
  if (!scope) return undefined
  const [row] = await tx
    .select()
    .from(appointment)
    .where(
      and(
        ...conditions,
        check.forTest ? undefined : eq(appointment.isTest, false),
        check.ignoreAppointmentId ? ne(appointment.id, check.ignoreAppointmentId) : undefined,
      ),
    )
    .limit(1)
  return row
}

/**
 * Totales por día local cubierto: cada tramo del intervalo debe caer dentro
 * de un turno activo del profesional. Sin turnos configurados se rechaza:
 * el profesional necesita horario explícito.
 */
export async function validateAvailability(
  tx: Db,
  orgId: string,
  check: AvailabilityCheck,
): Promise<void> {
  if (check.endsAt <= check.startsAt) throw validation("La cita debe terminar después de iniciar")
  const resolved = await requireBranch(tx, orgId, check.branchId)
  await requireProfessional(tx, orgId, check.professionalUserId)
  await requireRoomInBranch(tx, orgId, check.roomId, check.branchId)
  const rules = await tx
    .select()
    .from(professionalSchedule)
    .where(
      and(
        eq(professionalSchedule.organizationId, orgId),
        eq(professionalSchedule.branchId, check.branchId),
        eq(professionalSchedule.professionalUserId, check.professionalUserId),
        eq(professionalSchedule.isActive, true),
      ),
    )
  if (rules.length === 0 && !check.allowOutsideSchedule) {
    throw validation("El profesional no tiene horario configurado en esta sede")
  }
  // Parte el intervalo por días locales y exige un turno que cubra cada tramo.
  let cursor = check.startsAt
  for (let guard = 0; guard < 8; guard++) {
    const startParts = zonedPartsOf(cursor, resolved.timeZone)
    const dayLabel = toISODate(startParts.year, startParts.month, startParts.day)
    const nextDay = new Date(zonedDayStartUtc(dayLabel, resolved.timeZone).getTime() + 86_400_000)
    const segmentEnd = check.endsAt < nextDay ? check.endsAt : nextDay
    const endProbe = new Date(segmentEnd.getTime() - 1)
    const endParts = zonedPartsOf(endProbe > cursor ? endProbe : cursor, resolved.timeZone)
    const covered = rules.some(
      (rule) =>
        rule.weekday === startParts.weekday &&
        rule.startMin <= startParts.minutes &&
        endParts.weekday === startParts.weekday &&
        endParts.minutes < rule.endMin,
    )
    if (!covered && !check.allowOutsideSchedule) {
      throw validation("El horario del profesional no cubre ese momento en esta sede")
    }
    if (segmentEnd >= check.endsAt) break
    cursor = segmentEnd
    if (guard === 7) throw validation("El intervalo supera el máximo admitido")
  }
  const block = await overlappingBlocks(tx, orgId, check)
  if (block) {
    throw conflict(
      "SCHEDULE_BLOCKED",
      block.kind === "ausencia"
        ? "El profesional está ausente en ese horario"
        : "La agenda está bloqueada en ese horario",
    )
  }
  const clash = await overlappingAppointment(tx, orgId, check)
  if (clash) {
    throw conflict(
      "APPOINTMENT_CONFLICT",
      `El profesional o la ${(await roomWord(tx, orgId)).one} ya están ocupados en ese horario`,
    )
  }
}

/* Huecos libres */

/**
 * Lo que se le ofrece a la persona para reservar sola (su enlace, Sofi) empieza
 * al menos media hora después: una hora que empieza en tres minutos no le da
 * tiempo de llegar y termina en una cita perdida (ADR 0113). Recepción sigue
 * viendo el primer hueco libre.
 */
export const SELF_BOOKING_LEAD_MS = 30 * 60_000

/** Desde cuándo se ofrece una hora a quien reserva sola. */
export function selfBookingNotBefore(now = new Date()): string {
  return new Date(now.getTime() + SELF_BOOKING_LEAD_MS).toISOString()
}

export interface SlotsQuery {
  branchId: string
  professionalUserId?: string
  roomId?: string
  serviceId?: string
  from: string
  to: string
  durationMin?: number
  timeZone?: string
  /** Cada cuántos minutos empieza un hueco; sin indicar, `bookingStepMin` de la duración. */
  stepMin?: number
  /** Descarta los huecos que empiezan antes de este instante (lo ya pasado no se ofrece). */
  notBefore?: string
  /** Solo el primer hueco de cada profesional: responde «quién puede atender primero». */
  firstPerProfessional?: boolean
  /**
   * Como mucho estos huecos por profesional y día, repartidos en su jornada: el
   * primero, el último y los de en medio. Así una lista corta no se la queda una
   * sola persona y se ve también la tarde (decisión 16 de la fase 4). Se reparte
   * antes del tope de 200, así que el tope cuenta lo que se ofrece.
   */
  perProfessionalPerDay?: number
  /** Para una persona de prueba (ADR 0094): sus huecos descuentan también las otras pruebas. */
  forTest?: boolean
}

export interface AvailableSlot {
  startsAt: string
  endsAt: string
  professionalUserId: string
  professionalName: string
  roomId: string | null
  roomName: string | null
  timeZone: string
}

export interface AvailableSlotsResult {
  /** Ordenados por hora, mezclando a los profesionales. */
  slots: AvailableSlot[]
  /** true si se alcanzó el tope de 200: hay más huecos fuera de la respuesta. */
  truncated: boolean
  timeZone: string
  /**
   * Si el servicio pedido tiene quien lo atienda en la sede, solo se ofrecen
   * sus huecos: aquí van su especialidad y quiénes son (ADR 0039).
   */
  attending: AttendingRule | null
}

/**
 * Cada cuántos minutos se ofrece una hora a quien reserva: una por cada cita
 * que cabe (redondeada a 5 minutos, entre 15 y 60), no cada cuarto de hora.
 * Menos opciones y las mismas posibilidades reales. Es una sola regla para el
 * enlace, el portal y el agente: la persona ve las mismas horas por cualquier vía.
 */
export function bookingStepMin(durationMin: number): number {
  return Math.min(60, Math.max(15, Math.round(durationMin / 5) * 5))
}

/**
 * De los huecos de un día, ya ordenados por hora, como mucho `perDay` por
 * profesional: el primero, el último y los de en medio repartidos. Con los
 * primeros nada más, quien tenía la tarde libre solo aparecía a primera hora y
 * la persona creía que no había más (auditoría del ADR 0104).
 */
function spreadOverDay(daySlots: AvailableSlot[], perDay: number): AvailableSlot[] {
  const byProfessional = new Map<string, AvailableSlot[]>()
  for (const slot of daySlots) {
    const own = byProfessional.get(slot.professionalUserId)
    if (own) own.push(slot)
    else byProfessional.set(slot.professionalUserId, [slot])
  }
  const kept = new Set<AvailableSlot>()
  for (const own of byProfessional.values()) {
    if (own.length <= perDay) {
      for (const slot of own) kept.add(slot)
      continue
    }
    for (let i = 0; i < perDay; i++) kept.add(own[Math.round((i * (own.length - 1)) / Math.max(1, perDay - 1))]!)
  }
  return daySlots.filter((slot) => kept.has(slot))
}

/**
 * Huecos reservables en la zona IANA de la sede (o la pedida si es
 * válida). Solo profesionales con horario explícito; descuenta citas
 * ocupantes, bloqueos y ausencias. Con servicio, solo quien lo atiende
 * (`attendingRule`, la misma regla para recepción, el enlace, el portal y el
 * agente). Ordenados por hora. Máximo 200 huecos y 62 días por consulta:
 * `truncated` avisa del recorte para acotar el rango o paginar por días.
 */
export async function listAvailableSlots(
  tx: Db,
  orgId: string,
  input: SlotsQuery,
): Promise<AvailableSlotsResult> {
  const resolved = await requireBranch(tx, orgId, input.branchId)
  const timeZone = input.timeZone
    ? assertTimeZone(input.timeZone, "La zona horaria pedida")
    : resolved.timeZone
  const from = parseInstant(input.from, "from")
  const to = parseInstant(input.to, "to")
  if (to <= from) throw validation("El rango de huecos es inválido")
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000) {
    throw validation(`El rango máximo es de ${MAX_RANGE_DAYS} días`)
  }
  let duration = input.durationMin
  if (input.serviceId) {
    const [service] = await tx
      .select({ id: serviceCatalog.id, durationMin: serviceCatalog.durationMin })
      .from(serviceCatalog)
      .where(
        and(
          eq(serviceCatalog.organizationId, orgId),
          eq(serviceCatalog.id, input.serviceId),
          eq(serviceCatalog.isActive, true),
        ),
      )
      .limit(1)
    if (!service) throw notFound("Servicio")
    duration ??= service.durationMin ?? undefined
  }
  // Sin servicio ni duración pedida: lo que dura una cita regular en la sede.
  duration ??= resolved.defaultMinutes
  if (!Number.isInteger(duration) || (duration as number) <= 0 || (duration as number) > 480) {
    throw validation("La duración debe estar entre 1 y 480 minutos")
  }
  const slotMin: number = duration
  const step = input.stepMin ?? bookingStepMin(slotMin)
  if (!Number.isInteger(step) || step < 5 || step > 120) {
    throw validation("El paso debe estar entre 5 y 120 minutos")
  }
  const perDay = input.perProfessionalPerDay
  if (perDay !== undefined && (!Number.isInteger(perDay) || perDay < 1 || perDay > 50)) {
    throw validation("perProfessionalPerDay debe estar entre 1 y 50")
  }
  if (input.professionalUserId) await requireProfessional(tx, orgId, input.professionalUserId)
  // Solo quien atiende el servicio, si alguien lo atiende en esta sede.
  const attending = input.serviceId ? await attendingRule(tx, orgId, { serviceId: input.serviceId, branchId: input.branchId }) : null
  if (attending && input.professionalUserId && !attending.professionalUserIds.includes(input.professionalUserId)) {
    return { slots: [], truncated: false, timeZone, attending }
  }
  const roomFilter = input.roomId
    ? await requireRoomInBranch(tx, orgId, input.roomId, input.branchId)
    : null

  const scheduleConditions = [
    eq(professionalSchedule.organizationId, orgId),
    eq(professionalSchedule.branchId, input.branchId),
    eq(professionalSchedule.isActive, true),
  ]
  if (input.professionalUserId) {
    scheduleConditions.push(eq(professionalSchedule.professionalUserId, input.professionalUserId))
  } else if (attending) {
    scheduleConditions.push(inArray(professionalSchedule.professionalUserId, attending.professionalUserIds))
  }
  const rules = await tx
    .select({ rule: professionalSchedule, professionalName: user.name })
    .from(professionalSchedule)
    .innerJoin(user, eq(user.id, professionalSchedule.professionalUserId))
    .where(and(...scheduleConditions))
    .orderBy(
      asc(professionalSchedule.professionalUserId),
      asc(professionalSchedule.weekday),
      asc(professionalSchedule.startMin),
    )
  if (rules.length === 0) return { slots: [], truncated: false, timeZone, attending }
  const notBefore = input.notBefore ? parseInstant(input.notBefore, "notBefore") : null
  const professionalsWithRules = new Set(rules.map((entry) => entry.rule.professionalUserId))
  const found = new Set<string>()

  const rooms = await tx
    .select({ id: scheduleRoom.id, name: scheduleRoom.name })
    .from(scheduleRoom)
    .where(
      and(
        eq(scheduleRoom.organizationId, orgId),
        eq(scheduleRoom.branchId, input.branchId),
        eq(scheduleRoom.isActive, true),
      ),
    )
    .orderBy(asc(scheduleRoom.name))

  const [busyAppointments, blocks] = await Promise.all([
    tx
      .select({
        id: appointment.id,
        professionalUserId: appointment.professionalUserId,
        roomId: appointment.roomId,
        startsAt: appointment.startsAt,
        endsAt: appointment.endsAt,
      })
      .from(appointment)
      .where(
        // De toda la organización: quien atiende en dos sedes no está libre en esta
        // mientras tiene una cita en la otra.
        and(
          eq(appointment.organizationId, orgId),
          inArray(appointment.status, ["programada", "confirmada"]),
          lt(appointment.startsAt, to),
          gte(appointment.endsAt, from),
          input.forTest ? undefined : eq(appointment.isTest, false),
        ),
      ),
    tx
      .select()
      .from(scheduleBlock)
      .where(
        and(
          eq(scheduleBlock.organizationId, orgId),
          eq(scheduleBlock.branchId, input.branchId),
          lt(scheduleBlock.startsAt, to),
          gte(scheduleBlock.endsAt, from),
        ),
      ),
  ])

  const slots: AvailableSlot[] = []

  // Itera días locales de la sede dentro del rango pedido.
  const startParts = zonedPartsOf(from, resolved.timeZone)
  let dayLabel = toISODate(startParts.year, startParts.month, startParts.day)
  for (let dayIndex = 0; dayIndex < MAX_RANGE_DAYS + 1; dayIndex++) {
    const dayStart = zonedDayStartUtc(dayLabel, resolved.timeZone)
    const dayEnd = new Date(dayStart.getTime() + 86_400_000)
    if (dayStart >= to) break
    const weekday = new Date(
      Date.UTC(Number(dayLabel.slice(0, 4)), Number(dayLabel.slice(5, 7)) - 1, Number(dayLabel.slice(8, 10))),
    ).getUTCDay()
    // Lo de cada día se junta y se ordena por hora antes de cortar.
    const daySlots: AvailableSlot[] = []
    for (const entry of rules) {
      if (entry.rule.weekday !== weekday) continue
      if (input.firstPerProfessional && found.has(entry.rule.professionalUserId)) continue
      for (let minute = entry.rule.startMin; minute + slotMin <= entry.rule.endMin; minute += step) {
        const startUtc = zonedTimeToUtc(dayLabel, minute, resolved.timeZone)
        const endUtc = new Date(startUtc.getTime() + slotMin * 60000)
        if (endUtc <= from || startUtc >= to) continue
        if (notBefore && startUtc < notBefore) continue
        const professionalBusy = busyAppointments.some(
          (item) =>
            item.professionalUserId === entry.rule.professionalUserId &&
            item.startsAt < endUtc &&
            item.endsAt > startUtc,
        )
        if (professionalBusy) continue
        // Cierra el hueco si un bloqueo alcanza al profesional sin importar la unidad dental.
        const professionalBlocked = blocks.some(
          (block) =>
            (block.professionalUserId === null || block.professionalUserId === entry.rule.professionalUserId) &&
            block.roomId === null &&
            block.startsAt < endUtc &&
            block.endsAt > startUtc,
        )
        if (professionalBlocked) continue
        const roomFree = (roomId: string): boolean => {
          const busy = busyAppointments.some(
            (item) => item.roomId === roomId && item.startsAt < endUtc && item.endsAt > startUtc,
          )
          if (busy) return false
          return !blocks.some(
            (block) =>
              (block.roomId === null || block.roomId === roomId) &&
              (block.professionalUserId === null || block.professionalUserId === entry.rule.professionalUserId) &&
              block.startsAt < endUtc &&
              block.endsAt > startUtc,
          )
        }
        let roomId: string | null = null
        let roomName: string | null = null
        if (roomFilter) {
          if (!roomFree(roomFilter.id)) continue
          roomId = roomFilter.id
          roomName = roomFilter.name
        } else {
          const free = rooms.find((room) => roomFree(room.id))
          if (!free) continue
          roomId = free.id
          roomName = free.name
        }
        daySlots.push({
          startsAt: startUtc.toISOString(),
          endsAt: endUtc.toISOString(),
          professionalUserId: entry.rule.professionalUserId,
          professionalName: entry.professionalName,
          roomId,
          roomName,
          timeZone,
        })
        if (input.firstPerProfessional) {
          found.add(entry.rule.professionalUserId)
          break
        }
      }
    }
    // Por hora, mezclando a los profesionales; a la misma hora, por nombre.
    daySlots.sort(
      (a, b) =>
        a.startsAt.localeCompare(b.startsAt) ||
        a.professionalName.localeCompare(b.professionalName, "es") ||
        a.professionalUserId.localeCompare(b.professionalUserId),
    )
    for (const slot of perDay === undefined ? daySlots : spreadOverDay(daySlots, perDay)) {
      if (slots.length >= MAX_SLOTS) return { slots, truncated: true, timeZone, attending }
      slots.push(slot)
    }
    if (input.firstPerProfessional && found.size === professionalsWithRules.size) {
      return { slots, truncated: false, timeZone, attending }
    }
    if (dayEnd >= to) break
    const next = new Date(dayStart.getTime() + 86_400_000)
    const nextParts = zonedPartsOf(next, resolved.timeZone)
    const nextLabel = toISODate(nextParts.year, nextParts.month, nextParts.day)
    if (nextLabel <= dayLabel) break
    dayLabel = nextLabel
  }
  return { slots, truncated: false, timeZone, attending }
}

/* Disponibilidad a la vista de la agenda */

const NEXT_FREE_DAYS = 14

/** Un tramo en milisegundos: `[inicio, fin)`. Reportes › Agenda usa las mismas cuentas. */
type Span = [start: number, end: number]

/** Une tramos solapados o contiguos. */
export function mergeSpans(spans: Span[]): Span[] {
  const sorted = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
  const out: Span[] = []
  for (const [a, b] of sorted) {
    const last = out[out.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

/** Lo que queda de `base` al quitarle `cuts`. */
export function subtractSpans(base: Span[], cuts: Span[]): Span[] {
  let rest = mergeSpans(base)
  for (const [from, to] of mergeSpans(cuts)) {
    rest = rest.flatMap(([a, b]): Span[] => {
      if (to <= a || from >= b) return [[a, b]]
      const parts: Span[] = []
      if (from > a) parts.push([a, from])
      if (to < b) parts.push([to, b])
      return parts
    })
  }
  return rest
}

/** Lo común a dos listas de tramos. */
export function intersectSpans(first: Span[], second: Span[]): Span[] {
  const out: Span[] = []
  for (const [a, b] of mergeSpans(first)) {
    for (const [c, d] of mergeSpans(second)) {
      const start = Math.max(a, c)
      const end = Math.min(b, d)
      if (end > start) out.push([start, end])
    }
  }
  return out
}

export interface AgendaAvailability {
  branchId: string
  timeZone: string
  /** Minutos de una cita regular en la sede (sin servicio). */
  defaultDurationMin: number
  /**
   * Tramos en que cada profesional puede recibir una cita: su horario menos
   * ausencias, citas en pie (en cualquier sede) y lo ya pasado, y solo mientras
   * queda alguna unidad dental libre.
   */
  free: Array<{ professionalUserId: string; startsAt: string; endsAt: string }>
  /** Quienes atienden en la sede (tienen horario), con su próximo hueco reservable. */
  professionals: Array<{
    id: string
    label: string
    nextFree: { startsAt: string; endsAt: string; roomId: string | null } | null
  }>
  /** Tramos de atención del rango, ya como instantes. */
  open: Array<{ professionalUserId: string; startsAt: string; endsAt: string }>
  blocks: ScheduleBlockItem[]
  /**
   * Con servicio: si alguien lo atiende en la sede, la agenda ofrece solo a
   * esas personas y aquí dice su especialidad (la regla de `listAvailableSlots`).
   */
  attending: AttendingRule | null
}

/**
 * Lo que la agenda necesita para pintar qué se puede reservar: horario de cada
 * profesional materializado en el rango, bloqueos y el primer hueco libre de
 * cada uno desde `now`. Sale de las mismas reglas que valida la reserva.
 */
export async function getAgendaAvailability(
  tx: Db,
  orgId: string,
  input: {
    branchId: string
    from: string
    to: string
    now?: Date
    /** Al reprogramar: el hueco de esa cita cuenta como libre en los tramos (`free`). */
    ignoreAppointmentId?: string
    /** «Nueva cita» con servicio: solo quien lo atiende (ADR 0039). */
    serviceId?: string
  },
): Promise<AgendaAvailability> {
  const resolved = await requireBranch(tx, orgId, input.branchId)
  const from = parseInstant(input.from, "from")
  const to = parseInstant(input.to, "to")
  if (to <= from) throw validation("El rango de agenda es inválido")
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000) {
    throw validation(`El rango máximo es de ${MAX_RANGE_DAYS} días`)
  }
  const now = input.now ?? new Date()
  const attending = input.serviceId
    ? await attendingRule(tx, orgId, { serviceId: input.serviceId, branchId: input.branchId })
    : null
  const rules = await tx
    .select({ rule: professionalSchedule, professionalName: user.name })
    .from(professionalSchedule)
    .innerJoin(user, eq(user.id, professionalSchedule.professionalUserId))
    .where(
      and(
        eq(professionalSchedule.organizationId, orgId),
        eq(professionalSchedule.branchId, input.branchId),
        eq(professionalSchedule.isActive, true),
        attending ? inArray(professionalSchedule.professionalUserId, attending.professionalUserIds) : undefined,
      ),
    )
    .orderBy(asc(user.name), asc(professionalSchedule.weekday), asc(professionalSchedule.startMin))

  const open: AgendaAvailability["open"] = []
  const startParts = zonedPartsOf(from, resolved.timeZone)
  let dayLabel = toISODate(startParts.year, startParts.month, startParts.day)
  for (let dayIndex = 0; dayIndex < MAX_RANGE_DAYS + 1; dayIndex++) {
    const dayStart = zonedDayStartUtc(dayLabel, resolved.timeZone)
    if (dayStart >= to) break
    const weekday = new Date(`${dayLabel}T12:00:00Z`).getUTCDay()
    for (const entry of rules) {
      if (entry.rule.weekday !== weekday) continue
      open.push({
        professionalUserId: entry.rule.professionalUserId,
        startsAt: zonedTimeToUtc(dayLabel, entry.rule.startMin, resolved.timeZone).toISOString(),
        endsAt: zonedTimeToUtc(dayLabel, entry.rule.endMin, resolved.timeZone).toISOString(),
      })
    }
    // 26 h después del inicio cae siempre en el día local siguiente, también con cambio de hora.
    const nextParts = zonedPartsOf(new Date(dayStart.getTime() + 93_600_000), resolved.timeZone)
    const nextLabel = toISODate(nextParts.year, nextParts.month, nextParts.day)
    if (nextLabel <= dayLabel) break
    dayLabel = nextLabel
  }

  const [blocks, next] = await Promise.all([
    listScheduleBlocks(tx, orgId, { branchId: input.branchId, from: input.from, to: input.to }),
    listAvailableSlots(tx, orgId, {
      branchId: input.branchId,
      from: now.toISOString(),
      to: new Date(now.getTime() + NEXT_FREE_DAYS * 86_400_000).toISOString(),
      notBefore: now.toISOString(),
      // Recepción ve el primer cuarto de hora libre, no la hora que se ofrece a la persona.
      stepMin: 15,
      firstPerProfessional: true,
      ...(input.serviceId ? { serviceId: input.serviceId } : {}),
    }),
  ])
  const nextByProfessional = new Map(next.slots.map((slot) => [slot.professionalUserId, slot]))
  const professionals = new Map<string, AgendaAvailability["professionals"][number]>()
  for (const entry of rules) {
    if (professionals.has(entry.rule.professionalUserId)) continue
    const slot = nextByProfessional.get(entry.rule.professionalUserId)
    professionals.set(entry.rule.professionalUserId, {
      id: entry.rule.professionalUserId,
      label: entry.professionalName,
      nextFree: slot ? { startsAt: slot.startsAt, endsAt: slot.endsAt, roomId: slot.roomId } : null,
    })
  }
  // Tramos reservables por profesional, con las mismas reglas que valida la reserva.
  const [busy, roomRows] = await Promise.all([
    tx
      .select({
        professionalUserId: appointment.professionalUserId,
        roomId: appointment.roomId,
        startsAt: appointment.startsAt,
        endsAt: appointment.endsAt,
      })
      .from(appointment)
      .where(
        and(
          eq(appointment.organizationId, orgId),
          inArray(appointment.status, ["programada", "confirmada"]),
          lt(appointment.startsAt, to),
          gt(appointment.endsAt, from),
          input.ignoreAppointmentId ? ne(appointment.id, input.ignoreAppointmentId) : undefined,
          // La Agenda muestra libre lo que una prueba tiene: no ocupa el horario (ADR 0094).
          eq(appointment.isTest, false),
        ),
      ),
    tx
      .select({ id: scheduleRoom.id })
      .from(scheduleRoom)
      .where(
        and(
          eq(scheduleRoom.organizationId, orgId),
          eq(scheduleRoom.branchId, input.branchId),
          eq(scheduleRoom.isActive, true),
        ),
      ),
  ])
  const whole: Span[] = [[from.getTime(), to.getTime()]]
  const spanOf = (item: { startsAt: Date | string; endsAt: Date | string }): Span => [
    new Date(item.startsAt).getTime(),
    new Date(item.endsAt).getTime(),
  ]
  const free: AgendaAvailability["free"] = []
  for (const professional of professionals.values()) {
    const mine = (professionalUserId: string | null) =>
      professionalUserId === null || professionalUserId === professional.id
    const hours = open.filter((item) => item.professionalUserId === professional.id).map(spanOf)
    const taken: Span[] = [
      ...blocks.filter((block) => block.roomId === null && mine(block.professionalUserId)).map(spanOf),
      ...busy.filter((item) => item.professionalUserId === professional.id).map(spanOf),
      [0, now.getTime()],
    ]
    const roomFree = roomRows.flatMap((room) =>
      subtractSpans(whole, [
        ...busy.filter((item) => item.roomId === room.id).map(spanOf),
        ...blocks
          .filter((block) => block.roomId === room.id && mine(block.professionalUserId))
          .map(spanOf),
      ]),
    )
    for (const [start, end] of intersectSpans(subtractSpans(hours, taken), roomFree)) {
      free.push({
        professionalUserId: professional.id,
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(end).toISOString(),
      })
    }
  }
  return {
    branchId: input.branchId,
    timeZone: resolved.timeZone,
    defaultDurationMin: resolved.defaultMinutes,
    professionals: [...professionals.values()],
    open,
    blocks,
    free,
    attending,
  }
}

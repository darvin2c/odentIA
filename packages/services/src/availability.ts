/**
 * Disponibilidad de agenda: horarios por profesional/sede, bloqueos y
 * ausencias, consulta de huecos con zona IANA y lista de espera.
 * Comparte las invariantes con reserva/movimiento (appointments.ts valida
 * contra estas mismas reglas) para que agentes y portal no calculen
 * huecos por su cuenta. Toda función recibe `tx: Db` ya contextualizado.
 */
import type { Db } from "@odentia/db"
import { appointment, scheduleChair } from "@odentia/db/schema/agenda"
import {
  SCHEDULE_BLOCK_KINDS,
  WAITLIST_PRIORITIES,
  WAITLIST_STATUSES,
  professionalSchedule,
  scheduleBlock,
  waitlistEntry,
  type ScheduleBlockKind,
  type WaitlistPriority,
  type WaitlistStatus,
} from "@odentia/db/schema/availability"
import { member, user } from "@odentia/db/schema/auth"
import { patient, serviceCatalog } from "@odentia/db/schema/clinical"
import { contact, orgFk, timestamps } from "@odentia/db/schema/crm"
import { branch, orgProfile } from "@odentia/db/schema/org"
import { and, asc, eq, gt, gte, inArray, isNull, lt, ne, or } from "drizzle-orm"
import { notFound, ServiceError, validation } from "./errors.js"
import { createWorkspaceNotification } from "./workspace.js"

const FALLBACK_TZ = "America/Lima"
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
    new Intl.DateTimeFormat("es-PE", { timeZone: candidate })
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
  if (branchZone) return assertTimeZone(branchZone, "La zona horaria de la sucursal")
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

function zonedPartsOf(instant: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(instant)
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
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(instant)
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
  if (!row) throw notFound("Sucursal")
  return { ...row, timeZone: branchTimeZone(row.timezone, row.orgTimezone) }
}

async function requireDentist(tx: Db, orgId: string, dentistUserId: string) {
  const [membership] = await tx
    .select({ id: member.id, name: user.name })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(member.organizationId, orgId), eq(member.userId, dentistUserId)))
    .limit(1)
  if (!membership) throw notFound("Profesional")
  return membership
}

async function requireChairInBranch(tx: Db, orgId: string, chairId: string, branchId: string) {
  const [row] = await tx
    .select({ id: scheduleChair.id, name: scheduleChair.name })
    .from(scheduleChair)
    .where(
      and(
        eq(scheduleChair.organizationId, orgId),
        eq(scheduleChair.id, chairId),
        eq(scheduleChair.branchId, branchId),
        eq(scheduleChair.isActive, true),
      ),
    )
    .limit(1)
  if (!row) throw notFound("Sillón")
  return row
}

function assertBlockKind(kind: string): ScheduleBlockKind {
  if (!(SCHEDULE_BLOCK_KINDS as readonly string[]).includes(kind)) {
    throw validation(`Tipo de bloqueo inválido: ${kind}`)
  }
  return kind as ScheduleBlockKind
}

function assertPriority(priority: string): WaitlistPriority {
  if (!(WAITLIST_PRIORITIES as readonly string[]).includes(priority)) {
    throw validation(`Prioridad inválida: ${priority}`)
  }
  return priority as WaitlistPriority
}

function assertWaitlistStatus(status: string): WaitlistStatus {
  if (!(WAITLIST_STATUSES as readonly string[]).includes(status)) {
    throw validation(`Estado de espera inválido: ${status}`)
  }
  return status as WaitlistStatus
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
  dentistUserId: string
  timeZone: string
  rules: ScheduleRule[]
}

/** Horario activo de un profesional en una sede (vacío = sin configurar). */
export async function getProfessionalSchedule(
  tx: Db,
  orgId: string,
  branchId: string,
  dentistUserId: string,
): Promise<ProfessionalScheduleView> {
  const resolved = await requireBranch(tx, orgId, branchId)
  await requireDentist(tx, orgId, dentistUserId)
  const rows = await tx
    .select()
    .from(professionalSchedule)
    .where(
      and(
        eq(professionalSchedule.organizationId, orgId),
        eq(professionalSchedule.branchId, branchId),
        eq(professionalSchedule.dentistUserId, dentistUserId),
        eq(professionalSchedule.isActive, true),
      ),
    )
    .orderBy(asc(professionalSchedule.weekday), asc(professionalSchedule.startMin))
  return {
    branchId,
    dentistUserId,
    timeZone: resolved.timeZone,
    rules: rows.map((row) => ({
      id: row.id,
      weekday: row.weekday,
      startMin: row.startMin,
      endMin: row.endMin,
      isActive: row.isActive,
    })),
  }
}

/**
 * Reemplaza el horario semanal del profesional en la sede. Reglas vacías =
 * sin atención (pero explícito: `cleared: true` lo distingue de "sin configurar").
 */
export async function setProfessionalSchedule(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: { branchId: string; dentistUserId: string; rules: ScheduleRuleInput[] },
): Promise<ProfessionalScheduleView> {
  await requireBranch(tx, orgId, input.branchId)
  await requireDentist(tx, orgId, input.dentistUserId)
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
  await tx
    .delete(professionalSchedule)
    .where(
      and(
        eq(professionalSchedule.organizationId, orgId),
        eq(professionalSchedule.branchId, input.branchId),
        eq(professionalSchedule.dentistUserId, input.dentistUserId),
      ),
    )
  if (input.rules.length > 0) {
    await tx.insert(professionalSchedule).values(
      input.rules.map((rule) => ({
        organizationId: orgId,
        branchId: input.branchId,
        dentistUserId: input.dentistUserId,
        weekday: rule.weekday,
        startMin: rule.startMin,
        endMin: rule.endMin,
        isActive: true,
        createdBy: actorUserId,
      })),
    )
  }
  return getProfessionalSchedule(tx, orgId, input.branchId, input.dentistUserId)
}

/* Bloqueos y ausencias */

export interface ScheduleBlockItem {
  id: string
  branchId: string
  dentistUserId: string | null
  dentistName: string | null
  chairId: string | null
  kind: ScheduleBlockKind
  reason: string | null
  startsAt: string
  endsAt: string
}

export interface CreateBlockInput {
  branchId: string
  dentistUserId?: string | null
  chairId?: string | null
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
    .select({ block: scheduleBlock, dentistName: user.name })
    .from(scheduleBlock)
    .leftJoin(user, eq(user.id, scheduleBlock.dentistUserId))
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
    dentistUserId: row.block.dentistUserId,
    dentistName: row.dentistName,
    chairId: row.block.chairId,
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
  if (input.dentistUserId) await requireDentist(tx, orgId, input.dentistUserId)
  if (input.chairId) await requireChairInBranch(tx, orgId, input.chairId, input.branchId)
  // Sin profesional ni sillón, el bloqueo cierra la sede completa.
  const kind = assertBlockKind(input.kind ?? "bloqueo")
  const [created] = await tx
    .insert(scheduleBlock)
    .values({
      organizationId: orgId,
      branchId: input.branchId,
      dentistUserId: input.dentistUserId ?? null,
      chairId: input.chairId ?? null,
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
  dentistUserId: string
  chairId: string
  startsAt: Date
  endsAt: Date
  ignoreAppointmentId?: string
  /** Urgencia: se reserva aunque el horario del profesional no cubra ese momento. */
  allowOutsideSchedule?: boolean
}

async function overlappingBlocks(
  tx: Db,
  orgId: string,
  check: AvailabilityCheck,
): Promise<typeof scheduleBlock.$inferSelect | undefined> {
  const dentistScope = or(
    isNull(scheduleBlock.dentistUserId),
    eq(scheduleBlock.dentistUserId, check.dentistUserId),
  )
  const chairScope = or(isNull(scheduleBlock.chairId), eq(scheduleBlock.chairId, check.chairId))
  if (!dentistScope || !chairScope) return undefined
  const [row] = await tx
    .select()
    .from(scheduleBlock)
    .where(
      and(
        eq(scheduleBlock.organizationId, orgId),
        eq(scheduleBlock.branchId, check.branchId),
        dentistScope,
        chairScope,
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
      eq(appointment.dentistUserId, check.dentistUserId),
      eq(appointment.chairId, check.chairId),
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
    .where(and(...conditions))
    .limit(1)
  if (row && check.ignoreAppointmentId && row.id === check.ignoreAppointmentId) return undefined
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
  await requireDentist(tx, orgId, check.dentistUserId)
  await requireChairInBranch(tx, orgId, check.chairId, check.branchId)
  const rules = await tx
    .select()
    .from(professionalSchedule)
    .where(
      and(
        eq(professionalSchedule.organizationId, orgId),
        eq(professionalSchedule.branchId, check.branchId),
        eq(professionalSchedule.dentistUserId, check.dentistUserId),
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
      "El profesional o el sillón ya están ocupados en ese horario",
    )
  }
}

/* Huecos libres */

export interface SlotsQuery {
  branchId: string
  dentistUserId?: string
  chairId?: string
  serviceId?: string
  from: string
  to: string
  durationMin?: number
  timeZone?: string
  stepMin?: number
  /** Descarta los huecos que empiezan antes de este instante (lo ya pasado no se ofrece). */
  notBefore?: string
  /** Solo el primer hueco de cada profesional: responde «quién puede atender primero». */
  firstPerDentist?: boolean
}

export interface AvailableSlot {
  startsAt: string
  endsAt: string
  dentistUserId: string
  dentistName: string
  chairId: string | null
  chairName: string | null
  timeZone: string
}

export interface AvailableSlotsResult {
  slots: AvailableSlot[]
  /** true si se alcanzó el tope de 200: hay más huecos fuera de la respuesta. */
  truncated: boolean
  timeZone: string
}

/**
 * Huecos reservables en la zona IANA de la sucursal (o la pedida si es
 * válida). Solo profesionales con horario explícito; descuenta citas
 * ocupantes, bloqueos y ausencias. Máximo 200 huecos y 62 días por consulta:
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
  const step = input.stepMin ?? 15
  if (!Number.isInteger(step) || step < 5 || step > 120) {
    throw validation("El paso debe estar entre 5 y 120 minutos")
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
  if (input.dentistUserId) await requireDentist(tx, orgId, input.dentistUserId)
  const chairFilter = input.chairId
    ? await requireChairInBranch(tx, orgId, input.chairId, input.branchId)
    : null

  const scheduleConditions = [
    eq(professionalSchedule.organizationId, orgId),
    eq(professionalSchedule.branchId, input.branchId),
    eq(professionalSchedule.isActive, true),
  ]
  if (input.dentistUserId) {
    scheduleConditions.push(eq(professionalSchedule.dentistUserId, input.dentistUserId))
  }
  const rules = await tx
    .select({ rule: professionalSchedule, dentistName: user.name })
    .from(professionalSchedule)
    .innerJoin(user, eq(user.id, professionalSchedule.dentistUserId))
    .where(and(...scheduleConditions))
    .orderBy(
      asc(professionalSchedule.dentistUserId),
      asc(professionalSchedule.weekday),
      asc(professionalSchedule.startMin),
    )
  if (rules.length === 0) return { slots: [], truncated: false, timeZone }
  const notBefore = input.notBefore ? parseInstant(input.notBefore, "notBefore") : null
  const dentistsWithRules = new Set(rules.map((entry) => entry.rule.dentistUserId))
  const found = new Set<string>()

  const chairs = await tx
    .select({ id: scheduleChair.id, name: scheduleChair.name })
    .from(scheduleChair)
    .where(
      and(
        eq(scheduleChair.organizationId, orgId),
        eq(scheduleChair.branchId, input.branchId),
        eq(scheduleChair.isActive, true),
      ),
    )
    .orderBy(asc(scheduleChair.name))

  const [busyAppointments, blocks] = await Promise.all([
    tx
      .select({
        id: appointment.id,
        dentistUserId: appointment.dentistUserId,
        chairId: appointment.chairId,
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

  // Itera días locales de la sucursal dentro del rango pedido.
  const startParts = zonedPartsOf(from, resolved.timeZone)
  let dayLabel = toISODate(startParts.year, startParts.month, startParts.day)
  for (let dayIndex = 0; dayIndex < MAX_RANGE_DAYS + 1; dayIndex++) {
    const dayStart = zonedDayStartUtc(dayLabel, resolved.timeZone)
    const dayEnd = new Date(dayStart.getTime() + 86_400_000)
    if (dayStart >= to) break
    const weekday = new Date(
      Date.UTC(Number(dayLabel.slice(0, 4)), Number(dayLabel.slice(5, 7)) - 1, Number(dayLabel.slice(8, 10))),
    ).getUTCDay()
    for (const entry of rules) {
      if (entry.rule.weekday !== weekday) continue
      if (input.firstPerDentist && found.has(entry.rule.dentistUserId)) continue
      for (let minute = entry.rule.startMin; minute + slotMin <= entry.rule.endMin; minute += step) {
        const startUtc = zonedTimeToUtc(dayLabel, minute, resolved.timeZone)
        const endUtc = new Date(startUtc.getTime() + slotMin * 60000)
        if (endUtc <= from || startUtc >= to) continue
        if (notBefore && startUtc < notBefore) continue
        const dentistBusy = busyAppointments.some(
          (item) =>
            item.dentistUserId === entry.rule.dentistUserId &&
            item.startsAt < endUtc &&
            item.endsAt > startUtc,
        )
        if (dentistBusy) continue
        // Cierra el hueco si un bloqueo alcanza al profesional sin importar el sillón.
        const dentistBlocked = blocks.some(
          (block) =>
            (block.dentistUserId === null || block.dentistUserId === entry.rule.dentistUserId) &&
            block.chairId === null &&
            block.startsAt < endUtc &&
            block.endsAt > startUtc,
        )
        if (dentistBlocked) continue
        const chairFree = (chairId: string): boolean => {
          const busy = busyAppointments.some(
            (item) => item.chairId === chairId && item.startsAt < endUtc && item.endsAt > startUtc,
          )
          if (busy) return false
          return !blocks.some(
            (block) =>
              (block.chairId === null || block.chairId === chairId) &&
              (block.dentistUserId === null || block.dentistUserId === entry.rule.dentistUserId) &&
              block.startsAt < endUtc &&
              block.endsAt > startUtc,
          )
        }
        let chairId: string | null = null
        let chairName: string | null = null
        if (chairFilter) {
          if (!chairFree(chairFilter.id)) continue
          chairId = chairFilter.id
          chairName = chairFilter.name
        } else {
          const free = chairs.find((chair) => chairFree(chair.id))
          if (!free) continue
          chairId = free.id
          chairName = free.name
        }
        slots.push({
          startsAt: startUtc.toISOString(),
          endsAt: endUtc.toISOString(),
          dentistUserId: entry.rule.dentistUserId,
          dentistName: entry.dentistName,
          chairId,
          chairName,
          timeZone,
        })
        if (slots.length >= MAX_SLOTS) return { slots, truncated: true, timeZone }
        if (input.firstPerDentist) {
          found.add(entry.rule.dentistUserId)
          break
        }
      }
      if (input.firstPerDentist && found.size === dentistsWithRules.size) {
        return { slots, truncated: false, timeZone }
      }
    }
    if (dayEnd >= to) break
    const next = new Date(dayStart.getTime() + 86_400_000)
    const nextParts = zonedPartsOf(next, resolved.timeZone)
    const nextLabel = toISODate(nextParts.year, nextParts.month, nextParts.day)
    if (nextLabel <= dayLabel) break
    dayLabel = nextLabel
  }
  return { slots, truncated: false, timeZone }
}

/* Disponibilidad a la vista de la agenda */

const NEXT_FREE_DAYS = 14

type Span = [start: number, end: number]

/** Une tramos solapados o contiguos. */
function mergeSpans(spans: Span[]): Span[] {
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
function subtractSpans(base: Span[], cuts: Span[]): Span[] {
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
function intersectSpans(first: Span[], second: Span[]): Span[] {
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
   * queda algún sillón libre.
   */
  free: Array<{ dentistUserId: string; startsAt: string; endsAt: string }>
  /** Quienes atienden en la sede (tienen horario), con su próximo hueco reservable. */
  professionals: Array<{
    id: string
    label: string
    nextFree: { startsAt: string; endsAt: string; chairId: string | null } | null
  }>
  /** Tramos de atención del rango, ya como instantes. */
  open: Array<{ dentistUserId: string; startsAt: string; endsAt: string }>
  blocks: ScheduleBlockItem[]
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
  const rules = await tx
    .select({ rule: professionalSchedule, dentistName: user.name })
    .from(professionalSchedule)
    .innerJoin(user, eq(user.id, professionalSchedule.dentistUserId))
    .where(
      and(
        eq(professionalSchedule.organizationId, orgId),
        eq(professionalSchedule.branchId, input.branchId),
        eq(professionalSchedule.isActive, true),
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
        dentistUserId: entry.rule.dentistUserId,
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
      firstPerDentist: true,
    }),
  ])
  const nextByDentist = new Map(next.slots.map((slot) => [slot.dentistUserId, slot]))
  const professionals = new Map<string, AgendaAvailability["professionals"][number]>()
  for (const entry of rules) {
    if (professionals.has(entry.rule.dentistUserId)) continue
    const slot = nextByDentist.get(entry.rule.dentistUserId)
    professionals.set(entry.rule.dentistUserId, {
      id: entry.rule.dentistUserId,
      label: entry.dentistName,
      nextFree: slot ? { startsAt: slot.startsAt, endsAt: slot.endsAt, chairId: slot.chairId } : null,
    })
  }
  // Tramos reservables por profesional, con las mismas reglas que valida la reserva.
  const [busy, chairRows] = await Promise.all([
    tx
      .select({
        dentistUserId: appointment.dentistUserId,
        chairId: appointment.chairId,
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
        ),
      ),
    tx
      .select({ id: scheduleChair.id })
      .from(scheduleChair)
      .where(
        and(
          eq(scheduleChair.organizationId, orgId),
          eq(scheduleChair.branchId, input.branchId),
          eq(scheduleChair.isActive, true),
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
    const mine = (dentistUserId: string | null) =>
      dentistUserId === null || dentistUserId === professional.id
    const hours = open.filter((item) => item.dentistUserId === professional.id).map(spanOf)
    const taken: Span[] = [
      ...blocks.filter((block) => block.chairId === null && mine(block.dentistUserId)).map(spanOf),
      ...busy.filter((item) => item.dentistUserId === professional.id).map(spanOf),
      [0, now.getTime()],
    ]
    const chairFree = chairRows.flatMap((chair) =>
      subtractSpans(whole, [
        ...busy.filter((item) => item.chairId === chair.id).map(spanOf),
        ...blocks
          .filter((block) => block.chairId === chair.id && mine(block.dentistUserId))
          .map(spanOf),
      ]),
    )
    for (const [start, end] of intersectSpans(subtractSpans(hours, taken), chairFree)) {
      free.push({
        dentistUserId: professional.id,
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
  }
}

/* Lista de espera */

export interface WaitlistItem {
  id: string
  branchId: string
  patientId: string | null
  patientName: string | null
  contactId: string | null
  contactName: string | null
  dentistUserId: string | null
  dentistName: string | null
  serviceId: string | null
  serviceName: string | null
  priority: WaitlistPriority
  status: WaitlistStatus
  notes: string | null
  offeredStartsAt: string | null
  offeredEndsAt: string | null
  offeredChairId: string | null
  createdAt: string
}

export interface AddWaitlistInput {
  branchId: string
  patientId?: string
  contactId?: string
  dentistUserId?: string | null
  serviceId?: string | null
  priority?: string
  notes?: string
}

const PRIORITY_RANK: Record<WaitlistPriority, number> = { alta: 0, normal: 1, baja: 2 }

function toWaitlistItem(row: {
  entry: typeof waitlistEntry.$inferSelect
  patientName: string | null
  contactName: string | null
  dentistName: string | null
}): WaitlistItem {
  return {
    id: row.entry.id,
    branchId: row.entry.branchId,
    patientId: row.entry.patientId,
    patientName: row.patientName,
    contactId: row.entry.contactId,
    contactName: row.contactName,
    dentistUserId: row.entry.dentistUserId,
    dentistName: row.dentistName,
    serviceId: row.entry.serviceId,
    serviceName: row.entry.serviceName,
    priority: assertPriority(row.entry.priority),
    status: assertWaitlistStatus(row.entry.status),
    notes: row.entry.notes,
    offeredStartsAt: row.entry.offeredStartsAt?.toISOString() ?? null,
    offeredEndsAt: row.entry.offeredEndsAt?.toISOString() ?? null,
    offeredChairId: row.entry.offeredChairId,
    createdAt: row.entry.createdAt.toISOString(),
  }
}

export async function listWaitlistEntries(
  tx: Db,
  orgId: string,
  input: { branchId?: string; status?: string },
): Promise<WaitlistItem[]> {
  const conditions = [eq(waitlistEntry.organizationId, orgId)]
  if (input.branchId) {
    await requireBranch(tx, orgId, input.branchId)
    conditions.push(eq(waitlistEntry.branchId, input.branchId))
  }
  if (input.status) {
    const statuses = input.status
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
    for (const status of statuses) assertWaitlistStatus(status)
    if (statuses.length > 0) conditions.push(inArray(waitlistEntry.status, statuses))
  }
  const rows = await tx
    .select({
      entry: waitlistEntry,
      patientName: patient.displayName,
      contactName: contact.displayName,
      dentistName: user.name,
    })
    .from(waitlistEntry)
    .leftJoin(
      patient,
      and(eq(patient.organizationId, orgId), eq(patient.id, waitlistEntry.patientId)),
    )
    .leftJoin(
      contact,
      and(eq(contact.organizationId, orgId), eq(contact.id, waitlistEntry.contactId)),
    )
    .leftJoin(user, eq(user.id, waitlistEntry.dentistUserId))
    .where(and(...conditions))
    .orderBy(asc(waitlistEntry.createdAt))
  return rows
    .map(toWaitlistItem)
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority])
}

export async function addWaitlistEntry(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: AddWaitlistInput,
): Promise<WaitlistItem> {
  await requireBranch(tx, orgId, input.branchId)
  if (!input.patientId && !input.contactId) {
    throw validation("La espera necesita un paciente o un contacto")
  }
  if (input.patientId) {
    const [row] = await tx
      .select({ id: patient.id })
      .from(patient)
      .where(and(eq(patient.organizationId, orgId), eq(patient.id, input.patientId)))
      .limit(1)
    if (!row) throw notFound("Paciente")
  }
  if (input.contactId) {
    const [row] = await tx
      .select({ id: contact.id })
      .from(contact)
      .where(and(eq(contact.organizationId, orgId), eq(contact.id, input.contactId)))
      .limit(1)
    if (!row) throw notFound("Contacto")
  }
  if (input.dentistUserId) await requireDentist(tx, orgId, input.dentistUserId)
  let service: { id: string; name: string } | null = null
  if (input.serviceId) {
    const [row] = await tx
      .select({ id: serviceCatalog.id, name: serviceCatalog.name })
      .from(serviceCatalog)
      .where(
        and(
          eq(serviceCatalog.organizationId, orgId),
          eq(serviceCatalog.id, input.serviceId),
          eq(serviceCatalog.isActive, true),
        ),
      )
      .limit(1)
    if (!row) throw notFound("Servicio")
    service = row
  }
  const priority = assertPriority(input.priority ?? "normal")
  const [created] = await tx
    .insert(waitlistEntry)
    .values({
      organizationId: orgId,
      branchId: input.branchId,
      patientId: input.patientId ?? null,
      contactId: input.contactId ?? null,
      dentistUserId: input.dentistUserId ?? null,
      serviceId: service?.id ?? null,
      serviceName: service?.name ?? null,
      priority,
      status: "en_espera",
      notes: input.notes?.trim() || null,
      createdBy: actorUserId,
    })
    .returning({ id: waitlistEntry.id })
  if (!created) throw new Error("No se pudo registrar la espera")
  return getWaitlistItem(tx, orgId, created.id)
}

async function requireWaitlistEntry(tx: Db, orgId: string, id: string) {
  const [row] = await tx
    .select()
    .from(waitlistEntry)
    .where(and(eq(waitlistEntry.organizationId, orgId), eq(waitlistEntry.id, id)))
    .limit(1)
  if (!row) throw notFound("Espera")
  return row
}

/**
 * Ofrece un hueco concreto de la lista de espera usando el mismo servicio
 * registrado. Valida disponibilidad real antes de marcarla como ofrecida y
 * avisa al profesional destinatario.
 */
export async function offerWaitlistSlot(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  input: { startsAt: string; endsAt: string; dentistUserId?: string; chairId?: string },
): Promise<WaitlistItem> {
  const entry = await requireWaitlistEntry(tx, orgId, id)
  if (entry.status !== "en_espera" && entry.status !== "ofrecida") {
    throw validation("Solo se puede ofrecer una espera pendiente")
  }
  if (!entry.patientId) throw validation("La espera necesita un paciente para ofrecer un hueco")
  const startsAt = parseInstant(input.startsAt, "startsAt")
  const endsAt = parseInstant(input.endsAt, "endsAt")
  const dentistUserId = input.dentistUserId ?? entry.dentistUserId
  if (!dentistUserId) throw validation("La oferta necesita un profesional")
  const chairId = input.chairId ?? entry.offeredChairId
  if (!chairId) throw validation("La oferta necesita un sillón")
  await validateAvailability(tx, orgId, {
    branchId: entry.branchId,
    dentistUserId,
    chairId,
    startsAt,
    endsAt,
  })
  await tx
    .update(waitlistEntry)
    .set({
      dentistUserId,
      offeredStartsAt: startsAt,
      offeredEndsAt: endsAt,
      offeredChairId: chairId,
      status: "ofrecida",
      updatedAt: new Date(),
    })
    .where(and(eq(waitlistEntry.organizationId, orgId), eq(waitlistEntry.id, id)))
  await createWorkspaceNotification(tx, orgId, {
    userId: dentistUserId,
    dedupeKey: `waitlist-offer-${id}`,
    title: "Hueco ofrecido de lista de espera",
    body: `Hay un hueco ofrecido en agenda pendiente de confirmación.`,
    href: "/agenda",
    permission: "appointments.read",
  })
  return getWaitlistItem(tx, orgId, id)
}

async function getWaitlistItem(tx: Db, orgId: string, id: string): Promise<WaitlistItem> {
  const [item] = await tx
    .select({
      entry: waitlistEntry,
      patientName: patient.displayName,
      contactName: contact.displayName,
      dentistName: user.name,
    })
    .from(waitlistEntry)
    .leftJoin(
      patient,
      and(eq(patient.organizationId, orgId), eq(patient.id, waitlistEntry.patientId)),
    )
    .leftJoin(
      contact,
      and(eq(contact.organizationId, orgId), eq(contact.id, waitlistEntry.contactId)),
    )
    .leftJoin(user, eq(user.id, waitlistEntry.dentistUserId))
    .where(and(eq(waitlistEntry.organizationId, orgId), eq(waitlistEntry.id, id)))
    .limit(1)
  if (!item) throw new Error("No se pudo leer la espera")
  return toWaitlistItem(item)
}

/** La espera ofrecida vuelve a pendiente (el hueco se libera para otros). */
export async function cancelWaitlistEntry(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
): Promise<WaitlistItem> {
  const entry = await requireWaitlistEntry(tx, orgId, id)
  if (entry.status === "confirmada") throw validation("La espera confirmada ya generó su cita")
  await tx
    .update(waitlistEntry)
    .set({ status: "cancelada", updatedAt: new Date() })
    .where(and(eq(waitlistEntry.organizationId, orgId), eq(waitlistEntry.id, id)))
  return getWaitlistItem(tx, orgId, id)
}

export type { ScheduleBlockKind, WaitlistPriority, WaitlistStatus }

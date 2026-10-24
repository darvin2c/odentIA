import type { Db } from "@odentia/db"
import { agentConfig } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { validation } from "./errors.js"
import { findOrgLocale } from "./locale.js"
import {
  isOpportune,
  lastOpportuneAtOrBefore,
  type MinuteRange,
  mergeRanges,
  nextOpportuneFrom,
  type OpportuneSchedule,
  startOfNextLocalDay,
} from "./opportune-hours.js"

/**
 * «Horario de recontacto» (decisión 18 v3 de la fase 4; ADR 0042): cuándo
 * odentIA le escribe a alguien por su cuenta (recordatorios, controles,
 * seguimientos, novedades, lo que inicia el agente, insistir y despedirse).
 * Se configura por día en Agente, con el mismo editor semanal de las sedes, y
 * se lee con la hora de cada sede. No depende del horario de atención y es el
 * único horario: cuando la persona escribe, se le responde siempre (ADR 0084).
 * Los avisos de lo que pasó (una cita cancelada) salen al momento.
 */

/** Por día de la semana (0 = domingo), sus tramos en minutos locales; vacío = ese día no se escribe. */
export type WritingWeek = MinuteRange[][]

const HOUR_MS = 60 * 60_000
/** Tramos por día que acepta el editor: más no tienen sentido para escribir. */
const MAX_RANGES_PER_DAY = 4

/** Lunes a viernes de 8:00 a 20:00, sábado de 8:00 a 14:00 y domingo sin mensajes. */
export const DEFAULT_WRITING_HOURS: WritingWeek = [
  [],
  [[480, 1200]],
  [[480, 1200]],
  [[480, 1200]],
  [[480, 1200]],
  [[480, 1200]],
  [[480, 840]],
]

/** Valida y ordena una semana; lanza un error de validación con lo que está mal. */
export function normalizeWritingWeek(value: unknown): WritingWeek {
  if (!Array.isArray(value) || value.length !== 7) throw validation("El horario de recontacto va por los siete días de la semana")
  return value.map((day, weekday) => {
    if (!Array.isArray(day)) throw validation("Cada día del horario es una lista de tramos")
    if (day.length > MAX_RANGES_PER_DAY) throw validation(`Como mucho ${MAX_RANGES_PER_DAY} tramos por día`)
    const ranges = day.map((range): MinuteRange => {
      if (!Array.isArray(range) || range.length !== 2) throw validation("Cada tramo tiene un inicio y un fin")
      const [start, end] = range as unknown[]
      if (!Number.isInteger(start) || !Number.isInteger(end)) throw validation("Las horas van en minutos enteros")
      const from = start as number
      const until = end as number
      if (from < 0 || until > 1440 || until <= from) {
        throw validation(`El tramo del día ${weekday} debe terminar después de empezar, dentro del mismo día`)
      }
      return [from, until]
    })
    return mergeRanges(ranges)
  })
}

/** Lo guardado, o el horario por defecto si la fila no existe o está dañada. */
function readWeek(value: unknown): WritingWeek {
  try {
    return normalizeWritingWeek(value)
  } catch {
    return DEFAULT_WRITING_HOURS.map((day) => day.map(([a, b]): MinuteRange => [a, b]))
  }
}

export async function getWritingHours(tx: Db, orgId: string): Promise<WritingWeek> {
  const [row] = await tx
    .select({ writingHours: agentConfig.writingHours })
    .from(agentConfig)
    .where(eq(agentConfig.organizationId, orgId))
    .limit(1)
  return readWeek(row?.writingHours ?? DEFAULT_WRITING_HOURS)
}

/** Guarda el horario de recontacto; queda auditado con quién y qué. */
export async function setWritingHours(tx: Db, orgId: string, actorUserId: string | null, week: unknown): Promise<WritingWeek> {
  const next = normalizeWritingWeek(week)
  const now = new Date()
  await tx
    .insert(agentConfig)
    .values({ organizationId: orgId, writingHours: next })
    .onConflictDoUpdate({ target: agentConfig.organizationId, set: { writingHours: next, updatedAt: now } })
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "agent.writing_hours_set",
    entity: "agent_config",
    entityId: orgId,
    metadata: { week: next },
  })
  return next
}

/** El horario de recontacto de la clínica, leído con la hora de una sede (o la de la clínica). */
export function writingSchedule(week: WritingWeek, timeZone: string): OpportuneSchedule {
  return { timeZone, week }
}

export async function writingScheduleOf(tx: Db, orgId: string, timeZone?: string): Promise<OpportuneSchedule> {
  const zone = timeZone ?? (await findOrgLocale(tx, orgId)).timezone
  return writingSchedule(await getWritingHours(tx, orgId), zone)
}

/** ¿Se puede escribir por cuenta propia en `at`? */
export function isWritingTime(at: Date, schedule: OpportuneSchedule): boolean {
  return isOpportune(at, schedule)
}

/**
 * Cuándo sale un mensaje que tocaba en `target` (decisión 18 v3). Dentro del
 * horario, a su hora (o ahora, si ya pasó). Fuera, en el último momento
 * permitido antes, si todavía no pasó; si no hay ninguno, en el primero
 * después, siempre que falte al menos una hora para la cita (`appointmentAt`).
 * Nulo si no hay momento para enviarlo: ya no sale.
 */
export function sendTimeFor(
  target: Date,
  now: Date,
  schedule: OpportuneSchedule,
  appointmentAt?: Date | null,
): Date | null {
  const from = target.getTime() < now.getTime() ? now : target
  if (isOpportune(from, schedule)) return from
  const before = lastOpportuneAtOrBefore(from, schedule)
  if (before && before.getTime() >= now.getTime()) return before
  const after = nextOpportuneFrom(from, schedule)
  if (!after) return null
  if (appointmentAt && appointmentAt.getTime() - after.getTime() < HOUR_MS) return null
  return after
}

/** El primer momento para escribir de un día posterior al de `now` (quien ya recibió su mensaje de hoy). */
export function nextWritingDay(now: Date, schedule: OpportuneSchedule): Date {
  const tomorrow = startOfNextLocalDay(now, schedule.timeZone)
  return nextOpportuneFrom(tomorrow, schedule) ?? tomorrow
}

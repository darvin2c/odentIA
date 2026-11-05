import type { Db } from "@odentia/db"
import { professionalSchedule, scheduleBlock } from "@odentia/db/schema/availability"
import { branch } from "@odentia/db/schema/org"
import { and, eq, gt, isNull, lt } from "drizzle-orm"
import { findOrgLocale } from "./locale.js"
import { addOpportuneMinutes, type MinuteRange, type OpportuneSchedule, openParts, windowsBetween } from "./opportune-hours.js"

/**
 * Cuándo un tema pasa a «Ahora» (decisión 1 del pulido de la Bandeja): a las
 * dos horas de clínica abierta desde que espera una respuesta del equipo. Lo
 * que pasa con la clínica cerrada no cuenta: un tema del sábado a las 18:30 no
 * amanece en rojo el lunes; pasa a «Ahora» el lunes a las 11:00 si abre a las
 * 9:00. Se guarda en el tema (`urgent_at`) para que la Bandeja, Inicio y el
 * Agente digan lo mismo con una sola regla.
 */
export const TOPIC_URGENT_AFTER_MINUTES = 120

const DAY_MS = 86_400_000

type ScheduleRow = { branchId: string; weekday: number; startMin: number; endMin: number }

function weekOf(rows: ScheduleRow[]): MinuteRange[][] {
  const week: MinuteRange[][] = Array.from({ length: 7 }, () => [])
  for (const row of rows) week[row.weekday]?.push([row.startMin, row.endMin])
  return week
}

/**
 * La clínica está abierta cuando atiende alguna de sus sedes: la suma de los
 * horarios activos de sus profesionales en sedes activas, en la zona de la
 * clínica, sin lo que ninguna sede tiene abierto por un cierre. Los cierres se
 * leen desde `from` (desde cuándo espera el tema más antiguo que se cuenta).
 * Nulo si todavía no hay ningún horario (clínica recién creada).
 */
export async function clinicOpenSchedule(tx: Db, orgId: string, from: Date = new Date()): Promise<OpportuneSchedule | null> {
  const rows = await tx
    .select({
      branchId: professionalSchedule.branchId,
      weekday: professionalSchedule.weekday,
      startMin: professionalSchedule.startMin,
      endMin: professionalSchedule.endMin,
    })
    .from(professionalSchedule)
    .innerJoin(branch, and(eq(branch.id, professionalSchedule.branchId), eq(branch.organizationId, orgId), eq(branch.isActive, true)))
    .where(and(eq(professionalSchedule.organizationId, orgId), eq(professionalSchedule.isActive, true)))
  if (rows.length === 0) return null
  const timeZone = (await findOrgLocale(tx, orgId)).timezone
  const week = weekOf(rows)
  return { timeZone, week, closed: await clinicClosures(tx, orgId, rows, { timeZone, week }, from) }
}

/**
 * Cuándo la clínica entera está cerrada aunque su horario diga que abre (un
 * feriado, un cierre): lo que su horario abre y ninguna sede tiene abierto,
 * porque cada una está cerrada por un bloqueo de toda la sede (sin profesional
 * ni unidad) o no atiende a esa hora. Una sede que ese día no abre no anula el
 * cierre de las otras. Desde `from` (o el día anterior, si es más tarde) hasta
 * las cinco semanas que siguen: lo que alcanza a contar un tema.
 */
async function clinicClosures(
  tx: Db,
  orgId: string,
  rows: ScheduleRow[],
  clinic: OpportuneSchedule,
  from: Date,
): Promise<Array<{ start: Date; end: Date }>> {
  const now = Date.now()
  const start = new Date(Math.min(from.getTime(), now - DAY_MS))
  const end = new Date(Math.max(from.getTime(), now) + 33 * DAY_MS)
  const blocks = await tx
    .select({ branchId: scheduleBlock.branchId, start: scheduleBlock.startsAt, end: scheduleBlock.endsAt })
    .from(scheduleBlock)
    .innerJoin(branch, and(eq(branch.id, scheduleBlock.branchId), eq(branch.organizationId, orgId), eq(branch.isActive, true)))
    .where(
      and(
        eq(scheduleBlock.organizationId, orgId),
        isNull(scheduleBlock.professionalUserId),
        isNull(scheduleBlock.roomId),
        gt(scheduleBlock.endsAt, start),
        lt(scheduleBlock.startsAt, end),
      ),
    )
  if (blocks.length === 0) return []
  // Lo que cada sede tiene abierto: su horario, menos sus propios cierres.
  const open = [...new Set(rows.map((row) => row.branchId))].flatMap((branchId) => {
    const own = blocks.filter((block) => block.branchId === branchId)
    const week = weekOf(rows.filter((row) => row.branchId === branchId))
    return windowsBetween({ timeZone: clinic.timeZone, week }, start, end).flatMap((window) =>
      openParts(window.start.getTime(), window.end.getTime(), own),
    )
  })
  const openAsGaps = open.map(([a, b]) => ({ start: new Date(a), end: new Date(b) }))
  // Cerrado: lo que el horario de la clínica abre y ninguna sede tiene abierto.
  return windowsBetween(clinic, start, end)
    .flatMap((window) => openParts(window.start.getTime(), window.end.getTime(), openAsGaps))
    .map(([a, b]) => ({ start: new Date(a), end: new Date(b) }))
}

/**
 * El instante en que un tema que espera desde `since` pasa a «Ahora», con el
 * horario ya leído (para leerlo una sola vez al contar muchos temas). Sin
 * horarios, o si el horario no abre en un mes, cuentan las horas de reloj.
 */
export function topicUrgentAtWith(schedule: OpportuneSchedule | null, since: Date): Date {
  const open = schedule ? addOpportuneMinutes(since, TOPIC_URGENT_AFTER_MINUTES, schedule) : null
  return open ?? new Date(since.getTime() + TOPIC_URGENT_AFTER_MINUTES * 60_000)
}

/** El instante en que un tema que espera desde `since` pasa a «Ahora». */
export async function topicUrgentAt(tx: Db, orgId: string, since: Date): Promise<Date> {
  return topicUrgentAtWith(await clinicOpenSchedule(tx, orgId, since), since)
}

/**
 * De qué trata un tema (R3 de la Bandeja): una cita o un precio van a
 * recepción, una duda clínica al odontólogo que atiende a la persona, un pago a
 * caja y lo demás a recepción. También dice qué puede retomar Sofi al día
 * siguiente: solo citas y precios de lista.
 */
export const TOPIC_KINDS = ["cita", "precio", "clinico", "pago", "otro"] as const
export type TopicKind = (typeof TOPIC_KINDS)[number]
export const topicKindOf = (value: string | null | undefined): TopicKind =>
  (TOPIC_KINDS as readonly string[]).includes(value ?? "") ? (value as TopicKind) : "otro"

/** ¿Está en «Ahora»? Prioridad alta o ya se cumplió su `urgent_at`. */
export function topicIsUrgent(row: { priority: string; urgentAt: Date | null }, now: Date = new Date()): boolean {
  return row.priority === "alta" || (row.urgentAt !== null && row.urgentAt.getTime() <= now.getTime())
}

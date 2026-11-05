import type { Db } from "@odentia/db"
import { professionalSchedule, scheduleBlock } from "@odentia/db/schema/availability"
import { branch } from "@odentia/db/schema/org"
import { and, eq, gt, isNull, lt } from "drizzle-orm"
import { findOrgLocale } from "./locale.js"
import { addOpportuneMinutes, type MinuteRange, type OpportuneSchedule } from "./opportune-hours.js"

/**
 * Cuándo un tema pasa a «Ahora» (decisión 1 del pulido de la Bandeja): a las
 * dos horas de clínica abierta desde que espera una respuesta del equipo. Lo
 * que pasa con la clínica cerrada no cuenta: un tema del sábado a las 18:30 no
 * amanece en rojo el lunes; pasa a «Ahora» el lunes a las 11:00 si abre a las
 * 9:00. Se guarda en el tema (`urgent_at`) para que la Bandeja, Inicio y el
 * Agente digan lo mismo con una sola regla.
 */
export const TOPIC_URGENT_AFTER_MINUTES = 120

/**
 * La clínica está abierta cuando atiende alguna de sus sedes: la suma de los
 * horarios activos de sus profesionales en sedes activas, en la zona de la
 * clínica. Nulo si todavía no hay ningún horario (clínica recién creada).
 */
export async function clinicOpenSchedule(tx: Db, orgId: string): Promise<OpportuneSchedule | null> {
  const rows = await tx
    .select({ weekday: professionalSchedule.weekday, startMin: professionalSchedule.startMin, endMin: professionalSchedule.endMin })
    .from(professionalSchedule)
    .innerJoin(branch, and(eq(branch.id, professionalSchedule.branchId), eq(branch.organizationId, orgId), eq(branch.isActive, true)))
    .where(and(eq(professionalSchedule.organizationId, orgId), eq(professionalSchedule.isActive, true)))
  if (rows.length === 0) return null
  const week: MinuteRange[][] = Array.from({ length: 7 }, () => [])
  for (const row of rows) week[row.weekday]?.push([row.startMin, row.endMin])
  return { timeZone: (await findOrgLocale(tx, orgId)).timezone, week, closed: await clinicClosures(tx, orgId) }
}

/**
 * Cuándo la clínica entera está cerrada aunque su horario diga que abre (un
 * feriado, un cierre): los bloqueos de toda una sede (sin profesional ni
 * unidad), cuando cierran a la vez todas sus sedes activas. Del día anterior a
 * las cuatro semanas que siguen, lo que alcanza a contar un tema.
 */
async function clinicClosures(tx: Db, orgId: string): Promise<Array<{ start: Date; end: Date }>> {
  const now = Date.now()
  const rows = await tx
    .select({ branchId: scheduleBlock.branchId, start: scheduleBlock.startsAt, end: scheduleBlock.endsAt })
    .from(scheduleBlock)
    .innerJoin(branch, and(eq(branch.id, scheduleBlock.branchId), eq(branch.organizationId, orgId), eq(branch.isActive, true)))
    .where(
      and(
        eq(scheduleBlock.organizationId, orgId),
        isNull(scheduleBlock.professionalUserId),
        isNull(scheduleBlock.roomId),
        gt(scheduleBlock.endsAt, new Date(now - 86_400_000)),
        lt(scheduleBlock.startsAt, new Date(now + 32 * 86_400_000)),
      ),
    )
  if (rows.length === 0) return []
  const branches = await tx
    .select({ id: branch.id })
    .from(branch)
    .where(and(eq(branch.organizationId, orgId), eq(branch.isActive, true)))
  // Lo cerrado a la vez en todas las sedes: la intersección de los cierres de cada una.
  let closed: Array<{ start: Date; end: Date }> | null = null
  for (const { id } of branches) {
    const own = rows.filter((row) => row.branchId === id).map((row) => ({ start: row.start, end: row.end }))
    if (closed === null) {
      closed = own
      continue
    }
    const next: Array<{ start: Date; end: Date }> = []
    for (const a of closed)
      for (const b of own) {
        const start = Math.max(a.start.getTime(), b.start.getTime())
        const end = Math.min(a.end.getTime(), b.end.getTime())
        if (end > start) next.push({ start: new Date(start), end: new Date(end) })
      }
    closed = next
  }
  return closed ?? []
}

/**
 * El instante en que un tema que espera desde `since` pasa a «Ahora». Sin
 * horarios, o si el horario no abre en un mes, cuentan las horas de reloj.
 */
export async function topicUrgentAt(tx: Db, orgId: string, since: Date): Promise<Date> {
  const schedule = await clinicOpenSchedule(tx, orgId)
  const open = schedule ? addOpportuneMinutes(since, TOPIC_URGENT_AFTER_MINUTES, schedule) : null
  return open ?? new Date(since.getTime() + TOPIC_URGENT_AFTER_MINUTES * 60_000)
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

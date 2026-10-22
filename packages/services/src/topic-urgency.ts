import type { Db } from "@odentia/db"
import { professionalSchedule } from "@odentia/db/schema/availability"
import { branch } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { findOrgLocale } from "./locale.js"
import { addOpportuneMinutes, type MinuteRange, type OpportuneSchedule } from "./opportune-hours.js"

/**
 * Cuándo un tema pasa a «Ahora» (decisión 1 del pulido de la Bandeja): a las
 * dos horas de clínica abierta desde que espera una respuesta del equipo. Lo
 * que pasa con la clínica cerrada no cuenta: un tema del sábado a las 18:30 no
 * amanece en rojo el lunes; pasa a «Ahora» el lunes a las 11:00 si abre a las
 * 9:00. Se guarda en el tema (`urgent_at`) para que la Bandeja, Inicio y el
 * panel del agente digan lo mismo con una sola regla.
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
  return { timeZone: (await findOrgLocale(tx, orgId)).timezone, week }
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

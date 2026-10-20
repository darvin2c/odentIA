/**
 * Metas del mes (decisión 9 de Reportes v2; ADR 0071): lo cobrado y los
 * pacientes nuevos, por mes y de toda la clínica. Una meta vale desde el mes
 * en que se guarda hasta que otra la reemplace, así que cambiarla no reescribe
 * los meses pasados. Solo se muestran con un mes elegido: un rango de días o
 * varios meses no tienen meta (decisión 15).
 */
import { reportGoal, REPORT_GOAL_METRICS } from "@odentia/db/schema/reports"
import type { Db } from "@odentia/db"
import { sql } from "drizzle-orm"
import { validation } from "./errors.js"
import { getOrgLocale } from "./locale.js"
import { currentMonthIn, monthStart, type ReportWindow, type YearMonth } from "./report-periods.js"

export { REPORT_GOAL_METRICS }
export type ReportGoalMetric = (typeof REPORT_GOAL_METRICS)[number]

export interface ReportGoal {
  metric: ReportGoalMetric
  amount: number
  currency: string | null
  /** El mes desde el que vale (`YYYY-MM`). */
  fromMonth: string
}

const MAX_CENTS = 10_000_000_000_00
const MAX_PATIENTS = 100_000

function monthKey(value: YearMonth): string {
  return `${value.year}-${String(value.month).padStart(2, "0")}`
}

/** Las metas que valen en un mes: la última guardada desde ese mes o antes; sin importe, no hay meta. */
export async function goalsForMonth(tx: Db, orgId: string, month: YearMonth): Promise<Partial<Record<ReportGoalMetric, ReportGoal>>> {
  const rows = await tx.execute<{ metric: ReportGoalMetric; amount: string | null; currency: string | null; fromMonth: string }>(sql`
    select distinct on (metric) metric, amount::text as amount, currency, to_char(from_month, 'YYYY-MM') as "fromMonth"
    from report_goal
    where organization_id = ${orgId} and from_month <= ${`${monthKey(month)}-01`}::date
    order by metric, from_month desc`)
  const out: Partial<Record<ReportGoalMetric, ReportGoal>> = {}
  for (const row of rows) {
    if (row.amount === null) continue
    out[row.metric] = { metric: row.metric, amount: Number(row.amount), currency: row.currency, fromMonth: row.fromMonth }
  }
  return out
}

/**
 * Pone, cambia o quita (`amount` nulo) una meta desde el mes en curso, en la
 * zona de la clínica. Dos cambios en el mismo mes dejan el último; los meses
 * pasados conservan la que tenían. Lo cobrado va en la moneda de la clínica.
 */
export async function setReportGoal(
  tx: Db,
  orgId: string,
  userId: string,
  input: { metric: string; amount: number | null },
  now: Date = new Date(),
): Promise<{ metric: ReportGoalMetric; amount: number | null; fromMonth: string }> {
  if (!(REPORT_GOAL_METRICS as readonly string[]).includes(input.metric)) throw validation("Meta no reconocida")
  const metric = input.metric as ReportGoalMetric
  const { timezone, currency } = await getOrgLocale(tx, orgId)
  if (input.amount !== null) {
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw validation(metric === "cobrado" ? "Escribe cuánto quieres cobrar cada mes" : "Escribe cuántos pacientes nuevos quieres cada mes")
    if (input.amount > (metric === "cobrado" ? MAX_CENTS : MAX_PATIENTS)) throw validation("La meta es demasiado grande")
  }
  const month = currentMonthIn(timezone, now)
  const fromMonth = `${monthKey(month)}-01`
  const values = {
    organizationId: orgId,
    metric,
    fromMonth,
    amount: input.amount,
    currency: metric === "cobrado" && input.amount !== null ? currency : null,
    setBy: userId,
    setAt: now,
  }
  await tx
    .insert(reportGoal)
    .values(values)
    .onConflictDoUpdate({
      target: [reportGoal.organizationId, reportGoal.metric, reportGoal.fromMonth],
      set: { amount: values.amount, currency: values.currency, setBy: userId, setAt: now },
    })
  return { metric, amount: input.amount, fromMonth: monthKey(month) }
}

export interface GoalProgress {
  amount: number
  currency: string | null
  value: number
  /** Cuánto de la meta se llegó, en porcentaje entero (puede pasar de 100). */
  percent: number
  /** Lo que falta; 0 si ya se llegó. */
  remaining: number
}

export interface ReportGoals {
  /** El mes elegido (`YYYY-MM`); null si el periodo no es un mes: entonces no hay metas. */
  month: string | null
  /** El mes elegido es el que corre: ahí se pone o se cambia la meta. */
  editable: boolean
  /** En el mes que corre: cuánto del mes ya pasó y cuántos días quedan (con hoy). */
  elapsedPercent: number | null
  daysLeft: number | null
  cobrado: GoalProgress | null
  pacientesNuevos: GoalProgress | null
  /** El mejor mes de los últimos 12 ya cerrados, para sugerir una meta. */
  best: { cobrado: { month: string; cents: number } | null; pacientesNuevos: { month: string; count: number } | null }
}

function progressOf(goal: ReportGoal | undefined, value: number, currency: string | null): GoalProgress | null {
  if (!goal) return null
  // Una meta en otra moneda no se compara con lo cobrado: nunca se convierte.
  if (goal.metric === "cobrado" && goal.currency !== currency) return null
  return { amount: goal.amount, currency: goal.currency, value, percent: Math.round((value * 100) / goal.amount), remaining: Math.max(0, goal.amount - value) }
}

/**
 * Las metas del periodo de la pantalla, con su avance: lo que se cobró y los
 * pacientes nuevos del mes salen del Resumen (las mismas consultas).
 */
export async function reportGoalsFor(
  tx: Db,
  orgId: string,
  input: {
    window: ReportWindow
    timezone: string
    currency: string
    now: Date
    collected: number
    newPatients: number
    months: Array<{ key: string; partial: boolean; collected: number; newPatients: number }>
  },
): Promise<ReportGoals> {
  const { window, timezone, now } = input
  const complete = input.months.filter((month) => !month.partial)
  const bestOf = <K extends "collected" | "newPatients">(key: K) =>
    complete.reduce<(typeof complete)[number] | null>((top, month) => (month[key] > 0 && (!top || month[key] > top[key]) ? month : top), null)
  const bestCollected = bestOf("collected")
  const bestPatients = bestOf("newPatients")
  const best = {
    cobrado: bestCollected ? { month: bestCollected.key, cents: bestCollected.collected } : null,
    pacientesNuevos: bestPatients ? { month: bestPatients.key, count: bestPatients.newPatients } : null,
  }
  const single = window.kind === "months" && window.from.year === window.to.year && window.from.month === window.to.month
  if (!single) return { month: null, editable: false, elapsedPercent: null, daysLeft: null, cobrado: null, pacientesNuevos: null, best }
  const current = currentMonthIn(timezone, now)
  const editable = current.year === window.from.year && current.month === window.from.month
  const goals = await goalsForMonth(tx, orgId, window.from)
  let elapsedPercent: number | null = null
  let daysLeft: number | null = null
  if (editable) {
    const start = monthStart(timezone, window.from.year, window.from.month)
    const next = window.from.month === 12 ? monthStart(timezone, window.from.year + 1, 1) : monthStart(timezone, window.from.year, window.from.month + 1)
    elapsedPercent = Math.round(((now.getTime() - start.getTime()) * 100) / (next.getTime() - start.getTime()))
    daysLeft = Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 86_400_000))
  }
  return {
    month: monthKey(window.from),
    editable,
    elapsedPercent,
    daysLeft,
    cobrado: progressOf(goals.cobrado, input.collected, input.currency),
    pacientesNuevos: progressOf(goals.pacientes_nuevos, input.newPatients, null),
    best,
  }
}

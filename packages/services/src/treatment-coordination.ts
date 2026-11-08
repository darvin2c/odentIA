/**
 * Coordinación del tratamiento para quien agenda sin leer la ficha clínica.
 *
 * Reúne lo que recepción necesita para dar continuidad —qué espera decisión,
 * qué control falta reservar y qué tratamiento sigue abierto— con el mínimo de
 * datos: títulos, estados y fechas. Nunca diagnósticos, piezas, superficies,
 * importes, instrucciones ni notas. Las reglas siguen en sus servicios; aquí
 * solo se proyecta lo que estos ya devuelven.
 */
import type { Db } from "@odentia/db"
import { appointment } from "@odentia/db/schema/agenda"
import { treatmentBudget } from "@odentia/db/schema/clinical"
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm"
import { SCHEDULABLE_ITEM_STATUSES } from "./appointments.js"
import { budgetAwaitsAnswerSql } from "./budget-awaiting.js"
import { listFollowUps, type ScheduleFollowUpInput, scheduleFollowUp } from "./follow-ups.js"
import { findOrgLocale } from "./locale.js"
import { scheduledItems } from "./plan-next.js"
import { listPlanItems } from "./plan.js"
import {
  appointmentServesControl,
  isOverdueControl,
  isToSchedule,
  LIVE_APPOINTMENT_STATUSES,
  nextControlOf,
  sessionCountsOf,
  sessionsLeft,
} from "./to-schedule.js"

const OPEN_TREATMENT_STATUSES = ["pendiente", "programado", "en_curso", "suspendido"]
// Lo que no aceptó, lo reemplazado y lo que estaba solo en una opción no elegida.
const DISCARDED_DECISIONS = ["rechazado", "reemplazado", "no_elegida"]

export interface CoordinationFollowUp {
  id: string
  patientId: string
  title: string
  dueAt: Date
  status: string
  legacyScheduledAt: Date | null
  appointment: { id: string; startsAt: Date; endsAt: Date; status: string } | null
  /** La sede donde se indicó, para reservar ahí (ADR 0152); nula: la sede activa. */
  branchId: string | null
  /** Desde cuándo una visita lo cumple: «Usar esa cita» ofrece las citas desde ahí. */
  windowFrom: Date
}

/**
 * El próximo control de la persona para el Resumen (QA del 6 nov, X3), con el
 * orden y las reglas de «Qué sigue»: `nextControlOf`, `isOverdueControl` y
 * `appointmentServesControl`. Sin diagnósticos ni indicaciones: lo lee recepción.
 */
export interface NextControl {
  id: string
  title: string
  dueAt: Date
  status: string
  /** Vencido sin cita: pendiente, su día ya pasó y no tiene ninguna cita por venir. */
  overdue: boolean
  /**
   * La cita que lo cumple: la suya si está reservado, o la próxima cita de la
   * persona si cae desde que abre su ventana. Nula: falta reservarla.
   */
  appointment: { id: string; startsAt: Date } | null
}

export interface TreatmentCoordination {
  /** Presupuestos que esperan respuesta de quien decide (`budgetAwaitsAnswerSql`). */
  budgetsAwaitingDecision: Array<{ id: string; title: string; presentedAt: Date | null }>
  /** Controles abiertos: por reservar o con cita vigente. */
  followUps: CoordinationFollowUp[]
  /** El próximo control, el mismo que nombra «Qué sigue»; nulo si no tiene ninguno abierto. */
  nextControl: NextControl | null
  /**
   * Tratamientos abiertos, solo nombre y estado operativo. `toSchedule`: aceptado
   * y sin cita por venir, lo que «Nueva cita» ofrece para traer. `sessionsLeft`:
   * cuántas sesiones le faltan reservar (`canBookAnother`); con alguna, «Nueva
   * cita» también lo ofrece, como «sesión 2 de 2» (`nextSession`).
   */
  treatments: Array<{
    id: string
    title: string
    status: string
    decision: string
    serviceId: string | null
    toSchedule: boolean
    sessionsLeft: number
    /** La sesión que sería una cita nueva al final: hechas + en pie + 1, de las previstas. */
    nextSession: { n: number; m: number }
  }>
}

function toCoordinationFollowUp(
  row: Awaited<ReturnType<typeof listFollowUps>>[number],
): CoordinationFollowUp {
  return {
    id: row.id,
    patientId: row.patientId,
    title: row.title,
    dueAt: row.dueAt,
    status: row.status,
    legacyScheduledAt: row.legacyScheduledAt,
    appointment: row.appointment,
    branchId: row.branchId,
    windowFrom: row.windowFrom,
  }
}

export async function getTreatmentCoordination(
  tx: Db,
  orgId: string,
  patientId: string,
): Promise<TreatmentCoordination> {
  // `listFollowUps` y `listPlanItems` verifican que el paciente es de la organización.
  const followUps = await listFollowUps(tx, orgId, patientId)
  const items = await listPlanItems(tx, orgId, patientId)
  const budgets = await tx
    .select({
      id: treatmentBudget.id,
      title: treatmentBudget.title,
      presentedAt: treatmentBudget.presentedAt,
    })
    .from(treatmentBudget)
    .where(
      and(
        eq(treatmentBudget.organizationId, orgId),
        eq(treatmentBudget.patientId, patientId),
        budgetAwaitsAnswerSql(treatmentBudget),
      ),
    )
    .orderBy(desc(treatmentBudget.createdAt), desc(treatmentBudget.id))
  const open = items.filter(
    (item) =>
      OPEN_TREATMENT_STATUSES.includes(item.status) &&
      !DISCARDED_DECISIONS.includes(item.decisionStatus),
  )
  // La regla de «Por agendar» (`isToSchedule`): aceptado, por hacer y sin una cita por venir que lo lleve.
  const schedulable = open.filter((item) => item.decisionStatus === "aceptado" && SCHEDULABLE_ITEM_STATUSES.includes(item.status))
  const withAppointment = await scheduledItems(tx, orgId, patientId, schedulable.map((item) => item.id))
  const toSchedule = new Set(open.filter((item) => isToSchedule(item, withAppointment)).map((item) => item.id))
  const counts = await sessionCountsOf(tx, orgId, schedulable.map((item) => item.id))
  const countOf = (id: string) => counts.get(id) ?? { done: 0, booked: 0 }
  return {
    budgetsAwaitingDecision: budgets,
    followUps: followUps
      .filter((row) => row.status === "pendiente" || row.status === "programado")
      .map(toCoordinationFollowUp),
    nextControl: await nextControlFor(tx, orgId, patientId, followUps),
    treatments: open.map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      decision: item.decision,
      serviceId: item.serviceId,
      toSchedule: toSchedule.has(item.id),
      sessionsLeft: sessionsLeft(item, countOf(item.id)),
      nextSession: { n: countOf(item.id).done + countOf(item.id).booked + 1, m: item.plannedSessions },
    })),
  }
}

/** El próximo control con lo que el Resumen dice de él: si venció y qué cita lo cumple. */
async function nextControlFor(
  tx: Db,
  orgId: string,
  patientId: string,
  followUps: Awaited<ReturnType<typeof listFollowUps>>,
): Promise<NextControl | null> {
  const control = nextControlOf(followUps)
  if (!control) return null
  const { timezone } = await findOrgLocale(tx, orgId)
  const [next] = await tx
    .select({ id: appointment.id, startsAt: appointment.startsAt })
    .from(appointment)
    .where(
      and(
        eq(appointment.organizationId, orgId),
        eq(appointment.patientId, patientId),
        inArray(appointment.status, [...LIVE_APPOINTMENT_STATUSES]),
        gt(appointment.startsAt, new Date()),
      ),
    )
    .orderBy(asc(appointment.startsAt))
    .limit(1)
  const own =
    control.status === "programado" && control.appointment && control.scheduledAt
      ? { id: control.appointment.id, startsAt: control.appointment.startsAt }
      : null
  const serving =
    control.status === "pendiente" && next && appointmentServesControl(control, next.startsAt, timezone) ? next : null
  return {
    id: control.id,
    title: control.title,
    dueAt: control.dueAt,
    status: control.status,
    overdue: isOverdueControl(control, next?.startsAt ?? null, timezone),
    appointment: own ?? serving,
  }
}

/**
 * Reserva la cita de un control desde la coordinación: misma operación que la
 * vía clínica (`scheduleFollowUp`), con respuesta mínima.
 */
export async function scheduleFollowUpFromCoordination(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  followUpId: string,
  input: ScheduleFollowUpInput,
): Promise<CoordinationFollowUp> {
  const updated = await scheduleFollowUp(tx, orgId, actorUserId, patientId, followUpId, input)
  return toCoordinationFollowUp(updated)
}

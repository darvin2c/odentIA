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
import { treatmentBudget } from "@odentia/db/schema/clinical"
import { and, desc, eq } from "drizzle-orm"
import { budgetAwaitsAnswerSql } from "./budget-awaiting.js"
import { listFollowUps, type ScheduleFollowUpInput, scheduleFollowUp } from "./follow-ups.js"
import { listPlanItems } from "./plan.js"

const OPEN_TREATMENT_STATUSES = ["pendiente", "programado", "en_curso", "suspendido"]
const DISCARDED_DECISIONS = ["rechazado", "reemplazado"]

export interface CoordinationFollowUp {
  id: string
  patientId: string
  title: string
  dueAt: Date
  status: string
  legacyScheduledAt: Date | null
  appointment: { id: string; startsAt: Date; endsAt: Date; status: string } | null
}

export interface TreatmentCoordination {
  /** Presupuestos que esperan respuesta de quien decide (`budgetAwaitsAnswerSql`). */
  budgetsAwaitingDecision: Array<{ id: string; title: string; presentedAt: Date | null }>
  /** Controles abiertos: por reservar o con cita vigente. */
  followUps: CoordinationFollowUp[]
  /** Tratamientos abiertos, solo nombre y estado operativo. */
  treatments: Array<{ id: string; title: string; status: string; decision: string }>
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
  return {
    budgetsAwaitingDecision: budgets,
    followUps: followUps
      .filter((row) => row.status === "pendiente" || row.status === "programado")
      .map(toCoordinationFollowUp),
    treatments: items
      .filter(
        (item) =>
          OPEN_TREATMENT_STATUSES.includes(item.status) &&
          !DISCARDED_DECISIONS.includes(item.decisionStatus),
      )
      .map((item) => ({
        id: item.id,
        title: item.title,
        status: item.status,
        decision: item.decision,
      })),
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

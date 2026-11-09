/**
 * «No contesta · volver a llamar» de un presupuesto entregado (QA de la ficha del 9 nov):
 * recepción lo llama, no contesta, y anota cuándo volver a llamar. No es una respuesta: el
 * presupuesto sigue esperando la suya (`budgetAwaitsAnswer`) y nada de lo que lee el agente
 * cambia. Es una tarea de recepción con fecha, la misma de Tareas: una sola abierta por
 * presupuesto (clave `presupuesto-llamar:<id>`), que se reprograma si vuelve a no contestar y
 * se cierra sola cuando se anota su respuesta (`settleBudgetCallback`).
 */
import type { Db } from "@odentia/db"
import { patient, treatmentBudget } from "@odentia/db/schema/clinical"
import { crmTask } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { and, eq, sql } from "drizzle-orm"
import { budgetAwaitsAnswer } from "./budget-awaiting.js"
import { invalidField, notFound, ServiceError } from "./errors.js"
import { findOrgLocale } from "./locale.js"
import { joinPatientPerson, patientPerson } from "./patient-identity.js"
import { createTask } from "./tasks.js"

/** Prefijo de la tarea «Volver a llamar» de un presupuesto; la lee «Qué sigue» (`plan-next.ts`). */
export const BUDGET_CALLBACK_KEY = "presupuesto-llamar:"

export interface BudgetCallback {
  taskId: string
  dueAt: Date
}

/** Anota que no contestó y cuándo volver a llamar (`callAgainAt`, un instante por venir). */
export async function noteBudgetNoAnswer(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  budgetId: string,
  input: { callAgainAt: string },
): Promise<BudgetCallback> {
  const dueAt = new Date(input.callAgainAt)
  if (Number.isNaN(dueAt.getTime())) throw invalidField("callAgainAt", "Elige cuándo volver a llamar")
  if (dueAt.getTime() < Date.now() - 24 * 3_600_000) throw invalidField("callAgainAt", "Elige un día de hoy en adelante")
  const [budget] = await tx
    .select({ id: treatmentBudget.id, status: treatmentBudget.status })
    .from(treatmentBudget)
    .where(and(eq(treatmentBudget.organizationId, orgId), eq(treatmentBudget.patientId, patientId), eq(treatmentBudget.id, budgetId)))
    .limit(1)
  if (!budget) throw notFound("Presupuesto")
  const lines = await tx.execute<{ decision: string | null }>(
    sql`select decision from treatment_budget_item where organization_id = ${orgId} and budget_id = ${budgetId}`,
  )
  if (!budgetAwaitsAnswer({ status: budget.status, items: [...lines] }))
    throw new ServiceError("BUDGET_NOT_AWAITING", 409, "Este presupuesto ya no espera respuesta: su estado está arriba")
  const key = `${BUDGET_CALLBACK_KEY}${budgetId}`
  const [existing] = await tx
    .select({ id: crmTask.id })
    .from(crmTask)
    .where(and(eq(crmTask.organizationId, orgId), eq(crmTask.idempotencyKey, key)))
    .limit(1)
  // «No contestó el 9 nov», en el formato y el día de la clínica: lo lee recepción en Tareas.
  const { locale, timezone } = await findOrgLocale(tx, orgId)
  const reason = `No contestó el ${new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: timezone }).format(new Date()).replace(".", "")}`
  let taskId: string
  if (existing) {
    // Volvió a no contestar (o la tarea ya se había cerrado a mano): la misma tarea, otra fecha.
    await tx
      .update(crmTask)
      .set({ status: "open", dueAt, reason, settledReason: null, updatedAt: new Date() })
      .where(and(eq(crmTask.organizationId, orgId), eq(crmTask.id, existing.id)))
    await tx.execute(sql`select pg_notify('org_events', ${JSON.stringify({ orgId, kind: "task.updated", at: new Date().toISOString() })})`)
    taskId = existing.id
  } else {
    const [person] = await tx
      .select({ givenNames: patientPerson.givenNames, displayName: patientPerson.displayName })
      .from(patient)
      .innerJoin(patientPerson, joinPatientPerson(patientPerson))
      .where(and(eq(patient.organizationId, orgId), eq(patient.id, patientId)))
      .limit(1)
    // Por el presupuesto de la persona, no «a» ella: de un menor se llama a quien decide (paciente ≠ interlocutor).
    const name = person?.displayName || "la persona"
    const created = await createTask(tx, orgId, {
      title: `Volver a llamar por el presupuesto de ${name}`,
      patientId,
      area: "recepcion",
      dueAt: dueAt.toISOString(),
      createdBy: "user",
      actorUserId,
      reason,
      idempotencyKey: key,
    })
    taskId = created.id
  }
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "budget.no_answer",
    entity: "treatment_budget",
    entityId: budgetId,
    metadata: { patientId, callAgainAt: dueAt.toISOString() },
  })
  return { taskId, dueAt }
}

/** Ya respondió, se anuló o se revisó: su «volver a llamar» se cierra solo, con el motivo. */
export async function settleBudgetCallback(
  tx: Db,
  orgId: string,
  budgetId: string,
  why = "Ya respondió su presupuesto",
): Promise<void> {
  await tx
    .update(crmTask)
    .set({ status: "done", settledReason: why, updatedAt: new Date() })
    .where(
      and(
        eq(crmTask.organizationId, orgId),
        eq(crmTask.idempotencyKey, `${BUDGET_CALLBACK_KEY}${budgetId}`),
        eq(crmTask.status, "open"),
      ),
    )
}

/**
 * «Qué sigue» del plan de una persona (tablero 3 de la fase 3): una frase y un
 * botón que decide el servidor. Es la misma regla para la pestaña Plan, el
 * Resumen, «Te espera» y la línea del Administrador que retoma presupuestos:
 * se apoya en `budgetAwaitsAnswer` (lo que espera respuesta), en
 * `deriveNextAction` (el siguiente paso de un tratamiento) y en los controles.
 *
 * El orden es fijo y sin puntajes:
 * 1. Un presupuesto armado y sin enviar: «Enviar el presupuesto a Lucía».
 * 2. Lo aceptado que aún no tiene cita: «Aceptó 2 de 3: falta su cita».
 * 3. Lo que espera respuesta: «Enviado · espera respuesta» o «Lo está pensando».
 * 4. Un tratamiento en curso sin cita para su próxima sesión.
 * 5. El próximo control: «Control de las resinas · por reservar desde el 20 nov».
 *
 * Recibe `can`: el botón solo se ofrece a quien puede hacerlo. La frase nunca
 * lleva diagnósticos, piezas ni notas: también la lee recepción.
 */
import { formatMoney } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { appointment } from "@odentia/db/schema/agenda"
import {
  appointmentPlanItem,
  clinicalFollowUp,
  patient,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm"
import { firstName } from "./automation-routing.js"
import { listBudgets, listBudgetsForPatients, valueOptionOf, type BudgetWithTotals } from "./budgets.js"
import { notFound } from "./errors.js"
import { findOrgLocale } from "./locale.js"
import { deriveNextAction } from "./treatment-journey.js"
import { joinPatientPerson, patientPerson } from "./patient-identity.js"
import { productHooks } from "./products.js"

export type PlanNextKind = "enviar" | "agendar" | "respuesta" | "continuar" | "control" | "ninguno"

export interface PlanNextAction {
  /** «Enviar», «Reservar cita» o «¿Qué respondió?». */
  label: string
  budgetId?: string
  /** Lo aceptado que se agenda junto: la cita los trae. */
  planItemIds?: string[]
  /** El servicio con el que se abre «Nueva cita». */
  serviceId?: string | null
  followUpId?: string
}

export interface PlanNextStep {
  kind: PlanNextKind
  text: string
  detail: string | null
  /** Nulo si el rol no puede hacerlo (la frase igual se dice). */
  action: PlanNextAction | null
}

export type Can = (permission: string) => boolean

/** Estados de una cita que todavía va a ocurrir. */
const LIVE_APPOINTMENT = ["programada", "confirmada"]

function dayWords(date: Date, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone }).format(date).replace(".", "")
}

/** Tratamientos con una cita por venir que ya los trae. */
export async function scheduledItems(tx: Db, orgId: string, patientId: string, itemIds: string[]): Promise<Set<string>> {
  if (itemIds.length === 0) return new Set()
  const rows = await tx
    .select({ planItemId: appointmentPlanItem.planItemId })
    .from(appointmentPlanItem)
    .innerJoin(
      appointment,
      and(eq(appointment.id, appointmentPlanItem.appointmentId), eq(appointment.organizationId, appointmentPlanItem.organizationId)),
    )
    .where(
      and(
        eq(appointmentPlanItem.organizationId, orgId),
        eq(appointmentPlanItem.patientId, patientId),
        inArray(appointmentPlanItem.planItemId, itemIds),
        inArray(appointment.status, LIVE_APPOINTMENT),
        gt(appointment.startsAt, new Date()),
      ),
    )
  return new Set(rows.map((row) => row.planItemId))
}

/** El presupuesto armado y sin enviar de la persona, si tiene líneas. */
export function unsentBudgetOf(budgets: BudgetWithTotals[]): BudgetWithTotals | null {
  return budgets.find((budget) => budget.status === "borrador" && !budget.supersedesBudgetId && budget.items.length > 0) ?? null
}

/** «3 tratamientos · S/ 540», con el total de la opción que vale. */
export function budgetLine(budget: BudgetWithTotals, locale: string): string {
  const value = valueOptionOf(budget.options)
  const count = value?.lineCount ?? budget.items.length
  const money = budget.totalCents == null ? "falta algún precio" : formatMoney(budget.totalCents, budget.currency, locale)
  const options = budget.options.length > 1 ? ` · ${budget.options.length} opciones` : ""
  return `${count} ${count === 1 ? "tratamiento" : "tratamientos"} · ${money}${options}`
}

export async function getPlanNextStep(
  tx: Db,
  orgId: string,
  patientId: string,
  can: Can,
): Promise<PlanNextStep> {
  const [person] = await tx
    .select({ givenNames: patientPerson.givenNames, displayName: patientPerson.displayName })
    .from(patient)
    .innerJoin(patientPerson, joinPatientPerson(patientPerson))
    .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
    .limit(1)
  if (!person) throw notFound("Paciente")
  const context = await planContext(tx, orgId)
  const budgets = await listBudgets(tx, orgId, patientId)
  const items = await tx
    .select()
    .from(treatmentPlanItem)
    .where(and(eq(treatmentPlanItem.organizationId, orgId), eq(treatmentPlanItem.patientId, patientId)))
    .orderBy(asc(treatmentPlanItem.sortOrder), asc(treatmentPlanItem.createdAt), asc(treatmentPlanItem.id))
  const withAppointment = await scheduledItems(tx, orgId, patientId, items.map((item) => item.id))
  const [control] = await tx
    .select()
    .from(clinicalFollowUp)
    .where(
      and(
        eq(clinicalFollowUp.organizationId, orgId),
        eq(clinicalFollowUp.patientId, patientId),
        inArray(clinicalFollowUp.status, ["pendiente", "programado"]),
      ),
    )
    .orderBy(sql`${clinicalFollowUp.status} = 'pendiente' desc`, asc(clinicalFollowUp.dueAt))
    .limit(1)
  return planNextStepFrom({ name: firstName(person), budgets, items, withAppointment, control }, context, can)
}

/**
 * «Qué sigue» de muchos pacientes a la vez (los atajos de Pacientes y su
 * página): lo mismo que `getPlanNextStep` de cada uno, con la misma regla
 * (`planNextStepFrom`) y un puñado de consultas en total, no varias por
 * paciente. Un paciente que no existe no aparece.
 */
export async function planNextStepsOf(
  tx: Db,
  orgId: string,
  patientIds: string[],
  can: Can,
): Promise<Map<string, PlanNextStep>> {
  const out = new Map<string, PlanNextStep>()
  if (patientIds.length === 0) return out
  const people = await tx
    .select({ id: patient.id, givenNames: patientPerson.givenNames, displayName: patientPerson.displayName })
    .from(patient)
    .innerJoin(patientPerson, joinPatientPerson(patientPerson))
    .where(and(eq(patient.organizationId, orgId), inArray(patient.id, patientIds)))
  if (people.length === 0) return out
  const ids = people.map((person) => person.id)
  const context = await planContext(tx, orgId)
  const budgets = await listBudgetsForPatients(tx, orgId, ids)
  const items = await tx
    .select()
    .from(treatmentPlanItem)
    .where(and(eq(treatmentPlanItem.organizationId, orgId), inArray(treatmentPlanItem.patientId, ids)))
    .orderBy(asc(treatmentPlanItem.sortOrder), asc(treatmentPlanItem.createdAt), asc(treatmentPlanItem.id))
  const scheduled = await tx
    .select({ planItemId: appointmentPlanItem.planItemId })
    .from(appointmentPlanItem)
    .innerJoin(
      appointment,
      and(eq(appointment.id, appointmentPlanItem.appointmentId), eq(appointment.organizationId, appointmentPlanItem.organizationId)),
    )
    .where(
      and(
        eq(appointmentPlanItem.organizationId, orgId),
        inArray(appointmentPlanItem.patientId, ids),
        inArray(appointment.status, LIVE_APPOINTMENT),
        gt(appointment.startsAt, new Date()),
      ),
    )
  const withAppointment = new Set(scheduled.map((row) => row.planItemId))
  // El próximo control de cada uno, con el mismo orden que el de uno solo.
  const controls = await tx
    .selectDistinctOn([clinicalFollowUp.patientId])
    .from(clinicalFollowUp)
    .where(
      and(
        eq(clinicalFollowUp.organizationId, orgId),
        inArray(clinicalFollowUp.patientId, ids),
        inArray(clinicalFollowUp.status, ["pendiente", "programado"]),
      ),
    )
    .orderBy(clinicalFollowUp.patientId, sql`${clinicalFollowUp.status} = 'pendiente' desc`, asc(clinicalFollowUp.dueAt))
  const itemsOf = new Map<string, PlanItemRow[]>()
  for (const item of items) {
    const list = itemsOf.get(item.patientId) ?? []
    list.push(item)
    itemsOf.set(item.patientId, list)
  }
  const controlOf = new Map(controls.map((row) => [row.patientId, row]))
  for (const person of people) {
    out.set(
      person.id,
      planNextStepFrom(
        {
          name: firstName(person),
          budgets: budgets.get(person.id) ?? [],
          items: itemsOf.get(person.id) ?? [],
          withAppointment,
          control: controlOf.get(person.id),
        },
        context,
        can,
      ),
    )
  }
  return out
}

type PlanItemRow = typeof treatmentPlanItem.$inferSelect
type FollowUpRow = typeof clinicalFollowUp.$inferSelect

/** Lo de la clínica que necesita la frase: formato de fechas y si su producto pide presupuesto. */
interface PlanContext {
  locale: string
  timezone: string
  budgetRequired: boolean
}

async function planContext(tx: Db, orgId: string): Promise<PlanContext> {
  const { locale, timezone } = await findOrgLocale(tx, orgId)
  return { locale, timezone, budgetRequired: (await productHooks(tx, orgId)).budgetRequired }
}

/** Lo de una persona que decide su «Qué sigue». `withAppointment` puede traer tratamientos de otras. */
interface PlanFacts {
  name: string
  budgets: BudgetWithTotals[]
  items: PlanItemRow[]
  withAppointment: Set<string>
  control: FollowUpRow | undefined
}

/** La regla de «Qué sigue», en el orden fijo de arriba. Sin consultas: decide con lo cargado. */
function planNextStepFrom(facts: PlanFacts, context: PlanContext, can: Can): PlanNextStep {
  const { name, budgets, items, withAppointment, control } = facts
  const { locale, timezone } = context
  const day = (date: Date) => dayWords(date, locale, timezone)

  // 1. Armado y sin enviar: lo envía recepción (decisión 4).
  const unsent = unsentBudgetOf(budgets)
  if (unsent) {
    return {
      kind: "enviar",
      text: `Enviar el presupuesto a ${name}`,
      detail: `${budgetLine(unsent, locale)} · por enviar desde el ${day(unsent.createdAt)}`,
      action: can("budgets.send") ? { label: "Enviar", budgetId: unsent.id } : null,
    }
  }

  // 2. Lo aceptado sin cita: «Reservar cita» con los tratamientos ya puestos.
  const accepted = items.filter((item) => item.decisionStatus === "aceptado" && item.status === "pendiente")
  const toSchedule = accepted.filter((item) => !withAppointment.has(item.id))
  if (toSchedule.length > 0) {
    const decided = budgets
      .filter((budget) => budget.status === "aceptado" || budget.status === "parcial")
      .find((budget) => budget.items.some((line) => toSchedule.some((item) => item.id === line.planItemId)))
    const text = decided
      ? decided.status === "aceptado"
        ? "Aceptó todo: falta su cita"
        : `${decided.stateText}: falta su cita`
      : context.budgetRequired
        ? "Tiene tratamientos aceptados sin cita"
        : // En latidIA lo indicado ya queda aceptado: no hubo nada que aceptar.
          "Falta la cita de lo indicado"
    return {
      kind: "agendar",
      text,
      detail: decided?.decidedAt ? `Respondió el ${day(decided.decidedAt)}` : null,
      action: can("appointments.write")
        ? { label: "Reservar cita", planItemIds: toSchedule.map((item) => item.id), serviceId: toSchedule[0]?.serviceId ?? null }
        : null,
    }
  }

  // 3. Lo que espera respuesta (una sola regla: `budgetAwaitsAnswer`).
  const awaiting = budgets.filter((budget) => budget.awaitsAnswer).at(-1)
  if (awaiting) {
    const sent = awaiting.presentedAt ? `Enviado el ${day(awaiting.presentedAt)}` : null
    return {
      kind: "respuesta",
      text: awaiting.status === "presentado" ? "Enviado · espera respuesta" : "Lo está pensando",
      detail: [budgetLine(awaiting, locale), sent].filter(Boolean).join(" · "),
      action: can("budgets.decide") ? { label: "¿Qué respondió?", budgetId: awaiting.id } : null,
    }
  }

  // 4. Un tratamiento en curso sin cita para su próxima sesión.
  const continuing = items.find(
    (item) =>
      deriveNextAction({ status: item.status, decisionStatus: item.decisionStatus, budgetStatus: "aceptado", openSession: false }) === "continuar" &&
      !withAppointment.has(item.id),
  )
  if (continuing) {
    return {
      kind: "continuar",
      text: `Falta la cita de la próxima sesión: ${continuing.title}`,
      detail: null,
      action: can("appointments.write")
        ? { label: "Reservar cita", planItemIds: [continuing.id], serviceId: continuing.serviceId }
        : null,
    }
  }

  // 5. El próximo control.
  if (control) {
    if (control.status === "pendiente") {
      return {
        kind: "control",
        text: `${control.title} · por reservar`,
        detail: `Desde el ${day(control.dueAt)}`,
        action: can("appointments.write") ? { label: "Reservar cita", followUpId: control.id } : null,
      }
    }
    return { kind: "control", text: `${control.title} · con cita`, detail: null, action: null }
  }
  return { kind: "ninguno", text: "Nada pendiente en el plan", detail: null, action: null }
}

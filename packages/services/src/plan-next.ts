/**
 * «Qué sigue» del plan de una persona (tablero 3 de la fase 3): una frase y un
 * botón que decide el servidor. Es la misma regla para la pestaña Plan, el
 * Resumen, «Te espera» y la línea del Administrador que retoma presupuestos:
 * se apoya en `budgetAwaitsAnswer` (lo que espera respuesta), en
 * `isToSchedule` (lo aceptado sin cita) y en los controles.
 *
 * El orden es fijo y sin puntajes:
 * 1. Un presupuesto armado y sin enviar: «Enviar el presupuesto a Lucía». Si
 *    además un tratamiento empezado no tiene cita para su próxima sesión, el
 *    detalle lo dice.
 * 2. Lo aceptado que aún no tiene cita: «Aceptó 2 de 3: falta su cita». Pero
 *    lo empezado va antes que lo aceptado sin empezar (QA del 8 nov, X5): con
 *    una endodoncia a medias sin cita, «Falta la cita de la próxima sesión»
 *    gana a la corona que va después.
 * 3. Lo que espera respuesta: «Entregado · espera respuesta» o «Lo está pensando».
 * 4. Un tratamiento en curso sin cita para su próxima sesión, o uno que ya
 *    tiene su primera cita y le faltan sesiones por reservar (`canBookAnother`):
 *    «Falta la cita de la próxima sesión: Endodoncia · sesión 2 de 2».
 * 5. El próximo control: «Control de las resinas · por reservar · Toca el 20 nov»,
 *    o «se puede hacer en su cita del 22 nov» si ya tiene una cita que le sirve
 *    (`appointmentServesControl`: desde que abre su ventana hasta 30 días después).
 *
 * `getPlanNextSteps` da además todo eso en una lista, para el Resumen: cada
 * paso en su fila, con el control vencido primero.
 *
 * «Falta su cita» y «por reservar» siguen las reglas de `to-schedule.ts`: lo
 * aceptado sin una cita que lo lleve y el control sin ninguna cita por venir.
 *
 * Recibe `can`: el botón solo se ofrece a quien puede hacerlo. La frase nunca
 * lleva diagnósticos, piezas ni notas: también la lee recepción.
 */
import { formatMoney, moneyTotalsText, sessionWords, showsSession } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { appointment } from "@odentia/db/schema/agenda"
import { user } from "@odentia/db/schema/auth"
import {
  appointmentPlanItem,
  clinicalFollowUp,
  encounter,
  patient,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm"
import { firstName } from "./automation-routing.js"
import { listBudgets, listBudgetsForPatients, valueOptionOf, type BudgetWithTotals } from "./budgets.js"
import { notFound } from "./errors.js"
import { findOrgLocale } from "./locale.js"
import { joinPatientPerson, patientPerson } from "./patient-identity.js"
import { productHooks } from "./products.js"
import {
  appointmentServesControl,
  canBookAnother,
  dayKeyIn,
  isOverdueControl,
  isToSchedule,
  servedToday,
  todayLiveAppointments,
  LIVE_APPOINTMENT_STATUSES,
  type SessionCount,
  sessionCountsOf,
  TO_SCHEDULE_STATUSES,
} from "./to-schedule.js"

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
  /** «Ver la cita»: el control ya tiene la suya. */
  appointmentId?: string
}

export interface PlanNextStep {
  kind: PlanNextKind
  text: string
  detail: string | null
  /** Nulo si el rol no puede hacerlo (la frase igual se dice). */
  action: PlanNextAction | null
  /**
   * Lo aceptado sin empezar que también falta agendar cuando gana la sesión de
   * un tratamiento empezado: el presupuesto del Plan conserva su «Reservar cita».
   * Solo para quien puede reservar.
   */
  alsoToSchedule?: string[]
}

export type Can = (permission: string) => boolean

/** Estados de una cita que todavía va a ocurrir (la misma lista de `to-schedule.ts`). */
const LIVE_APPOINTMENT = [...LIVE_APPOINTMENT_STATUSES]

/** «12 dic»; de otro año, con el año («12 dic 2025»). */
function dayWords(date: Date, locale: string, timeZone: string): string {
  const yearOf = (at: Date) => new Intl.DateTimeFormat("en-CA", { year: "numeric", timeZone }).format(at)
  const otherYear = yearOf(date) !== yearOf(new Date())
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", ...(otherYear ? { year: "numeric" } : {}), timeZone })
    .format(date)
    .replace(".", "")
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

/**
 * El presupuesto armado y sin enviar de la persona, si tiene líneas. Lo que
 * lleva algo de una atención todavía en borrador no está armado: se arma al
 * firmarla (`assembleEncounterBudget`) y, si se anula, se anula con ella. Hasta
 * entonces no se le pide a nadie enviarlo (`openEncounters`: las atenciones en
 * borrador de la persona; la misma regla en SQL en `waitingUnsentBudgets`).
 */
export function unsentBudgetOf(
  budgets: BudgetWithTotals[],
  items: ReadonlyArray<{ id: string; sourceEncounterId: string | null }> = [],
  openEncounters: ReadonlySet<string> = new Set(),
): BudgetWithTotals | null {
  const source = new Map(items.map((item) => [item.id, item.sourceEncounterId]))
  const preparing = (budget: BudgetWithTotals) =>
    budget.items.some((line) => {
      const from = source.get(line.planItemId)
      return !!from && openEncounters.has(from)
    })
  return (
    budgets.find(
      (budget) => budget.status === "borrador" && !budget.supersedesBudgetId && budget.items.length > 0 && !preparing(budget),
    ) ?? null
  )
}

/** Las atenciones en borrador de esas personas: lo que sale de ellas aún se está preparando. */
async function openEncountersOf(tx: Db, orgId: string, patientIds: string[]): Promise<Set<string>> {
  if (patientIds.length === 0) return new Set()
  const rows = await tx
    .select({ id: encounter.id })
    .from(encounter)
    .where(and(eq(encounter.organizationId, orgId), inArray(encounter.patientId, patientIds), eq(encounter.status, "borrador")))
  return new Set(rows.map((row) => row.id))
}

/** «3 tratamientos · S/ 540», con el total de la opción que vale. */
export function budgetLine(budget: BudgetWithTotals, locale: string): string {
  const value = valueOptionOf(budget.options)
  const count = value?.lineCount ?? budget.items.length
  const money = moneyTotalsText(budget.totals, (cents, currency) => formatMoney(cents, currency, locale), "falta algún precio")
  const options = budget.options.length > 1 ? ` · ${budget.options.length} opciones` : ""
  return `${count} ${count === 1 ? "tratamiento" : "tratamientos"} · ${money}${options}`
}

export async function getPlanNextStep(
  tx: Db,
  orgId: string,
  patientId: string,
  can: Can,
): Promise<PlanNextStep> {
  const { facts, context } = await planFactsOf(tx, orgId, patientId)
  return planNextStepFrom(facts, context, can)
}

/**
 * «Qué sigue» del plan (`step`, lo de siempre) y todo lo que sigue en una lista
 * (`steps`, el Resumen), con la misma regla y una sola lectura.
 */
export async function getPlanNextSteps(
  tx: Db,
  orgId: string,
  patientId: string,
  can: Can,
): Promise<{ step: PlanNextStep; steps: PlanNextStep[] }> {
  const { facts, context } = await planFactsOf(tx, orgId, patientId)
  return { step: planNextStepFrom(facts, context, can), steps: planStepsFrom(facts, context, can) }
}

/** Lo de una persona que decide su «Qué sigue». */
async function planFactsOf(tx: Db, orgId: string, patientId: string): Promise<{ facts: PlanFacts; context: PlanContext }> {
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
  const sessions = await sessionCountsOf(tx, orgId, items.filter(mayTakeSessions).map((item) => item.id))
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
  const [next] = await tx
    .select({ id: appointment.id, startsAt: appointment.startsAt })
    .from(appointment)
    .where(
      and(
        eq(appointment.organizationId, orgId),
        eq(appointment.patientId, patientId),
        inArray(appointment.status, LIVE_APPOINTMENT),
        gt(appointment.startsAt, new Date()),
      ),
    )
    .orderBy(asc(appointment.startsAt))
    .limit(1)
  const today = (await todayLiveAppointments(tx, orgId, [patientId], context.timezone)).get(patientId) ?? null
  // Quién indicó el control y cuándo: el profesional y el día de la atención donde nació
  // (no quien lo creó: el que se repite lo crea quien cerró el anterior).
  const [origin] = control?.originEncounterId
    ? await tx
        .select({
          professionalName: user.name,
          at: sql<Date>`coalesce(${encounter.finalizedAt}, ${encounter.startedAt})`.mapWith(encounter.startedAt),
          reason: encounter.reason,
        })
        .from(encounter)
        .leftJoin(user, eq(user.id, encounter.professionalUserId))
        .where(and(eq(encounter.organizationId, orgId), eq(encounter.id, control.originEncounterId)))
        .limit(1)
    : []
  return {
    facts: {
      name: firstName(person),
      budgets,
      items,
      openEncounters: await openEncountersOf(tx, orgId, [patientId]),
      withAppointment,
      sessions,
      control,
      nextAppointmentAt: next?.startsAt ?? null,
      nextAppointmentId: next?.id ?? null,
      today,
      controlOrigin: origin ? { professionalName: origin.professionalName, at: origin.at, reason: origin.reason?.trim() || null } : null,
    },
    context,
  }
}

/**
 * «Qué sigue» de muchos pacientes a la vez (los atajos de Pacientes y su
 * página): lo mismo que `getPlanNextStep` de cada uno, con la misma regla
 * (`planNextStepFrom`) y un puñado de consultas en total, no varias por
 * paciente. Un paciente que no existe no aparece.
 *
 * `prefer`: la lista de Pacientes filtrada por un atajo dice el paso de ese
 * atajo, si lo tiene (QA del 8 nov: filtrada por «Control vencido», la fila
 * decía «Reservar lo aceptado»). Es el mismo paso de la lista de la ficha
 * (`planStepsFrom`); la regla de un solo paso no cambia, ni lo que cuentan los
 * atajos ni lo que lee el agente.
 */
export async function planNextStepsOf(
  tx: Db,
  orgId: string,
  patientIds: string[],
  can: Can,
  prefer: readonly PlanNextKind[] = [],
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
  const sessions = await sessionCountsOf(tx, orgId, items.filter(mayTakeSessions).map((item) => item.id))
  // La próxima cita de cada uno, lleve o no lo aceptado: «falta su cita» no se dice a quien ya tiene una.
  const nextAppointments = await tx
    .selectDistinctOn([appointment.patientId], { patientId: appointment.patientId, id: appointment.id, startsAt: appointment.startsAt })
    .from(appointment)
    .where(
      and(
        eq(appointment.organizationId, orgId),
        inArray(appointment.patientId, ids),
        inArray(appointment.status, LIVE_APPOINTMENT),
        gt(appointment.startsAt, new Date()),
      ),
    )
    .orderBy(appointment.patientId, asc(appointment.startsAt))
  const nextAppointmentOf = new Map(nextAppointments.map((row) => [row.patientId, row]))
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
  const todayOf = await todayLiveAppointments(tx, orgId, ids, context.timezone)
  const openEncounters = await openEncountersOf(tx, orgId, ids)
  for (const person of people) {
    const facts: PlanFacts = {
      name: firstName(person),
      budgets: budgets.get(person.id) ?? [],
      items: itemsOf.get(person.id) ?? [],
      openEncounters,
      withAppointment,
      sessions,
      control: controlOf.get(person.id),
      nextAppointmentAt: nextAppointmentOf.get(person.id)?.startsAt ?? null,
      nextAppointmentId: nextAppointmentOf.get(person.id)?.id ?? null,
      today: todayOf.get(person.id) ?? null,
    }
    const preferred = prefer.length > 0 ? planStepsFrom(facts, context, can).find((step) => prefer.includes(step.kind)) : undefined
    out.set(person.id, preferred ?? planNextStepFrom(facts, context, can))
  }
  return out
}

type PlanItemRow = typeof treatmentPlanItem.$inferSelect
type FollowUpRow = typeof clinicalFollowUp.$inferSelect

/** Lo que puede pedir otra sesión: aceptado, por hacer y de más de una prevista. Solo de esos se cuentan. */
function mayTakeSessions(item: PlanItemRow): boolean {
  return (
    item.decisionStatus === "aceptado" &&
    (TO_SCHEDULE_STATUSES as readonly string[]).includes(item.status) &&
    item.plannedSessions > 1
  )
}

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
  /** Sus atenciones en borrador: su presupuesto aún se está preparando (`unsentBudgetOf`). */
  openEncounters?: ReadonlySet<string>
  withAppointment: Set<string>
  /** Sesiones hechas y en pie de lo que puede pedir otra (`sessionCountsOf`). */
  sessions: Map<string, SessionCount>
  control: FollowUpRow | undefined
  /** Su próxima cita, aunque no lleve lo aceptado. */
  nextAppointmentAt?: Date | null
  nextAppointmentId?: string | null
  /** Su primera cita viva de hoy (por venir, en la sala o en atención). */
  today?: { id: string; startsAt: Date } | null
  /** La atención donde se indicó el control: quién, cuándo y su motivo. Solo de una persona. */
  controlOrigin?: { professionalName: string | null; at: Date; reason: string | null } | null
}

/** Sin nada que hacer en el plan. */
const NOTHING: PlanNextStep = { kind: "ninguno", text: "Nada pendiente en el plan", detail: null, action: null }

/**
 * Las piezas de la regla: qué toca de cada clase y la frase de cada una, sin
 * decidir el orden. `planNextStepFrom` elige la primera, como siempre, y
 * `planStepsFrom` las pone todas en una lista; las dos con estas mismas piezas.
 */
function planPieces(facts: PlanFacts, context: PlanContext, can: Can) {
  const { name, budgets, items, withAppointment, sessions, control, nextAppointmentAt, nextAppointmentId, today, controlOrigin } = facts
  const { locale, timezone } = context
  const day = (date: Date) => dayWords(date, locale, timezone)
  const dayKey = (date: Date) => dayKeyIn(date, timezone)
  // Quien no ve la agenda (caja) no recibe fechas de citas ni el control (QA del 8 nov).
  const seesAgenda = can("appointments.read") || can("clinical.read")
  // Lo aceptado sin una cita por venir que lo lleve (la regla de «Por agendar»).
  const toSchedule = items.filter((item) => isToSchedule(item, withAppointment))

  const countOf = (item: PlanItemRow) => sessions.get(item.id) ?? { done: 0, booked: 0 }
  // Un tratamiento empezado y sin una cita por venir que lo lleve: le falta la cita de su próxima sesión.
  const started = items.find((item) => item.status === "en_curso" && isToSchedule(item, withAppointment))
  // El que pasa adelante es el que de verdad tiene una sesión por reservar (`canBookAnother`, la
  // regla de la firma): uno que ya llegó a sus previstas y quedó abierto sigue en el paso 4.
  const startedFirst = items.find(
    (item) =>
      item.status === "en_curso" &&
      isToSchedule(item, withAppointment) &&
      sessions.has(item.id) &&
      canBookAnother(item, countOf(item)),
  )
  const notStarted = (item: PlanItemRow) => item.status === "pendiente" || item.status === "programado"
  const accepted = items.filter((item) => item.decisionStatus === "aceptado" && notStarted(item))
  const toStart = toSchedule.filter(notStarted)
  const awaiting = budgets.filter((budget) => budget.awaitsAnswer).at(-1) ?? null
  // Un tratamiento en curso sin cita para su próxima sesión, o uno que ya tiene
  // su primera cita (o sesión) y le faltan otras por reservar.
  const continuing =
    started ?? items.find((item) => canBookAnother(item, countOf(item)) && countOf(item).done + countOf(item).booked > 0) ?? null
  // Para la lista, todos los que siguen así, sin lo que ya va en «lo aceptado sin cita»: el
  // mismo tratamiento no sale dos veces (uno ya empezado, con su cita de hoy pasada, también
  // queda «por agendar»).
  const allContinuing = items.filter(
    (item) =>
      !toStart.some((other) => other.id === item.id) &&
      ((item.status === "en_curso" && isToSchedule(item, withAppointment)) ||
        (canBookAnother(item, countOf(item)) && countOf(item).done + countOf(item).booked > 0)),
  )

  /** «Falta la cita de la próxima sesión: Endodoncia · sesión 2 de 2», con «Reservar la sesión 2». */
  const continueStep = (item: PlanItemRow): PlanNextStep => {
    const n = countOf(item).done + countOf(item).booked + 1
    const numbered = showsSession(n, item.plannedSessions)
    const session = numbered ? ` · ${sessionWords(n, item.plannedSessions)}` : ""
    return {
      kind: "continuar",
      text: `Falta la cita de la próxima sesión: ${item.title}${session}`,
      detail: null,
      // El botón dice qué reserva (QA del 8 nov): «Reservar la sesión 2», como al firmar.
      action: can("appointments.write")
        ? { label: numbered ? `Reservar la sesión ${n}` : "Reservar la próxima sesión", planItemIds: [item.id], serviceId: item.serviceId }
        : null,
    }
  }

  /** 1. Armado y sin enviar: lo envía recepción (decisión 4). */
  const sendStep = (budget: BudgetWithTotals): PlanNextStep => ({
    kind: "enviar",
    text: `Enviar el presupuesto a ${name}`,
    detail: `${budgetLine(budget, locale)} · por enviar desde el ${day(budget.createdAt)}`,
    action: can("budgets.send") ? { label: "Enviar", budgetId: budget.id } : null,
  })

  /** 2. Lo aceptado sin cita: «Reservar cita» con los tratamientos ya puestos, y cuáles son. */
  const scheduleStep = (): PlanNextStep => {
    const decided = budgets
      .filter((budget) => budget.status === "aceptado" || budget.status === "parcial")
      .find((budget) => budget.items.some((line) => toStart.some((item) => item.id === line.planItemId)))
    // Ya tiene una cita que no lo lleva: se dice así, no «falta su cita», que suena a que no tiene ninguna.
    // Si una parte ya tiene cita, se dice que falta el resto. A quien no ve la agenda, sin su fecha.
    const partly = toStart.length < accepted.length
    const yourAppointment = (date: Date) => (seesAgenda ? `su cita del ${day(date)}` : "su próxima cita")
    const missing = nextAppointmentAt ? `${yourAppointment(nextAppointmentAt)} no lo lleva${partly ? " todo" : ""}` : "falta su cita"
    const text = decided
      ? decided.status === "aceptado"
        ? `Aceptó todo: ${missing}`
        : `${decided.stateText}: ${missing}`
      : context.budgetRequired
        ? nextAppointmentAt
          ? `Tiene tratamientos aceptados que ${yourAppointment(nextAppointmentAt)} no lleva`
          : "Tiene tratamientos aceptados sin cita"
        : // En latidIA lo indicado ya queda aceptado: no hubo nada que aceptar.
          nextAppointmentAt
          ? `${partly ? "Parte de lo indicado" : "Lo indicado"} no va en ${yourAppointment(nextAppointmentAt)}`
          : "Falta la cita de lo indicado"
    // Qué falta, con sus nombres (QA del 8 nov: «Aceptó todo: falta su cita» no decía qué).
    const titles = toStart.map((item) => item.title)
    const named = titles.length > 3 ? `${titles.slice(0, 3).join(", ")} y ${titles.length - 3} más` : titles.join(", ")
    return {
      kind: "agendar",
      text,
      detail: [named || null, decided?.decidedAt ? `respondió el ${day(decided.decidedAt)}` : null].filter(Boolean).join(" · ") || null,
      // Dice qué reserva: «Reservar cita» a secas es el de la cabecera (segunda mesa del 8 nov).
      action: can("appointments.write")
        ? {
            label: context.budgetRequired ? "Reservar lo aceptado" : "Reservar lo indicado",
            planItemIds: toStart.map((item) => item.id),
            serviceId: toStart[0]?.serviceId ?? null,
          }
        : null,
    }
  }

  /** 3. Lo que espera respuesta (una sola regla: `budgetAwaitsAnswer`). */
  const answerStep = (budget: BudgetWithTotals): PlanNextStep => ({
    kind: "respuesta",
    text: budget.status === "presentado" ? "Entregado · espera respuesta" : "Lo está pensando",
    detail: [budgetLine(budget, locale), budget.presentedAt ? `Entregado el ${day(budget.presentedAt)}` : null].filter(Boolean).join(" · "),
    action: can("budgets.decide") ? { label: "¿Qué respondió?", budgetId: budget.id } : null,
  })

  /**
   * 5. El próximo control, con quién lo indicó y cuándo (QA del 8 nov: no decía
   * para qué era). Vencido sin cita: `overdue`, que la lista pone primero.
   */
  const controlStep = (): (PlanNextStep & { overdue: boolean }) | null => {
    if (!control || !seesAgenda) return null
    const due = `${dayKey(control.dueAt) < dayKey(new Date()) ? "Tocaba el" : "Toca el"} ${day(control.dueAt)}`
    const origin = controlOrigin ?? null
    const why =
      control.repeatsFromId && control.repeatEveryMonths
        ? `se repite cada ${control.repeatEveryMonths === 1 ? "mes" : `${control.repeatEveryMonths} meses`}`
        : origin
          ? [
              `lo indicó ${origin.professionalName ?? "alguien que ya no está en el equipo"} el ${day(origin.at)}`,
              // El motivo de esa atención, solo a quien lee la historia.
              origin.reason && can("clinical.read") ? `en la atención por «${origin.reason}»` : null,
            ]
              .filter(Boolean)
              .join(" ")
          : null
    const detail = (...parts: Array<string | null>) => [...parts, why].filter(Boolean).join(" · ")
    // Hoy tiene una cita viva desde que abrió su ventana: al firmar esa atención se cumple
    // (`servedToday`), aunque ya esté en la sala y la hora de la cita haya pasado.
    if (today && servedToday(control, today.startsAt, timezone)) {
      return {
        kind: "control",
        overdue: false,
        text: `${control.title} · se cumple con su atención de hoy`,
        detail: detail(due),
        action: can("appointments.read") ? { label: "Ver la cita", appointmentId: today.id } : null,
      }
    }
    // A un control le sirve una visita desde que abre su ventana hasta 30 días después de su
    // fecha (ADR 0152): con esa cita por venir no está «por reservar», pero no es su cita
    // propia; quien firma esa atención marca si se hizo.
    if (control.status === "pendiente" && nextAppointmentAt && appointmentServesControl(control, nextAppointmentAt, timezone)) {
      return {
        kind: "control",
        overdue: false,
        text: `${control.title} · se puede hacer en su cita del ${day(nextAppointmentAt)}`,
        detail: detail(due, "sin cita propia"),
        action: nextAppointmentId && can("appointments.read") ? { label: "Ver la cita", appointmentId: nextAppointmentId } : null,
      }
    }
    if (control.status === "pendiente") {
      // Vencido sin cita (la regla de «Control vencido», `isOverdueControl`).
      const overdue = isOverdueControl(control, nextAppointmentAt ?? null, timezone)
      return {
        kind: "control",
        overdue,
        text: `${control.title} · ${overdue ? "vencido" : "por reservar"}`,
        // «Vencido» ya dice que no tiene ninguna cita por venir: no se repite.
        detail: detail(due),
        action: can("appointments.write") ? { label: "Reservar el control", followUpId: control.id } : null,
      }
    }
    return {
      kind: "control",
      overdue: false,
      text: `${control.title} · con cita`,
      detail: detail(due),
      action: control.appointmentId && can("appointments.read") ? { label: "Ver la cita", appointmentId: control.appointmentId } : null,
    }
  }

  return {
    unsent: unsentBudgetOf(budgets, facts.items, facts.openEncounters),
    startedFirst,
    toStart,
    awaiting,
    continuing,
    allContinuing,
    continueStep,
    sendStep,
    scheduleStep,
    answerStep,
    controlStep,
  }
}

/** Una fila sin lo que la regla usa por dentro. */
function bare(step: PlanNextStep & { overdue?: boolean }): PlanNextStep {
  const { overdue: _overdue, ...rest } = step
  return rest
}

/** La regla de «Qué sigue», en el orden fijo de arriba. Sin consultas: decide con lo cargado. */
function planNextStepFrom(facts: PlanFacts, context: PlanContext, can: Can): PlanNextStep {
  const p = planPieces(facts, context, can)
  const alsoSession = p.startedFirst ? `también falta la cita de la próxima sesión de ${p.startedFirst.title}` : null

  // 1. Armado y sin enviar. Sigue primero (es su atajo en Pacientes), pero no esconde la
  // sesión que falta reservar.
  if (p.unsent) {
    const step = p.sendStep(p.unsent)
    return alsoSession ? { ...step, detail: `${step.detail} · ${alsoSession}` } : step
  }
  // 2. Lo empezado antes que lo aceptado sin empezar: la sesión 2 de la endodoncia antes que la corona.
  // Lo aceptado sigue «por agendar» y el presupuesto del Plan conserva su «Reservar cita».
  if (p.toStart.length > 0 && p.startedFirst)
    return {
      ...p.continueStep(p.startedFirst),
      detail: "También falta la cita de lo aceptado sin empezar",
      ...(can("appointments.write") ? { alsoToSchedule: p.toStart.map((item) => item.id) } : {}),
    }
  if (p.toStart.length > 0) return p.scheduleStep()
  // 3. Lo que espera respuesta.
  if (p.awaiting) {
    const step = p.answerStep(p.awaiting)
    return alsoSession ? { ...step, detail: `${step.detail} · ${alsoSession}` } : step
  }
  // 4. La próxima sesión de lo que sigue en curso.
  if (p.continuing) return p.continueStep(p.continuing)
  // 5. El próximo control.
  const control = p.controlStep()
  return control ? bare(control) : NOTHING
}

/**
 * Todo lo que sigue, en una lista (QA del 8 nov, propuesta 5): las mismas
 * piezas y el mismo orden de la regla, cada una en su fila y sin repetir en el
 * detalle lo que ya dice otra. Lo único que cambia de lugar es el control
 * vencido sin cita: va primero, como iba lo vencido en «Pendientes». Sin nada,
 * la lista va vacía.
 */
function planStepsFrom(facts: PlanFacts, context: PlanContext, can: Can): PlanNextStep[] {
  const p = planPieces(facts, context, can)
  const steps: PlanNextStep[] = []
  if (p.unsent) steps.push(p.sendStep(p.unsent))
  const sessionFirst = p.toStart.length > 0 ? p.startedFirst : undefined
  if (sessionFirst) steps.push(p.continueStep(sessionFirst))
  if (p.toStart.length > 0) steps.push(p.scheduleStep())
  if (p.awaiting) steps.push(p.answerStep(p.awaiting))
  // Cada tratamiento que sigue en curso, una vez: primero el de la regla, después los demás.
  const ordered = p.continuing ? [p.continuing, ...p.allContinuing.filter((item) => item.id !== p.continuing?.id)] : p.allContinuing
  for (const item of ordered) {
    if (item.id === sessionFirst?.id || p.toStart.some((other) => other.id === item.id)) continue
    steps.push(p.continueStep(item))
  }
  const control = p.controlStep()
  if (control) {
    if (control.overdue) steps.unshift(bare(control))
    else steps.push(bare(control))
  }
  return steps
}

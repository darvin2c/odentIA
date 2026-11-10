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
import { OPEN_LINE_DECISIONS } from "./budget-awaiting.js"
import { BUDGET_CALLBACK_KEY } from "./budget-callback.js"
import {
  type BudgetWithTotals,
  listBudgets,
  listBudgetsForPatients,
  valueOptionOf,
} from "./budgets.js"
import { notFound } from "./errors.js"
import { findOrgLocale } from "./locale.js"
import { joinPatientPerson, patientPerson } from "./patient-identity.js"
import { productHooks } from "./products.js"
import { nextSessionFromOf, SESSION_GAP_NOTE } from "./session-gap.js"
import {
  appointmentServesControl,
  canBookAnother,
  controlWindowStart,
  dayKeyIn,
  isControlWindowOpen,
  isOverdueControl,
  isToSchedule,
  LIVE_APPOINTMENT_STATUSES,
  pairsWithAccepted,
  type SessionCount,
  servedToday,
  sessionCountsOf,
  TO_SCHEDULE_STATUSES,
  todayLiveAppointments,
  waitingFor,
} from "./to-schedule.js"

/**
 * `cerrar`: una cita de un día que ya pasó y que nadie cerró (sin llegada ni atención): solo en la
 * lista de la ficha (`getPlanNextSteps`), con «¿Vino?», que abre la cita para registrar la atención
 * o decir que no vino. La frase única y la fila de Pacientes no la dicen.
 */
export type PlanNextKind =
  | "enviar"
  | "agendar"
  | "respuesta"
  | "continuar"
  | "reservado"
  | "control"
  | "cerrar"
  | "sin_objeto"
  | "suspendido"
  | "ninguno"

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
  /** Varios controles en la misma cita (lo aceptado y el control de su tratamiento). */
  followUpIds?: string[]
  /**
   * El día (`YYYY-MM-DD`, en la zona de la clínica) desde el que se busca hora: lo que va después
   * de otro tratamiento de la misma pieza, o el control que todavía no se puede hacer.
   */
  date?: string
  /** Por qué se busca desde ese día, para el cajón de la reserva. */
  note?: string
  /**
   * «Sumar a su cita del 10 nov»: lo aceptado se suma a la cita que ya tiene, sin otra visita
   * (QA de la ficha del 9 nov). El botón principal pasa a ser «Otra cita».
   */
  join?: { appointmentId: string; label: string }
  /** La cita sin objeto: su versión, para usarla o liberarla sin pisar otro cambio. */
  appointmentVersion?: number
  /** «Usarla para la exodoncia»: lo aceptado que falta reservar y podría ir en esa cita. */
  reuse?: { planItemId: string; title: string }
}

export interface PlanNextStep {
  kind: PlanNextKind
  text: string
  detail: string | null
  /** Nulo si el rol no puede hacerlo (la frase igual se dice). */
  action: PlanNextAction | null
  /** Un aviso que no frena, en su propio renglón (la cita que se atendió sin registrar lo hecho). */
  notice?: string | null
  /**
   * Lo aceptado sin empezar que también falta agendar cuando gana la sesión de
   * un tratamiento empezado, para quien solo lee esta frase (el agente, Pacientes): la lista
   * de la ficha y del Plan lo ofrece en su propia fila.
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

/**
 * Las atenciones en borrador de esas personas: lo que sale de ellas aún se
 * está preparando. Menos las que lleva quien mira (`viewerUserId`): para él, lo
 * que arma en su consulta ya se puede mostrar o enviar.
 */
async function openEncountersOf(tx: Db, orgId: string, patientIds: string[], viewerUserId?: string): Promise<Set<string>> {
  if (patientIds.length === 0) return new Set()
  const rows = await tx
    .select({ id: encounter.id, professionalUserId: encounter.professionalUserId })
    .from(encounter)
    .where(and(eq(encounter.organizationId, orgId), inArray(encounter.patientId, patientIds), eq(encounter.status, "borrador")))
  return new Set(rows.filter((row) => !viewerUserId || row.professionalUserId !== viewerUserId).map((row) => row.id))
}

/**
 * El presupuesto en una línea honesta. Con una opción: «3 tratamientos · S/ 540».
 * Con varias, cada una con su total, que nunca se suman: «Opción A S/ 1,350 ·
 * Opción B S/ 150 · falta que elija»; con una elegida, «Eligió la opción A · S/
 * 1,350» (QA de la atención del 8 nov: decía «2 tratamientos · S/ 1,350 · 2
 * opciones» con tres indicados y dos montos).
 */
export function budgetLine(budget: BudgetWithTotals, locale: string, names?: string): string {
  const say = (totals: BudgetWithTotals["totals"]) =>
    moneyTotalsText(
      totals,
      (cents, currency) => formatMoney(cents, currency, locale),
      "falta algún precio",
    )
  if (budget.options.length > 1) {
    const ordered = [...budget.options].sort((a, b) => a.position - b.position)
    const chosen = ordered.find((option) => option.decision === "elegida")
    if (chosen)
      return `Eligió la ${chosen.label.charAt(0).toLowerCase()}${chosen.label.slice(1)} · ${say(chosen.totals)}`
    return `${ordered.map((option) => `${option.label} ${say(option.totals)}`).join(" · ")} · falta que elija`
  }
  // Con sus nombres, si quien llama los tiene: «Resina y Corona · S/ 1,080» (QA de la ficha del 9 nov).
  if (names) return `${names} · ${say(budget.totals)}`
  const value = valueOptionOf(budget.options)
  const count = value?.lineCount ?? budget.items.length
  return `${count} ${count === 1 ? "tratamiento" : "tratamientos"} · ${say(budget.totals)}`
}

/**
 * Las líneas que todavía esperan respuesta cuando ya respondió una parte (aceptó la
 * resina y dejó la profilaxis para después): las de la opción que vale con la misma
 * regla que `budgetAwaitsAnswer` (`OPEN_LINE_DECISIONS`). `null` si nada se respondió
 * todavía: entonces se habla del presupuesto entero.
 */
export function awaitingLines(
  budget: Pick<BudgetWithTotals, "items" | "options">,
): BudgetWithTotals["items"] | null {
  const value = budget.options.length > 1 ? valueOptionOf(budget.options) : null
  const lines = value ? budget.items.filter((line) => line.optionId === value.id) : budget.items
  const open = lines.filter((line) =>
    (OPEN_LINE_DECISIONS as readonly string[]).includes(line.decision),
  )
  return open.length > 0 && open.length < lines.length ? open : null
}

/** «Profilaxis · S/ 120.00»: lo que espera respuesta con lo que suma, por moneda. */
export function awaitingLinesText(
  lines: BudgetWithTotals["items"],
  locale: string,
  names: string,
): string {
  const currencies = [...new Set(lines.map((line) => line.currency))].sort()
  const totals = currencies.map((currency) => {
    const own = lines.filter((line) => line.currency === currency)
    return {
      currency,
      totalCents: own.some((line) => line.lineTotalCents == null)
        ? null
        : own.reduce((sum, line) => sum + (line.lineTotalCents ?? 0), 0),
    }
  })
  const amount = moneyTotalsText(
    totals,
    (cents, currency) => formatMoney(cents, currency, locale),
    "falta algún precio",
  )
  const what = names || `${lines.length} ${lines.length === 1 ? "tratamiento" : "tratamientos"}`
  return `${what} · ${amount}`
}

/**
 * `viewerUserId`: quien mira. El presupuesto que se prepara en una atención en
 * borrador solo se le ofrece enviar a quien la lleva (lo muestra o lo envía en
 * plena consulta); a los demás, recién al firmarla (`unsentBudgetOf`).
 */
export async function getPlanNextStep(
  tx: Db,
  orgId: string,
  patientId: string,
  can: Can,
  opts: { viewerUserId?: string } = {},
): Promise<PlanNextStep> {
  const { facts, context } = await planFactsOf(tx, orgId, patientId, opts.viewerUserId, { list: false })
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
  opts: { viewerUserId?: string } = {},
): Promise<{ step: PlanNextStep; steps: PlanNextStep[] }> {
  const { facts, context } = await planFactsOf(tx, orgId, patientId, opts.viewerUserId)
  return { step: planNextStepFrom(facts, context, can), steps: planStepsFrom(facts, context, can) }
}

/** Lo de una persona que decide su «Qué sigue». */
async function planFactsOf(
  tx: Db,
  orgId: string,
  patientId: string,
  viewerUserId?: string,
  opts: { list?: boolean } = {},
): Promise<{ facts: PlanFacts; context: PlanContext }> {
  // Lo que solo dice la lista de la ficha (la cita sin cerrar y lo atendido sin registrar).
  const forList = opts.list ?? true
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
  // Todos sus controles abiertos: el de un tratamiento va primero y el otro, con lo aceptado.
  const controls = await tx
    .select()
    .from(clinicalFollowUp)
    .where(
      and(
        eq(clinicalFollowUp.organizationId, orgId),
        eq(clinicalFollowUp.patientId, patientId),
        inArray(clinicalFollowUp.status, ["pendiente", "programado"]),
      ),
    )
    .orderBy(sql`${clinicalFollowUp.status} = 'pendiente' desc`, asc(clinicalFollowUp.dueAt), asc(clinicalFollowUp.id))
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
  // Sus citas de días que ya pasaron sin que nadie dijera si vino (la regla de «Te espera» y de la
  // Agenda, «Ya pasaron · sin cerrar»), y lo aceptado cuya cita se atendió sin registrar lo hecho.
  const unclosed = !forList ? [] : await tx.execute<{ id: string; startsAt: Date; serviceName: string | null; professionalName: string | null }>(sql`
    select a.id, a.starts_at as "startsAt", a.service_name as "serviceName", u.name as "professionalName"
    from appointment a
    left join branch b on b.id = a.branch_id and b.organization_id = a.organization_id
    left join "user" u on u.id = a.professional_user_id
    where a.organization_id = ${orgId} and a.patient_id = ${patientId}::uuid and not a.is_test
      and a.status in ('programada', 'confirmada') and a.arrived_at is null
      and (a.starts_at at time zone coalesce(b.timezone, ${context.timezone}))::date < (now() at time zone coalesce(b.timezone, ${context.timezone}))::date
      and not exists (select 1 from encounter e where e.organization_id = a.organization_id and e.appointment_id = a.id and e.status <> 'anulada')
    order by a.starts_at desc, a.id limit 3`)
  // La última cita que llevaba cada tratamiento aceptado sin empezar: si se atendió, lo hecho no
  // se registró (registrarlo lo deja en curso). Solo una cita reservada para él antes de ocurrir.
  const attended = !forList ? [] : (
    await tx.execute<{ planItemId: string; startsAt: Date; status: string; professionalUserId: string; professionalName: string | null }>(sql`
    select distinct on (link.plan_item_id) link.plan_item_id as "planItemId", a.starts_at as "startsAt", a.status,
      a.professional_user_id as "professionalUserId", u.name as "professionalName"
    from appointment_plan_item link
    join appointment a on a.organization_id = link.organization_id and a.id = link.appointment_id
    join treatment_plan_item item on item.organization_id = link.organization_id and item.id = link.plan_item_id
    left join "user" u on u.id = a.professional_user_id
    where link.organization_id = ${orgId} and link.patient_id = ${patientId}::uuid and not a.is_test
      and link.created_at <= a.starts_at
      and item.status in ('pendiente', 'programado', 'en_curso') and item.decision_status = 'aceptado'
      -- Con una atención firmada en esa cita, lo que se hizo (o no) quedó registrado: decir que no se
      -- registró nombraba a otro doctor en el «lo piensa» (QA del 10 nov, B1). Queda la cita cerrada
      -- con «Vino» (M4: la sesión 2 de la endodoncia).
      and not exists (select 1 from encounter signed where signed.organization_id = a.organization_id
        and signed.appointment_id = a.id and signed.status = 'finalizada')
      -- Y nada de ese tratamiento se registró desde ese día.
      and not exists (select 1 from encounter_procedure proc
        join encounter done on done.organization_id = proc.organization_id and done.id = proc.encounter_id
        where proc.organization_id = item.organization_id and proc.plan_item_id = item.id
          and proc.voided_at is null and done.status <> 'anulada'
          and done.started_at >= a.starts_at - interval '12 hours')
    order by link.plan_item_id, a.starts_at desc`)
  ).filter((row) => row.status === "atendida" && new Date(row.startsAt).getTime() < Date.now())
  // Quién indicó cada control y cuándo: el profesional y el día de la atención donde nació
  // (no quien lo creó: el que se repite lo crea quien cerró el anterior).
  const originIds = [...new Set(controls.map((row) => row.originEncounterId).filter((id): id is string => !!id))]
  const origins =
    originIds.length > 0
      ? await tx
          .select({
            id: encounter.id,
            professionalName: user.name,
            at: sql<Date>`coalesce(${encounter.finalizedAt}, ${encounter.startedAt})`.mapWith(encounter.startedAt),
            reason: encounter.reason,
          })
          .from(encounter)
          .leftJoin(user, eq(user.id, encounter.professionalUserId))
          .where(and(eq(encounter.organizationId, orgId), inArray(encounter.id, originIds)))
      : []
  const originOf = new Map(origins.map((row) => [row.id, row]))
  // «No contesta · volver a llamar»: la tarea abierta de cada presupuesto (`budget-callback.ts`).
  const callbacks = await tx.execute<{ key: string; dueAt: Date | null; reason: string | null }>(sql`
    select idempotency_key as key, due_at as "dueAt", reason from task
    where organization_id = ${orgId} and patient_id = ${patientId}::uuid and status = 'open'
      and idempotency_key like ${`${BUDGET_CALLBACK_KEY}%`}`)
  const freed = !forList
    ? []
    : await (await import("./appointments.js")).freedAppointmentsOf(tx, orgId, patientId, null)
  return {
    facts: {
      name: firstName(person),
      freed,
      budgets,
      items,
      openEncounters: await openEncountersOf(tx, orgId, [patientId], viewerUserId),
      withAppointment,
      sessions,
      controls,
      carriedAt: await carriedAtOf(tx, orgId, [patientId]),
      sessionFrom: await nextSessionFromOf(tx, orgId, items.filter((item) => item.status === "en_curso").map((item) => item.id)),
      callbacks: new Map(
        callbacks.map((row) => [
          row.key.slice(BUDGET_CALLBACK_KEY.length),
          { said: row.reason, dueAt: row.dueAt ? new Date(row.dueAt) : null },
        ]),
      ),
      nextAppointmentAt: next?.startsAt ?? null,
      nextAppointmentId: next?.id ?? null,
      today,
      unclosed: unclosed.map((row) => ({ ...row, startsAt: new Date(row.startsAt) })),
      unrecorded: new Map(
        attended.map((row) => [
          row.planItemId,
          { startsAt: new Date(row.startsAt), professionalName: row.professionalName, mine: !!viewerUserId && row.professionalUserId === viewerUserId },
        ]),
      ),
      controlOrigins: new Map(
        controls.flatMap((row) => {
          const origin = row.originEncounterId ? originOf.get(row.originEncounterId) : undefined
          return origin
            ? [[row.id, { professionalName: origin.professionalName, at: origin.at, reason: origin.reason?.trim() || null }] as const]
            : []
        }),
      ),
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
  const { context, facts } = await planFactsMany(tx, orgId, patientIds)
  for (const [patientId, one] of facts) {
    const preferred = prefer.length > 0 ? planStepsFrom(one, context, can).find((step) => prefer.includes(step.kind)) : undefined
    out.set(patientId, preferred ?? planNextStepFrom(one, context, can))
  }
  return out
}

/**
 * Toda la lista de «Qué sigue» de muchos pacientes a la vez, con la misma regla
 * (`planStepsFrom`): los atajos de presupuestos de Pacientes cuentan a quien
 * tiene ese paso en cualquier fila, no solo en la primera (QA del 8 nov,
 * entrega 3: un control de un tratamiento que va primero no saca a nadie del
 * atajo «Presupuesto sin enviar»).
 */
export async function planStepListsOf(
  tx: Db,
  orgId: string,
  patientIds: string[],
  can: Can,
): Promise<Map<string, PlanNextStep[]>> {
  const { context, facts } = await planFactsMany(tx, orgId, patientIds)
  return new Map([...facts].map(([patientId, one]) => [patientId, planStepsFrom(one, context, can)]))
}

/** Lo de muchos pacientes que decide su «Qué sigue», con un puñado de consultas en total. */
async function planFactsMany(
  tx: Db,
  orgId: string,
  patientIds: string[],
): Promise<{ context: PlanContext; facts: Map<string, PlanFacts> }> {
  const out = new Map<string, PlanFacts>()
  const empty = { context: { locale: "", timezone: "UTC", budgetRequired: true }, facts: out }
  if (patientIds.length === 0) return empty
  const people = await tx
    .select({ id: patient.id, givenNames: patientPerson.givenNames, displayName: patientPerson.displayName })
    .from(patient)
    .innerJoin(patientPerson, joinPatientPerson(patientPerson))
    .where(and(eq(patient.organizationId, orgId), inArray(patient.id, patientIds)))
  if (people.length === 0) return empty
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
  // Los controles abiertos de cada uno, con el mismo orden que los de uno solo.
  const controls = await tx
    .select()
    .from(clinicalFollowUp)
    .where(
      and(
        eq(clinicalFollowUp.organizationId, orgId),
        inArray(clinicalFollowUp.patientId, ids),
        inArray(clinicalFollowUp.status, ["pendiente", "programado"]),
      ),
    )
    .orderBy(clinicalFollowUp.patientId, sql`${clinicalFollowUp.status} = 'pendiente' desc`, asc(clinicalFollowUp.dueAt), asc(clinicalFollowUp.id))
  const itemsOf = new Map<string, PlanItemRow[]>()
  for (const item of items) {
    const list = itemsOf.get(item.patientId) ?? []
    list.push(item)
    itemsOf.set(item.patientId, list)
  }
  const controlsOf = new Map<string, FollowUpRow[]>()
  for (const row of controls) controlsOf.set(row.patientId, [...(controlsOf.get(row.patientId) ?? []), row])
  const todayOf = await todayLiveAppointments(tx, orgId, ids, context.timezone)
  const openEncounters = await openEncountersOf(tx, orgId, ids)
  const carriedAt = await carriedAtOf(tx, orgId, ids)
  const sessionFrom = await nextSessionFromOf(
    tx,
    orgId,
    [...itemsOf.values()].flat().filter((item) => item.status === "en_curso").map((item) => item.id),
  )
  // «No contesta · volver a llamar» de cada uno: la fila de Pacientes dice lo mismo que la ficha.
  const callbackRows = await tx.execute<{ patientId: string; key: string; dueAt: Date | null; reason: string | null }>(sql`
    select patient_id as "patientId", idempotency_key as key, due_at as "dueAt", reason from task
    where organization_id = ${orgId} and status = 'open' and idempotency_key like ${`${BUDGET_CALLBACK_KEY}%`}
      and patient_id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`)
  const callbacksOf = new Map<string, Map<string, { said: string | null; dueAt: Date | null }>>()
  for (const row of callbackRows) {
    const map = callbacksOf.get(row.patientId) ?? new Map()
    map.set(row.key.slice(BUDGET_CALLBACK_KEY.length), { said: row.reason, dueAt: row.dueAt ? new Date(row.dueAt) : null })
    callbacksOf.set(row.patientId, map)
  }
  for (const person of people) {
    const facts: PlanFacts = {
      name: firstName(person),
      budgets: budgets.get(person.id) ?? [],
      items: itemsOf.get(person.id) ?? [],
      openEncounters,
      withAppointment,
      sessions,
      carriedAt,
      sessionFrom,
      callbacks: callbacksOf.get(person.id),
      controls: controlsOf.get(person.id) ?? [],
      nextAppointmentAt: nextAppointmentOf.get(person.id)?.startsAt ?? null,
      nextAppointmentId: nextAppointmentOf.get(person.id)?.id ?? null,
      today: todayOf.get(person.id) ?? null,
    }
    out.set(person.id, facts)
  }
  return { context, facts: out }
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

/**
 * Lo de la clínica que necesita la frase: formato de fechas, si su producto pide presupuesto y
 * las fases de su plan, en el orden en que se hacen (lo que va después en la misma pieza).
 */
interface PlanContext {
  locale: string
  timezone: string
  budgetRequired: boolean
  phases?: readonly string[]
}

async function planContext(tx: Db, orgId: string): Promise<PlanContext> {
  const { locale, timezone } = await findOrgLocale(tx, orgId)
  const hooks = await productHooks(tx, orgId)
  return { locale, timezone, budgetRequired: hooks.budgetRequired, phases: hooks.planPhases }
}

/** La próxima cita por venir que lleva cada tratamiento. */
export async function carriedAtOf(tx: Db, orgId: string, patientIds: string[]): Promise<Map<string, Date>> {
  if (patientIds.length === 0) return new Map()
  const rows = await tx
    .select({ planItemId: appointmentPlanItem.planItemId, startsAt: appointment.startsAt })
    .from(appointmentPlanItem)
    .innerJoin(
      appointment,
      and(eq(appointment.id, appointmentPlanItem.appointmentId), eq(appointment.organizationId, appointmentPlanItem.organizationId)),
    )
    .where(
      and(
        eq(appointmentPlanItem.organizationId, orgId),
        inArray(appointmentPlanItem.patientId, patientIds),
        inArray(appointment.status, LIVE_APPOINTMENT),
        gt(appointment.startsAt, new Date()),
      ),
    )
  const out = new Map<string, Date>()
  for (const row of rows) {
    const known = out.get(row.planItemId)
    if (!known || row.startsAt < known) out.set(row.planItemId, row.startsAt)
  }
  return out
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
  /** Sus controles abiertos (pendientes primero, por fecha). */
  controls: FollowUpRow[]
  /** Su próxima cita, aunque no lleve lo aceptado. */
  nextAppointmentAt?: Date | null
  nextAppointmentId?: string | null
  /** Su primera cita viva de hoy (por venir, en la sala o en atención). */
  today?: { id: string; startsAt: Date } | null
  /** Sus citas de días pasados que nadie cerró, la más reciente primero. Solo de una persona. */
  unclosed?: Array<{ id: string; startsAt: Date; serviceName: string | null; professionalName: string | null }>
  /**
   * Lo aceptado sin empezar cuya cita ya se atendió sin registrar lo que se hizo: sigue
   * por agendar (la regla es una, `to-schedule.ts`), pero la fila lo avisa. Solo de una persona.
   */
  unrecorded?: ReadonlyMap<string, { startsAt: Date; professionalName: string | null; mine: boolean }>
  /** La atención donde se indicó cada control: quién, cuándo y su motivo. Solo de una persona. */
  controlOrigins?: ReadonlyMap<string, { professionalName: string | null; at: Date; reason: string | null }>
  /** La próxima cita por venir que lleva cada tratamiento: cuándo es la sesión de lo que va antes. */
  carriedAt?: ReadonlyMap<string, Date>
  /** Desde qué día conviene la próxima sesión de lo empezado (`nextSessionFromOf`): la endodoncia, una semana. */
  sessionFrom?: ReadonlyMap<string, string>
  /** «No contesta»: el presupuesto y cuándo volver a llamar (su tarea abierta). Solo de una persona. */
  callbacks?: ReadonlyMap<string, { said: string | null; dueAt: Date | null }>
  /** Sus citas por venir que solo llevaban lo ya terminado (`freedAppointmentsOf`). Solo de una persona. */
  freed?: Array<{ id: string; version: number; startsAt: Date; professionalName: string | null; wasFor: string }>
}

/** Sin nada que hacer en el plan. */
const NOTHING: PlanNextStep = { kind: "ninguno", text: "Nada pendiente en el plan", detail: null, action: null }


/**
 * El control de un tratamiento (el de una endodoncia): decide si funcionó y va primero. Es el
 * que lleva su tratamiento; el que se indica al firmar guarda el procedimiento de la visita
 * aunque sea de mantenimiento (`encounters.ts`), así que eso no basta.
 */
function isTreatmentControl(control: FollowUpRow): boolean {
  return control.planItemId !== null || control.kind === "tratamiento"
}

/**
 * Las piezas de la regla: qué toca de cada clase y la frase de cada una, sin
 * decidir el orden. `planStepsFrom` las pone en una lista y `planNextStepFrom`
 * toma su primera fila; las dos con estas mismas piezas.
 */
function planPieces(facts: PlanFacts, context: PlanContext, can: Can) {
  const { name, budgets, items, withAppointment, sessions, controls, nextAppointmentAt, nextAppointmentId, today, controlOrigins } = facts
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
  // regla de la firma): uno que ya llegó a sus previstas y quedó abierto sigue más abajo.
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

  // --- Lo que va después de otro tratamiento de la misma pieza ------------------------------
  // Lo aceptado sin empezar espera a otro aceptado y sin terminar de la misma pieza que va en
  // una fase anterior del plan: la corona, a la endodoncia (QA de la ficha del 9 nov: se
  // proponía reservarla hoy, antes de la sesión 2). Las fases son del producto: latidIA tiene
  // una sola y nunca espera nada. Es un aviso: la reserva se puede hacer igual.
  // La regla vive en `to-schedule.ts` (`waitingFor`): la misma de «Hoy viene a…», Inicio y Argos.
  const phases = context.phases ?? []
  const sameSite = (a: PlanItemRow, b: PlanItemRow) =>
    !!a.siteCode && a.siteSystem === b.siteSystem && a.siteCode === b.siteCode
  const blockerOf = (item: PlanItemRow): PlanItemRow | null => waitingFor(item, items, phases)
  const ready = toStart.filter((item) => !blockerOf(item))
  const awaiting = budgets.filter((budget) => budget.awaitsAnswer).at(-1) ?? null
  // Un tratamiento en curso sin cita para su próxima sesión, o uno que ya tiene
  // su primera cita (o sesión) y le faltan otras por reservar.
  // La sesión siguiente se pide cuando la anterior ya se hizo y no hay otra en pie: con la sesión 1
  // de la corona reservada, la 2 se reserva en esa cita, cuando se sabe cuánto tarda el laboratorio
  // (QA del 9 nov, repaso 3). Reservarla antes sigue siendo posible desde la agenda.
  const asksNext = (item: PlanItemRow) => countOf(item).done > 0 && countOf(item).booked === 0
  const continuing =
    started ?? items.find((item) => canBookAnother(item, countOf(item)) && asksNext(item)) ?? null
  // Para la lista, todos los que siguen así, sin lo que ya va en «lo aceptado sin cita»: el
  // mismo tratamiento no sale dos veces (uno ya empezado, con su cita de hoy pasada, también
  // queda «por agendar»).
  const allContinuing = items.filter(
    (item) =>
      !toStart.some((other) => other.id === item.id) &&
      ((item.status === "en_curso" && isToSchedule(item, withAppointment)) ||
        (canBookAnother(item, countOf(item)) && asksNext(item))),
  )
  // Lo que ya tiene la cita de su próxima sesión: no falta nada, pero se dice cuándo es, para no
  // leer «Nada pendiente» con una endodoncia abierta (QA del 9 nov, repaso 3). Solo a quien ve la agenda.
  const bookedNext = seesAgenda
    ? items.filter(
        (item) =>
          item.decisionStatus === "aceptado" &&
          (TO_SCHEDULE_STATUSES as readonly string[]).includes(item.status) &&
          !!facts.carriedAt?.get(item.id),
      )
    : []

  // --- Los controles ---------------------------------------------------------------------
  // Se cumple con su atención de hoy (`servedToday`) o con una cita por venir que le sirve
  // (`appointmentServesControl`, ADR 0152): no falta reservarle nada.
  const servedNow = (control: FollowUpRow) => !!today && servedToday(control, today.startsAt, timezone)
  const servedLater = (control: FollowUpRow) =>
    control.status === "pendiente" && !!nextAppointmentAt && appointmentServesControl(control, nextAppointmentAt, timezone)
  /** Le falta su cita: vencido sin cita o ya en su ventana, y nada lo cumple. */
  const toBook = (control: FollowUpRow) =>
    control.status === "pendiente" &&
    !servedNow(control) &&
    !servedLater(control) &&
    (isOverdueControl(control, nextAppointmentAt ?? null, timezone) || isControlWindowOpen(control, timezone))
  // Quien no ve la agenda (caja) no recibe ningún control.
  const open = seesAgenda ? controls : []
  // El control de un tratamiento que falta reservar va primero: dice si el tratamiento funcionó.
  const treatmentControl = open.find((control) => isTreatmentControl(control) && toBook(control)) ?? null
  // Otro control que falta reservar (la limpieza y control) va con lo aceptado, en la misma fila
  // y la misma cita; sin nada aceptado, en su lugar.
  const joinedControl = open.find((control) => !isTreatmentControl(control) && toBook(control)) ?? null
  // El resto, al final: el próximo de los que quedan (con cita, por venir o se cumple hoy).
  // El control de un tratamiento y lo aceptado de la misma pieza (la corona sobre la 46 con su
  // endodoncia por controlar): una fila y una cita, desde que el control se puede hacer (QA de la
  // ficha del 9 nov). Lo de otras piezas no se atrasa por él: sigue en su fila.
  const treatedOf = (control: FollowUpRow) => (control.planItemId ? items.find((item) => item.id === control.planItemId) : undefined)
  const pairedControl =
    open.find((control) => {
      if (!isTreatmentControl(control) || control.status !== "pendiente" || servedNow(control) || servedLater(control)) return false
      // Solo un control cercano: uno a 6 meses atrasaría la corona meses (QA antes de entregar).
      if (!pairsWithAccepted(control)) return false
      const treated = treatedOf(control)
      return !!treated && ready.some((item) => sameSite(item, treated))
    }) ?? null
  const pairedItems = pairedControl ? ready.filter((item) => sameSite(item, treatedOf(pairedControl)!)) : []
  const laterControl =
    open.find(
      (control) => control.id !== treatmentControl?.id && control.id !== joinedControl?.id && control.id !== pairedControl?.id,
    ) ?? null
  // Los controles que no salen en ninguna fila (el radiográfico del año detrás del de
  // mantenimiento): la fila del próximo dice cuántos más hay (repaso final de la atención, B13).
  const moreControls = open.filter(
    (control) =>
      ![treatmentControl, joinedControl, pairedControl, laterControl].some(
        (shown) => shown?.id === control.id,
      ),
  ).length

  // Quien no reserva (caja) ve la fila sin botón: se le dice a quién le toca (QA del 9 nov).
  const bookedBy = can("appointments.write") ? null : "la cita la reserva recepción"

  /** «Falta la cita de la próxima sesión: Endodoncia · sesión 2 de 2», con «Reservar la sesión 2». */
  const continueStep = (item: PlanItemRow): PlanNextStep => {
    const n = countOf(item).done + countOf(item).booked + 1
    const numbered = showsSession(n, item.plannedSessions)
    const session = numbered ? ` · ${sessionWords(n, item.plannedSessions)}` : ""
    // Lo que va después ya tiene su cita (la corona reservada mientras la endodoncia pide otra
    // sesión): esa cita llega antes que esta sesión. Se avisa donde se reserva (repaso del 9 nov).
    const laterBooked = items
      .map((later) => ({ later, at: facts.carriedAt?.get(later.id) }))
      .filter(
        (row): row is { later: PlanItemRow; at: Date } =>
          !!row.at && waitingFor(row.later, items, phases)?.id === item.id,
      )
      .sort((a, b) => a.at.getTime() - b.at.getTime())[0]
    // Su cita se cerró con «Vino» y nadie registró la sesión (QA del 10 nov, M4): se avisa a quien
    // atendió, sin quitar «Reservar» (recepción puede tener al paciente delante; mesa de la entrega 12).
    const seen = facts.unrecorded?.get(item.id)
    const unrecordedWords = seen && seesAgenda
      ? seen.mine
        ? `Su cita contigo del ${day(seen.startsAt)} quedó atendida sin registrar ${lower(item.title)}: regístralo si se hizo esa sesión.`
        : `Su cita del ${day(seen.startsAt)} quedó atendida sin registrar ${lower(item.title)}${seen.professionalName ? `: pregúntale a ${seen.professionalName} si se hizo esa sesión` : ""}.`
      : null
    return {
      kind: "continuar",
      text: `Falta la cita de la próxima sesión: ${item.title}${session}`,
      detail: bookedBy,
      ...(unrecordedWords
        ? { notice: unrecordedWords }
        : laterBooked && seesAgenda
          ? {
              notice: `${laterBooked.later.title} ya tiene cita el ${day(laterBooked.at)}, y va después: revisa esa cita.`,
            }
          : {}),
      // El botón dice qué reserva (QA del 8 nov): «Reservar la sesión 2», como al firmar.
      action: can("appointments.write")
        ? {
            label: numbered ? `Reservar la sesión ${n}` : "Reservar la próxima sesión",
            planItemIds: [item.id],
            serviceId: item.serviceId,
            // No mañana: lo que su tratamiento deja entre sesiones (QA del 9 nov, repaso 3).
            ...(facts.sessionFrom?.get(item.id)
              ? { date: facts.sessionFrom.get(item.id)!, note: SESSION_GAP_NOTE }
              : {}),
          }
        : null,
    }
  }

  /** «Corona · sesión 1 de 2: mar 10 nov, 09:00», sin botón: ya tiene su cita. */
  const bookedStep = (item: PlanItemRow): PlanNextStep => {
    const at = facts.carriedAt!.get(item.id)!
    const n = countOf(item).done + 1
    const session = showsSession(n, item.plannedSessions) ? ` · ${sessionWords(n, item.plannedSessions)}` : ""
    const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone: timezone }).format(at)
    const weekday = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: timezone }).format(at).replace(".", "")
    const more = item.plannedSessions > n
    return {
      kind: "reservado",
      text: `${item.title}${session}: ${weekday} ${day(at)}, ${time}`,
      // La siguiente se reserva en esa cita: en la corona depende del laboratorio.
      detail: more ? `Con su cita · la sesión ${n + 1} se reserva en esa cita` : "Con su cita",
      action: null,
    }
  }

  /** Armado y sin enviar: lo envía recepción (decisión 4). */
  const sendStep = (budget: BudgetWithTotals): PlanNextStep => ({
    kind: "enviar",
    text: `Enviar el presupuesto a ${name}`,
    detail: `${budgetLine(budget, locale)} · por enviar desde el ${day(budget.createdAt)}`,
    action: can("budgets.send") ? { label: "Enviar", budgetId: budget.id } : null,
  })

  /** «Limpieza y control vencido: tocaba el 2 oct», para la fila de lo aceptado. */
  const controlWords = (control: FollowUpRow) => {
    const overdue = dayKey(control.dueAt) < dayKey(new Date())
    return `${control.title} ${overdue ? "vencido: tocaba" : "por reservar: toca"} el ${day(control.dueAt)}`
  }

  /** «Corona» → «corona»: el título dentro de una frase. */
  const lower = (title: string) => title.charAt(0).toLowerCase() + title.slice(1)
  /**
   * «Resina · Corona · y 1 más»: con « · », porque los nombres de los servicios llevan comas
   * («Corona metal-cerámica, metal base») y una «y» entre ellos no se leía (segunda mesa del 9 nov).
   */
  const namesOf = (list: PlanItemRow[]) => {
    const titles = list.map((item) => item.title)
    return titles.length > 3 ? `${titles.slice(0, 3).join(" · ")} · y ${titles.length - 3} más` : titles.join(" · ")
  }
  const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
  /** El día siguiente a `YYYY-MM-DD`. */
  const nextDayOf = (key: string) => {
    const [y, m, d] = key.split("-").map(Number)
    return new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10)
  }
  /** El día siguiente a `date`, en la zona de la clínica (`YYYY-MM-DD`). */
  const dayAfter = (date: Date) => {
    const [y, m, d] = dayKey(date).split("-").map(Number)
    return new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10)
  }
  /**
   * Cuándo es lo que va antes, sin prometer que ahí termina (puede pedir otra sesión):
   * «su sesión 2 es el 11 nov», «su cita es el 11 nov» o, sin cita, «primero, la endodoncia».
   */
  const beforeWords = (blocker: PlanItemRow) => {
    const at = facts.carriedAt?.get(blocker.id)
    if (!at) return `primero, ${blocker.status === "en_curso" ? "la próxima sesión de " : ""}${lower(blocker.title)}`
    const n = countOf(blocker).done + 1
    if (!seesAgenda) return "ya tiene su cita"
    return showsSession(n, blocker.plannedSessions)
      ? `su ${sessionWords(n, blocker.plannedSessions)} es el ${day(at)}`
      : `su cita es el ${day(at)}`
  }

  /**
   * Lo aceptado sin cita: «Reservar lo aceptado» con los tratamientos ya puestos, y cuáles son.
   * Con un control que también falta reservar, los dos en una fila y una cita (QA del 8 nov,
   * entrega 3): la limpieza va en la misma visita y no se pierde. Lo que va después de otro
   * tratamiento de la misma pieza se dice así y se busca hora desde el día siguiente a esa
   * sesión; si todo espera, la fila es esa (QA de la ficha del 9 nov). Con una cita por venir
   * que no lo lleva, se ofrece sumarlo a ella.
   */
  const scheduleStep = (list: PlanItemRow[], controls: FollowUpRow[]): PlanNextStep => {
    const control = controls[0] ?? null
    const listReady = list.filter((item) => !blockerOf(item))
    const listWaiting = list.filter((item) => !!blockerOf(item))
    const decided = budgets
      .filter((budget) => budget.status === "aceptado" || budget.status === "parcial")
      .find((budget) => budget.items.some((line) => list.some((item) => item.id === line.planItemId)))
    const label = context.budgetRequired ? "Reservar lo aceptado" : "Reservar lo indicado"
    const answered = decided?.decidedAt ? `respondió el ${day(decided.decidedAt)}` : null

    // Todo lo que falta va después de otro tratamiento: la fila dice de cuál y cuándo es.
    if (listReady.length === 0 && listWaiting.length > 0 && controls.length === 0) {
      const blocker = blockerOf(listWaiting[0]!)!
      const at = facts.carriedAt?.get(blocker.id)
      const before = beforeWords(blocker)
      // Sin cita lo de antes, al menos después de cuando conviene su próxima sesión: no hoy
      // (pendiente de la entrega 8: reservar desde la ficha proponía hoy).
      const blockerFrom = facts.sessionFrom?.get(blocker.id)
      return {
        kind: "agendar",
        text: `${namesOf(listWaiting)}: va después de terminar ${blocker.title}`,
        detail: [capital(before), answered, bookedBy].filter(Boolean).join(" · "),
        action: can("appointments.write")
          ? {
              label,
              planItemIds: listWaiting.map((item) => item.id),
              serviceId: listWaiting[0]?.serviceId ?? null,
              ...(at ? { date: dayAfter(at) } : blockerFrom ? { date: nextDayOf(blockerFrom) } : {}),
              note: `Va después de terminar ${blocker.title} (${before}).`,
            }
          : null,
      }
    }

    // Ya tiene una cita que no lo lleva: se dice así, no «falta su cita», que suena a que no tiene ninguna.
    // Si una parte ya tiene cita, se dice que falta el resto. A quien no ve la agenda, sin su fecha.
    const partly = toStart.length < accepted.length
    const yourAppointment = (date: Date) => (seesAgenda ? `su cita del ${day(date)}` : "su próxima cita")
    const what = context.budgetRequired ? "lo aceptado" : "lo indicado"
    // «aún no va en su cita del 10 nov»: el estado; las salidas las dicen los botones (mesa del 9 nov).
    const missing = nextAppointmentAt ? `aún no va${partly ? " todo" : ""} en ${yourAppointment(nextAppointmentAt)}` : "falta su cita"
    // «el control vencido»: no es el control de lo aceptado, y lo vencido se dice en el título (segunda mesa).
    const controlNoun = control && dayKey(control.dueAt) < dayKey(new Date()) ? "el control vencido" : "el control"
    const text = control
      ? nextAppointmentAt
        ? `${what.charAt(0).toUpperCase()}${what.slice(1)} y ${controlNoun} no van en ${yourAppointment(nextAppointmentAt)}`
        : `Falta su cita: ${what} y ${controlNoun}`
      : decided
        ? // «Aceptó todo» o, con varias opciones, «Eligió la opción A»: el mismo nombre que el Plan.
          `${decided.stateText}: ${missing}`
        : context.budgetRequired
          ? nextAppointmentAt
            ? `Tiene tratamientos aceptados que aún no van en ${yourAppointment(nextAppointmentAt)}`
            : "Tiene tratamientos aceptados sin cita"
          : // En latidIA lo indicado ya queda aceptado: no hubo nada que aceptar.
            nextAppointmentAt
            ? `${partly ? "Parte de lo indicado" : "Lo indicado"} aún no va en ${yourAppointment(nextAppointmentAt)}`
            : "Falta la cita de lo indicado"
    // Qué falta, con sus nombres (QA del 8 nov: «Aceptó todo: falta su cita» no decía qué); lo
    // que va después de otro tratamiento, con cuál.
    const named = [
      namesOf(listReady) || null,
      ...listWaiting.map((item) => `${item.title}: va después de ${blockerOf(item)!.title}`),
    ]
      .filter(Boolean)
      .join(" · ")
    // Su cita ya se atendió y nadie registró que se hiciera: se avisa donde se decide reservar, sin
    // frenarlo (mesa del 9 nov: pudo posponerse a propósito). Quien atendió sabe si se hizo.
    const notRecorded = list.flatMap((item) => {
      const seen = facts.unrecorded?.get(item.id)
      return seen ? [{ item, ...seen }] : []
    })
    // Solo a quien ve la agenda: a caja no le toca reservar ni preguntar por la cita.
    const recordedWarning =
      notRecorded.length && seesAgenda
        ? (() => {
            const last = notRecorded.reduce((a, b) => (a.startsAt > b.startsAt ? a : b))
            const what = notRecorded.map((row) => lower(row.item.title)).join(", ")
            // A quien atendió no se le pide que se pregunte a sí mismo (segunda mesa del 9 nov).
            if (last.mine)
              return `Su cita contigo del ${day(last.startsAt)} se atendió sin registrar ${what}: regístralo en su próxima atención si se hizo`
            return `Su cita del ${day(last.startsAt)} se atendió sin registrar ${what}${last.professionalName ? `: pregúntale a ${last.professionalName} si se hizo` : ""}`
          })()
        : null
    // El control que todavía no se puede hacer: se busca hora desde que abre su ventana.
    const opens = controls
      .map((row) => dayKey(controlWindowStart(row)))
      .filter((key) => key > dayKey(new Date()))
      .sort()
      .at(-1)
    // Sumarlo a la cita que ya tiene: solo lo que no espera a otro tratamiento y sin control (el
    // control se reserva con su propia regla).
    const join =
      nextAppointmentAt && nextAppointmentId && controls.length === 0 && listReady.length > 0 && seesAgenda
        ? { appointmentId: nextAppointmentId, label: `Sumar a su cita del ${day(nextAppointmentAt)}` }
        : null
    return {
      kind: "agendar",
      text,
      detail:
        [
          named || null,
          answered,
          ...controls.map(controlWords),
          // Quién pidió el control de su tratamiento (se decía en su fila antes de juntarlas).
          ...controls.map((row) => {
            const origin = isTreatmentControl(row) ? controlOrigins?.get(row.id) : undefined
            return origin?.professionalName ? `lo indicó ${origin.professionalName}` : null
          }),
          bookedBy,
        ]
          .filter(Boolean)
          .join(" · ") || null,
      // Dice qué reserva: «Reservar cita» a secas es el de la cabecera (segunda mesa del 8 nov).
      action: can("appointments.write")
        ? {
            label: join ? "Otra cita" : control ? `${label} y el control` : label,
            planItemIds: listReady.map((item) => item.id),
            serviceId: listReady[0]?.serviceId ?? null,
            ...(control
              ? { followUpId: control.id, followUpIds: controls.map((row) => row.id) }
              : {}),
            // Lo aceptado no espera la ventana del control (decisión B3 del 10 nov): se busca hora
            // como siempre, y el control se suma a esa cita solo si su día cae en la ventana; si no,
            // queda por reservar (lo decide `createAppointment`).
            ...(opens && control
              ? {
                  note: `${control.title} toca el ${day(control.dueAt)}: se suma a esta cita si es desde el ${day(new Date(`${opens}T12:00:00Z`))}; si no, queda por reservar.`,
                }
              : {}),
            ...(join ? { join } : {}),
          }
        : null,
      notice: recordedWarning,
    }
  }

  /** Lo que espera respuesta (una sola regla: `budgetAwaitsAnswer`). */
  /**
   * Lo que espera respuesta, con qué tratamientos son (recepción llama y tiene que saber de qué
   * hablar) y, si no contestó, cuándo volver a llamar (QA de la ficha del 9 nov).
   */
  const answerStep = (budget: BudgetWithTotals): PlanNextStep => {
    const titleOf = new Map(items.map((item) => [item.id, item.title]))
    // Si ya respondió una parte, solo lo que espera respuesta: lo aceptado no se vuelve a preguntar
    // ni suma (repaso final de la ficha del 10 nov, M2).
    const open = awaitingLines(budget)
    const titles = [
      ...new Set(
        (open ?? budget.items)
          .map((line) => titleOf.get(line.planItemId))
          .filter((title): title is string => !!title),
      ),
    ]
    const names =
      titles.length > 2
        ? `${titles.slice(0, 2).join(" · ")} · y ${titles.length - 2} más`
        : titles.join(" · ")
    const callback = facts.callbacks?.get(budget.id)
    const callbackText = callback
      ? (() => {
          const today = dayKey(new Date())
          const due = callback.dueAt ? dayKey(callback.dueAt) : null
          const when = !callback.dueAt || !due
            ? "volver a llamar"
            : due === today
              ? "volver a llamar hoy"
              : due < today
                ? `volver a llamar: tocaba el ${day(callback.dueAt)}`
                : `volver a llamar el ${day(callback.dueAt)}`
          // «No contestó el 9 nov», como quedó anotado (la fecha de la tarea cambia si se edita).
          return `${callback.said ?? "No contestó"} · ${when}`
        })()
      : null
    return {
      kind: "respuesta",
      text: callbackText ?? (budget.status === "presentado" ? "Entregado · espera respuesta" : "Lo está pensando"),
      detail: [
        open
          ? awaitingLinesText(open, locale, names)
          : budgetLine(budget, locale, budget.options.length > 1 ? undefined : names || undefined),
        budget.presentedAt ? `Entregado el ${day(budget.presentedAt)}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      action: can("budgets.decide") ? { label: "¿Qué respondió?", budgetId: budget.id } : null,
    }
  }

  /** Un control, con quién lo indicó y cuándo (QA del 8 nov: no decía para qué era). */
  const controlStep = (control: FollowUpRow): PlanNextStep => {
    const due = `${dayKey(control.dueAt) < dayKey(new Date()) ? "Tocaba el" : "Toca el"} ${day(control.dueAt)}`
    const origin = controlOrigins?.get(control.id) ?? null
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
    if (today && servedNow(control)) {
      return {
        kind: "control",
        text: `${control.title} · se cumple con su atención de hoy`,
        detail: detail(due),
        action: can("appointments.read") ? { label: "Ver la cita", appointmentId: today.id } : null,
      }
    }
    // A un control le sirve una visita desde que abre su ventana hasta 30 días después de su
    // fecha (ADR 0152): con esa cita por venir no está «por reservar», pero no es su cita
    // propia; quien firma esa atención marca si se hizo.
    if (nextAppointmentAt && servedLater(control)) {
      return {
        kind: "control",
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
        text: `${control.title} · ${overdue ? "vencido" : "por reservar"}`,
        // «Vencido» ya dice que no tiene ninguna cita por venir: no se repite.
        detail: detail(due),
        action: can("appointments.write") ? { label: "Reservar el control", followUpId: control.id } : null,
      }
    }
    // En su próxima cita: lo dice, así se ve que va en la misma visita (segunda mesa del 9 nov).
    if (control.appointmentId && control.appointmentId === nextAppointmentId && nextAppointmentAt)
      return {
        kind: "control",
        text: `${control.title} · en su cita del ${day(nextAppointmentAt)}`,
        detail: detail(due),
        action: can("appointments.read") ? { label: "Ver la cita", appointmentId: control.appointmentId } : null,
      }
    return {
      kind: "control",
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
    treatmentControl,
    joinedControl,
    pairedControl,
    pairedItems,
    blockerOf,
    laterControl,
    moreControls,
    continueStep,
    bookedNext,
    bookedStep,
    sendStep,
    scheduleStep,
    answerStep,
    controlStep,
  }
}

/**
 * Todo lo que sigue, en una lista y en un solo orden (QA del 8 nov, entrega 3):
 * la misma en el Resumen, en la franja del Plan y, en una línea, en la fila de
 * Pacientes, que dicen su primera fila. Sin nada, la lista va vacía.
 *
 * 1. El control de un tratamiento que falta reservar (el de una endodoncia). Con lo aceptado
 *    de la misma pieza (la corona), en una fila y una cita, aunque el control todavía no se
 *    pueda hacer: se busca hora desde que se puede (QA de la ficha del 9 nov).
 * 2. El presupuesto armado y sin enviar.
 * 3. La próxima sesión de lo empezado, si además hay algo aceptado sin empezar
 *    (QA del 8 nov, X5: la sesión 2 de la endodoncia antes que la corona).
 * 4. Lo aceptado sin cita, con el otro control que falta reservar en la misma
 *    fila; sin nada aceptado, ese control solo.
 * 5. Lo que espera respuesta.
 * 6. Lo que sigue en curso, cada tratamiento una vez.
 * 7. El próximo control que queda (con cita, por venir o se cumple hoy).
 */
function planStepsFrom(facts: PlanFacts, context: PlanContext, can: Can): PlanNextStep[] {
  const steps = [...stepsOf(planPieces(facts, context, can)), ...suspendedSteps(facts)]
  // Una cita que ya pasó y que nadie cerró va primero en la lista de la ficha: decir si vino
  // registra lo que se hizo o devuelve lo que llevaba a «por reservar» (QA de la ficha del 8 nov).
  // Solo a quien ve la agenda; la frase única no la dice (es de la ficha, no del plan).
  if (!(can("appointments.read") || can("clinical.read"))) return steps
  const { locale, timezone } = context
  // La cita que quedó sin objeto, hasta que alguien elige usarla o liberarla (QA del 10 nov, M1).
  const reusable = facts.items.find(
    (item) =>
      item.decisionStatus === "aceptado" &&
      ["pendiente", "programado", "en_curso"].includes(item.status) &&
      !facts.withAppointment.has(item.id),
  )
  const freed = (facts.freed ?? []).map((row): PlanNextStep => {
    const day = dayWords(row.startsAt, locale, timezone)
    return {
      kind: "sin_objeto",
      text: `Su cita del ${day} era para ${row.wasFor}, que ya se terminó`,
      detail: [row.professionalName ? `con ${row.professionalName}` : null, "no tiene nada que hacer: úsala para otra cosa o libérala"]
        .filter(Boolean)
        .join(" · "),
      action: can("appointments.write")
        ? {
            label: "Liberarla",
            appointmentId: row.id,
            appointmentVersion: row.version,
            ...(reusable ? { reuse: { planItemId: reusable.id, title: reusable.title } } : {}),
          }
        : null,
    }
  })
  if (!facts.unclosed?.length) return [...freed, ...steps]
  const closing = facts.unclosed.map((row): PlanNextStep => {
    const day = dayWords(row.startsAt, locale, timezone)
    return {
      kind: "cerrar",
      text: `Su cita del ${day} quedó sin cerrar`,
      detail: [row.serviceName, row.professionalName ? `con ${row.professionalName}` : null, "nadie dijo si vino"].filter(Boolean).join(" · "),
      action: can("appointments.read") ? { label: "¿Vino?", appointmentId: row.id } : null,
    }
  })
  return [...closing, ...freed, ...steps]
}

function stepsOf(p: ReturnType<typeof planPieces>): PlanNextStep[] {
  const steps: PlanNextStep[] = []
  // El control de un tratamiento con lo aceptado de la misma pieza va primero, en una fila.
  if (p.pairedControl) steps.push(p.scheduleStep(p.pairedItems, [p.pairedControl]))
  if (p.treatmentControl && p.treatmentControl.id !== p.pairedControl?.id) steps.push(p.controlStep(p.treatmentControl))
  if (p.unsent) steps.push(p.sendStep(p.unsent))
  const rest = p.toStart.filter((item) => !p.pairedItems.some((other) => other.id === item.id))
  const sessionFirst = rest.length > 0 ? p.startedFirst : undefined
  if (sessionFirst) steps.push(p.continueStep(sessionFirst))
  // El control va con lo aceptado solo si algo de eso se puede reservar ya; si todo espera a otro
  // tratamiento, cada uno en su fila (QA antes de entregar: el botón quedaba sin nada que reservar).
  const restReady = rest.some((item) => !p.blockerOf(item))
  if (rest.length > 0) steps.push(p.scheduleStep(rest, p.joinedControl && restReady ? [p.joinedControl] : []))
  if (p.joinedControl && !(rest.length > 0 && restReady)) steps.push(p.controlStep(p.joinedControl))
  if (p.awaiting) steps.push(p.answerStep(p.awaiting))
  // Cada tratamiento que sigue en curso, una vez: primero el de la regla, después los demás.
  const ordered = p.continuing ? [p.continuing, ...p.allContinuing.filter((item) => item.id !== p.continuing?.id)] : p.allContinuing
  for (const item of ordered) {
    if (item.id === sessionFirst?.id || p.toStart.some((other) => other.id === item.id)) continue
    steps.push(p.continueStep(item))
  }
  // Lo que ya tiene la cita de su próxima sesión, después de lo que falta hacer.
  for (const item of p.bookedNext) {
    if (steps.some((step) => step.action?.planItemIds?.includes(item.id))) continue
    steps.push(p.bookedStep(item))
  }
  if (p.laterControl) {
    const step = p.controlStep(p.laterControl)
    const more =
      p.moreControls > 0
        ? `y ${p.moreControls} ${p.moreControls === 1 ? "control" : "controles"} más`
        : null
    steps.push(more ? { ...step, detail: [step.detail, more].filter(Boolean).join(" · ") } : step)
  }
  return steps
}

/**
 * «Qué sigue» en una frase: la primera fila de la lista, con lo que dice de más
 * cuando es lo único que se ve (el Plan, la fila de Pacientes, lo que lee el
 * agente). Sin consultas: decide con lo cargado.
 */
/** Lo suspendido, en una fila cada uno, con su motivo. */
function suspendedSteps(facts: PlanFacts): PlanNextStep[] {
  return facts.items
    .filter((item) => item.status === "suspendido")
    .map((item) => ({
      kind: "suspendido" as const,
      text: `Suspendido: ${item.title}`,
      detail: [item.statusReason?.trim() || null, "se retoma desde su Plan"].filter(Boolean).join(" · "),
      action: null,
    }))
}

function planNextStepFrom(facts: PlanFacts, context: PlanContext, can: Can): PlanNextStep {
  const p = planPieces(facts, context, can)
  const [first] = stepsOf(p)
  if (!first) return suspendedSteps(facts)[0] ?? NOTHING
  // La sesión de lo empezado gana a lo aceptado sin empezar: lo aceptado sigue «por agendar» (la
  // lista lo ofrece en su fila).
  if (first.kind === "continuar" && p.toStart.length > 0)
    return {
      ...first,
      detail: "También falta la cita de lo aceptado sin empezar",
      ...(can("appointments.write") ? { alsoToSchedule: p.toStart.map((item) => item.id) } : {}),
    }
  // Sin esa fila a la vista, el presupuesto no esconde la sesión que falta reservar.
  // Lo aceptado sin empezar que no es la primera fila se dice también a quien lee solo esta frase.
  const alsoToSchedule =
    first.kind !== "agendar" && p.toStart.length > 0 && can("appointments.write") ? { alsoToSchedule: p.toStart.map((item) => item.id) } : {}
  if ((first.kind === "enviar" || first.kind === "respuesta") && p.startedFirst)
    return { ...first, detail: `${first.detail} · también falta la cita de la próxima sesión de ${p.startedFirst.title}`, ...alsoToSchedule }
  return { ...first, ...alsoToSchedule }
}

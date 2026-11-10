import type { Db } from "@odentia/db"
import { type SQL, type SQLWrapper, sql } from "drizzle-orm"
import { NEUTRAL_TIMEZONE } from "./locale.js"

/**
 * Lo que falta agendar, con una sola regla para cada pregunta (propuestas O1 y
 * L3 de la ronda de QA del 2026-11-04). La usan Inicio, Pacientes, «Qué sigue»,
 * Reportes y las líneas de Argos: una pantalla no cuenta con otra regla.
 *
 * - **Aceptó y no tiene cita**: un tratamiento aceptado que aún se hace
 *   (pendiente, programado o en curso) y que ninguna cita por venir lleva. Otra cita de la
 *   persona no lo agenda: «Qué sigue» lo dice («su cita del 12 dic no lo lleva»). Lo que va
 *   después de otro tratamiento de la misma pieza que ya tiene su cita (la corona tras la
 *   endodoncia, con la sesión 2 reservada) no cuenta mientras esa cita esté por venir.
 * - **Va después** (`waitingFor`): lo aceptado sin empezar espera a otro aceptado y sin
 *   terminar (o pausado) de la misma persona y la misma pieza, de una fase anterior del plan.
 *   Es un aviso, nunca un freno: «Qué sigue», «Hoy viene a…» y el enlace lo dicen, y la
 *   reserva se puede hacer igual.
 * - **Control vencido sin cita**: un control pendiente cuyo día ya pasó, de una
 *   persona sin ninguna cita por venir. A un control le sirve cualquier visita:
 *   la cita no tiene que llevarlo.
 * - **La ventana de un control** (`controlWindowStart`): desde cuándo una
 *   visita lo cumple al firmarse, y desde cuándo una cita por venir cuenta en
 *   «Qué sigue» y en «Usar esa cita».
 *
 * Cada regla existe en código y en SQL; cambian juntas y su prueba las compara.
 */

/** Estados de una cita que todavía va a ocurrir. */
export const LIVE_APPOINTMENT_STATUSES = ["programada", "confirmada"] as const

/**
 * Lo aceptado que aún se hace: lo que espera empezar (pendiente, o programado
 * si se deshizo una atención que lo había hecho) y lo que va por sesiones. Es
 * también lo que una cita puede traer (`SCHEDULABLE_ITEM_STATUSES`).
 */
export const TO_SCHEDULE_STATUSES = ["pendiente", "programado", "en_curso"] as const

const list = (values: readonly string[]) => sql.join(values.map((value) => sql`${value}`), sql`, `)

/** Aceptó y no tiene cita, en código: `carried` son los tratamientos que una cita por venir ya lleva. */
export function isToSchedule(
  item: { id: string; status: string; decisionStatus: string },
  carried: ReadonlySet<string>,
): boolean {
  return (
    item.decisionStatus === "aceptado" &&
    (TO_SCHEDULE_STATUSES as readonly string[]).includes(item.status) &&
    !carried.has(item.id)
  )
}

/** Una cita por venir (programada o confirmada, desde `now`) lleva el tratamiento. */
export function carriedByUpcomingSql(
  item: { id: SQLWrapper; organizationId: SQLWrapper },
  now: SQLWrapper = sql`now()`,
): SQL {
  return sql`exists (select 1 from appointment_plan_item carrier
    join appointment carrier_appointment on carrier_appointment.organization_id = carrier.organization_id
      and carrier_appointment.id = carrier.appointment_id
    where carrier.organization_id = ${item.organizationId} and carrier.plan_item_id = ${item.id}
      and carrier_appointment.status in (${list(LIVE_APPOINTMENT_STATUSES)}) and carrier_appointment.starts_at > ${now})`
}

/**
 * Un tratamiento del plan con lo que pide la regla «va después»: su fase del plan y su sitio
 * (la pieza). Las fases son las del producto (`productHooks.planPhases`), en el orden en que
 * se hacen: latidIA tiene una sola y nunca espera nada.
 */
export interface SequencedItem {
  id: string
  status: string
  decisionStatus: string
  phase: string
  siteSystem: string | null
  siteCode: string | null
}

/** Lo que espera empezar: lo único que puede ir después de otro. */
const NOT_STARTED_STATUSES = ["pendiente", "programado"] as const
/** Lo que todavía va antes: aceptado y sin terminar, también pausado (retomarlo es lo primero). */
const BEFORE_STATUSES = [...TO_SCHEDULE_STATUSES, "suspendido"] as const

/** `before` va antes de `item`: misma pieza, aceptado y sin terminar, de una fase anterior. */
function goesBefore(
  item: SequencedItem,
  before: SequencedItem,
  phases: readonly string[],
): boolean {
  const rank = (row: SequencedItem) => phases.indexOf(row.phase)
  return (
    (NOT_STARTED_STATUSES as readonly string[]).includes(item.status) &&
    !!item.siteCode &&
    before.id !== item.id &&
    before.decisionStatus === "aceptado" &&
    (BEFORE_STATUSES as readonly string[]).includes(before.status) &&
    before.siteSystem === item.siteSystem &&
    before.siteCode === item.siteCode &&
    rank(before) >= 0 &&
    rank(item) > rank(before)
  )
}

/**
 * Lo que va antes de `item` (QA de la ficha del 9 nov; en un solo lugar desde la entrega 8):
 * otro tratamiento aceptado y sin terminar de la misma pieza, en una fase anterior. Si hay
 * varios, el que ya empezó: es el que se está terminando. `items` son los de la misma persona.
 */
export function waitingFor<T extends SequencedItem>(
  item: T,
  items: readonly T[],
  phases: readonly string[],
): T | null {
  const before = items.filter((other) => goesBefore(item, other, phases))
  return before.find((other) => other.status === "en_curso") ?? before[0] ?? null
}

/**
 * Va después de otro tratamiento que ya tiene su cita por venir (`carried`): mientras tanto
 * no cuenta como «aceptó y no tiene cita». Si lo de antes no tiene cita, la persona ya
 * aparece por eso; si su cita pasó, se pausó sin cita o terminó, vuelve a contar.
 */
export function awaitsBooked(
  item: SequencedItem,
  items: readonly SequencedItem[],
  carried: ReadonlySet<string>,
  phases: readonly string[],
): boolean {
  return items.some((other) => carried.has(other.id) && goesBefore(item, other, phases))
}

/** Las columnas de un tratamiento del plan con las que trabajan estas reglas en SQL. */
export interface PlanItemSql {
  id: SQLWrapper
  organizationId: SQLWrapper
  patientId: SQLWrapper
  status: SQLWrapper
  decisionStatus: SQLWrapper
  phase: SQLWrapper
  siteSystem: SQLWrapper
  siteCode: SQLWrapper
}

/** Esas columnas sobre un alias de `treatment_plan_item` («i», «pi»). */
export function planItemSql(alias: string): PlanItemSql {
  const col = (name: string) => sql.raw(`${alias}.${name}`)
  return {
    id: col("id"),
    organizationId: col("organization_id"),
    patientId: col("patient_id"),
    status: col("status"),
    decisionStatus: col("decision_status"),
    phase: col("phase"),
    siteSystem: col("site_system"),
    siteCode: col("site_code"),
  }
}

/** El orden de las fases en SQL (`array_position` empieza en 1; fuera de la lista, nulo). */
const phaseRankSql = (phases: readonly string[], phase: SQLWrapper) =>
  phases.length
    ? sql`array_position(array[${list(phases)}]::text[], ${phase}::text)`
    : sql`null::int`

/** `before` va antes de `item` (`waitingFor`), en SQL: un rango nulo deja la comparación falsa. */
export function goesBeforeSql(
  item: PlanItemSql,
  before: PlanItemSql,
  phases: readonly string[],
): SQL {
  return sql`(${item.status} in (${list(NOT_STARTED_STATUSES)}) and ${item.siteCode} is not null
    and ${before.organizationId} = ${item.organizationId} and ${before.patientId} = ${item.patientId}
    and ${before.id} <> ${item.id} and ${before.decisionStatus} = 'aceptado'
    and ${before.status} in (${list(BEFORE_STATUSES)})
    and ${before.siteSystem} is not distinct from ${item.siteSystem} and ${before.siteCode} = ${item.siteCode}
    and ${phaseRankSql(phases, before.phase)} < ${phaseRankSql(phases, item.phase)})`
}

/** Va después de otro tratamiento con su cita por venir (`awaitsBooked`), en SQL. */
export function awaitsBookedSql(
  item: PlanItemSql,
  phases: readonly string[],
  now: SQLWrapper = sql`now()`,
): SQL {
  const before = planItemSql("before_item")
  return sql`exists (select 1 from treatment_plan_item before_item where ${goesBeforeSql(item, before, phases)}
    and ${carriedByUpcomingSql(before, now)})`
}

/**
 * Hasta cuántos días por venir puede abrir su ventana el control de un tratamiento para ir en la
 * misma cita que lo aceptado de esa pieza (la corona con el control de su endodoncia). Supuesto a
 * confirmar con una clínica: el control de corto plazo de una endodoncia, no el radiográfico de
 * meses. La usan «Qué sigue» y la reserva desde el cierre de la atención.
 */
export const PAIRED_CONTROL_DAYS = 30

/** El control abre su ventana dentro de `PAIRED_CONTROL_DAYS`: puede ir en la cita de lo aceptado. */
export function pairsWithAccepted(
  control: { dueAt: Date; createdAt: Date },
  now: Date = new Date(),
): boolean {
  return controlWindowStart(control).getTime() <= now.getTime() + PAIRED_CONTROL_DAYS * 86_400_000
}

/** De `ids`, los que van después de otro tratamiento de la persona (`waitingFor`). */
export async function waitingItemIds(
  tx: Db,
  orgId: string,
  ids: readonly string[],
  phases: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const rows = await tx.execute<{ id: string }>(sql`
    select i.id from treatment_plan_item i
    where i.organization_id = ${orgId} and i.id in (${list(ids)})
      and exists (select 1 from treatment_plan_item before_item where ${goesBeforeSql(planItemSql("i"), planItemSql("before_item"), phases)})`)
  return new Set(rows.map((row) => row.id))
}

/**
 * Aceptó y no tiene cita, en SQL, sobre una fila de `treatment_plan_item` (o un alias), sin lo
 * que va después de otro tratamiento que ya tiene su cita. En código: `isToSchedule` y no
 * `awaitsBooked`. Las fases, las del producto de la clínica (`productHooks(...).planPhases`).
 */
export function toScheduleSql(
  item: PlanItemSql,
  phases: readonly string[],
  now: SQLWrapper = sql`now()`,
): SQL {
  return sql`(${item.decisionStatus} = 'aceptado' and ${item.status} in (${list(TO_SCHEDULE_STATUSES)})
    and not ${carriedByUpcomingSql(item, now)} and not ${awaitsBookedSql(item, phases, now)})`
}

/**
 * El presupuesto tiene una línea aceptada cuyo tratamiento sigue sin cita
 * (`toScheduleSql`): la línea de Argos y su tarea. `extra` acota el tratamiento
 * (`scheduled_item`), por ejemplo a lo que va en curso.
 */
export function budgetToScheduleSql(
  budget: { id: SQLWrapper; organizationId: SQLWrapper },
  phases: readonly string[],
  now: SQLWrapper = sql`now()`,
  extra: SQL = sql``,
): SQL {
  return sql`exists (select 1 from treatment_budget_item scheduled_line
    join treatment_plan_item scheduled_item on scheduled_item.organization_id = scheduled_line.organization_id
      and scheduled_item.id = scheduled_line.plan_item_id
    where scheduled_line.organization_id = ${budget.organizationId} and scheduled_line.budget_id = ${budget.id}
      and scheduled_line.decision = 'aceptado' ${extra}
      and ${toScheduleSql(planItemSql("scheduled_item"), phases, now)})`
}

/**
 * Las sesiones de un tratamiento de varias (una endodoncia en dos, la
 * ortodoncia mensual, una terapia). Se calculan, no se guardan:
 *
 * - **Hechas**: atenciones distintas, no anuladas, con un procedimiento vigente
 *   del tratamiento. Una atención es una sesión aunque lo registre dos veces,
 *   como en las comisiones.
 * - **En pie**: citas programadas o confirmadas que lo llevan y cuya atención
 *   todavía no lo registró (si ya lo registró, es una sesión hecha y no se
 *   cuenta dos veces). Una que ya pasó sin llegada ni atención no cuenta: nadie
 *   marcó «No vino», pero tampoco va a ocurrir.
 * - **Puede llevar otra cita**: aceptado y por hacer (`TO_SCHEDULE_STATUSES`),
 *   con más sesiones previstas que hechas y en pie. Es una regla aparte de
 *   «Aceptó y no tiene cita» (`isToSchedule`), que no cambia: Inicio, Pacientes,
 *   Reportes y Argos siguen contando lo mismo. La usan la reserva («Para esta
 *   cita»), la cita que no dice qué trae (Sofi, «Su enlace», Clío) y «Qué sigue».
 *
 * Cada regla existe en código y en SQL, y su prueba las compara.
 */
export interface SessionCount {
  /** Atenciones distintas con un procedimiento vigente del tratamiento. */
  done: number
  /** Citas en pie que lo llevan y aún no lo registraron. */
  booked: number
}

/** Puede llevar otra cita, en código, con lo que cuenta `sessionCountsOf`. */
export function canBookAnother(
  item: { status: string; decisionStatus: string; plannedSessions: number },
  count: SessionCount,
): boolean {
  return (
    item.decisionStatus === "aceptado" &&
    (TO_SCHEDULE_STATUSES as readonly string[]).includes(item.status) &&
    item.plannedSessions > count.done + count.booked
  )
}

/** Cuántas sesiones quedan por reservar (0 si no puede llevar otra cita). */
export function sessionsLeft(
  item: { status: string; decisionStatus: string; plannedSessions: number },
  count: SessionCount,
): number {
  return canBookAnother(item, count) ? item.plannedSessions - count.done - count.booked : 0
}

/**
 * Sesiones hechas del tratamiento, en SQL. `exceptAppointment` deja fuera la
 * atención de esa cita: la sesión que la cita viene a hacer no es «anterior».
 */
export function sessionsDoneSql(
  item: { id: SQLWrapper; organizationId: SQLWrapper },
  exceptAppointment?: SQLWrapper,
): SQL {
  return sql`(select count(distinct done_procedure.encounter_id)::int from encounter_procedure done_procedure
    join encounter done_encounter on done_encounter.organization_id = done_procedure.organization_id
      and done_encounter.id = done_procedure.encounter_id
    where done_procedure.organization_id = ${item.organizationId} and done_procedure.plan_item_id = ${item.id}
      and done_procedure.voided_at is null and done_encounter.status <> 'anulada'
      ${exceptAppointment ? sql`and done_encounter.appointment_id is distinct from ${exceptAppointment}` : sql``})`
}

/**
 * La cita está en pie para el tratamiento (ver arriba), sobre una fila de `appointment` (o un alias).
 * Una cita cuya hora ya pasó cuenta solo si es de hoy, en el día de la clínica, y la persona
 * llegó o se la está atendiendo: es la sesión que ocurre ahora. Una de un día anterior que
 * nadie cerró (llegó, o su atención quedó abierta, y nadie la marcó atendida) no va a volver a
 * ocurrir: si su atención registró la sesión, ya cuenta como hecha (`sessionsDoneSql`), y si
 * no, la sesión sigue por reservar (QA del 8 nov, entrega 3: «Reservar la sesión 2» contaba una
 * cita ya pasada).
 */
export function standingForSql(
  appointment: { id: SQLWrapper; organizationId: SQLWrapper; status: SQLWrapper; startsAt: SQLWrapper; arrivedAt: SQLWrapper },
  itemId: SQLWrapper,
  now: SQLWrapper = sql`now()`,
): SQL {
  const zone = sql`coalesce(nullif((select standing_zone.timezone from org_profile standing_zone
    where standing_zone.organization_id = ${appointment.organizationId}), ''), ${NEUTRAL_TIMEZONE})`
  return sql`(${appointment.status} in (${list(LIVE_APPOINTMENT_STATUSES)})
    and (${appointment.startsAt} > ${now}
      or ((${appointment.startsAt} at time zone ${zone})::date = (${now} at time zone ${zone})::date
        and (${appointment.arrivedAt} is not null
          or exists (select 1 from encounter standing_encounter
            where standing_encounter.organization_id = ${appointment.organizationId}
              and standing_encounter.appointment_id = ${appointment.id} and standing_encounter.status <> 'anulada'))))
    and not exists (select 1 from encounter standing_done
      join encounter_procedure standing_procedure on standing_procedure.organization_id = standing_done.organization_id
        and standing_procedure.encounter_id = standing_done.id
      where standing_done.organization_id = ${appointment.organizationId}
        and standing_done.appointment_id = ${appointment.id} and standing_done.status <> 'anulada'
        and standing_procedure.plan_item_id = ${itemId} and standing_procedure.voided_at is null))`
}

/** Citas en pie que llevan el tratamiento, en SQL. */
export function bookedSessionsSql(item: { id: SQLWrapper; organizationId: SQLWrapper }, now: SQLWrapper = sql`now()`): SQL {
  return sql`(select count(*)::int from appointment_plan_item booked
    join appointment booked_appointment on booked_appointment.organization_id = booked.organization_id
      and booked_appointment.id = booked.appointment_id
    where booked.organization_id = ${item.organizationId} and booked.plan_item_id = ${item.id}
      and ${standingForSql(
        {
          id: sql`booked_appointment.id`,
          organizationId: sql`booked_appointment.organization_id`,
          status: sql`booked_appointment.status`,
          startsAt: sql`booked_appointment.starts_at`,
          arrivedAt: sql`booked_appointment.arrived_at`,
        },
        item.id,
        now,
      )})`
}

/** Puede llevar otra cita, en SQL, sobre una fila de `treatment_plan_item` (o un alias). */
export function canBookAnotherSql(
  item: { id: SQLWrapper; organizationId: SQLWrapper; status: SQLWrapper; decisionStatus: SQLWrapper; plannedSessions: SQLWrapper },
  now: SQLWrapper = sql`now()`,
): SQL {
  return sql`(${item.decisionStatus} = 'aceptado' and ${item.status} in (${list(TO_SCHEDULE_STATUSES)})
    and ${item.plannedSessions} > ${sessionsDoneSql(item)} + ${bookedSessionsSql(item, now)})`
}

/** Hechas y en pie de cada tratamiento, en una sola consulta. Los que no existen no aparecen. */
export async function sessionCountsOf(tx: Db, orgId: string, itemIds: readonly string[]): Promise<Map<string, SessionCount>> {
  const ids = [...new Set(itemIds)]
  if (ids.length === 0) return new Map()
  const item = { id: sql`counted.id`, organizationId: sql`counted.organization_id` }
  const rows = await tx.execute<{ id: string; done: number; booked: number }>(sql`
    select counted.id, ${sessionsDoneSql(item)} as done, ${bookedSessionsSql(item)} as booked
    from treatment_plan_item counted
    where counted.organization_id = ${orgId} and counted.id in (${list(ids)})`)
  return new Map(rows.map((row) => [row.id, { done: Number(row.done), booked: Number(row.booked) }]))
}

/**
 * En qué sesión quedó un tratamiento con una atención ya hecha: `n` cuenta las
 * atenciones no anuladas con un procedimiento vigente del tratamiento hasta
 * esta (por su inicio, y por su id si empezaron a la vez), con la regla de
 * `sessionsDoneSql`; `m`, las previstas; `finished`, que esta fue la que lo
 * terminó (realizado, y ninguna hecha después).
 */
export interface EncounterSession {
  encounterId: string
  planItemId: string
  n: number
  m: number
  finished: boolean
}

/** La clave de `encounterSessionsOf`: la atención y el tratamiento. */
export const encounterSessionKey = (encounterId: string, planItemId: string) => `${encounterId}:${planItemId}`

/**
 * La sesión de cada tratamiento hecho en esas atenciones, en una sola consulta.
 * Lo usan la Historia (la tarjeta de la atención) y la historia de la pieza,
 * para decir «sesión 1 de 2» y no «Realizado» con el tratamiento en curso
 * (tercer repaso del 9 nov, E8 y E12). Las anuladas no tienen sesión.
 */
export async function encounterSessionsOf(
  tx: Db,
  orgId: string,
  encounterIds: readonly string[],
): Promise<Map<string, EncounterSession>> {
  const ids = [...new Set(encounterIds)]
  if (ids.length === 0) return new Map()
  const item = { id: sql`session_item.id`, organizationId: sql`session_item.organization_id` }
  const rows = await tx.execute<{ encounter_id: string; plan_item_id: string; status: string; m: number; n: number; done: number }>(sql`
    select distinct here.encounter_id, session_item.id as plan_item_id, session_item.status,
      session_item.planned_sessions as m,
      (select count(distinct earlier_procedure.encounter_id)::int from encounter_procedure earlier_procedure
        join encounter earlier on earlier.organization_id = earlier_procedure.organization_id
          and earlier.id = earlier_procedure.encounter_id
        where earlier_procedure.organization_id = session_item.organization_id
          and earlier_procedure.plan_item_id = session_item.id
          and earlier_procedure.voided_at is null and earlier.status <> 'anulada'
          and (earlier.started_at, earlier.id) <= (this_encounter.started_at, this_encounter.id)) as n,
      ${sessionsDoneSql(item)} as done
    from encounter_procedure here
    join encounter this_encounter on this_encounter.organization_id = here.organization_id
      and this_encounter.id = here.encounter_id
    join treatment_plan_item session_item on session_item.organization_id = here.organization_id
      and session_item.id = here.plan_item_id
    where here.organization_id = ${orgId} and here.encounter_id in (${list(ids)})
      and here.voided_at is null and this_encounter.status <> 'anulada'`)
  return new Map(
    rows.map((row) => {
      const n = Number(row.n)
      const session: EncounterSession = {
        encounterId: row.encounter_id,
        planItemId: row.plan_item_id,
        n,
        m: Number(row.m),
        finished: row.status === "realizado" && n >= Number(row.done),
      }
      return [encounterSessionKey(row.encounter_id, row.plan_item_id), session]
    }),
  )
}

/** La persona no tiene ninguna cita por venir. */
export function noUpcomingAppointmentSql(
  patient: { id: SQLWrapper; organizationId: SQLWrapper },
  now: SQLWrapper = sql`now()`,
): SQL {
  return sql`not exists (select 1 from appointment upcoming
    where upcoming.organization_id = ${patient.organizationId} and upcoming.patient_id = ${patient.id}
      and upcoming.status in (${list(LIVE_APPOINTMENT_STATUSES)}) and upcoming.starts_at > ${now})`
}

/** El día de una fecha en la zona de la clínica, como «2026-11-06». */
export function dayKeyIn(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(date)
}

/**
 * Control vencido sin cita, en código: pendiente, su día ya pasó en la zona de
 * la clínica y la persona no tiene ninguna cita por venir (`nextAppointmentAt`).
 */
export function isOverdueControl(
  control: { status: string; dueAt: Date },
  nextAppointmentAt: Date | null,
  timezone: string,
  now: Date = new Date(),
): boolean {
  return control.status === "pendiente" && dayKeyIn(control.dueAt, timezone) < dayKeyIn(now, timezone) && !nextAppointmentAt
}

const DAY_MS = 86_400_000

/**
 * Desde cuándo una visita cumple un control (ADR 0152): su ventana abre
 * `max(2 días, 25 % del intervalo)` antes de su día, donde el intervalo va de
 * cuando se indicó a su día, y nunca antes de que se indicara. Un control a 6
 * meses abre unos 45 días antes; uno a 7 días, 2 días antes. No tiene fin: un
 * control vencido sigue cumpliéndose con la próxima visita. Cambia junto con
 * `controlWindowStartSql`.
 */
export function controlWindowStart(control: { dueAt: Date; createdAt: Date }): Date {
  const interval = control.dueAt.getTime() - control.createdAt.getTime()
  const opens = control.dueAt.getTime() - Math.max(2 * DAY_MS, interval / 4)
  return new Date(Math.max(control.createdAt.getTime(), opens))
}

/**
 * La ventana del control ya abrió hoy, en días de la zona de la clínica. Un
 * control indicado hoy no se cumple hoy: la visita en que se indicó no es la
 * que lo cumple.
 */
export function isControlWindowOpen(
  control: { dueAt: Date; createdAt: Date },
  timezone: string,
  now: Date = new Date(),
): boolean {
  const today = dayKeyIn(now, timezone)
  return dayKeyIn(controlWindowStart(control), timezone) <= today && dayKeyIn(control.createdAt, timezone) < today
}

/**
 * Una cita por venir le sirve al control pendiente: cae, en días de la zona de
 * la clínica, desde que abre su ventana hasta 30 días después de su fecha, como
 * `appointmentServesControlSql` (ADR 0152). Una cita mucho más lejana no lo
 * cumple a tiempo: el control sigue «por reservar» (QA del 8 nov, M6: la ficha
 * decía que una resina de noviembre cumplía un control de mayo y el Plan, que
 * no tenía cita). La usan «Qué sigue», el Resumen y el Plan.
 */
export function appointmentServesControl(
  control: { dueAt: Date; createdAt: Date },
  appointmentAt: Date,
  timezone: string,
): boolean {
  const day = dayKeyIn(appointmentAt, timezone)
  const latest = new Date(control.dueAt.getTime() + CONTROL_SERVED_DAYS_AFTER * DAY_MS)
  return day >= dayKeyIn(controlWindowStart(control), timezone) && appointmentAt.getTime() <= latest.getTime()
}

/**
 * La persona tiene hoy una cita viva (por venir hoy, en la sala o en atención) y
 * la ventana del control ya abrió: al firmar su atención de hoy el control se
 * cumple (ADR 0152). No está «vencido» ni falta reservarle nada, aunque la hora
 * de esa cita ya haya pasado (revisión del 7 nov: la ficha decía «Control vencido
 * · sin cita por venir» a quien estaba en la sala). `todayAt` es el inicio de la
 * primera cita viva de hoy (`todayLiveAppointments`).
 */
export function servedToday(
  control: { status: string; dueAt: Date; createdAt: Date },
  todayAt: Date | null,
  timezone: string,
  now: Date = new Date(),
): boolean {
  return (
    control.status === "pendiente" &&
    todayAt !== null &&
    dayKeyIn(todayAt, timezone) === dayKeyIn(now, timezone) &&
    isControlWindowOpen(control, timezone, now)
  )
}

/** Vencido sin cita y sin cumplirse hoy: `isOverdueControl` salvo que se cumpla con su atención de hoy. */
export function isOverdueToday(
  control: { status: string; dueAt: Date; createdAt: Date },
  nextAppointmentAt: Date | null,
  todayAt: Date | null,
  timezone: string,
  now: Date = new Date(),
): boolean {
  return isOverdueControl(control, nextAppointmentAt, timezone, now) && !servedToday(control, todayAt, timezone, now)
}

/** La primera cita viva de hoy de cada persona, en la zona de la clínica (la haya pasado su hora o no). */
export async function todayLiveAppointments(
  tx: Db,
  orgId: string,
  patientIds: readonly string[],
  timezone: string,
): Promise<Map<string, { id: string; startsAt: Date }>> {
  const ids = [...new Set(patientIds)]
  if (ids.length === 0) return new Map()
  const rows = await tx.execute<{ id: string; patientId: string; startsAt: Date | string }>(sql`
    select distinct on (patient_id) id, patient_id as "patientId", starts_at as "startsAt" from appointment
    where organization_id = ${orgId} and patient_id in (${list(ids)})
      and status in (${list(LIVE_APPOINTMENT_STATUSES)})
      and (starts_at at time zone ${timezone})::date = (now() at time zone ${timezone})::date
    order by patient_id, starts_at`)
  return new Map(rows.map((row) => [row.patientId, { id: row.id, startsAt: new Date(row.startsAt) }]))
}

/**
 * El próximo control de la persona, con el orden de «Qué sigue»: primero el
 * que falta reservar (pendiente) y, entre iguales, el de fecha más cercana.
 * Solo cuentan los abiertos (pendiente o programado).
 */
export function nextControlOf<T extends { status: string; dueAt: Date }>(controls: readonly T[]): T | null {
  const open = controls.filter((control) => control.status === "pendiente" || control.status === "programado")
  return (
    [...open].sort(
      (a, b) =>
        Number(b.status === "pendiente") - Number(a.status === "pendiente") || a.dueAt.getTime() - b.dueAt.getTime(),
    )[0] ?? null
  )
}

/** `controlWindowStart` en SQL, sobre una fila de `clinical_follow_up` (o un alias). */
export function controlWindowStartSql(control: { dueAt: SQLWrapper; createdAt: SQLWrapper }): SQL {
  return sql`greatest(${control.createdAt}, ${control.dueAt} - greatest(interval '2 days', (${control.dueAt} - ${control.createdAt}) * 0.25))`
}

/** `isControlWindowOpen` en SQL: el día en que abre su ventana ya llegó y no se indicó hoy. */
export function controlWindowOpenSql(
  control: { dueAt: SQLWrapper; createdAt: SQLWrapper },
  timezone: string,
  now: SQLWrapper = sql`now()`,
): SQL {
  return sql`((${controlWindowStartSql(control)} at time zone ${timezone})::date <= (${now} at time zone ${timezone})::date
    and (${control.createdAt} at time zone ${timezone})::date < (${now} at time zone ${timezone})::date)`
}

/** Hasta cuántos días después de su fecha una cita por venir todavía le sirve a un control. */
export const CONTROL_SERVED_DAYS_AFTER = 30

/**
 * Una cita por venir le sirve al control (ADR 0152): cae desde que abre su
 * ventana hasta 30 días después de su fecha. «Avisar un control» calla solo
 * entonces; una cita mucho más lejana no lo cumple a tiempo.
 */
export function appointmentServesControlSql(
  control: { organizationId: SQLWrapper; patientId: SQLWrapper; dueAt: SQLWrapper; createdAt: SQLWrapper },
  now: SQLWrapper = sql`now()`,
): SQL {
  return sql`exists (select 1 from appointment serving
    where serving.organization_id = ${control.organizationId} and serving.patient_id = ${control.patientId}
      and serving.status in (${list(LIVE_APPOINTMENT_STATUSES)}) and serving.starts_at > ${now}
      and serving.starts_at >= ${controlWindowStartSql(control)}
      and serving.starts_at <= ${control.dueAt} + make_interval(days => ${CONTROL_SERVED_DAYS_AFTER}))`
}

/** Control vencido sin cita, en SQL, sobre una fila de `clinical_follow_up` (o un alias). */
export function overdueControlSql(
  control: { organizationId: SQLWrapper; patientId: SQLWrapper; status: SQLWrapper; dueAt: SQLWrapper },
  timezone: string,
): SQL {
  return sql`(${control.status} = 'pendiente'
    and (${control.dueAt} at time zone ${timezone})::date < (now() at time zone ${timezone})::date
    and ${noUpcomingAppointmentSql({ id: control.patientId, organizationId: control.organizationId })})`
}

/** Pacientes activos y que no son de prueba con algo aceptado y sin cita: Pacientes › «Por agendar» y su fila de Inicio. */
export async function patientsToSchedule(
  tx: Db,
  orgId: string,
  phases: readonly string[],
): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    select distinct p.id from treatment_plan_item i
    join patient p on p.organization_id = i.organization_id and p.id = i.patient_id
    join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id and pp.is_active and not pp.is_test
    where i.organization_id = ${orgId}
      and ${toScheduleSql(planItemSql("i"), phases)}`)
  return rows.map((row) => row.id)
}

/** Pacientes activos y que no son de prueba con un control vencido y sin cita: Pacientes › «Control vencido» y su fila de Inicio. */
export async function patientsWithOverdueControl(tx: Db, orgId: string, timezone: string): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    select distinct p.id from clinical_follow_up f
    join patient p on p.organization_id = f.organization_id and p.id = f.patient_id
    join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id and pp.is_active and not pp.is_test
    where f.organization_id = ${orgId}
      and ${overdueControlSql({ organizationId: sql`f.organization_id`, patientId: sql`f.patient_id`, status: sql`f.status`, dueAt: sql`f.due_at` }, timezone)}`)
  return rows.map((row) => row.id)
}

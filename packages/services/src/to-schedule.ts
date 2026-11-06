import type { Db } from "@odentia/db"
import { type SQL, type SQLWrapper, sql } from "drizzle-orm"

/**
 * Lo que falta agendar, con una sola regla para cada pregunta (propuestas O1 y
 * L3 de la ronda de QA del 2026-11-04). La usan Inicio, Pacientes, «Qué sigue»,
 * Reportes y las líneas de Argos: una pantalla no cuenta con otra regla.
 *
 * - **Aceptó y no tiene cita**: un tratamiento aceptado que aún se hace
 *   (pendiente, programado o en curso) y que ninguna cita por venir lleva. Otra cita de la
 *   persona no lo agenda: «Qué sigue» lo dice («su cita del 12 dic no lo lleva»).
 * - **Control vencido sin cita**: un control pendiente cuyo día ya pasó, de una
 *   persona sin ninguna cita por venir. A un control le sirve cualquier visita:
 *   la cita no tiene que llevarlo.
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

/** Aceptó y no tiene cita, en SQL, sobre una fila de `treatment_plan_item` (o un alias). */
export function toScheduleSql(
  item: { id: SQLWrapper; organizationId: SQLWrapper; status: SQLWrapper; decisionStatus: SQLWrapper },
  now: SQLWrapper = sql`now()`,
): SQL {
  return sql`(${item.decisionStatus} = 'aceptado' and ${item.status} in (${list(TO_SCHEDULE_STATUSES)})
    and not ${carriedByUpcomingSql(item, now)})`
}

/**
 * El presupuesto tiene una línea aceptada cuyo tratamiento sigue sin cita
 * (`toScheduleSql`): la línea de Argos y su tarea. `extra` acota el tratamiento
 * (`scheduled_item`), por ejemplo a lo que va en curso.
 */
export function budgetToScheduleSql(
  budget: { id: SQLWrapper; organizationId: SQLWrapper },
  now: SQLWrapper = sql`now()`,
  extra: SQL = sql``,
): SQL {
  return sql`exists (select 1 from treatment_budget_item scheduled_line
    join treatment_plan_item scheduled_item on scheduled_item.organization_id = scheduled_line.organization_id
      and scheduled_item.id = scheduled_line.plan_item_id
    where scheduled_line.organization_id = ${budget.organizationId} and scheduled_line.budget_id = ${budget.id}
      and scheduled_line.decision = 'aceptado' ${extra}
      and ${toScheduleSql(
        {
          id: sql`scheduled_item.id`,
          organizationId: sql`scheduled_item.organization_id`,
          status: sql`scheduled_item.status`,
          decisionStatus: sql`scheduled_item.decision_status`,
        },
        now,
      )})`
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

/** Control vencido sin cita, en SQL, sobre una fila de `clinical_follow_up` (o un alias). */
export function overdueControlSql(
  control: { organizationId: SQLWrapper; patientId: SQLWrapper; status: SQLWrapper; dueAt: SQLWrapper },
  timezone: string,
): SQL {
  return sql`(${control.status} = 'pendiente'
    and (${control.dueAt} at time zone ${timezone})::date < (now() at time zone ${timezone})::date
    and ${noUpcomingAppointmentSql({ id: control.patientId, organizationId: control.organizationId })})`
}

/** Pacientes activos con algo aceptado y sin cita: Pacientes › «Por agendar» y su fila de Inicio. */
export async function patientsToSchedule(tx: Db, orgId: string): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    select distinct p.id from treatment_plan_item i
    join patient p on p.organization_id = i.organization_id and p.id = i.patient_id
    join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id and pp.is_active
    where i.organization_id = ${orgId}
      and ${toScheduleSql({ id: sql`i.id`, organizationId: sql`i.organization_id`, status: sql`i.status`, decisionStatus: sql`i.decision_status` })}`)
  return rows.map((row) => row.id)
}

/** Pacientes activos con un control vencido y sin cita: Pacientes › «Control vencido» y su fila de Inicio. */
export async function patientsWithOverdueControl(tx: Db, orgId: string, timezone: string): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    select distinct p.id from clinical_follow_up f
    join patient p on p.organization_id = f.organization_id and p.id = f.patient_id
    join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id and pp.is_active
    where f.organization_id = ${orgId}
      and ${overdueControlSql({ organizationId: sql`f.organization_id`, patientId: sql`f.patient_id`, status: sql`f.status`, dueAt: sql`f.due_at` }, timezone)}`)
  return rows.map((row) => row.id)
}

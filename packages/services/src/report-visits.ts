import { type SQL, sql } from "drizzle-orm"

/**
 * Cada vez que vino una persona, con una sola regla (estudio de la atención, entrega 8): una
 * cita atendida o una atención firmada sin cita; la atención de una cita cuenta con su cita, no
 * dos veces. Es la regla de la vista `argos.pacientes` (migración 0047), de la primera visita, de
 * «Última visita» de Pacientes, de los activos y «sin venir» de Reportes y de «Invitar a volver»;
 * «vinieron» del embudo (`funnelSql`) también acepta una atención firmada. Las citas de prueba no
 * cuentan. Quien solo se atiende sin cita (Marta, dos veces hoy; la medida al paso de vistIA)
 * también vino.
 *
 * Filas `(id, patient_id, starts_at, branch_id, service_name, professional_user_id,
 * appointment_id)`: `id` es el de la visita (la cita o la atención) y `appointment_id`, el de la
 * cita, nulo si vino sin cita. `patient`: solo las de ese paciente (una columna de la consulta de
 * afuera o un valor).
 */
export function visitRowsSql(orgId: string, patient?: SQL): SQL {
  return sql`
        select id, patient_id, starts_at, branch_id, service_name, professional_user_id, id as appointment_id
        from appointment where organization_id=${orgId} and status='atendida' and not is_test
          ${patient ? sql`and patient_id = ${patient}` : sql``}
        union all
        select id, patient_id, started_at, branch_id, null::text, professional_user_id, null::uuid
        from encounter where organization_id=${orgId} and status='finalizada' and voided_at is null and appointment_id is null
          ${patient ? sql`and patient_id = ${patient}` : sql``}`
}

/**
 * Cuándo fue la última visita de un paciente (`visitRowsSql`), o nulo si nunca vino: «Última
 * visita» de Pacientes. `patient` es la columna del paciente de la consulta de afuera.
 */
export function lastVisitAtSql(orgId: string, patient: SQL): SQL {
  return sql`(select max(v.starts_at) from (${visitRowsSql(orgId, patient)}) v)`
}

/**
 * La primera vez que vino cada persona: su primera visita (`visitRowsSql`).
 * `first_visit(id, patient_id, starts_at, branch_id, service_name, professional_user_id)`.
 */
export function firstVisitSql(orgId: string): SQL {
  return sql`first_visit as (
      select distinct on (patient_id) id, patient_id, starts_at, branch_id, service_name, professional_user_id
      from (${visitRowsSql(orgId)}) visit
      order by patient_id, starts_at, id
    )`
}

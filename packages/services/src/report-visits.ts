import { type SQL, sql } from "drizzle-orm"

/**
 * La primera vez que vino cada persona: su primera cita atendida o su primera
 * atención firmada sin cita, lo que pasó antes. La misma regla que «Vinieron»
 * en el embudo de Pacientes (`funnelSql`). Las citas de prueba no cuentan.
 * `first_visit(id, patient_id, starts_at, branch_id, service_name, professional_user_id)`.
 */
export function firstVisitSql(orgId: string): SQL {
  return sql`first_visit as (
      select distinct on (patient_id) id, patient_id, starts_at, branch_id, service_name, professional_user_id
      from (
        select id, patient_id, starts_at, branch_id, service_name, professional_user_id
        from appointment where organization_id=${orgId} and status='atendida' and not is_test
        union all
        select id, patient_id, started_at, branch_id, null::text, professional_user_id
        from encounter where organization_id=${orgId} and status='finalizada' and voided_at is null and appointment_id is null
      ) visit
      order by patient_id, starts_at, id
    )`
}

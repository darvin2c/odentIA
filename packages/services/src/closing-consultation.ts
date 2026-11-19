/**
 * La consulta ya marcada al firmar (mesa del cierre de la atención, 19 nov 2026). Casi todas las
 * clínicas cobran la consulta, y una consulta sin nada registrado se firmaba con «No se carga
 * nada»: la evaluación de S/ 50 de la cita no la cobraba nadie. Ahora, si hoy no se registró nada
 * hecho, el cierre la trae marcada con su precio; quien firma la cambia o la desmarca.
 *
 * Ningún dato dice cuál es «la consulta de la clínica» (desarrollo y el auditor de la mesa): se
 * elige la de la cita si su servicio es una consulta; si no, la que más cobró la clínica en los
 * últimos 6 meses; si no, la primera de la biblioteca del producto. Son consultas los servicios de
 * la biblioteca de consulta y evaluación del producto y los que la clínica usa como evaluación de
 * otros servicios (`evaluation_service_id`). Una visita que cumple un control no la propone, salvo
 * en el producto que cobra el control (latidIA), que propone su consulta de control.
 */
import type { Db } from "@odentia/db"
import { sql } from "drizzle-orm"
import { productHooks } from "./products.js"

export interface ConsultationOption {
  serviceId: string
  name: string
  priceCents: number
  currency: string
  /** Por qué viene primero: la de su cita, la que más cobra la clínica o la de la biblioteca. */
  reason: "cita" | "mas-cobrada" | "biblioteca"
}

export interface ClosingConsultation {
  /** La que viene marcada. */
  proposed: ConsultationOption
  /** Todas las que la clínica tiene con precio, para «Cambiar». */
  options: ConsultationOption[]
}

/** Lo que el cierre necesita saber de la visita: si ya se hizo algo y si cumple un control. */
export interface ConsultationVisit {
  encounterId: string
  patientId: string
  appointmentId: string | null
  startedAt: Date
  hasProcedures: boolean
  controlVisit: boolean
}

export async function closingConsultationOf(
  tx: Db,
  orgId: string,
  visit: ConsultationVisit,
): Promise<ClosingConsultation | null> {
  if (visit.hasProcedures) return null
  const { consultation } = await productHooks(tx, orgId)
  const keys = visit.controlVisit ? consultation.controlTemplateKeys : consultation.templateKeys
  if (!keys || keys.length === 0) return null
  const keyList = sql.join(
    keys.map((key) => sql`${key}`),
    sql`, `,
  )
  // Con un control, solo la consulta de control de la biblioteca; sin él, también las que la
  // clínica usa como evaluación de sus servicios.
  const evaluations = visit.controlVisit
    ? sql`false`
    : sql`s.id in (select e.evaluation_service_id from service_catalog e
        where e.organization_id = ${orgId} and e.evaluation_service_id is not null)`
  const rows = await tx.execute<{
    id: string
    name: string
    price_cents: number
    currency: string
    template_rank: number | null
    charged: number
  }>(sql`
    select s.id, s.name, s.price_cents, s.currency,
      array_position(array[${keyList}]::text[], tt.key) as template_rank,
      (select count(*)::int from encounter_procedure ep
        join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id
        where ep.organization_id = s.organization_id and ep.service_id = s.id and ep.voided_at is null
          and e.status = 'finalizada' and e.finalized_at >= now() - interval '6 months') as charged
    from service_catalog s
    left join catalog.treatment_template tt on tt.id = s.template_id
    where s.organization_id = ${orgId} and s.is_active and s.price_cents > 0
      and (tt.key in (${keyList}) or ${evaluations})
    order by s.name, s.id`)
  if (rows.length === 0) return null
  // Ya se cargó la consulta de esta visita (recepción la cobró al llegar): no se propone otra.
  const [already] = await tx.execute<{ id: string }>(sql`
    select c.id from patient_charge c
    where c.organization_id = ${orgId} and c.patient_id = ${visit.patientId} and c.voided_at is null
      and c.created_at >= ${visit.startedAt.toISOString()}::timestamptz - interval '12 hours'
      and c.description in (${sql.join(
        rows.map((row) => sql`${row.name}`),
        sql`, `,
      )})
    limit 1`)
  if (already) return null
  const [booked] = visit.appointmentId
    ? await tx.execute<{ service_id: string | null }>(sql`
        select service_id from appointment where organization_id = ${orgId} and id = ${visit.appointmentId}`)
    : []
  const option = (row: (typeof rows)[number], reason: ConsultationOption["reason"]): ConsultationOption => ({
    serviceId: row.id,
    name: row.name,
    priceCents: Number(row.price_cents),
    currency: row.currency,
    reason,
  })
  const fromBooking = rows.find((row) => row.id === booked?.service_id)
  const mostCharged = [...rows].sort((a, b) => Number(b.charged) - Number(a.charged))[0]
  const fromLibrary = [...rows]
    .filter((row) => row.template_rank !== null)
    .sort((a, b) => Number(a.template_rank) - Number(b.template_rank))[0]
  const proposed = fromBooking
    ? option(fromBooking, "cita")
    : mostCharged && Number(mostCharged.charged) > 0
      ? option(mostCharged, "mas-cobrada")
      : option(fromLibrary ?? rows[0]!, "biblioteca")
  return {
    proposed,
    options: rows.map((row) => option(row, row.id === proposed.serviceId ? proposed.reason : "biblioteca")),
  }
}

import type { Db } from "@odentia/db"
import { patientCharge } from "@odentia/db/schema/clinical"
import { and, eq, inArray, isNotNull, type SQL, sql } from "drizzle-orm"

/** La clave del cargo de un adelanto para un tratamiento (`advanceForBudgetItemId`), con la del cobro. */
export const ADVANCE_KEY = "adelanto:"

/**
 * Lo cobrado de un tratamiento que se devolvió entero (ADR 0068): una devolución
 * parcial deja un concepto con lo devuelto (`returned_cents`), pero la total lo
 * anula sin reemplazo, y sin esto el tratamiento parecería nunca cobrado y la
 * siguiente atención lo cobraría otra vez. Es el último concepto de su cadena
 * (`original_charge_id`), anulado por una devolución (su pago guarda `return_id`)
 * y sin otro que lo reemplace. Un adelanto devuelto no cuenta: se devuelve entero
 * justamente para que el tratamiento se cobre al atenderlo. Lo anulado con
 * «Anular concepto» o «Anular ticket» tampoco: corrige un error al cobrar.
 *
 * `charge` es el nombre del concepto en la consulta (`sql.raw('"patient_charge"')`
 * o un alias): la misma regla para las cuentas que se hacen en SQL.
 */
export function wholeReturnedChargeSql(charge: SQL): SQL {
  return sql`(${charge}.voided_at is not null
    and coalesce(${charge}.request_key, '') not like ${`${ADVANCE_KEY}%`}
    and exists (select 1 from patient_payment_application returned_app
      where returned_app.organization_id = ${charge}.organization_id and returned_app.charge_id = ${charge}.id
        and returned_app.return_id is not null)
    and not exists (select 1 from patient_charge successor
      where successor.organization_id = ${charge}.organization_id
        and successor.original_charge_id = coalesce(${charge}.original_charge_id, ${charge}.id)
        and successor.created_at > ${charge}.created_at))`
}

/** Lo cobrado de un tratamiento que una devolución se llevó entero. */
export interface WholeReturnedCharge {
  chargeId: string
  planItemId: string
  encounterProcedureId: string | null
  currency: string
  createdAt: Date
  /** Lo que se cobró de él: importe más lo devuelto antes y lo descontado (el total de la cadena). */
  chargedCents: number
  /** Lo devuelto de la cadena, que es todo lo que se pagó: lo cobrado sin lo descontado. */
  returnedCents: number
}

/** Los conceptos de tratamientos devueltos enteros de una persona (`wholeReturnedChargeSql`). */
export async function wholeReturnedCharges(
  tx: Db,
  orgId: string,
  patientId: string,
  /** Sin lista: todos los tratamientos de la persona. */
  planItemIds?: string[],
): Promise<WholeReturnedCharge[]> {
  if (planItemIds?.length === 0) return []
  const rows = await tx
    .select({
      chargeId: patientCharge.id,
      planItemId: patientCharge.planItemId,
      encounterProcedureId: patientCharge.encounterProcedureId,
      currency: patientCharge.currency,
      createdAt: patientCharge.createdAt,
      chargedCents: sql<number>`${patientCharge.amountCents} + ${patientCharge.returnedCents} + ${patientCharge.discountCents}`.mapWith(Number),
      returnedCents: sql<number>`${patientCharge.amountCents} + ${patientCharge.returnedCents}`.mapWith(Number),
    })
    .from(patientCharge)
    .where(
      and(
        eq(patientCharge.organizationId, orgId),
        eq(patientCharge.patientId, patientId),
        planItemIds ? inArray(patientCharge.planItemId, planItemIds) : isNotNull(patientCharge.planItemId),
        wholeReturnedChargeSql(sql.raw('"patient_charge"')),
      ),
    )
    .orderBy(patientCharge.createdAt)
  return rows.flatMap((row) => (row.planItemId ? [{ ...row, planItemId: row.planItemId }] : []))
}

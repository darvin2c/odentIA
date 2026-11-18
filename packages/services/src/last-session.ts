/**
 * Quién hizo la última sesión de un tratamiento y en qué sede (mesa del 17 nov, hallazgo 3 de la
 * clínica): «Reservar la sesión 2» la propone primero con esa persona y en esa sede, aunque la
 * agenda ofrezca el servicio a otra especialidad (ADR 0039). La odontóloga general que empezó la
 * endodoncia sigue con ella. Propone, no obliga: la reserva deja elegir a otro.
 */
import type { Db } from "@odentia/db"
import { sql } from "drizzle-orm"

export interface LastSession {
  professionalUserId: string
  professionalName: string | null
  /** La sede de esa atención; nula si no tenía o ya no está activa. */
  branchId: string | null
}

/**
 * La última sesión de cada tratamiento de `itemIds`: su procedimiento vigente más reciente, en una
 * atención no anulada. Solo si quien la hizo sigue en la clínica; los que no tienen sesión no vienen.
 */
export async function lastSessionOf(
  tx: Db,
  orgId: string,
  itemIds: readonly string[],
): Promise<Map<string, LastSession>> {
  const ids = [...new Set(itemIds)]
  if (ids.length === 0) return new Map()
  const rows = await tx.execute<{
    item_id: string
    professional_user_id: string
    professional_name: string | null
    branch_id: string | null
  }>(sql`
    select distinct on (p.plan_item_id) p.plan_item_id as item_id, e.professional_user_id,
      u.name as professional_name, b.id as branch_id
    from encounter_procedure p
    join encounter e on e.organization_id = p.organization_id and e.id = p.encounter_id and e.status <> 'anulada'
    join member m on m.organization_id = e.organization_id and m.user_id = e.professional_user_id
    left join "user" u on u.id = e.professional_user_id
    left join branch b on b.organization_id = e.organization_id and b.id = e.branch_id and b.is_active
    where p.organization_id = ${orgId} and p.voided_at is null
      and p.plan_item_id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
    order by p.plan_item_id, p.created_at desc, p.id desc`)
  return new Map(
    [...rows].map((row) => [
      row.item_id,
      {
        professionalUserId: row.professional_user_id,
        professionalName: row.professional_name,
        branchId: row.branch_id,
      },
    ]),
  )
}

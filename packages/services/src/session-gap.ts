/**
 * Desde qué día se propone la próxima sesión de un tratamiento (QA del 9 nov,
 * repaso 3, M1): la sesión 2 de una endodoncia con hidróxido de calcio se
 * proponía para mañana. Es el día de la última sesión hecha más los días que su
 * tipo de tratamiento deja entre sesiones (`ProductHooks.sessionGapDays`); sin
 * sesión hecha o sin espera propia, nada (la reserva busca desde mañana, como
 * siempre). Lo usan la reserva desde el cierre, «Qué sigue» y lo que va después
 * de una endodoncia que todavía no tiene su próxima cita: una sola regla.
 *
 * Propone, no exige: la reserva deja elegir antes.
 */
import type { Db } from "@odentia/db"
import { sql } from "drizzle-orm"
import { findOrgLocale } from "./locale.js"
import { productHooks } from "./products.js"

/** `YYYY-MM-DD` en la zona de la clínica. */
function dayIn(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).format(date)
}

function addDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number)
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10)
}

/**
 * El primer día (`YYYY-MM-DD`, zona de la clínica) en que conviene la próxima sesión de cada
 * tratamiento de `itemIds` que espera algo después de su última sesión. Solo vienen los que
 * caen después de hoy.
 */
export async function nextSessionFromOf(
  tx: Db,
  orgId: string,
  itemIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(itemIds)]
  if (ids.length === 0) return new Map()
  const hooks = await productHooks(tx, orgId)
  if (!hooks.sessionGapDays) return new Map()
  const rows = await tx.execute<{
    id: string
    kind: string | null
    last_done: Date | string | null
  }>(sql`
    select item.id, template.specialty as kind,
      (select max(coalesce(done_encounter.finalized_at, done_procedure.created_at)) from encounter_procedure done_procedure
        join encounter done_encounter on done_encounter.organization_id = done_procedure.organization_id
          and done_encounter.id = done_procedure.encounter_id
        where done_procedure.organization_id = item.organization_id and done_procedure.plan_item_id = item.id
          and done_procedure.voided_at is null and done_encounter.status <> 'anulada') as last_done
    from treatment_plan_item item
    left join service_catalog service on service.organization_id = item.organization_id and service.id = item.service_id
    left join treatment_template template on template.id = service.template_id
    where item.organization_id = ${orgId} and item.id in (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`)
  const { timezone } = await findOrgLocale(tx, orgId)
  const today = dayIn(new Date(), timezone)
  const out = new Map<string, string>()
  for (const row of rows) {
    const gap = hooks.sessionGapDays(row.kind)
    if (!gap || !row.last_done) continue
    const from = addDays(dayIn(new Date(row.last_done), timezone), gap)
    if (from > today) out.set(row.id, from)
  }
  return out
}

/** Por qué se busca desde ese día, para el cajón de la reserva. */
export const SESSION_GAP_NOTE =
  "Entre sesiones se deja actuar la medicación: se busca hora desde una semana después de la anterior."

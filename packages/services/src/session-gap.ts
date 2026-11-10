/**
 * Desde qué día se propone la próxima sesión de un tratamiento (QA del 9 nov,
 * repaso 3, M1): la sesión 2 de una endodoncia con hidróxido de calcio se
 * proponía para mañana. Es el día de la última sesión hecha más los días que su
 * servicio deja entre sesiones; sin
 * sesión hecha o sin espera propia, nada (la reserva busca desde mañana, como
 * siempre). La espera es la de su servicio (`session_gap_days`, de la clínica o de la guía). Cuenta desde el día en que se registró la sesión, no desde la firma. Lo usan la reserva desde el cierre, «Qué sigue» y lo que va después
 * de una endodoncia que todavía no tiene su próxima cita: una sola regla.
 *
 * Propone, no exige: la reserva deja elegir antes.
 */

import { gapWords } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { sql } from "drizzle-orm"
import { findOrgLocale } from "./locale.js"

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

/** Desde qué día conviene la próxima sesión y cuántos días pide su servicio. */
export interface NextSessionGap {
  from: string
  days: number
}

/**
 * El primer día (`YYYY-MM-DD`, zona de la clínica) en que conviene la próxima sesión de cada
 * tratamiento de `itemIds` que espera algo después de su última sesión, con los días de espera
 * de su servicio (los de la clínica o los de la guía, `sessionGapSql`; decisión B5 del 10 nov).
 * Solo vienen los que caen después de hoy.
 */
export async function nextSessionGapOf(
  tx: Db,
  orgId: string,
  itemIds: readonly string[],
): Promise<Map<string, NextSessionGap>> {
  const ids = [...new Set(itemIds)]
  if (ids.length === 0) return new Map()
  const rows = await tx.execute<{
    id: string
    gap: number | null
    last_done: Date | string | null
  }>(sql`
    select item.id,
      coalesce(service.session_gap_days, template.session_gap_days, 0)::int as gap,
      (select max(done_procedure.created_at) from encounter_procedure done_procedure
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
  const out = new Map<string, NextSessionGap>()
  for (const row of rows) {
    const gap = Number(row.gap ?? 0)
    if (!gap || !row.last_done) continue
    const from = addDays(dayIn(new Date(row.last_done), timezone), gap)
    if (from > today) out.set(row.id, { from, days: gap })
  }
  return out
}

/** Solo el día, para quien no dice cuántos son. */
export async function nextSessionFromOf(
  tx: Db,
  orgId: string,
  itemIds: readonly string[],
): Promise<Map<string, string>> {
  const gaps = await nextSessionGapOf(tx, orgId, itemIds)
  return new Map([...gaps].map(([id, gap]) => [id, gap.from]))
}

/** Por qué se busca desde ese día, para el cajón de la reserva. */
export const SESSION_GAP_NOTE =
  "Su servicio pide esperar entre sesiones (por ejemplo, para que actúe la medicación): se busca hora desde ese día."

/** «Entre sesiones se espera una semana: …», con los días que pide su servicio. */
export function sessionGapNote(days: number): string {
  return `Entre sesiones se espera ${gapWords(days)}: se busca hora desde ese día.`
}

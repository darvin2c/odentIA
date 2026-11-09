/**
 * Lo que un tratamiento terminado resuelve (QA del 9 nov): la endodoncia de la
 * 46 terminaba y la pulpitis de la 46 seguía «Activo» para siempre. Al firmar,
 * el cierre propone, marcado, que el diagnóstico activo con el mismo código y
 * el mismo sitio que un tratamiento que hoy queda realizado pasa a
 * «resuelto»; quien firma lo desmarca si no (una pulpitis reversible con una
 * resina pide controlar la vitalidad). Solo se resuelve lo que la pantalla
 * mostró marcado (`resolveDiagnosisIds`): nada sin esa firma, y queda en la
 * actividad quién lo decidió. Solo con un sitio (una pieza): un diagnóstico de
 * la persona entera (una hipertensión) no lo resuelve un acto. Con caras (una
 * resina), solo si cubre todas las del diagnóstico: una resina O no resuelve
 * una caries OD.
 */
import type { Db } from "@odentia/db"
import { encounterDiagnosis } from "@odentia/db/schema/clinical"
import { auditEvent } from "@odentia/db/schema/org"
import { and, eq, inArray, sql } from "drizzle-orm"
import { diagnosisTitlesOf, namedDiagnosis } from "./diagnosis-codes.js"
import { productHooks } from "./products.js"

/** Un diagnóstico (o sus filas de varias atenciones) que un tratamiento de hoy resuelve. */
export interface ClosingResolvable {
  /** Las filas activas con ese código en ese sitio: se resuelven juntas. */
  diagnosisIds: string[]
  /** Los tratamientos trabajados hoy que lo resuelven si terminan (basta uno). */
  planItemIds: string[]
  /** «Pulpitis (CIE-11 DA09.0)». */
  label: string
  /** «pieza 46». */
  site: string | null
}

interface Row extends Record<string, unknown> {
  id: string
  plan_item_id: string
  diagnosis_system: string | null
  diagnosis_code: string
  site_system: string | null
  site_code: string | null
  site_qualifiers: string[] | null
}

/**
 * Los diagnósticos activos que resuelven los tratamientos trabajados hoy en la
 * atención (con un acto suyo vigente en ella). `done`: solo los que ya quedaron
 * realizados (al firmar, después de «¿Terminaste?»); sin él, también los abiertos
 * (el cierre los muestra según lo que se responda).
 */
export async function resolvableDiagnosesOf(
  tx: Db,
  orgId: string,
  patientId: string,
  encounterId: string,
  options: { done?: boolean } = {},
): Promise<ClosingResolvable[]> {
  const rows = await tx.execute<Row>(sql`
    select d.id, item.id as plan_item_id, d.diagnosis_system, d.diagnosis_code,
      d.site_system, d.site_code, d.site_qualifiers
    from treatment_plan_item item
    join encounter_diagnosis d
      on d.organization_id = item.organization_id and d.patient_id = item.patient_id
      and d.diagnosis_code = item.diagnosis_code
      and (item.diagnosis_system is null or d.diagnosis_system = item.diagnosis_system)
      and d.site_code = item.site_code and d.site_system is not distinct from item.site_system
      and (cardinality(item.site_qualifiers) = 0 or d.site_qualifiers <@ item.site_qualifiers)
    where item.organization_id = ${orgId} and item.patient_id = ${patientId}
      and item.site_code is not null and item.diagnosis_code is not null
      and ${options.done ? sql`item.status = 'realizado'` : sql`item.status in ('pendiente', 'programado', 'en_curso', 'realizado')`}
      and d.voided_at is null and d.status = 'activo'
      and exists (select 1 from encounter_procedure today
        where today.organization_id = item.organization_id and today.plan_item_id = item.id
          and today.encounter_id = ${encounterId} and today.voided_at is null)
    order by item.sort_order, item.created_at, item.id, d.created_at, d.id`)
  if (rows.length === 0) return []
  const site = (await productHooks(tx, orgId)).site
  const titles = await diagnosisTitlesOf(
    tx,
    rows.map((row) => ({ system: row.diagnosis_system, code: row.diagnosis_code })),
  )
  // Un diagnóstico por código y sitio, aunque lo hayan anotado en varias atenciones;
  // y uno solo aunque dos tratamientos de hoy lo resuelvan (el primero lo dice).
  const byKey = new Map<string, ClosingResolvable>()
  for (const row of rows) {
    const key = [row.diagnosis_system ?? "", row.diagnosis_code, row.site_system ?? "", row.site_code].join("|")
    const same = byKey.get(key)
    if (same) {
      if (!same.diagnosisIds.includes(row.id)) same.diagnosisIds.push(row.id)
      if (!same.planItemIds.includes(row.plan_item_id)) same.planItemIds.push(row.plan_item_id)
      continue
    }
    byKey.set(key, {
      diagnosisIds: [row.id],
      planItemIds: [row.plan_item_id],
      label: namedDiagnosis(titles, row.diagnosis_system, row.diagnosis_code),
      site: site.words(
        { siteSystem: row.site_system, siteCode: row.site_code, siteQualifiers: row.site_qualifiers ?? [] },
        "short",
      ),
    })
  }
  return [...byKey.values()]
}

/**
 * Al firmar: deja resueltos los diagnósticos que la pantalla mostró marcados
 * (`resolve`), si un tratamiento que los resuelve quedó hoy realizado.
 */
export async function resolveDiagnosesOnSign(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  resolve: readonly string[],
  at: Date,
): Promise<number> {
  const wanted = new Set(resolve)
  if (wanted.size === 0) return 0
  const ids = (await resolvableDiagnosesOf(tx, orgId, patientId, encounterId, { done: true })).flatMap((found) =>
    found.diagnosisIds.filter((id) => wanted.has(id)).map((id) => ({ id, planItemId: found.planItemIds[0] })),
  )
  if (ids.length === 0) return 0
  const resolved = await tx
    .update(encounterDiagnosis)
    .set({ status: "resuelto", resolvedAt: at, updatedAt: at })
    .where(
      and(
        eq(encounterDiagnosis.organizationId, orgId),
        eq(encounterDiagnosis.patientId, patientId),
        eq(encounterDiagnosis.status, "activo"),
        inArray(
          encounterDiagnosis.id,
          ids.map((row) => row.id),
        ),
      ),
    )
    .returning({ id: encounterDiagnosis.id })
  const planItemOf = new Map(ids.map((row) => [row.id, row.planItemId]))
  for (const row of resolved)
    await tx.insert(auditEvent).values({
      organizationId: orgId,
      actorUserId,
      action: "encounter.diagnosis_status",
      entity: "encounter_diagnosis",
      entityId: row.id,
      metadata: { patientId, from: "activo", to: "resuelto", encounterId, planItemId: planItemOf.get(row.id), onSign: true },
    })
  return resolved.length
}

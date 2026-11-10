/**
 * El consentimiento de cada tratamiento (consentimientos, 10 nov): va unido al tratamiento
 * (`planItemId`), no a la atención donde se preparó. Lo dicen el Plan y «Hoy viene a…» de
 * cualquier atención donde se haga, para firmarlo antes de empezar.
 */
import type { Db } from "@odentia/db"
import { sql } from "drizzle-orm"

/**
 * - `falta`: su servicio pide un consentimiento publicado y no hay ninguno preparado.
 * - `sin_firmar`: preparado, sin firmar.
 * - `por_confirmar`: lo firmó en su enlace; falta que quien atiende lo confirme con la persona.
 * - `firmado`: firmado (en la clínica, en papel o confirmado el del enlace).
 */
export type TreatmentConsentState = "falta" | "sin_firmar" | "por_confirmar" | "firmado"

/** El estado del consentimiento de cada tratamiento que lo pide; los que no lo piden no vienen. */
export async function treatmentConsentStates(
  tx: Db,
  orgId: string,
  planItemIds: readonly string[],
): Promise<Map<string, TreatmentConsentState>> {
  const ids = [...new Set(planItemIds)]
  if (ids.length === 0) return new Map()
  // Uno por cada plantilla que pide su servicio (una exodoncia puede pedir el suyo y el de la
  // anestesia): el tratamiento está firmado solo si lo están todos; lo que falte manda.
  const rows = await tx.execute<{ id: string; signed: boolean; link_signed: boolean; pending: boolean }>(sql`
    select item.id, t.key,
      exists (select 1 from consent_document d join consent_template dt on dt.id = d.template_id
        where d.organization_id = item.organization_id and dt.key = t.key
        and d.plan_item_id = item.id and d.status = 'firmado'
        and (item.consent_reset_at is null or d.signed_at > item.consent_reset_at)) as signed,
      exists (select 1 from consent_document d join consent_template dt on dt.id = d.template_id
        where d.organization_id = item.organization_id and dt.key = t.key
        and d.plan_item_id = item.id and d.status = 'pendiente' and d.person_signed_at is not null) as link_signed,
      exists (select 1 from consent_document d join consent_template dt on dt.id = d.template_id
        where d.organization_id = item.organization_id and dt.key = t.key
        and d.plan_item_id = item.id and d.status = 'pendiente') as pending
    from treatment_plan_item item
    join consent_template_service link on link.organization_id = item.organization_id and link.service_id = item.service_id
    join consent_template t on t.organization_id = link.organization_id and t.key = link.template_key
      and t.status = 'publicado'
    where item.organization_id = ${orgId}
      and item.id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
      and item.status not in ('realizado', 'cancelado')`)
  const rank: Record<TreatmentConsentState, number> = { falta: 0, sin_firmar: 1, por_confirmar: 2, firmado: 3 }
  const out = new Map<string, TreatmentConsentState>()
  for (const row of rows) {
    const state: TreatmentConsentState = row.signed
      ? "firmado"
      : row.link_signed
        ? "por_confirmar"
        : row.pending
          ? "sin_firmar"
          : "falta"
    const before = out.get(row.id)
    if (!before || rank[state] < rank[before]) out.set(row.id, state)
  }
  return out
}

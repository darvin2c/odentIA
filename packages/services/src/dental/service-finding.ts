import type { Db } from "@odentia/db"
import { serviceCatalog, treatmentTemplate } from "@odentia/db/schema/clinical"
import { dentalTemplateRule, serviceFinding } from "@odentia/db/schema/dental"
import type { LeavesFinding } from "@odentia/dental"
import { and, eq, sql } from "drizzle-orm"

/**
 * Lo que deja un servicio en la pieza (ADR 0079): vive en
 * `dental.service_finding` y, en la biblioteca, en `catalog.dental_template_rule`.
 * La API lo sigue diciendo en el servicio como `leavesFinding`.
 */

const asFinding = (value: unknown): LeavesFinding | null =>
  value === null || value === undefined
    ? null
    : typeof value === "string"
      ? JSON.parse(value)
      : (value as LeavesFinding)

/** `leavesFinding` de un servicio, para elegirlo junto con sus columnas. */
export const serviceLeavesFinding = sql<LeavesFinding | null>`(
  select jsonb_strip_nulls(jsonb_build_object('condition', ${serviceFinding.condition}, 'variant', ${serviceFinding.variant}))
  from ${serviceFinding}
  where ${serviceFinding.serviceId} = ${serviceCatalog.id} and ${serviceFinding.organizationId} = ${serviceCatalog.organizationId}
)`.mapWith(asFinding)

/** Lo dental de un tratamiento de la biblioteca: caras que admite y lo que deja en la pieza. */
export const templateDentalColumns = {
  surfaceCountMin: sql<number | null>`(
    select ${dentalTemplateRule.surfaceCountMin} from ${dentalTemplateRule} where ${dentalTemplateRule.templateId} = ${treatmentTemplate.id}
  )`.mapWith((value) => (value === null ? null : Number(value))),
  surfaceCountMax: sql<number | null>`(
    select ${dentalTemplateRule.surfaceCountMax} from ${dentalTemplateRule} where ${dentalTemplateRule.templateId} = ${treatmentTemplate.id}
  )`.mapWith((value) => (value === null ? null : Number(value))),
  leavesFinding: sql<LeavesFinding | null>`(
    select case when ${dentalTemplateRule.leavesCondition} is null then null
      else jsonb_strip_nulls(jsonb_build_object('condition', ${dentalTemplateRule.leavesCondition}, 'variant', ${dentalTemplateRule.leavesVariant})) end
    from ${dentalTemplateRule} where ${dentalTemplateRule.templateId} = ${treatmentTemplate.id}
  )`.mapWith(asFinding),
}

export interface TemplateDental {
  surfaceCountMin: number | null
  surfaceCountMax: number | null
  leavesFinding: LeavesFinding | null
}

/** Guarda lo que deja un servicio; `null` lo quita (no deja nada dibujado). */
export async function saveServiceFinding(
  tx: Db,
  service: { organizationId: string; id: string },
  leaves: LeavesFinding | null,
): Promise<void> {
  if (!leaves) {
    await tx
      .delete(serviceFinding)
      .where(
        and(
          eq(serviceFinding.organizationId, service.organizationId),
          eq(serviceFinding.serviceId, service.id),
        ),
      )
    return
  }
  await tx
    .insert(serviceFinding)
    .values({
      serviceId: service.id,
      organizationId: service.organizationId,
      condition: leaves.condition,
      variant: leaves.variant ?? null,
    })
    .onConflictDoUpdate({
      target: serviceFinding.serviceId,
      set: { condition: leaves.condition, variant: leaves.variant ?? null, updatedAt: new Date() },
    })
}


import type { Db } from "@odentia/db"
import { serviceCatalog, treatmentTemplate } from "@odentia/db/schema/clinical"
import { dentalTemplateRule, serviceFinding } from "@odentia/db/schema/dental"
import {
  DENTITION_COUNTERPART_FAMILIES,
  type Dentition,
  type LeavesFinding,
  leavesFindingIssues,
  type ToothGroup,
  validateLeavesFinding,
} from "@odentia/dental"
import { and, eq, sql } from "drizzle-orm"
import { validation } from "../errors.js"
import { orgProduct } from "../locale.js"
import { orgDentalProfile } from "./profile.js"

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
  /** Para qué piezas es (entrega 8 de la atención); null si su nombre no lo dice. */
  toothAnatomy: sql<TemplateToothAnatomy | null>`(
    select jsonb_build_object('groups', to_jsonb(${dentalTemplateRule.toothGroups}), 'dentition', ${dentalTemplateRule.dentition}, 'family', ${dentalTemplateRule.family})
    from ${dentalTemplateRule} where ${dentalTemplateRule.templateId} = ${treatmentTemplate.id} and ${dentalTemplateRule.family} is not null
  )`.mapWith(asJson<TemplateToothAnatomy>),
}

/** Para qué piezas es un tratamiento de la biblioteca: sus grupos, su dentición (null = las dos) y su familia. */
export interface TemplateToothAnatomy {
  groups: ToothGroup[]
  dentition: Dentition | null
  family: string
}

/** Un servicio activo de la misma familia, que se puede ofrecer en su lugar. */
export interface ToothAnatomySibling {
  id: string
  name: string
  priceCents: number | null
  currency: string
  groups: ToothGroup[]
  dentition: Dentition | null
}

/**
 * La anatomía de un servicio: la de su tratamiento de la biblioteca, con los
 * servicios activos de la clínica de su familia (los hermanos que se ofrecen si
 * no encaja en la pieza). Un servicio propio no tiene: nunca avisa.
 */
export type ServiceToothAnatomy = TemplateToothAnatomy & { siblings: ToothAnatomySibling[] }

function asJson<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null
  return (typeof value === "string" ? JSON.parse(value) : value) as T
}

/**
 * `toothAnatomy` de un servicio, para elegirlo junto con sus columnas. Los
 * hermanos son de la misma clínica (y la RLS lo vuelve a exigir).
 */
/** Pares (familia, la de la otra dentición) para el SQL de los hermanos. */
const COUNTERPART_PAIRS = Object.entries(DENTITION_COUNTERPART_FAMILIES).flatMap(([family, others]) =>
  others.map((other) => `${family}>${other}`),
)

export const serviceToothAnatomy = sql<ServiceToothAnatomy | null>`(
  select jsonb_build_object(
    'groups', to_jsonb(own_rule."tooth_groups"), 'dentition', own_rule."dentition", 'family', own_rule."family",
    'siblings', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', other."id", 'name', other."name", 'priceCents', other."price_cents", 'currency', other."currency",
          'groups', to_jsonb(kin."tooth_groups"), 'dentition', kin."dentition"
        ) order by other."name")
      from "service_catalog" other
      join ${dentalTemplateRule} kin on kin."template_id" = other."template_id"
      where other."organization_id" = ${serviceCatalog.organizationId} and other."is_active"
        and other."id" <> ${serviceCatalog.id}
        -- La misma familia, o la que hace lo mismo en la otra dentición (la pulpectomía de una temporal).
        and (kin."family" = own_rule."family"
          or (own_rule."family" || '>' || kin."family") in (${sql.join(
            COUNTERPART_PAIRS.map((pair) => sql`${pair}`),
            sql`, `,
          )}))
    ), '[]'::jsonb))
  from ${dentalTemplateRule} own_rule
  where own_rule."template_id" = ${serviceCatalog.templateId} and own_rule."family" is not null
)`.mapWith(asJson<ServiceToothAnatomy>)

export interface TemplateDental {
  surfaceCountMin: number | null
  surfaceCountMax: number | null
  leavesFinding: LeavesFinding | null
  toothAnatomy: TemplateToothAnatomy | null
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


/** Lo que deja un servicio, como lo dice la API (`leavesFinding`). */
export type ServiceLeaves = LeavesFinding

/**
 * Lo que deja el servicio en la pieza al completarse (lo tratado queda
 * dibujado): `null` = nada. Se valida con el ámbito del servicio y la regla
 * del país de la clínica (en Perú, con su variante). Una clínica de otro
 * producto no registra nada de esto. Con `field` (el nombre del dato en el
 * cuerpo, p. ej. `leavesFinding`), cada error va a su dato:
 * `leavesFinding.condition` o `leavesFinding.variant`.
 */
export async function checkServiceFinding(
  tx: Db,
  orgId: string,
  leaves: unknown,
  scope: string | null | undefined,
  field?: string,
): Promise<LeavesFinding | null> {
  if (leaves === null || leaves === undefined) return null
  if ((await orgProduct(tx, orgId)) !== "dental") {
    const message = "Esta clínica no registra lo que deja un servicio"
    throw validation(message, field ? { [field]: message } : undefined)
  }
  const strictVariants = (await orgDentalProfile(tx, orgId)).odontogram?.strictVariants ?? false
  const issues = leavesFindingIssues(leaves, { scope, strictVariants })
  if (issues.length) {
    const fields: Record<string, string> = {}
    for (const issue of issues) fields[`${field}.${issue.field}`] ??= issue.message
    throw validation(issues.map((issue) => issue.message).join(" "), field ? fields : undefined)
  }
  const { condition, variant } = leaves as LeavesFinding
  return variant ? { condition, variant } : { condition }
}

/**
 * Lo que deja un servicio de la biblioteca: lo que odentIA puso en su
 * tratamiento (`dental_template_rule`, ADR 0069 y 0079); null si no
 * deja nada claro o no encaja con el ámbito.
 */
export function libraryServiceFinding(template: { leavesFinding: LeavesFinding | null; scope: string }): LeavesFinding | null {
  const leaves = template.leavesFinding
  if (!leaves) return null
  // La variante se exige al configurar a mano; aquí basta con que encaje en la pieza.
  return validateLeavesFinding(leaves, { scope: template.scope, strictVariants: false }).length === 0
    ? { ...leaves }
    : null
}

import type { ProcedureCodingSnapshot } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  procedureCatalogRelease,
  procedureCode,
  treatmentTemplate,
  treatmentTemplateCode,
} from "@odentia/db/schema/clinical"
import { and, desc, eq } from "drizzle-orm"
import { ServiceError } from "./errors.js"

/**
 * Proyección oficial 1:1 de plantillas y snapshots congelados.
 *
 * Cada plantilla vigente es la proyección de UN único código oficial
 * (`treatment_template.key = cpms:<version>:<code>`, p. ej.
 * `cpms:RM-550-2023-MINSA:D2391`) con un único mapeo en
 * `treatment_template_code`. Los servicios nunca editan las tablas globales:
 * al indicar se congela una copia en `codings` del plan/presupuesto/atención
 * (con su `version` oficial); el histórico nunca sigue al mapeo vigente.
 * Las ofertas propias (`custom`, sin plantilla) congelan `[]`.
 */

const codingJoin = and(
  eq(treatmentTemplateCode.systemKey, procedureCode.systemKey),
  eq(treatmentTemplateCode.code, procedureCode.code),
  eq(treatmentTemplateCode.version, procedureCode.version),
)

export interface CatalogRelease {
  system: string
  version: string
  scope: string
  sourceUrl: string
  sourceSha256: string
  expectedCount: number
}

/** Edición importada vigente; los errores de esquema/conexión no se ocultan. */
export async function currentCatalogRelease(
  tx: Db,
  system = "CPMS",
): Promise<CatalogRelease | null> {
  const [release] = await tx
    .select({
      system: procedureCatalogRelease.systemKey,
      version: procedureCatalogRelease.version,
      scope: procedureCatalogRelease.scope,
      sourceUrl: procedureCatalogRelease.sourceUrl,
      sourceSha256: procedureCatalogRelease.sourceSha256,
      expectedCount: procedureCatalogRelease.expectedCount,
    })
    .from(procedureCatalogRelease)
    .where(
      and(
        eq(procedureCatalogRelease.systemKey, system),
        eq(procedureCatalogRelease.isCurrent, true),
      ),
    )
    .limit(1)
  return release ?? null
}

/** Codificaciones activas de una plantilla, primaria primero. */
export async function listTemplateCodings(
  tx: Db,
  templateId: string,
): Promise<ProcedureCodingSnapshot[]> {
  const rows = await tx
    .select({
      system: treatmentTemplateCode.systemKey,
      code: treatmentTemplateCode.code,
      version: treatmentTemplateCode.version,
      display: procedureCode.display,
    })
    .from(treatmentTemplateCode)
    .innerJoin(procedureCode, codingJoin)
    .where(and(eq(treatmentTemplateCode.templateId, templateId), eq(procedureCode.isActive, true)))
    .orderBy(desc(treatmentTemplateCode.isPrimary), treatmentTemplateCode.systemKey)
  return rows
}

function ambiguousError(codes: string[]): ServiceError {
  return new ServiceError(
    "CODING_AMBIGUOUS",
    409,
    `La prestación retirada tiene varias equivalencias (${codes.join(", ")}): ` +
      "crea una nueva indicación exacta desde la biblioteca vigente; " +
      "nunca se factura como múltiples actos",
  )
}

/** Una nueva indicación oficial exige un único código de la edición vigente. */
export async function resolveSingleTemplateCoding(
  tx: Db,
  templateId: string,
): Promise<ProcedureCodingSnapshot[]> {
  const codings = await tx
    .select({
      system: procedureCode.systemKey,
      code: procedureCode.code,
      version: procedureCode.version,
      display: procedureCode.display,
    })
    .from(treatmentTemplate)
    .innerJoin(treatmentTemplateCode, eq(treatmentTemplateCode.templateId, treatmentTemplate.id))
    .innerJoin(procedureCode, codingJoin)
    .innerJoin(
      procedureCatalogRelease,
      and(
        eq(procedureCatalogRelease.systemKey, procedureCode.systemKey),
        eq(procedureCatalogRelease.version, procedureCode.version),
      ),
    )
    .where(
      and(
        eq(treatmentTemplate.id, templateId),
        eq(treatmentTemplate.isActive, true),
        eq(procedureCode.isActive, true),
        eq(procedureCatalogRelease.isCurrent, true),
      ),
    )
  if (codings.length > 1) throw ambiguousError(codings.map((c) => c.code))
  if (codings.length !== 1) {
    throw new ServiceError(
      "TEMPLATE_INACTIVE",
      409,
      "La prestación no tiene un código oficial vigente: selecciona una prestación exacta de la biblioteca o registra una prestación propia sin equivalencia",
    )
  }
  return codings
}

/** Snapshot para una oferta del catálogo: [] si es propia; un único snapshot si es oficial. */
export async function resolveServiceCodings(
  tx: Db,
  service: { templateId: string | null },
): Promise<ProcedureCodingSnapshot[]> {
  if (!service.templateId) return []
  return resolveSingleTemplateCoding(tx, service.templateId)
}

/**
 * Valida un snapshot congelado antes de ejecutar/facturar: las ofertas
 * propias conservan `[]` y las oficiales un único snapshot con su versión.
 * Un histórico ambiguo heredado (varias equivalencias) falla con un error
 * accionable: no se elige un principal, se pide una nueva indicación exacta.
 */
export function assertExecutableCodings(codings: ProcedureCodingSnapshot[]): void {
  if (codings.length > 1) throw ambiguousError(codings.map((c) => c.code))
}

/** Plantilla vigente que proyecta un código externo (búsqueda inversa, p. ej. por CPMS). */
export async function templatesForCode(
  tx: Db,
  systemKey: string,
  code: string,
): Promise<
  Array<{ templateId: string; templateKey: string; templateName: string; isPrimary: boolean }>
> {
  return tx
    .select({
      templateId: treatmentTemplateCode.templateId,
      templateKey: treatmentTemplate.key,
      templateName: treatmentTemplate.name,
      isPrimary: treatmentTemplateCode.isPrimary,
    })
    .from(treatmentTemplateCode)
    .innerJoin(treatmentTemplate, eq(treatmentTemplateCode.templateId, treatmentTemplate.id))
    .innerJoin(procedureCode, codingJoin)
    .where(
      and(
        eq(treatmentTemplateCode.systemKey, systemKey),
        eq(treatmentTemplateCode.code, code),
        eq(treatmentTemplate.isActive, true),
        eq(procedureCode.isActive, true),
      ),
    )
    .orderBy(treatmentTemplate.key)
}

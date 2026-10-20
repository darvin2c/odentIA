import type { ProcedureCodingSnapshot, ServiceListProfile } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  procedureCatalogRelease,
  procedureCode,
  treatmentTemplateCode,
} from "@odentia/db/schema/clinical"
import { and, eq } from "drizzle-orm"
import { ServiceError } from "./errors.js"

/**
 * El código oficial de cada servicio en la lista de su país (ADR 0067) y los
 * snapshots que se congelan.
 *
 * Un servicio de la biblioteca toma el código de su tratamiento en la lista
 * del país de la clínica (`treatment_template_code`); uno propio guarda el
 * suyo (`service_catalog.procedure_*`). Sin lista en el país no hay código.
 * Los servicios nunca editan las tablas globales: al indicar se congela una
 * copia en `codings` del plan, el presupuesto o la atención, con su edición;
 * el histórico nunca sigue al código vigente.
 */

export interface CatalogRelease {
  system: string
  version: string
  scope: string
  sourceUrl: string
  sourceSha256: string
  expectedCount: number
}

/** Edición vigente de una lista; los errores de esquema o conexión no se ocultan. */
export async function currentCatalogRelease(tx: Db, system: string): Promise<CatalogRelease | null> {
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
    .where(and(eq(procedureCatalogRelease.systemKey, system), eq(procedureCatalogRelease.isCurrent, true)))
    .limit(1)
  return release ?? null
}

/**
 * El código de un tratamiento de la biblioteca en la edición vigente de una
 * lista, o null si no tiene uno en ella.
 */
export async function templateCodingIn(
  tx: Db,
  templateId: string,
  system: string,
): Promise<ProcedureCodingSnapshot | null> {
  const [coding] = await tx
    .select({
      system: procedureCode.systemKey,
      code: procedureCode.code,
      version: procedureCode.version,
      display: procedureCode.display,
    })
    .from(treatmentTemplateCode)
    .innerJoin(
      procedureCode,
      and(
        eq(treatmentTemplateCode.systemKey, procedureCode.systemKey),
        eq(treatmentTemplateCode.code, procedureCode.code),
        eq(treatmentTemplateCode.version, procedureCode.version),
      ),
    )
    .innerJoin(
      procedureCatalogRelease,
      and(
        eq(procedureCatalogRelease.systemKey, procedureCode.systemKey),
        eq(procedureCatalogRelease.version, procedureCode.version),
      ),
    )
    .where(
      and(
        eq(treatmentTemplateCode.templateId, templateId),
        eq(treatmentTemplateCode.systemKey, system),
        eq(procedureCode.isActive, true),
        eq(procedureCatalogRelease.isCurrent, true),
      ),
    )
    .limit(1)
  return coding ?? null
}

/** Un código de la edición vigente de una lista, o null si no existe o se retiró. */
export async function currentProcedureCode(
  tx: Db,
  system: string,
  code: string,
): Promise<ProcedureCodingSnapshot | null> {
  const [row] = await tx
    .select({
      system: procedureCode.systemKey,
      code: procedureCode.code,
      version: procedureCode.version,
      display: procedureCode.display,
    })
    .from(procedureCode)
    .innerJoin(
      procedureCatalogRelease,
      and(
        eq(procedureCatalogRelease.systemKey, procedureCode.systemKey),
        eq(procedureCatalogRelease.version, procedureCode.version),
      ),
    )
    .where(
      and(
        eq(procedureCode.systemKey, system),
        eq(procedureCode.code, code),
        eq(procedureCode.isActive, true),
        eq(procedureCatalogRelease.isCurrent, true),
      ),
    )
    .limit(1)
  return row ?? null
}

/** Lo que hace falta de un servicio para saber su código oficial. */
export interface ServiceCodingSource {
  templateId: string | null
  procedureSystem: string | null
  procedureCode: string | null
  procedureVersion: string | null
}

/**
 * El código oficial de un servicio en la lista de su país, o null: sin lista,
 * sin código en ella o con un código retirado. Uno propio lo lee de su fila;
 * uno de la biblioteca, de su tratamiento. El código propio se busca por su
 * número en la edición vigente: una edición nueva que conserva el número lo
 * sigue a ella (las listas oficiales no reutilizan un número con otro acto).
 */
export async function serviceCoding(
  tx: Db,
  list: ServiceListProfile | null,
  service: ServiceCodingSource,
): Promise<ProcedureCodingSnapshot | null> {
  if (!list) return null
  if (service.templateId) return templateCodingIn(tx, service.templateId, list.system)
  if (!service.procedureCode || service.procedureSystem !== list.system) return null
  return currentProcedureCode(tx, list.system, service.procedureCode)
}

/**
 * Snapshot para una nueva indicación: el código del servicio en la lista de su
 * país, o `[]` sin código. El código obligatorio se exige al crear y editar el
 * servicio, no aquí: si una edición nueva retira el código de uno ya creado, la
 * consulta no se detiene; Servicios lo muestra sin código vigente para que la
 * clínica elija otro.
 */
export async function resolveServiceCodings(
  tx: Db,
  list: ServiceListProfile | null,
  service: ServiceCodingSource,
): Promise<ProcedureCodingSnapshot[]> {
  const coding = await serviceCoding(tx, list, service)
  return coding ? [coding] : []
}

/**
 * Valida un snapshot congelado antes de ejecutar o facturar: a lo sumo un
 * código. Un histórico con varios (de antes de ADR 0067) falla con un error
 * accionable: no se elige uno, se pide una nueva indicación.
 */
export function assertExecutableCodings(codings: ProcedureCodingSnapshot[]): void {
  if (codings.length > 1) {
    throw new ServiceError(
      "CODING_AMBIGUOUS",
      409,
      `La prestación tiene varias equivalencias (${codings.map((c) => c.code).join(", ")}): ` +
        "indícala de nuevo desde Servicios; nunca se factura como varios actos",
    )
  }
}

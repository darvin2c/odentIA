import { bodySiteOf, type DentalSite, dentalSiteOf, ISO_3950, toothNumbersOfCodes, toothSiteCode } from "@odentia/dental"
import { and, eq, type SQL, sql } from "drizzle-orm"
import type { AnyPgColumn } from "drizzle-orm/pg-core"

/**
 * El borde entre el sitio común que guardan las tablas (ADR 0079: sistema,
 * código y calificadores) y el sitio dental que siguen usando la API y las
 * pantallas (pieza, caras, cuadrante y arcada).
 */

export interface SiteColumns {
  siteSystem: string | null
  siteCode: string | null
  siteQualifiers: string[]
}

/** Pieza, caras, cuadrante o arcada → columnas del sitio común. */
export function siteColumns(site: Partial<DentalSite> | null | undefined): SiteColumns {
  const body = bodySiteOf(site)
  return { siteSystem: body.system, siteCode: body.code, siteQualifiers: [...body.qualifiers] }
}

/** Columnas del sitio común → pieza, caras, cuadrante y arcada. */
export function dentalSiteOfRow(row: SiteColumns): DentalSite {
  return dentalSiteOf({ system: row.siteSystem, code: row.siteCode, qualifiers: row.siteQualifiers })
}

/** La fila con su sitio dental a la vista, como la devolvía la API. */
export function withDentalSite<T extends SiteColumns>(row: T): T & DentalSite {
  return { ...row, ...dentalSiteOfRow(row) }
}

/** Solo la pieza de una fila (nula si el sitio es un área o no hay). */
export function toothOfRow(row: Pick<SiteColumns, "siteSystem" | "siteCode">): number | null {
  return dentalSiteOf({ system: row.siteSystem, code: row.siteCode }).toothNumber
}

/** Condición «el sitio es esta pieza», para filtrar por pieza en SQL. */
export function isTooth(columns: { siteSystem: AnyPgColumn; siteCode: AnyPgColumn }, toothNumber: number): SQL {
  return and(eq(columns.siteSystem, ISO_3950), eq(columns.siteCode, toothSiteCode(toothNumber))) as SQL
}

/**
 * La pieza del sitio en SQL (nula si es un área o no hay), para las consultas
 * que eligen columnas y seguían leyendo `toothNumber`.
 */
export function toothNumberSql(columns: { siteSystem: AnyPgColumn; siteCode: AnyPgColumn }): SQL<number | null> {
  return sql<number | null>`case when ${columns.siteSystem} = ${ISO_3950} and ${columns.siteCode} ~ '^[1-8][1-8]$' then ${columns.siteCode}::int end`
}

/** Las piezas de un contexto de documento (sus códigos ISO 3950). */
export function teethOfCodes(row: { siteSystem: string | null; siteCodes: string[] }): number[] {
  return row.siteSystem === ISO_3950 ? toothNumbersOfCodes(row.siteCodes) : []
}

/** Piezas → columnas del contexto de un documento. */
export function siteCodesColumns(teeth: readonly number[]): { siteSystem: string | null; siteCodes: string[] } {
  return teeth.length > 0 ? { siteSystem: ISO_3950, siteCodes: teeth.map(toothSiteCode) } : { siteSystem: null, siteCodes: [] }
}

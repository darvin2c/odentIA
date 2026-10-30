import {
  assertTreatmentSite,
  bodySiteOf,
  type DentalSite,
  dentalSiteOf,
  FDI_ADULT_ROWS,
  ISO_3950,
  isValidTooth,
  surfacesForTooth,
  TREATMENT_SCOPES,
  type TreatmentScope,
  toothNumbersOfCodes,
  toothSiteCode,
} from "@odentia/dental"
import { and, eq, type SQL, sql } from "drizzle-orm"
import type { AnyPgColumn } from "drizzle-orm/pg-core"
import { invalidField, validation } from "../errors.js"
import type { ProductSite } from "../product-hooks.js"

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
  return dentalSiteOf({
    system: row.siteSystem,
    code: row.siteCode,
    qualifiers: row.siteQualifiers,
  })
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
export function isTooth(
  columns: { siteSystem: AnyPgColumn; siteCode: AnyPgColumn },
  toothNumber: number,
): SQL {
  return and(
    eq(columns.siteSystem, ISO_3950),
    eq(columns.siteCode, toothSiteCode(toothNumber)),
  ) as SQL
}

/**
 * La pieza del sitio en SQL (nula si es un área o no hay), para las consultas
 * que eligen columnas y seguían leyendo `toothNumber`.
 */
export function toothNumberSql(columns: {
  siteSystem: AnyPgColumn
  siteCode: AnyPgColumn
}): SQL<number | null> {
  return sql<
    number | null
  >`case when ${columns.siteSystem} = ${ISO_3950} and ${columns.siteCode} ~ '^[1-8][1-8]$' then ${columns.siteCode}::int end`
}

/** Las piezas de un contexto de documento (sus códigos ISO 3950). */
export function teethOfCodes(row: { siteSystem: string | null; siteCodes: string[] }): number[] {
  return row.siteSystem === ISO_3950 ? toothNumbersOfCodes(row.siteCodes) : []
}

/** Piezas → columnas del contexto de un documento. */
export function siteCodesColumns(teeth: readonly number[]): {
  siteSystem: string | null
  siteCodes: string[]
} {
  return teeth.length > 0
    ? { siteSystem: ISO_3950, siteCodes: teeth.map(toothSiteCode) }
    : { siteSystem: null, siteCodes: [] }
}

/** Qué superficies quedan de una lista, sin repetir y ordenadas; exige una pieza que las tenga. */
function cleanSurfaces(surfaces: unknown, toothNumber: number | null): string[] {
  const list = [
    ...new Set(
      (Array.isArray(surfaces) ? surfaces : []).map((s) => String(s).trim()).filter(Boolean),
    ),
  ]
  if (list.length === 0) return []
  if (toothNumber === null) throw invalidField("toothNumber", "Las superficies exigen una pieza")
  const allowed = new Set<string>(surfacesForTooth(toothNumber))
  for (const surface of list)
    if (!allowed.has(surface))
      throw invalidField("surfaces", `Superficie inválida para la pieza ${toothNumber}`)
  return list.sort()
}

const isTreatmentScope = (scope: string): scope is TreatmentScope =>
  (TREATMENT_SCOPES as readonly string[]).includes(scope)

const asNumber = (value: unknown): number | null =>
  value == null || value === "" ? null : Number(value)

/**
 * El «dónde» de odentIA (ADR 0079): la API dice pieza, caras, cuadrante y
 * arcada; la base guarda ISO 3950 con las caras como calificadores.
 */
export const dentalProductSite: ProductSite = {
  system: ISO_3950,
  inputs: ["toothNumber", "surfaces", "quadrant", "arch"],
  looseScope: "tooth",
  scopes: TREATMENT_SCOPES,
  fields: (row) => ({ ...dentalSiteOfRow(row) }),
  columns(input, rules) {
    const toothNumber = asNumber(input.toothNumber)
    const quadrant = asNumber(input.quadrant)
    const arch = input.arch == null || input.arch === "" ? null : String(input.arch)
    if (rules) {
      if (!isTreatmentScope(rules.scope)) throw validation("Ámbito de prestación inválido")
      const site = {
        toothNumber,
        surfaces: Array.isArray(input.surfaces) ? input.surfaces.map(String) : null,
        quadrant,
        arch,
      }
      const hasSurfaces = Array.isArray(site.surfaces) && site.surfaces.length > 0
      // Indicado con la pieza o la cara por definir: lo dicho se valida, lo que falta espera a hacerlo.
      const pendingTooth =
        rules.pending &&
        (rules.scope === "tooth" || rules.scope === "surfaces") &&
        toothNumber === null &&
        !hasSurfaces &&
        quadrant === null &&
        arch === null
      const pendingSurfaces =
        rules.pending && rules.scope === "surfaces" && toothNumber !== null && !hasSurfaces
      if (pendingTooth)
        return siteColumns({ toothNumber: null, surfaces: [], quadrant: null, arch: null })
      if (pendingSurfaces) {
        if (!isValidTooth(toothNumber))
          throw invalidField("toothNumber", `Pieza FDI inválida: ${input.toothNumber}`)
        if (quadrant !== null || arch !== null)
          throw validation("La prestación por caras no lleva cuadrante ni arcada")
        return siteColumns({ toothNumber, surfaces: [], quadrant: null, arch: null })
      }
      try {
        assertTreatmentSite(rules.scope, site, rules.surfaces)
      } catch (e) {
        const message = e instanceof Error ? e.message : "Sitio clínico inválido"
        // Cada ámbito pide un dato: el error va junto a él (las caras, aparte de la pieza).
        const field =
          rules.scope === "quadrant"
            ? "quadrant"
            : rules.scope === "arch"
              ? "arch"
              : rules.scope === "general"
                ? null
                : rules.scope === "surfaces" && /superficie/i.test(message)
                  ? "surfaces"
                  : "toothNumber"
        throw field ? invalidField(field, message) : validation(message)
      }
      return siteColumns({ toothNumber, surfaces: site.surfaces ?? [], quadrant, arch })
    }
    if (toothNumber !== null && !isValidTooth(toothNumber))
      throw invalidField("toothNumber", `Pieza FDI inválida: ${input.toothNumber}`)
    if (quadrant !== null && !(Number.isInteger(quadrant) && quadrant >= 1 && quadrant <= 8))
      throw invalidField("quadrant", "Cuadrante inválido")
    if (arch !== null && arch !== "upper" && arch !== "lower")
      throw invalidField("arch", "Arcada inválida")
    return siteColumns({
      toothNumber,
      surfaces: cleanSurfaces(input.surfaces, toothNumber),
      quadrant,
      arch,
    })
  },
  code(value) {
    const tooth = asNumber(value)
    return tooth !== null && Number.isInteger(tooth) && tooth > 0 && isValidTooth(tooth)
      ? toothSiteCode(tooth)
      : null
  },
  value(code) {
    return code && /^[1-8][1-8]$/.test(code) ? Number(code) : null
  },
  chart(rows) {
    const marked = new Set<number>()
    for (const row of rows) {
      const { toothNumber } = dentalSiteOfRow(row)
      if (toothNumber != null) marked.add(toothNumber)
    }
    if (marked.size === 0) return null
    return {
      label: "Pieza",
      rows: FDI_ADULT_ROWS.map((row) =>
        row.map((tooth) => ({ label: String(tooth), marked: marked.has(tooth) })),
      ),
    }
  },
  words(row, form = "long") {
    const site = dentalSiteOfRow(row)
    if (form === "full") {
      if (site.toothNumber !== null)
        return `Pieza ${site.toothNumber}${site.surfaces.length ? ` (${site.surfaces.join(", ")})` : ""}`
      if (site.quadrant !== null) return `Cuadrante ${site.quadrant}`
      if (site.arch === "upper") return "Arcada superior"
      if (site.arch === "lower") return "Arcada inferior"
      return null
    }
    if (site.toothNumber === null) return null
    if (form === "short" || !site.surfaces.length) return `pieza ${site.toothNumber}`
    return `pieza ${site.toothNumber} (${site.surfaces.join(", ")})`
  },
  bodySite(row) {
    const site = dentalSiteOfRow(row)
    if (site.toothNumber === null) return null
    return {
      text: `Pieza ${site.toothNumber} (FDI)${site.surfaces.length ? ` · ${site.surfaces.join(", ")}` : ""}`,
    }
  },
  invalid: (value) => `Pieza FDI inválida: ${value}`,
  pending(row, scope) {
    const site = dentalSiteOfRow(row)
    const noPlace = site.toothNumber === null && site.quadrant === null && site.arch === null
    if ((scope === "tooth" || scope === "surfaces") && noPlace) {
      return {
        fields: scope === "surfaces" ? ["toothNumber", "surfaces"] : ["toothNumber"],
        ask: "Falta la pieza: elígela para registrar lo hecho.",
      }
    }
    if (scope === "surfaces" && site.toothNumber !== null && site.surfaces.length === 0) {
      return {
        fields: ["surfaces"],
        ask: `Falta la cara de la ${site.toothNumber}: elígela para registrar lo hecho.`,
      }
    }
    return null
  },
}

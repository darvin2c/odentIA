import { type ClinicalProduct, isClinicalProduct } from "@odentia/clinical"

/*
 * Lo que Hoy, Kairós, Reportes y Demos leen de la dirección. Como en
 * `lib/list-search.ts`, cada clave va siempre, con `undefined` si su valor no
 * sirve: el router junta la búsqueda cruda con la de la ruta y una clave
 * omitida dejaría pasar el valor crudo («?tareas=cualquiera») hasta la API.
 * Lo que es el valor de siempre también va como `undefined`, para que la
 * dirección quede limpia.
 */

const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined =>
  typeof value === "string" && (values as readonly string[]).includes(value)
    ? (value as T)
    : undefined
const productOf = (value: unknown): ClinicalProduct | undefined =>
  isClinicalProduct(value) ? value : undefined

export interface TodaySearch {
  /** Sin valor: «Mías». */
  tareas?: "todas" | undefined
  producto?: ClinicalProduct | undefined
}

export function todaySearchOf(search: Record<string, unknown>): TodaySearch {
  return {
    tareas: oneOf(["todas"] as const, search.tareas),
    producto: productOf(search.producto),
  }
}

export interface KairosSearch {
  /** Sin valor: «Espera tu sí». */
  vista?: "hizo" | undefined
  producto?: ClinicalProduct | undefined
}

export function kairosSearchOf(search: Record<string, unknown>): KairosSearch {
  return {
    vista: oneOf(["hizo"] as const, search.vista),
    producto: productOf(search.producto),
  }
}

/** Cuántos meses mira el embudo; 6 es el de siempre (`FUNNEL_DEFAULT_MONTHS`). */
export const REPORT_MONTHS = [3, 6, 12, 24] as const
export type ReportMonths = (typeof REPORT_MONTHS)[number]
export const DEFAULT_REPORT_MONTHS: ReportMonths = 6

export interface ReportsSearch {
  /** Sin valor: «Embudo». */
  pestana?: "ingresos" | "prevision" | undefined
  /** Sin valor: 6 meses. */
  meses?: Exclude<ReportMonths, 6> | undefined
}

export function reportsSearchOf(search: Record<string, unknown>): ReportsSearch {
  // «?meses=12» llega como número; «?meses="12"», como texto: los dos sirven.
  const months = Number(search.meses)
  const meses = REPORT_MONTHS.find(
    (value) => value === months && value !== DEFAULT_REPORT_MONTHS,
  ) as Exclude<ReportMonths, 6> | undefined
  return {
    pestana: oneOf(["ingresos", "prevision"] as const, search.pestana),
    meses,
  }
}

export interface DemosSearch {
  producto?: ClinicalProduct | undefined
  /** La demo abierta en su cajón. */
  demo?: string | undefined
}

export function demosSearchOf(search: Record<string, unknown>): DemosSearch {
  return {
    producto: productOf(search.producto),
    demo: typeof search.demo === "string" && search.demo ? search.demo : undefined,
  }
}

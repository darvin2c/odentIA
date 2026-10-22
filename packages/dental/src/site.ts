/**
 * El sitio dental guardado como sitio común (ADR 0079). ISO 3950 designa
 * dientes y áreas de la cavidad oral con dos dígitos: un diente es su número
 * FDI («16»); un código con al menos un cero es un área: «00» la boca completa,
 * «01» la zona maxilar, «02» la mandibular y «10» el cuadrante superior
 * derecho (los cuadrantes temporales siguen la misma regla: «50» a «80»). Las
 * caras van como calificadores. Las pantallas y la API siguen hablando de
 * pieza, caras, cuadrante y arcada: aquí se traduce en el borde con la base.
 */
import { type BodySite, NO_SITE } from "@odentia/clinical"

export const ISO_3950 = "ISO-3950"

/** El sitio como lo dicen la atención, el plan y el presupuesto. */
export interface DentalSite {
  toothNumber: number | null
  surfaces: string[]
  quadrant: number | null
  arch: string | null
}

export const NO_DENTAL_SITE: DentalSite = { toothNumber: null, surfaces: [], quadrant: null, arch: null }

const ARCH_CODE: Record<string, string> = { upper: "01", lower: "02" }
const CODE_ARCH: Record<string, string> = { "01": "upper", "02": "lower" }

/** Pieza, caras, cuadrante o arcada → sitio común. Sin ninguno, sin sitio. */
export function bodySiteOf(site: Partial<DentalSite> | null | undefined): BodySite {
  const qualifiers = site?.surfaces ?? []
  if (site?.toothNumber != null) return { system: ISO_3950, code: String(site.toothNumber), qualifiers }
  if (site?.quadrant != null) return { system: ISO_3950, code: `${site.quadrant}0`, qualifiers }
  const arch = site?.arch ? ARCH_CODE[site.arch] : undefined
  if (arch) return { system: ISO_3950, code: arch, qualifiers }
  return { ...NO_SITE, qualifiers }
}

/** Sitio común → pieza, caras, cuadrante o arcada. Otro sistema: sin sitio dental. */
export function dentalSiteOf(site: {
  system: string | null
  code: string | null
  qualifiers?: readonly string[] | null
}): DentalSite {
  const surfaces = [...(site.qualifiers ?? [])]
  if (site.system !== ISO_3950 || !site.code) return { ...NO_DENTAL_SITE, surfaces }
  if (/^[1-8][1-8]$/.test(site.code)) return { ...NO_DENTAL_SITE, toothNumber: Number(site.code), surfaces }
  if (/^[1-8]0$/.test(site.code)) return { ...NO_DENTAL_SITE, quadrant: Number(site.code[0]), surfaces }
  return { ...NO_DENTAL_SITE, arch: CODE_ARCH[site.code] ?? null, surfaces }
}

/** El código ISO 3950 de una pieza, para buscar por pieza en las tablas comunes. */
export function toothSiteCode(toothNumber: number): string {
  return String(toothNumber)
}

/** Las piezas de una lista de códigos ISO 3950 (las áreas no son piezas). */
export function toothNumbersOfCodes(codes: readonly string[] | null | undefined): number[] {
  return (codes ?? []).filter((code) => /^[1-8][1-8]$/.test(code)).map(Number)
}

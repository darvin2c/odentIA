/**
 * Lo tratado queda dibujado (fase 3, tablero 4; ADR 0036): cada servicio dice
 * qué deja en la pieza al completarse (`service_catalog.leaves_finding`). La
 * resina deja «Restauración definitiva · resina» en buen estado (azul); la
 * exodoncia, una pieza ausente. Solo se registra lo observado tras el acto
 * (NTS 188, 5.8): nunca lo planificado.
 *
 * odentIA lo deja puesto en los servicios de su biblioteca con la
 * correspondencia código → hallazgo de abajo, solo para los procedimientos
 * que dejan algo claro en una pieza; en un servicio propio se elige al crearlo
 * o editarlo. Lo que es por arcada o por tramo (prótesis, puentes) no se
 * dibuja solo: se registra en la atención.
 */
import { isValidTooth, surfacesForTooth } from "./anatomy.js"
import { findingDefinition } from "./catalog.js"
import { validateFinding } from "./findings.js"
import type { FindingDetails, FindingInput } from "./types.js"

/** Qué deja un servicio en la pieza: el hallazgo y, si corresponde, su variante. */
export interface LeavesFinding {
  condition: string
  variant?: string
}

/**
 * Hallazgos que un tratamiento puede dejar en una sola pieza o en sus caras.
 * Los de color dual quedan en buen estado (azul): es lo que se acaba de hacer.
 */
export const TREATMENT_RESULT_CONDITIONS = [
  "definitive_restoration",
  "temporary_restoration",
  "sealant",
  "crown",
  "post_and_core",
  "root_canal_treatment",
  "pulpotomy",
  "implant",
  "missing_tooth",
] as const
export type TreatmentResultCondition = (typeof TREATMENT_RESULT_CONDITIONS)[number]

export function isTreatmentResultCondition(value: unknown): value is TreatmentResultCondition {
  return typeof value === "string" && (TREATMENT_RESULT_CONDITIONS as readonly string[]).includes(value)
}

const RESIN: LeavesFinding = { condition: "definitive_restoration", variant: "resin" }
const AMALGAM: LeavesFinding = { condition: "definitive_restoration", variant: "amalgam" }
const IONOMER: LeavesFinding = { condition: "definitive_restoration", variant: "glass_ionomer" }
const ROOT_CANAL: LeavesFinding = { condition: "root_canal_treatment", variant: "root_canal" }
const PULPECTOMY: LeavesFinding = { condition: "root_canal_treatment", variant: "pulpectomy" }
/** La causa (por caries u otra) no la dice el procedimiento: se deduce al completarlo. */
const EXTRACTION: LeavesFinding = { condition: "missing_tooth" }

function each(codes: readonly string[], leaves: LeavesFinding): Array<[string, LeavesFinding]> {
  return codes.map((code) => [`CPMS:${code}`, leaves])
}

/**
 * Correspondencia de la biblioteca (CPMS, RM-550-2023-MINSA) con lo que cada
 * procedimiento deja en la pieza. Solo lo inequívoco: las restauraciones por
 * superficies con su material, las coronas cuyo material dice el nombre, el
 * espigo-muñón, la pulpotomía, la pulpectomía, el tratamiento de conductos
 * terminado, el implante y la exodoncia. Lo incompleto (sin obturación
 * final), lo provisional que pide escribir el material y lo que es de toda la
 * corona sin caras no entra.
 */
export const LEAVES_BY_PROCEDURE: Readonly<Record<string, LeavesFinding>> = Object.fromEntries([
  ...each(["D2140", "D2150", "D2160", "D2161"], AMALGAM),
  ...each(
    [
      "D2330",
      "D2331",
      "D2332",
      "D2335",
      "D2385",
      "D2386",
      "D2391",
      "D2392",
      "D2393",
      "D2394",
      "E2336",
      "E2337",
      "E2338",
      "E2339",
      "E2340",
      "E2341",
      "E2342",
      "E2343",
    ],
    RESIN,
  ),
  ...each(["E2395", "E2396", "E2397", "E2398", "E2399", "E2400"], IONOMER),
  ["CPMS:D2740", { condition: "crown", variant: "metal_free" }],
  ["CPMS:D2751", { condition: "crown", variant: "metal_ceramic" }],
  ...each(["D2791", "D2794", "D2930", "D2931"], { condition: "crown", variant: "metal" }),
  ["CPMS:D2952", { condition: "post_and_core" }],
  ["CPMS:D3220", { condition: "pulpotomy" }],
  ...each(["D3230", "D3240"], PULPECTOMY),
  ...each(["D3310", "D3320", "D3330", "E3319", "E3321", "E3322", "D3346", "D3347", "D3348"], ROOT_CANAL),
  ...each(["D6010", "D6040", "D6050"], { condition: "implant" }),
  ...each(
    ["D7111", "D7140", "D7176", "D7210", "D7220", "D7230", "D7240", "D7241", "D7250", "E7251"],
    EXTRACTION,
  ),
])

/** Lo que deja en la pieza un procedimiento de la biblioteca, o null si no deja nada claro. */
export function leavesFindingForProcedure(system: string, code: string): LeavesFinding | null {
  const key = `${system}:${code}`
  return Object.hasOwn(LEAVES_BY_PROCEDURE, key) ? { ...LEAVES_BY_PROCEDURE[key]! } : null
}

/**
 * Comprueba lo que un servicio dice que deja en la pieza. `scope` es el ámbito
 * del servicio: lo que se dibuja en las caras necesita un servicio por
 * superficies y lo de una pieza, uno por pieza o por superficies. Con
 * odontograma oficial (Perú) la variante va siempre, salvo en la ausencia,
 * cuya causa se deduce al completar el tratamiento.
 */
export function validateLeavesFinding(
  leaves: unknown,
  options: { scope: string | null | undefined; strictVariants: boolean },
): string[] {
  if (typeof leaves !== "object" || leaves === null || Array.isArray(leaves))
    return ["Elige de la lista qué deja el servicio en la pieza."]
  const { condition, variant, ...rest } = leaves as Record<string, unknown>
  if (Object.keys(rest).length > 0) return ["Lo que deja en la pieza solo lleva el hallazgo y su variante."]
  if (!isTreatmentResultCondition(condition))
    return ["Elige de la lista qué deja el servicio en la pieza."]
  const def = findingDefinition(condition)
  if (!def) return ["Elige de la lista qué deja el servicio en la pieza."]
  const errors: string[] = []
  const name = def.variantName ?? "Variante"
  if (variant !== undefined && variant !== null && variant !== "") {
    if (!def.variants?.some((item) => item.value === variant))
      errors.push(
        def.variants
          ? `«${name}» no corresponde a «${def.label}»: elígela de la lista.`
          : `«${def.label}» no lleva variante.`,
      )
  } else if (options.strictVariants && def.variants && condition !== "missing_tooth") {
    errors.push(`Falta «${name}»: en Perú se registra con su sigla.`)
  }
  if (def.scope === "surface" && options.scope !== "surfaces")
    errors.push(`«${def.label}» se dibuja en las caras de la pieza: el servicio debe ser por superficies.`)
  else if (def.scope !== "surface" && options.scope !== "tooth" && options.scope !== "surfaces")
    errors.push(`«${def.label}» queda en una pieza: el servicio debe ser por pieza o por superficies.`)
  return errors
}

/** Dónde se hizo el tratamiento: su pieza y, si es por superficies, sus caras. */
export interface TreatedSite {
  toothNumber: number | null | undefined
  surfaces?: readonly string[] | null
}

export interface TreatedContext {
  /** Con odontograma oficial (Perú) la variante es obligatoria. */
  strictVariants: boolean
  /** Hallazgo que motivó el tratamiento (su código), si lo hay. */
  originCondition?: string | null
  /** Hallazgos vigentes de la pieza al completarlo (sus códigos). */
  toothConditions?: readonly string[]
}

/**
 * Causa de una pieza ausente tras la exodoncia, cuando el servicio no la fija
 * (NTS 188, 6.1.20): por caries (DEX) si la motivó una caries o un remanente
 * radicular, o si la pieza tenía uno vigente; si no, por otras razones (DAO).
 */
export function absenceCauseOf(context: TreatedContext): "caries_extraction" | "other_absence" {
  const byCaries = (code: string | null | undefined) => code === "caries" || code === "root_remnant"
  if (byCaries(context.originCondition)) return "caries_extraction"
  if ((context.toothConditions ?? []).some(byCaries)) return "caries_extraction"
  return "other_absence"
}

/**
 * El hallazgo que deja un tratamiento completado, listo para registrarse, o
 * null si no se puede dibujar (sin pieza, sin caras para lo que va en caras, o
 * algo que no valida en el país de la clínica). Lo que se acaba de hacer queda
 * en buen estado (azul) y observado clínicamente.
 */
export function findingLeftByTreatment(
  leaves: LeavesFinding,
  site: TreatedSite,
  context: TreatedContext,
): FindingInput | null {
  if (!isTreatmentResultCondition(leaves.condition)) return null
  const def = findingDefinition(leaves.condition)
  const toothNumber = site.toothNumber
  if (!def || toothNumber == null || !isValidTooth(toothNumber)) return null
  const details: FindingDetails = {}
  const variant =
    leaves.variant ||
    (def.code === "missing_tooth" && context.strictVariants ? absenceCauseOf(context) : undefined)
  if (variant) details.variant = variant
  if (def.color === "quality") details.quality = "good"
  if (def.requiresEvidence) details.clinicallyObserved = true
  const input: FindingInput = { toothNumber, condition: def.code, details }
  if (def.scope === "surface") {
    const valid = new Set<string>(surfacesForTooth(toothNumber))
    const surfaces = [...new Set(site.surfaces ?? [])].filter((surface) => valid.has(surface))
    if (surfaces.length === 0) return null
    input.surfaces = surfaces
  }
  return validateFinding(input, { strictVariants: context.strictVariants }).length === 0 ? input : null
}

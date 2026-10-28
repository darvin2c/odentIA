import { type DiagnosisSystemKey, findingDiagnosisCode } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  conditionLabel,
  FINDINGS,
  type FindingDefinition,
  type FindingDetails,
  isValidTooth,
  surfaceLabel,
  surfacesForTooth,
  validateFinding,
  variantLabel,
} from "@odentia/dental"
import { findDiagnosisCode } from "../diagnosis-codes.js"
import { normalizeForSearch } from "../knowledge.js"
import type { DictationPrepared, ProductDictation } from "../product-hooks.js"
import { orgStrictVariants } from "./odontogram.js"
import { registerToothFinding } from "./tooth-panel.js"

/* ---------- Lo que Clío dicta de odentIA: los hallazgos del odontograma y la pieza con sus caras ---------- */

/**
 * Hallazgos que se pueden dictar (issue 109, fase 1): los de una pieza, con o
 * sin caras. Quedan fuera los que piden marcar que se observó clínicamente
 * (implante, endodoncia, espigo, impactación) y los que necesitan un dato que
 * la voz no da bien (grado de movilidad, sentido del giro, posiciones): esos
 * se registran tocando la pieza, como siempre.
 */
const NOT_BY_VOICE = new Set([
  "pathological_mobility",
  "rotation",
  "abnormal_position",
  "clinical_observation",
])
export const DICTATION_FINDINGS: readonly FindingDefinition[] = FINDINGS.filter(
  (finding) =>
    (finding.scope === "tooth" || finding.scope === "surface") &&
    !finding.requiresEvidence &&
    !NOT_BY_VOICE.has(finding.code),
)

/**
 * Los hallazgos como se le dan al asistente: código, nombre, variantes y si
 * lleva estado. No depende de la clínica, así que va en la parte fija del
 * prompt, la que el proveedor guarda en caché.
 */
export function dictationFindingsText(): string {
  return DICTATION_FINDINGS.map((finding) => {
    const variants = finding.variants
      ? `; ${(finding.variantName ?? "variante").toLowerCase()}: ${finding.variants.map((item) => `${item.value} = ${item.label}`).join(", ")}`
      : ""
    const quality = finding.color === "quality" ? "; estado: good o poor" : ""
    return `${finding.code} (${finding.label}${variants}${quality})`
  }).join("\n")
}

/** Cómo se dice cada cara al dictar; la clave del sistema depende de la pieza. */
const SPOKEN_SURFACE: Record<string, "mesial" | "distal" | "outer" | "inner" | "biting"> = {
  mesial: "mesial",
  distal: "distal",
  vestibular: "outer",
  bucal: "outer",
  buccal: "outer",
  facial: "outer",
  labial: "outer",
  palatina: "inner",
  palatino: "inner",
  palatal: "inner",
  lingual: "inner",
  oclusal: "biting",
  occlusal: "biting",
  incisal: "biting",
}

/**
 * Caras dictadas («oclusal», «palatina») como las registra el sistema para esa
 * pieza. Lo que no es una cara de esa pieza se descarta: la operación
 * rechazaría la sugerencia entera por una palabra mal oída.
 */
function normalizeSurfaces(toothNumber: number, spoken: unknown): string[] {
  if (!Array.isArray(spoken) || !isValidTooth(toothNumber)) return []
  const [mesial, distal, outer, inner, biting] = surfacesForTooth(toothNumber)
  const byRole = { mesial, distal, outer, inner, biting }
  const out: string[] = []
  for (const item of spoken) {
    const role = SPOKEN_SURFACE[normalizeForSearch(String(item))]
    const surface = role ? byRole[role] : undefined
    if (surface && !out.includes(surface)) out.push(surface)
  }
  return out
}

const noTooth = (tooth: unknown) =>
  `La pieza ${String(tooth)} no existe en la numeración FDI. Corrígela.`

/** Pieza y caras de una sugerencia, ya en los valores del sistema; `invalid` si la pieza no existe. */
function normalizeSite(payload: Record<string, unknown>): {
  payload: Record<string, unknown>
  invalid: string | null
} {
  const { toothNumber, surfaces, ...rest } = payload
  if (toothNumber === undefined || toothNumber === null) return { payload: rest, invalid: null }
  if (typeof toothNumber !== "number" || !isValidTooth(toothNumber))
    return { payload: { ...rest, toothNumber }, invalid: noTooth(toothNumber) }
  const faces = normalizeSurfaces(toothNumber, surfaces)
  return {
    payload: { ...rest, toothNumber, ...(faces.length ? { surfaces: faces } : {}) },
    invalid: null,
  }
}

function site(payload: Record<string, unknown>): string {
  const tooth = typeof payload["toothNumber"] === "number" ? `Pieza ${payload["toothNumber"]}` : ""
  const surfaces =
    Array.isArray(payload["surfaces"]) && payload["surfaces"].length
      ? `cara ${(payload["surfaces"] as string[]).map((surface) => surfaceLabel(surface).toLowerCase()).join(", ")}`
      : ""
  return [tooth, surfaces].filter(Boolean).join(" · ")
}

/** «Pieza 36 · Lesión de caries a nivel de la dentina · cara oclusal», el estado y el diagnóstico que deja. */
function findingSummary(payload: Record<string, unknown>): string {
  const condition = String(payload["condition"] ?? "")
  const variant = typeof payload["variant"] === "string" ? payload["variant"] : null
  const name = (variant ? variantLabel(condition, variant) : undefined) ?? conditionLabel(condition)
  const quality =
    payload["quality"] === "good"
      ? "Buen estado"
      : payload["quality"] === "poor"
        ? "Mal estado"
        : ""
  const tooth = typeof payload["toothNumber"] === "number" ? `Pieza ${payload["toothNumber"]}` : ""
  const faces = site({ surfaces: payload["surfaces"] })
  const diagnosis =
    typeof payload["diagnosisCode"] === "string"
      ? `Con el diagnóstico ${payload["diagnosisType"] === "confirmed" ? "definitivo" : "presuntivo"} ${payload["diagnosisCode"]}${payload["diagnosisDescription"] ? ` ${payload["diagnosisDescription"]}` : ""}`
      : ""
  return [[tooth, name, faces].filter(Boolean).join(" · "), quality, diagnosis]
    .filter(Boolean)
    .join("\n")
}

const findingDefinitionOf = (code: string) =>
  DICTATION_FINDINGS.find((finding) => finding.code === code)

/** El hallazgo dictado: por su código o, si el asistente escribió el nombre, por su nombre. */
function dictatedFinding(spoken: string): FindingDefinition | undefined {
  const wanted = normalizeForSearch(spoken)
  return DICTATION_FINDINGS.find(
    (finding) => finding.code === spoken.trim() || normalizeForSearch(finding.label) === wanted,
  )
}

/** La variante dicha: por su valor o por una palabra de su nombre («dentina», «metalcerámica»). */
function dictatedVariant(finding: FindingDefinition, spoken: unknown): string | undefined {
  if (typeof spoken !== "string" || !finding.variants) return undefined
  const exact = finding.variants.find((item) => item.value === spoken.trim())
  if (exact) return exact.value
  const wanted = normalizeForSearch(spoken)
  if (wanted.length < 4) return undefined
  // «dentina» está en «…de la dentina» y en «…de la dentina / compromiso de la pulpa»: vale el más justo, el más corto.
  const named = finding.variants
    .filter((item) => normalizeForSearch(item.label).includes(wanted))
    .sort((a, b) => a.label.length - b.label.length)
  return named[0]?.value
}

/**
 * Un hallazgo dictado, con la misma regla que al tocar la pieza
 * (`validateFinding` con la norma del país). Lo que el país exige y no se
 * dijo (la profundidad de una caries en Perú, el estado de una corona) queda
 * en `missing` y la sugerencia por revisar: la pantalla lo pide con botones o
 * se completa diciéndolo. Si el hallazgo tiene diagnóstico en la lista de la
 * clínica, lo lleva consigo, como lo propone el odontograma al tocar la pieza.
 */
async function prepareFinding(
  tx: Db,
  payload: Record<string, unknown>,
  diagnosisSystem: DiagnosisSystemKey,
  strictVariants: boolean,
): Promise<DictationPrepared> {
  const spoken = String(payload["condition"] ?? "")
  const finding = dictatedFinding(spoken)
  if (!finding) {
    return {
      payload,
      status: "por_revisar",
      note: `No reconozco «${spoken}» como un hallazgo que se pueda dictar. Regístralo tocando la pieza en el odontograma.`,
    }
  }
  const tooth = payload["toothNumber"]
  if (typeof tooth !== "number" || !isValidTooth(tooth)) {
    return {
      payload: { ...payload, condition: finding.code },
      status: "por_revisar",
      note: noTooth(tooth ?? ""),
    }
  }
  const { variant: _variant, quality: _quality, surfaces: _surfaces, ...rest } = payload
  const variant = dictatedVariant(finding, payload["variant"])
  const quality =
    finding.color === "quality" && (payload["quality"] === "good" || payload["quality"] === "poor")
      ? payload["quality"]
      : undefined
  const surfaces = finding.scope === "surface" ? normalizeSurfaces(tooth, payload["surfaces"]) : []
  const missing = [
    ...(finding.variants && !variant && strictVariants ? ["variant"] : []),
    ...(finding.color === "quality" && !quality ? ["quality"] : []),
  ]
  const code = findingDiagnosisCode(diagnosisSystem, finding.code, variant ?? null)
  const known = code ? await findDiagnosisCode(tx, diagnosisSystem, code) : null
  const ready: Record<string, unknown> = {
    ...rest,
    condition: finding.code,
    ...(variant ? { variant } : {}),
    ...(quality ? { quality } : {}),
    ...(surfaces.length ? { surfaces } : {}),
    ...(known && !known.isCategory
      ? { diagnosisCode: known.code, diagnosisSystem, diagnosisDescription: known.description }
      : {}),
  }
  if (!known || known.isCategory)
    for (const key of ["diagnosisCode", "diagnosisSystem", "diagnosisDescription"])
      delete ready[key]
  if (missing.length) {
    const asks = [
      missing.includes("variant")
        ? `Elige ${(finding.variantName ?? "la variante").toLowerCase()}: la norma de tu país lo pide.`
        : "",
      missing.includes("quality") ? "¿En buen o mal estado?" : "",
    ].filter(Boolean)
    return { payload: { ...ready, missing }, status: "por_revisar", note: asks.join(" ") }
  }
  const details: FindingDetails = {
    ...(variant ? { variant } : {}),
    ...(quality ? { quality: quality as "good" | "poor" } : {}),
  }
  const errors = validateFinding(
    { toothNumber: tooth, condition: finding.code, surfaces, details },
    { strictVariants },
  )
  if (errors.length) return { payload: ready, status: "por_revisar", note: errors.join(" ") }
  return { payload: ready, status: "lista", note: null }
}

/**
 * Ajusta una indicación al ámbito de su prestación: una general no lleva pieza
 * y una por pieza no lleva caras, aunque se hayan dictado. Si le falta lo que
 * su ámbito exige, queda por revisar en vez de fallar al confirmar.
 */
/** Lo que falta de una indicación, como pregunta: nunca impide confirmarla. */
const PENDING_TOOTH = "¿En qué pieza? Tócala o dila; si aún no la sabes, confirma igual y la defines al hacerla."
const pendingSurfaces = (tooth: number) =>
  `¿Qué cara de la ${tooth}? Tócala o dila; si aún no la sabes, confirma igual y la defines al hacerla.`

function fitToScope(payload: Record<string, unknown>, scope: string | null): DictationPrepared {
  const { toothNumber, surfaces, ...rest } = payload
  const hasTooth = typeof toothNumber === "number"
  const hasSurfaces = Array.isArray(surfaces) && surfaces.length > 0
  // La pieza y la cara que no se dijeron no frenan: la indicación queda lista con lo
  // que falta a la vista (`pending`), se completa con un toque o dicho, y si no, se
  // define al hacerla. Solo el cuadrante o la arcada se arman desde el plan.
  const { pending: _pending, ...clean } = rest
  if (scope === "general") return { payload: clean, status: "lista", note: null }
  if (scope === "tooth") {
    return hasTooth
      ? { payload: { ...clean, toothNumber }, status: "lista", note: null }
      : { payload: { ...clean, pending: ["toothNumber"] }, status: "lista", note: PENDING_TOOTH }
  }
  if (scope === "surfaces") {
    if (hasTooth && hasSurfaces) return { payload: { ...clean, toothNumber, surfaces }, status: "lista", note: null }
    if (hasTooth) return { payload: { ...clean, toothNumber, pending: ["surfaces"] }, status: "lista", note: pendingSurfaces(toothNumber) }
    return { payload: { ...clean, pending: ["toothNumber", "surfaces"] }, status: "lista", note: PENDING_TOOTH }
  }
  return {
    payload: rest,
    status: "por_revisar",
    note: "Esta prestación se indica por cuadrante o arcada: agrégala desde el plan de tratamiento.",
  }
}

/** Lo que odentIA lee una vez para revisar un tramo: si la norma de su país exige la variante del hallazgo. */
interface DentalDictationContext {
  strictVariants: boolean
}

export const DENTAL_DICTATION: ProductDictation = {
  kinds: ["odontograma"],
  catalogText: dictationFindingsText,
  async context(tx, orgId): Promise<DentalDictationContext> {
    return { strictVariants: await orgStrictVariants(tx, orgId) }
  },
  normalizeSite,
  siteWords: site,
  fitToScope,
  prepare: (tx, _kind, payload, { diagnosisSystem, product }) =>
    prepareFinding(
      tx,
      payload,
      diagnosisSystem,
      (product as DentalDictationContext).strictVariants,
    ),
  summarize: (_kind, payload) => findingSummary(payload),
  modelLabel: (_kind, payload) =>
    [
      String(payload["condition"] ?? ""),
      payload["variant"] ? String(payload["variant"]) : "",
      site(payload),
    ]
      .filter(Boolean)
      .join(", "),
  describeField(key, before) {
    const old = before[key]
    if (key === "toothNumber") return typeof old === "number" ? `pieza ${old}` : "sin pieza"
    if (key === "surfaces")
      return Array.isArray(old) && old.length
        ? `cara ${(old as string[]).map((surface) => surfaceLabel(surface).toLowerCase()).join(", ")}`
        : "sin caras"
    if (key === "variant") {
      const condition = String(before["condition"] ?? "")
      const name = (findingDefinitionOf(condition)?.variantName ?? "variante").toLowerCase()
      return typeof old === "string" ? (variantLabel(condition, old) ?? old) : `sin ${name}`
    }
    if (key === "quality")
      return old === "good" ? "buen estado" : old === "poor" ? "mal estado" : "sin estado"
    if (key === "condition") return conditionLabel(String(old ?? ""))
    return null
  },
  // Un hallazgo que ya está pendiente (la misma pieza, el mismo hallazgo y las mismas caras) no se
  // repite: el asistente a veces corrige una sugerencia y además la vuelve a registrar.
  sameKey: (_kind, payload) =>
    JSON.stringify([
      payload["toothNumber"],
      payload["condition"],
      [...((payload["surfaces"] as string[] | undefined) ?? [])].sort(),
    ]),
  async confirm(tx, { orgId, actorUserId, patientId, encounterId }, _kind, payload) {
    // La misma operación que el panel de la pieza: el hallazgo y, si lo lleva, su diagnóstico de la atención.
    const variant = typeof payload["variant"] === "string" ? payload["variant"] : undefined
    const quality =
      payload["quality"] === "good" || payload["quality"] === "poor"
        ? payload["quality"]
        : undefined
    const created = await registerToothFinding(tx, orgId, actorUserId, patientId, {
      encounterId,
      toothNumbers: [Number(payload["toothNumber"])],
      condition: String(payload["condition"]),
      surfaces: (payload["surfaces"] as string[] | undefined) ?? [],
      details: { ...(variant ? { variant } : {}), ...(quality ? { quality } : {}) },
      note: (payload["note"] as string | undefined) ?? null,
      diagnosis:
        typeof payload["diagnosisCode"] === "string"
          ? {
              diagnosisCode: payload["diagnosisCode"],
              diagnosisSystem:
                typeof payload["diagnosisSystem"] === "string" ? payload["diagnosisSystem"] : null,
              diagnosisType: payload["diagnosisType"] === "confirmed" ? "confirmed" : "provisional",
            }
          : null,
    })
    return created.entries[0]?.id ?? null
  },
}

import { anesthesiaAnswersSchema, type DiagnosisSystemKey, findingDiagnosisCode, isPulpNecrosis } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { odontogramEntry } from "@odentia/db/schema/dental"
import { and, eq, isNull, ne } from "drizzle-orm"
import { z } from "zod"
import {
  anatomyFits,
  conditionLabel,
  type Dentition,
  dentitionOf,
  FINDINGS,
  type FindingDefinition,
  type FindingDetails,
  isValidTooth,
  surfaceLabel,
  surfacesForTooth,
  TOOTH_GROUPS,
  type ToothGroup,
  type TreatmentAnatomy,
  validateFinding,
  variantLabel,
} from "@odentia/dental"
import { findDiagnosisCode } from "../diagnosis-codes.js"
import { DECLARED_HEALTH_SHAPE } from "../dictation-health.js"
import { normalizeForSearch } from "../knowledge.js"
import type { DictationDiagnosis, DictationPatient, DictationPrepared, DictationService, DictationServiceFit, ProductDictation } from "../product-hooks.js"
import { orgStrictVariants } from "./odontogram.js"
import { activeServiceAnatomies } from "./service-finding.js"
import { registerToothFinding } from "./tooth-panel.js"

/* ---------- Lo que Clío dicta de odentIA: los hallazgos del odontograma y la pieza con sus caras ---------- */

/**
 * Hallazgos que se pueden dictar (issue 109, fase 1): los de una pieza, con o
 * sin caras, también el implante, la endodoncia, el espigo-muñón y la
 * impactación desde que no piden marcar que se observaron (mesa del 23 nov).
 * Quedan fuera los que necesitan un dato que la voz no da bien (grado de
 * movilidad, sentido del giro, posiciones) y la observación libre: esos se
 * registran tocando la pieza, como siempre.
 */
const NOT_BY_VOICE = new Set([
  "pathological_mobility",
  "rotation",
  "abnormal_position",
  "clinical_observation",
])
export const DICTATION_FINDINGS: readonly FindingDefinition[] = FINDINGS.filter(
  (finding) =>
    (finding.scope === "tooth" || finding.scope === "surface") && !NOT_BY_VOICE.has(finding.code),
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
  const own = variant ? variantLabel(condition, variant) : undefined
  // El tipo de fractura («Esmalte y dentina») no dice solo qué es: va con el hallazgo. Las demás
  // variantes ya lo nombran («Lesión de caries a nivel de la dentina», «Corona metálica»).
  const name = own
    ? condition === "fracture"
      ? `${conditionLabel(condition)} · ${own.toLowerCase()}`
      : own
    : conditionLabel(condition)
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

/**
 * La clave de un hallazgo de toda la pieza en `DentalDictationContext.current`, con su estado y su
 * tipo: «36:implant:good:». Así lo que cambió (la corona que ahora está en mal estado) sí se propone.
 */
const toothFindingKey = (tooth: number, condition: string, quality?: string | null, variant?: string | null) =>
  `${tooth}:${condition}:${quality ?? ""}:${variant ?? ""}`

/**
 * Lo de toda la pieza (sin caras) que el paciente ya tiene vigente: ni anulado, ni resuelto, ni
 * por revisar. Clío no lo vuelve a proponer (mesa del 23 nov): el implante de la 36 que ya está en
 * el odontograma, dictado otra vez al describir la boca, sería un hallazgo repetido.
 */
async function currentToothFindings(tx: Db, orgId: string, patientId: string): Promise<Set<string>> {
  const rows = await tx
    .select({
      toothNumber: odontogramEntry.toothNumber,
      condition: odontogramEntry.condition,
      surface: odontogramEntry.surface,
      details: odontogramEntry.details,
    })
    .from(odontogramEntry)
    .where(
      and(
        eq(odontogramEntry.organizationId, orgId),
        eq(odontogramEntry.patientId, patientId),
        isNull(odontogramEntry.voidedAt),
        ne(odontogramEntry.status, "voided"),
        isNull(odontogramEntry.resolvedAt),
        eq(odontogramEntry.needsReview, false),
      ),
    )
  const keys = new Set<string>()
  for (const row of rows) {
    if (row.surface) continue
    const details = (row.details ?? {}) as FindingDetails
    // Dicho sin estado ni tipo, también es el mismo hallazgo: se guarda la clave sin ellos.
    keys.add(toothFindingKey(row.toothNumber, row.condition))
    keys.add(toothFindingKey(row.toothNumber, row.condition, details.quality, details.variant))
    if (details.quality) keys.add(toothFindingKey(row.toothNumber, row.condition, details.quality))
    if (details.variant) keys.add(toothFindingKey(row.toothNumber, row.condition, undefined, details.variant))
  }
  return keys
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
  { strictVariants, current }: Pick<DentalDictationContext, "strictVariants" | "current">,
): Promise<DictationPrepared | null> {
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
  // Lo de toda la pieza que ya tiene vigente, con el mismo estado y tipo (o dicho sin ellos), no se
  // propone otra vez (null: no es una sugerencia). Si cambió, sí: la corona ahora en mal estado.
  if (finding.scope === "tooth" && current.has(toothFindingKey(tooth, finding.code, quality, variant))) return null
  const surfaces = finding.scope === "surface" ? normalizeSurfaces(tooth, payload["surfaces"]) : []
  // Un hallazgo por cara dicho sin cara (una caries en la 36): la cara se elige con un
  // toque. Lo que además admite el dibujo de su forma se dibuja tocando la pieza.
  const missing = [
    ...(finding.color === "quality" && !quality ? ["quality"] : []),
    ...(finding.scope === "surface" && surfaces.length === 0 ? ["surfaces"] : []),
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
      missing.includes("quality") ? "¿En buen o mal estado?" : "",
      // Solo con un toque: dicha después, la cara llega como otro hallazgo (su clave lleva las caras).
      missing.includes("surfaces") ? `¿Qué cara de la ${tooth}? Elígela aquí.` : "",
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

/** Lo hecho hoy sí lleva su sitio: se pregunta, y se responde con un toque o dicho. */
const DONE_TOOTH = "¿En qué pieza lo hiciste? Tócala o dila."
const doneSurfaces = (tooth: number) => `¿Qué cara de la ${tooth} trabajaste? Tócala o dila.`

function fitToScope(payload: Record<string, unknown>, scope: string | null, done = false): DictationPrepared {
  const fitted = fitIndication(payload, scope)
  const pending = Array.isArray(fitted.payload["pending"]) ? (fitted.payload["pending"] as string[]) : []
  if (!done || pending.length === 0) return fitted
  const tooth = fitted.payload["toothNumber"]
  return { ...fitted, status: "por_revisar", note: pending.includes("toothNumber") || typeof tooth !== "number" ? DONE_TOOTH : doneSurfaces(tooth) }
}

function fitIndication(payload: Record<string, unknown>, scope: string | null): DictationPrepared {
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

/* ---------- Para qué piezas es una prestación dicha (prueba con voz del 15 nov, c3) ---------- */

/** Para qué piezas es un servicio: su dentición (null: las dos) y sus grupos (vacío: todos). */
type ServiceAnatomy = Pick<TreatmentAnatomy, "groups" | "dentition">

/** De leche: «deciduo», «de leche» o «diente temporal». «Temporal» solo no: «Restauración temporal» no es de leche. */
const DECIDUOUS_WORDS = /\b(?:decidu[oa]s?|de leche|(?:dientes?|denticion|piezas?|molar(?:es)?)\s+temporal(?:es)?)\b/
const PERMANENT_WORDS = /\bpermanentes?\b/
/** El grupo por la palabra con que lo nombra la biblioteca; «posterior», amplio (premolares y molares). */
const GROUP_WORDS: ReadonlyArray<readonly [RegExp, readonly ToothGroup[]]> = [
  [/\banterior(?:es)?\b/, ["anterior"]],
  [/\bposterior(?:es)?\b/, ["premolar", "molar"]],
  [/\b(?:bicuspides?|premolar(?:es)?)\b/, ["premolar"]],
  [/\bmolar(?:es)?\b/, ["molar"]],
]

/**
 * Lo que dicen el nombre y el código de un servicio sin la anatomía de la biblioteca (uno propio de
 * la clínica, o de un tratamiento que no la tiene, como «Corona de acero prefabricada, deciduo»):
 * su dentición y su grupo de piezas. Es una desviación consciente de `treatment-anatomy.ts`, que
 * nunca deduce del nombre: aquí solo sirve para no proponer lo de otra pieza, y por eso
 * «posterior» se lee amplio, para no dejar fuera lo que sí calza. null: el nombre no dice nada.
 */
export function anatomyFromName(service: Pick<DictationService, "name" | "code">): ServiceAnatomy | null {
  const said = normalizeForSearch(`${service.name} ${service.code ?? ""}`)
  const dentition: Dentition | null = DECIDUOUS_WORDS.test(said) ? "deciduous" : PERMANENT_WORDS.test(said) ? "permanent" : null
  const groups = [...new Set(GROUP_WORDS.flatMap(([words, named]) => (words.test(said) ? named : [])))]
  return dentition || groups.length ? { groups, dentition } : null
}

/**
 * Si un servicio puede ser lo dicho (`ProductDictation.serviceFit`): en una pieza FDI, el de otra
 * dentición nunca y el de otro grupo solo si ninguno del suyo calza (`anatomyFits`: la 36 es un
 * molar permanente, ni la pulpectomía de leche ni la endodoncia anterior); sin pieza, a un adulto
 * nunca uno de leche. La anatomía es la que se leyó de la clínica (`context`) o, sin ella, la que
 * dicen su nombre y su código. La variante vital o no vital sigue a la pulpa diagnosticada en esa
 * pieza (`pulpFit`).
 */
function serviceFit(service: DictationService, where: Record<string, unknown>, patient: DictationPatient, context?: unknown): DictationServiceFit {
  const fit = anatomyFit(service, where, patient, context as DentalDictationContext | undefined)
  return fit === "fits" ? pulpFit(service, where, patient, context as DentalDictationContext | undefined) : fit
}

function anatomyFit(service: DictationService, where: Record<string, unknown>, patient: DictationPatient, context?: DentalDictationContext): DictationServiceFit {
  const read = context?.anatomy
  const anatomy = service.id && read?.has(service.id) ? read.get(service.id) : anatomyFromName(service)
  if (!anatomy) return "fits"
  const tooth = where["toothNumber"]
  if (typeof tooth !== "number" || !isValidTooth(tooth)) return patient.adult && anatomy.dentition === "deciduous" ? "never" : "fits"
  if (anatomy.dentition && anatomy.dentition !== dentitionOf(tooth)) return "never"
  return anatomyFits({ groups: anatomy.groups.length ? anatomy.groups : TOOTH_GROUPS, dentition: null }, tooth) ? "fits" : "fallback"
}

/* ---------- La variante que depende de la pulpa (prueba con voz del 15 nov, c5, v06) ---------- */

/** La pulpa viva o necrótica: decide la endodoncia vital o no vital. */
type PulpState = "vital" | "necrotic"

/** La familia de la biblioteca que dice la variante (la misma de la decisión B2 del 10 nov). */
const PULP_FAMILY: Readonly<Record<string, PulpState>> = { "endodoncia-vital": "vital", "endodoncia-no-vital": "necrotic" }
/** Un tratamiento de la pulpa, por su nombre: «Endodoncia…», «Tratamiento de conductos…», «Biopulpectomía». */
const PULP_TREATMENT = /\b(?:endodon[a-z]*|conductos?|[a-z]*pulp[a-z]*)\b/
/** Lo que dice que la pulpa no está viva: «no vital» (también «no es vital»), la necrosis, el absceso apical. */
const NECROTIC = /\bno (?:[a-z]+ )?vital\b|\bnecro(?:sis|tic[oa]s?|sad[oa]s?|pulp[a-z]*)\b|\babscesos? (?:peri)?apical(?:es)?\b|\babsceso dentoalveolar\b/
/** Lo que dice que está viva: la pulpitis, «vital», la biopulpectomía. */
const VITAL = /\bpulpitis\b|\bvital\b|\bbiopulp[a-z]*/
/** La pulpitis en la CIE-10 y en la CIE-11 (los atajos de `PULP_DIAGNOSES` de `@odentia/clinical`). */
const PULPITIS = /^(?:K04\.0|DA09\.0)/

/** Lo que dice de la pulpa un texto ya normalizado (`normalizeForSearch`); null si no dice nada, o dice las dos cosas. */
function pulpSaid(said: string): PulpState | null {
  const necrotic = NECROTIC.test(said)
  // «no vital» también dice «vital»: cuenta solo el «vital» que no niega nada.
  const vital = VITAL.test(said.replace(NECROTIC, " "))
  return necrotic === vital ? null : necrotic ? "necrotic" : "vital"
}

/**
 * La variante de un tratamiento de la pulpa: la de su familia de la biblioteca o, sin ella, la que
 * nombra el servicio («Endodoncia unirradicular no vital»); null si no tiene.
 */
export function pulpVariantOf(service: Pick<DictationService, "name">, family?: string | null): PulpState | null {
  if (family) return PULP_FAMILY[family] ?? null
  const name = normalizeForSearch(service.name)
  return PULP_TREATMENT.test(name) ? pulpSaid(name) : null
}

/**
 * La pulpa de un diagnóstico: la pulpitis está viva; la necrosis y lo que la presupone no
 * (`isPulpNecrosis`, la misma regla del aviso de la pieza). Con otro código, lo que dice su nombre o
 * lo dicho.
 */
function pulpOfDiagnosis(item: DictationDiagnosis): PulpState | null {
  const code = String(item.code ?? "").trim().toUpperCase()
  if (isPulpNecrosis(code)) return "necrotic"
  if (PULPITIS.test(code)) return "vital"
  return pulpSaid(normalizeForSearch(item.text))
}

/**
 * La pulpa diagnosticada donde va el servicio: lo de esa pieza y lo de toda la atención. null si no
 * se dijo nada o se dijeron las dos (la pulpitis en la ficha y la necrosis en Diagnóstico).
 */
function pulpAt(where: Record<string, unknown>, patient: DictationPatient): PulpState | null {
  const tooth = where["toothNumber"]
  const states = new Set(
    (patient.diagnoses ?? []).flatMap((item) => {
      const at = item.where?.["toothNumber"]
      if (typeof tooth === "number" && typeof at === "number" && at !== tooth) return []
      return pulpOfDiagnosis(item) ?? []
    }),
  )
  return states.size === 1 ? ([...states][0] ?? null) : null
}

/**
 * La variante que depende de la pulpa sigue al diagnóstico: con la pulpitis, la vital; con la
 * necrosis o el absceso, la no vital. La otra solo se ofrece para elegir, si no hay la que calza, y,
 * si no se sabe, ninguna se da por buena: se elige entre las dos (`unsure`).
 */
function pulpFit(service: DictationService, where: Record<string, unknown>, patient: DictationPatient, context?: DentalDictationContext): DictationServiceFit {
  const variant = service.id && context?.pulp.has(service.id) ? context.pulp.get(service.id) : pulpVariantOf(service)
  if (!variant) return "fits"
  const known = pulpAt(where, patient)
  if (!known) return "unsure"
  return known === variant ? "fits" : "fallback"
}

/**
 * Lo que odentIA lee una vez para revisar un tramo: si su país nombra la variante del hallazgo
 * por su sigla (es opcional en todos, ADR 0200), para qué piezas es cada servicio activo y si es una endodoncia vital o no vital (de la
 * biblioteca o, sin ella, de su nombre).
 */
export interface DentalDictationContext {
  strictVariants: boolean
  /** Lo de toda la pieza que el paciente ya tiene vigente (`pieza:hallazgo`); vacío sin paciente. */
  current: ReadonlySet<string>
  anatomy: ReadonlyMap<string, ServiceAnatomy | null>
  pulp: ReadonlyMap<string, PulpState | null>
}

const DECLARED_MOUTH = DECLARED_HEALTH_SHAPE.dental.unwrap()
const DECLARED_HABITS = DECLARED_HEALTH_SHAPE.medical.unwrap().shape

/**
 * Lo de su salud dicho en la consulta que pregunta odentIA (mesa del 20 nov 2026), con la forma de
 * su registro: la anestesia y el sangrado tras una extracción, el corazón, el miedo, el bruxismo,
 * sus hábitos, su última visita y lo de un niño en casa; la lactancia y el tabaco. La anestesia va
 * con su respuesta por separado (`anesthesiaAnswersSchema`), no con la pregunta doble de antes.
 */
export const DENTAL_DICTATION_HEALTH = {
  dental: DECLARED_MOUTH.pick({
    corazon: true,
    ansiedadDental: true,
    bruxismo: true,
    habitos: true,
    ultimaVisita: true,
    biberon: true,
    chupon: true,
    dulcesEntreComidas: true,
    pastaConFluor: true,
    quienCepilla: true,
  })
    .extend({ problemaAnestesia: anesthesiaAnswersSchema.optional() })
    .optional()
    .describe(
      "Lo de su boca que contó: si tuvo problemas con la anestesia del dentista o sangró mucho tras una extracción (`problemaAnestesia`, cada uno con `si`, `no` o `no_sabe`), lo del corazón que pide antibiótico antes (`corazon`), el miedo al dentista, si rechina o aprieta los dientes, sus hábitos (morderse las uñas, morder lapiceros), cuándo fue su última visita y, de un niño, el biberón, el chupón, los dulces entre comidas, la pasta con flúor y quién le cepilla.",
    ),
  medical: z
    .strictObject({ lactancia: DECLARED_HABITS.lactancia, tabaco: DECLARED_HABITS.tabaco, cigarrillos: DECLARED_HABITS.cigarrillos })
    .optional()
    .describe("Si da de lactar y si fuma (`cigarrillos`, cuántos al día, solo de quien fuma)."),
} satisfies z.ZodRawShape

export const DENTAL_DICTATION: ProductDictation = {
  kinds: ["odontograma"],
  health: DENTAL_DICTATION_HEALTH,
  // «la resina de la pieza 36 por oclusal», «la endodoncia de la molar»: la pieza, su tipo, el lado y
  // la cara dicen dónde, no cuál prestación. «Superior» y «anterior» no: también distinguen servicios.
  placeWords: [
    "pieza", "piezas", "diente", "dientes", "muela", "muelas", "molar", "molares", "premolar", "premolares", "incisivo", "incisivos", "canino", "caninos",
    "derecho", "derecha", "izquierdo", "izquierda", "cara", "caras", "oclusales", ...Object.keys(SPOKEN_SURFACE),
  ],
  catalogText: dictationFindingsText,
  async context(tx, orgId, patientId): Promise<DentalDictationContext> {
    const strictVariants = await orgStrictVariants(tx, orgId)
    const services = await activeServiceAnatomies(tx, orgId)
    return {
      strictVariants,
      current: patientId ? await currentToothFindings(tx, orgId, patientId) : new Set(),
      anatomy: new Map(services.map((service) => [service.id, service.anatomy ?? anatomyFromName(service)])),
      pulp: new Map(services.map((service) => [service.id, pulpVariantOf(service, service.family)])),
    }
  },
  serviceFit,
  normalizeSite,
  siteWords: site,
  fitToScope,
  prepare: (tx, _kind, payload, { diagnosisSystem, product }) =>
    prepareFinding(tx, payload, diagnosisSystem, product as DentalDictationContext),
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

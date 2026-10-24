import {
  ADMINISTRATION_ROUTES,
  allergyWarnings,
  BUDGET_OPTIONS_MAX,
  DIAGNOSIS_SYSTEM_INFO,
  DIAGNOSIS_VERIFICATION_LABELS,
  type DiagnosisSystemKey,
  findMedication,
  isDiagnosisVerification,
  type MedicationCatalog,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  DICTATION_KINDS,
  type DictationKind,
  encounterDictationSuggestion,
  patientAllergy,
  prescription,
  serviceCatalog,
  treatmentBudgetOption,
} from "@odentia/db/schema/clinical"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, eq, inArray, sql } from "drizzle-orm"
import { getAgentConfig } from "./agentConfig.js"
import { findDiagnosisCode, orgDiagnosisSystem } from "./diagnosis-codes.js"
import { addEncounterDiagnosis } from "./encounter-diagnoses.js"
import { assertOpenDraft, lockEncounter, updateEncounterDraft, type UpdateEncounterDraftPatch } from "./encounters.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { createFollowUp } from "./follow-ups.js"
import { normalizeForSearch } from "./knowledge.js"
import { findOrgLocale, formatOrgMoney, type OrgLocale, orgProduct } from "./locale.js"
import { OPERATIONS, operationAgentSchema } from "./operation-fields.js"
import { addBudgetItems, createBudget, duplicateBudgetOption, findDraftBudget, removeBudgetItems } from "./budgets.js"
import { addPlanItem } from "./plan.js"
import { createPrescription } from "./prescriptions.js"
import type { DictationPrepared, ProductDictation } from "./product-hooks.js"
import { productHooks, requireDictatingProduct } from "./products.js"

/*
 * ---------- Asistente clínico: lo dictado se vuelve sugerencias que el profesional confirma ----------
 *
 * Lo común de Clío (ADR 0012 y 0079): guardar cada tramo, corregir y quitar
 * por voz, confirmar con la operación de siempre y descartar. Lo del producto
 * (odentIA: los hallazgos del odontograma y la pieza con sus caras) lo pone su
 * `ProductDictation`.
 */

function conflict(code: string, message: string): ServiceError {
  return new ServiceError(code, 409, message)
}

/** Texto máximo de un dictado que se procesa de una vez. */
export const DICTATION_CHARS = 12_000
/** Sugerencias que se guardan de un tramo del dictado: más que esto es ruido, no una atención. */
export const DICTATION_MAX_SUGGESTIONS = 40
/** Lo que se guarda de «lo que dijiste» de cada sugerencia. */
export const DICTATION_SOURCE_CHARS = 600
const SERVICE_CANDIDATES = 3

export const DICTATION_KIND_LABEL: Record<DictationKind, string> = {
  nota: "Consulta",
  diagnostico: "Diagnóstico",
  plan: "Plan de tratamiento",
  control: "Controles",
  odontograma: "Odontograma",
  receta: "Receta",
}

/** Operación de la atención que ejecuta cada clase de sugerencia al confirmarse. */
export const DICTATION_OPERATION = {
  nota: "atencion.nota",
  diagnostico: "atencion.diagnostico",
  plan: "plan.indicacion",
  control: "control.crear",
  odontograma: "odontograma.hallazgo",
  receta: "receta.medicamento",
} as const satisfies Record<DictationKind, keyof typeof OPERATIONS>

export interface DictationDraft {
  kind: DictationKind
  /** Campos de la operación, tal como los llenó el asistente. */
  payload: Record<string, unknown>
  /** Lo que dijo el odontólogo y dio lugar a la sugerencia. */
  sourceText?: string
}

export interface DictationSuggestion {
  id: string
  kind: DictationKind
  payload: Record<string, unknown>
  sourceText: string
  status: "lista" | "por_revisar" | "confirmada" | "descartada"
  note: string | null
  /** Texto corto de lo que entraría a la historia. */
  summary: string
  /** Corregida por voz al seguir dictando: qué decía antes, para poder deshacerlo. */
  voice: { before: string } | null
  /** Quitada por voz («quita la endodoncia»): lo que dijo, para poder deshacerlo. */
  removal: { said: string } | null
  createdAt: string
}

/**
 * Datos de la sugerencia que no son de su operación: de qué tramo del dictado
 * salió (para no ordenarlo dos veces), cómo estaba antes de una corrección por
 * voz y cómo estaba antes de que se pidiera quitarla. Van dentro de `payload`
 * bajo `_meta` y nunca salen de este módulo ni llegan a la operación al
 * confirmar.
 */
interface SuggestionMeta {
  segments?: string[]
  voice?: { payload: Record<string, unknown>; status: "lista" | "por_revisar"; note: string | null; before: string } | undefined
  removal?: { status: "lista" | "por_revisar"; said: string } | undefined
}
const META = "_meta"

function splitMeta(payload: Record<string, unknown>): { data: Record<string, unknown>; meta: SuggestionMeta } {
  const { [META]: meta, ...data } = payload
  return { data, meta: meta && typeof meta === "object" ? (meta as SuggestionMeta) : {} }
}

function withMeta(data: Record<string, unknown>, meta: SuggestionMeta): Record<string, unknown> {
  const kept = Object.fromEntries(Object.entries(meta).filter(([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0)))
  return Object.keys(kept).length ? { ...data, [META]: kept } : data
}

/** ¿El asistente clínico está encendido en esta clínica? Devuelve lo que dicta su producto. */
export async function requireClinicalAssistant(tx: Db, orgId: string): Promise<ProductDictation> {
  const dictation = await requireDictatingProduct(tx, orgId)
  const cfg = await getAgentConfig(tx, orgId)
  if (!cfg.clinicalAssistantEnabled) {
    throw new ServiceError("CLINICAL_ASSISTANT_OFF", 409, "Clío está apagada en esta clínica")
  }
  return dictation
}

interface ServiceOption {
  id: string
  name: string
  priceCents: number
  currency: string
  /** Ámbito de la prestación: decide si lleva pieza, superficies, o nada. */
  scope: string | null
}

async function activeServices(tx: Db, orgId: string): Promise<ServiceOption[]> {
  return tx
    .select({ id: serviceCatalog.id, name: serviceCatalog.name, priceCents: serviceCatalog.priceCents, currency: serviceCatalog.currency, scope: serviceCatalog.scope })
    .from(serviceCatalog)
    .where(and(eq(serviceCatalog.organizationId, orgId), eq(serviceCatalog.isActive, true)))
    .orderBy(asc(serviceCatalog.name))
    .limit(500)
}

/**
 * Lo que el asistente necesita saber de la clínica para entender un dictado:
 * su producto (con qué prompt y formato dicta), sus prestaciones, su lista de
 * diagnósticos y lo que el producto le da (odentIA: los hallazgos que se dictan).
 */
export async function getDictationCatalog(
  tx: Db,
  orgId: string,
): Promise<{
  product: Awaited<ReturnType<typeof orgProduct>>
  services: Array<{ name: string }>
  diagnosisSystem: { key: DiagnosisSystemKey; title: string }
  catalog: string
}> {
  const dictation = await requireDictatingProduct(tx, orgId)
  const system = await orgDiagnosisSystem(tx, orgId)
  return {
    product: await orgProduct(tx, orgId),
    services: (await activeServices(tx, orgId)).map((service) => ({ name: service.name })),
    diagnosisSystem: { key: system, title: DIAGNOSIS_SYSTEM_INFO[system].title },
    catalog: dictation.catalogText(),
  }
}

/** Lo de la clínica con que se revisa una sugerencia: sus servicios, su lista de diagnósticos, su receta y lo del producto. */
interface DictationScope {
  services: ServiceOption[]
  diagnosisSystem: DiagnosisSystemKey
  medications: MedicationCatalog
  dictation: ProductDictation
  /** Lo que el producto leyó para revisar (`ProductDictation.context`). */
  product: unknown
}

async function dictationScope(tx: Db, orgId: string): Promise<DictationScope> {
  const dictation = await requireDictatingProduct(tx, orgId)
  return {
    services: await activeServices(tx, orgId),
    diagnosisSystem: await orgDiagnosisSystem(tx, orgId),
    medications: (await productHooks(tx, orgId)).prescribing.catalog,
    dictation,
    product: await dictation.context(tx, orgId),
  }
}

/** Las clases de sugerencia de todo producto; cada uno suma las suyas (`ProductDictation.kinds`). */
const COMMON_KINDS: readonly DictationKind[] = ["nota", "diagnostico", "plan", "control", "receta"]

const words = (text: string) => normalizeForSearch(text).split(" ").filter((word) => word.length >= 3)

/** La prestación del tarifario que nombró el odontólogo, o las más parecidas si no hay una sola. */
function matchService(spoken: string, services: ServiceOption[]): { match: ServiceOption | null; candidates: ServiceOption[] } {
  const wanted = normalizeForSearch(spoken)
  const exact = services.filter((service) => normalizeForSearch(service.name) === wanted)
  if (exact.length === 1) return { match: exact[0] ?? null, candidates: [] }
  const tokens = words(spoken)
  const scored = services
    .map((service) => {
      const name = normalizeForSearch(service.name)
      const own = words(service.name)
      const shared = tokens.filter((token) => own.some((word) => word.startsWith(token.slice(0, 5)) || token.startsWith(word.slice(0, 5)))).length
      return { service, shared, contains: name.includes(wanted) || wanted.includes(name) }
    })
    .filter((item) => item.shared > 0 || item.contains)
    .sort((a, b) => Number(b.contains) - Number(a.contains) || b.shared - a.shared)
  const [best, second] = scored
  // Una sola coincidencia clara se da por buena; si hay varias parecidas, elige el odontólogo.
  if (best && best.contains && (!second || !second.contains) && best.shared >= Math.min(tokens.length, words(best.service.name).length)) {
    return { match: best.service, candidates: [] }
  }
  return { match: null, candidates: scored.slice(0, SERVICE_CANDIDATES).map((item) => item.service) }
}

/** Formato y zona de la clínica con los que se escribe el resumen de una sugerencia. */
type Zone = Pick<OrgLocale, "locale" | "timezone">

const NOTE_LABEL = Object.fromEntries(Object.entries(OPERATIONS["atencion.nota"].fields).map(([key, field]) => [key, field.label]))

function summarize(kind: DictationKind, payload: Record<string, unknown>, zone: Zone, dictation: ProductDictation): string {
  if (kind === "nota") {
    return Object.entries(payload)
      .filter(([, value]) => typeof value === "string" && value.trim())
      .map(([key, value]) => `${NOTE_LABEL[key] ?? key}: ${String(value)}`)
      .join("\n")
  }
  if (kind === "diagnostico") {
    const type = isDiagnosisVerification(payload["diagnosisType"]) ? DIAGNOSIS_VERIFICATION_LABELS[payload["diagnosisType"]] : ""
    return [`${payload["diagnosisCode"] ?? ""}${payload["description"] ? ` · ${payload["description"]}` : ""}`, [dictation.siteWords(payload), type].filter(Boolean).join(" · ")]
      .filter(Boolean)
      .join("\n")
  }
  if (dictation.kinds.includes(kind)) return dictation.summarize(kind, payload)
  if (kind === "plan") {
    // La tarifa lleva la moneda del tarifario; sin moneda no se inventa una: no se escribe el importe.
    const price =
      typeof payload["priceCents"] === "number" && typeof payload["currency"] === "string"
        ? formatOrgMoney(payload["priceCents"], payload["currency"], zone)
        : ""
    const choice = (option: PlanChoice) => {
      const cost = typeof option.priceCents === "number" && typeof option.currency === "string" ? formatOrgMoney(option.priceCents, option.currency, zone) : ""
      return `${option.serviceName ?? option.service ?? ""}${cost ? ` · ${cost}` : ""}`
    }
    const options = Array.isArray(payload["options"]) ? (payload["options"] as PlanChoice[]) : []
    if (options.length) {
      // Dos o tres caminos para lo mismo: la principal es la opción A, la recomendada.
      const how = options.length === 1 ? "Dos caminos" : "Tres caminos"
      const tooth = typeof payload["toothNumber"] === "number" ? ` para la ${payload["toothNumber"]}` : ""
      return [`${how}${tooth} · elige uno`, `Opción A · recomendada: ${choice(payload as PlanChoice)}`, ...options.map((option, index) => `Opción ${OPTION_LETTER[index + 1]}: ${choice(option)}`)].join("\n")
    }
    return [`${payload["serviceName"] ?? payload["service"] ?? ""}${price ? ` · ${price}` : ""}`, dictation.siteWords(payload), payload["detail"]].filter(Boolean).join("\n")
  }
  if (kind === "receta") {
    const name = String(payload["genericName"] ?? "")
    const title = [`${name.charAt(0).toUpperCase()}${name.slice(1)}`, payload["strength"]].filter(Boolean).join(" ")
    const how = [payload["dose"], payload["route"] ? `vía ${payload["route"]}` : "", payload["frequency"], payload["duration"] ? `por ${payload["duration"]}` : ""].filter(Boolean).join(" · ")
    const quantity = typeof payload["quantity"] === "number" ? `Cantidad total: ${payload["quantity"]}${payload["quantityCalculated"] ? " (calculada)" : ""}` : ""
    return [[title, payload["dosageForm"]].filter(Boolean).join(" · "), how, quantity].filter(Boolean).join("\n")
  }
  const due = typeof payload["dueAt"] === "string" ? new Date(payload["dueAt"]).toLocaleDateString(zone.locale, { timeZone: zone.timezone, day: "numeric", month: "long", year: "numeric" }) : ""
  return [String(payload["title"] ?? "Control"), due ? `Alrededor del ${due}` : "", payload["instructions"]].filter(Boolean).join("\n")
}

function toItem(row: typeof encounterDictationSuggestion.$inferSelect, zone: Zone, dictation: ProductDictation): DictationSuggestion {
  const { data, meta } = splitMeta(row.payload)
  return {
    id: row.id,
    kind: row.kind,
    payload: data,
    sourceText: row.sourceText,
    status: row.status as DictationSuggestion["status"],
    note: row.note,
    summary: summarize(row.kind, data, zone, dictation),
    voice: meta.voice ? { before: meta.voice.before } : null,
    removal: row.status === "descartada" && meta.removal ? { said: meta.removal.said } : null,
    createdAt: row.createdAt.toISOString(),
  }
}

/**
 * Cómo se le nombra una sugerencia pendiente al asistente cuando el odontólogo
 * sigue dictando, para que entienda «no, es la veintiséis» o «quita la
 * endodoncia». Solo lo que salió del propio dictado: sin tarifas.
 */
export function dictationModelLabel(item: Pick<DictationSuggestion, "kind" | "payload">, dictation: ProductDictation): string {
  const payload = item.payload
  const what =
    item.kind === "nota"
      ? Object.keys(payload).map((key) => NOTE_LABEL[key] ?? key).join(", ")
      : item.kind === "diagnostico"
        ? [`${payload["diagnosisCode"] ?? ""}${payload["description"] ? ` ${payload["description"]}` : ""}`, dictation.siteWords(payload)].filter(Boolean).join(", ")
        : item.kind === "plan"
          ? [
              [String(payload["serviceName"] ?? payload["service"] ?? ""), ...(Array.isArray(payload["options"]) ? (payload["options"] as PlanChoice[]).map((option) => String(option.serviceName ?? option.service ?? "")) : [])].join(" o "),
              dictation.siteWords(payload),
            ].filter(Boolean).join(", ")
          : item.kind === "receta"
            ? [payload["genericName"], payload["strength"], payload["duration"] ? `por ${payload["duration"]}` : ""].filter(Boolean).join(" ")
            : dictation.kinds.includes(item.kind)
            ? dictation.modelLabel(item.kind, payload)
            : String(payload["title"] ?? "Control")
  return `${DICTATION_KIND_LABEL[item.kind]}: ${what}`
}

/**
 * Deja una sugerencia lista o por revisar. Se valida con el mismo esquema que
 * usa el asistente para llenarla; lo que no encaja o le falta algo que solo
 * una persona puede elegir queda `por_revisar` con el motivo, nunca se pierde.
 */
async function prepare(tx: Db, draft: DictationDraft, scope: DictationScope): Promise<Prepared | null> {
  const { services, diagnosisSystem, dictation } = scope
  const own = dictation.kinds.includes(draft.kind)
  if (!own && !COMMON_KINDS.includes(draft.kind)) return null
  const parsed = operationAgentSchema(DICTATION_OPERATION[draft.kind]).safeParse(draft.payload)
  if (!parsed.success) {
    return { payload: draft.payload, status: "por_revisar", note: "No pude ubicar todos los datos de esto. Revísalo antes de confirmar." }
  }
  // Un texto en blanco es un campo que no se dictó.
  const payload = Object.fromEntries(
    Object.entries(parsed.data as Record<string, unknown>)
      .map(([key, value]) => [key, typeof value === "string" ? value.trim() : value] as const)
      .filter(([, value]) => value !== undefined && value !== null && value !== ""),
  )
  if (draft.kind === "nota") return Object.keys(payload).length ? { payload, status: "lista", note: null } : null
  if (own) return dictation.prepare(tx, draft.kind, payload, { diagnosisSystem, product: scope.product })
  if (draft.kind === "diagnostico" || draft.kind === "plan") {
    const site = dictation.normalizeSite(payload)
    if (site.invalid) return { payload: site.payload, status: "por_revisar", note: site.invalid }
    for (const key of Object.keys(payload)) if (!(key in site.payload)) delete payload[key]
    Object.assign(payload, site.payload)
  }
  if (draft.kind === "diagnostico") {
    // Se valida contra la lista de la clínica: un código de otra lista no se acepta.
    const code = String(payload["diagnosisCode"] ?? "").trim().toUpperCase()
    const known = code ? await findDiagnosisCode(tx, diagnosisSystem, code) : null
    const list = DIAGNOSIS_SYSTEM_INFO[diagnosisSystem].title
    if (!known) return { payload: { ...payload, diagnosisCode: code, diagnosisSystem }, status: "por_revisar", note: `El código ${code} no está en la lista ${list} de la clínica. Elige el diagnóstico.` }
    if (known.isCategory) return { payload: { ...payload, diagnosisCode: known.code, diagnosisSystem, description: known.description }, status: "por_revisar", note: `${known.code} es una categoría: elige el subcódigo más específico.` }
    return { payload: { ...payload, diagnosisCode: known.code, diagnosisSystem, description: known.description }, status: "lista", note: null }
  }
  if (draft.kind === "plan") {
    // «Resina, o si no una corona»: los otros caminos se buscan igual que la principal.
    const { alternatives, ...main } = payload
    const options = Array.isArray(alternatives) ? alternatives.filter((spoken) => typeof spoken === "string" && spoken.trim()).map((spoken) => ({ service: String(spoken).trim() })) : []
    return settlePlan({ ...main, ...(options.length ? { options } : {}) }, services, dictation)
  }
  if (draft.kind === "receta") return prepareMedication(payload, scope.medications)
  return { payload, status: "lista", note: null }
}

/** Lo que se busca en el tarifario de una prestación dicha: el servicio si hay uno solo, o las candidatas. */
type PlanChoice = { service?: string; serviceId?: string; serviceName?: string; priceCents?: number; currency?: string; serviceScope?: string | null; candidates?: ServiceOption[] }

function chooseService(choice: PlanChoice, services: ServiceOption[]): PlanChoice {
  const chosen = typeof choice.serviceId === "string" ? services.find((service) => service.id === choice.serviceId) : undefined
  const match = chosen ?? matchService(String(choice.service ?? ""), services).match
  if (match) return { service: choice.service ?? match.name, serviceId: match.id, serviceName: match.name, priceCents: match.priceCents, currency: match.currency, serviceScope: match.scope }
  return { service: choice.service ?? "", candidates: matchService(String(choice.service ?? ""), services).candidates }
}

const OPTION_LETTER = ["A", "B", "C"]

/**
 * Una indicación del plan, con sus otros caminos si se dijeron (issue 109,
 * fase 2). La principal es la recomendada (la opción A del presupuesto); cada
 * camino busca su servicio en el tarifario como la principal. Queda lista solo
 * si todos tienen su servicio.
 */
function settlePlan(payload: Record<string, unknown>, services: ServiceOption[], dictation: ProductDictation): Prepared {
  const { options: rawOptions, candidates: _candidates, ...rest } = payload
  const main = chooseService(rest as PlanChoice, services)
  const base = { ...rest, ...main }
  delete base["candidates"]
  const fitted: Prepared = main.serviceId
    ? dictation.fitToScope(base, main.serviceScope ?? null)
    : {
        payload: { ...base, candidates: main.candidates ?? [] },
        status: "por_revisar",
        note: main.candidates?.length
          ? `Dijiste «${main.service}» y no coincide con una sola prestación de tus servicios. Elige cuál es.`
          : `Dijiste «${main.service}» y no está en tus servicios. Elige la prestación.`,
      }
  if (!Array.isArray(rawOptions) || rawOptions.length === 0) return fitted
  const options = (rawOptions as PlanChoice[]).slice(0, BUDGET_OPTIONS_MAX - 1).map((option) => chooseService(option, services))
  const ready: Prepared = { ...fitted, payload: { ...fitted.payload, options } }
  // Cada opción dice qué se dijo y sus candidatas; arriba basta una línea.
  if (!main.serviceId || (fitted.status === "lista" && options.some((option) => !option.serviceId))) return { ...ready, status: "por_revisar", note: CHOOSE_EACH_OPTION }
  return ready
}

const CHOOSE_EACH_OPTION = "Elige la prestación en cada opción."

/** Números como se dictan: «8», «ocho», «una». */
const SPOKEN_NUMBERS: Record<string, number> = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  doce: 12, catorce: 14, quince: 15, veinte: 20, veinticuatro: 24, treinta: 30,
}
function spokenNumber(text: string, unit: RegExp): number | null {
  const plain = normalizeForSearch(text)
  const found = new RegExp(`(\\d+|[a-z]+)\\s+${unit.source}`).exec(plain)
  if (!found?.[1]) return null
  const value = /^\d+$/.test(found[1]) ? Number(found[1]) : SPOKEN_NUMBERS[found[1]]
  return value && value > 0 ? value : null
}

/** Formas que se toman por la boca: con ellas, «vía oral» no se dicta (decisión 6 de la fase 2). */
const ORAL_FORMS = /\b(capsula|tableta|comprimido|gragea|jarabe|suspension|sobre|solucion oral|gotas)\b/

const MEDICATION_LABEL: Record<string, string> = {
  strength: "la concentración",
  dosageForm: "la forma farmacéutica",
  dose: "la dosis",
  route: "la vía",
  frequency: "la frecuencia",
  duration: "la duración",
}

/**
 * Un medicamento dictado, con lo que la receta exige (la Guía de la buena
 * prescripción de la OMS, igual que «Emitir receta»). La vía oral se da por
 * dicha con una forma que se toma por la boca y la cantidad total se calcula
 * de la dosis, la frecuencia y la duración cuando se puede (decisión 5); las dos
 * se marcan para que se vea. Lo que falta deja la sugerencia por revisar: se
 * dice o se completa en el formulario de siempre. La DCI que no está en la
 * lista del producto se receta igual, pero se avisa que no se revisan sus alergias.
 */
function prepareMedication(payload: Record<string, unknown>, medications: MedicationCatalog): Prepared {
  const text = (key: string) => (typeof payload[key] === "string" ? String(payload[key]).trim() : "")
  const genericName = text("genericName").toLowerCase()
  const ready: Record<string, unknown> = { ...payload, genericName }
  for (const key of ["routeImplied", "quantityCalculated", "notInList"]) delete ready[key]
  const form = normalizeForSearch(text("dosageForm"))
  const spokenRoute = normalizeForSearch(text("route"))
  const route = ADMINISTRATION_ROUTES.find((value) => normalizeForSearch(value) === spokenRoute)
  if (route) ready["route"] = route
  else if (!spokenRoute && ORAL_FORMS.test(form)) Object.assign(ready, { route: "oral", routeImplied: true })
  else delete ready["route"]
  if (typeof payload["quantity"] !== "number") {
    // Solo con unidades que se cuentan: «10 mL» de jarabe no da un número de frascos.
    const perDose = spokenNumber(text("dose"), /(capsula|tableta|comprimido|gragea|sobre)/)
    const everyHours = spokenNumber(text("frequency"), /hora/)
    const days = spokenNumber(text("duration"), /dia/)
    if (perDose && everyHours && days && 24 % everyHours === 0) Object.assign(ready, { quantity: perDose * (24 / everyHours) * days, quantityCalculated: true })
  }
  if (!findMedication(genericName, medications.medications)) ready["notInList"] = true
  const missing = Object.keys(MEDICATION_LABEL).filter((key) => !ready[key] || (typeof ready[key] === "string" && !String(ready[key]).trim()))
  if (missing.length) {
    const list = missing.map((key) => MEDICATION_LABEL[key])
    return { payload: ready, status: "por_revisar", note: `Falta ${list.join(", ")} de ${genericName}. Dila o complétala.` }
  }
  return { payload: ready, status: "lista", note: null }
}

async function lockOwnDraft(tx: Db, orgId: string, actorUserId: string, patientId: string, encounterId: string) {
  const locked = await lockEncounter(tx, orgId, patientId, encounterId)
  assertOpenDraft(locked, actorUserId)
  return locked
}

type Prepared = DictationPrepared

/**
 * Aplica un cambio a una sugerencia —a mano o dicho en voz alta— y la vuelve a
 * validar como al crearla. `null`: quedó vacía.
 */
async function revise(
  tx: Db,
  kind: DictationKind,
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
  scope: DictationScope,
): Promise<Prepared | null> {
  const { services, dictation } = scope
  // Un campo que llega vacío se quita de la sugerencia: el odontólogo lo borró.
  let payload: Record<string, unknown> = Object.fromEntries(
    Object.entries({ ...current, ...patch }).filter(([, value]) => value !== null && value !== ""),
  )
  if (kind === "plan" && Array.isArray(current["options"])) return revisePlanChoice(current, patch, services, dictation)
  if (kind === "plan" && typeof patch["serviceId"] === "string") {
    // Elegir la prestación a mano resuelve lo que el asistente no pudo ubicar.
    const chosen = services.find((service) => service.id === patch["serviceId"])
    if (!chosen) throw validation("Esa prestación no está activa en tus servicios")
    const { candidates: _candidates, ...rest } = payload
    payload = { ...rest, service: chosen.name, serviceId: chosen.id, serviceName: chosen.name, priceCents: chosen.priceCents, currency: chosen.currency, serviceScope: chosen.scope }
  } else if (kind === "plan" && typeof patch["service"] === "string" && patch["service"] !== current["service"]) {
    // Se nombró otra prestación: se busca de nuevo en el tarifario, no se conserva la anterior.
    for (const key of ["serviceId", "serviceName", "priceCents", "currency", "serviceScope", "candidates"]) delete payload[key]
  }
  const chosenService = kind === "plan" && typeof payload["serviceId"] === "string" ? services.find((service) => service.id === payload["serviceId"]) : undefined
  if (chosenService) {
    const fitted = dictation.normalizeSite(payload)
    return fitted.invalid
      ? { payload: fitted.payload, status: "por_revisar", note: fitted.invalid }
      : dictation.fitToScope(fitted.payload, chosenService.scope)
  }
  return prepare(tx, { kind, payload }, scope)
}

const CHOICE_ALREADY_HERE = "Ya hay otra elección de caminos en este dictado. Un presupuesto lleva una sola: arma esta en el presupuesto, duplicando una opción."
const CHOICE_ALREADY_IN_BUDGET = "Su presupuesto en borrador ya tiene opciones. Arma esta elección ahí, duplicando una opción."

/** Lo del paciente que revisa una sugerencia antes de quedar lista: sus alergias y si ya hay una elección en curso. */
interface PatientChecks {
  allergies: Array<{ substance: string; substanceSystem: string | null; substanceCode: string | null; severity: string | null; verification: string | null }>
  /** Por qué no cabe otra elección de caminos (decisión 3), o null si cabe. */
  choiceBlocked: string | null
}

async function patientChecks(tx: Db, orgId: string, patientId: string, encounterId: string, exceptId?: string): Promise<PatientChecks> {
  // Las alergias vigentes, todas por igual: la misma lista que mira «Emitir receta».
  const allergies = await tx
    .select({
      substance: patientAllergy.substance,
      substanceSystem: patientAllergy.substanceSystem,
      substanceCode: patientAllergy.substanceCode,
      severity: patientAllergy.severity,
      verification: patientAllergy.verification,
    })
    .from(patientAllergy)
    .where(and(eq(patientAllergy.organizationId, orgId), eq(patientAllergy.patientId, patientId), eq(patientAllergy.isActive, true)))
  // Manda la primera elección dicha: la que ya espera por esta regla no le quita el lugar.
  const pendingChoice = (await listDictationSuggestions(tx, orgId, patientId, encounterId)).some(
    (item) => item.kind === "plan" && item.id !== exceptId && Array.isArray(item.payload["options"]) && item.note !== CHOICE_ALREADY_HERE,
  )
  const draft = await findDraftBudget(tx, orgId, patientId)
  const draftOptions = draft
    ? (await tx.select({ id: treatmentBudgetOption.id }).from(treatmentBudgetOption).where(and(eq(treatmentBudgetOption.organizationId, orgId), eq(treatmentBudgetOption.budgetId, draft.id)))).length
    : 0
  return { allergies, choiceBlocked: pendingChoice ? CHOICE_ALREADY_HERE : draftOptions > 1 ? CHOICE_ALREADY_IN_BUDGET : null }
}

/**
 * Lo que solo se sabe con el paciente: una receta que choca con sus alergias
 * queda por revisar con el aviso de siempre (la misma regla que «Emitir
 * receta»), y una elección de caminos que no cabe en su presupuesto espera.
 */
function checkAgainstPatient(kind: DictationKind, prepared: Prepared, checks: PatientChecks, medications: MedicationCatalog): Prepared {
  if (kind === "receta") {
    const { allergyWarnings: _old, ...payload } = prepared.payload
    const warnings = allergyWarnings(String(payload["genericName"] ?? ""), checks.allergies as never, medications)
    if (!warnings.length) return { ...prepared, payload }
    return { payload: { ...payload, allergyWarnings: warnings }, status: "por_revisar", note: `Aviso de alergia: ${warnings.join(" ")}` }
  }
  if (kind === "plan" && Array.isArray(prepared.payload["options"])) {
    // `choiceBlocked`: la pantalla la muestra sin elegir nada, porque así no se puede confirmar.
    const { choiceBlocked: _old, ...payload } = prepared.payload
    if (!checks.choiceBlocked) return { ...prepared, payload }
    return { payload: { ...payload, choiceBlocked: true }, status: "por_revisar", note: checks.choiceBlocked }
  }
  return prepared
}

const MAIN_SERVICE_KEYS = ["service", "serviceId", "serviceName", "priceCents", "currency", "serviceScope", "candidates"] as const

/**
 * Cambios a una indicación con otros caminos: elegir el servicio de la
 * principal (`serviceId`) o de un camino (`option1ServiceId`, `option2ServiceId`),
 * y «Recomendar» un camino (`recommend`: 1 o 2), que pasa a ser la opción A.
 */
function revisePlanChoice(current: Record<string, unknown>, patch: Record<string, unknown>, services: ServiceOption[], dictation: ProductDictation): Prepared {
  const pick = (id: unknown) => {
    const chosen = services.find((service) => service.id === id)
    if (!chosen) throw validation("Esa prestación no está activa en tus servicios")
    return chosen.id
  }
  const main: Record<string, unknown> = Object.fromEntries(MAIN_SERVICE_KEYS.flatMap((key) => (current[key] === undefined ? [] : [[key, current[key]]])))
  let options = [...(current["options"] as PlanChoice[])]
  const rest = Object.fromEntries(Object.entries({ ...current, ...patch }).filter(([key, value]) => value !== null && value !== "" && !(MAIN_SERVICE_KEYS as readonly string[]).includes(key) && key !== "options" && !/^option\dServiceId$|^recommend$/.test(key)))
  let chosenMain: PlanChoice = main as PlanChoice
  if (typeof patch["serviceId"] === "string") chosenMain = { service: String(main["service"] ?? ""), serviceId: pick(patch["serviceId"]) }
  options = options.map((option, index) => {
    const id = patch[`option${index + 1}ServiceId`]
    return typeof id === "string" ? { service: option.service, serviceId: pick(id) } : option
  })
  // «Recomiendo la corona», dicho en voz alta, llega como otra prestación: si es uno de los caminos, se recomienda.
  const spoken = typeof patch["service"] === "string" ? normalizeForSearch(patch["service"]) : ""
  const named = spoken ? options.findIndex((option) => [option.service, option.serviceName].some((name) => name && normalizeForSearch(name).includes(spoken))) : -1
  if (named >= 0) patch = { ...patch, recommend: named + 1 }
  const recommend = Number(patch["recommend"])
  if (Number.isInteger(recommend) && recommend >= 1 && recommend <= options.length) {
    const swapped = options[recommend - 1]!
    options[recommend - 1] = chosenMain
    chosenMain = swapped
  }
  const site = dictation.normalizeSite(rest)
  if (site.invalid) return { payload: { ...rest, ...chosenMain, options }, status: "por_revisar", note: site.invalid }
  return settlePlan({ ...site.payload, ...chosenMain, options }, services, dictation)
}

const FIELD_LABEL = Object.fromEntries(
  DICTATION_KINDS.map((kind) => [
    kind,
    Object.fromEntries(Object.entries(OPERATIONS[DICTATION_OPERATION[kind]].fields).map(([key, field]) => [key, field.label])),
  ]),
) as Record<DictationKind, Record<string, string>>

/** Qué decía la sugerencia antes de una corrección por voz, en pocas palabras. `null`: no cambió nada. */
function describeBefore(
  kind: DictationKind,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  keys: string[],
  dictation: ProductDictation,
): string | null {
  const parts: string[] = []
  for (const key of keys) {
    if (JSON.stringify(before[key] ?? null) === JSON.stringify(after[key] ?? null)) continue
    const old = before[key]
    // Lo del producto (odentIA: la pieza, las caras y el hallazgo) lo dice el producto.
    const own = dictation.describeField(key, before)
    if (own !== null) parts.push(own)
    else if (key === "service") parts.push(String(before["serviceName"] ?? old ?? "otra prestación"))
    else if (key === "diagnosisCode" || key === "title") parts.push(String(old ?? "sin dato"))
    else if (key === "diagnosisType") parts.push(isDiagnosisVerification(old) ? DIAGNOSIS_VERIFICATION_LABELS[old].toLowerCase() : "sin tipo")
    else if (kind === "receta") parts.push(old == null || old === "" ? `sin ${(FIELD_LABEL[kind][key] ?? key).toLowerCase()}` : String(old))
    else parts.push(`otro texto en ${(FIELD_LABEL[kind][key] ?? key).toLowerCase()}`)
  }
  return parts.length ? parts.join(", ") : null
}

/** Una corrección dicha en voz alta sobre una sugerencia que sigue sin decidir. */
export interface DictationVoiceCorrection {
  suggestionId: string
  /** Solo los campos que cambian, con los nombres de la operación. */
  changes: Record<string, unknown>
}

export interface DictationSegment {
  drafts: DictationDraft[]
  corrections?: DictationVoiceCorrection[]
  /** Sugerencias que el odontólogo pidió quitar en voz alta, con lo que dijo para pedirlo. */
  removals?: Array<{ suggestionId: string; said: string }>
  /** Identidad del tramo: el mismo tramo no se guarda dos veces. */
  segmentId?: string | undefined
}

export interface DictationSegmentResult {
  suggestions: DictationSuggestion[]
  corrected: string[]
  removed: string[]
  /** El tramo ya se había guardado: no se hizo nada. */
  repeated: boolean
}

/** ¿Ese tramo del dictado ya dejó algo en esta atención? */
export async function dictationSegmentSeen(tx: Db, orgId: string, patientId: string, encounterId: string, segmentId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: encounterDictationSuggestion.id })
    .from(encounterDictationSuggestion)
    .where(
      and(
        eq(encounterDictationSuggestion.organizationId, orgId),
        eq(encounterDictationSuggestion.patientId, patientId),
        eq(encounterDictationSuggestion.encounterId, encounterId),
        sql`${encounterDictationSuggestion.payload} @> ${JSON.stringify({ [META]: { segments: [segmentId] } })}::jsonb`,
      ),
    )
    .limit(1)
  return Boolean(row)
}

/**
 * Guarda un tramo del dictado: sugerencias nuevas y, si el odontólogo siguió
 * hablando, lo que corrigió o pidió quitar de las que aún no decide. Solo quien
 * lleva la atención en borrador puede dictar en ella. Nada entra a la historia
 * aquí. Una corrección que no encaja en su operación, o que apunta a una
 * sugerencia ya decidida, se ignora: nunca se adivina.
 */
export async function saveDictationSegment(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  segment: DictationSegment,
): Promise<DictationSegmentResult> {
  const dictation = await requireClinicalAssistant(tx, orgId)
  // El bloqueo de la atención ordena dos envíos del mismo tramo: el segundo ya lo ve guardado.
  await lockOwnDraft(tx, orgId, actorUserId, patientId, encounterId)
  const segmentId = segment.segmentId
  if (segmentId && (await dictationSegmentSeen(tx, orgId, patientId, encounterId, segmentId))) {
    return { suggestions: [], corrected: [], removed: [], repeated: true }
  }
  const stamp = (meta: SuggestionMeta): SuggestionMeta => (segmentId ? { ...meta, segments: [...(meta.segments ?? []), segmentId] } : meta)
  const scope = await dictationScope(tx, orgId)
  const pendingRow = async (id: string) => {
    const [row] = await tx
      .select()
      .from(encounterDictationSuggestion)
      .where(
        and(
          eq(encounterDictationSuggestion.organizationId, orgId),
          eq(encounterDictationSuggestion.patientId, patientId),
          eq(encounterDictationSuggestion.encounterId, encounterId),
          eq(encounterDictationSuggestion.id, id),
          inArray(encounterDictationSuggestion.status, ["lista", "por_revisar"]),
        ),
      )
      .for("update")
      .limit(1)
    return row
  }

  const corrected: string[] = []
  for (const correction of (segment.corrections ?? []).slice(0, DICTATION_MAX_SUGGESTIONS)) {
    const row = await pendingRow(correction.suggestionId)
    if (!row) continue
    const { data, meta } = splitMeta(row.payload)
    const schema = operationAgentSchema(DICTATION_OPERATION[row.kind])
    const patch = Object.fromEntries(Object.entries(correction.changes).filter(([key, value]) => key in schema.shape && value !== undefined && value !== null))
    if (Object.keys(patch).length === 0 || !schema.safeParse({ ...data, ...patch }).success) continue
    const revised = await revise(tx, row.kind, data, patch, scope)
    if (!revised) continue
    const ready =
      row.kind === "plan" || row.kind === "receta"
        ? checkAgainstPatient(row.kind, revised, await patientChecks(tx, orgId, patientId, encounterId, row.id), scope.medications)
        : revised
    const before = describeBefore(row.kind, data, ready.payload, Object.keys(patch), dictation)
    if (!before) continue
    // Se conserva cómo estaba antes de la primera corrección: deshacer vuelve ahí.
    const voice = meta.voice ?? { payload: data, status: row.status as "lista" | "por_revisar", note: row.note, before }
    await tx
      .update(encounterDictationSuggestion)
      .set({ payload: withMeta(ready.payload, stamp({ ...meta, voice })), status: ready.status, note: ready.note, updatedAt: new Date() })
      .where(eq(encounterDictationSuggestion.id, row.id))
    corrected.push(row.id)
  }

  const removed: string[] = []
  for (const removal of (segment.removals ?? []).slice(0, DICTATION_MAX_SUGGESTIONS)) {
    const row = await pendingRow(removal.suggestionId)
    if (!row) continue
    const { data, meta } = splitMeta(row.payload)
    // Si se entendió mal, «Deshacer» la devuelve como estaba (issue 135, opción B).
    const undo = { status: row.status as "lista" | "por_revisar", said: removal.said.slice(0, DICTATION_SOURCE_CHARS) }
    await tx
      .update(encounterDictationSuggestion)
      .set({ payload: withMeta(data, stamp({ ...meta, removal: undo })), status: "descartada", decidedBy: actorUserId, decidedAt: new Date(), updatedAt: new Date() })
      .where(eq(encounterDictationSuggestion.id, row.id))
    removed.push(row.id)
  }

  // Lo que ya está pendiente no se repite: el asistente a veces corrige una sugerencia y además la
  // vuelve a registrar. Lo hace igual una sugerencia del producto (`sameKey`; odentIA: la misma
  // pieza, el mismo hallazgo y las mismas caras) y un medicamento: se corrige, no se receta dos veces.
  const sameKey = (kind: DictationKind, payload: Record<string, unknown>) => {
    const key = dictation.kinds.includes(kind) ? dictation.sameKey(kind, payload) : null
    return key === null ? null : `${kind}:${key}`
  }
  const recipeKey = (payload: Record<string, unknown>) => String(payload["genericName"] ?? "").toLowerCase()
  const pendingNow = await listDictationSuggestions(tx, orgId, patientId, encounterId)
  const pendingOwn = new Set(pendingNow.flatMap((item) => sameKey(item.kind, item.payload) ?? []))
  const pendingRecipes = new Set(pendingNow.filter((item) => item.kind === "receta").map((item) => recipeKey(item.payload)))
  const rows: Array<typeof encounterDictationSuggestion.$inferInsert> = []
  const checks = await patientChecks(tx, orgId, patientId, encounterId)
  for (const draft of segment.drafts.slice(0, DICTATION_MAX_SUGGESTIONS)) {
    const prepared = await prepare(tx, draft, scope)
    if (!prepared) continue
    const ready = checkAgainstPatient(draft.kind, prepared, checks, scope.medications)
    // Una sola elección por presupuesto (decisión 3): la siguiente de este mismo tramo también espera.
    if (draft.kind === "plan" && Array.isArray(ready.payload["options"])) checks.choiceBlocked ??= CHOICE_ALREADY_HERE
    const own = sameKey(draft.kind, ready.payload)
    if (own !== null) {
      if (pendingOwn.has(own)) continue
      pendingOwn.add(own)
    }
    if (draft.kind === "receta") {
      const key = recipeKey(ready.payload)
      if (pendingRecipes.has(key)) continue
      pendingRecipes.add(key)
    }
    rows.push({
      organizationId: orgId,
      patientId,
      encounterId,
      professionalUserId: actorUserId,
      kind: draft.kind,
      payload: withMeta(ready.payload, stamp({})),
      sourceText: (draft.sourceText ?? "").slice(0, DICTATION_SOURCE_CHARS),
      status: ready.status,
      note: ready.note,
    })
  }
  const inserted = rows.length ? await tx.insert(encounterDictationSuggestion).values(rows).returning() : []
  if (inserted.length + corrected.length + removed.length > 0) {
    await tx.insert(auditEvent).values({
      organizationId: orgId,
      actorUserId,
      action: "encounter.dictation_suggested",
      entity: "encounter",
      entityId: encounterId,
      // Sin texto clínico en la auditoría: cuántas y de qué clase.
      metadata: { patientId, count: inserted.length, kinds: [...new Set(inserted.map((row) => row.kind))], corrected: corrected.length, removed: removed.length },
    })
  }
  const zone = await findOrgLocale(tx, orgId)
  return { suggestions: inserted.map((row) => toItem(row, zone, dictation)), corrected, removed, repeated: false }
}

/**
 * Guarda lo que el asistente entendió de un dictado como sugerencias de esa
 * atención. Es `saveDictationSegment` sin correcciones ni identidad de tramo.
 */
export async function saveDictationSuggestions(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  drafts: DictationDraft[],
): Promise<DictationSuggestion[]> {
  return (await saveDictationSegment(tx, orgId, actorUserId, patientId, encounterId, { drafts })).suggestions
}

/** Cuántas sugerencias de esta atención ya confirmó el odontólogo: se firman con ella. */
export async function countConfirmedDictation(tx: Db, orgId: string, patientId: string, encounterId: string): Promise<number> {
  const rows = await tx
    .select({ id: encounterDictationSuggestion.id })
    .from(encounterDictationSuggestion)
    .where(
      and(
        eq(encounterDictationSuggestion.organizationId, orgId),
        eq(encounterDictationSuggestion.patientId, patientId),
        eq(encounterDictationSuggestion.encounterId, encounterId),
        eq(encounterDictationSuggestion.status, "confirmada"),
      ),
    )
  return rows.length
}

/** Sugerencias de una atención que aún esperan decisión, más las ya resueltas en esta sesión de trabajo. */
export async function listDictationSuggestions(tx: Db, orgId: string, patientId: string, encounterId: string): Promise<DictationSuggestion[]> {
  // Un producto que no dicta no tiene sugerencias.
  const { dictation } = await productHooks(tx, orgId)
  if (!dictation) return []
  const rows = await tx
    .select()
    .from(encounterDictationSuggestion)
    .where(
      and(
        eq(encounterDictationSuggestion.organizationId, orgId),
        eq(encounterDictationSuggestion.patientId, patientId),
        eq(encounterDictationSuggestion.encounterId, encounterId),
        inArray(encounterDictationSuggestion.status, ["lista", "por_revisar"]),
      ),
    )
    .orderBy(asc(encounterDictationSuggestion.createdAt), asc(encounterDictationSuggestion.id))
  const zone = await findOrgLocale(tx, orgId)
  return rows.map((row) => toItem(row, zone, dictation))
}

/**
 * Las que el odontólogo pidió quitar en voz alta y aún se pueden devolver: la
 * pantalla las muestra tachadas en su bloque, con «Deshacer», hasta firmar.
 */
export async function listVoiceRemovedDictation(tx: Db, orgId: string, patientId: string, encounterId: string): Promise<DictationSuggestion[]> {
  const { dictation } = await productHooks(tx, orgId)
  if (!dictation) return []
  const rows = await tx
    .select()
    .from(encounterDictationSuggestion)
    .where(
      and(
        eq(encounterDictationSuggestion.organizationId, orgId),
        eq(encounterDictationSuggestion.patientId, patientId),
        eq(encounterDictationSuggestion.encounterId, encounterId),
        eq(encounterDictationSuggestion.status, "descartada"),
        sql`jsonb_exists(${encounterDictationSuggestion.payload} -> ${META}, 'removal')`,
      ),
    )
    .orderBy(asc(encounterDictationSuggestion.createdAt), asc(encounterDictationSuggestion.id))
  const zone = await findOrgLocale(tx, orgId)
  return rows.map((row) => toItem(row, zone, dictation))
}

async function lockSuggestion(tx: Db, orgId: string, patientId: string, encounterId: string, id: string) {
  const [row] = await tx
    .select()
    .from(encounterDictationSuggestion)
    .where(
      and(
        eq(encounterDictationSuggestion.organizationId, orgId),
        eq(encounterDictationSuggestion.patientId, patientId),
        eq(encounterDictationSuggestion.encounterId, encounterId),
        eq(encounterDictationSuggestion.id, id),
      ),
    )
    .for("update")
    .limit(1)
  if (!row) throw notFound("Sugerencia")
  if (row.status === "confirmada" || row.status === "descartada") throw conflict("SUGGESTION_DECIDED", `La sugerencia ya está ${row.status}`)
  return row
}

/**
 * El odontólogo corrige una sugerencia antes de confirmarla: cambia sus campos
 * o elige la prestación que faltaba. Se vuelve a validar como al crearla.
 */
export async function updateDictationSuggestion(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  id: string,
  patch: Record<string, unknown>,
): Promise<DictationSuggestion> {
  await lockOwnDraft(tx, orgId, actorUserId, patientId, encounterId)
  const row = await lockSuggestion(tx, orgId, patientId, encounterId, id)
  const scope = await dictationScope(tx, orgId)
  const { data, meta } = splitMeta(row.payload)
  const revised = await revise(tx, row.kind, data, patch, scope)
  if (!revised) throw validation("La sugerencia quedó vacía; descártala si no aplica")
  const ready = checkAgainstPatient(row.kind, revised, await patientChecks(tx, orgId, patientId, encounterId, row.id), scope.medications)
  // Editada a mano, ya no es «corregida por voz»: no queda nada que deshacer.
  const [updated] = await tx
    .update(encounterDictationSuggestion)
    .set({ payload: withMeta(ready.payload, { ...meta, voice: undefined }), status: ready.status, note: ready.note, updatedAt: new Date() })
    .where(eq(encounterDictationSuggestion.id, id))
    .returning()
  if (!updated) throw new Error("No se pudo actualizar la sugerencia")
  return toItem(updated, await findOrgLocale(tx, orgId), scope.dictation)
}

/**
 * Deshace lo que se hizo por voz: una corrección (la sugerencia vuelve a como
 * estaba antes de ella) o un «quita» (vuelve a estar pendiente, como estaba).
 */
export async function undoDictationVoiceCorrection(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  id: string,
): Promise<DictationSuggestion> {
  await lockOwnDraft(tx, orgId, actorUserId, patientId, encounterId)
  const dictation = await requireDictatingProduct(tx, orgId)
  const [removed] = await tx
    .select()
    .from(encounterDictationSuggestion)
    .where(
      and(
        eq(encounterDictationSuggestion.organizationId, orgId),
        eq(encounterDictationSuggestion.patientId, patientId),
        eq(encounterDictationSuggestion.encounterId, encounterId),
        eq(encounterDictationSuggestion.id, id),
        eq(encounterDictationSuggestion.status, "descartada"),
      ),
    )
    .for("update")
    .limit(1)
  const removal = removed ? splitMeta(removed.payload) : null
  if (removed && removal?.meta.removal) {
    const [restored] = await tx
      .update(encounterDictationSuggestion)
      .set({
        payload: withMeta(removal.data, { ...removal.meta, removal: undefined }),
        status: removal.meta.removal.status,
        decidedBy: null,
        decidedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(encounterDictationSuggestion.id, id))
      .returning()
    if (!restored) throw new Error("No se pudo deshacer el «quita»")
    return toItem(restored, await findOrgLocale(tx, orgId), dictation)
  }
  const row = await lockSuggestion(tx, orgId, patientId, encounterId, id)
  const { meta } = splitMeta(row.payload)
  if (!meta.voice) throw conflict("NO_VOICE_CORRECTION", "Esta sugerencia no tiene una corrección por voz que deshacer")
  const [updated] = await tx
    .update(encounterDictationSuggestion)
    .set({ payload: withMeta(meta.voice.payload, { ...meta, voice: undefined }), status: meta.voice.status, note: meta.voice.note, updatedAt: new Date() })
    .where(eq(encounterDictationSuggestion.id, id))
    .returning()
  if (!updated) throw new Error("No se pudo deshacer la corrección")
  return toItem(updated, await findOrgLocale(tx, orgId), dictation)
}

/** Plan donde entra una indicación dictada: el de esta atención, el más reciente del paciente o uno nuevo. */
const pick = <T extends string>(payload: Record<string, unknown>, keys: readonly T[]): Partial<Record<T, unknown>> =>
  Object.fromEntries(keys.filter((key) => payload[key] !== undefined).map((key) => [key, payload[key]])) as Partial<Record<T, unknown>>

/**
 * Confirmar es lo único que lleva una sugerencia a la historia, y lo hace con
 * la operación de siempre: la misma validación, el mismo permiso y la misma
 * auditoría que si el profesional lo hubiera escrito. Si la operación rechaza
 * el dato, la sugerencia sigue ahí para corregirla. Las clases del producto
 * las confirma el producto (odentIA: el hallazgo, como el panel de la pieza).
 */
export async function confirmDictationSuggestion(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  id: string,
): Promise<DictationSuggestion> {
  await lockOwnDraft(tx, orgId, actorUserId, patientId, encounterId)
  const dictation = await requireDictatingProduct(tx, orgId)
  const row = await lockSuggestion(tx, orgId, patientId, encounterId, id)
  if (row.status === "por_revisar") throw conflict("SUGGESTION_NEEDS_REVIEW", row.note ?? "Revisa la sugerencia antes de confirmarla")
  // Emitir una receta es firmarla: tiene su propio botón (decisión 4 de la fase 2).
  if (row.kind === "receta") throw conflict("PRESCRIPTION_NEEDS_ISSUE", "Una receta dictada se emite con «Emitir receta»")
  // La operación recibe los campos de la sugerencia, no sus metadatos.
  const payload = splitMeta(row.payload).data
  let entityId: string | null = null
  if (row.kind === "nota") {
    const fields = Object.keys(OPERATIONS["atencion.nota"].fields)
    await updateEncounterDraft(tx, orgId, actorUserId, patientId, encounterId, pick(payload, fields) as UpdateEncounterDraftPatch)
  } else if (row.kind === "diagnostico") {
    const created = await addEncounterDiagnosis(tx, orgId, actorUserId, patientId, encounterId, {
      diagnosisCode: String(payload["diagnosisCode"]),
      diagnosisSystem: typeof payload["diagnosisSystem"] === "string" ? payload["diagnosisSystem"] : null,
      diagnosisType: String(payload["diagnosisType"]),
      toothNumber: (payload["toothNumber"] as number | undefined) ?? null,
      surfaces: (payload["surfaces"] as string[] | undefined) ?? null,
      note: (payload["note"] as string | undefined) ?? null,
    })
    entityId = created.id
  } else if (row.kind === "plan" && Array.isArray(payload["options"]) && payload["options"].length) {
    entityId = await confirmPlanChoice(tx, orgId, actorUserId, patientId, encounterId, row.id, payload)
  } else if (row.kind === "plan") {
    const created = await addPlanItem(tx, orgId, actorUserId, patientId, {
      serviceId: String(payload["serviceId"]),
      // Sin plan elegido: va al plan abierto de la persona (o nace uno), como al escribirlo.
      planId: null,
      sourceEncounterId: encounterId,
      toothNumber: (payload["toothNumber"] as number | undefined) ?? null,
      surfaces: (payload["surfaces"] as string[] | undefined) ?? null,
      detail: (payload["detail"] as string | undefined) ?? null,
    })
    entityId = created.id
  } else if (dictation.kinds.includes(row.kind)) {
    entityId = await dictation.confirm(tx, { orgId, actorUserId, patientId, encounterId }, row.kind, payload)
  } else {
    const created = await createFollowUp(tx, orgId, actorUserId, patientId, {
      kind: "mantenimiento",
      title: String(payload["title"]),
      instructions: (payload["instructions"] as string | undefined) ?? null,
      dueAt: String(payload["dueAt"]),
      originEncounterId: encounterId,
    })
    entityId = created.id
  }
  const [updated] = await tx
    .update(encounterDictationSuggestion)
    .set({ status: "confirmada", entityId, decidedBy: actorUserId, decidedAt: new Date(), updatedAt: new Date() })
    .where(eq(encounterDictationSuggestion.id, id))
    .returning()
  if (!updated) throw new Error("No se pudo confirmar la sugerencia")
  return toItem(updated, await findOrgLocale(tx, orgId), dictation)
}

/**
 * «Dos caminos para la 46» (issue 109, fase 2): cada camino entra al plan como
 * se indica a mano, y el presupuesto en borrador queda con una opción por
 * camino, como se arma hoy en la pantalla del presupuesto: la opción A con la
 * principal (la recomendada) y cada otra opción como copia de la A con su
 * camino en lugar de la principal. Lo que se indique después en la atención
 * entra a todas las opciones al firmar (`assembleEncounterBudget`). Si el
 * borrador ya tiene opciones, no se mezclan (decisión 3).
 */
async function confirmPlanChoice(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  suggestionId: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const checks = await patientChecks(tx, orgId, patientId, encounterId, suggestionId)
  if (checks.choiceBlocked) throw conflict("BUDGET_CHOICE_TAKEN", checks.choiceBlocked)
  const site = {
    toothNumber: (payload["toothNumber"] as number | undefined) ?? null,
    surfaces: (payload["surfaces"] as string[] | undefined) ?? null,
    detail: (payload["detail"] as string | undefined) ?? null,
  }
  const indicate = (serviceId: string) =>
    addPlanItem(tx, orgId, actorUserId, patientId, { serviceId, planId: null, sourceEncounterId: encounterId, ...site })
  const main = await indicate(String(payload["serviceId"]))
  const others = []
  for (const option of payload["options"] as PlanChoice[]) others.push(await indicate(String(option.serviceId)))
  const tooth = typeof site.toothNumber === "number" ? ` para la ${site.toothNumber}` : ""
  const draft = await findDraftBudget(tx, orgId, patientId)
  const budget = draft
    ? await addBudgetItems(tx, orgId, actorUserId, patientId, draft.id, { itemIds: [main.id] })
    : await createBudget(tx, orgId, actorUserId, patientId, {
        planId: main.planId,
        itemIds: [main.id],
        notes: `${others.length === 1 ? "Dos caminos" : "Tres caminos"}${tooth}: elige uno.`,
      })
  const optionA = budget.options[0]
  if (!optionA) throw new Error("El presupuesto quedó sin opción")
  for (const other of others) {
    const copied = await duplicateBudgetOption(tx, orgId, actorUserId, patientId, budget.id, optionA.id)
    const created = copied.options.at(-1)
    if (!created) throw new Error("No se pudo crear la opción")
    await removeBudgetItems(tx, orgId, actorUserId, patientId, budget.id, { itemIds: [main.id], optionId: created.id })
    await addBudgetItems(tx, orgId, actorUserId, patientId, budget.id, { itemIds: [other.id], optionId: created.id })
  }
  return main.id
}

/**
 * Emite la receta dictada (issue 109, fase 2): todos los medicamentos que
 * esperan en esta atención, en una sola receta, con `createPrescription`, la
 * misma de «Emitir receta» (firma con la colegiatura y el aviso de alergia,
 * que aquí no se salta: con aviso se resuelve en el formulario). Las
 * sugerencias quedan confirmadas con la receta.
 */
export async function issueDictationPrescription(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
): Promise<{ prescriptionId: string }> {
  await lockOwnDraft(tx, orgId, actorUserId, patientId, encounterId)
  const rows = (await pendingPrescriptionRows(tx, orgId, patientId, encounterId))
  if (rows.length === 0) throw conflict("NO_DICTATED_PRESCRIPTION", "No hay una receta dictada por emitir")
  const waiting = rows.find((row) => row.status !== "lista")
  if (waiting) throw conflict("SUGGESTION_NEEDS_REVIEW", waiting.note ?? "Completa la receta antes de emitirla")
  const created = await createPrescription(tx, orgId, actorUserId, patientId, {
    encounterId,
    items: rows.map((row) => {
      const data = splitMeta(row.payload).data
      const text = (key: string) => (typeof data[key] === "string" ? String(data[key]) : "")
      return {
        genericName: text("genericName"),
        strength: text("strength"),
        dosageForm: text("dosageForm"),
        dose: text("dose"),
        route: text("route"),
        frequency: text("frequency"),
        duration: text("duration"),
        quantity: typeof data["quantity"] === "number" ? data["quantity"] : null,
        instructions: text("instructions") || null,
      }
    }),
  })
  await settleRows(tx, actorUserId, rows.map((row) => row.id), created.id)
  return { prescriptionId: created.id }
}

/**
 * La receta dictada se terminó en el formulario de siempre («Completar»,
 * «Cambiar medicamento», «Recetar igual, con motivo»): sus sugerencias quedan
 * confirmadas con esa receta, que tiene que ser de esta atención.
 */
export async function settleDictationPrescription(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  prescriptionId: string,
): Promise<{ settled: number }> {
  await lockOwnDraft(tx, orgId, actorUserId, patientId, encounterId)
  const [issued] = await tx
    .select({ id: prescription.id })
    .from(prescription)
    .where(and(eq(prescription.organizationId, orgId), eq(prescription.patientId, patientId), eq(prescription.encounterId, encounterId), eq(prescription.id, prescriptionId)))
    .limit(1)
  if (!issued) throw notFound("Receta")
  const rows = await pendingPrescriptionRows(tx, orgId, patientId, encounterId)
  await settleRows(tx, actorUserId, rows.map((row) => row.id), issued.id)
  return { settled: rows.length }
}

async function pendingPrescriptionRows(tx: Db, orgId: string, patientId: string, encounterId: string) {
  return tx
    .select()
    .from(encounterDictationSuggestion)
    .where(
      and(
        eq(encounterDictationSuggestion.organizationId, orgId),
        eq(encounterDictationSuggestion.patientId, patientId),
        eq(encounterDictationSuggestion.encounterId, encounterId),
        eq(encounterDictationSuggestion.kind, "receta"),
        inArray(encounterDictationSuggestion.status, ["lista", "por_revisar"]),
      ),
    )
    .orderBy(asc(encounterDictationSuggestion.createdAt), asc(encounterDictationSuggestion.id))
    .for("update")
}

async function settleRows(tx: Db, actorUserId: string, ids: string[], prescriptionId: string) {
  if (!ids.length) return
  await tx
    .update(encounterDictationSuggestion)
    .set({ status: "confirmada", entityId: prescriptionId, decidedBy: actorUserId, decidedAt: new Date(), updatedAt: new Date() })
    .where(inArray(encounterDictationSuggestion.id, ids))
}

/** Descartar: la sugerencia no entra a la historia. */
export async function discardDictationSuggestion(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  id: string,
): Promise<void> {
  await lockOwnDraft(tx, orgId, actorUserId, patientId, encounterId)
  await lockSuggestion(tx, orgId, patientId, encounterId, id)
  await tx
    .update(encounterDictationSuggestion)
    .set({ status: "descartada", decidedBy: actorUserId, decidedAt: new Date(), updatedAt: new Date() })
    .where(eq(encounterDictationSuggestion.id, id))
}

/** Descarta todo lo que quede sin decidir: lo que no se confirma no entra a la historia. */
export async function discardPendingDictation(tx: Db, orgId: string, actorUserId: string, patientId: string, encounterId: string): Promise<number> {
  await lockOwnDraft(tx, orgId, actorUserId, patientId, encounterId)
  const rows = await tx
    .update(encounterDictationSuggestion)
    .set({ status: "descartada", decidedBy: actorUserId, decidedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(encounterDictationSuggestion.organizationId, orgId),
        eq(encounterDictationSuggestion.encounterId, encounterId),
        inArray(encounterDictationSuggestion.status, ["lista", "por_revisar"]),
      ),
    )
    .returning({ id: encounterDictationSuggestion.id })
  return rows.length
}

/**
 * Lo mismo que `saveDictationSuggestions`, sin guardar nada: para el dictado
 * de práctica. Valida contra los servicios y el catálogo reales de la clínica.
 */
export async function previewDictationSuggestions(tx: Db, orgId: string, drafts: DictationDraft[]): Promise<Array<Omit<DictationSuggestion, "id" | "createdAt" | "voice" | "removal">>> {
  const scope = await dictationScope(tx, orgId)
  const zone = await findOrgLocale(tx, orgId)
  const out: Array<Omit<DictationSuggestion, "id" | "createdAt" | "voice" | "removal">> = []
  for (const draft of drafts.slice(0, DICTATION_MAX_SUGGESTIONS)) {
    const ready = await prepare(tx, draft, scope)
    if (!ready) continue
    out.push({ kind: draft.kind, payload: ready.payload, sourceText: (draft.sourceText ?? "").slice(0, DICTATION_SOURCE_CHARS), status: ready.status, note: ready.note, summary: summarize(draft.kind, ready.payload, zone, scope.dictation) })
  }
  return out
}

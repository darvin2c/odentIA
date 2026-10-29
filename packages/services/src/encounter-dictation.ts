import {
  ADMINISTRATION_ROUTES,
  type AllergenEntry,
  allergenName,
  allergyWarnings,
  BUDGET_OPTIONS_MAX,
  codeAllergySubstance,
  DIAGNOSIS_SYSTEM_INFO,
  DIAGNOSIS_VERIFICATION_LABELS,
  type DiagnosisSystemKey,
  findMedication,
  isDiagnosisVerification,
  type MedicationCatalog,
  normalizeDrugText,
  quantityWords,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  DICTATION_KINDS,
  type DictationKind,
  encounter,
  encounterDictationSuggestion,
  patientAllergy,
  prescription,
  serviceCatalog,
  treatmentBudget,
  treatmentBudgetOption,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { medicalLeave } from "@odentia/db/schema/clinical-forms"
import { product } from "@odentia/db/schema/inventory"
import { appointment } from "@odentia/db/schema/agenda"
import { auditEvent, branch } from "@odentia/db/schema/org"
import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm"
import { getAgentConfig } from "./agentConfig.js"
import { addPatientAllergy, markAllergiesReviewed, removePatientAllergy } from "./allergies.js"
import { createAppointment } from "./appointments.js"
import { listAvailableSlots, zonedTimeToUtc } from "./availability.js"
import { findDiagnosisCode, orgDiagnosisSystem } from "./diagnosis-codes.js"
import { addEncounterDiagnosis, voidEncounterDiagnosis } from "./encounter-diagnoses.js"
import { addEncounterProcedure, assertOpenDraft, lockEncounter, updateEncounterDraft, type UpdateEncounterDraftPatch, voidEncounterProcedure } from "./encounters.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { cancelFollowUp, createFollowUp } from "./follow-ups.js"
import { normalizeForSearch } from "./knowledge.js"
import { findOrgLocale, formatOrgMoney, type OrgLocale, orgProduct } from "./locale.js"
import { OPERATIONS, operationAgentSchema } from "./operation-fields.js"
import { addBudgetItems, assembleEncounterBudget, createBudget, duplicateBudgetOption, findDraftBudget, removeBudgetItems } from "./budgets.js"
import { addPlanItem, listPlanItems, setPlanItemStatus } from "./plan.js"
import { createPrescription } from "./prescriptions.js"
import { dictatedMaterials, materialsFromServices } from "./service-materials.js"
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
  signos: "Signos vitales",
  examen: "Examen físico",
  descanso: "Descanso médico",
  alergia: "Alergias",
  procedimiento: "Procedimientos",
  cita: "Próxima cita",
  presupuesto: "Presupuesto",
  material: "Materiales",
}

/** Operación de la atención que ejecuta cada clase de sugerencia al confirmarse. */
export const DICTATION_OPERATION = {
  nota: "atencion.nota",
  diagnostico: "atencion.diagnostico",
  plan: "plan.indicacion",
  control: "control.crear",
  odontograma: "odontograma.hallazgo",
  receta: "receta.medicamento",
  signos: "atencion.signos",
  examen: "atencion.examen",
  descanso: "descanso.medico",
  alergia: "alergia.dictada",
  procedimiento: "atencion.procedimiento",
  cita: "cita.dictada",
  presupuesto: "presupuesto.armar",
  material: "atencion.material",
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
  /** Ya confirmada, y pidió quitarla en voz alta: espera que una persona lo decida. */
  undoRequest: { said: string } | null
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
  /** «Quita la endodoncia» sobre una ya confirmada: nunca se quita sola, se propone. */
  undoRequest?: { said: string } | undefined
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

/** Un producto de Inventario que se usa en las atenciones: donde se busca un material dicho (ADR 0105). */
interface CareProduct {
  id: string
  name: string
  /** Unidad de uso, en singular. */
  unit: string
}

async function careProducts(tx: Db, orgId: string): Promise<CareProduct[]> {
  return tx
    .select({ id: product.id, name: product.name, unit: product.unit })
    .from(product)
    .where(and(eq(product.organizationId, orgId), eq(product.isActive, true), eq(product.usedInCare, true)))
    .orderBy(asc(product.name))
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
  /** Los productos que se usan en las atenciones: ahí se busca un material dicho. */
  products: CareProduct[]
  diagnosisSystem: DiagnosisSystemKey
  medications: MedicationCatalog
  dictation: ProductDictation
  /** Lo que el producto leyó para revisar (`ProductDictation.context`). */
  product: unknown
  /**
   * Si una indicación puede traer otros caminos para que el paciente elija: son
   * opciones de su presupuesto, así que solo donde lo indicado lo espera
   * (odentIA; en latidIA lo indicado queda aceptado, decisión 15 del issue 229).
   */
  choices: boolean
}

async function dictationScope(tx: Db, orgId: string): Promise<DictationScope> {
  const dictation = await requireDictatingProduct(tx, orgId)
  const hooks = await productHooks(tx, orgId)
  return {
    services: await activeServices(tx, orgId),
    products: await careProducts(tx, orgId),
    diagnosisSystem: await orgDiagnosisSystem(tx, orgId),
    medications: hooks.prescribing.catalog,
    dictation,
    product: await dictation.context(tx, orgId),
    choices: hooks.budgetRequired,
  }
}

/** Las clases de sugerencia de todo producto; cada uno suma las suyas (`ProductDictation.kinds`). */
const COMMON_KINDS: readonly DictationKind[] = ["nota", "diagnostico", "plan", "control", "receta", "alergia", "procedimiento", "cita", "presupuesto", "material"]

const words = (text: string) => normalizeForSearch(text).split(" ").filter((word) => word.length >= 3)

/**
 * La prestación del tarifario (o el producto de Inventario) que nombró el
 * odontólogo, o las más parecidas si no hay una sola.
 */
function matchService<T extends { name: string }>(spoken: string, services: T[]): { match: T | null; candidates: T[] } {
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
  if (kind === "alergia") {
    if (payload["none"] === true) return payload["review"] === "sin_cambios" ? "Sin alergias nuevas" : "No tiene alergias"
    const reaction = [payload["reaction"], payload["severity"] ? `reacción ${payload["severity"]}` : ""].filter(Boolean).join(" · ")
    return [`Alergia a ${allergyName(payload)}`, reaction].filter(Boolean).join("\n")
  }
  if (kind === "cita") {
    const what = String(payload["serviceName"] ?? payload["service"] ?? "")
    if (typeof payload["startsAt"] !== "string") return [`Cita${what ? ` · ${what}` : ""}`, payload["date"] ? `Desde el ${dayWords(String(payload["date"]), zone)}` : ""].filter(Boolean).join("\n")
    const minutes = typeof payload["durationMin"] === "number" ? ` · ${payload["durationMin"]} min` : ""
    return [`Cita · ${slotWords(payload["startsAt"], zone)}${what ? ` · ${what}` : ""}`, `Contigo${minutes}`].join("\n")
  }
  if (kind === "presupuesto") {
    const lines = Array.isArray(payload["lines"]) ? (payload["lines"] as BudgetPreviewLine[]) : []
    const total = typeof payload["totalCents"] === "number" && typeof payload["currency"] === "string" ? ` · ${formatOrgMoney(payload["totalCents"], payload["currency"], zone)}` : ""
    return [`Presupuesto · ${lines.length === 1 ? "1 tratamiento" : `${lines.length} tratamientos`}${total}`, "Queda en borrador: todavía no le llega a nadie."].join("\n")
  }
  if (kind === "material") {
    // El total de ese producto en la atención: lo que ya traían sus servicios no se suma.
    const name = String(payload["productName"] ?? payload["product"] ?? "")
    const total = typeof payload["unit"] === "string" ? `${quantityWords(quantityOf(payload), payload["unit"], zone.locale)} en total` : ""
    const brought = payload["inServices"] as MaterialInServices | undefined
    const unit = typeof payload["unit"] === "string" ? payload["unit"] : ""
    const said = typeof payload["alreadySaid"] === "number" ? payload["alreadySaid"] : null
    return [
      [name, total].filter(Boolean).join(" · "),
      said !== null
        ? `Ya anotaste ${quantityWords(said, unit, zone.locale)}: vale el total, no se suma`
        : brought
        ? `${brought.services.join(" y ")} ya trae ${quantityWords(brought.quantity, unit, zone.locale)}: vale el total, no se suma`
        : typeof payload["productId"] === "string"
          ? "Sale de la sede al firmar"
          : "",
    ]
      .filter(Boolean)
      .join("\n")
  }
  if (kind === "procedimiento") {
    const price =
      typeof payload["priceCents"] === "number" && typeof payload["currency"] === "string"
        ? ` · ${formatOrgMoney(payload["priceCents"] * quantityOf(payload), payload["currency"], zone)}`
        : ""
    const many = quantityOf(payload) > 1 ? ` ×${quantityOf(payload)}` : ""
    return [`Hecho hoy · ${payload["serviceName"] ?? payload["service"] ?? ""}${many}${price}`, [dictation.siteWords(payload), DONE_SOURCE[String(payload["source"])] ?? ""].filter(Boolean).join(" · ")]
      .filter(Boolean)
      .join("\n")
  }
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
      const how = options.length === 1 ? "dos caminos" : "tres caminos"
      const tooth = typeof payload["toothNumber"] === "number" ? `Pieza ${payload["toothNumber"]} · ` : ""
      return [`${tooth}${tooth ? how : `${how.charAt(0).toUpperCase()}${how.slice(1)}`}, el paciente elige`, `Opción A · recomendada: ${choice(payload as PlanChoice)}`, ...options.map((option, index) => `Opción ${OPTION_LETTER[index + 1]}: ${choice(option)}`)].join("\n")
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
    undoRequest: row.status === "confirmada" && meta.undoRequest ? { said: meta.undoRequest.said } : null,
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
            : item.kind === "alergia"
            ? payload["none"] === true ? "no tiene alergias" : allergyName(payload)
            : item.kind === "procedimiento"
            ? [String(payload["serviceName"] ?? payload["service"] ?? ""), dictation.siteWords(payload)].filter(Boolean).join(", ")
            : item.kind === "cita"
            ? [String(payload["serviceName"] ?? payload["service"] ?? ""), String(payload["date"] ?? ""), payload["time"] ? `a las ${payload["time"]}` : ""].filter(Boolean).join(", ")
            : item.kind === "presupuesto"
            ? "armar el presupuesto"
            : item.kind === "material"
            ? [String(payload["productName"] ?? payload["product"] ?? ""), typeof payload["quantity"] === "number" ? `${payload["quantity"]} en total` : ""].filter(Boolean).join(", ")
            : dictation.kinds.includes(item.kind)
            ? dictation.modelLabel(item.kind, payload)
            : String(payload["title"] ?? "Control")
  // Lo que le falta va a la vista del asistente: «oclusal», dicho solo, completa esa.
  const missing = (Array.isArray(payload["pending"]) ? (payload["pending"] as string[]) : []).map((key) => PENDING_WORDS[key] ?? key)
  return `${DICTATION_KIND_LABEL[item.kind]}: ${what}${missing.length ? ` · falta: ${missing.join(" y ")}` : ""}`
}

const PENDING_WORDS: Record<string, string> = { toothNumber: "la pieza", surfaces: "la cara", severity: "qué tan fuerte fue" }

/** Cómo se nombra la sustancia de una alergia dictada: «penicilinas», o como se dijo. */
const allergyName = (payload: Record<string, unknown>) => String(payload["name"] ?? payload["substance"] ?? "")

const quantityOf = (payload: Record<string, unknown>) => (typeof payload["quantity"] === "number" ? payload["quantity"] : 1)

/** De dónde sale lo que se hizo hoy, sin que el odontólogo lo elija. */
const DONE_SOURCE: Record<string, string> = { plan: "del plan", servicio: "de tus servicios", libre: "sin servicio: no se cobra" }

/** Cuánto de un material traen ya los servicios de la atención, y cuáles. */
type MaterialInServices = { quantity: number; services: string[] }

/**
 * Un material dicho se busca en Inventario, entre lo que se usa en las
 * atenciones. Lo que no está no se puede descontar: queda por revisar, con las
 * más parecidas si las hay; descartarlo no frena nada.
 */
function prepareMaterial(payload: Record<string, unknown>, products: CareProduct[]): Prepared {
  const spoken = String(payload["product"] ?? "").trim()
  const quantity = typeof payload["quantity"] === "number" ? { quantity: payload["quantity"] } : {}
  const { match, candidates } = matchService(spoken, products)
  if (match) return { payload: { product: spoken, productId: match.id, productName: match.name, unit: match.unit, ...quantity }, status: "lista", note: null }
  const names = candidates.map((item) => item.name)
  return {
    payload: { product: spoken, ...quantity },
    status: "por_revisar",
    note: names.length
      ? `¿Cuál de Inventario? ${names.join(" o ")}. Escríbelo al editar, o descártalo.`
      : `«${spoken}» no está entre los productos que se usan en las atenciones: agrégalo en Inventario o descártalo.`,
  }
}

/**
 * Lo dicho de un material es el total de ese producto en la atención (ADR
 * 0105): si sus servicios ya lo traen, se dice cuánto y no se suma. Sin
 * cantidad dicha queda lo que traen, o uno.
 */
async function settleMaterial(tx: Db, orgId: string, encounterId: string, prepared: Prepared): Promise<Prepared> {
  const { inServices: _old, alreadySaid: _said, ...payload } = prepared.payload
  if (typeof payload["productId"] !== "string") return { ...prepared, payload }
  // Lo ya anotado de ese producto manda sobre lo de sus servicios: es lo que saldría hoy.
  const said = (await dictatedMaterials(tx, orgId, encounterId)).get(payload["productId"])
  const brought = said ? undefined : (await materialsFromServices(tx, orgId, encounterId)).get(payload["productId"])
  const quantity = typeof payload["quantity"] === "number" ? payload["quantity"] : (said ?? brought?.quantity ?? 1)
  return { ...prepared, payload: { ...payload, quantity, ...(said ? { alreadySaid: said } : brought ? { inServices: brought } : {}) } }
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
  if (draft.kind === "diagnostico" || draft.kind === "plan" || draft.kind === "procedimiento") {
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
    const options = scope.choices && Array.isArray(alternatives) ? alternatives.filter((spoken) => typeof spoken === "string" && spoken.trim()).map((spoken) => ({ service: String(spoken).trim() })) : []
    return settlePlan({ ...main, ...(options.length ? { options } : {}) }, services, dictation)
  }
  if (draft.kind === "receta") return prepareMedication(payload, scope.medications)
  if (draft.kind === "alergia") return prepareAllergy(payload, scope.medications.allergens)
  if (draft.kind === "material") return prepareMaterial(payload, scope.products)
  if (draft.kind === "cita") {
    // El día se cuenta desde hoy: uno que no es una fecha no se adivina.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(payload["date"])) || Number.isNaN(new Date(`${payload["date"]}T12:00:00Z`).getTime())) {
      return { payload, status: "por_revisar", note: "No entendí para qué día. Dilo otra vez o elige otro horario." }
    }
    if (payload["time"] !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(payload["time"]))) delete payload["time"]
    const what = typeof payload["service"] === "string" ? chooseService(payload as PlanChoice, services) : {}
    return { payload: { ...payload, ...what }, status: "lista", note: null }
  }
  if (draft.kind === "presupuesto") return { payload: { show: payload["show"] === true }, status: "lista", note: null }
  // Lo que se hizo hoy se busca en el tarifario; de dónde sale (el plan, tus servicios o un
  // acto libre) se decide con lo del paciente (`checkAgainstPatient`).
  if (draft.kind === "procedimiento") return { payload: { ...payload, ...chooseService(payload as PlanChoice, services) }, status: "lista", note: null }
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
  // La elección guarda la pieza y las caras como se dijeron: cada camino toma de ahí lo suyo al
  // confirmarse (`confirmPlanChoice`), y la corona no se queda sin las caras que pide la resina.
  const site = choiceSite(base)
  const ready: Prepared = { ...fitted, payload: { ...fitted.payload, ...site, options } }
  // Cada opción dice qué se dijo y sus candidatas; arriba basta una línea.
  if (!main.serviceId || (fitted.status === "lista" && options.some((option) => !option.serviceId))) return { ...ready, status: "por_revisar", note: CHOOSE_EACH_OPTION }
  if (fitted.status !== "lista") return ready
  // Resina (por caras) o corona (por pieza): cada camino se revisa con su propio ámbito.
  // Lo que le falta a alguno (la cara de la resina) es un aviso de la elección, no un freno.
  const pending = new Set(Array.isArray(fitted.payload["pending"]) ? (fitted.payload["pending"] as string[]) : [])
  let note = fitted.note
  for (const [index, option] of options.entries()) {
    const own = dictation.fitToScope(site, option.serviceScope ?? null)
    const label = `Opción ${OPTION_LETTER[index + 1]} · ${option.serviceName ?? option.service}`
    if (own.status !== "lista") return { ...ready, status: "por_revisar", note: `${label}: ${own.note}` }
    for (const key of Array.isArray(own.payload["pending"]) ? (own.payload["pending"] as string[]) : []) pending.add(key)
    note ??= own.note ? `${label}: ${own.note}` : null
  }
  const { pending: _old, ...choice } = ready.payload
  return { payload: pending.size ? { ...choice, pending: [...pending] } : choice, status: "lista", note }
}

/** La pieza y las caras de una elección de caminos, tal como se dijeron. */
function choiceSite(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(["toothNumber", "surfaces"].filter((key) => payload[key] !== undefined && payload[key] !== null).map((key) => [key, payload[key]]))
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

const ASK_SEVERITY = "¿Qué tan fuerte fue? Si no lo sabe, confirma igual: entra como «No se sabe»."
const UNCODED_SUBSTANCE = "No está en la lista de sustancias: entra como la dijiste y después la eliges de la lista."

/**
 * Una alergia dicha: la sustancia con su código si es una de la lista (la misma
 * regla que «Nueva alergia», `codeAllergySubstance`) o como se dijo. Qué tan
 * fuerte fue no se deduce: si no se dijo, es un aviso y entra como «No se sabe».
 * «Niega alergias» responde la revisión de alergias.
 */
function prepareAllergy(payload: Record<string, unknown>, allergens: readonly AllergenEntry[]): Prepared | null {
  const spoken = typeof payload["substance"] === "string" ? payload["substance"].trim().replace(/\s+/g, " ") : ""
  if (!spoken) return payload["none"] === true ? { payload: { none: true }, status: "lista", note: null } : null
  const entry = codeAllergySubstance(spoken, allergens)
  const ready: Record<string, unknown> = {
    substance: entry ? entry.label : spoken,
    name: entry ? allergenName(entry) : spoken,
    ...(entry ? { substanceSystem: entry.system, substanceCode: entry.code } : {}),
    ...(typeof payload["reaction"] === "string" ? { reaction: payload["reaction"] } : {}),
    ...(typeof payload["severity"] === "string" ? { severity: payload["severity"] } : { pending: ["severity"] }),
  }
  const note = [ready["severity"] ? "" : ASK_SEVERITY, entry ? "" : UNCODED_SUBSTANCE].filter(Boolean).join(" ")
  return { payload: ready, status: "lista", note: note || null }
}

/** La misma sustancia: el mismo código o, sin código, el mismo texto (la regla de `addPatientAllergy`). */
function sameSubstance(a: { substance: string; substanceSystem?: string | null; substanceCode?: string | null }, b: typeof a): boolean {
  if (a.substanceCode || b.substanceCode) return a.substanceSystem === b.substanceSystem && a.substanceCode === b.substanceCode
  return normalizeDrugText(a.substance) === normalizeDrugText(b.substance)
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
  // Tocar otro hueco de los que ofrece la tarjeta: se queda ese, si sigue libre.
  if (kind === "cita" && typeof patch["startsAt"] === "string") return { payload: { ...current, startsAt: patch["startsAt"] }, status: "lista", note: null }
  if (kind === "procedimiento") {
    if (typeof patch["serviceId"] === "string") {
      const chosen = services.find((service) => service.id === patch["serviceId"])
      if (!chosen) throw validation("Esa prestación no está activa en tus servicios")
      payload = { ...payload, service: chosen.name }
    } else if (typeof patch["service"] === "string" && patch["service"] !== current["service"]) {
      for (const key of [...MAIN_SERVICE_KEYS.filter((key) => key !== "service"), "planItemId", "acceptOnDo", "source"]) delete payload[key]
    }
    return prepare(tx, { kind, payload }, scope)
  }
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

type AllergyOnFile = { substance: string; substanceSystem: string | null; substanceCode: string | null; severity: string | null; verification: string | null }

/** Un tratamiento del plan que aún se puede hacer hoy: del que sale lo que se dice hecho. */
interface OpenPlanItem {
  id: string
  serviceId: string | null
  title: string
  scope: string | null
  toothNumber: number | null
  surfaces: string[]
  priceCents: number | null
  currency: string | null
  accepted: boolean
  /** Está en un presupuesto ya enviado: su respuesta la da el paciente, no el dictado. */
  inSentBudget: boolean
}

/** Lo del paciente que revisa una sugerencia antes de quedar lista: sus alergias, su plan y si ya hay una elección en curso. */
interface PatientChecks {
  allergies: AllergyOnFile[]
  /** Las alergias dictadas en esta atención que aún no se confirman: también avisan al recetar. */
  dictatedAllergies: AllergyOnFile[]
  /** Por qué no cabe otra elección de caminos (decisión 3), o null si cabe. */
  choiceBlocked: string | null
  planItems: OpenPlanItem[]
}

/** Lo que se puede hacer hoy de un tratamiento: no está cerrado ni suspendido, y está aceptado o espera respuesta. */
const DOABLE_STATUSES = ["pendiente", "programado", "en_curso"]
const DOABLE_DECISIONS = ["aceptado", "pendiente"]

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
  const pending = await listDictationSuggestions(tx, orgId, patientId, encounterId)
  // Manda la primera elección dicha: la que ya espera por esta regla no le quita el lugar.
  const pendingChoice = pending.some(
    (item) => item.kind === "plan" && item.id !== exceptId && Array.isArray(item.payload["options"]) && item.note !== CHOICE_ALREADY_HERE,
  )
  const dictatedAllergies = pending
    .filter((item) => item.kind === "alergia" && item.id !== exceptId && typeof item.payload["substance"] === "string")
    .map((item) => dictatedAllergy(item.payload))
  const draft = await findDraftBudget(tx, orgId, patientId)
  const draftOptions = draft
    ? (await tx.select({ id: treatmentBudgetOption.id }).from(treatmentBudgetOption).where(and(eq(treatmentBudgetOption.organizationId, orgId), eq(treatmentBudgetOption.budgetId, draft.id)))).length
    : 0
  const items = (await listPlanItems(tx, orgId, patientId)).filter((item) => DOABLE_STATUSES.includes(item.status) && DOABLE_DECISIONS.includes(item.decision))
  const budgetIds = [...new Set(items.flatMap((item) => (item.budgetId ? [item.budgetId] : [])))]
  const sent = new Set(
    budgetIds.length
      ? (await tx.select({ id: treatmentBudget.id, status: treatmentBudget.status }).from(treatmentBudget).where(and(eq(treatmentBudget.organizationId, orgId), inArray(treatmentBudget.id, budgetIds))))
          .filter((budget) => budget.status !== "borrador")
          .map((budget) => budget.id)
      : [],
  )
  const planItems = items.map((item) => {
    const site = item as typeof item & { toothNumber?: number | null; surfaces?: string[] | null }
    return {
      id: item.id,
      serviceId: item.serviceId,
      title: item.title,
      scope: item.scope,
      toothNumber: site.toothNumber ?? null,
      surfaces: site.surfaces ?? [],
      priceCents: item.priceCents,
      currency: item.currency,
      accepted: item.decision === "aceptado",
      inSentBudget: Boolean(item.budgetId && sent.has(item.budgetId)),
    }
  })
  return { allergies, dictatedAllergies, choiceBlocked: pendingChoice ? CHOICE_ALREADY_HERE : draftOptions > 1 ? CHOICE_ALREADY_IN_BUDGET : null, planItems }
}

/** Una alergia dictada, como la lee el aviso al recetar. */
const dictatedAllergy = (payload: Record<string, unknown>): AllergyOnFile => ({
  substance: String(payload["substance"] ?? ""),
  substanceSystem: typeof payload["substanceSystem"] === "string" ? payload["substanceSystem"] : null,
  substanceCode: typeof payload["substanceCode"] === "string" ? payload["substanceCode"] : null,
  severity: typeof payload["severity"] === "string" ? payload["severity"] : null,
  verification: null,
})

/**
 * Lo que se revisa con el paciente antes de guardar una sugerencia. La cita lee
 * además la agenda (el hueco) y el presupuesto, lo indicado en la atención.
 */
async function withPatient(
  tx: Db,
  orgId: string,
  patientId: string,
  encounterId: string,
  kind: DictationKind,
  prepared: Prepared,
  checks: PatientChecks,
  scope: DictationScope,
): Promise<Prepared> {
  const ready = checkAgainstPatient(kind, prepared, checks, scope.medications, scope.dictation)
  if (kind === "cita") return settleAppointment(tx, orgId, patientId, encounterId, ready, checks)
  if (kind === "presupuesto") return previewBudget(tx, orgId, patientId, encounterId, ready, scope)
  if (kind === "material") return settleMaterial(tx, orgId, encounterId, ready)
  return ready
}

/** Cuántos huecos ofrece la tarjeta de la cita, y en cuántos días desde el pedido se buscan. */
const SLOT_CHOICES = 3
const SLOT_DAYS = 8
const DAY_MS = 86_400_000

/** Fecha y hora de un hueco como se lee en la tarjeta: «jueves 12 de noviembre, 10:00». */
function slotWords(startsAt: string, zone: Zone): string {
  const at = new Date(startsAt)
  const day = at.toLocaleDateString(zone.locale, { timeZone: zone.timezone, weekday: "long", day: "numeric", month: "long" })
  const time = at.toLocaleTimeString(zone.locale, { timeZone: zone.timezone, hour: "2-digit", minute: "2-digit", hour12: false })
  return `${day}, ${time}`
}

/** Un día dicho (AAAA-MM-DD) en palabras: «12 de noviembre». */
function dayWords(date: string, zone: Zone): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(zone.locale, { timeZone: "UTC", day: "numeric", month: "long" })
}

/** Dónde y con quién va la próxima cita: la sede de la atención (o la primera de la clínica) y quien la lleva. */
async function appointmentPlace(tx: Db, orgId: string, encounterId: string) {
  const [row] = await tx
    .select({ branchId: encounter.branchId, professionalUserId: encounter.professionalUserId })
    .from(encounter)
    .where(and(eq(encounter.organizationId, orgId), eq(encounter.id, encounterId)))
    .limit(1)
  const [place] = await tx
    .select({ id: branch.id, timezone: branch.timezone })
    .from(branch)
    .where(and(eq(branch.organizationId, orgId), eq(branch.isActive, true), ...(row?.branchId ? [eq(branch.id, row.branchId)] : [])))
    .orderBy(asc(branch.createdAt))
    .limit(1)
  const locale = await findOrgLocale(tx, orgId)
  return {
    branchId: place?.id ?? null,
    professionalUserId: row?.professionalUserId ?? null,
    zone: { locale: locale.locale, timezone: place?.timezone || locale.timezone },
  }
}

const NO_BRANCH = "La clínica no tiene una sede activa: reserva la cita desde Agenda."
const NO_SLOTS = "No tienes huecos libres esa semana: elige otro horario."

/**
 * «Cítalo en quince días para la endodoncia»: el primer hueco libre de quien
 * lleva la atención desde ese día, en su sede y con la duración del servicio
 * (`listAvailableSlots`, la misma regla de la agenda), y dos más cerca para
 * elegir con un toque. Con la hora dicha, esa; si no está libre, la más
 * cercana, con el aviso. Si ya tiene una cita cerca de ese día, no se reserva
 * otra. Lo que la cita trae (el tratamiento aceptado de ese servicio) lo une
 * `createAppointment` al reservar.
 */
async function settleAppointment(
  tx: Db,
  orgId: string,
  patientId: string,
  encounterId: string,
  prepared: Prepared,
  checks: PatientChecks,
): Promise<Prepared> {
  if (prepared.status === "por_revisar") return prepared
  const { slots: _slots, existing: _existing, durationMin: _duration, branchId: _branch, planItemIds: _items, startsAt: kept, ...base } = prepared.payload
  const place = await appointmentPlace(tx, orgId, encounterId)
  if (!place.branchId || !place.professionalUserId) return { payload: base, status: "por_revisar", note: NO_BRANCH }
  const dayStart = zonedTimeToUtc(String(base["date"]), 0, place.zone.timezone)
  const [near] = await tx
    .select({ id: appointment.id, startsAt: appointment.startsAt })
    .from(appointment)
    .where(
      and(
        eq(appointment.organizationId, orgId),
        eq(appointment.patientId, patientId),
        inArray(appointment.status, ["programada", "confirmada"]),
        gt(appointment.startsAt, new Date(Math.max(Date.now(), dayStart.getTime() - 7 * DAY_MS))),
        lt(appointment.startsAt, new Date(dayStart.getTime() + SLOT_DAYS * DAY_MS)),
      ),
    )
    .orderBy(asc(appointment.startsAt))
    .limit(1)
  if (near) {
    const at = near.startsAt.toISOString()
    return { payload: { ...base, existing: { id: near.id, startsAt: at } }, status: "lista", note: `Ya tiene cita el ${slotWords(at, place.zone)}: no se reserva otra.` }
  }
  const serviceId = typeof base["serviceId"] === "string" ? base["serviceId"] : null
  const [service] = serviceId
    ? await tx.select({ durationMin: serviceCatalog.durationMin }).from(serviceCatalog).where(and(eq(serviceCatalog.organizationId, orgId), eq(serviceCatalog.id, serviceId))).limit(1)
    : []
  const search = (withService: boolean) =>
    listAvailableSlots(tx, orgId, {
      branchId: place.branchId!,
      professionalUserId: place.professionalUserId!,
      ...(withService && serviceId ? { serviceId } : service?.durationMin ? { durationMin: service.durationMin } : {}),
      from: dayStart.toISOString(),
      to: new Date(dayStart.getTime() + SLOT_DAYS * DAY_MS).toISOString(),
      notBefore: new Date().toISOString(),
    })
  // Quien atiende la cita es quien la pide: si el servicio no está entre los suyos en la agenda, se busca con su duración.
  let found = await search(true)
  if (found.slots.length === 0 && serviceId) found = await search(false)
  const slots = found.slots.filter((slot, index, all) => all.findIndex((other) => other.startsAt === slot.startsAt) === index)
  if (slots.length === 0) return { payload: base, status: "por_revisar", note: NO_SLOTS }
  const time = typeof base["time"] === "string" ? base["time"] : null
  const wanted = typeof kept === "string" ? Date.parse(kept) : time ? zonedTimeToUtc(String(base["date"]), Number(time.slice(0, 2)) * 60 + Number(time.slice(3)), place.zone.timezone).getTime() : null
  const nearest = (target: number) => [...slots].sort((a, b) => Math.abs(Date.parse(a.startsAt) - target) - Math.abs(Date.parse(b.startsAt) - target))
  const chosen = wanted === null ? slots[0]! : nearest(wanted)[0]!
  const picked = nearest(Date.parse(chosen.startsAt)).slice(0, SLOT_CHOICES).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
  const moved = wanted !== null && Date.parse(chosen.startsAt) !== wanted
  const note = !moved
    ? null
    : typeof kept === "string"
      ? `${slotWords(kept, place.zone)} se ocupó: te dejo el hueco más cercano.`
      : `A las ${time} no está libre: te dejo el hueco más cercano.`
  const planItemIds = serviceId ? checks.planItems.filter((item) => item.accepted && item.serviceId === serviceId).map((item) => item.id) : []
  return {
    payload: {
      ...base,
      startsAt: chosen.startsAt,
      durationMin: Math.round((Date.parse(chosen.endsAt) - Date.parse(chosen.startsAt)) / 60_000),
      slots: picked.map((slot) => slot.startsAt),
      branchId: place.branchId,
      ...(planItemIds.length ? { planItemIds } : {}),
    },
    status: "lista",
    note,
  }
}

/** Una línea de lo que llevaría el presupuesto pedido. */
interface BudgetPreviewLine {
  title: string
  site: string
  priceCents: number
  currency: string
  /** Dictada hoy y aún sin confirmar: entra al plan al armarlo. */
  dictated: boolean
}

const NOTHING_TO_QUOTE = "Aún no hay nada con precio para presupuestar: indica un tratamiento y pídelo otra vez."

/**
 * Lo que llevaría «Arma el presupuesto»: lo indicado en esta atención que aún
 * no está en un presupuesto (la regla de firmar, `assembleEncounterBudget`) y
 * lo dictado que espera confirmación, con los precios de la lista.
 */
async function previewBudget(tx: Db, orgId: string, patientId: string, encounterId: string, prepared: Prepared, scope: DictationScope): Promise<Prepared> {
  const required = (await productHooks(tx, orgId)).budgetRequired
  const indicated = (await listPlanItems(tx, orgId, patientId)).filter(
    (item) =>
      item.sourceEncounterId === encounterId &&
      item.budgetId === null &&
      item.status === "pendiente" &&
      item.decision === (required ? "pendiente" : "aceptado") &&
      item.priceCents !== null &&
      item.currency,
  )
  const suggestions = await listDictationSuggestions(tx, orgId, patientId, encounterId)
  const pending = suggestions.filter(
    (item) => item.kind === "plan" && item.status === "lista" && typeof item.payload["priceCents"] === "number" && typeof item.payload["currency"] === "string",
  )
  // Lo dictado que aún no tiene servicio de tu lista no tiene precio: sale sin eso, y se dice.
  const unpriced = suggestions.filter((item) => item.kind === "plan" && typeof item.payload["serviceId"] !== "string").map((item) => String(item.payload["service"] ?? ""))
  const lines: BudgetPreviewLine[] = [
    ...indicated.map((item) => ({ title: item.title, site: scope.dictation.siteWords(item as unknown as Record<string, unknown>), priceCents: item.priceCents!, currency: item.currency!, dictated: false })),
    ...pending.map((item) => ({
      title: String(item.payload["serviceName"] ?? item.payload["service"] ?? ""),
      site: scope.dictation.siteWords(item.payload),
      priceCents: item.payload["priceCents"] as number,
      currency: item.payload["currency"] as string,
      dictated: true,
    })),
  ]
  const currency = lines[0]?.currency ?? null
  const same = lines.filter((line) => line.currency === currency)
  const payload = { show: prepared.payload["show"] === true, lines: same, ...(currency ? { totalCents: same.reduce((sum, line) => sum + line.priceCents, 0), currency } : {}) }
  const missing = unpriced.length
    ? `${unpriced.map((name) => `«${name}»`).join(" y ")} aún no ${unpriced.length === 1 ? "tiene" : "tienen"} servicio de tu lista: sale sin eso. Elige el servicio en su tarjeta.`
    : null
  return same.length ? { payload, status: "lista", note: missing } : { payload, status: "por_revisar", note: missing ?? NOTHING_TO_QUOTE }
}

/** El presupuesto pedido que aún espera, al día con lo que se indicó o se confirmó después. */
async function refreshBudgetPreview(tx: Db, orgId: string, patientId: string, encounterId: string, scope: DictationScope): Promise<void> {
  for (const row of await pendingRowsOf(tx, orgId, patientId, encounterId, "presupuesto")) {
    const { data, meta } = splitMeta(row.payload)
    const ready = await previewBudget(tx, orgId, patientId, encounterId, { payload: data, status: "lista", note: null }, scope)
    await tx
      .update(encounterDictationSuggestion)
      .set({ payload: withMeta(ready.payload, meta), status: ready.status, note: ready.note, updatedAt: new Date() })
      .where(eq(encounterDictationSuggestion.id, row.id))
  }
}

const IN_SENT_BUDGET = "Está en un presupuesto que el paciente aún no respondió: se registra como servicio de tu lista. Anota su respuesta en el presupuesto."
const ACCEPTED_WHEN_DONE = "Estaba en un presupuesto sin aceptar: al confirmar, queda aceptado y hecho, con su precio."
const NOT_IN_SERVICES = "No está en tus servicios: queda registrado sin cobro. Si se cobra, elige el servicio."

/**
 * De dónde sale lo que se dice hecho, sin que el odontólogo lo elija: del
 * tratamiento del plan que lo indicaba (con su precio, y la pieza o la cara que
 * le faltaban), de sus servicios o, si no está en ninguno, como acto libre que
 * no se cobra. Lo hecho sí necesita su sitio: si falta, se pregunta.
 */
function settleDone(prepared: Prepared, checks: PatientChecks, dictation: ProductDictation): Prepared {
  const { planItemId: _item, acceptOnDo: _accept, source: _source, pending: _pending, ...base } = prepared.payload
  const said = placeOf(base)
  const spoken = String(base["service"] ?? "")
  const byService = checks.planItems.filter((item) =>
    typeof base["serviceId"] === "string"
      ? item.serviceId === base["serviceId"]
      : matchService(spoken, [{ id: item.id, name: item.title, priceCents: 0, currency: "", scope: item.scope }]).match !== null,
  )
  const fits = byService.filter((item) => said.tooth === null || item.toothNumber === null || item.toothNumber === said.tooth)
  // Con la pieza dicha, la de esa pieza; sin pieza, solo si hay uno: entre dos resinas no se adivina.
  const item = fits.find((one) => said.tooth !== null && one.toothNumber === said.tooth) ?? (fits.length === 1 ? fits[0] : undefined)
  if (item && !item.inSentBudget) {
    const { quantity: _quantity, candidates: _candidates, serviceName: _name, priceCents: _price, currency: _currency, ...rest } = base
    const site = { ...rest, ...(item.toothNumber !== null ? { toothNumber: item.toothNumber } : {}), ...(item.surfaces.length ? { surfaces: item.surfaces } : {}), ...siteOf(said) }
    const fitted = dictation.fitToScope(site, item.scope, true)
    const done = {
      ...fitted.payload,
      planItemId: item.id,
      serviceName: item.title,
      ...(item.priceCents !== null && item.currency ? { priceCents: item.priceCents, currency: item.currency } : {}),
      source: "plan",
      ...(item.accepted ? {} : { acceptOnDo: true }),
    }
    const note = [fitted.note, item.accepted ? null : ACCEPTED_WHEN_DONE].filter(Boolean).join(" ")
    return { payload: done, status: fitted.status, note: note || null }
  }
  if (typeof base["serviceId"] === "string") {
    const fitted = dictation.fitToScope(base, typeof base["serviceScope"] === "string" ? base["serviceScope"] : null, true)
    const note = [fitted.note, item?.inSentBudget ? IN_SENT_BUDGET : null].filter(Boolean).join(" ")
    return { payload: { ...fitted.payload, source: "servicio" }, status: fitted.status, note: note || null }
  }
  // Ni en el plan ni en sus servicios: queda registrado sin cobro, y si se cobra se elige el servicio.
  return { payload: { ...base, source: "libre" }, status: "lista", note: NOT_IN_SERVICES }
}

/**
 * Lo que solo se sabe con el paciente: una receta que choca con sus alergias
 * queda por revisar con el aviso de siempre (la misma regla que «Emitir
 * receta»), y una elección de caminos que no cabe en su presupuesto espera.
 */
function checkAgainstPatient(kind: DictationKind, prepared: Prepared, checks: PatientChecks, medications: MedicationCatalog, dictation: ProductDictation): Prepared {
  if (kind === "receta") {
    const { allergyWarnings: _old, ...payload } = prepared.payload
    const genericName = String(payload["genericName"] ?? "")
    const onFile = allergyWarnings(genericName, checks.allergies as never, medications)
    // La alergia que se acaba de dictar avisa igual, aunque aún no se confirme.
    const dictated = allergyWarnings(genericName, checks.dictatedAllergies as never, medications).filter((line) => !onFile.includes(line))
    const warnings = [...onFile, ...dictated]
    if (!warnings.length) return { ...prepared, payload }
    const note = [onFile.length ? `Aviso de alergia: ${onFile.join(" ")}` : "", dictated.length ? `Aviso de la alergia que dictaste hoy: ${dictated.join(" ")}` : ""].filter(Boolean).join(" ")
    return { payload: { ...payload, allergyWarnings: warnings }, status: "por_revisar", note }
  }
  if (kind === "alergia") {
    const { review: _review, known: _known, ...payload } = prepared.payload
    // «Niega alergias» con alergias registradas es «Sin cambios»; sin ninguna, «No tiene alergias».
    if (payload["none"] === true) return { ...prepared, payload: { ...payload, review: checks.allergies.length ? "sin_cambios" : "no_tiene" } }
    const said = dictatedAllergy(payload)
    return checks.allergies.some((row) => sameSubstance(row, said)) ? { ...prepared, payload: { ...payload, known: true } } : { ...prepared, payload }
  }
  if (kind === "procedimiento") return settleDone(prepared, checks, dictation)
  if (kind === "plan" && Array.isArray(prepared.payload["options"])) {
    // `choiceBlocked`: la pantalla la muestra sin elegir nada, porque así no se puede confirmar.
    const { choiceBlocked: _old, ...payload } = prepared.payload
    if (!checks.choiceBlocked) return { ...prepared, payload }
    return { payload: { ...payload, choiceBlocked: true }, status: "por_revisar", note: checks.choiceBlocked }
  }
  return prepared
}

/** Las clases que se revisan con lo del paciente: sus alergias, su plan, su presupuesto y lo que ya traen sus servicios. */
const PATIENT_CHECKED: readonly DictationKind[] = ["plan", "receta", "alergia", "procedimiento", "cita", "presupuesto", "material"]

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

/** Dónde va una indicación o un diagnóstico: la pieza y sus caras, ordenadas. */
interface Place {
  tooth: number | null
  surfaces: string[]
}

const placeOf = (payload: Record<string, unknown>): Place => ({
  tooth: typeof payload["toothNumber"] === "number" ? payload["toothNumber"] : null,
  surfaces: Array.isArray(payload["surfaces"]) ? [...(payload["surfaces"] as string[])].sort() : [],
})

/** ¿`wide` ya dice todo lo de `narrow`? Sin pieza no dice nada; con pieza, la misma, y las mismas caras si las tiene. */
function covers(wide: Place, narrow: Place): boolean {
  if (narrow.tooth === null) return true
  if (wide.tooth !== narrow.tooth) return false
  return narrow.surfaces.length === 0 || JSON.stringify(wide.surfaces) === JSON.stringify(narrow.surfaces)
}

const siteOf = (place: Place): Record<string, unknown> => ({
  ...(place.tooth !== null ? { toothNumber: place.tooth } : {}),
  ...(place.surfaces.length ? { surfaces: place.surfaces } : {}),
})

const isPlanChoice = (kind: DictationKind, payload: Record<string, unknown>) =>
  kind === "plan" && Array.isArray(payload["options"]) && payload["options"].length > 0

/** Una indicación pendiente del plan: sus prestaciones (la principal y sus caminos) y dónde va. */
interface PendingPlan {
  id: string | null
  names: string[]
  place: Place
  choice: boolean
}

/** Cada prestación se reconoce por su servicio o, si no se ubicó, por cómo se dijo. */
function planEntry(id: string | null, payload: Record<string, unknown>): PendingPlan {
  const choices = [payload as PlanChoice, ...(Array.isArray(payload["options"]) ? (payload["options"] as PlanChoice[]) : [])]
  const names = choices.flatMap((choice) => [
    ...(choice.serviceId ? [`id:${choice.serviceId}`] : []),
    ...(choice.service ? [`dicho:${normalizeForSearch(String(choice.service))}`] : []),
  ])
  return { id, names, place: placeOf(payload), choice: choices.length > 1 }
}

const diagnosisKey = (payload: Record<string, unknown>) =>
  JSON.stringify([String(payload["diagnosisCode"] ?? "").trim().toUpperCase(), placeOf(payload)])

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
  /** Ya confirmadas que pidió quitar: quedan propuestas, no se quitan solas. */
  undoRequested: string[]
  /** Alergias dichas que ya estaban registradas («penicilinas»): no se proponen, se avisa. */
  alreadyOnFile: string[]
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
    return { suggestions: [], corrected: [], removed: [], undoRequested: [], alreadyOnFile: [], repeated: true }
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
  /** Aplica a una sugerencia pendiente lo que se corrigió en voz alta. `false`: no encaja o no cambia nada. */
  const correct = async (suggestionId: string, changes: Record<string, unknown>): Promise<boolean> => {
    const row = await pendingRow(suggestionId)
    if (!row) return false
    const { data, meta } = splitMeta(row.payload)
    const schema = operationAgentSchema(DICTATION_OPERATION[row.kind])
    const patch = Object.fromEntries(Object.entries(changes).filter(([key, value]) => key in schema.shape && value !== undefined && value !== null))
    if (Object.keys(patch).length === 0 || !schema.safeParse({ ...data, ...patch }).success) return false
    const revised = await revise(tx, row.kind, data, patch, scope)
    if (!revised) return false
    const ready = PATIENT_CHECKED.includes(row.kind)
      ? await withPatient(tx, orgId, patientId, encounterId, row.kind, revised, await patientChecks(tx, orgId, patientId, encounterId, row.id), scope)
      : revised
    const before = describeBefore(row.kind, data, ready.payload, Object.keys(patch), dictation)
    if (!before) return false
    // Se conserva cómo estaba antes de la primera corrección: deshacer vuelve ahí.
    const voice = meta.voice ?? { payload: data, status: row.status as "lista" | "por_revisar", note: row.note, before }
    await tx
      .update(encounterDictationSuggestion)
      .set({ payload: withMeta(ready.payload, stamp({ ...meta, voice })), status: ready.status, note: ready.note, updatedAt: new Date() })
      .where(eq(encounterDictationSuggestion.id, row.id))
    if (!corrected.includes(row.id)) corrected.push(row.id)
    return true
  }
  for (const correction of (segment.corrections ?? []).slice(0, DICTATION_MAX_SUGGESTIONS)) await correct(correction.suggestionId, correction.changes)

  const removed: string[] = []
  const undoRequested: string[] = []
  for (const removal of (segment.removals ?? []).slice(0, DICTATION_MAX_SUGGESTIONS)) {
    const row = await pendingRow(removal.suggestionId)
    if (!row) {
      // Ya confirmada hoy: lo confirmado nunca se quita solo. Queda propuesto en su
      // tarjeta («Quitar del plan» / «Dejarla») y una persona lo decide.
      const [confirmed] = await tx
        .select()
        .from(encounterDictationSuggestion)
        .where(
          and(
            eq(encounterDictationSuggestion.organizationId, orgId),
            eq(encounterDictationSuggestion.encounterId, encounterId),
            eq(encounterDictationSuggestion.id, removal.suggestionId),
            eq(encounterDictationSuggestion.status, "confirmada"),
            inArray(encounterDictationSuggestion.kind, UNDOABLE_KINDS),
          ),
        )
        .for("update")
        .limit(1)
      if (!confirmed) continue
      const { data, meta } = splitMeta(confirmed.payload)
      await tx
        .update(encounterDictationSuggestion)
        .set({ payload: withMeta(data, stamp({ ...meta, undoRequest: { said: removal.said.slice(0, DICTATION_SOURCE_CHARS) } })), updatedAt: new Date() })
        .where(eq(encounterDictationSuggestion.id, confirmed.id))
      undoRequested.push(confirmed.id)
      continue
    }
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
  // Lo mismo con el plan y los diagnósticos: la misma prestación o el mismo diagnóstico en el mismo sitio.
  const pendingPlans: PendingPlan[] = pendingNow.filter((item) => item.kind === "plan").map((item) => planEntry(item.id, item.payload))
  const pendingDiagnoses = new Set(pendingNow.filter((item) => item.kind === "diagnostico").map((item) => diagnosisKey(item.payload)))
  const rows: Array<typeof encounterDictationSuggestion.$inferInsert> = []
  const checks = await patientChecks(tx, orgId, patientId, encounterId)
  const preparedDrafts: Array<{ draft: DictationDraft; prepared: Prepared }> = []
  for (const draft of segment.drafts.slice(0, DICTATION_MAX_SUGGESTIONS)) {
    const prepared = await prepare(tx, draft, scope)
    if (prepared) preparedDrafts.push({ draft, prepared })
  }
  // La elección de caminos va antes: así la indicación suelta de uno de sus caminos se reconoce repetida.
  // Las alergias, antes que las recetas: la que se acaba de dictar ya avisa en este mismo tramo.
  const first = (draft: { draft: DictationDraft; prepared: Prepared }) => Number(isPlanChoice(draft.draft.kind, draft.prepared.payload)) * 2 + Number(draft.draft.kind === "alergia")
  preparedDrafts.sort((a, b) => first(b) - first(a))
  const allergyKey = (payload: Record<string, unknown>) => (payload["none"] === true ? "ninguna" : JSON.stringify([payload["substanceSystem"] ?? null, payload["substanceCode"] ?? normalizeDrugText(String(payload["substance"] ?? ""))]))
  const pendingAllergies = new Set(pendingNow.filter((item) => item.kind === "alergia").map((item) => allergyKey(item.payload)))
  const doneKey = (payload: Record<string, unknown>) => JSON.stringify([payload["planItemId"] ?? payload["serviceId"] ?? normalizeForSearch(String(payload["service"] ?? "")), placeOf(payload)])
  const pendingDone = new Set(pendingNow.filter((item) => item.kind === "procedimiento").map((item) => doneKey(item.payload)))
  // Un material pendiente se corrige («no, fueron cuatro»), no se vuelve a proponer.
  // Por el producto y por cómo se dijo: el que no se encontró y se vuelve a decir ya encontrado es el mismo.
  const materialKeys = (payload: Record<string, unknown>) => [
    ...(typeof payload["productId"] === "string" ? [payload["productId"]] : []),
    `dicho:${normalizeForSearch(String(payload["product"] ?? ""))}`,
  ]
  const pendingMaterials = new Set(pendingNow.filter((item) => item.kind === "material").flatMap((item) => materialKeys(item.payload)))
  let allergiesTouched = removed.length > 0 || corrected.length > 0
  let pendingBudget = pendingNow.some((item) => item.kind === "presupuesto")
  const alreadyOnFile: string[] = []
  for (const { draft, prepared } of preparedDrafts) {
    const ready = await withPatient(tx, orgId, patientId, encounterId, draft.kind, prepared, checks, scope)
    // Una sola elección por presupuesto (decisión 3): la siguiente de este mismo tramo también espera.
    if (isPlanChoice(draft.kind, ready.payload)) checks.choiceBlocked ??= CHOICE_ALREADY_HERE
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
    if (draft.kind === "alergia") {
      // Ya está en sus alergias: no se propone otra vez, se avisa.
      if (ready.payload["known"] === true) {
        if (!alreadyOnFile.includes(allergyName(ready.payload))) alreadyOnFile.push(allergyName(ready.payload))
        continue
      }
      const key = allergyKey(ready.payload)
      if (pendingAllergies.has(key)) continue
      pendingAllergies.add(key)
      if (typeof ready.payload["substance"] === "string") checks.dictatedAllergies.push(dictatedAllergy(ready.payload))
      allergiesTouched = true
    }
    if (draft.kind === "procedimiento") {
      const key = doneKey(ready.payload)
      if (pendingDone.has(key)) continue
      pendingDone.add(key)
    }
    if (draft.kind === "material") {
      const keys = materialKeys(ready.payload)
      if (keys.some((key) => pendingMaterials.has(key))) continue
      for (const key of keys) pendingMaterials.add(key)
    }
    // Pedir otra vez el presupuesto no es otro presupuesto: el que espera se pone al día al terminar el tramo.
    if (draft.kind === "presupuesto") {
      if (pendingBudget) continue
      pendingBudget = true
    }
    if (draft.kind === "diagnostico") {
      const key = diagnosisKey(ready.payload)
      if (pendingDiagnoses.has(key)) continue
      pendingDiagnoses.add(key)
    }
    if (draft.kind === "plan") {
      const entry = planEntry(null, ready.payload)
      const same = pendingPlans.filter((item) => item.names.some((name) => entry.names.includes(name)))
      // Ya está (o está con más precisión, o es un camino de una elección): no se registra otra vez.
      // Una elección nueva solo se repite si es la misma elección; si no, es otra decisión y se ve.
      const repeated = entry.choice
        ? same.some((item) => item.choice && covers(item.place, entry.place) && entry.names.every((name) => item.names.includes(name)))
        : same.some((item) => covers(item.place, entry.place))
      if (repeated) continue
      // Lo nuevo solo agrega lo que le faltaba a una pendiente («la corona es en la 25»): se corrige esa.
      if (!entry.choice) {
        const vaguer = same.find((item) => item.id && !item.choice && covers(entry.place, item.place))
        if (vaguer?.id && (await correct(vaguer.id, siteOf(entry.place)))) {
          vaguer.place = entry.place
          continue
        }
      }
      pendingPlans.push(entry)
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
  // Una alergia nueva, corregida o quitada cambia el aviso de las recetas que ya esperaban.
  if (allergiesTouched) await refreshRecipes(tx, orgId, patientId, encounterId, scope)
  // Lo indicado en este tramo también va al presupuesto pedido.
  await refreshBudgetPreview(tx, orgId, patientId, encounterId, scope)
  if (inserted.length + corrected.length + removed.length + undoRequested.length > 0) {
    await tx.insert(auditEvent).values({
      organizationId: orgId,
      actorUserId,
      action: "encounter.dictation_suggested",
      entity: "encounter",
      entityId: encounterId,
      // Sin texto clínico en la auditoría: cuántas y de qué clase.
      metadata: { patientId, count: inserted.length, kinds: [...new Set(inserted.map((row) => row.kind))], corrected: corrected.length, removed: removed.length, undoRequested: undoRequested.length },
    })
  }
  const zone = await findOrgLocale(tx, orgId)
  return { suggestions: inserted.map((row) => toItem(row, zone, dictation)), corrected, removed, undoRequested, alreadyOnFile, repeated: false }
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
  const ready = await withPatient(tx, orgId, patientId, encounterId, row.kind, revised, await patientChecks(tx, orgId, patientId, encounterId, row.id), scope)
  // Editada a mano, ya no es «corregida por voz»: no queda nada que deshacer.
  const [updated] = await tx
    .update(encounterDictationSuggestion)
    .set({ payload: withMeta(ready.payload, { ...meta, voice: undefined }), status: ready.status, note: ready.note, updatedAt: new Date() })
    .where(eq(encounterDictationSuggestion.id, id))
    .returning()
  if (!updated) throw new Error("No se pudo actualizar la sugerencia")
  if (row.kind === "alergia") await refreshRecipes(tx, orgId, patientId, encounterId, scope)
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
    if (restored.kind === "alergia") await refreshRecipes(tx, orgId, patientId, encounterId, await dictationScope(tx, orgId))
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
  if (updated.kind === "alergia") await refreshRecipes(tx, orgId, patientId, encounterId, await dictationScope(tx, orgId))
  return toItem(updated, await findOrgLocale(tx, orgId), dictation)
}

/**
 * Lo confirmado hoy que el asistente puede proponer quitar: una indicación sin
 * caminos, un diagnóstico, un control, una alergia, lo que se hizo hoy o un
 * material. Una elección de caminos ya armó el presupuesto con sus opciones, y
 * un hallazgo o la receta se corrigen donde quedaron: esos no se proponen. «No
 * tiene alergias» no dejó nada que quitar.
 */
const UNDOABLE_KINDS: DictationKind[] = ["plan", "diagnostico", "control", "alergia", "procedimiento", "material"]

/** Ya confirmadas en esta atención que se pueden proponer quitar, en el orden en que se dictaron. */
export async function listConfirmedDictation(tx: Db, orgId: string, patientId: string, encounterId: string): Promise<DictationSuggestion[]> {
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
        eq(encounterDictationSuggestion.status, "confirmada"),
        inArray(encounterDictationSuggestion.kind, UNDOABLE_KINDS),
      ),
    )
    .orderBy(asc(encounterDictationSuggestion.createdAt), asc(encounterDictationSuggestion.id))
  const zone = await findOrgLocale(tx, orgId)
  return rows
    .filter((row) => row.entityId && !Array.isArray(splitMeta(row.payload).data["options"]))
    .map((row) => toItem(row, zone, dictation))
}

/**
 * Las piezas nombradas en lo dictado de esta atención (pendiente o confirmado),
 * para ofrecer con un toque la que le falta a una indicación.
 */
export async function dictationTeeth(tx: Db, orgId: string, patientId: string, encounterId: string): Promise<number[]> {
  const rows = await tx
    .select({ payload: encounterDictationSuggestion.payload })
    .from(encounterDictationSuggestion)
    .where(
      and(
        eq(encounterDictationSuggestion.organizationId, orgId),
        eq(encounterDictationSuggestion.patientId, patientId),
        eq(encounterDictationSuggestion.encounterId, encounterId),
        inArray(encounterDictationSuggestion.status, ["lista", "por_revisar", "confirmada"]),
      ),
    )
  const teeth = new Set<number>()
  for (const row of rows) {
    const tooth = (row.payload as Record<string, unknown>)["toothNumber"]
    if (typeof tooth === "number") teeth.add(tooth)
  }
  return [...teeth].sort((a, b) => a - b)
}

async function lockUndoRequest(tx: Db, orgId: string, patientId: string, encounterId: string, id: string) {
  const [row] = await tx
    .select()
    .from(encounterDictationSuggestion)
    .where(
      and(
        eq(encounterDictationSuggestion.organizationId, orgId),
        eq(encounterDictationSuggestion.patientId, patientId),
        eq(encounterDictationSuggestion.encounterId, encounterId),
        eq(encounterDictationSuggestion.id, id),
        eq(encounterDictationSuggestion.status, "confirmada"),
      ),
    )
    .for("update")
    .limit(1)
  const parts = row ? splitMeta(row.payload) : null
  if (!row || !parts?.meta.undoRequest) throw conflict("NO_UNDO_REQUEST", "No hay un pedido de quitar esto")
  return { row, ...parts, undoRequest: parts.meta.undoRequest }
}

/**
 * «Quitar del plan» (o el diagnóstico, o el control) de lo que se pidió quitar
 * en voz alta y ya estaba confirmado. Lo hace la operación de siempre, con el
 * motivo de lo que dijo: el tratamiento se cancela (y sale del presupuesto en
 * borrador), el diagnóstico se anula y el control se cancela. Un tratamiento que
 * ya está en un presupuesto enviado no se toca desde aquí.
 */
export async function undoConfirmedDictation(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  id: string,
): Promise<DictationSuggestion> {
  await lockOwnDraft(tx, orgId, actorUserId, patientId, encounterId)
  const dictation = await requireDictatingProduct(tx, orgId)
  const { row, data, meta, undoRequest } = await lockUndoRequest(tx, orgId, patientId, encounterId, id)
  const reason = `Se quitó al dictar: «${undoRequest.said}»`.slice(0, 2000)
  const entityId = String(row.entityId)
  if (row.kind === "plan") {
    const [item] = await tx
      .select({ budgetId: treatmentPlanItem.budgetId, status: treatmentBudget.status })
      .from(treatmentPlanItem)
      .leftJoin(treatmentBudget, eq(treatmentBudget.id, treatmentPlanItem.budgetId))
      .where(and(eq(treatmentPlanItem.organizationId, orgId), eq(treatmentPlanItem.id, entityId)))
      .limit(1)
    if (item?.budgetId && item.status !== "borrador") {
      throw conflict("PLAN_ITEM_IN_SENT_BUDGET", "Ya está en un presupuesto enviado: cámbialo desde el plan")
    }
    if (item?.budgetId) await removeBudgetItems(tx, orgId, actorUserId, patientId, item.budgetId, { itemIds: [entityId] })
    await setPlanItemStatus(tx, orgId, actorUserId, patientId, entityId, { status: "cancelado", statusReason: reason, encounterId })
  } else if (row.kind === "diagnostico") {
    await voidEncounterDiagnosis(tx, orgId, actorUserId, patientId, encounterId, entityId, { reason })
  } else if (row.kind === "control") {
    await cancelFollowUp(tx, orgId, actorUserId, patientId, entityId, { reason })
  } else if (row.kind === "alergia") {
    // Quitar una alergia pide su motivo de la lista: dictada y quitada en la misma atención, fue un error.
    await removePatientAllergy(tx, orgId, actorUserId, patientId, entityId, "error")
  } else if (row.kind === "procedimiento") {
    await voidEncounterProcedure(tx, orgId, actorUserId, patientId, encounterId, entityId, { reason })
  } else if (row.kind === "material") {
    // Todavía no salió de la sede (sale al firmar): quitarlo es dejar de contarlo.
  } else {
    throw conflict("NOT_UNDOABLE", "Esto se corrige donde quedó, no desde el dictado")
  }
  const [updated] = await tx
    .update(encounterDictationSuggestion)
    .set({ payload: withMeta(data, { ...meta, undoRequest: undefined }), status: "descartada", decidedBy: actorUserId, decidedAt: new Date(), updatedAt: new Date() })
    .where(eq(encounterDictationSuggestion.id, id))
    .returning()
  if (!updated) throw new Error("No se pudo quitar")
  return toItem(updated, await findOrgLocale(tx, orgId), dictation)
}

/** «Dejarla»: el pedido de quitar algo ya confirmado se descarta y todo sigue como estaba. */
export async function keepConfirmedDictation(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  id: string,
): Promise<DictationSuggestion> {
  await lockOwnDraft(tx, orgId, actorUserId, patientId, encounterId)
  const dictation = await requireDictatingProduct(tx, orgId)
  const { data, meta } = await lockUndoRequest(tx, orgId, patientId, encounterId, id)
  const [updated] = await tx
    .update(encounterDictationSuggestion)
    .set({ payload: withMeta(data, { ...meta, undoRequest: undefined }), updatedAt: new Date() })
    .where(eq(encounterDictationSuggestion.id, id))
    .returning()
  if (!updated) throw new Error("No se pudo dejar")
  return toItem(updated, await findOrgLocale(tx, orgId), dictation)
}

/**
 * Las recetas pendientes vuelven a mirar las alergias: las registradas y las
 * dictadas hoy. Una alergia dictada que se descarta deja de avisar; una que se
 * confirma avisa como registrada.
 */
async function refreshRecipes(tx: Db, orgId: string, patientId: string, encounterId: string, scope: DictationScope): Promise<void> {
  const rows = await pendingRowsOf(tx, orgId, patientId, encounterId, "receta")
  if (!rows.length) return
  const checks = await patientChecks(tx, orgId, patientId, encounterId)
  for (const row of rows) {
    const { data, meta } = splitMeta(row.payload)
    const ready = checkAgainstPatient("receta", prepareMedication(data, scope.medications), checks, scope.medications, scope.dictation)
    if (ready.status === row.status && ready.note === row.note) continue
    await tx
      .update(encounterDictationSuggestion)
      .set({ payload: withMeta(ready.payload, meta), status: ready.status, note: ready.note, updatedAt: new Date() })
      .where(eq(encounterDictationSuggestion.id, row.id))
  }
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
  // Emitir una receta es firmarla: tiene su propio botón (decisión 4 de la fase 2). El descanso médico también.
  if (row.kind === "receta") throw conflict("PRESCRIPTION_NEEDS_ISSUE", "Una receta dictada se emite con «Emitir receta»")
  if (row.kind === "descanso") throw conflict("MEDICAL_LEAVE_NEEDS_ISSUE", "Un descanso médico dictado se emite con «Emitir descanso»")
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
  } else if (row.kind === "alergia") {
    if (payload["none"] === true) {
      // «Niega alergias» responde la revisión, como «Sin cambios» o «No tiene alergias».
      await markAllergiesReviewed(tx, orgId, actorUserId, patientId)
    } else {
      const created = await addPatientAllergy(tx, orgId, actorUserId, patientId, {
        substance: String(payload["substance"]),
        substanceSystem: (payload["substanceSystem"] as string | undefined) ?? null,
        substanceCode: (payload["substanceCode"] as string | undefined) ?? null,
        severity: (payload["severity"] as string | undefined) ?? null,
        reaction: (payload["reaction"] as string | undefined) ?? null,
      })
      entityId = created.id
    }
  } else if (row.kind === "procedimiento") {
    entityId = await confirmDone(tx, orgId, actorUserId, patientId, encounterId, payload)
  } else if (row.kind === "material") {
    // Confirmado queda como el total de ese producto en la atención: sale de la sede al
    // firmar, en lugar de lo que traían sus servicios (`encounterMaterialPlan`).
    entityId = String(payload["productId"])
  } else if (row.kind === "cita") {
    const booked = await confirmAppointment(tx, orgId, actorUserId, patientId, encounterId, row, payload)
    if (typeof booked !== "string") return toItem(booked, await findOrgLocale(tx, orgId), dictation)
    entityId = booked
  } else if (row.kind === "presupuesto") {
    entityId = await confirmBudget(tx, orgId, actorUserId, patientId, encounterId, row.id)
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
  if (row.kind === "alergia") await refreshRecipes(tx, orgId, patientId, encounterId, await dictationScope(tx, orgId))
  if (row.kind === "plan") await refreshBudgetPreview(tx, orgId, patientId, encounterId, await dictationScope(tx, orgId))
  return toItem(updated, await findOrgLocale(tx, orgId), dictation)
}

/**
 * Reserva la cita con la operación de «Nueva cita» (`createAppointment`): con
 * quien lleva la atención, en su sede, y con el aviso a la persona como cuando
 * reserva recepción. Antes se mira que el hueco siga libre: si se ocupó
 * mientras atendía, la sugerencia queda con el más cercano y sin reservar, para
 * confirmarla de nuevo. Si ya tenía una cita cerca, no se reserva otra.
 */
async function confirmAppointment(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  suggestion: typeof encounterDictationSuggestion.$inferSelect,
  payload: Record<string, unknown>,
): Promise<string | typeof encounterDictationSuggestion.$inferSelect> {
  const existing = payload["existing"] as { id: string } | undefined
  if (existing?.id) return existing.id
  const again = await settleAppointment(tx, orgId, patientId, encounterId, { payload, status: "lista", note: null }, await patientChecks(tx, orgId, patientId, encounterId, suggestion.id))
  if (again.status !== "lista" || again.payload["startsAt"] !== payload["startsAt"] || again.payload["existing"]) {
    const [row] = await tx
      .update(encounterDictationSuggestion)
      .set({ payload: withMeta(again.payload, splitMeta(suggestion.payload).meta), status: again.status, note: again.note, updatedAt: new Date() })
      .where(eq(encounterDictationSuggestion.id, suggestion.id))
      .returning()
    if (!row) throw new Error("No se pudo actualizar la cita")
    return row
  }
  const created = await createAppointment(tx, orgId, actorUserId, {
    patientId,
    professionalUserId: actorUserId,
    branchId: String(payload["branchId"]),
    startsAt: String(payload["startsAt"]),
    ...(typeof payload["durationMin"] === "number" ? { durationMin: payload["durationMin"] } : {}),
    ...(typeof payload["serviceId"] === "string" ? { serviceId: payload["serviceId"] } : {}),
    reason: String(payload["serviceName"] ?? payload["service"] ?? "Próxima cita").slice(0, 200),
    ...(Array.isArray(payload["planItemIds"]) && payload["planItemIds"].length ? { planItemIds: payload["planItemIds"] as string[] } : {}),
  })
  return created.id
}

/**
 * «Arma el presupuesto» ahora: lo dictado que espera entra al plan como al
 * confirmarlo, y lo indicado en la atención va al borrador con la misma regla
 * que al firmar (`assembleEncounterBudget`, también donde es opcional). No
 * envía nada.
 */
async function confirmBudget(tx: Db, orgId: string, actorUserId: string, patientId: string, encounterId: string, suggestionId: string): Promise<string> {
  for (const item of await listDictationSuggestions(tx, orgId, patientId, encounterId)) {
    if (item.kind === "plan" && item.status === "lista" && item.id !== suggestionId) await confirmDictationSuggestion(tx, orgId, actorUserId, patientId, encounterId, item.id)
  }
  const assembled = await assembleEncounterBudget(tx, orgId, actorUserId, patientId, encounterId, { onRequest: true })
  const id = assembled?.id ?? (await findDraftBudget(tx, orgId, patientId))?.id
  if (!id) throw conflict("NOTHING_TO_QUOTE", NOTHING_TO_QUOTE)
  return id
}

/**
 * Lo que se hizo hoy entra como «Registrar procedimiento»: del tratamiento del
 * plan, de un servicio o como acto libre. Un tratamiento que aún esperaba
 * respuesta queda aceptado al hacerlo (`acceptWhenDone`): el paciente lo aceptó
 * al hacérselo.
 */
async function confirmDone(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const site = {
    toothNumber: (payload["toothNumber"] as number | undefined) ?? null,
    surfaces: (payload["surfaces"] as string[] | undefined) ?? null,
  }
  const planItemId = typeof payload["planItemId"] === "string" ? payload["planItemId"] : null
  if (planItemId) {
    return (await addEncounterProcedure(tx, orgId, actorUserId, patientId, encounterId, { planItemId, ...site, acceptWhenDone: payload["acceptOnDo"] === true })).id
  }
  const quantity = typeof payload["quantity"] === "number" ? payload["quantity"] : null
  if (typeof payload["serviceId"] === "string") {
    return (await addEncounterProcedure(tx, orgId, actorUserId, patientId, encounterId, { serviceId: payload["serviceId"], ...site, quantity })).id
  }
  return (await addEncounterProcedure(tx, orgId, actorUserId, patientId, encounterId, { description: String(payload["service"] ?? ""), ...site, quantity })).id
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
  const dictation = await requireDictatingProduct(tx, orgId)
  const services = await activeServices(tx, orgId)
  const site = choiceSite(payload)
  const detail = (payload["detail"] as string | undefined) ?? null
  // Cada camino toma de lo dicho solo lo que su prestación lleva: la corona, la pieza; la resina, también las caras.
  const indicate = (serviceId: string) => {
    const scope = services.find((service) => service.id === serviceId)?.scope ?? null
    const own = dictation.fitToScope(site, scope).payload
    return addPlanItem(tx, orgId, actorUserId, patientId, {
      serviceId,
      planId: null,
      sourceEncounterId: encounterId,
      toothNumber: (own["toothNumber"] as number | undefined) ?? null,
      surfaces: (own["surfaces"] as string[] | undefined) ?? null,
      detail,
    })
  }
  const main = await indicate(String(payload["serviceId"]))
  const others = []
  for (const option of payload["options"] as PlanChoice[]) others.push(await indicate(String(option.serviceId)))
  const tooth = typeof site["toothNumber"] === "number" ? ` para la ${site["toothNumber"]}` : ""
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

/**
 * El descanso dictado se emitió con el formulario de siempre, ya lleno con los
 * días dictados: ahí quien atiende firma y la persona decide si su diagnóstico
 * figura. Su sugerencia queda confirmada con ese descanso, que tiene que ser de
 * esta atención.
 */
export async function settleDictationMedicalLeave(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  medicalLeaveId: string,
): Promise<{ settled: number }> {
  await lockOwnDraft(tx, orgId, actorUserId, patientId, encounterId)
  const [issued] = await tx
    .select({ id: medicalLeave.id })
    .from(medicalLeave)
    .where(and(eq(medicalLeave.organizationId, orgId), eq(medicalLeave.patientId, patientId), eq(medicalLeave.encounterId, encounterId), eq(medicalLeave.id, medicalLeaveId)))
    .limit(1)
  if (!issued) throw notFound("Descanso médico")
  const rows = await pendingRowsOf(tx, orgId, patientId, encounterId, "descanso")
  await settleRows(tx, actorUserId, rows.map((row) => row.id), issued.id)
  return { settled: rows.length }
}

async function pendingPrescriptionRows(tx: Db, orgId: string, patientId: string, encounterId: string) {
  return pendingRowsOf(tx, orgId, patientId, encounterId, "receta")
}

/** Las sugerencias de una clase que esperan en esta atención, bloqueadas para decidirlas. */
async function pendingRowsOf(tx: Db, orgId: string, patientId: string, encounterId: string, kind: DictationKind) {
  return tx
    .select()
    .from(encounterDictationSuggestion)
    .where(
      and(
        eq(encounterDictationSuggestion.organizationId, orgId),
        eq(encounterDictationSuggestion.patientId, patientId),
        eq(encounterDictationSuggestion.encounterId, encounterId),
        eq(encounterDictationSuggestion.kind, kind),
        inArray(encounterDictationSuggestion.status, ["lista", "por_revisar"]),
      ),
    )
    .orderBy(asc(encounterDictationSuggestion.createdAt), asc(encounterDictationSuggestion.id))
    .for("update")
}

async function settleRows(tx: Db, actorUserId: string, ids: string[], entityId: string) {
  if (!ids.length) return
  await tx
    .update(encounterDictationSuggestion)
    .set({ status: "confirmada", entityId, decidedBy: actorUserId, decidedAt: new Date(), updatedAt: new Date() })
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
  const row = await lockSuggestion(tx, orgId, patientId, encounterId, id)
  await tx
    .update(encounterDictationSuggestion)
    .set({ status: "descartada", decidedBy: actorUserId, decidedAt: new Date(), updatedAt: new Date() })
    .where(eq(encounterDictationSuggestion.id, id))
  if (row.kind === "alergia") await refreshRecipes(tx, orgId, patientId, encounterId, await dictationScope(tx, orgId))
  if (row.kind === "plan") await refreshBudgetPreview(tx, orgId, patientId, encounterId, await dictationScope(tx, orgId))
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
export async function previewDictationSuggestions(tx: Db, orgId: string, drafts: DictationDraft[]): Promise<Array<Omit<DictationSuggestion, "id" | "createdAt" | "voice" | "removal" | "undoRequest">>> {
  const scope = await dictationScope(tx, orgId)
  const zone = await findOrgLocale(tx, orgId)
  const out: Array<Omit<DictationSuggestion, "id" | "createdAt" | "voice" | "removal" | "undoRequest">> = []
  for (const draft of drafts.slice(0, DICTATION_MAX_SUGGESTIONS)) {
    const ready = await prepare(tx, draft, scope)
    if (!ready) continue
    out.push({ kind: draft.kind, payload: ready.payload, sourceText: (draft.sourceText ?? "").slice(0, DICTATION_SOURCE_CHARS), status: ready.status, note: ready.note, summary: summarize(draft.kind, ready.payload, zone, scope.dictation) })
  }
  return out
}

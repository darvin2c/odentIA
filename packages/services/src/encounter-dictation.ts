import {
  DIAGNOSIS_SYSTEM_INFO,
  DIAGNOSIS_VERIFICATION_LABELS,
  type DiagnosisSystemKey,
  isDiagnosisVerification,
  isValidTooth,
  surfaceLabel,
  surfacesForTooth,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  DICTATION_KINDS,
  type DictationKind,
  encounterDictationSuggestion,
  serviceCatalog,
} from "@odentia/db/schema/clinical"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm"
import { getAgentConfig } from "./agentConfig.js"
import { findDiagnosisCode, orgDiagnosisSystem } from "./diagnosis-codes.js"
import { addEncounterDiagnosis } from "./encounter-diagnoses.js"
import { assertOpenDraft, lockEncounter, updateEncounterDraft, type UpdateEncounterDraftPatch } from "./encounters.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { createFollowUp } from "./follow-ups.js"
import { normalizeForSearch } from "./knowledge.js"
import { findOrgLocale, formatOrgMoney, type OrgLocale } from "./locale.js"
import { OPERATIONS, operationAgentSchema } from "./operation-fields.js"
import { addPlanItem } from "./plan.js"

/* ---------- Asistente clínico: lo dictado se vuelve sugerencias que el odontólogo confirma ---------- */

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
}

/** Operación de la atención que ejecuta cada clase de sugerencia al confirmarse. */
export const DICTATION_OPERATION = {
  nota: "atencion.nota",
  diagnostico: "atencion.diagnostico",
  plan: "plan.indicacion",
  control: "control.crear",
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
  createdAt: string
}

/**
 * Datos de la sugerencia que no son de su operación: de qué tramo del dictado
 * salió (para no ordenarlo dos veces) y cómo estaba antes de una corrección por
 * voz. Van dentro de `payload` bajo `_meta` y nunca salen de este módulo ni
 * llegan a la operación al confirmar.
 */
interface SuggestionMeta {
  segments?: string[]
  voice?: { payload: Record<string, unknown>; status: "lista" | "por_revisar"; note: string | null; before: string } | undefined
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

/** ¿El asistente clínico está encendido en esta clínica? */
export async function requireClinicalAssistant(tx: Db, orgId: string): Promise<void> {
  const cfg = await getAgentConfig(tx, orgId)
  if (!cfg.clinicalAssistantEnabled) {
    throw new ServiceError("CLINICAL_ASSISTANT_OFF", 409, "Clío está apagada en esta clínica")
  }
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
    .where(and(eq(serviceCatalog.organizationId, orgId), eq(serviceCatalog.isActive, true), ne(serviceCatalog.source, "legacy")))
    .orderBy(asc(serviceCatalog.name))
    .limit(500)
}

/** Lo que el asistente necesita saber de la clínica para entender un dictado: sus prestaciones. */
export async function getDictationCatalog(
  tx: Db,
  orgId: string,
): Promise<{ services: Array<{ name: string }>; diagnosisSystem: { key: DiagnosisSystemKey; title: string } }> {
  const system = await orgDiagnosisSystem(tx, orgId)
  return {
    services: (await activeServices(tx, orgId)).map((service) => ({ name: service.name })),
    diagnosisSystem: { key: system, title: DIAGNOSIS_SYSTEM_INFO[system].title },
  }
}

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

/** Pieza y caras de una sugerencia, ya en los valores del sistema; `invalid` si la pieza no existe. */
function normalizeSite(payload: Record<string, unknown>): { payload: Record<string, unknown>; invalid: boolean } {
  const { toothNumber, surfaces, ...rest } = payload
  if (toothNumber === undefined || toothNumber === null) return { payload: rest, invalid: false }
  if (typeof toothNumber !== "number" || !isValidTooth(toothNumber)) return { payload: { ...rest, toothNumber }, invalid: true }
  const faces = normalizeSurfaces(toothNumber, surfaces)
  return { payload: { ...rest, toothNumber, ...(faces.length ? { surfaces: faces } : {}) }, invalid: false }
}

/** Formato y zona de la clínica con los que se escribe el resumen de una sugerencia. */
type Zone = Pick<OrgLocale, "locale" | "timezone">

function site(payload: Record<string, unknown>): string {
  const tooth = typeof payload["toothNumber"] === "number" ? `Pieza ${payload["toothNumber"]}` : ""
  const surfaces =
    Array.isArray(payload["surfaces"]) && payload["surfaces"].length
      ? `cara ${(payload["surfaces"] as string[]).map((surface) => surfaceLabel(surface).toLowerCase()).join(", ")}`
      : ""
  return [tooth, surfaces].filter(Boolean).join(" · ")
}

const NOTE_LABEL = Object.fromEntries(Object.entries(OPERATIONS["atencion.nota"].fields).map(([key, field]) => [key, field.label]))

function summarize(kind: DictationKind, payload: Record<string, unknown>, zone: Zone): string {
  if (kind === "nota") {
    return Object.entries(payload)
      .filter(([, value]) => typeof value === "string" && value.trim())
      .map(([key, value]) => `${NOTE_LABEL[key] ?? key}: ${String(value)}`)
      .join("\n")
  }
  if (kind === "diagnostico") {
    const type = isDiagnosisVerification(payload["diagnosisType"]) ? DIAGNOSIS_VERIFICATION_LABELS[payload["diagnosisType"]] : ""
    return [`${payload["diagnosisCode"] ?? ""}${payload["description"] ? ` · ${payload["description"]}` : ""}`, [site(payload), type].filter(Boolean).join(" · ")]
      .filter(Boolean)
      .join("\n")
  }
  if (kind === "plan") {
    // La tarifa lleva la moneda del tarifario; sin moneda no se inventa una: no se escribe el importe.
    const price =
      typeof payload["priceCents"] === "number" && typeof payload["currency"] === "string"
        ? formatOrgMoney(payload["priceCents"], payload["currency"], zone)
        : ""
    return [`${payload["serviceName"] ?? payload["service"] ?? ""}${price ? ` · ${price}` : ""}`, site(payload), payload["detail"]].filter(Boolean).join("\n")
  }
  const due = typeof payload["dueAt"] === "string" ? new Date(payload["dueAt"]).toLocaleDateString(zone.locale, { timeZone: zone.timezone, day: "numeric", month: "long", year: "numeric" }) : ""
  return [String(payload["title"] ?? "Control"), due ? `Alrededor del ${due}` : "", payload["instructions"]].filter(Boolean).join("\n")
}

function toItem(row: typeof encounterDictationSuggestion.$inferSelect, zone: Zone): DictationSuggestion {
  const { data, meta } = splitMeta(row.payload)
  return {
    id: row.id,
    kind: row.kind,
    payload: data,
    sourceText: row.sourceText,
    status: row.status as DictationSuggestion["status"],
    note: row.note,
    summary: summarize(row.kind, data, zone),
    voice: meta.voice ? { before: meta.voice.before } : null,
    createdAt: row.createdAt.toISOString(),
  }
}

/**
 * Cómo se le nombra una sugerencia pendiente al asistente cuando el odontólogo
 * sigue dictando, para que entienda «no, es la veintiséis» o «quita la
 * endodoncia». Solo lo que salió del propio dictado: sin tarifas.
 */
export function dictationModelLabel(item: Pick<DictationSuggestion, "kind" | "payload">): string {
  const payload = item.payload
  const what =
    item.kind === "nota"
      ? Object.keys(payload).map((key) => NOTE_LABEL[key] ?? key).join(", ")
      : item.kind === "diagnostico"
        ? [`${payload["diagnosisCode"] ?? ""}${payload["description"] ? ` ${payload["description"]}` : ""}`, site(payload)].filter(Boolean).join(", ")
        : item.kind === "plan"
          ? [String(payload["serviceName"] ?? payload["service"] ?? ""), site(payload)].filter(Boolean).join(", ")
          : String(payload["title"] ?? "Control")
  return `${DICTATION_KIND_LABEL[item.kind]}: ${what}`
}

/**
 * Deja una sugerencia lista o por revisar. Se valida con el mismo esquema que
 * usa el asistente para llenarla; lo que no encaja o le falta algo que solo
 * una persona puede elegir queda `por_revisar` con el motivo, nunca se pierde.
 */
async function prepare(
  tx: Db,
  draft: DictationDraft,
  services: ServiceOption[],
  diagnosisSystem: DiagnosisSystemKey,
): Promise<{ payload: Record<string, unknown>; status: "lista" | "por_revisar"; note: string | null } | null> {
  if (!(DICTATION_KINDS as readonly string[]).includes(draft.kind)) return null
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
  if (draft.kind === "diagnostico" || draft.kind === "plan") {
    const site = normalizeSite(payload)
    if (site.invalid) return { payload: site.payload, status: "por_revisar", note: `La pieza ${String(payload["toothNumber"])} no existe en la numeración FDI. Corrígela.` }
    for (const key of ["toothNumber", "surfaces"]) delete payload[key]
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
    const spoken = String(payload["service"] ?? "")
    const { match, candidates } = matchService(spoken, services)
    if (match) return fitToScope({ ...payload, serviceId: match.id, serviceName: match.name, priceCents: match.priceCents, currency: match.currency, serviceScope: match.scope }, match.scope)
    return {
      payload: { ...payload, candidates },
      status: "por_revisar",
      note: candidates.length
        ? `Dijiste «${spoken}» y no coincide con una sola prestación de tus servicios. Elige cuál es.`
        : `Dijiste «${spoken}» y no está en tus servicios. Elige la prestación.`,
    }
  }
  return { payload, status: "lista", note: null }
}

/**
 * Ajusta una indicación al ámbito de su prestación: una general no lleva pieza
 * y una por pieza no lleva caras, aunque se hayan dictado. Si le falta lo que
 * su ámbito exige, queda por revisar en vez de fallar al confirmar.
 */
function fitToScope(payload: Record<string, unknown>, scope: string | null): { payload: Record<string, unknown>; status: "lista" | "por_revisar"; note: string | null } {
  const { toothNumber, surfaces, ...rest } = payload
  const hasTooth = typeof toothNumber === "number"
  const hasSurfaces = Array.isArray(surfaces) && surfaces.length > 0
  if (scope === "general") return { payload: rest, status: "lista", note: null }
  if (scope === "tooth") {
    return hasTooth
      ? { payload: { ...rest, toothNumber }, status: "lista", note: null }
      : { payload: rest, status: "por_revisar", note: "Esta prestación se indica por pieza y no dijiste cuál. Agrega la pieza." }
  }
  if (scope === "surfaces") {
    return hasTooth && hasSurfaces
      ? { payload: { ...rest, toothNumber, surfaces }, status: "lista", note: null }
      : { payload: { ...rest, ...(hasTooth ? { toothNumber } : {}) }, status: "por_revisar", note: "Esta prestación necesita la pieza y al menos una cara. Complétala." }
  }
  return { payload: rest, status: "por_revisar", note: "Esta prestación se indica por cuadrante o arcada: agrégala desde el plan de tratamiento." }
}

async function lockOwnDraft(tx: Db, orgId: string, actorUserId: string, patientId: string, encounterId: string) {
  const locked = await lockEncounter(tx, orgId, patientId, encounterId)
  assertOpenDraft(locked, actorUserId)
  return locked
}

type Prepared = { payload: Record<string, unknown>; status: "lista" | "por_revisar"; note: string | null }

/**
 * Aplica un cambio a una sugerencia —a mano o dicho en voz alta— y la vuelve a
 * validar como al crearla. `null`: quedó vacía.
 */
async function revise(
  tx: Db,
  kind: DictationKind,
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
  services: ServiceOption[],
  diagnosisSystem: DiagnosisSystemKey,
): Promise<Prepared | null> {
  // Un campo que llega vacío se quita de la sugerencia: el odontólogo lo borró.
  let payload: Record<string, unknown> = Object.fromEntries(
    Object.entries({ ...current, ...patch }).filter(([, value]) => value !== null && value !== ""),
  )
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
    const fitted = normalizeSite(payload)
    return fitted.invalid
      ? { payload: fitted.payload, status: "por_revisar", note: `La pieza ${String(payload["toothNumber"])} no existe en la numeración FDI. Corrígela.` }
      : fitToScope(fitted.payload, chosenService.scope)
  }
  return prepare(tx, { kind, payload }, services, diagnosisSystem)
}

const FIELD_LABEL = Object.fromEntries(
  DICTATION_KINDS.map((kind) => [
    kind,
    Object.fromEntries(Object.entries(OPERATIONS[DICTATION_OPERATION[kind]].fields).map(([key, field]) => [key, field.label])),
  ]),
) as Record<DictationKind, Record<string, string>>

/** Qué decía la sugerencia antes de una corrección por voz, en pocas palabras. `null`: no cambió nada. */
function describeBefore(kind: DictationKind, before: Record<string, unknown>, after: Record<string, unknown>, keys: string[]): string | null {
  const parts: string[] = []
  for (const key of keys) {
    if (JSON.stringify(before[key] ?? null) === JSON.stringify(after[key] ?? null)) continue
    const old = before[key]
    if (key === "toothNumber") parts.push(typeof old === "number" ? `pieza ${old}` : "sin pieza")
    else if (key === "surfaces") parts.push(Array.isArray(old) && old.length ? `cara ${(old as string[]).map((surface) => surfaceLabel(surface).toLowerCase()).join(", ")}` : "sin caras")
    else if (key === "service") parts.push(String(before["serviceName"] ?? old ?? "otra prestación"))
    else if (key === "diagnosisCode" || key === "title") parts.push(String(old ?? "sin dato"))
    else if (key === "diagnosisType") parts.push(isDiagnosisVerification(old) ? DIAGNOSIS_VERIFICATION_LABELS[old].toLowerCase() : "sin tipo")
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
  /** Sugerencias que el odontólogo pidió quitar en voz alta. */
  removals?: string[]
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
  await requireClinicalAssistant(tx, orgId)
  // El bloqueo de la atención ordena dos envíos del mismo tramo: el segundo ya lo ve guardado.
  await lockOwnDraft(tx, orgId, actorUserId, patientId, encounterId)
  const segmentId = segment.segmentId
  if (segmentId && (await dictationSegmentSeen(tx, orgId, patientId, encounterId, segmentId))) {
    return { suggestions: [], corrected: [], removed: [], repeated: true }
  }
  const stamp = (meta: SuggestionMeta): SuggestionMeta => (segmentId ? { ...meta, segments: [...(meta.segments ?? []), segmentId] } : meta)
  const services = await activeServices(tx, orgId)
  const diagnosisSystem = await orgDiagnosisSystem(tx, orgId)
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
    const ready = await revise(tx, row.kind, data, patch, services, diagnosisSystem)
    if (!ready) continue
    const before = describeBefore(row.kind, data, ready.payload, Object.keys(patch))
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
  for (const id of (segment.removals ?? []).slice(0, DICTATION_MAX_SUGGESTIONS)) {
    const row = await pendingRow(id)
    if (!row) continue
    const { data, meta } = splitMeta(row.payload)
    await tx
      .update(encounterDictationSuggestion)
      .set({ payload: withMeta(data, stamp(meta)), status: "descartada", decidedBy: actorUserId, decidedAt: new Date(), updatedAt: new Date() })
      .where(eq(encounterDictationSuggestion.id, row.id))
    removed.push(row.id)
  }

  const rows: Array<typeof encounterDictationSuggestion.$inferInsert> = []
  for (const draft of segment.drafts.slice(0, DICTATION_MAX_SUGGESTIONS)) {
    const ready = await prepare(tx, draft, services, diagnosisSystem)
    if (!ready) continue
    rows.push({
      organizationId: orgId,
      patientId,
      encounterId,
      dentistUserId: actorUserId,
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
  return { suggestions: inserted.map((row) => toItem(row, zone)), corrected, removed, repeated: false }
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
  return rows.map((row) => toItem(row, zone))
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
  const services = await activeServices(tx, orgId)
  const diagnosisSystem = await orgDiagnosisSystem(tx, orgId)
  const { data, meta } = splitMeta(row.payload)
  const ready = await revise(tx, row.kind, data, patch, services, diagnosisSystem)
  if (!ready) throw validation("La sugerencia quedó vacía; descártala si no aplica")
  // Editada a mano, ya no es «corregida por voz»: no queda nada que deshacer.
  const [updated] = await tx
    .update(encounterDictationSuggestion)
    .set({ payload: withMeta(ready.payload, { ...meta, voice: undefined }), status: ready.status, note: ready.note, updatedAt: new Date() })
    .where(eq(encounterDictationSuggestion.id, id))
    .returning()
  if (!updated) throw new Error("No se pudo actualizar la sugerencia")
  return toItem(updated, await findOrgLocale(tx, orgId))
}

/** Deshace una corrección dicha en voz alta: la sugerencia vuelve a como estaba antes de ella. */
export async function undoDictationVoiceCorrection(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  id: string,
): Promise<DictationSuggestion> {
  await lockOwnDraft(tx, orgId, actorUserId, patientId, encounterId)
  const row = await lockSuggestion(tx, orgId, patientId, encounterId, id)
  const { meta } = splitMeta(row.payload)
  if (!meta.voice) throw conflict("NO_VOICE_CORRECTION", "Esta sugerencia no tiene una corrección por voz que deshacer")
  const [updated] = await tx
    .update(encounterDictationSuggestion)
    .set({ payload: withMeta(meta.voice.payload, { ...meta, voice: undefined }), status: meta.voice.status, note: meta.voice.note, updatedAt: new Date() })
    .where(eq(encounterDictationSuggestion.id, id))
    .returning()
  if (!updated) throw new Error("No se pudo deshacer la corrección")
  return toItem(updated, await findOrgLocale(tx, orgId))
}

/** Plan donde entra una indicación dictada: el de esta atención, el más reciente del paciente o uno nuevo. */
const pick = <T extends string>(payload: Record<string, unknown>, keys: readonly T[]): Partial<Record<T, unknown>> =>
  Object.fromEntries(keys.filter((key) => payload[key] !== undefined).map((key) => [key, payload[key]])) as Partial<Record<T, unknown>>

/**
 * Confirmar es lo único que lleva una sugerencia a la historia, y lo hace con
 * la operación de siempre: la misma validación, el mismo permiso y la misma
 * auditoría que si el odontólogo lo hubiera escrito. Si la operación rechaza
 * el dato, la sugerencia sigue ahí para corregirla.
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
  const row = await lockSuggestion(tx, orgId, patientId, encounterId, id)
  if (row.status === "por_revisar") throw conflict("SUGGESTION_NEEDS_REVIEW", row.note ?? "Revisa la sugerencia antes de confirmarla")
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
  return toItem(updated, await findOrgLocale(tx, orgId))
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
export async function previewDictationSuggestions(tx: Db, orgId: string, drafts: DictationDraft[]): Promise<Array<Omit<DictationSuggestion, "id" | "createdAt" | "voice">>> {
  const services = await activeServices(tx, orgId)
  const diagnosisSystem = await orgDiagnosisSystem(tx, orgId)
  const zone = await findOrgLocale(tx, orgId)
  const out: Array<Omit<DictationSuggestion, "id" | "createdAt" | "voice">> = []
  for (const draft of drafts.slice(0, DICTATION_MAX_SUGGESTIONS)) {
    const ready = await prepare(tx, draft, services, diagnosisSystem)
    if (!ready) continue
    out.push({ kind: draft.kind, payload: ready.payload, sourceText: (draft.sourceText ?? "").slice(0, DICTATION_SOURCE_CHARS), status: ready.status, note: ready.note, summary: summarize(draft.kind, ready.payload, zone) })
  }
  return out
}

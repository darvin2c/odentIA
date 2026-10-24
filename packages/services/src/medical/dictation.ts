import {
  formatVitals,
  parseVitals,
  VITAL_SIGNS,
  type VitalSignKey,
  type Vitals,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { encounter } from "@odentia/db/schema/clinical"
import {
  EXAM_STATE_LABELS,
  EXAM_SYSTEMS,
  type ExamState,
  type ExamSystemKey,
  MEDICAL_VITAL_KEYS,
  readSystemsExam,
} from "@odentia/medical"
import { and, eq } from "drizzle-orm"
import { updateEncounterDraft } from "../encounters.js"
import { ServiceError } from "../errors.js"
import { normalizeForSearch } from "../knowledge.js"
import type { DictationPrepared, ProductDictation } from "../product-hooks.js"

/*
 * ---------- Lo que Clío dicta de latidIA: los signos vitales, el examen por sistemas y el descanso ----------
 *
 * Issue 229, entrega 10 (decisión 20). Sin «dónde»: la parte del cuerpo se
 * escribe en el hallazgo o en el diagnóstico (decisión 4). Lo que no se dicta
 * del examen queda «No examinado» (decisión 5): confirmar un sistema no toca
 * los demás. El descanso médico se emite firmado, como la receta: tiene su
 * propio botón, y la persona decide si su diagnóstico figura.
 */

/** Los sistemas como se le dan al asistente: clave y nombre. Va en la parte fija del prompt. */
export function examSystemsText(): string {
  return EXAM_SYSTEMS.map((system) => `${system.key} (${system.label})`).join("\n")
}

/** El sistema dictado: por su clave o, si el asistente escribió el nombre, por su nombre. */
function examSystemOf(spoken: string): (typeof EXAM_SYSTEMS)[number] | undefined {
  const wanted = normalizeForSearch(spoken)
  return EXAM_SYSTEMS.find(
    (system) => system.key === spoken.trim() || normalizeForSearch(system.label) === wanted,
  )
}

const isVital = (key: string): key is VitalSignKey => VITAL_SIGNS.some((sign) => sign.key === key)

const days = (count: unknown) => `${String(count)} ${count === 1 ? "día" : "días"}`

/** «24 de octubre»: el día que empieza el descanso, sin la hora ni la zona (es una fecha). */
function dayWords(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("es", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  })
}

const isDay = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))

/** Las medidas dictadas, juntas como las valida la atención (la presión va completa). */
function prepareVitals(payload: Record<string, unknown>): DictationPrepared {
  const values = Object.fromEntries(Object.entries(payload).filter(([key]) => isVital(key)))
  const parsed = parseVitals(values, MEDICAL_VITAL_KEYS)
  if (!parsed.ok)
    return {
      payload: values,
      status: "por_revisar",
      note: `${parsed.error}. Corrígelo o dilo de nuevo.`,
    }
  if (!parsed.value)
    return {
      payload: values,
      status: "por_revisar",
      note: "No entendí ninguna medida. Dila de nuevo o escríbela.",
    }
  return { payload: parsed.value, status: "lista", note: null }
}

/**
 * Un sistema del examen. Normal es «Sin alteraciones», sin texto; con hallazgos
 * tiene que decir cuáles: si no, queda por revisar.
 */
function prepareExam(payload: Record<string, unknown>): DictationPrepared {
  const spoken = String(payload["system"] ?? "")
  const system = examSystemOf(spoken)
  if (!system) {
    return {
      payload,
      status: "por_revisar",
      note: `No reconozco «${spoken}» como un sistema del examen. Regístralo en el examen físico.`,
    }
  }
  const state: ExamState =
    payload["state"] === "con_hallazgos" ? "con_hallazgos" : "sin_alteraciones"
  const finding = typeof payload["finding"] === "string" ? payload["finding"].trim() : ""
  if (state === "sin_alteraciones")
    return { payload: { system: system.key, state }, status: "lista", note: null }
  if (!finding)
    return {
      payload: { system: system.key, state },
      status: "por_revisar",
      note: "Dijiste que hay hallazgos, pero no cuáles. Escríbelos.",
    }
  return { payload: { system: system.key, state, finding }, status: "lista", note: null }
}

/** El descanso dictado: los días y, si se dijo, desde cuándo; el resto se elige al emitirlo. */
function prepareLeave(payload: Record<string, unknown>): DictationPrepared {
  const { startsOn, ...rest } = payload
  if (startsOn !== undefined && !isDay(startsOn)) {
    return {
      payload: rest,
      status: "por_revisar",
      note: "No entendí desde qué día va el descanso. Elígelo al emitirlo.",
    }
  }
  return { payload: { ...rest, ...(startsOn ? { startsOn } : {}) }, status: "lista", note: null }
}

function examLine(payload: Record<string, unknown>): string {
  const system = EXAM_SYSTEMS.find((item) => item.key === payload["system"])
  const state = payload["state"] === "con_hallazgos" ? "con_hallazgos" : "sin_alteraciones"
  return `${system?.label ?? String(payload["system"] ?? "")} · ${EXAM_STATE_LABELS[state].toLowerCase()}`
}

function leaveLine(payload: Record<string, unknown>): string {
  return `${days(payload["days"])} ${isDay(payload["startsOn"]) ? `desde el ${dayWords(payload["startsOn"])}` : "desde hoy"}`
}

/** La atención en borrador, para sumarle lo dictado sin pisar lo que ya tiene. */
async function draftOf(tx: Db, orgId: string, patientId: string, encounterId: string) {
  const [row] = await tx
    .select({ vitals: encounter.vitals, examination: encounter.examination })
    .from(encounter)
    .where(
      and(
        eq(encounter.organizationId, orgId),
        eq(encounter.patientId, patientId),
        eq(encounter.id, encounterId),
      ),
    )
    .limit(1)
  return row
}

export const MEDICAL_DICTATION: ProductDictation = {
  kinds: ["signos", "examen", "descanso"],
  catalogText: examSystemsText,
  context: async () => null,
  // Sin «dónde» (decisión 4): una pieza o una cara que llegue se quita, no se adivina.
  normalizeSite: ({ toothNumber: _tooth, surfaces: _surfaces, ...rest }) => ({
    payload: rest,
    invalid: null,
  }),
  siteWords: () => "",
  fitToScope: ({ toothNumber: _tooth, surfaces: _surfaces, ...rest }) => ({
    payload: rest,
    status: "lista",
    note: null,
  }),
  async prepare(_tx, kind, payload) {
    if (kind === "signos") return prepareVitals(payload)
    if (kind === "examen") return prepareExam(payload)
    return prepareLeave(payload)
  },
  summarize(kind, payload) {
    if (kind === "signos") return formatVitals(payload as Vitals)
    if (kind === "examen")
      return [examLine(payload), typeof payload["finding"] === "string" ? payload["finding"] : ""]
        .filter(Boolean)
        .join("\n")
    return leaveLine(payload)
  },
  modelLabel(kind, payload) {
    if (kind === "signos") return formatVitals(payload as Vitals)
    if (kind === "examen") return examLine(payload)
    return leaveLine(payload)
  },
  describeField(key, before) {
    const old = before[key]
    if (key === "presionSistolica" || key === "presionDiastolica") {
      return typeof before["presionSistolica"] === "number" &&
        typeof before["presionDiastolica"] === "number"
        ? formatVitals({
            presionSistolica: before["presionSistolica"],
            presionDiastolica: before["presionDiastolica"],
          })
        : "sin presión"
    }
    if (isVital(key)) {
      const sign = VITAL_SIGNS.find((item) => item.key === key)
      return typeof old === "number"
        ? formatVitals({ [key]: old }) || `${sign?.label ?? key} ${old}`
        : `sin ${(sign?.label ?? key).toLowerCase()}`
    }
    if (key === "system")
      return EXAM_SYSTEMS.find((item) => item.key === old)?.label ?? "otro sistema"
    if (key === "state")
      return old === "con_hallazgos" || old === "sin_alteraciones"
        ? EXAM_STATE_LABELS[old].toLowerCase()
        : "sin estado"
    if (key === "days") return typeof old === "number" ? days(old) : "sin días"
    if (key === "startsOn") return isDay(old) ? `desde el ${dayWords(old)}` : "desde hoy"
    return null
  },
  // Un sistema que ya tiene una sugerencia pendiente no se repite, y un solo descanso por atención.
  sameKey: (kind, payload) =>
    kind === "examen" ? String(payload["system"] ?? "") : kind === "descanso" ? "descanso" : null,
  async confirm(tx, { orgId, actorUserId, patientId, encounterId }, kind, payload) {
    // Emitir el descanso es firmarlo: tiene su propio botón, como la receta.
    if (kind === "descanso")
      throw new ServiceError(
        "MEDICAL_LEAVE_NEEDS_ISSUE",
        409,
        "Un descanso médico dictado se emite con «Emitir descanso»",
      )
    const current = await draftOf(tx, orgId, patientId, encounterId)
    if (kind === "signos") {
      // Lo dictado se suma a lo que ya tenía la atención: una medida nueva reemplaza solo la suya.
      const vitals = { ...((current?.vitals as Record<string, unknown> | null) ?? {}), ...payload }
      await updateEncounterDraft(tx, orgId, actorUserId, patientId, encounterId, { vitals })
      return null
    }
    // Un sistema a la vez: lo demás del examen queda como estaba.
    const exam = readSystemsExam(current?.examination)
    const system = String(payload["system"]) as ExamSystemKey
    const finding = typeof payload["finding"] === "string" ? payload["finding"] : undefined
    const entry =
      payload["state"] === "con_hallazgos" && finding
        ? { estado: "con_hallazgos" as const, hallazgo: finding }
        : { estado: "sin_alteraciones" as const }
    await updateEncounterDraft(tx, orgId, actorUserId, patientId, encounterId, {
      examination: { sistemas: { ...(exam?.sistemas ?? {}), [system]: entry } },
    })
    return null
  },
}

import {
  CIGARETTE_BAND_LABELS,
  type HealthDeclarant,
  INTERVIEW_ANSWER_LABELS,
  normalizeDrugText,
  registrationAnswersSchema,
  whoWords,
} from "@odentia/clinical"
import { z } from "zod"
import { OPERATIONS, operationAgentSchema } from "./operation-fields.js"
import type { DictationPrepared } from "./product-hooks.js"

/*
 * ---------- Lo de salud dicho en la conversación (mesa del 20 nov 2026, «Clío en una consulta conversada») ----------
 *
 * Clío no tenía dónde poner lo que el paciente, o quien lo acompaña, cuenta de su salud: la
 * warfarina y la metformina caían en el relato, el asma de un niño se perdía y «no que yo sepa» se
 * volvía «No tiene alergias». Lo que dijo tiene la forma de su registro
 * (`registrationAnswersSchema.shape.health`), la misma que entra a Antecedentes desde su enlace;
 * quién lo dijo lo declara la operación `salud.dicha`. Es una sola sugerencia por atención, que se
 * suma pausa a pausa como la consulta, y nunca entra de un toque: se revisa con la persona.
 */

/** La forma de lo que una persona declara de su salud, grupo por grupo (su registro). */
export const DECLARED_HEALTH_SHAPE = registrationAnswersSchema.shape.health.unwrap().shape
const HEALTH = DECLARED_HEALTH_SHAPE

/** Los grupos que Clío puede proponer, en el orden de la tarjeta. */
const GROUPS = ["anticoagulants", "boneMedicines", "medications", "conditions", "allergies", "personal", "medical", "dental"] as const
type HealthGroup = (typeof GROUPS)[number]
/** Los grupos que son una lista de lo que dijo (enfermedades, medicinas). */
const LISTS: readonly HealthGroup[] = ["conditions", "medications"]
/** Los grupos de una sola respuesta, con cuál: un anticoagulante, una medicina para los huesos. */
const DIRECTED: readonly HealthGroup[] = ["anticoagulants", "boneMedicines"]
/** Los grupos de la entrevista, campo por campo. */
const INTERVIEW: readonly HealthGroup[] = ["personal", "medical", "dental"]

/**
 * Lo común de los dos productos, más lo de cada uno (`ProductDictation.health`; odentIA: su boca,
 * la lactancia y el tabaco; latidIA: también el alcohol). Las alergias que se dicen van en su
 * propia parte (`alergia.dictada`): aquí solo el «no sabe», que esa parte no puede decir.
 */
export function dictationHealthSchema(own: z.ZodRawShape) {
  return operationAgentSchema("salud.dicha").extend({
    allergies: z
      .strictObject({ state: HEALTH.allergies.unwrap().shape.state })
      .optional()
      .describe("Solo si no sabe si tiene alergias («no que yo sepa», «creo que no», «no sé»): `unknown`. Las alergias que dijo, o que no tiene, van en `alergias`."),
    conditions: HEALTH.conditions.describe(
      "Sus enfermedades («presión alta», «asma», «diabetes»): `recorded` con cada una en `items`, en sus palabras. `none` solo si respondió que no tiene ninguna; `unknown` si no sabe. Omítelo si no se habló de eso.",
    ),
    medications: HEALTH.medications.describe(
      "Lo que toma todos los días que no es anticoagulante ni para los huesos («losartán», «metformina», «inhalador de salbutamol»), con la dosis y cuándo solo si los dijo. `none` solo si respondió que no toma nada; `unknown` si no sabe.",
    ),
    anticoagulants: HEALTH.anticoagulants.describe(
      "Si toma un anticoagulante o aspirina todos los días («warfarina», «apixabán», «Eliquis»): `recorded` con cuál en `detail`. `none` si respondió que no; `unknown` si no sabe.",
    ),
    boneMedicines: HEALTH.boneMedicines.describe(
      "Si toma o tomó una medicina para los huesos («alendronato», «denosumab»): `recorded` con cuál en `detail`, y si ya no la toma (`now`), solo si lo dijo.",
    ),
    personal: HEALTH.personal.describe(
      "Embarazo (`embarazo`; `semanasEmbarazo` solo si dijo las semanas), operaciones, hospitalizaciones y transfusiones, en sus palabras.",
    ),
    ...own,
  })
}

/** Quién lo dijo, como lo guarda la declaración (`HealthDeclarant`). Sin saberlo, lo anotó el equipo. */
export function healthDeclarantOf(payload: Record<string, unknown>): HealthDeclarant {
  const who = payload["declarante"]
  if (who === "paciente") return { kind: "patient", name: null, relation: null }
  if (who === "acompanante") {
    const relation = typeof payload["vinculo"] === "string" ? payload["vinculo"].trim().toLocaleLowerCase("es").slice(0, 80) : ""
    return { kind: "representative", name: null, relation: relation || null }
  }
  return { kind: "staff", name: null, relation: null }
}

/** «No que yo sepa», «creo que no», «no sé»: una respuesta con duda es «no sabe», nunca «no». */
const DOUBT = /\b(?:que yo sepa|creo que no|me parece que no|no s[eé]|no me acuerdo|no recuerdo|no estoy segur[oa]|a lo mejor|tal vez|quiz[aá]s?)\b/u

export function saidInDoubt(text: string | undefined): boolean {
  return !!text && DOUBT.test(text.toLocaleLowerCase("es"))
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const STATES = new Set(["none", "unknown", "recorded"])
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "")

/** Un grupo de lista (enfermedades, medicinas), con lo que dijo de cada una y sin lo vacío. */
function listGroup(group: HealthGroup, value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !STATES.has(String(value["state"]))) return undefined
  const state = String(value["state"])
  if (state !== "recorded") return { state, items: [] }
  const keys = group === "medications" ? ["name", "dose", "frequency", "notes"] : ["name", "notes"]
  const items = (Array.isArray(value["items"]) ? value["items"] : []).flatMap((item) => {
    if (!isRecord(item) || !text(item["name"])) return []
    return [Object.fromEntries(keys.flatMap((key) => (text(item[key]) ? [[key, text(item[key])]] : [])))]
  })
  // Un «Sí» a enfermedades sin decir cuál no se puede registrar; a la medicación, sí (no dijo cuál).
  if (!items.length && group !== "medications") return undefined
  return { state, items }
}

/** Un anticoagulante o una medicina para los huesos: cuál, solo con el Sí. */
function directedGroup(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !STATES.has(String(value["state"]))) return undefined
  const state = String(value["state"])
  if (state !== "recorded") return { state }
  return Object.fromEntries(
    Object.entries({ state, detail: text(value["detail"]) || undefined, now: value["now"], reason: value["reason"], form: value["form"] }).filter(([, item]) => item !== undefined && item !== ""),
  )
}

/** Un grupo de la entrevista: solo los campos que su forma acepta, cada uno como lo acepta. */
function interviewGroup(schema: z.ZodType, value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  const object = (schema instanceof z.ZodOptional ? schema.unwrap() : schema) as z.ZodObject
  const kept: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const field = object.shape?.[key] as z.ZodType | undefined
    if (!field || item === undefined || item === null || item === "") continue
    const parsed = field.safeParse(typeof item === "string" ? item.trim() : item)
    if (parsed.success && parsed.data !== undefined) kept[key] = parsed.data
  }
  if (!Object.keys(kept).length) return undefined
  const whole = object.safeParse(kept)
  if (whole.success) return whole.data as Record<string, unknown>
  // Lo que choca con otra respuesta (cuántos fuma sin «fuma») no se adivina: se quita eso solo.
  const { cigarrillos: _cigarrettes, ...rest } = kept
  const again = object.safeParse(rest)
  return again.success && Object.keys(rest).length ? (again.data as Record<string, unknown>) : undefined
}

/**
 * Con duda en lo que dijo («creo que no», «que yo sepa no»), ningún «no» queda como «no»: el de un
 * grupo es «no sabe», el de la entrevista con «No sabe» también, y uno que no puede decir «no sabe»
 * (la lactancia, un sí o no) no se propone. El silencio tampoco es «no»: lo que no se dijo no está.
 */
function withoutDoubtfulNo(group: HealthGroup, value: Record<string, unknown>): Record<string, unknown> | undefined {
  if (LISTS.includes(group) || DIRECTED.includes(group) || group === "allergies") return value["state"] === "none" ? { ...value, state: "unknown" } : value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === false || item === "nunca" || item === "ninguna") continue
    if (item === "no") {
      if (["pastaConFluor"].includes(key)) out[key] = "no_sabe"
      continue
    }
    if (isRecord(item)) {
      const inner = Object.fromEntries(Object.entries(item).map(([name, answer]) => [name, answer === "no" ? "no_sabe" : answer]))
      out[key] = inner
      continue
    }
    out[key] = item
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * Lo que dijo de su salud, listo para guardarse como sugerencia: quién lo dijo y, grupo por grupo,
 * lo que acepta su registro en este producto (`own`). Lo que no es de su salud (un peso que alguien
 * calcula, lo de un familiar) no tiene dónde ir y no se guarda. `null`: no dijo nada de su salud.
 */
export function prepareHealth(payload: Record<string, unknown>, said: string | undefined, own: z.ZodRawShape): DictationPrepared | null {
  const shape = dictationHealthSchema(own).shape as Record<string, z.ZodType>
  const declarante = ["paciente", "acompanante", "no_se_sabe"].includes(String(payload["declarante"])) ? String(payload["declarante"]) : "no_se_sabe"
  const vinculo = declarante === "acompanante" ? text(payload["vinculo"]).slice(0, OPERATIONS["salud.dicha"].fields.vinculo.max) : ""
  const doubt = saidInDoubt(said)
  const health: Record<string, unknown> = {}
  for (const group of GROUPS) {
    if (!(group in shape) || payload[group] === undefined) continue
    let value =
      group === "allergies"
        ? isRecord(payload[group]) && payload[group]["state"] === "unknown"
          ? { state: "unknown", items: [] }
          : undefined
        : LISTS.includes(group)
          ? listGroup(group, payload[group])
          : DIRECTED.includes(group)
            ? directedGroup(payload[group])
            : interviewGroup(shape[group] as z.ZodType, payload[group])
    if (value && doubt) value = withoutDoubtfulNo(group, value)
    if (value) health[group] = value
  }
  // Lo que su registro no acepta tal cual no se guarda a medias: ese grupo se deja fuera.
  for (const group of Object.keys(health)) {
    const check = (HEALTH as Record<string, z.ZodType>)[group]?.safeParse(health[group])
    if (!check?.success) delete health[group]
  }
  if (!Object.keys(health).length) return null
  return { payload: { declarante, ...(vinculo ? { vinculo } : {}), ...health }, status: "lista", note: null }
}

/** Lo de su salud que la sugerencia propone, sin quién lo dijo: la forma de su registro. */
export function healthOfPayload(payload: Record<string, unknown>): NonNullable<z.infer<typeof registrationAnswersSchema>["health"]> {
  const health = Object.fromEntries(GROUPS.flatMap((group) => (payload[group] === undefined ? [] : [[group, payload[group]]])))
  return registrationAnswersSchema.shape.health.unwrap().parse(health)
}

const sameName = (a: unknown, b: unknown) => normalizeDrugText(text(a)) === normalizeDrugText(text(b))

/**
 * Lo nuevo de su salud sumado a lo que ya estaba pendiente, como la consulta: lo que no trae no se
 * toca; una enfermedad o una medicina más se suma sin repetir; una respuesta de un solo valor (el
 * anticoagulante, el embarazo) dicha distinto queda con la última y guarda la anterior en
 * `earlier` («antes dijo warfarina»), y un «no» o un «no sé» después no borra lo que sí dijo. Con
 * `correct` (alguien corrigió en voz alta lo ya dicho) el grupo que trae reemplaza al que había.
 */
export function mergeHealth(
  current: Record<string, unknown>,
  added: Record<string, unknown>,
  correct = false,
): { payload: Record<string, unknown>; earlier: Record<string, string> } {
  const payload = { ...current }
  const earlier: Record<string, string> = {}
  const known = (who: unknown) => who === "paciente" || who === "acompanante"
  if (added["declarante"] !== undefined && (correct || (!known(current["declarante"]) && known(added["declarante"])))) {
    payload["declarante"] = added["declarante"]
    if (added["vinculo"] !== undefined) payload["vinculo"] = added["vinculo"]
    else delete payload["vinculo"]
  }
  for (const group of GROUPS) {
    const now = added[group]
    if (!isRecord(now)) continue
    const before = current[group]
    if (!isRecord(before) || JSON.stringify(before) === JSON.stringify(now)) {
      payload[group] = now
      continue
    }
    const was = groupWords(group, before)
    if (correct) {
      payload[group] = now
      if (was !== groupWords(group, now)) earlier[group] = was
      continue
    }
    if (LISTS.includes(group)) {
      if (now["state"] === "recorded") {
        const items = [...((before["state"] === "recorded" ? before["items"] : []) as Array<Record<string, unknown>>)]
        for (const item of (now["items"] ?? []) as Array<Record<string, unknown>>) {
          const index = items.findIndex((one) => sameName(one["name"], item["name"]))
          if (index < 0) items.push(item)
          else items[index] = { ...items[index], ...item }
        }
        payload[group] = { state: "recorded", items }
      } else if (before["state"] !== "recorded") payload[group] = now
      continue
    }
    if (DIRECTED.includes(group) || group === "allergies") {
      if (before["state"] === "recorded" && now["state"] !== "recorded") continue
      payload[group] = now
      if (was !== groupWords(group, now)) earlier[group] = was
      continue
    }
    // La entrevista, campo por campo: lo de una sola respuesta dicho distinto queda con lo último.
    const merged: Record<string, unknown> = { ...before }
    for (const [key, value] of Object.entries(now)) {
      const old = before[key]
      if (old === undefined || JSON.stringify(old) === JSON.stringify(value)) {
        merged[key] = value
        continue
      }
      if (Array.isArray(old) && Array.isArray(value)) {
        merged[key] = [...old, ...value.filter((item) => !old.some((one) => sameName(one, item)))]
        continue
      }
      merged[key] = value
      earlier[`${group}.${key}`] = fieldWords(group, key, old)
    }
    payload[group] = merged
  }
  return { payload, earlier }
}

/* ---------- En palabras: la tarjeta, la franja y lo que lee Clío ---------- */

const GROUP_LABEL: Record<HealthGroup, string> = {
  anticoagulants: "Anticoagulante",
  boneMedicines: "Para los huesos",
  medications: "Medicación",
  conditions: "Enfermedades",
  allergies: "Alergias",
  personal: "Antecedentes",
  medical: "Hábitos",
  dental: "Su boca",
}

/** Cómo se dice cada campo de la entrevista. */
const FIELD_LABEL: Record<string, string> = {
  "personal.embarazo": "Embarazo",
  "personal.cirugias": "Operaciones",
  "personal.hospitalizaciones": "Hospitalizaciones",
  "personal.transfusiones": "Transfusiones",
  "medical.lactancia": "Lactancia",
  "medical.tabaco": "Fuma",
  "medical.alcohol": "Alcohol",
  "dental.problemaAnestesia": "Anestesia del dentista",
  "dental.corazon": "Corazón",
  "dental.ansiedadDental": "Miedo al dentista",
  "dental.bruxismo": "Rechina o aprieta los dientes",
  "dental.habitos": "Hábitos",
  "dental.ultimaVisita": "Última visita al dentista",
  "dental.experienciaPrevia": "Cómo le fue antes",
  "dental.cepilladosAlDia": "Cepillados al día",
  "dental.hiloDental": "Hilo dental",
  "dental.biberon": "Biberón o pecho para dormir",
  "dental.chupon": "Chupón o dedo",
  "dental.dulcesEntreComidas": "Dulces o jugos entre comidas",
  "dental.pastaConFluor": "Pasta con flúor",
  "dental.quienCepilla": "Quién le cepilla",
}

/** Las respuestas de una lista, como se dicen. */
const VALUE_WORDS: Record<string, string> = {
  nunca: "no fuma",
  fuma: "sí",
  dejo: "lo dejó",
  ocasional: "de vez en cuando",
  frecuente: "con frecuencia",
  ninguna: "ninguno",
  ya_no: "ya no",
  chupon: "chupón",
  dedo: "se chupa el dedo",
  casi_nunca: "casi nunca",
  "1_a_3": "1 a 3 al día",
  "4_o_mas": "4 o más al día",
  solo: "solo, sin ayuda",
  adulto: "un adulto",
  ambos: "los dos",
  si: "sí",
  no_sabe: "no sabe",
}

const valueWords = (value: unknown): string =>
  value === true
    ? "sí"
    : value === false
      ? "no"
      : Array.isArray(value)
        ? value.map(valueWords).join(", ")
        : typeof value === "number"
          ? String(value)
          : (VALUE_WORDS[String(value)] ?? (String(value) in INTERVIEW_ANSWER_LABELS ? INTERVIEW_ANSWER_LABELS[String(value) as "no"].toLocaleLowerCase("es") : String(value)))

/** Lo que dice un campo de la entrevista, en pocas palabras. */
function fieldWords(group: string, key: string, value: unknown): string {
  if (group === "dental" && key === "corazon" && isRecord(value)) {
    return [
      value["riesgoEndocarditis"] ? `válvula o endocarditis: ${valueWords(value["riesgoEndocarditis"])}` : "",
      value["antibioticoPrevio"] ? `antibiótico antes: ${valueWords(value["antibioticoPrevio"])}` : "",
    ]
      .filter(Boolean)
      .join(" · ")
  }
  if (group === "dental" && key === "problemaAnestesia") {
    if (!isRecord(value)) return valueWords(value)
    return [
      value["anestesia"] ? `problemas: ${valueWords(value["anestesia"])}${value["quePaso"] ? ` (${value["quePaso"] === "desmayo" ? "se desmayó o le bajó la presión" : value["quePaso"] === "alergia" ? "alergia o ronchas" : "otra cosa"})` : ""}` : "",
      value["sangrado"] ? `sangró mucho tras una extracción: ${valueWords(value["sangrado"])}` : "",
    ]
      .filter(Boolean)
      .join(" · ")
  }
  return valueWords(value)
}

/** Lo que dice un grupo, en pocas palabras: «apixabán», «dijo que no», «no sabe». */
function groupWords(group: HealthGroup, value: Record<string, unknown>): string {
  if (value["state"] === "none") return "dijo que no"
  if (value["state"] === "unknown") return "no sabe"
  if (LISTS.includes(group)) {
    const items = (value["items"] ?? []) as Array<Record<string, unknown>>
    return items.length ? items.map((item) => [item["name"], item["dose"], item["frequency"]].filter(Boolean).join(" ")).join(" · ") : "sí, no dijo cuál"
  }
  if (DIRECTED.includes(group)) return [text(value["detail"]) || "sí, no dijo cuál", value["now"] === false ? "ya no la toma" : ""].filter(Boolean).join(", ")
  return ""
}

/** Cada dato que propone, en palabras, con la clave de su grupo o de su campo («antes dijo» va con la misma clave). */
export function healthRows(payload: Record<string, unknown>): Array<{ key: string; label: string; value: string }> {
  const rows: Array<{ key: string; label: string; value: string }> = []
  for (const group of GROUPS) {
    const value = payload[group]
    if (!isRecord(value)) continue
    if (!INTERVIEW.includes(group)) {
      rows.push({ key: group, label: GROUP_LABEL[group], value: groupWords(group, value) })
      continue
    }
    for (const [key, item] of Object.entries(value)) {
      if (key === "semanasEmbarazo" || key === "cigarrillos") continue
      let words = fieldWords(group, key, item)
      if (group === "personal" && key === "embarazo" && item === true && typeof value["semanasEmbarazo"] === "number") words = `sí, ${value["semanasEmbarazo"]} semanas`
      if (group === "medical" && key === "tabaco" && item === "fuma" && typeof value["cigarrillos"] === "string")
        words = `sí, ${CIGARETTE_BAND_LABELS[value["cigarrillos"] as keyof typeof CIGARETTE_BAND_LABELS] ?? value["cigarrillos"]}`
      rows.push({ key: `${group}.${key}`, label: FIELD_LABEL[`${group}.${key}`] ?? key, value: words })
    }
  }
  return rows
}

/** Quién lo dijo, en pocas palabras: «el paciente», «su madre», «no se sabe». */
function declarantWords(payload: Record<string, unknown>): string {
  if (payload["declarante"] === "paciente") return "Lo dijo: el paciente"
  if (payload["declarante"] === "acompanante") return `Lo dijo: ${whoWords(healthDeclarantOf(payload), null)}`
  return "No se sabe quién lo dijo"
}

/** La tarjeta: cada dato con lo que dijo antes, si lo dijo distinto, y quién lo dijo. */
export function healthSummary(payload: Record<string, unknown>, earlier: Record<string, string> = {}): string {
  const lines = healthRows(payload).map((row) => {
    const before = earlier[row.key]
    return `${row.label}: ${row.value}${before && before !== row.value ? ` (antes dijo «${before}»)` : ""}`
  })
  return [...lines, declarantWords(payload)].join("\n")
}

/** Cómo se le nombra a Clío la salud pendiente: con lo que ya dice, para que sume sin repetir. */
export function healthModelLabel(payload: Record<string, unknown>): string {
  const rows = healthRows(payload).map((row) => `${row.label.toLocaleLowerCase("es")}: «${row.value}»`)
  return ["Salud", ...rows, declarantWords(payload).toLocaleLowerCase("es")].join(" · ")
}

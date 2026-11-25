import {
  CIGARETTE_BAND_LABELS,
  findHabitualMedication,
  HABITUAL_MEDICATIONS,
  type HealthDeclarant,
  INTERVIEW_ANSWER_LABELS,
  kinSaid,
  medicationClassOf,
  normalizeDrugText,
  registrationAnswersSchema,
  whoWords,
} from "@odentia/clinical"
import { z } from "zod"

// Lo usan también los turnos del repaso (`@odentia/agent`), que no dependen de `@odentia/clinical`.
export { kinSaid } from "@odentia/clinical"
import { groundHeard, heardVocabulary, plain } from "./dictation-heard.js"
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
export type HealthGroup = (typeof GROUPS)[number]
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
    const relation = kinSaid(payload["vinculo"]).toLocaleLowerCase("es").slice(0, 80)
    return { kind: "representative", name: null, relation: relation || null }
  }
  return { kind: "staff", name: null, relation: null }
}

/**
 * Quién dijo un dato de su salud (revisión del 21 nov, A4): el paciente, quien lo acompaña (con su
 * vínculo, si se dijo) o no se sabe. Lo dicho por dos personas en la misma consulta no queda a
 * nombre de la primera que habló: cada dato lleva el suyo en `quien`.
 */
export interface HealthSaidBy {
  declarante: "paciente" | "acompanante" | "no_se_sabe"
  vinculo?: string
}
const DECLARANTS = ["paciente", "acompanante", "no_se_sabe"] as const
/** Dónde guarda la propuesta quién dijo cada dato: su clave (`declarantKeys`) y quién. */
const QUIEN = "quien"

/** Quién lo dijo según la propuesta entera (o una entrada de Clío); `null` si no lo dice. */
function topSaidBy(payload: Record<string, unknown>): HealthSaidBy | null {
  const who = payload["declarante"]
  if (!DECLARANTS.includes(who as HealthSaidBy["declarante"])) return null
  const vinculo = who === "acompanante" ? kinSaid(payload["vinculo"]).slice(0, 80) : ""
  return { declarante: who as HealthSaidBy["declarante"], ...(vinculo ? { vinculo } : {}) }
}

/** Un campo de la entrevista que acompaña a otro (las semanas al embarazo, cuántos fuma al tabaco). */
const FIELD_OF: Record<string, string> = { semanasEmbarazo: "embarazo", cigarrillos: "tabaco" }

/**
 * Las claves con que se dice quién dijo cada dato de un grupo: el grupo entero; en una lista, cada
 * enfermedad o medicina por su nombre; en la entrevista, cada campo.
 */
function declarantKeys(group: HealthGroup, value: Record<string, unknown>): string[] {
  if (INTERVIEW.includes(group)) return [...new Set(Object.keys(value).map((key) => `${group}.${FIELD_OF[key] ?? key}`))]
  if (LISTS.includes(group) && value["state"] === "recorded") {
    const items = (Array.isArray(value["items"]) ? value["items"] : []) as Array<Record<string, unknown>>
    if (items.length) return items.map((item) => itemKey(group, item))
  }
  return [group]
}
const itemKey = (group: HealthGroup, item: Record<string, unknown>) => `${group}:${normalizeDrugText(text(item["name"]))}`

/** Lo que dice `quien` tal como está guardado, sin lo que no se puede leer. */
function storedSaidBy(payload: Record<string, unknown>): Record<string, HealthSaidBy> {
  const stored = payload[QUIEN]
  if (!isRecord(stored)) return {}
  return Object.fromEntries(Object.entries(stored).flatMap(([key, value]) => (isRecord(value) && topSaidBy(value) ? [[key, topSaidBy(value) as HealthSaidBy]] : [])))
}

/**
 * Quién dijo cada dato que trae: lo guardado en `quien` y, lo que no lo tiene, quien lo dijo según
 * la propuesta o la entrada (`declarante`). Sin ninguno de los dos, nada: no se supone.
 */
function explicitSaidBy(payload: Record<string, unknown>): Record<string, HealthSaidBy> {
  const top = topSaidBy(payload)
  const stored = storedSaidBy(payload)
  const out: Record<string, HealthSaidBy> = {}
  for (const group of GROUPS) {
    const value = payload[group]
    if (!isRecord(value)) continue
    for (const key of declarantKeys(group, value)) {
      const who = stored[key] ?? top
      if (who) out[key] = who
    }
  }
  return out
}

/** Quién dijo cada dato de la propuesta; lo que no se sabe, «no se sabe». */
export function healthSaidBy(payload: Record<string, unknown>): Record<string, HealthSaidBy> {
  const known = explicitSaidBy(payload)
  const out: Record<string, HealthSaidBy> = {}
  for (const group of GROUPS) {
    const value = payload[group]
    if (!isRecord(value)) continue
    for (const key of declarantKeys(group, value)) out[key] = known[key] ?? { declarante: "no_se_sabe" }
  }
  return out
}

const sameSaidBy = (a: HealthSaidBy | undefined, b: HealthSaidBy | undefined) =>
  a?.declarante === b?.declarante && (a?.vinculo ?? "").toLocaleLowerCase("es") === (b?.vinculo ?? "").toLocaleLowerCase("es")

/** `quien` con solo las claves de lo que la propuesta trae: lo que se quitó no deja su declarante. */
function withSaidBy(payload: Record<string, unknown>, by: Record<string, HealthSaidBy>): Record<string, unknown> {
  const { [QUIEN]: _old, ...rest } = payload
  const keys = GROUPS.flatMap((group) => (isRecord(rest[group]) ? declarantKeys(group, rest[group] as Record<string, unknown>) : []))
  const kept = Object.fromEntries(keys.flatMap((key) => (by[key] ? [[key, by[key]]] : [])))
  return Object.keys(kept).length ? { ...rest, [QUIEN]: kept } : rest
}

/**
 * «No que yo sepa», «creo que no», «no sé»: una respuesta con duda es «no sabe», nunca «no». Los
 * bordes son de letras Unicode: en JavaScript `\b` solo ve letras ASCII, y «no sé» o «quizá» (con
 * la tilde al final, como los escribe la voz de Chrome) no se reconocían (revisión del 21 nov).
 */
const DOUBT = /(?<![\p{L}\p{N}])(?:que yo sepa|creo que no|me parece que no|no s[eé]|no me acuerdo|no recuerdo|no estoy segur[oa]|a lo mejor|tal vez|quiz[aá]s?)(?![\p{L}\p{N}])/u

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
  const vinculo = declarante === "acompanante" ? kinSaid(payload["vinculo"]).slice(0, OPERATIONS["salud.dicha"].fields.vinculo.max) : ""
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
  // Quién dijo cada dato: lo que ya traía (una propuesta sumada) y, si no, quien lo dijo en la pausa.
  const by = healthSaidBy({ ...payload, declarante })
  return { payload: withSaidBy({ declarante, ...(vinculo ? { vinculo } : {}), ...health }, by), status: "lista", note: null }
}

/** Palabras de un nombre que no lo distinguen: «inhalador de salbutamol» se reconoce por «salbutamol». */
const NAME_FILLER = new Set(["de", "del", "la", "las", "los", "el", "en", "con", "para", "por", "una", "uno", "mg", "ml", "cada", "dia", "dias", "pastilla", "tableta"])

/** ¿Esa palabra del nombre está en lo dicho, tal cual, por su raíz o por cómo suena (`groundHeard`)? */
function wordHeard(word: string, said: string): boolean {
  const saidWords = plain(said).split(/[^a-z0-9ñ]+/).filter(Boolean)
  if (saidWords.includes(word)) return true
  if (word.length >= 5 && saidWords.some((one) => one.length >= 5 && one.slice(0, 5) === word.slice(0, 5))) return true
  return groundHeard(word, said, heardVocabulary([word])) !== ""
}

/** ¿El nombre sale de lo dicho? Basta una palabra que lo distinga («losartán 50 mg» de «tomo losartán»). */
function nameHeard(name: string, said: string): boolean {
  const words = plain(name)
    .split(/[^a-z0-9ñ]+/)
    .filter((word) => word.length >= 3 && !/^\d+$/.test(word) && !NAME_FILLER.has(word))
  return words.length === 0 || words.some((word) => wordHeard(word, said))
}

/**
 * Lo que no es el nombre de una medicina, aunque Clío lo ponga como tal (QA del 23 nov, verificador 2):
 * «algo para la tiroides», «unas pastillas para la presión», «no me acuerdo el nombre». Dice para qué
 * la toma, no cuál es: como medicina pisaba a la que sí nombró («salbutamol (antes dijo salbutamol)»).
 * El nombre que sigue sin artículo sí es una medicina («tabletas de losartán»).
 */
const VAGUE_MEDICINE =
  /^(?:algo|alguna cosa|(?:(?:una?|unas|unos) )?(?:pastillas?|medicinas?|medicamentos?|remedios?|tabletas?|capsulas?|jarabes?|gotas|inyecciones?)|no (?:se|sabe|recuerda|recuerdo|me acuerdo)\b.*)(?: (?:para|contra|por|de la|de las|del|de los) .*)?$/u

/**
 * Una enfermedad que no dice cuál es (QA del 23 nov, verificador 3: «algo en los huesos», «le
 * hicieron unos exámenes y salió algo»): no se propone como enfermedad; va a «No lo usé» con su frase.
 */
const VAGUE_CONDITION =
  /^(?:algo|alguna cosa|una cosa|un problema|unos problemas)(?: (?:en|de|del|de la|de los|con|raro|malo)\b.*)?$|\b(?:salio|le salio|me salio|salieron) algo\b|^no (?:se|sabe|recuerda|recuerdo|me acuerdo) (?:que|cual|como)\b/u

/** ¿Esa «enfermedad» no dice cuál es? (`VAGUE_CONDITION`) */
export const vagueCondition = (name: string) => VAGUE_CONDITION.test(plain(name).replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim())

/** ¿Ese «nombre» solo dice para qué la toma? (`VAGUE_MEDICINE`) */
export const vagueMedicine = (name: string) => VAGUE_MEDICINE.test(plain(name).replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim())

/**
 * Lo de su salud que sale de su frase (revisión del 21 nov, A5): una enfermedad, una medicina o un
 * anticoagulante cuyo nombre no está en lo que se dijo («apixabán» cuando dijo «warfarina») no se
 * propone; se dice en `notHeard`. Una medicina que no dice cuál es («algo para la tiroides») tampoco:
 * se dice en `unnamed`, y nunca reemplaza a otra. Una lista que se queda sin nada de lo que nombró se
 * quita entera; un anticoagulante sin su nombre queda «sí, no dijo cuál». `payload` nulo: no queda nada.
 */
export function groundHealthNames(
  payload: Record<string, unknown>,
  said: string,
): { payload: Record<string, unknown> | null; notHeard: string[]; unnamed: string[]; vague: string[] } {
  const out = { ...payload }
  const notHeard: string[] = []
  const unnamed: string[] = []
  const vague: string[] = []
  for (const group of LISTS) {
    const value = out[group]
    if (!isRecord(value) || value["state"] !== "recorded" || !Array.isArray(value["items"]) || !value["items"].length) continue
    const items = (value["items"] as Array<Record<string, unknown>>).filter((item) => {
      if (group === "medications" && vagueMedicine(text(item["name"]))) {
        unnamed.push(text(item["name"]))
        return false
      }
      if (group === "conditions" && vagueCondition(text(item["name"]))) {
        vague.push(text(item["name"]))
        return false
      }
      const heard = nameHeard(text(item["name"]), said)
      if (!heard) notHeard.push(text(item["name"]))
      return heard
    })
    if (items.length) out[group] = { ...value, items }
    else delete out[group]
  }
  for (const group of DIRECTED) {
    const value = out[group]
    if (!isRecord(value) || !text(value["detail"]) || nameHeard(text(value["detail"]), said)) continue
    notHeard.push(text(value["detail"]))
    const { detail: _invented, ...rest } = value
    out[group] = rest
  }
  return { payload: GROUPS.some((group) => isRecord(out[group])) ? out : null, notHeard, unnamed, vague }
}

/** Lo que «No lo usé» dice de una enfermedad que no dice cuál es (`groundHealthNames`, `vague`). */
export const vagueConditionWhy = (names: readonly string[]) =>
  `«${names.join("», «")}» no dice qué enfermedad es: no lo propuse. Pregunta cuál es o anótalo a mano.`

/** Lo que «No lo usé» dice de una medicina sin nombre (`groundHealthNames`, `unnamed`). */
export const unnamedMedicineWhy = (names: readonly string[]) =>
  `«${names.join("», «")}» no dice qué medicina es: no lo propuse. Pregunta cuál es o anótalo a mano.`

/** Cómo se corrige uno mismo a media frase: «warfarina, no, perdón, apixabán», «digo», «mejor dicho». */
const SELF_CORRECTION = / (?:perdon|digo|mejor dicho|me equivoque|corrijo|quise decir) /u

/**
 * Lo que dijo antes en la misma frase y corrigió ahí mismo («tomo warfarina no perdón ahora
 * apixabán»): Clío propone lo último y la tarjeta y la franja dicen «antes dijo warfarina» (QA del
 * 21 nov, C2). Solo un anticoagulante o una medicina para los huesos de la lista, de la misma clase
 * que el que quedó, nombrado antes de la corrección y distinto de él; si hay más de uno, ninguno.
 */
export function selfCorrectedHealth(payload: Record<string, unknown>, phrase: string): Record<string, string> {
  const said = ` ${plain(phrase).replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim()} `
  const marker = said.search(SELF_CORRECTION)
  if (marker < 0) return {}
  const before = `${said.slice(0, marker)} `
  const after = said.slice(marker)
  const named = (entry: (typeof HABITUAL_MEDICATIONS)[number], text: string) =>
    [entry.dci, ...(entry.names ?? [])].some((name) => text.includes(` ${plain(name)} `))
  const out: Record<string, string> = {}
  for (const group of DIRECTED) {
    const value = payload[group]
    const detail = isRecord(value) ? text(value["detail"]) : ""
    const chosen = detail ? findHabitualMedication(detail) : null
    if (!chosen || !named(chosen, after)) continue
    const kind = medicationClassOf(chosen.atc)
    const earlier = HABITUAL_MEDICATIONS.filter((entry) => entry.dci !== chosen.dci && medicationClassOf(entry.atc) === kind && named(entry, before))
    if (earlier.length === 1 && earlier[0]) out[group] = earlier[0].dci
  }
  return out
}

/** Una respuesta que niega: «no», «nunca», «ninguna», un «No» a un sí o no. */
const isDenial = (value: unknown) => value === false || value === "no" || value === "nunca" || value === "ninguna" || value === "ninguno"

/**
 * Lo que «Lo revisé con…» guarda y lo que no (revisión del 21 nov, A2): lo que nombró y lo que no
 * sabe se guardan; un «No» (a las enfermedades, a la medicación, a un anticoagulante, a un campo de
 * la entrevista) se confirma en su fila, nunca de paso con lo demás. `denied`: los «No», con quién
 * los dijo, para que sigan esperando su propia confirmación.
 */
export function splitHealthDenials(payload: Record<string, unknown>): { kept: Record<string, unknown>; denied: Record<string, unknown> } {
  const by = healthSaidBy(payload)
  const kept: Record<string, unknown> = {}
  const denied: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) if (!(GROUPS as readonly string[]).includes(key) && key !== QUIEN) kept[key] = denied[key] = value
  for (const group of GROUPS) {
    const value = payload[group]
    if (!isRecord(value)) continue
    if (!INTERVIEW.includes(group)) {
      ;(value["state"] === "none" ? denied : kept)[group] = value
      continue
    }
    const yes: Record<string, unknown> = {}
    const no: Record<string, unknown> = {}
    for (const [field, answer] of Object.entries(value)) {
      if (isRecord(answer)) {
        const inner = Object.entries(answer)
        const said = Object.fromEntries(inner.filter(([, one]) => !isDenial(one)))
        const nos = Object.fromEntries(inner.filter(([, one]) => isDenial(one)))
        if (Object.keys(said).length) yes[field] = said
        if (Object.keys(nos).length) no[field] = nos
      } else (isDenial(answer) ? no : yes)[field] = answer
    }
    // Lo que acompaña a una respuesta va con ella: las semanas con el embarazo.
    for (const [field, main] of Object.entries(FIELD_OF)) if (field in yes && main in no) (no[field] = yes[field]), delete yes[field]
    if (Object.keys(yes).length) {
      // Lo que sin su «No» no se puede guardar tal cual espera con él: nada se guarda a medias.
      if ((HEALTH as Record<string, z.ZodType>)[group]?.safeParse(yes).success) kept[group] = yes
      else Object.assign(no, yes)
    }
    if (Object.keys(no).length) denied[group] = no
  }
  return { kept: withSaidBy(kept, by), denied: withSaidBy(denied, by) }
}

/** ¿La propuesta trae algo de su salud? */
export const hasHealth = (payload: Record<string, unknown>) => GROUPS.some((group) => isRecord(payload[group]))

/**
 * Las claves de lo que dice una propuesta de su salud, como las de sus filas (`healthRows`): su grupo
 * (las medicinas, el anticoagulante) o, en la entrevista, su campo («dental.corazon»). Con ellas se
 * sabe qué dato dijo después otra vez (QA del 21 nov, H3: lo dicho otro día y corregido hoy).
 */
export function healthKeysOf(payload: Record<string, unknown>): Set<string> {
  const keys = new Set<string>()
  for (const group of GROUPS) {
    const value = payload[group]
    if (!isRecord(value)) continue
    if (!INTERVIEW.includes(group)) keys.add(group)
    else for (const field of Object.keys(value)) keys.add(`${group}.${field}`)
  }
  return keys
}

/**
 * La propuesta sin los datos que se dijeron después otra vez (`keys`, de `healthKeysOf`): de un dato
 * vale lo último que dijo. `null` si no le queda nada de su salud.
 */
export function withoutHealthKeys(payload: Record<string, unknown>, keys: ReadonlySet<string>): Record<string, unknown> | null {
  const out: Record<string, unknown> = { ...payload }
  for (const group of GROUPS) {
    const value = out[group]
    if (!isRecord(value)) continue
    if (!INTERVIEW.includes(group)) {
      if (keys.has(group)) delete out[group]
      continue
    }
    const fields = Object.fromEntries(Object.entries(value).filter(([field]) => !keys.has(`${group}.${field}`)))
    if (Object.keys(fields).length) out[group] = fields
    else delete out[group]
  }
  return hasHealth(out) ? out : null
}

/**
 * Lo de su salud separado por quien lo dijo, para registrar una declaración por persona (revisión
 * del 21 nov, A4): lo del paciente a su nombre y lo de su hija, al de ella.
 */
export function healthByDeclarant(payload: Record<string, unknown>): Array<{ by: HealthSaidBy; payload: Record<string, unknown> }> {
  const saidBy = healthSaidBy(payload)
  const people: Array<{ by: HealthSaidBy; payload: Record<string, unknown> }> = []
  const of = (who: HealthSaidBy) => {
    const known = people.find((one) => sameSaidBy(one.by, who))
    if (known) return known.payload
    const person = { by: who, payload: { declarante: who.declarante, ...(who.vinculo ? { vinculo: who.vinculo } : {}) } as Record<string, unknown> }
    people.push(person)
    return person.payload
  }
  for (const group of GROUPS) {
    const value = payload[group]
    if (!isRecord(value)) continue
    if (INTERVIEW.includes(group)) {
      for (const [field, answer] of Object.entries(value)) {
        const target = of(saidBy[`${group}.${FIELD_OF[field] ?? field}`] ?? { declarante: "no_se_sabe" })
        target[group] = { ...((target[group] as Record<string, unknown> | undefined) ?? {}), [field]: answer }
      }
      continue
    }
    const items = LISTS.includes(group) && value["state"] === "recorded" && Array.isArray(value["items"]) ? (value["items"] as Array<Record<string, unknown>>) : []
    if (!items.length) {
      of(saidBy[group] ?? { declarante: "no_se_sabe" })[group] = value
      continue
    }
    for (const item of items) {
      const target = of(saidBy[itemKey(group, item)] ?? { declarante: "no_se_sabe" })
      const before = target[group] as Record<string, unknown> | undefined
      target[group] = { ...value, items: [...((before?.["items"] as unknown[] | undefined) ?? []), item] }
    }
  }
  return people
}

/** Lo de su salud que la sugerencia propone, sin quién lo dijo: la forma de su registro. */
export function healthOfPayload(payload: Record<string, unknown>): NonNullable<z.infer<typeof registrationAnswersSchema>["health"]> {
  const health = Object.fromEntries(GROUPS.flatMap((group) => (payload[group] === undefined ? [] : [[group, payload[group]]])))
  return registrationAnswersSchema.shape.health.unwrap().parse(health)
}

const sameName = (a: unknown, b: unknown) => normalizeDrugText(text(a)) === normalizeDrugText(text(b))
/** La medicina, sin dosis ni frecuencia: «apixabán 5 mg dos veces al día» → «apixaban». */
const drugHead = (value: unknown) => normalizeDrugText(text(value)).split(" ")[0] ?? ""

/**
 * El repaso al terminar (mesa del 20 nov 2026, P4): lo de su salud que no repite lo ya decidido
 * (confirmado con la persona o descartado). Un grupo igual se quita entero; de una lista, la
 * enfermedad o la medicina ya decidida. `null` si no queda nada nuevo.
 */
export function withoutSettledHealth(
  payload: Record<string, unknown>,
  settled: ReadonlyArray<Record<string, unknown>>,
  /** Ya hay una alergia con su sustancia, propuesta o decidida: su «no sabe» o su «no» no vuelve. */
  namedAllergy = false,
): Record<string, unknown> | null {
  const kept = { ...payload }
  for (const group of GROUPS) {
    const now = kept[group]
    if (!isRecord(now)) continue
    // Con la alergia ya nombrada (la hija: «con el ibuprofeno se le hincharon los ojos»), el «no que
    // ella sepa» de la paciente no vuelve en el repaso a contradecirla (mesa del 25 nov, H3).
    if (group === "allergies" && namedAllergy && now["state"] !== "recorded") {
      delete kept[group]
      continue
    }
    const before = settled.map((item) => item[group]).filter(isRecord)
    // El anticoagulante y la medicina para los huesos son una respuesta: la misma medicina dicha con
    // otra dosis («apixabán» y «apixabán cinco miligramos dos veces al día») ya está decidida (H3).
    const sameAnswer = (item: Record<string, unknown>) =>
      JSON.stringify(item) === JSON.stringify(now) ||
      (DIRECTED.includes(group) && item["state"] === now["state"] && (now["state"] !== "recorded" || drugHead(item["detail"]) === drugHead(now["detail"])))
    if (before.some(sameAnswer)) {
      delete kept[group]
      continue
    }
    if (!LISTS.includes(group) || now["state"] !== "recorded") continue
    const decided = before.flatMap((item) => (item["state"] === "recorded" && Array.isArray(item["items"]) ? (item["items"] as Array<Record<string, unknown>>) : []))
    const items = (Array.isArray(now["items"]) ? (now["items"] as Array<Record<string, unknown>>) : []).filter((item) => !decided.some((one) => sameName(one["name"], item["name"])))
    if (items.length) kept[group] = { ...now, items }
    else delete kept[group]
  }
  return GROUPS.some((group) => isRecord(kept[group])) ? kept : null
}

/**
 * Lo nuevo de su salud sumado a lo que ya estaba pendiente, como la consulta: lo que no trae no se
 * toca; una enfermedad o una medicina más se suma sin repetir; una respuesta de un solo valor (el
 * anticoagulante, el embarazo) dicha distinto queda con la última y guarda la anterior en
 * `earlier` («antes dijo warfarina»), y un «no» o un «no sé» después no borra lo que sí dijo. Con
 * `correct` (alguien corrigió en voz alta lo ya dicho) el grupo que trae reemplaza al que había,
 * salvo en una lista: una medicina más se suma, y solo sale la que nombra la frase que corrige
 * (`correct` es la frase: «warfarina no perdón apixabán»); sin frase, la que ya no trae. «Antes
 * dijo» nombra solo lo que salió, nunca lo que queda (QA del 23 nov, verificador 2).
 */
export function mergeHealth(
  current: Record<string, unknown>,
  added: Record<string, unknown>,
  correct: boolean | string = false,
): { payload: Record<string, unknown>; earlier: Record<string, string> } {
  const payload = { ...current }
  const earlier: Record<string, string> = {}
  const known = (who: unknown) => who === "paciente" || who === "acompanante"
  if (added["declarante"] !== undefined && (correct !== false || (!known(current["declarante"]) && known(added["declarante"])))) {
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
    if (correct !== false && LISTS.includes(group) && before["state"] === "recorded" && now["state"] === "recorded") {
      const old = (before["items"] ?? []) as Array<Record<string, unknown>>
      const fresh = (now["items"] ?? []) as Array<Record<string, unknown>>
      const kept = (item: Record<string, unknown>) => fresh.some((one) => sameName(one["name"], item["name"]))
      // Con la frase, sale solo lo que esa frase nombra («no es warfarina»); sin ella, lo que ya no trae.
      const gone = old.filter((item) => !kept(item) && (typeof correct === "string" ? nameHeard(text(item["name"]), correct) : true))
      const items = old.filter((item) => !gone.includes(item)).map((item) => ({ ...item, ...fresh.find((one) => sameName(one["name"], item["name"])) }))
      for (const item of fresh) if (!items.some((one) => sameName(one["name"], item["name"]))) items.push(item)
      payload[group] = { state: "recorded", items }
      if (gone.length) earlier[group] = groupWords(group, { state: "recorded", items: gone })
      continue
    }
    if (correct !== false) {
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
  // Cada dato con quien lo dijo (revisión del 21 nov, A4): lo nuevo, con quien lo dijo en esta pausa;
  // lo de antes, con quien lo dijo entonces. La metformina que dijo su hija no queda a nombre del paciente.
  return { payload: withSaidBy(payload, { ...healthSaidBy(current), ...explicitSaidBy(added) }), earlier }
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
  // `group` es el grupo de la entrevista («dental.corazon»), no el producto: se compara la clave entera.
  const field = `${group}.${key}`
  if (field === "dental.corazon" && isRecord(value)) {
    return [
      value["riesgoEndocarditis"] ? `válvula o endocarditis: ${valueWords(value["riesgoEndocarditis"])}` : "",
      value["antibioticoPrevio"] ? `antibiótico antes: ${valueWords(value["antibioticoPrevio"])}` : "",
    ]
      .filter(Boolean)
      .join(" · ")
  }
  if (field === "dental.problemaAnestesia") {
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

/** Un dato que propone, en palabras: su clave (la de su grupo o su campo), quién lo dijo y lo que dijo antes. */
export interface HealthRow {
  key: string
  /** El grupo de su registro: la pantalla lo pone en la fila de su tema. */
  group: HealthGroup
  label: string
  value: string
  by: HealthSaidBy
  /** Lo que dijo antes, si lo dijo distinto: «warfarina». */
  before: string | null
  /** Es un «No»: se confirma en su fila, nunca con «Lo revisé con…» (`splitHealthDenials`). */
  denied: boolean
  /** Lo volvió a decir después, distinto o igual (ISO 8601): esta fila ya no es lo vigente. */
  newer?: string | null
  /** La frase en que se oyó, tal cual (la de la última pausa que lo dijo): la fila la muestra. */
  said?: string | null
}

/**
 * La frase en que se oyó cada dato de una propuesta de su salud, por su clave (`healthKeysOf`): la de
 * la pausa que lo dijo. Se suma a lo que ya tenía; un dato dicho otra vez queda con su última frase
 * (QA del 22 nov, UX-3: cada fila del aviso dice qué se oyó).
 *
 * Con `change` (cómo estaba la propuesta y cómo queda al sumar), un dato que no cambió conserva su
 * frase, y la frase nueva no repite la de otro dato que ya tenía la suya: Clío cita a veces dos pausas
 * juntas («tomo losartan para la presion no que yo sepa») y las dos filas quedaban con esa frase unida
 * (QA del 23 nov, verificador 2).
 */
export function healthSaidOf(
  payload: Record<string, unknown>,
  phrase: string | undefined,
  before: Record<string, string> = {},
  change?: { was: Record<string, unknown>; now: Record<string, unknown> },
): Record<string, string> {
  const said = phrase?.trim() ?? ""
  if (!said) return before
  const out = { ...before }
  const was = change ? healthValues(change.was) : null
  const now = change ? healthValues(change.now) : null
  for (const key of healthKeysOf(payload)) {
    if (was && now && before[key] && was.get(key) === now.get(key)) continue
    // Lo que en la frase es de otro dato (su propia frase, dicha en otra pausa) no es de este.
    let own = said
    for (const [other, phrase] of Object.entries(before)) {
      if (other === key || !phrase.trim() || phrase.trim() === said) continue
      const rest = own.replace(phrase.trim(), " ").replace(/\s+/g, " ").trim()
      if (rest !== own && /[\p{L}\p{N}]/u.test(rest)) own = rest
    }
    out[key] = own
  }
  return out
}

/** Un valor en texto sin mirar el orden de sus claves: lo guardado (jsonb) vuelve con otro orden. */
const valueKey = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(valueKey).join(",")}]`
    : isRecord(value)
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${valueKey(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value ?? null)

/** Lo que dice cada dato de una propuesta, por su clave (`healthKeysOf`): para saber cuál cambió. */
function healthValues(payload: Record<string, unknown>): Map<string, string> {
  const values = new Map<string, string>()
  for (const group of GROUPS) {
    const value = payload[group]
    if (!isRecord(value)) continue
    if (!INTERVIEW.includes(group)) values.set(group, valueKey(value))
    else for (const [field, answer] of Object.entries(value)) values.set(`${group}.${field}`, valueKey(answer))
  }
  return values
}

/** Las filas con la frase en que se oyó cada una (`healthSaidOf`). */
export function withSaidPhrases(rows: HealthRow[], said: Record<string, string> = {}): HealthRow[] {
  return rows.map((row) => (said[row.key] ? { ...row, said: said[row.key] } : row))
}

/** Quién lo dijo, en pocas palabras: «el paciente», «su madre»; `null` si no se sabe. */
export function saidByWords(by: HealthSaidBy): string | null {
  if (by.declarante === "paciente") return "el paciente"
  if (by.declarante === "acompanante") return whoWords(healthDeclarantOf({ ...by }), null)
  return null
}

/**
 * Cada dato que propone, en palabras, con quién lo dijo («antes dijo» va con la misma clave). Lo
 * de una lista dicho por otra persona lo dice al lado: «metformina (lo dijo su hija)».
 */
export function healthRows(payload: Record<string, unknown>, earlier: Record<string, string> = {}): HealthRow[] {
  const rows: HealthRow[] = []
  const saidBy = healthSaidBy(payload)
  const unknownBy: HealthSaidBy = { declarante: "no_se_sabe" }
  const push = (row: Omit<HealthRow, "before" | "denied">, denied: boolean, still: (name: string) => boolean = () => false) => {
    // «Antes dijo» nunca nombra lo que sigue en la fila: de una lista, solo lo que ya no está
    // («salbutamol (antes dijo salbutamol)», QA del 23 nov, verificador 2).
    const said = earlier[row.key]
    const gone = said ? said.split(" · ").filter((name) => !still(name)).join(" · ") : ""
    rows.push({ ...row, denied, before: gone && gone !== row.value ? gone : null })
  }
  for (const group of GROUPS) {
    const value = payload[group]
    if (!isRecord(value)) continue
    if (!INTERVIEW.includes(group)) {
      const items = LISTS.includes(group) && value["state"] === "recorded" ? ((value["items"] ?? []) as Array<Record<string, unknown>>) : []
      const by = (items.length ? saidBy[itemKey(group, items[0] as Record<string, unknown>)] : saidBy[group]) ?? unknownBy
      const words =
        items.length && items.some((item) => !sameSaidBy(saidBy[itemKey(group, item)], by))
          ? items
              .map((item) => {
                const own = saidBy[itemKey(group, item)] ?? unknownBy
                const name = [item["name"], item["dose"], item["frequency"]].filter(Boolean).join(" ")
                return sameSaidBy(own, by) ? name : `${name} (${saidByWords(own) ? `lo dijo ${saidByWords(own)}` : "no se sabe quién lo dijo"})`
              })
              .join(" · ")
          : groupWords(group, value)
      const still = (name: string) =>
        items.some((item) => sameName(item["name"], name) || sameName([item["name"], item["dose"], item["frequency"]].filter(Boolean).join(" "), name))
      push({ key: group, group, label: GROUP_LABEL[group], value: words, by }, value["state"] === "none", still)
      continue
    }
    for (const [key, item] of Object.entries(value)) {
      if (key === "semanasEmbarazo" || key === "cigarrillos") continue
      let words = fieldWords(group, key, item)
      if (group === "personal" && key === "embarazo" && item === true && typeof value["semanasEmbarazo"] === "number") words = `sí, ${value["semanasEmbarazo"]} semanas`
      if (`${group}.${key}` === "medical.tabaco" && item === "fuma" && typeof value["cigarrillos"] === "string")
        words = `sí, ${CIGARETTE_BAND_LABELS[value["cigarrillos"] as keyof typeof CIGARETTE_BAND_LABELS] ?? value["cigarrillos"]}`
      const denied = isDenial(item) || (isRecord(item) && Object.keys(item).length > 0 && Object.values(item).every(isDenial))
      push({ key: `${group}.${key}`, group, label: FIELD_LABEL[`${group}.${key}`] ?? key, value: words, by: saidBy[`${group}.${key}`] ?? unknownBy }, denied)
    }
  }
  return rows
}

/** Quién lo dijo, para la tarjeta y para Clío: «Lo dijo: el paciente», «Lo dijeron: el paciente y su hija». */
function declarantWords(payload: Record<string, unknown>): string {
  const people = [...new Set(Object.values(healthSaidBy(payload)).map((by) => saidByWords(by) ?? ""))]
  const known = people.filter(Boolean)
  if (!known.length) return "No se sabe quién lo dijo"
  if (known.length === 1 && people.length === 1) return `Lo dijo: ${known[0]}`
  const all = people.length > known.length ? [...known, "alguien más"] : known
  return `Lo dijeron: ${all.slice(0, -1).join(", ")} y ${all.at(-1)}`
}

/** La tarjeta: cada dato con lo que dijo antes, si lo dijo distinto, y quién lo dijo. */
export function healthSummary(payload: Record<string, unknown>, earlier: Record<string, string> = {}): string {
  const lines = healthRows(payload, earlier).map((row) => `${row.label}: ${row.value}${row.before ? ` (antes dijo «${row.before}»)` : ""}`)
  return [...lines, declarantWords(payload)].join("\n")
}

/** Cómo se le nombra a Clío la salud pendiente: con lo que ya dice, para que sume sin repetir. */
export function healthModelLabel(payload: Record<string, unknown>): string {
  const rows = healthRows(payload).map((row) => `${row.label.toLocaleLowerCase("es")}: «${row.value}»`)
  return ["Salud", ...rows, declarantWords(payload).toLocaleLowerCase("es")].join(" · ")
}

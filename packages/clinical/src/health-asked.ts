/**
 * Qué se sabe ya de la salud de una persona, dato por dato (mesa del 13 nov,
 * entrega 6): su enlace le pregunta solo lo que falta y la atención distingue
 * «No se le preguntó» de «dijo que no». Una sola regla para el servidor, «Su
 * enlace» y la atención; aquí no se lee la base: recibe lo que ya cargó.
 */
import { type MedicationClass, MEDICATION_CLASSES, medicationClassOf } from "./allergens.js"
import {
  REGISTRATION_FIELDS,
  type RegistrationAnswers,
  type RegistrationConfig,
  type RegistrationFieldKey,
  registrationFieldApplies,
  registrationFieldAsked,
} from "./patient-registration.js"
import type { ClinicalProduct } from "./products.js"

type Rec = Record<string, unknown>
type DeclaredHealth = NonNullable<RegistrationAnswers["health"]>

/** Lo que hace falta saber de su ficha para decir qué ya se sabe. */
export interface KnownHealthInput {
  bloodGroup: string | null
  /** El estado de cada grupo: `none` (no tiene), `recorded` (tiene) o `unknown` (nadie lo dijo). */
  reviewStatus: { allergies: string; conditions: string; medications: string }
  /** Alergias activas (las descartadas no cuentan). */
  activeAllergies: number
  /** Lo que toma o tomó, con su código ATC si lo tiene. */
  medications: ReadonlyArray<{ atcCode?: string | null }>
  /** La última versión de la entrevista de salud. */
  interview: Rec | null | undefined
  /** Lo que declaró, tal como llegó, de lo más nuevo a lo más antiguo. */
  declarations: ReadonlyArray<{ health: DeclaredHealth }>
}

const isRec = (value: unknown): value is Rec => !!value && typeof value === "object" && !Array.isArray(value)
const present = (value: unknown) =>
  value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && value.length === 0)

/** Dónde guarda la entrevista cada dato del registro (las claves de `declared` de cada producto). */
const INTERVIEW_PATH: Partial<Record<RegistrationFieldKey, readonly string[][]>> = {
  "personal.embarazo": [["embarazoLactancia", "embarazo"], ["antecedentesPersonales", "embarazo"]],
  "personal.cirugias": [["antecedentesPersonales", "cirugias"]],
  "personal.hospitalizaciones": [["antecedentesPersonales", "hospitalizaciones"]],
  "personal.transfusiones": [["antecedentesPersonales", "transfusiones"]],
  "medical.lactancia": [["embarazoLactancia", "lactancia"]],
  "medical.tabaco": [["habitos", "tabaco"]],
  "medical.alcohol": [["habitos", "alcohol"]],
}

function interviewHas(interview: Rec | null | undefined, key: RegistrationFieldKey): boolean {
  if (!interview) return false
  const paths =
    INTERVIEW_PATH[key] ?? (key.startsWith("dental.") ? [["antecedentesOdontologicos", key.slice("dental.".length)]] : [])
  return paths.some(([group, name]) => {
    const section = interview[group as string]
    return isRec(section) && present(section[name as string])
  })
}

/** Si una declaración respondió ese dato (un «No sé» también es una respuesta). */
function declarationHas(health: DeclaredHealth, key: RegistrationFieldKey): boolean {
  const dot = key.indexOf(".")
  if (dot > 0) {
    const section = (health as Rec)[key.slice(0, dot)]
    return isRec(section) && present(section[key.slice(dot + 1)])
  }
  const value = (health as Rec)[key]
  if (key === "bloodGroup") return present(value)
  return isRec(value) && typeof value.state === "string" && value.state !== "unanswered"
}

/**
 * Los datos de salud del registro que ya se saben de la persona: los anotó el
 * equipo (un grupo con «tiene» o «no tiene», una medicina de esa clase, un dato
 * de la entrevista) o los respondió en una declaración. Lo demás es lo que
 * falta preguntarle.
 */
export function knownHealthQuestions(input: KnownHealthInput): Set<RegistrationFieldKey> {
  const known = new Set<RegistrationFieldKey>()
  for (const field of REGISTRATION_FIELDS) {
    if (field.group !== "health") continue
    const key = field.key
    if (input.declarations.some((row) => declarationHas(row.health, key))) known.add(key)
    else if (key === "bloodGroup" && input.bloodGroup) known.add(key)
    else if (key === "allergies" && (input.activeAllergies > 0 || input.reviewStatus.allergies !== "unknown")) known.add(key)
    else if ((key === "conditions" || key === "medications") && input.reviewStatus[key] !== "unknown") known.add(key)
    else if (key === "anticoagulants" || key === "boneMedicines") {
      // Una medicina de esa clase, o que no toma ninguna medicina, ya lo responde.
      if (input.reviewStatus.medications === "none" || input.medications.some((row) => medicationClassOf(row.atcCode) === key))
        known.add(key)
    } else if (interviewHas(input.interview, key)) known.add(key)
  }
  return known
}

/**
 * Lo que su enlace le pregunta de su salud: lo que la clínica pregunta en su
 * producto, que corresponde a la persona (el embarazo y la lactancia, solo a
 * mujeres de 12 a 55 años) y que aún no se sabe. Vacío: nada que preguntarle.
 */
export function healthQuestionsToAsk(
  config: Pick<RegistrationConfig, "fields">,
  context: { countryCode: string | null; product: ClinicalProduct; person: { sex?: string | null; age?: number | null } },
  known: ReadonlySet<RegistrationFieldKey>,
): RegistrationFieldKey[] {
  return REGISTRATION_FIELDS.filter(
    (field) =>
      field.group === "health" &&
      !known.has(field.key) &&
      registrationFieldAsked(config, field.key, context.countryCode, context.product) &&
      registrationFieldApplies(field.key, context.person),
  ).map((field) => field.key)
}

/**
 * Lo que se sabe de una clase de medicina, para la atención: `yes` (toma una;
 * la marca va arriba), `no` (dijo que no, o no toma ninguna medicina),
 * `unknown` (dijo «No sé») o `unasked` (nadie se lo preguntó). `said`: lo
 * respondió en una declaración y no lo anotó el equipo.
 */
export interface MedicineClassAnswer {
  answer: "yes" | "no" | "unknown" | "unasked"
  said: boolean
}

export function medicineClassAnswers(
  input: Pick<KnownHealthInput, "reviewStatus" | "declarations"> & {
    /** Lo que toma hoy (no lo que ya dejó). */
    current: ReadonlyArray<{ atcCode?: string | null }>
  },
): Record<MedicationClass, MedicineClassAnswer> {
  const of = (group: MedicationClass): MedicineClassAnswer => {
    if (input.current.some((row) => medicationClassOf(row.atcCode) === group)) return { answer: "yes", said: false }
    const said = input.declarations.find((row) => {
      const state = row.health[group]?.state
      return state !== undefined && state !== "unanswered"
    })?.health[group]?.state
    // Dijo que sí y ya no figura: el equipo la quitó o la terminó, así que hoy no la toma.
    if (said === "none" || said === "recorded") return { answer: "no", said: said === "none" }
    if (input.reviewStatus.medications === "none") return { answer: "no", said: false }
    if (said === "unknown") return { answer: "unknown", said: true }
    return { answer: "unasked", said: false }
  }
  return { anticoagulants: of("anticoagulants"), boneMedicines: of("boneMedicines") }
}

/**
 * La marca de una medicina en la franja: «Anticoagulante: warfarina 5 mg» o
 * «Huesos: alendronato» si su código es de una de las dos clases; si no,
 * «Toma …». Lo dicho sin nombre («Anticoagulante (no dijo cuál)») se lee tal cual.
 */
export function medicationAlertWords(row: { name: string; dose?: string | null; atcCode?: string | null }): {
  label: string
  group: MedicationClass | null
} {
  const what = [row.name, row.dose].filter(Boolean).join(" ")
  const group = medicationClassOf(row.atcCode)
  if (!group) return { label: `Toma ${what}`, group: null }
  const { label, unnamed } = MEDICATION_CLASSES[group]
  return { label: row.name === unnamed ? unnamed : `${label}: ${what}`, group }
}

/** Lo que va junto con un dato: las semanas, con el embarazo; cuántos al día, con el tabaco. */
const COMES_WITH: Record<string, RegistrationFieldKey> = {
  "personal.semanasEmbarazo": "personal.embarazo",
  "medical.cigarrillos": "medical.tabaco",
}

/**
 * De lo que envió, solo lo que se le preguntó (`keys`): lo que ya se sabía no
 * se le mostró, así que no puede cambiarlo desde su enlace.
 */
export function onlyAskedHealth(health: DeclaredHealth, keys: readonly RegistrationFieldKey[]): DeclaredHealth {
  const asked = new Set<string>(keys)
  const out: Rec = {}
  for (const [key, value] of Object.entries(health)) {
    // Un grupo de la entrevista (`personal`, el de cada producto) no lleva `state`: se filtra dato por dato.
    if (key !== "bloodGroup" && isRec(value) && !("state" in value)) {
      const kept = Object.fromEntries(
        Object.entries(value).filter(([name]) => {
          const full = `${key}.${name}`
          return asked.has(full) || asked.has(COMES_WITH[full] ?? "")
        }),
      )
      if (Object.keys(kept).length) out[key] = kept
    } else if (asked.has(key)) out[key] = value
  }
  return out as DeclaredHealth
}

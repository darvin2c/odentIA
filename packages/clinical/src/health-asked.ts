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
/**
 * Si «no toma medicamentos» quiere decir «ninguno»: lo anotó el equipo o lo dijo
 * en un registro de antes, cuando era una sola pregunta. Desde la entrega 6, el
 * «No» de una declaración que ya preguntó por las dos clases es solo de «algún
 * otro», y no dice nada del anticoagulante ni de los huesos.
 */
function takesNoMedicine(input: Pick<KnownHealthInput, "reviewStatus" | "declarations">): boolean {
  return (
    input.reviewStatus.medications === "none" &&
    !input.declarations.some((row) => "anticoagulants" in row.health || "boneMedicines" in row.health)
  )
}

export function knownHealthQuestions(input: KnownHealthInput): Set<RegistrationFieldKey> {
  const known = new Set<RegistrationFieldKey>()
  const hasClass = (key: MedicationClass) => input.medications.some((row) => medicationClassOf(row.atcCode) === key)
  for (const field of REGISTRATION_FIELDS) {
    if (field.group !== "health") continue
    const key = field.key
    if (input.declarations.some((row) => declarationHas(row.health, key))) known.add(key)
    else if (key === "bloodGroup" && input.bloodGroup) known.add(key)
    else if (key === "allergies" && (input.activeAllergies > 0 || input.reviewStatus.allergies !== "unknown")) known.add(key)
    else if (key === "conditions" && input.reviewStatus.conditions !== "unknown") known.add(key)
    else if (key === "medications") {
      // «Algún otro»: lo sabe un «no toma» o una medicina que no es de las dos clases. Un «tiene» que
      // solo trae el anticoagulante o la de los huesos no responde «¿algún otro?».
      if (input.reviewStatus.medications === "none" || input.medications.some((row) => !medicationClassOf(row.atcCode)))
        known.add(key)
    } else if (key === "anticoagulants" || key === "boneMedicines") {
      // Una medicina de esa clase, o que no toma ninguna medicina, ya lo responde.
      if (takesNoMedicine(input) || hasClass(key)) known.add(key)
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
 * la marca va arriba), `saidYes` (dijo que toma una y ninguna medicina anotada
 * lleva esa clase: hay que preguntarle cuál), `no` (dijo que no, el equipo la
 * terminó, o no toma ninguna medicina), `unknown` (dijo «No sé») o `unasked`
 * (nadie se lo preguntó). `said`: lo respondió en una declaración y no lo anotó
 * el equipo.
 */
export interface MedicineClassAnswer {
  /** `took`: de los huesos, la tomó y ya no; el riesgo de una extracción sigue (AAOMS 2022). */
  answer: "yes" | "saidYes" | "took" | "no" | "unknown" | "unasked"
  said: boolean
}

export function medicineClassAnswers(
  input: Pick<KnownHealthInput, "reviewStatus" | "declarations"> & {
    /** Lo que toma hoy (no lo que ya dejó). */
    current: ReadonlyArray<{ atcCode?: string | null }>
    /** Lo que ya dejó: una medicina terminada de la clase dice que hoy no la toma. */
    ended?: ReadonlyArray<{ atcCode?: string | null }>
  },
): Record<MedicationClass, MedicineClassAnswer> {
  const of = (group: MedicationClass): MedicineClassAnswer => {
    const isOf = (row: { atcCode?: string | null }) => medicationClassOf(row.atcCode) === group
    if (input.current.some(isOf)) return { answer: "yes", said: false }
    const said = input.declarations.find((row) => {
      const state = row.health[group]?.state
      return state !== undefined && state !== "unanswered"
    })?.health[group]?.state
    if (said === "recorded") {
      // Dijo que sí y el equipo la terminó: hoy no la toma. Si no figura con su clase (la escribieron
      // a mano, o le cambiaron el nombre), nunca «no toma»: dijo que sí y falta anotar cuál.
      if (!(input.ended ?? []).some(isOf)) return { answer: "saidYes", said: true }
      return group === "boneMedicines" ? { answer: "took", said: true } : { answer: "no", said: false }
    }
    if (said === "none") return { answer: "no", said: true }
    if (said === "unknown") return { answer: "unknown", said: true }
    if (takesNoMedicine(input)) return { answer: "no", said: false }
    return { answer: "unasked", said: false }
  }
  return { anticoagulants: of("anticoagulants"), boneMedicines: of("boneMedicines") }
}

/**
 * La marca de una medicina en la franja: «Anticoagulante: warfarina 5 mg» o
 * «Medicina para los huesos: alendronato» si su código es de una de las dos clases; si no,
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
  // La aspirina y el clopidogrel (B01AC) son antiagregantes, no anticoagulantes: se manejan distinto
  // antes de una extracción (SDCEP 2022). La pregunta es una sola; la marca dice cuál es.
  const named = group === "anticoagulants" && row.atcCode?.startsWith("B01AC") ? "Antiagregante" : label
  return { label: row.name === unnamed ? unnamed : `${named}: ${what}`, group }
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

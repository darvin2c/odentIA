/**
 * La anestesia local antes de anestesiar (QA del 16 nov, E5b y E5c): con el anestésico que se
 * elige y el peso de los signos vitales (`vitals.peso`, su único dueño), el máximo por peso. Es un
 * aviso, nunca una traba: decide el profesional, y no se registran cartuchos ni técnica (siguen en
 * la evolución).
 *
 * Fuentes:
 * - Malamed SF, *Handbook of Local Anesthesia*, 7.ª ed., Elsevier, 2020: dosis máximas
 *   recomendadas por peso y su tope (lidocaína y mepivacaína 4,4 mg/kg hasta 300 mg; articaína
 *   7 mg/kg hasta 500 mg; prilocaína 6 mg/kg hasta 400 mg) y la dosis de epinefrina en el
 *   paciente cardiópata (0,04 mg por sesión).
 * - AAPD, *Use of Local Anesthesia for Pediatric Dental Patients* (Reference Manual): la misma
 *   tabla en niños y la articaína no recomendada en menores de 4 años. Verificar el año de la
 *   última revisión y su tabla.
 * La ficha técnica de la lidocaína admite más (7 mg/kg, 500 mg): para un niño se usa el valor más
 * prudente.
 * A quién le corresponde el tope de epinefrina (reglas clínicas del 18 nov): `epinephrineCheckOf`.
 */
import { isLocalAnestheticName } from "./medications.js"
import { ADULT_BLOOD_PRESSURE_FROM_AGE, type Vitals } from "./vitals.js"

/** El cartucho dental: 1,8 mL. */
export const CARTRIDGE_ML = 1.8

/** Epinefrina por sesión con enfermedad cardiovascular significativa o ASA III–IV (Malamed): 0,04 mg. */
export const CARDIAC_EPINEPHRINE_MAX_MG = 0.04

export interface LocalAnesthetic {
  key: string
  /** Como se elige: «Lidocaína 2 % con epinefrina 1:100 000». */
  label: string
  /** Como se dice en la frase del máximo: «lidocaína 2 % con epinefrina». */
  name: string
  /** mg por mL: 2 % son 20 mg/mL. */
  mgPerMl: number
  mgPerKg: number
  maxMg: number
  /** mg de epinefrina por mL (1:100 000 son 0,01); null sin vasoconstrictor o con felipresina. */
  epinephrineMgPerMl: number | null
  /** Por debajo de esta edad no se recomienda (articaína, 4 años). */
  minAgeYears?: number
}

/** Los que se usan a diario en el consultorio, en el orden en que se eligen. */
export const LOCAL_ANESTHETICS = [
  {
    key: "lidocaina-2-epinefrina",
    label: "Lidocaína 2 % con epinefrina 1:100 000",
    name: "lidocaína 2 % con epinefrina",
    mgPerMl: 20,
    mgPerKg: 4.4,
    maxMg: 300,
    epinephrineMgPerMl: 0.01,
  },
  {
    key: "mepivacaina-3",
    label: "Mepivacaína 3 % sin vasoconstrictor",
    name: "mepivacaína 3 %",
    mgPerMl: 30,
    mgPerKg: 4.4,
    maxMg: 300,
    epinephrineMgPerMl: null,
  },
  {
    key: "articaina-4-epinefrina",
    label: "Articaína 4 % con epinefrina 1:100 000",
    name: "articaína 4 % con epinefrina",
    mgPerMl: 40,
    mgPerKg: 7,
    maxMg: 500,
    epinephrineMgPerMl: 0.01,
    minAgeYears: 4,
  },
  {
    key: "prilocaina-4",
    label: "Prilocaína 4 %",
    name: "prilocaína 4 %",
    mgPerMl: 40,
    mgPerKg: 6,
    maxMg: 400,
    epinephrineMgPerMl: null,
  },
] as const satisfies readonly LocalAnesthetic[]

export type LocalAnestheticKey = (typeof LOCAL_ANESTHETICS)[number]["key"]

/** El que viene elegido: la lidocaína con epinefrina, la de uso más común. */
export const DEFAULT_LOCAL_ANESTHETIC: LocalAnestheticKey = "lidocaina-2-epinefrina"

export function localAnestheticOf(key: string | null | undefined): LocalAnesthetic | null {
  return LOCAL_ANESTHETICS.find((anesthetic) => anesthetic.key === key) ?? null
}

/**
 * Un decimal hacia abajo: es un máximo, y redondear al más cercano puede pasarlo (2,69 → 2,6, no
 * 2,7; 1,46 → 1,4; revisión del 16 nov, R11). El 1e-9 evita que 96,8 × 10 quede en 967,99…
 */
function oneDecimal(value: number): number {
  return Math.floor(value * 10 + 1e-9) / 10
}

/** El máximo para ese peso con ese anestésico: mg, cartuchos de 1,8 mL y si llegó al tope. */
export function maxLocalAnestheticDose(
  weightKg: number,
  anesthetic: LocalAnesthetic,
): { mg: number; cartridges: number; capped: boolean } {
  const byWeight = weightKg * anesthetic.mgPerKg
  const mg = Math.min(byWeight, anesthetic.maxMg)
  return {
    mg: oneDecimal(mg),
    cartridges: oneDecimal(mg / (anesthetic.mgPerMl * CARTRIDGE_ML)),
    capped: byWeight > anesthetic.maxMg,
  }
}

const number = (value: number) =>
  value.toLocaleString("es", { maximumFractionDigits: 1, minimumFractionDigits: 0 })

/** «a», «a y b», «a, b y c». */
function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? ""
  return `${words.slice(0, -1).join(", ")} y ${words[words.length - 1]}`
}

/**
 * La presión de hoy que pide limitar la epinefrina: sistólica de 160 o más, o diastólica de 95 o
 * más, desde los 13 años (como `bloodPressureAlert`). Malamed (*Medical Emergencies in the Dental
 * Office*, 7.ª ed., 2015, cap. 2, tabla de presión del adulto) pone 160–199 / 95–114 en ASA III,
 * con protocolo de reducción del estrés; verificar la tabla.
 */
export const EPINEPHRINE_CAP_PRESSURE = { systolic: 160, diastolic: 95 } as const

/**
 * Por qué se limita la epinefrina, con el motivo verdadero (QA del 16 nov, Q10; reglas clínicas del
 * 18 nov): la ASA III o IV, una enfermedad del corazón registrada con su código o la presión de hoy.
 * La hipertensión registrada no lo pide por sí sola: la controlada es ASA II (ASA 2020) y en ella la
 * epinefrina del anestésico da cambios pequeños y casi ningún evento adverso (Bader JD, Bonito AJ,
 * Shugars DA, *Oral Surg Oral Med Oral Pathol Oral Radiol Endod* 2002;93:647-653). Lo que dice si
 * está controlada es la presión de hoy.
 */
export interface EpinephrineCap {
  /** Las enfermedades del corazón que lo piden, como se leen: «fibrilación auricular (I48)». */
  conditions: string[]
  /** La ASA que lo pide (III o más); nula si no es por la ASA. */
  asaClass: string | null
  /** La presión de hoy que lo pide («165/100»); nula si no es por la presión. */
  pressure: string | null
}

/** Lo que dice la regla de la epinefrina de esa persona hoy. */
export interface EpinephrineCheck {
  /** El tope de 0,04 mg, con sus motivos; nulo si nada lo pide. */
  cap: EpinephrineCap | null
  /**
   * La hipertensión registrada sin la presión de hoy, como se lee («hipertensión esencial (I10)»):
   * hay que tomarla antes de anestesiar para saber si está controlada (Little y Falace, 9.ª ed.,
   * 2018, cap. 3: la presión en cada cita del hipertenso). Nula si no tiene o ya se tomó.
   */
  takePressure: string | null
}

/** Una enfermedad de su ficha como la lee la regla: nombre, lista y código. Solo las activas. */
export interface AnesthesiaCondition {
  name: string
  diagnosisSystem?: string | null
  diagnosisCode?: string | null
}

/** «Fibrilación auricular» → «fibrilación auricular (I48)»; una sigla («HTA») queda como está. */
function conditionWords(condition: AnesthesiaCondition): string {
  const name = condition.name.trim()
  const lower = /^\p{Lu}\p{Ll}/u.test(name) ? name.charAt(0).toLocaleLowerCase("es") + name.slice(1) : name
  if (!condition.diagnosisCode) return lower
  // «Hipertensión esencial (primaria)» de la CIE-10 ya cierra con un paréntesis: el código va dentro,
  // «(primaria, I10)», no «(primaria) (I10)» (QA clínica del 18 nov).
  if (lower.endsWith(")")) return `${lower.slice(0, -1)}, ${condition.diagnosisCode})`
  return `${lower} (${condition.diagnosisCode})`
}

/**
 * La regla de la epinefrina: una sola para la línea de la atención y para lo que guarda la firma.
 * El tope de 0,04 mg por sesión (Malamed, *Handbook of Local Anesthesia*, 7.ª ed., 2020) sale con:
 * - la ASA III o IV, que pone el profesional (donde el producto la pide; latidIA no la pide y ahí
 *   llega nula);
 * - una enfermedad del corazón con su código, sin la hipertensión que no la tiene
 *   (`isHypertensionWithoutHeartFailure`): la fibrilación auricular (I48) y la cardiopatía
 *   hipertensiva con insuficiencia cardiaca (I11.0, I13.0, I13.2) sí cuentan;
 * - la presión de hoy de 160/95 o más, desde los 13 años (`EPINEPHRINE_CAP_PRESSURE`).
 * Sin edad (sin fecha de nacimiento) la presión cuenta igual, como en `bloodPressureAlert`. La
 * enfermedad escrita sin código no cuenta: no se reconoce por el nombre. Es un aviso: decide el
 * profesional.
 */
export function epinephrineCheckOf(input: {
  conditions: readonly AnesthesiaCondition[]
  asaClass: string | null | undefined
  vitals: Vitals | null | undefined
  ageYears: number | null | undefined
}): EpinephrineCheck {
  const asaClass = isSevereAsa(input.asaClass) ? (input.asaClass ?? null) : null
  const cardiac = input.conditions.filter(
    (row) =>
      isCardiacCondition(row.diagnosisSystem, row.diagnosisCode) &&
      !isHypertensionWithoutHeartFailure(row.diagnosisSystem, row.diagnosisCode),
  )
  const hypertension = input.conditions.find((row) => isHypertension(row.diagnosisSystem, row.diagnosisCode))
  const systolic = input.vitals?.presionSistolica
  const diastolic = input.vitals?.presionDiastolica
  const measured = systolic !== undefined && diastolic !== undefined
  const adult =
    input.ageYears === null || input.ageYears === undefined || input.ageYears >= ADULT_BLOOD_PRESSURE_FROM_AGE
  const pressure =
    measured &&
    adult &&
    (systolic >= EPINEPHRINE_CAP_PRESSURE.systolic || diastolic >= EPINEPHRINE_CAP_PRESSURE.diastolic)
      ? `${systolic}/${diastolic}`
      : null
  const cap =
    asaClass || cardiac.length > 0 || pressure ? { conditions: cardiac.map(conditionWords), asaClass, pressure } : null
  return { cap, takePressure: hypertension && !measured ? conditionWords(hypertension) : null }
}

/**
 * La línea del máximo y sus avisos: «Máximo para 22 kg con lidocaína 2 % con epinefrina
 * (cartucho de 1,8 mL): 96,8 mg, unos 2,6 cartuchos». Sin peso no inventa un máximo (`dose`
 * nulo): la pantalla pide anotarlo en los signos vitales.
 */
export function localAnesthesiaWords(input: {
  weightKg: number | null | undefined
  anesthetic: LocalAnestheticKey | string
  ageYears: number | null | undefined
  /** El tope de epinefrina con sus motivos y si falta tomar la presión (`epinephrineCheckOf`). */
  epinephrine: EpinephrineCheck | null
}): { dose: string | null; warnings: string[] } {
  const anesthetic = localAnestheticOf(input.anesthetic)
  if (!anesthetic) return { dose: null, warnings: [] }
  const warnings: string[] = []
  const { ageYears } = input
  if (
    anesthetic.minAgeYears &&
    ageYears !== null &&
    ageYears !== undefined &&
    ageYears < anesthetic.minAgeYears
  )
    warnings.push(
      `La ${anesthetic.name.split(" ")[0]} no se recomienda en menores de ${anesthetic.minAgeYears} años.`,
    )
  const cap = input.epinephrine?.cap ?? null
  if (cap && anesthetic.epinephrineMgPerMl) {
    const perCartridge = anesthetic.epinephrineMgPerMl * CARTRIDGE_ML
    const why = listWords([
      ...(cap.asaClass ? [`su ASA ${cap.asaClass}`] : []),
      ...cap.conditions.map((condition) => `su ${condition}`),
      ...(cap.pressure ? [`la presión de hoy (${cap.pressure})`] : []),
    ])
    warnings.push(
      `Por ${why}, la epinefrina hasta ${CARDIAC_EPINEPHRINE_MAX_MG.toLocaleString("es")} mg por sesión: unos ${number(oneDecimal(CARDIAC_EPINEPHRINE_MAX_MG / perCartridge))} cartuchos de este anestésico.`,
    )
  }
  // Con cualquier anestésico: la presión de hoy dice si está controlada y si lo electivo se difiere.
  if (input.epinephrine?.takePressure)
    warnings.push(`Con su ${input.epinephrine.takePressure}, toma la presión antes de anestesiar.`)
  const weight = input.weightKg
  if (weight === null || weight === undefined || !(weight > 0)) return { dose: null, warnings }
  const max = maxLocalAnestheticDose(weight, anesthetic)
  const mg = max.capped ? `${number(max.mg)} mg (el tope)` : `${number(max.mg)} mg`
  return {
    dose: `Máximo para ${number(weight)} kg con ${anesthetic.name} (cartucho de ${number(CARTRIDGE_ML)} mL): ${mg}, unos ${number(max.cartridges)} cartuchos`,
    warnings,
  }
}

/**
 * Una enfermedad del corazón o de la presión registrada con su código: CIE-10 I00–I52 (fiebre
 * reumática, hipertensión, isquemia, corazón pulmonar y otras del corazón) o CIE-11 BA00–BC9Z y
 * la insuficiencia cardiaca (BD1x). Lo cerebrovascular y lo de las arterias no cuentan aquí. Para
 * el tope de epinefrina se quita la hipertensión sin insuficiencia cardiaca
 * (`isHypertensionWithoutHeartFailure`).
 */
export function isCardiacCondition(
  system: string | null | undefined,
  code: string | null | undefined,
): boolean {
  if (!code) return false
  if (system === "ICD-11") return /^(B[ABC]|BD1)/.test(code)
  return /^I(0\d|[1-4]\d|5[0-2])/.test(code)
}

/**
 * La hipertensión registrada con su código: CIE-10 I10–I15 (enfermedades hipertensivas) o CIE-11
 * BA00–BA04. Pide tomar la presión antes de anestesiar. Verificar los rangos de la CIE-11 en el
 * navegador de la OMS.
 */
export function isHypertension(system: string | null | undefined, code: string | null | undefined): boolean {
  if (!code) return false
  if (system === "ICD-11") return /^BA0[0-4]/.test(code)
  return /^I1[0-5]/.test(code)
}

/**
 * La hipertensión que por sí sola no lleva el tope de epinefrina: la que no dice insuficiencia
 * cardiaca. En la CIE-10 de la OMS (versión 2019, cap. IX, «Enfermedades hipertensivas» I10–I15):
 * I10 (esencial), I11.9 (cardiopatía hipertensiva sin insuficiencia cardiaca), I12.x (enfermedad
 * renal hipertensiva), I13.1 (cardiorrenal con insuficiencia renal, sin la cardiaca) e I15.x
 * (secundaria). En la CIE-11 (MMS), lo mismo: BA00 (esencial), BA02 (enfermedad renal
 * hipertensiva) y BA04 (secundaria); BA01 y BA03 nombran la cardiopatía y, sin saber si hay
 * insuficiencia cardiaca, llevan el tope como I11 e I13 sin detalle. Las demás sí lo llevan: I11.0 e
 * I13.0 dicen «con insuficiencia cardiaca (congestiva)», I13.2 «con insuficiencia cardiaca e
 * insuficiencia renal», y en I11, I13 o I13.9 sin detalle no se sabe; la insuficiencia cardiaca
 * es enfermedad cardiovascular importante, con el tope de 0,04 mg (Malamed SF, *Handbook of Local
 * Anesthesia*, 7.ª ed., 2020, evaluación física, enfermedad cardiovascular; verificar la página).
 * Es un aviso: decide el profesional.
 */
export function isHypertensionWithoutHeartFailure(
  system: string | null | undefined,
  code: string | null | undefined,
): boolean {
  if (!code) return false
  if (system === "ICD-11") return /^BA0[024]/.test(code)
  return /^I(10|11\.?9|12|13\.?1|15)/.test(code)
}

/** La clasificación ASA que se elige en el consultorio (ASA 2020): V y VI no son de consultorio. */
export const OFFICE_ASA_CLASSES = ["I", "II", "III", "IV"] as const
export type OfficeAsaClass = (typeof OFFICE_ASA_CLASSES)[number]

/** ASA III o IV: el paciente con enfermedad sistémica grave, para el tope de epinefrina. */
export function isSevereAsa(asaClass: string | null | undefined): boolean {
  return asaClass === "III" || asaClass === "IV" || asaClass === "V" || asaClass === "VI"
}

/**
 * Lo de hoy que usa anestesia, separado: los procedimientos y los anestésicos de sus materiales
 * (`isLocalAnestheticName`). La línea decía «Para Exodoncia simple y Lidocaína 2 % con
 * epinefrina» y mezclaba un material con los procedimientos (auditor, 18 nov, H7). Lo firmado
 * antes guarda las dos cosas en `uses`: se separan al leerlo.
 */
export function anesthesiaUsesParts(uses: readonly string[]): { procedures: string[]; anesthetics: string[] } {
  const anesthetics = uses.filter((use) => isLocalAnestheticName(use))
  return { procedures: uses.filter((use) => !anesthetics.includes(use)), anesthetics }
}

/**
 * El peso para el máximo de anestesia: el de esta atención o, si no se anotó, el último anotado
 * hoy en otra atención no anulada de la persona (QA del 18 nov: la segunda atención del mismo día
 * volvía a pedirlo media hora después). El peso no cambia en el día. La presión sí, y la que
 * limita la epinefrina es la de esta atención: no se trae de otra.
 */
export function anesthesiaWeightKg(
  own: number | null | undefined,
  sameDay: ReadonlyArray<{ status: string; weightKg: unknown; startedAt: string | Date }>,
): { kg: number | null; fromOther: boolean } {
  if (typeof own === "number" && own > 0) return { kg: own, fromOther: false }
  const other = sameDay
    .filter((row) => row.status !== "anulada" && typeof row.weightKg === "number" && row.weightKg > 0)
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0]
  return other ? { kg: other.weightKg as number, fromOther: true } : { kg: null, fromOther: false }
}

/**
 * Lo que la atención firmada guarda de la anestesia de ese día (auditor, 16 nov, H5): con qué
 * ASA, qué peso y qué máximo se anestesió. Lo escribe la firma y no cambia después.
 */
export interface AnesthesiaAtSigning {
  /** Lo de hoy que usa anestesia local: sus servicios, o los anestésicos de sus materiales. */
  uses: string[]
  /** La ASA al firmar; nula sin clasificar o donde el producto no la pide. */
  asaClass: string | null
  /** La de antes, si se clasificó en esta atención (nula: estaba sin clasificar). */
  asaBefore?: string | null
  /** Quién la clasificó y cuándo (ISO 8601), si se sabe. */
  asaSetBy: string | null
  asaSetAt: string | null
  weightKg: number | null
  /** El anestésico elegido para el cálculo («Lidocaína 2 % con epinefrina 1:100 000»). */
  anesthetic: string | null
  /** «Máximo para 22 kg con…»; nulo sin peso. */
  dose: string | null
  warnings: string[]
}

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
 */

/** El cartucho dental: 1,8 mL. */
export const CARTRIDGE_ML = 1.8

/** Epinefrina por sesión en el paciente cardiópata (Malamed): 0,04 mg. */
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

/**
 * Por qué se limita la epinefrina, como lo dice la ficha: una enfermedad del corazón o de la
 * presión registrada con su código, la ASA III o IV, o las dos. El aviso nombra el motivo
 * verdadero (QA del 16 nov, Q10: decía «Con su corazón…» a una paciente con ASA III y sin ninguna
 * cardiopatía registrada).
 */
export interface EpinephrineCap {
  condition: boolean
  /** La ASA que lo pide (III o más); nula si es solo por la enfermedad registrada. */
  asaClass: string | null
}

/** El tope de epinefrina de esa persona, o nulo si nada de su ficha lo pide. */
export function epinephrineCapOf(input: {
  cardiacCondition: boolean
  asaClass: string | null | undefined
}): EpinephrineCap | null {
  const asaClass = isSevereAsa(input.asaClass) ? (input.asaClass ?? null) : null
  return input.cardiacCondition || asaClass ? { condition: input.cardiacCondition, asaClass } : null
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
  /** Cardiopatía registrada o ASA III o IV: el tope de epinefrina, con su motivo (`epinephrineCapOf`). */
  cardiac: EpinephrineCap | null
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
  if (input.cardiac && anesthetic.epinephrineMgPerMl) {
    const perCartridge = anesthetic.epinephrineMgPerMl * CARTRIDGE_ML
    const why = [
      input.cardiac.condition ? "su enfermedad cardiovascular registrada" : null,
      input.cardiac.asaClass ? `su ASA ${input.cardiac.asaClass}` : null,
    ]
      .filter(Boolean)
      .join(" y ")
    warnings.push(
      `Por ${why}, la epinefrina hasta ${CARDIAC_EPINEPHRINE_MAX_MG.toLocaleString("es")} mg por sesión: unos ${number(oneDecimal(CARDIAC_EPINEPHRINE_MAX_MG / perCartridge))} cartuchos de este anestésico.`,
    )
  }
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
 * Una cardiopatía o la hipertensión registradas con su código: CIE-10 I00–I52 (fiebre reumática,
 * hipertensión, isquemia, corazón pulmonar y otras del corazón) o CIE-11 BA00–BC9Z y la
 * insuficiencia cardiaca (BD1x). Lo cerebrovascular y lo de las arterias no cuentan aquí.
 */
export function isCardiacCondition(
  system: string | null | undefined,
  code: string | null | undefined,
): boolean {
  if (!code) return false
  if (system === "ICD-11") return /^(B[ABC]|BD1)/.test(code)
  return /^I(0\d|[1-4]\d|5[0-2])/.test(code)
}

/** La clasificación ASA que se elige en el consultorio (ASA 2020): V y VI no son de consultorio. */
export const OFFICE_ASA_CLASSES = ["I", "II", "III", "IV"] as const
export type OfficeAsaClass = (typeof OFFICE_ASA_CLASSES)[number]

/** ASA III o IV: el paciente con enfermedad sistémica grave, para el tope de epinefrina. */
export function isSevereAsa(asaClass: string | null | undefined): boolean {
  return asaClass === "III" || asaClass === "IV" || asaClass === "V" || asaClass === "VI"
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

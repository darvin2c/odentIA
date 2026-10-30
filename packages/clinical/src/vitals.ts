/**
 * Signos vitales de la atención. Cada uno se identifica con su código LOINC
 * (perfil de signos vitales de HL7 FHIR) y su unidad UCUM, para poder
 * intercambiarlos sin traducir. Los rangos son de plausibilidad para atrapar
 * errores de digitación, no de normalidad clínica.
 */
export const VITAL_SIGNS = [
  {
    key: "presionSistolica",
    loinc: "8480-6",
    unit: "mm[Hg]",
    label: "PA sistólica",
    suffix: "mmHg",
    min: 50,
    max: 260,
    decimals: 0,
  },
  {
    key: "presionDiastolica",
    loinc: "8462-4",
    unit: "mm[Hg]",
    label: "PA diastólica",
    suffix: "mmHg",
    min: 30,
    max: 160,
    decimals: 0,
  },
  {
    key: "frecuenciaCardiaca",
    loinc: "8867-4",
    unit: "/min",
    label: "Frecuencia cardiaca",
    suffix: "lpm",
    min: 20,
    max: 250,
    decimals: 0,
  },
  {
    key: "frecuenciaRespiratoria",
    loinc: "9279-1",
    unit: "/min",
    label: "Frecuencia respiratoria",
    suffix: "rpm",
    min: 5,
    max: 80,
    decimals: 0,
  },
  {
    key: "temperatura",
    loinc: "8310-5",
    unit: "Cel",
    label: "Temperatura",
    suffix: "°C",
    min: 30,
    max: 45,
    decimals: 1,
  },
  {
    key: "saturacionOxigeno",
    loinc: "59408-5",
    unit: "%",
    label: "Saturación de O₂",
    suffix: "%",
    min: 50,
    max: 100,
    decimals: 0,
  },
  {
    key: "peso",
    loinc: "29463-7",
    unit: "kg",
    label: "Peso",
    suffix: "kg",
    min: 0.5,
    max: 400,
    decimals: 1,
  },
  {
    key: "talla",
    loinc: "8302-2",
    unit: "cm",
    label: "Talla",
    suffix: "cm",
    min: 30,
    max: 250,
    decimals: 0,
  },
  // Los que solo registra el producto que los pide (latidIA, decisión 6 del issue 229).
  {
    key: "perimetroCefalico",
    loinc: "9843-4",
    unit: "cm",
    label: "Perímetro cefálico",
    suffix: "cm",
    min: 20,
    max: 70,
    decimals: 1,
  },
  {
    key: "glucosaCapilar",
    loinc: "41653-7",
    unit: "mg/dL",
    label: "Glucosa capilar",
    suffix: "mg/dL",
    min: 20,
    max: 600,
    decimals: 0,
  },
] as const

export type VitalSignKey = (typeof VITAL_SIGNS)[number]["key"]
export type Vitals = Partial<Record<VitalSignKey, number>>

/** Los que registra toda clínica: los ocho del perfil de signos vitales de siempre. */
export const CORE_VITAL_KEYS: readonly VitalSignKey[] = [
  "presionSistolica",
  "presionDiastolica",
  "frecuenciaCardiaca",
  "frecuenciaRespiratoria",
  "temperatura",
  "saturacionOxigeno",
  "peso",
  "talla",
]

/** El índice de masa corporal (LOINC 39156-5, kg/m²): sale del peso y la talla, no se guarda. */
export const BMI_LOINC = "39156-5"

/** IMC con un decimal; null si falta el peso o la talla. */
export function bodyMassIndex(vitals: Vitals | null | undefined): number | null {
  const weight = vitals?.peso
  const height = vitals?.talla
  if (weight === undefined || height === undefined) return null
  const meters = height / 100
  return Math.round((weight / (meters * meters)) * 10) / 10
}

/**
 * Valida y normaliza los signos vitales: solo claves conocidas, números
 * dentro del rango de plausibilidad y con los decimales de su medida. La
 * presión se registra completa (sistólica y diastólica) o no se registra.
 * Devuelve el mensaje del primer error o los valores limpios. `allowed` son
 * los que registra el producto de la clínica; por omisión, todos.
 */
export function parseVitals(
  input: unknown,
  allowed: readonly VitalSignKey[] = VITAL_SIGNS.map((v) => v.key),
): { ok: true; value: Vitals | null } | { ok: false; error: string } {
  if (input === null || input === undefined) return { ok: true, value: null }
  if (typeof input !== "object" || Array.isArray(input))
    return { ok: false, error: "Los signos vitales deben ser un objeto" }
  const out: Vitals = {}
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    const def = VITAL_SIGNS.find((v) => v.key === key && allowed.includes(v.key))
    if (!def) return { ok: false, error: `Signo vital desconocido: ${key}` }
    if (raw === null || raw === undefined || raw === "") continue
    const value = typeof raw === "number" ? raw : Number(raw)
    if (!Number.isFinite(value)) return { ok: false, error: `${def.label} debe ser un número` }
    if (value < def.min || value > def.max)
      return {
        ok: false,
        error: `${def.label} fuera de rango (${def.min}–${def.max} ${def.suffix})`,
      }
    const factor = 10 ** def.decimals
    out[def.key] = Math.round(value * factor) / factor
  }
  const hasSys = out.presionSistolica !== undefined
  const hasDia = out.presionDiastolica !== undefined
  if (hasSys !== hasDia)
    return { ok: false, error: "Registra la presión arterial completa: sistólica y diastólica" }
  if (hasSys && hasDia && (out.presionSistolica as number) <= (out.presionDiastolica as number))
    return { ok: false, error: "La presión sistólica debe ser mayor que la diastólica" }
  return { ok: true, value: Object.keys(out).length > 0 ? out : null }
}

/**
 * Lo mismo que `parseVitals`, pero dicho por signo: la clave del signo que hay
 * que corregir → su mensaje, para marcarlo junto a su campo. La presión
 * incompleta va en la que falta; la sistólica no mayor, en la sistólica.
 * Vacío: todo bien.
 */
export function vitalsErrors(
  input: Record<string, unknown> | null | undefined,
  allowed: readonly VitalSignKey[] = VITAL_SIGNS.map((v) => v.key),
): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!input) return errors
  for (const [key, raw] of Object.entries(input)) {
    const one = parseVitals({ [key]: raw }, allowed)
    if (!one.ok) errors[key] = one.error
  }
  if (Object.keys(errors).length > 0) return errors
  const whole = parseVitals(input, allowed)
  if (whole.ok) return errors
  const diastolic = input.presionDiastolica
  const key: VitalSignKey =
    diastolic === null || diastolic === undefined || diastolic === "" ? "presionDiastolica" : "presionSistolica"
  errors[key] = whole.error
  return errors
}

/** «PA 120/80 mmHg · FC 72 lpm · T 36.5 °C». */
export function formatVitals(vitals: Vitals | null | undefined): string {
  if (!vitals) return ""
  const parts: string[] = []
  if (vitals.presionSistolica !== undefined && vitals.presionDiastolica !== undefined)
    parts.push(`PA ${vitals.presionSistolica}/${vitals.presionDiastolica} mmHg`)
  const short: Partial<Record<VitalSignKey, string>> = {
    frecuenciaCardiaca: "FC",
    frecuenciaRespiratoria: "FR",
    temperatura: "T",
    saturacionOxigeno: "SatO₂",
    peso: "Peso",
    talla: "Talla",
    perimetroCefalico: "PC",
    glucosaCapilar: "Glucosa",
  }
  for (const def of VITAL_SIGNS) {
    const value = vitals[def.key]
    const label = short[def.key]
    if (value === undefined || !label) continue
    parts.push(`${label} ${value} ${def.suffix}`)
  }
  return parts.join(" · ")
}

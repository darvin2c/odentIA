/**
 * Signos vitales de la atención. Cada uno se identifica con su código LOINC
 * (perfil de signos vitales de HL7 FHIR) y su unidad UCUM, para poder
 * intercambiarlos sin traducir. Los rangos son de lo habitual, para avisar de
 * un posible error de digitación, no de normalidad clínica: un valor real
 * extremo (una glucosa de 650, una saturación de 48 %) se guarda con un aviso
 * (`vitalsWarnings`). Solo se rechaza lo que no es una medida (26 nov: nada lo
 * decide el sistema).
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

/** Un signo solo: que se conozca, que sea una medida (un número mayor que 0) y con sus decimales; vacío es null. */
function parseSign(
  key: string,
  raw: unknown,
  allowed: readonly VitalSignKey[],
): { ok: true; key: VitalSignKey; value: number | null } | { ok: false; error: string } {
  const def = VITAL_SIGNS.find((v) => v.key === key && allowed.includes(v.key))
  if (!def) return { ok: false, error: `Signo vital desconocido: ${key}` }
  if (raw === null || raw === undefined || raw === "") return { ok: true, key: def.key, value: null }
  const value = typeof raw === "number" ? raw : Number(raw)
  if (!Number.isFinite(value)) return { ok: false, error: `${def.label} debe ser un número` }
  if (value <= 0) return { ok: false, error: `${def.label} debe ser un número mayor que 0` }
  const factor = 10 ** def.decimals
  return { ok: true, key: def.key, value: Math.round(value * factor) / factor }
}

/**
 * Lee los signos vitales para guardarlos: solo claves conocidas, que sean una
 * medida y con los decimales de su medida. Lo fuera de lo habitual y la
 * presión a medias se guardan: los avisa `vitalsWarnings`. Devuelve el mensaje
 * del primer error o los valores limpios. `allowed` son los que registra el
 * producto de la clínica; por omisión, todos.
 */
export function readVitals(
  input: unknown,
  allowed: readonly VitalSignKey[] = VITAL_SIGNS.map((v) => v.key),
): { ok: true; value: Vitals | null } | { ok: false; error: string } {
  if (input === null || input === undefined) return { ok: true, value: null }
  if (typeof input !== "object" || Array.isArray(input))
    return { ok: false, error: "Los signos vitales deben ser un objeto" }
  const out: Vitals = {}
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    const one = parseSign(key, raw, allowed)
    if (!one.ok) return one
    if (one.value !== null) out[one.key] = one.value
  }
  return { ok: true, value: Object.keys(out).length > 0 ? out : null }
}

/**
 * Lo mismo que `readVitals` y, además, que cada signo esté dentro de lo
 * habitual y la presión completa y bien ordenada: si no, devuelve su mensaje.
 * No decide qué se guarda (eso es `readVitals`): lo usa lo dictado para dejar
 * por revisar una medida que conviene mirar antes de confirmarla.
 */
export function parseVitals(
  input: unknown,
  allowed: readonly VitalSignKey[] = VITAL_SIGNS.map((v) => v.key),
): { ok: true; value: Vitals | null } | { ok: false; error: string } {
  const read = readVitals(input, allowed)
  if (!read.ok || !read.value) return read
  for (const [key, value] of Object.entries(read.value)) {
    const def = VITAL_SIGNS.find((v) => v.key === key)!
    if (value < def.min || value > def.max)
      return { ok: false, error: `${def.label} fuera de rango (${def.min}–${def.max} ${def.suffix})` }
  }
  const hasSys = read.value.presionSistolica !== undefined
  const hasDia = read.value.presionDiastolica !== undefined
  if (hasSys !== hasDia)
    return { ok: false, error: "Registra la presión arterial completa: sistólica y diastólica" }
  if (hasSys && hasDia && (read.value.presionSistolica as number) <= (read.value.presionDiastolica as number))
    return { ok: false, error: "La presión sistólica debe ser mayor que la diastólica" }
  return read
}

/**
 * Lo mismo que `readVitals`, pero dicho por signo: la clave del signo que hay
 * que corregir → su mensaje, para marcarlo junto a su campo. Vacío: todo bien.
 */
export function vitalsErrors(
  input: Record<string, unknown> | null | undefined,
  allowed: readonly VitalSignKey[] = VITAL_SIGNS.map((v) => v.key),
): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!input) return errors
  for (const [key, raw] of Object.entries(input)) {
    const one = parseSign(key, raw, allowed)
    if (!one.ok) errors[key] = one.error
  }
  return errors
}

/**
 * Lo que se guarda pero conviene revisar, por signo (26 nov): lo fuera de lo habitual («Aviso: 650
 * mg/dL está fuera de lo habitual (20–600 mg/dL): revísalo.»), la presión con una sola de sus dos
 * cifras y la sistólica que no es mayor que la diastólica. Avisa y no frena: decide el profesional.
 * Lo que no es una medida no está aquí: es un error (`vitalsErrors`).
 */
export function vitalsWarnings(
  input: Record<string, unknown> | null | undefined,
  allowed: readonly VitalSignKey[] = VITAL_SIGNS.map((v) => v.key),
): Record<string, string> {
  const warnings: Record<string, string> = {}
  if (!input) return warnings
  const out: Vitals = {}
  for (const [key, raw] of Object.entries(input)) {
    const one = parseSign(key, raw, allowed)
    if (!one.ok || one.value === null) continue
    out[one.key] = one.value
    const def = VITAL_SIGNS.find((v) => v.key === one.key)!
    if (one.value < def.min || one.value > def.max)
      warnings[one.key] =
        `Aviso: ${one.value} ${def.suffix} está fuera de lo habitual (${def.min}–${def.max} ${def.suffix}): revísalo.`
  }
  const systolic = out.presionSistolica
  const diastolic = out.presionDiastolica
  if (systolic !== undefined && diastolic === undefined)
    warnings.presionDiastolica = "Aviso: falta la diastólica. Se guarda la sistólica sola."
  else if (systolic === undefined && diastolic !== undefined)
    warnings.presionSistolica = "Aviso: falta la sistólica. Se guarda la diastólica sola."
  else if (systolic !== undefined && diastolic !== undefined && systolic <= diastolic && !warnings.presionSistolica)
    warnings.presionSistolica = "Aviso: la sistólica no es mayor que la diastólica: revísalo."
  return warnings
}

/**
 * La presión que pide repetir la toma y pensar antes de lo electivo (QA del 16 nov): sistólica de
 * 180 o más, o diastólica de 110 o más. Es un aviso, no una traba: decide el profesional.
 *
 * Fuentes: Little JW, Miller CS, Rhodus NL, *Little and Falace's Dental Management of the
 * Medically Compromised Patient*, 9.ª ed., 2018, cap. 3 (Hipertensión): con 180/110 o más se
 * difiere la atención electiva y se deriva (verificar la página); ACC/AHA 2017 (Whelton y col.,
 * Hypertension 2018;71:e13-e115): con síntomas de daño de órgano es una emergencia; AHA
 * (Muntner y col., Hypertension 2019;73:e35-e66): una toma aislada sobreestima, se repite.
 */
export const BLOOD_PRESSURE_DEFER = { systolic: 180, diastolic: 110 } as const

/**
 * Desde qué edad valen los cortes del adulto: la AAP 2017 (Flynn y col., Pediatrics
 * 2017;140:e20171904) los usa desde los 13 años. Antes se juzga por percentiles de edad, sexo y
 * talla, y no hay un corte fijo que se pueda afirmar: no se avisa.
 */
export const ADULT_BLOOD_PRESSURE_FROM_AGE = 13

/**
 * «Aviso: 185/115 mmHg. Repite la toma…», o null si no hace falta. Sin la edad (sin fecha de
 * nacimiento) se avisa: callar ante 185/115 por un dato que falta sería peor que avisar de más.
 */
export function bloodPressureAlert(
  vitals: Vitals | null | undefined,
  ageYears: number | null | undefined,
): string | null {
  const systolic = vitals?.presionSistolica
  const diastolic = vitals?.presionDiastolica
  if (systolic === undefined || diastolic === undefined) return null
  if (ageYears !== null && ageYears !== undefined && ageYears < ADULT_BLOOD_PRESSURE_FROM_AGE) return null
  if (systolic < BLOOD_PRESSURE_DEFER.systolic && diastolic < BLOOD_PRESSURE_DEFER.diastolic) return null
  return `Aviso: ${systolic}/${diastolic} mmHg. Repite la toma. Con ${BLOOD_PRESSURE_DEFER.systolic}/${BLOOD_PRESSURE_DEFER.diastolic} o más, lo electivo se suele diferir. Con dolor de pecho, dolor de cabeza fuerte o falta de aire, es una urgencia.`
}

/** «PA 120/80 mmHg · FC 72 lpm · T 36.5 °C». */
export function formatVitals(vitals: Vitals | null | undefined): string {
  if (!vitals) return ""
  const parts: string[] = []
  if (vitals.presionSistolica !== undefined && vitals.presionDiastolica !== undefined)
    parts.push(`PA ${vitals.presionSistolica}/${vitals.presionDiastolica} mmHg`)
  // Una sola de las dos (lo dictado a medias, por revisar): se ve cuál falta, no una línea vacía.
  else if (vitals.presionSistolica !== undefined) parts.push(`PA ${vitals.presionSistolica}/? mmHg`)
  else if (vitals.presionDiastolica !== undefined) parts.push(`PA ?/${vitals.presionDiastolica} mmHg`)
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

/** Los signos que dicta odentIA (mesa del 25 nov, entrega 3, decisión 6): lo que cambia la anestesia o avisa. */
export const DENTAL_DICTATED_VITAL_KEYS: readonly VitalSignKey[] = ["peso", "presionSistolica", "presionDiastolica"]

/**
 * Lo que puede pesar alguien a su edad, con márgenes muy amplios por encima y por debajo de las
 * curvas de peso para la edad de la OMS (0–5 años, Child Growth Standards; 5–19, Growth Reference
 * 2007): fuera de eso no es un niño muy grande o muy chico, es un error al anotarlo o al dictarlo
 * («230» en vez de «23»). Desde los 18 vale el rango de plausibilidad de siempre (`VITAL_SIGNS`).
 */
// Los topes dejan lugar a la obesidad grave de un niño (revisión del 25 nov): entre los 14 y los 17
// vale el tope de un adulto; lo que se busca es «230» en vez de «23», no a un niño grande.
const WEIGHT_FOR_AGE: ReadonlyArray<{ below: number; min: number; max: number }> = [
  { below: 1, min: 0.5, max: 20 },
  { below: 3, min: 4, max: 35 },
  { below: 6, min: 6, max: 70 },
  { below: 10, min: 9, max: 130 },
  { below: 14, min: 14, max: 200 },
  { below: 18, min: 20, max: 400 },
]

/**
 * «230 kg no es un peso posible a los 7 años: revísalo antes de usarlo.» (mesa del 25 nov, entrega
 * 3), o null si el peso es posible para su edad o no se sabe la edad. Avisa antes de que el peso se
 * use (la dosis máxima de anestesia, la receta de un niño), no lo corrige.
 */
export function weightForAgeAlert(weightKg: number | null | undefined, ageYears: number | null | undefined): string | null {
  if (weightKg === null || weightKg === undefined || !(weightKg > 0) || ageYears === null || ageYears === undefined || ageYears < 0) return null
  const band = WEIGHT_FOR_AGE.find((one) => ageYears < one.below)
  if (!band || (weightKg >= band.min && weightKg <= band.max)) return null
  const years = Math.floor(ageYears)
  const age = years < 1 ? "antes del año" : years === 1 ? "con 1 año" : `a los ${years} años`
  return `${weightKg.toLocaleString("es")} kg no es un peso posible ${age}: revísalo antes de usarlo.`
}

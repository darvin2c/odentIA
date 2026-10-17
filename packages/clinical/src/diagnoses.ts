/**
 * Listas de diagnósticos (decisión 26 de la fase 4, ADR 0041). Cada código se
 * guarda con su lista (`system`) y el código; la edición la dice el catálogo.
 * La clínica elige con qué lista trabaja (CIE-10 o CIE-11 de la OMS); al
 * crearla viene la que recomienda su país (`clinicalProfileFor`). Nunca se
 * calcula un código de una lista a partir de la otra: la tabla de la OMS no
 * sirve para convertir datos.
 *
 * Las listas nacionales (la CIE-10 del MINSA, la CIE-10-ES) son sistemas
 * aparte, preparados pero sin cargar: entran cuando haya un archivo oficial y
 * permiso para usarlo.
 */

export const DIAGNOSIS_SYSTEMS = ["ICD-10", "ICD-11", "ICD-10-PE", "ICD-10-ES"] as const
export type DiagnosisSystemKey = (typeof DIAGNOSIS_SYSTEMS)[number]
/** Las que hoy puede elegir una clínica en «Datos de la clínica». */
export const SELECTABLE_DIAGNOSIS_SYSTEMS = [
  "ICD-10",
  "ICD-11",
] as const satisfies readonly DiagnosisSystemKey[]
export type SelectableDiagnosisSystem = (typeof SELECTABLE_DIAGNOSIS_SYSTEMS)[number]

export interface DiagnosisSystemInfo {
  key: DiagnosisSystemKey
  /** Nombre completo: «CIE-10 (OMS)». */
  title: string
  /** Cómo se antepone al código en pantalla: «CIE-10 · K02.1». */
  short: string
  /** URI canónica del sistema (HL7 FHIR `Coding.system`). */
  uri: string
  /** País de una lista nacional; null en las de la OMS. */
  country: string | null
}

export const DIAGNOSIS_SYSTEM_INFO: Record<DiagnosisSystemKey, DiagnosisSystemInfo> = {
  "ICD-10": {
    key: "ICD-10",
    title: "CIE-10 (OMS)",
    short: "CIE-10",
    uri: "http://hl7.org/fhir/sid/icd-10",
    country: null,
  },
  "ICD-11": {
    key: "ICD-11",
    title: "CIE-11 (OMS)",
    short: "CIE-11",
    uri: "http://id.who.int/icd/release/11/mms",
    country: null,
  },
  "ICD-10-PE": {
    key: "ICD-10-PE",
    title: "CIE-10 MINSA",
    short: "CIE-10 MINSA",
    uri: "urn:odentia:diagnosis:icd-10-pe",
    country: "PE",
  },
  "ICD-10-ES": {
    key: "ICD-10-ES",
    title: "CIE-10-ES",
    short: "CIE-10-ES",
    uri: "urn:odentia:diagnosis:icd-10-es",
    country: "ES",
  },
}

export function isDiagnosisSystem(value: unknown): value is DiagnosisSystemKey {
  return typeof value === "string" && (DIAGNOSIS_SYSTEMS as readonly string[]).includes(value)
}

export function isSelectableDiagnosisSystem(value: unknown): value is SelectableDiagnosisSystem {
  return (
    typeof value === "string" && (SELECTABLE_DIAGNOSIS_SYSTEMS as readonly string[]).includes(value)
  )
}

/** «CIE-10 · K02.1»: el código con su lista, como se lee en la historia. */
export function diagnosisCodeLabel(
  system: string | null | undefined,
  code: string | null | undefined,
): string {
  if (!code) return ""
  const info = isDiagnosisSystem(system) ? DIAGNOSIS_SYSTEM_INFO[system] : null
  return info ? `${info.short} · ${code}` : code
}

/**
 * Tipo del diagnóstico con HL7 FHIR `Condition.verificationStatus`:
 * provisional («Presuntivo») o confirmed («Definitivo»). «Ya diagnosticado
 * antes» no se elige: lo marca el sistema (decisión 11).
 */
export const DIAGNOSIS_VERIFICATION = ["provisional", "confirmed"] as const
export type DiagnosisVerification = (typeof DIAGNOSIS_VERIFICATION)[number]
export const DIAGNOSIS_VERIFICATION_LABELS: Record<DiagnosisVerification, string> = {
  provisional: "Presuntivo",
  confirmed: "Definitivo",
}
export const FHIR_CONDITION_VERIFICATION_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/condition-ver-status"

export function isDiagnosisVerification(value: unknown): value is DiagnosisVerification {
  return typeof value === "string" && (DIAGNOSIS_VERIFICATION as readonly string[]).includes(value)
}

/**
 * Tipo del diagnóstico en la hoja del registro HIS del MINSA (solo en los
 * perfiles con `diagnosis.officialRecordTypes`): P presuntivo, D definitivo y
 * R repetido, que es el definitivo de un código que la persona ya tenía en la
 * misma lista.
 */
export function hisDiagnosisType(
  verification: string | null | undefined,
  previouslyDiagnosed: boolean,
): "P" | "D" | "R" | null {
  if (verification === "provisional") return "P"
  if (verification === "confirmed") return previouslyDiagnosed ? "R" : "D"
  return null
}

/**
 * Código sin †, *, espacios ni minúsculas; en la CIE-10, el punto que falte
 * después del tercer carácter («K021» → «K02.1»). Los signos † y * son del
 * sistema de doble clasificación de la CIE-10 y no forman parte del código.
 */
export function normalizeDiagnosisCode(system: DiagnosisSystemKey, raw: string): string {
  const code = raw.replace(/[†*✝\s]/g, "").toUpperCase()
  if (system !== "ICD-11" && /^[A-Z][0-9]{2}[0-9X]{1,2}$/.test(code))
    return `${code.slice(0, 3)}.${code.slice(3)}`
  return code
}

const CODE_FORMAT: Record<DiagnosisSystemKey, RegExp> = {
  "ICD-10": /^[A-Z][0-9]{2}(\.[0-9X]{1,2})?$/,
  "ICD-10-PE": /^[A-Z][0-9]{2}(\.[0-9X]{1,2})?$/,
  "ICD-10-ES": /^[A-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$/,
  // CIE-11 MMS: cuatro caracteres de raíz (DA08) y hasta dos niveles tras el punto (DA08.0, NA0D.01).
  "ICD-11": /^[0-9A-HJ-NP-Z]{4}(\.[0-9A-HJ-NP-Z]{1,2})?$/,
}

/** El código tiene la forma de su lista (no dice si existe). */
export function isDiagnosisCodeFormat(system: DiagnosisSystemKey, code: string): boolean {
  return CODE_FORMAT[system].test(code)
}

/**
 * Lo odontológico de cada lista, para mostrarlo primero en el buscador. En la
 * CIE-10: el capítulo de la cavidad bucal, glándulas salivales y maxilares
 * (K00–K14), fracturas y luxaciones de dientes y maxilares (S02.5, S02.6,
 * S03.0, S03.2), heridas del labio y la boca (S01.5), fisuras labiopalatinas
 * (Q35–Q37), herpes y candidiasis de la boca (B00.2, B37.0), tumores del labio
 * y la boca (C00–C06, D10.0–D10.3) y los Z de examen y prótesis dental (Z01.2,
 * Z46.3, Z97.2). En la CIE-11: las afecciones de la boca y los dientes (DA0x)
 * y las lesiones de los dientes (NA0D).
 */
const DENTAL_ICD10: readonly RegExp[] = [
  /^K(0\d|1[0-4])(\.|$)/,
  /^S02\.[56]/,
  /^S03\.[02]/,
  /^S01\.5/,
  /^Q3[5-7](\.|$)/,
  /^B00\.2/,
  /^B37\.0/,
  /^C0[0-6](\.|$)/,
  /^D10\.[0-3]/,
  /^Z01\.2/,
  /^Z46\.3/,
  /^Z97\.2/,
]
const DENTAL_ICD11: readonly RegExp[] = [/^DA0/, /^NA0D/]

export function isDentalDiagnosis(system: DiagnosisSystemKey, code: string): boolean {
  const rules = system === "ICD-11" ? DENTAL_ICD11 : DENTAL_ICD10
  return rules.some((rule) => rule.test(code))
}

/**
 * Texto para buscar sin tildes ni mayúsculas: «Erupción» y «erupcion» se
 * escriben igual. El buscador normaliza la consulta con la misma función.
 */
export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ")
}

/** Lo que se guarda para buscar un código: el código, el código sin punto y el título. */
export function diagnosisSearchText(code: string, title: string): string {
  return normalizeSearchText(`${code} ${code.replace(".", "")} ${title}`)
}

/**
 * El diagnóstico que propone un hallazgo del odontograma, por lista. Solo los
 * hallazgos que son una enfermedad o una lesión proponen código (una
 * restauración o una corona no). Si el código no está cargado en la lista de
 * la clínica, el servicio no lo propone.
 *
 * CIE-10: caries por profundidad (K02.0 esmalte, K02.1 dentina; con
 * compromiso de la pulpa, K02.5 «caries con exposición pulpar», que solo se
 * propone si la edición cargada la trae), fractura S02.5, raíz retenida K08.3,
 * supernumerario K00.1, tamaño o forma K00.2, fluorosis K00.3, impactación
 * K01.1, posición K07.3 y ausencia por extracción K08.1.
 * CIE-11: solo la caries (DA08.0), hasta verificar los demás contra la OMS.
 */
const FINDING_DIAGNOSIS: Partial<
  Record<DiagnosisSystemKey, Record<string, string | Record<string, string>>>
> = {
  "ICD-10": {
    caries: {
      "": "K02.9",
      white_spot: "K02.0",
      enamel: "K02.0",
      dentin: "K02.1",
      pulpal_involvement: "K02.5",
    },
    fracture: "S02.5",
    root_remnant: "K08.3",
    supernumerary_tooth: "K00.1",
    macrodontia: "K00.2",
    microdontia: "K00.2",
    peg_tooth: "K00.2",
    fusion: "K00.2",
    gemination: "K00.2",
    enamel_development_defect: { fluorosis: "K00.3" },
    impaction: "K01.1",
    diastema: "K07.3",
    rotation: "K07.3",
    transposition: "K07.3",
    abnormal_position: "K07.3",
    ectopic_tooth: "K07.3",
    missing_tooth: { caries_extraction: "K08.1" },
  },
  "ICD-11": {
    caries: "DA08.0",
  },
}

export function findingDiagnosisCode(
  system: DiagnosisSystemKey,
  condition: string,
  variant?: string | null,
): string | null {
  const entry = FINDING_DIAGNOSIS[system]?.[condition]
  if (!entry) return null
  if (typeof entry === "string") return entry
  return entry[variant ?? ""] ?? null
}

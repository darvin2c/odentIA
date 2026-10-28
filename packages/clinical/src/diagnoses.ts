/**
 * Listas de diagnósticos (decisión 26 de la fase 4, ADR 0041). Cada código se
 * guarda con su lista (`system`) y el código; la edición la dice el catálogo.
 * La clínica elige con qué lista trabaja (CIE-10 o CIE-11 de la OMS); al
 * crearla viene la que recomienda su país (`clinicalProfileFor`). Nunca se
 * calcula un código de una lista a partir de la otra: la tabla de la OMS no
 * sirve para convertir datos.
 *
 * Las listas nacionales son sistemas aparte, nunca en lugar de la de la OMS.
 * La CIE-10 del MINSA (la que pide el registro HIS) se carga con la hoja que
 * publica el MINSA y es la que se propone en Perú; la CIE-10-ES está
 * preparada pero sin cargar.
 */

export const DIAGNOSIS_SYSTEMS = ["ICD-10", "ICD-11", "ICD-10-PE", "ICD-10-ES"] as const
export type DiagnosisSystemKey = (typeof DIAGNOSIS_SYSTEMS)[number]
/** Las que hoy puede elegir una clínica en «Datos de la clínica». */
export const SELECTABLE_DIAGNOSIS_SYSTEMS = [
  "ICD-10",
  "ICD-11",
  "ICD-10-PE",
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
 * La CIE-10 del MINSA agrega un sexto carácter en unos pocos códigos de
 * planificación familiar («Z30051» → «Z30.051», «Z33X21» → «Z33.X21»).
 */
export function normalizeDiagnosisCode(system: DiagnosisSystemKey, raw: string): string {
  const code = raw.replace(/[†*✝\s]/g, "").toUpperCase()
  const tail = system === "ICD-10-PE" ? /^[A-Z][0-9]{2}[0-9X]{1,3}$/ : /^[A-Z][0-9]{2}[0-9X]{1,2}$/
  if (system !== "ICD-11" && tail.test(code)) return `${code.slice(0, 3)}.${code.slice(3)}`
  return code
}

const CODE_FORMAT: Record<DiagnosisSystemKey, RegExp> = {
  "ICD-10": /^[A-Z][0-9]{2}(\.[0-9X]{1,2})?$/,
  "ICD-10-PE": /^[A-Z][0-9]{2}(\.[0-9X]{1,3})?$/,
  "ICD-10-ES": /^[A-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$/,
  // CIE-11 MMS: cuatro caracteres de raíz (DA08) y hasta dos niveles tras el punto (DA08.0, NA0D.01).
  "ICD-11": /^[0-9A-HJ-NP-Z]{4}(\.[0-9A-HJ-NP-Z]{1,2})?$/,
}

/** El código tiene la forma de su lista (no dice si existe). */
export function isDiagnosisCodeFormat(system: DiagnosisSystemKey, code: string): boolean {
  return CODE_FORMAT[system].test(code)
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
 * K01.1, posición K07.3 y ausencia por extracción K08.1. La CIE-10 del MINSA
 * trae esos mismos códigos (`FINDING_DIAGNOSIS` los comparte).
 * CIE-11, con los títulos de la edición oficial en español (2026-01): caries
 * DA08.0 (la CIE-11 no la divide por profundidad), fractura NA0D.0Z
 * («traumatismo de los tejidos dentales duros y la pulpa, sin
 * especificación», como S02.5 en la CIE-10), raíz retenida DA0A.3, hiperdoncia
 * LA30.3, tamaño o forma LA30.4, fluorosis DA07.0, impactación DA07.8,
 * posición DA0E.3 y pérdida por extracción DA0A.1. Una prueba comprueba que
 * cada uno existe en el archivo oficial incluido en `@odentia/db`.
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
    fracture: "NA0D.0Z",
    root_remnant: "DA0A.3",
    supernumerary_tooth: "LA30.3",
    macrodontia: "LA30.4",
    microdontia: "LA30.4",
    peg_tooth: "LA30.4",
    fusion: "LA30.4",
    gemination: "LA30.4",
    enamel_development_defect: { fluorosis: "DA07.0" },
    impaction: "DA07.8",
    diastema: "DA0E.3",
    rotation: "DA0E.3",
    transposition: "DA0E.3",
    abnormal_position: "DA0E.3",
    ectopic_tooth: "DA0E.3",
    missing_tooth: { caries_extraction: "DA0A.1" },
  },
}

/** Lo que propone el odontograma en una lista; la del MINSA, lo mismo que la CIE-10 de la OMS. */
function findingsOf(system: DiagnosisSystemKey) {
  return FINDING_DIAGNOSIS[system === "ICD-10-PE" ? "ICD-10" : system]
}

/** Todos los códigos que el odontograma puede proponer en una lista (para comprobarlos contra la oficial). */
export function findingDiagnosisCodes(system: DiagnosisSystemKey): string[] {
  const entries = Object.values(findingsOf(system) ?? {})
  return [
    ...new Set(entries.flatMap((entry) => (typeof entry === "string" ? [entry] : Object.values(entry)))),
  ]
}

export function findingDiagnosisCode(
  system: DiagnosisSystemKey,
  condition: string,
  variant?: string | null,
): string | null {
  const entry = findingsOf(system)?.[condition]
  if (!entry) return null
  if (typeof entry === "string") return entry
  return entry[variant ?? ""] ?? null
}

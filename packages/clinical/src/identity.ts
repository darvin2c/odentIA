import { clinicalProfileFor, type IdentityDocType } from "./country-profiles.js"

/**
 * Catálogos de identidad del paciente (ADR 0004 y 0036). Se guardan códigos estables;
 * las etiquetas son para mostrar. Donde hay estándar se documenta su
 * correspondencia para exportar sin traducir.
 */

/**
 * Sexo registrado. Correspondencia con ISO/IEC 5218 y HL7
 * AdministrativeGender: M → 1/male, F → 2/female, I (indeterminado) →
 * 9/other, D (desconocido o no registrado) → 0/unknown.
 */
export const SEX_CODES = ["M", "F", "I", "D"] as const
export type SexCode = (typeof SEX_CODES)[number]
export const SEX_LABELS: Record<SexCode, string> = {
  M: "Masculino",
  F: "Femenino",
  I: "Indeterminado",
  D: "Desconocido",
}

/**
 * Documentos de identidad. Los tipos y sus etiquetas valen en cualquier
 * clínica (un DNI se lee «DNI» también en Bogotá); qué tipos se ofrecen y quién
 * los emite lo dice el país de la clínica (`clinicalProfileFor`). En Perú: DNI
 * (RENIEC), carné de extranjería (Migraciones), pasaporte, certificado de
 * nacido vivo (CNV) y documento de identidad extranjero (DIE).
 */
export const DOC_TYPE_LABELS: Record<IdentityDocType, string> = {
  NACIONAL: "Documento nacional",
  DNI: "DNI",
  CE: "Carné de extranjería",
  PASAPORTE: "Pasaporte",
  CNV: "Certificado de nacido vivo",
  DIE: "Documento de identidad extranjero",
  OTRO: "Otro",
}
/**
 * Un documento como se lee en pantalla, con la etiqueta del catálogo y nunca
 * el código guardado: «Pasaporte AB1234567», «Carné de extranjería 001234567».
 */
export function documentText(docType: string | null | undefined, docNumber: string): string {
  const label = docType ? (DOC_TYPE_LABELS[docType as IdentityDocType] ?? docType) : ""
  return `${label} ${docNumber}`.trim()
}

/** Estado civil (catálogo de RENIEC/INEI). */
export const MARITAL_STATUSES = [
  "soltero",
  "casado",
  "conviviente",
  "viudo",
  "divorciado",
  "separado",
] as const
export const MARITAL_STATUS_LABELS: Record<(typeof MARITAL_STATUSES)[number], string> = {
  soltero: "Soltero(a)",
  casado: "Casado(a)",
  conviviente: "Conviviente",
  viudo: "Viudo(a)",
  divorciado: "Divorciado(a)",
  separado: "Separado(a)",
}

/** Nivel educativo alcanzado (categorías censales del INEI). */
export const EDUCATION_LEVELS = [
  "sin_nivel",
  "inicial",
  "primaria_incompleta",
  "primaria_completa",
  "secundaria_incompleta",
  "secundaria_completa",
  "superior_no_universitaria_incompleta",
  "superior_no_universitaria_completa",
  "superior_universitaria_incompleta",
  "superior_universitaria_completa",
  "posgrado",
] as const
export const EDUCATION_LEVEL_LABELS: Record<(typeof EDUCATION_LEVELS)[number], string> = {
  sin_nivel: "Sin nivel",
  inicial: "Inicial",
  primaria_incompleta: "Primaria incompleta",
  primaria_completa: "Primaria completa",
  secundaria_incompleta: "Secundaria incompleta",
  secundaria_completa: "Secundaria completa",
  superior_no_universitaria_incompleta: "Superior no universitaria incompleta",
  superior_no_universitaria_completa: "Superior no universitaria completa",
  superior_universitaria_incompleta: "Superior universitaria incompleta",
  superior_universitaria_completa: "Superior universitaria completa",
  posgrado: "Posgrado",
}

/** Parentesco del contacto de emergencia o del familiar. */
export const KINSHIP = [
  "madre",
  "padre",
  "hijo",
  "conyuge",
  "hermano",
  "abuelo",
  "tio",
  "otro_familiar",
  "no_familiar",
] as const
export const KINSHIP_LABELS: Record<(typeof KINSHIP)[number], string> = {
  madre: "Madre",
  padre: "Padre",
  hijo: "Hijo(a)",
  conyuge: "Cónyuge o pareja",
  hermano: "Hermano(a)",
  abuelo: "Abuelo(a)",
  tio: "Tío(a)",
  otro_familiar: "Otro familiar",
  no_familiar: "No familiar",
}

export const ISO_COUNTRY_RE = /^[A-Z]{2}$/

function lengthWords(what: string, count: number, expected: number, unit: string): string {
  const diff = expected - count
  return diff > 0
    ? `${what} tiene ${expected} ${unit}; ${diff === 1 ? "falta 1" : `faltan ${diff}`}`
    : `${what} tiene ${expected} ${unit}; ${-diff === 1 ? "sobra 1" : `sobran ${-diff}`}`
}

/**
 * Formato del número según el documento; null si es válido. Los errores dicen
 * qué arreglar («El DNI tiene 8 números; faltan 2»), nunca «formato inválido».
 */
export function identityDocumentError(
  docType: string | null | undefined,
  docNumber: string | null | undefined,
): string | null {
  const value = docNumber?.trim()
  if (!value) return null
  switch (docType) {
    case "DNI":
      if (!/^\d+$/.test(value)) return "El DNI solo lleva números"
      return value.length === 8 ? null : lengthWords("El DNI", value.length, 8, "números")
    case "CE":
      return /^[A-Za-z0-9]{8,12}$/.test(value)
        ? null
        : "El carné de extranjería tiene de 8 a 12 letras o números, sin espacios"
    case "PASAPORTE":
      return /^[A-Za-z0-9]{6,12}$/.test(value)
        ? null
        : "El pasaporte tiene de 6 a 12 letras o números, sin espacios"
    case "CNV":
      return /^\d{6,12}$/.test(value) ? null : "El certificado de nacido vivo tiene de 6 a 12 números"
    case "DIE":
      return /^[A-Za-z0-9-]{4,20}$/.test(value)
        ? null
        : "El documento extranjero tiene de 4 a 20 letras, números o guiones"
    case "NACIONAL":
      // Admite puntos y guion: 12.345.678-5 se escribe así en Chile.
      return /^[A-Za-z0-9][A-Za-z0-9.-]{3,19}$/.test(value)
        ? null
        : "El documento tiene de 4 a 20 letras o números; admite puntos y guion"
    case "OTRO":
      return /^[A-Za-z0-9][A-Za-z0-9. /-]{0,19}$/.test(value)
        ? null
        : "El documento tiene hasta 20 letras o números"
    default:
      return null
  }
}

/** «Rosa María» + «Quispe» + «Huamán» → «Rosa María Quispe Huamán». */
export function composeDisplayName(parts: {
  givenNames?: string | null
  paternalSurname?: string | null
  maternalSurname?: string | null
}): string {
  return [parts.givenNames, parts.paternalSurname, parts.maternalSurname]
    .map((part) => part?.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join(" ")
}

/**
 * Reparte «Apellidos» escritos en un solo campo. Con exactamente dos palabras
 * son paterno y materno; con una, o con más (apellidos compuestos como «De la
 * Cruz»), no se adivina: todo queda como primer apellido y lo separa quien
 * revisa la identidad en la clínica.
 */
export function splitSurnames(raw: string | null | undefined): {
  paternalSurname: string
  maternalSurname: string
} {
  const words = (raw ?? "").trim().split(/\s+/).filter(Boolean)
  if (words.length === 2) return { paternalSurname: words[0]!, maternalSurname: words[1]! }
  return { paternalSurname: words.join(" "), maternalSurname: "" }
}

/**
 * Cómo se reconoce un número nacional escrito sin código de país: lo dice el
 * país de la clínica. Solo figuran los países cuyo formato se ha comprobado;
 * en los demás el número se pide con su código de país (el campo de teléfono
 * de la interfaz ya lo entrega en E.164 para cualquier país).
 */
function nationalPhone(countryCode: string | null | undefined) {
  return clinicalProfileFor(countryCode).phone ?? undefined
}

/**
 * Normaliza un teléfono a E.164 (+código de país y número). Un número
 * nacional sin prefijo solo se completa con el perfil del país de la clínica
 * (`countryCode`, ISO 3166-1 alfa-2); sin país, o si el país no tiene perfil,
 * se exige el código de país. Devuelve null si no puede asegurar el formato;
 * nunca inventa un país.
 */
export function normalizePhone(raw: string | null | undefined, countryCode?: string | null): string | null {
  const value = raw?.trim()
  if (!value) return null
  const digits = value.replace(/[^\d]/g, "")
  if (value.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null
  if (value.startsWith("00") && digits.length > 10) return `+${digits.slice(2)}`
  const profile = nationalPhone(countryCode)
  if (profile) {
    if (profile.national.test(digits)) return `+${profile.callingCode}${digits}`
    if (digits.startsWith(profile.callingCode) && profile.national.test(digits.slice(profile.callingCode.length))) {
      return `+${digits}`
    }
  }
  // Solo dígitos y largo internacional (p. ej. el identificador de WhatsApp):
  // ya trae el código de país, solo falta el «+».
  if (/^[1-9]\d{9,14}$/.test(digits) && digits === value.replace(/\s+/g, "")) return `+${digits}`
  return null
}

/**
 * Qué decir cuando un teléfono no se puede llevar a E.164. Con el país de la
 * clínica se nombra su prefijo y su formato nacional; sin él, el texto no
 * menciona ningún país.
 */
export function phoneFormatError(countryCode?: string | null): string {
  const profile = nationalPhone(countryCode)
  return profile
    ? `Ingresa el teléfono con código de país (+${profile.callingCode}…) o ${profile.hint}`
    : "Ingresa el teléfono con su código de país, empezando por «+»"
}

/** Edad legible: en meses antes de los dos años, en años después. */
export function ageLabel(birthDate: string | null | undefined, today = new Date()): string {
  if (!birthDate || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) return ""
  const [y, m, d] = birthDate.split("-").map(Number) as [number, number, number]
  let months = (today.getFullYear() - y) * 12 + (today.getMonth() + 1 - m)
  if (today.getDate() < d) months -= 1
  if (months < 0) return ""
  if (months < 24) return months === 1 ? "1 mes" : `${months} meses`
  const years = Math.floor(months / 12)
  return `${years} años`
}

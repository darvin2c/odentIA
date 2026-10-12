/**
 * Catálogos de identidad del paciente (ADR 0004). Se guardan códigos estables;
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
 * Documentos de identidad usados en Perú: DNI (RENIEC), carné de extranjería
 * (Migraciones), pasaporte, certificado de nacido vivo (CNV) y documento de
 * identidad extranjero (DIE).
 */
export const IDENTITY_DOC_TYPES = ["DNI", "CE", "PASAPORTE", "CNV", "DIE", "OTRO"] as const
export type IdentityDocType = (typeof IDENTITY_DOC_TYPES)[number]
export const DOC_TYPE_LABELS: Record<IdentityDocType, string> = {
  DNI: "DNI",
  CE: "Carné de extranjería",
  PASAPORTE: "Pasaporte",
  CNV: "Certificado de nacido vivo",
  DIE: "Documento de identidad extranjero",
  OTRO: "Otro",
}
/** Documentos emitidos fuera del Perú: exigen el país emisor (ISO 3166-1 alfa-2). */
export const FOREIGN_DOC_TYPES: readonly IdentityDocType[] = ["PASAPORTE", "DIE"]

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
export const UBIGEO_RE = /^\d{6}$/

/** Formato del número según el documento; null si es válido. */
export function identityDocumentError(
  docType: string | null | undefined,
  docNumber: string | null | undefined,
): string | null {
  const value = docNumber?.trim()
  if (!value) return null
  switch (docType) {
    case "DNI":
      return /^\d{8}$/.test(value) ? null : "El DNI tiene exactamente 8 dígitos"
    case "CE":
      return /^[A-Za-z0-9]{8,12}$/.test(value)
        ? null
        : "El carné de extranjería tiene de 8 a 12 letras o dígitos"
    case "PASAPORTE":
      return /^[A-Za-z0-9]{6,12}$/.test(value)
        ? null
        : "El pasaporte tiene de 6 a 12 letras o dígitos"
    case "CNV":
      return /^\d{6,12}$/.test(value) ? null : "El CNV tiene de 6 a 12 dígitos"
    case "DIE":
      return /^[A-Za-z0-9-]{4,20}$/.test(value)
        ? null
        : "El documento extranjero tiene de 4 a 20 letras, dígitos o guiones"
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
 * Normaliza un teléfono a E.164 (+código de país y número). Un número
 * peruano sin prefijo se reconoce: celular de 9 dígitos que empieza por 9.
 * Devuelve null si no puede asegurar el formato; nunca inventa un país.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  const value = raw?.trim()
  if (!value) return null
  const digits = value.replace(/[^\d]/g, "")
  if (value.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null
  if (value.startsWith("00") && digits.length > 10) return `+${digits.slice(2)}`
  if (/^9\d{8}$/.test(digits)) return `+51${digits}`
  if (/^51\d{9}$/.test(digits)) return `+${digits}`
  // Solo dígitos y largo internacional (p. ej. el identificador de WhatsApp):
  // ya trae el código de país, solo falta el «+».
  if (/^[1-9]\d{9,14}$/.test(digits) && digits === value.replace(/\s+/g, "")) return `+${digits}`
  return null
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

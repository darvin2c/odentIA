import { clinicalProfileFor, type IdentityDocType, type TaxDocType } from "./country-profiles.js"

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
 * Documentos tributarios (los de un proveedor): el genérico del núcleo y el
 * de cada país con perfil. Como los de identidad, se guarda el código.
 */
export const TAX_DOC_TYPE_LABELS: Record<TaxDocType, string> = {
  TRIBUTARIO: "Documento tributario",
  RUC: "RUC",
}

/**
 * Cómo se lee un tipo de documento, de identidad o tributario. Un valor que
 * no es un código conocido (escrito a mano antes de que hubiera lista) se
 * muestra tal cual.
 */
export function documentTypeLabel(docType: string): string {
  if (Object.hasOwn(DOC_TYPE_LABELS, docType)) return DOC_TYPE_LABELS[docType as IdentityDocType]
  if (Object.hasOwn(TAX_DOC_TYPE_LABELS, docType)) return TAX_DOC_TYPE_LABELS[docType as TaxDocType]
  return docType
}
/**
 * Código de cada tipo en la tabla 0203 de HL7 v2 (Identifier Type, CC0;
 * `http://terminology.hl7.org/CodeSystem/v2-0203`), para enviarlo como FHIR
 * `Identifier.type`: pasaporte PPN, carné de extranjería PRC (residente
 * extranjero), certificado de nacido vivo BCT. Un documento nacional (el DNI,
 * el de otro país) es NN más su país emisor en ISO 3166-1 alfa-3 («NNPER»);
 * si no se conoce ese país, NI. «Otro» no tiene código: va solo con su texto.
 */
export const HL7_IDENTIFIER_TYPE_SYSTEM = "http://terminology.hl7.org/CodeSystem/v2-0203"
const FIXED_HL7_DOC: Partial<Record<IdentityDocType, string>> = { PASAPORTE: "PPN", CE: "PRC", CNV: "BCT" }
const NATIONAL_DOCS: ReadonlySet<IdentityDocType> = new Set(["NACIONAL", "DNI", "DIE"])
/** ISO 3166-1 alfa-2 → alfa-3 de los países con los que hoy trabaja odentIA y sus vecinos. */
const ALPHA3: Record<string, string> = {
  AR: "ARG", BO: "BOL", BR: "BRA", CL: "CHL", CO: "COL", CR: "CRI", CU: "CUB", DO: "DOM",
  EC: "ECU", ES: "ESP", GT: "GTM", HN: "HND", MX: "MEX", NI: "NIC", PA: "PAN", PE: "PER",
  PR: "PRI", PY: "PRY", SV: "SLV", US: "USA", UY: "URY", VE: "VEN",
}
export function hl7DocumentTypeCode(
  docType: string | null | undefined,
  issuerCountry?: string | null,
): string | null {
  if (!docType) return null
  const fixed = FIXED_HL7_DOC[docType as IdentityDocType]
  if (fixed) return fixed
  if (!NATIONAL_DOCS.has(docType as IdentityDocType)) return null
  const alpha3 = issuerCountry ? ALPHA3[issuerCountry.trim().toUpperCase()] : undefined
  return alpha3 ? `NN${alpha3}` : "NI"
}

/**
 * Un documento como se lee en pantalla, con la etiqueta del catálogo y nunca
 * el código guardado: «Pasaporte AB1234567», «Carné de extranjería 001234567»,
 * «RUC 20123456789».
 */
export function documentText(docType: string | null | undefined, docNumber: string): string {
  const label = docType ? documentTypeLabel(docType) : ""
  return `${label} ${docNumber}`.trim()
}

/**
 * Estado civil con HL7 v3 MaritalStatus (`http://terminology.hl7.org/CodeSystem/v3-MaritalStatus`):
 * S soltero, M casado, T pareja de hecho (Domestic partner), L separado
 * (Legally Separated), D divorciado y W viudo. El perfil del país puede
 * cambiar una palabra por la suya («Conviviente» en Perú): ese valor se guarda
 * tal cual, con el país delante (`PE:conviviente`), y solo se traduce a HL7 al
 * enviarlo a otro sistema (`maritalStatusToHl7`). Decisión 28 de la fase 4: la
 * tabla v2→FHIR de HL7 lleva «convivencia» y «pareja registrada» a T; C es un
 * tipo de matrimonio y no se usa.
 */
export const HL7_MARITAL_STATUSES = ["S", "M", "T", "L", "D", "W"] as const
export type Hl7MaritalStatus = (typeof HL7_MARITAL_STATUSES)[number]
/** Valores con nombre propio de un país y su código HL7. */
export const NATIONAL_MARITAL_STATUSES = {
  "PE:conviviente": { label: "Conviviente", hl7: "T" },
} as const satisfies Record<string, { label: string; hl7: Hl7MaritalStatus }>
export type NationalMaritalStatus = keyof typeof NATIONAL_MARITAL_STATUSES
export const MARITAL_STATUSES = [
  ...HL7_MARITAL_STATUSES,
  ...(Object.keys(NATIONAL_MARITAL_STATUSES) as NationalMaritalStatus[]),
] as [Hl7MaritalStatus, ...(Hl7MaritalStatus | NationalMaritalStatus)[]]
export type MaritalStatus = Hl7MaritalStatus | NationalMaritalStatus
export const MARITAL_STATUS_LABELS: Record<MaritalStatus, string> = {
  S: "Soltero(a)",
  M: "Casado(a)",
  T: "Pareja de hecho",
  L: "Separado(a)",
  D: "Divorciado(a)",
  W: "Viudo(a)",
  "PE:conviviente": NATIONAL_MARITAL_STATUSES["PE:conviviente"].label,
}
const HL7_MARITAL_DISPLAY: Record<Hl7MaritalStatus, string> = {
  S: "Never Married",
  M: "Married",
  T: "Domestic partner",
  L: "Legally Separated",
  D: "Divorced",
  W: "Widowed",
}
export const HL7_MARITAL_STATUS_SYSTEM = "http://terminology.hl7.org/CodeSystem/v3-MaritalStatus"

/**
 * El estado civil como se envía a otro sistema (FHIR `Patient.maritalStatus`):
 * el código HL7, su nombre y, como texto, la palabra que se eligió en la
 * clínica. «Conviviente» sale como T, con el texto «Conviviente». Null si no
 * hay dato o el valor no se conoce.
 */
export function maritalStatusToHl7(
  value: string | null | undefined,
): { system: string; code: Hl7MaritalStatus; display: string; text: string } | null {
  if (!value) return null
  const national = (NATIONAL_MARITAL_STATUSES as Record<string, { label: string; hl7: Hl7MaritalStatus }>)[value]
  const code = national ? national.hl7 : (HL7_MARITAL_STATUSES as readonly string[]).includes(value) ? (value as Hl7MaritalStatus) : null
  if (!code) return null
  return {
    system: HL7_MARITAL_STATUS_SYSTEM,
    code,
    display: HL7_MARITAL_DISPLAY[code],
    text: MARITAL_STATUS_LABELS[value as MaritalStatus],
  }
}

/**
 * Nivel educativo alcanzado con la CINE 2011 de la UNESCO (ISCED 2011,
 * niveles 0 a 8). Se guarda el número del nivel. Las categorías del censo de
 * un país (INEI en Perú) no se guardan: si un reporte las pidiera, irían como
 * correspondencia en el perfil de ese país.
 */
export const EDUCATION_LEVELS = ["0", "1", "2", "3", "4", "5", "6", "7", "8"] as const
export type EducationLevel = (typeof EDUCATION_LEVELS)[number]
export const EDUCATION_LEVEL_LABELS: Record<EducationLevel, string> = {
  "0": "Sin estudios o solo inicial",
  "1": "Primaria",
  "2": "Secundaria, primer ciclo",
  "3": "Secundaria completa",
  "4": "Postsecundaria no superior",
  "5": "Superior técnica de ciclo corto",
  "6": "Universitaria (grado o licenciatura)",
  "7": "Maestría",
  "8": "Doctorado",
}

/**
 * Parentesco con HL7 v3 RoleCode (PersonalRelationshipRoleType,
 * `http://terminology.hl7.org/CodeSystem/v3-RoleCode`). Se distingue el abuelo
 * materno del paterno. Los antecedentes familiares solo admiten familiares
 * (`FAMILY_KINSHIP`); el contacto de emergencia y las personas vinculadas,
 * también amistades y vecinos.
 */
export const FAMILY_KINSHIP = [
  "MTH",
  "FTH",
  "CHILD",
  "SPS",
  "DOMPART",
  "SIB",
  "MGRPRN",
  "PGRPRN",
  "GRNDCHILD",
  "AUNT",
  "UNCLE",
  "COUSN",
  "FAMMEMB",
] as const
export const KINSHIP = [...FAMILY_KINSHIP, "FRND", "NBOR"] as const
export type Kinship = (typeof KINSHIP)[number]
export type FamilyKinship = (typeof FAMILY_KINSHIP)[number]
export const HL7_ROLE_CODE_SYSTEM = "http://terminology.hl7.org/CodeSystem/v3-RoleCode"
export const KINSHIP_LABELS: Record<Kinship, string> = {
  MTH: "Madre",
  FTH: "Padre",
  CHILD: "Hijo(a)",
  SPS: "Cónyuge",
  DOMPART: "Pareja",
  SIB: "Hermano(a)",
  MGRPRN: "Abuelo(a) materno(a)",
  PGRPRN: "Abuelo(a) paterno(a)",
  GRNDCHILD: "Nieto(a)",
  AUNT: "Tía",
  UNCLE: "Tío",
  COUSN: "Primo(a)",
  FAMMEMB: "Otro familiar",
  FRND: "Amigo(a)",
  NBOR: "Vecino(a)",
}
/**
 * Las palabras con que una persona escribe su parentesco («Madre», «mamá»,
 * «Tía»), en minúsculas y sin tildes, con su código. Lo ambiguo no tiene
 * código: «abuela» sola no dice si es materna o paterna, y «tutor» no es un
 * parentesco.
 */
const KINSHIP_WORDS: Readonly<Record<string, Kinship>> = {
  madre: "MTH", mama: "MTH",
  padre: "FTH", papa: "FTH",
  hijo: "CHILD", hija: "CHILD",
  conyuge: "SPS", esposo: "SPS", esposa: "SPS",
  pareja: "DOMPART",
  hermano: "SIB", hermana: "SIB",
  "abuelo materno": "MGRPRN", "abuela materna": "MGRPRN",
  "abuelo paterno": "PGRPRN", "abuela paterna": "PGRPRN",
  nieto: "GRNDCHILD", nieta: "GRNDCHILD",
  tia: "AUNT", tio: "UNCLE",
  primo: "COUSN", prima: "COUSN",
  "otro familiar": "FAMMEMB",
  amigo: "FRND", amiga: "FRND",
  vecino: "NBOR", vecina: "NBOR",
}

/**
 * El código HL7 RoleCode del parentesco que se escribió a mano (el «Detalle
 * (Madre, Padre…)» del registro), o null si no es uno de la lista.
 */
export function kinshipFromWords(text: string | null | undefined): Kinship | null {
  if (!text) return null
  const words = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return KINSHIP_WORDS[words] ?? null
}
/** Solo los familiares, para los antecedentes familiares. */
export const FAMILY_KINSHIP_LABELS: Record<FamilyKinship, string> = Object.fromEntries(
  FAMILY_KINSHIP.map((code) => [code, KINSHIP_LABELS[code]]),
) as Record<FamilyKinship, string>

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

/** «Rosa María» + «Quispe Huamán» → «Rosa María Quispe Huamán». */
export function composeDisplayName(parts: { givenNames?: string | null; familyName?: string | null }): string {
  return [parts.givenNames, parts.familyName]
    .map((part) => part?.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join(" ")
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

/**
 * Por qué un número del país de la clínica no puede ser su WhatsApp, o null si
 * puede. El E.164 admite cualquier largo de 8 a 15 dígitos, así que un celular
 * con un dígito de menos (`+5199215437`) pasa como número y Meta lo rechaza en
 * cada envío. Solo se comprueba con el perfil del país de la clínica; un número
 * de otro país, o de un país sin perfil, pasa como viene.
 */
export function whatsappNumberProblem(e164: string, countryCode?: string | null): string | null {
  const profile = nationalPhone(countryCode)
  if (!profile) return null
  const digits = e164.replace(/\D/g, "")
  if (!digits.startsWith(profile.callingCode)) return null
  return profile.national.test(digits.slice(profile.callingCode.length))
    ? null
    : `Ese número no puede ser su WhatsApp: revisa que sea ${profile.hint}.`
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

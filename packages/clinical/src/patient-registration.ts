import { ALLERGY_SEVERITIES, REFERRAL_KINDS } from "./catalogs.js"
import { z } from "zod"
import type { ClinicalProduct } from "./products.js"
import {
  type ClinicalCountryProfile,
  clinicalProfileFor,
  documentTypeProfile,
  IDENTITY_DOC_TYPES,
  INSURANCE_TYPES,
  insuranceScheme,
  normalizeCountryCode,
  regionOption,
} from "./country-profiles.js"
import {
  DOC_TYPE_LABELS,
  EDUCATION_LEVELS,
  identityDocumentError,
  ISO_COUNTRY_RE,
  KINSHIP,
  MARITAL_STATUSES,
  normalizePhone,
  phoneFormatError,
  SEX_CODES,
} from "./identity.js"

export const CONTACT_RELATIONSHIPS = ["self", "guardian", "family", "other"] as const
export type ContactRelationship = (typeof CONTACT_RELATIONSHIPS)[number]
export const CONTACT_RELATIONSHIP_LABELS: Record<ContactRelationship, string> = {
  self: "Propio paciente", guardian: "Tutor o responsable", family: "Familiar", other: "Otro contacto",
}
export type RegistrationRespondent = "patient" | "representative" | "staff"
export type RegistrationEntryPoint = "platform" | "public_link" | "qr" | "conversation"
export type DeclarationState = "unanswered" | "unknown" | "none" | "recorded"
export const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "unknown"] as const
export type BloodGroup = (typeof BLOOD_GROUPS)[number]
/** «No se pide», «Opcional» y «Obligatorio» en «Registro de pacientes». */
export type RegistrationFieldMode = "hidden" | "optional" | "required"
export const REGISTRATION_MODE_LABELS: Record<RegistrationFieldMode, string> = {
  hidden: "No se pide",
  optional: "Opcional",
  required: "Obligatorio",
}
/**
 * Alcance del registro. `essentials` son los datos para reservar: desde el
 * enlace de cita, todo lo que la clínica necesita para atenderla (identidad,
 * celular, fecha de nacimiento y lo que marca «Obligatorio»), sin lo censal ni
 * la salud; cuando el equipo registra al reservar, su nombre. Lo demás queda
 * por completar en la clínica.
 */
export type RegistrationScope = "full" | "essentials"
/** Datos de la persona que admite el alcance `essentials` del equipo; cualquier otro se rechaza. */
export const ESSENTIAL_DEMOGRAPHICS = [
  "displayName", "givenNames", "familyName",
  "docType", "docNumber", "docCountry", "phone", "birthDate",
] as const
/**
 * Lo que el enlace de reserva nunca pide: lo censal y «Cómo nos conoció», que
 * no son obligatorios para ninguna clínica. Lo demás de la persona sí, si la
 * clínica lo exige.
 */
const NOT_FOR_BOOKING: readonly string[] = ["maritalStatus", "educationLevel", "occupation", "origin", "referralKind", "referralSource"]
/**
 * Lo obligatorio de la clínica que se pide en la misma pantalla de reservar.
 * Lo demás que exija (dirección, contacto de emergencia, seguro…) lo pide
 * «Tus datos» justo después de reservar, con sus propias pantallas.
 */
export const BOOKING_ASKED_FIELDS: readonly string[] = ["birthDate", "sex", "email", "docType", "docNumber"]
export const DOC_TYPES = IDENTITY_DOC_TYPES
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Grupos de datos de la persona (decisión 10 de la fase 3):
 * - `always`: los fija odentIA porque hacen falta para atender (nombres y
 *   apellidos, fecha de nacimiento, un teléfono o correo suyo o de quien habla
 *   por ella). Siempre cuentan para el aviso «Faltan datos para atenderla».
 * - `clinic`: los que la clínica decide en «Registro de pacientes»; cuentan
 *   solo si los marca obligatorios.
 * - `census`: opcionales y nunca obligatorios (nadie los usa para atender: ni
 *   impresos ni el agente; Reportes solo suma «Cómo nos conoció»). Nunca cuentan.
 * - `health`: los antecedentes que el registro puede preguntar. Los de la
 *   entrevista (`personal.*` y `dental.*`) llegan a «Entrevista de salud»
 *   de la ficha con las mismas claves y solo pueden ser opcionales.
 *
 * Un dato con `product` es de ese producto (ADR 0079): «Tu boca» (`dental.*`)
 * solo lo preguntan las clínicas dentales; la lactancia y los hábitos
 * (`medical.*`), los consultorios de latidIA (issue 229, decisión 13), que
 * guardan el embarazo con la fecha del registro.
 *
 * Solo entran aquí datos que el paciente sabe responder solo y que la ficha ya
 * guarda. Lo que se pregunta junto (la referencia con la dirección, el
 * parentesco con el contacto de emergencia, la aseguradora con el seguro) sigue
 * a su dato y nunca es obligatorio.
 */
export type RegistrationFieldGroup = "always" | "clinic" | "census" | "health"

export const REGISTRATION_FIELDS = [
  { key: "displayName", label: "Nombres y apellidos", step: "datos", group: "always" },
  { key: "birthDate", label: "Fecha de nacimiento", step: "datos", group: "always" },
  { key: "phone", label: "Teléfono o correo", step: "contacto", group: "always" },
  { key: "docType", label: "Tipo de documento", step: "datos", group: "clinic" },
  { key: "docNumber", label: "Número de documento", step: "datos", group: "clinic" },
  { key: "sex", label: "Sexo", step: "datos", group: "clinic" },
  { key: "nationality", label: "Nacionalidad", step: "datos", group: "clinic" },
  { key: "birthPlace", label: "Lugar de nacimiento", step: "datos", group: "clinic" },
  { key: "email", label: "Correo", step: "contacto", group: "clinic" },
  { key: "address", label: "Dirección", step: "contacto", group: "clinic" },
  { key: "emergencyContactName", label: "Contacto de emergencia", step: "contacto", group: "clinic" },
  { key: "emergencyContactPhone", label: "Teléfono de emergencia", step: "contacto", group: "clinic" },
  { key: "insuranceType", label: "Seguro", step: "contacto", group: "clinic" },
  { key: "maritalStatus", label: "Estado civil", step: "contacto", group: "census" },
  { key: "educationLevel", label: "Nivel educativo", step: "contacto", group: "census" },
  { key: "occupation", label: "Ocupación", step: "contacto", group: "census" },
  { key: "referralSource", label: "Cómo nos conoció", step: "contacto", group: "census" },
  // Solo en clínicas de Perú (`clinicalProfileFor(...).origin`).
  { key: "origin", label: "Procedencia", step: "contacto", group: "census" },
  { key: "bloodGroup", label: "Grupo sanguíneo", step: "salud", group: "health" },
  { key: "allergies", label: "Alergias", step: "salud", group: "health" },
  { key: "conditions", label: "Enfermedades", step: "salud", group: "health" },
  { key: "medications", label: "Medicación", step: "salud", group: "health" },
  { key: "personal.embarazo", label: "Embarazo", step: "personales", group: "health" },
  { key: "personal.cirugias", label: "Operaciones", step: "personales", group: "health" },
  { key: "personal.hospitalizaciones", label: "Hospitalizaciones", step: "personales", group: "health" },
  { key: "personal.transfusiones", label: "Transfusiones", step: "personales", group: "health" },
  { key: "medical.lactancia", label: "Lactancia", step: "personales", group: "health", product: "medical" },
  { key: "medical.tabaco", label: "Tabaco", step: "habitos", group: "health", product: "medical" },
  { key: "medical.alcohol", label: "Alcohol", step: "habitos", group: "health", product: "medical" },
  { key: "dental.ultimaVisita", label: "Última visita dental", step: "odontologicos", group: "health", product: "dental" },
  { key: "dental.experienciaPrevia", label: "Experiencia previa", step: "odontologicos", group: "health", product: "dental" },
  { key: "dental.ansiedadDental", label: "Ansiedad dental", step: "odontologicos", group: "health", product: "dental" },
  { key: "dental.cepilladosAlDia", label: "Cepillado diario", step: "odontologicos", group: "health", product: "dental" },
  { key: "dental.hiloDental", label: "Hilo dental", step: "odontologicos", group: "health", product: "dental" },
  { key: "dental.bruxismo", label: "Bruxismo", step: "odontologicos", group: "health", product: "dental" },
  { key: "dental.habitos", label: "Hábitos", step: "odontologicos", group: "health", product: "dental" },
] as const
export type RegistrationFieldKey = (typeof REGISTRATION_FIELDS)[number]["key"]
/** Datos que se piden siempre: el registro los guarda como obligatorios y no se cambian. */
export const ALWAYS_REGISTRATION_FIELDS: readonly RegistrationFieldKey[] = REGISTRATION_FIELDS
  .filter((field) => field.group === "always").map((field) => field.key)
/** Datos censales: solo «Opcional» o «No se pide». */
export const CENSUS_REGISTRATION_FIELDS: readonly RegistrationFieldKey[] = REGISTRATION_FIELDS
  .filter((field) => field.group === "census").map((field) => field.key)
/**
 * Solo «Opcional» o «No se pide»: lo censal y la entrevista de salud (embarazo,
 * operaciones, historia dental), que nunca impiden registrar.
 */
export const OPTIONAL_ONLY_REGISTRATION_FIELDS: readonly RegistrationFieldKey[] = REGISTRATION_FIELDS
  .filter(
    (field) =>
      field.group === "census" || field.step === "personales" || field.step === "odontologicos" || field.step === "habitos",
  )
  .map((field) => field.key)

export interface RegistrationConfig {
  version: number
  enabled: boolean
  fields: Record<RegistrationFieldKey, RegistrationFieldMode>
  privacyNotice: string
  /** El registro pregunta si acepta recordatorios de citas y controles. */
  askReminders: boolean
  /** El registro pregunta si acepta otros mensajes de la clínica. */
  askMessages: boolean
}
const optionalDefaults: Record<string, true> = { docType: true, docNumber: true, email: true, sex: true, address: true, bloodGroup: true, allergies: true, conditions: true, medications: true }
export const DEFAULT_REGISTRATION_CONFIG: RegistrationConfig = {
  version: 0, enabled: false, privacyNotice: "", askReminders: true, askMessages: true,
  fields: Object.fromEntries(REGISTRATION_FIELDS.map(({ key }) => [key,
    ALWAYS_REGISTRATION_FIELDS.includes(key) ? "required" : optionalDefaults[key] ? "optional" : "hidden",
  ])) as RegistrationConfig["fields"],
}
const text = (max: number) => z.string().trim().max(max, `Máximo ${max} caracteres`)
const optionalText = (max: number) => text(max).nullable().optional()
const email = text(200).refine(v => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Escribe el correo completo, como nombre@dominio.com")
const codeOrEmpty = <T extends readonly [string, ...string[]]>(values: T) => z.enum([...values, ""]).nullable().optional()
export const demographicsSchema = z.strictObject({
  displayName: text(200).min(1, "Escribe el nombre de la persona"),
  /** «Nombres» y «Apellidos», dos campos (ADR 0058); el nombre visible se deriva de ellos. */
  givenNames: optionalText(100), familyName: optionalText(200),
  birthDate: optionalText(10), docType: codeOrEmpty(DOC_TYPES),
  docNumber: optionalText(20), docCountry: optionalText(2), nationality: optionalText(2),
  birthCountry: optionalText(2), birthPlace: optionalText(200),
  sex: codeOrEmpty(SEX_CODES),
  phone: optionalText(50), email: email.nullable().optional(),
  /** Domicilio internacional (HL7 FHIR Address): calle y número, localidad, provincia, región, código postal y país. */
  address: optionalText(500), addressCity: optionalText(100), addressDistrict: optionalText(100),
  addressRegion: optionalText(100), addressPostalCode: optionalText(20), addressCountry: optionalText(2),
  addressReference: optionalText(300),
  maritalStatus: codeOrEmpty(MARITAL_STATUSES), educationLevel: codeOrEmpty(EDUCATION_LEVELS), occupation: optionalText(200),
  origin: optionalText(200), emergencyContactName: optionalText(200), emergencyContactPhone: optionalText(50),
  emergencyContactRelationship: codeOrEmpty(KINSHIP),
  insuranceType: z.enum([...INSURANCE_TYPES, ""]).nullable().optional(), insuranceScheme: optionalText(20),
  insurerName: optionalText(200), affiliationNumber: optionalText(50),
  /** «Cómo nos conoció» de la lista (`REFERRAL_KINDS`); `referralSource` es lo que dijo cuando es «Otro». */
  referralKind: codeOrEmpty(REFERRAL_KINDS), referralSource: optionalText(500),
})
export type RegistrationDemographics = z.infer<typeof demographicsSchema>
export const healthAllergyDeclarationSchema = z.strictObject({
  substance: text(200).min(1), reaction: text(2000).optional(), severity: z.enum(ALLERGY_SEVERITIES),
})
export const healthConditionDeclarationSchema = z.strictObject({ name: text(200).min(1), notes: text(2000).optional() })
export const healthMedicationDeclarationSchema = z.strictObject({
  name: text(200).min(1), dose: text(200).optional(), frequency: text(200).optional(), notes: text(2000).optional(),
})
export type HealthAllergyDeclaration = z.infer<typeof healthAllergyDeclarationSchema>
export type HealthConditionDeclaration = z.infer<typeof healthConditionDeclarationSchema>
export type HealthMedicationDeclaration = z.infer<typeof healthMedicationDeclarationSchema>
const declaration = <T extends z.ZodType>(item: T) => z.strictObject({
  state: z.enum(["unanswered", "unknown", "none", "recorded"]), items: z.array(item).max(50),
}).refine(v => v.state === "recorded" ? v.items.length > 0 : v.items.length === 0, "Indica entradas solo cuando la respuesta sea Sí")
export const registrationContactInputSchema = z.strictObject({
  contactId: z.uuid(), relationship: z.enum(CONTACT_RELATIONSHIPS), relationshipDetail: text(100).nullable().optional(),
  /** Parentesco con HL7 v3 RoleCode, si se conoce. */
  kinship: z.enum(KINSHIP).nullable().optional(), isPreferred: z.boolean(),
  /** Contacto de emergencia (decisión 25); sin indicar, queda como estaba. */
  isEmergency: z.boolean().optional(),
})
export type RegistrationContactInput = z.infer<typeof registrationContactInputSchema>
export const registrationAnswersSchema = z.strictObject({
  demographics: demographicsSchema,
  respondent: z.enum(["patient", "representative", "staff"]),
  representative: z.strictObject({
    displayName: text(200).min(1), relationship: z.enum(["guardian", "family", "other"]),
    relationshipDetail: text(100), phone: text(50).optional(), email: email.optional(),
    /** Documento del representante: obligatorio cuando representa a un menor. */
    docType: z.enum(DOC_TYPES).optional(), docNumber: text(20).optional(), docCountry: text(2).optional(),
  }).optional(),
  health: z.strictObject({
    bloodGroup: z.enum(BLOOD_GROUPS).nullable().optional(),
    allergies: declaration(healthAllergyDeclarationSchema).optional(),
    conditions: declaration(healthConditionDeclarationSchema).optional(),
    medications: declaration(healthMedicationDeclarationSchema).optional(),
    /** «Entrevista de salud» de la ficha, `antecedentesPersonales`, con sus mismas claves. */
    personal: z.strictObject({
      embarazo: z.boolean().optional(), semanasEmbarazo: z.number().int().min(0).max(42).optional(),
      cirugias: text(500).optional(), hospitalizaciones: text(500).optional(), transfusiones: text(500).optional(),
    }).optional(),
    dental: z.strictObject({
      ultimaVisita: text(2000).optional(), experienciaPrevia: z.enum(["positiva", "regular", "traumatica"]).optional(),
      ansiedadDental: z.enum(["ninguna", "leve", "moderada", "alta"]).optional(),
      cepilladosAlDia: z.number().int().min(0).max(10).optional(), hiloDental: z.boolean().optional(),
      bruxismo: z.boolean().optional(), habitos: z.array(text(100).min(1)).max(10).optional(),
    }).optional(),
    /** Lo que pregunta latidIA: va a «Embarazo y lactancia» y «Hábitos» de su entrevista. */
    medical: z.strictObject({
      lactancia: z.boolean().optional(), tabaco: z.enum(["nunca", "fuma", "dejo"]).optional(),
      alcohol: z.enum(["no", "ocasional", "frecuente"]).optional(),
    }).optional(),
  }).optional(),
  privacyAccepted: z.boolean(),
  // Permisos de mensajes: solo cuentan si el registro los pregunta y se aceptó el aviso.
  acceptsReminders: z.boolean().optional(),
  acceptsMessages: z.boolean().optional(),
})
export type RegistrationAnswers = z.infer<typeof registrationAnswersSchema>
const fieldKeys = REGISTRATION_FIELDS.map(f => f.key) as [RegistrationFieldKey, ...RegistrationFieldKey[]]
export const registrationConfigSchema = z.strictObject({
  version: z.number().int().nonnegative(), enabled: z.boolean(),
  fields: z.record(z.enum(fieldKeys), z.enum(["hidden", "optional", "required"])), privacyNotice: text(10000),
  askReminders: z.boolean().default(true), askMessages: z.boolean().default(true),
}).superRefine((config, ctx) => {
  const issue = (path: string[], message: string) => ctx.addIssue({ code: "custom", path, message })
  for (const key of ALWAYS_REGISTRATION_FIELDS) {
    if (config.fields[key] !== "required") issue(["fields", key], "Se pide siempre: hace falta para atender")
  }
  for (const key of OPTIONAL_ONLY_REGISTRATION_FIELDS) {
    if (config.fields[key] === "required") issue(["fields", key], "Este dato solo puede ser opcional o no pedirse")
  }
  if (config.fields.docType !== config.fields.docNumber) issue(["fields", "docNumber"], "Configura el documento como pareja")
  if (config.enabled && !config.privacyNotice) issue(["privacyNotice"], "Escribe el aviso de privacidad antes de publicar")
})

export function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}
export function isMinor(birthDate: string, today: string): boolean {
  const age = Number(today.slice(0, 4)) - Number(birthDate.slice(0, 4)) - (today.slice(5) < birthDate.slice(5) ? 1 : 0)
  return age < 18
}
export function documentNumberError(docType: string | null | undefined, docNumber: string | null | undefined): string | null {
  return identityDocumentError(docType, docNumber)
}

/**
 * País emisor de un documento según el país de la clínica: el del tipo cuando
 * lo emite un país fijo (el DNI, el Perú), el elegido y, si falta, el de la
 * clínica en el documento nacional. El pasaporte y el documento extranjero no
 * suponen ninguno: hay que elegirlo (nunca se inventa un país).
 */
export function documentIssuerCountry(
  profile: ClinicalCountryProfile,
  docType: string | null | undefined,
  docCountry: string | null | undefined,
): string | null {
  const chosen = normalizeCountryCode(docCountry)
  const issuer = documentTypeProfile(profile, docType)?.issuer
  if (issuer?.kind === "fixed") return issuer.country
  if (issuer?.kind === "foreign" || issuer?.kind === "chosen") return chosen
  return chosen ?? profile.country
}

/**
 * Datos completos de la persona (lo guardado más lo que cambia) listos para
 * guardar según el país de la clínica: países en mayúsculas, documento con su
 * país emisor, dirección con el país de la clínica si no se eligió otro y el
 * tipo general del seguro tomado de su régimen (SIS → público). No valida:
 * eso es `validateDemographics`.
 */
export function normalizePersonData<T extends Partial<RegistrationDemographics>>(
  data: T,
  profile: ClinicalCountryProfile,
): T & Pick<Partial<RegistrationDemographics>, "docCountry" | "insuranceType" | "addressCountry" | "referralKind" | "referralSource"> {
  const out: Record<string, unknown> = { ...data }
  for (const key of ["docCountry", "nationality", "birthCountry", "addressCountry"] as const) {
    if (typeof out[key] === "string") out[key] = (out[key] as string).trim().toUpperCase() || null
  }
  if (out.docNumber) out.docCountry = documentIssuerCountry(profile, out.docType as string, out.docCountry as string)
  else if ("docNumber" in out) out.docCountry = null
  if (typeof out.address === "string" && out.address.trim() && !out.addressCountry) out.addressCountry = profile.country
  const scheme = insuranceScheme(profile, out.insuranceScheme as string)
  if (scheme) out.insuranceType = scheme.type
  // «Cómo nos conoció»: lo escrito sin elegir de la lista es «Otro» con su texto;
  // otra opción de la lista no lleva texto.
  if (typeof out.referralSource === "string" && out.referralSource.trim() && !out.referralKind) out.referralKind = "otro"
  if (out.referralKind && out.referralKind !== "otro") out.referralSource = null
  return out as T
}

/**
 * Lo que valida un dato según el país: tipos de documento, regímenes de
 * seguro y lista de regiones. Un dato ya guardado que no cambia (`previous`)
 * se acepta aunque el país de la clínica haya cambiado: lo guardado conserva
 * su norma.
 */
function countryErrors(
  data: RegistrationDemographics,
  profile: ClinicalCountryProfile,
  previous: Partial<Record<string, unknown>> | undefined,
  errors: Record<string, string>,
): void {
  const unchanged = (key: keyof RegistrationDemographics) => previous !== undefined && (previous[key] ?? null) === (data[key] ?? null)
  if (data.docType && !unchanged("docType") && !documentTypeProfile(profile, data.docType))
    errors.docType = "Elige un tipo de documento de la lista"
  const issuer = documentTypeProfile(profile, data.docType)?.issuer
  const docCountry = documentIssuerCountry(profile, data.docType, data.docCountry)
  if (data.docNumber && !docCountry && !unchanged("docNumber")) errors.docCountry ??= "Elige el país que emitió el documento"
  if (data.docNumber && issuer?.kind === "foreign" && docCountry && docCountry === profile.country)
    errors.docCountry ??= `El ${DOC_TYPE_LABELS.DIE.toLowerCase()} lo emite otro país`
  if (data.insuranceScheme && !unchanged("insuranceScheme") && !insuranceScheme(profile, data.insuranceScheme))
    errors.insuranceScheme = "Elige el seguro de la lista"
  const regions = profile.address.regions
  if (data.maritalStatus && !unchanged("maritalStatus") && !profile.maritalStatuses.includes(data.maritalStatus))
    errors.maritalStatus = "Elige el estado civil de la lista"
  if (regions && data.addressRegion && !unchanged("addressRegion") && !regionOption(profile, data.addressRegion))
    errors.addressRegion = `Elige el ${profile.address.regionLabel.toLowerCase()} de la lista`
}

/**
 * `countryCode` es el país de la clínica (ISO 3166-1 alfa-2): de él dependen
 * los documentos, los seguros y las regiones que se aceptan, y con él se
 * reconoce un teléfono nacional escrito sin prefijo. `previous` son los datos
 * ya guardados: lo que no cambia no se vuelve a juzgar por el país. Los
 * errores dicen qué arreglar, nunca «formato inválido».
 */
export function validateDemographics(
  value: unknown,
  today?: string,
  countryCode?: string | null,
  previous?: Partial<Record<string, unknown>>,
): Record<string, string> {
  const errors: Record<string, string> = {}
  const parsed = demographicsSchema.safeParse(value)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) errors[issue.path.join(".")] ??= issue.message
    return errors
  }
  const data = parsed.data
  const profile = clinicalProfileFor(countryCode)
  const docError = documentNumberError(data.docType, data.docNumber)
  if (docError) errors.docNumber = docError
  if (data.docNumber && !data.docType) errors.docType = "Elige el tipo de documento"
  if (data.docType && !data.docNumber) errors.docNumber = "Escribe el número de documento"
  if (data.birthDate && (!isRealDate(data.birthDate) || (today && data.birthDate > today))) errors.birthDate = "Escribe una fecha real que no sea futura"
  for (const key of ["docCountry", "nationality", "birthCountry", "addressCountry"] as const)
    if (data[key] && !ISO_COUNTRY_RE.test(data[key]!.toUpperCase())) errors[key] = "Elige el país de la lista"
  if (data.addressPostalCode && !/^[A-Za-z0-9][A-Za-z0-9 -]{1,11}$/.test(data.addressPostalCode))
    errors.addressPostalCode = "El código postal tiene de 2 a 12 letras o números"
  if (data.insuranceScheme && !data.insuranceType && !insuranceScheme(profile, data.insuranceScheme))
    errors.insuranceType ??= "Elige el tipo de seguro"
  for (const key of ["phone", "emergencyContactPhone"] as const)
    if (data[key] && !normalizePhone(data[key], countryCode)) errors[key] = phoneFormatError(countryCode)
  if (data.givenNames && !data.familyName) errors.familyName = "Escribe los apellidos"
  if (data.familyName && !data.givenNames) errors.givenNames = "Escribe los nombres"
  countryErrors(data, profile, previous, errors)
  return errors
}
function registrationFieldValue(data: RegistrationAnswers, field: (typeof REGISTRATION_FIELDS)[number]): unknown {
  const key = field.key
  if (key.startsWith("dental.")) return data.health?.dental?.[key.slice(7) as keyof NonNullable<NonNullable<RegistrationAnswers["health"]>["dental"]>]
  if (key.startsWith("medical.")) return data.health?.medical?.[key.slice(8) as keyof NonNullable<NonNullable<RegistrationAnswers["health"]>["medical"]>]
  if (key.startsWith("personal.")) return data.health?.personal?.[key.slice(9) as keyof NonNullable<NonNullable<RegistrationAnswers["health"]>["personal"]>]
  if (field.step === "salud") return data.health?.[key as keyof NonNullable<RegistrationAnswers["health"]>]
  return data.demographics[key as keyof RegistrationDemographics]
}
function isUnanswered(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (typeof value === "object" && "state" in value && value.state === "unanswered")
}
/**
 * El teléfono o el correo de quien habla por la persona (su madre, su tutor)
 * cuentan como su medio de contacto: a un niño de 6 años no le falta teléfono si
 * el de su madre está. La misma regla para el registro y para el aviso de los
 * datos que faltan en su página.
 */
export function contactCoveredByRepresentative(key: RegistrationFieldKey, representativeContact: boolean): boolean {
  return representativeContact && (key === "phone" || key === "email")
}

/** Un dato que le falta a la persona para atenderla, con su nombre en pantalla. */
export interface MissingPersonDatum {
  key:
    | "givenNames" | "familyName" | "birthDate" | "phone" | "docType" | "docNumber"
    | "sex" | "nationality" | "birthPlace" | "email" | "address" | "emergencyContactName" | "emergencyContactPhone"
    | "insuranceType"
  label: string
}

/**
 * «Faltan datos para atenderla»: una sola regla para la página de la persona,
 * la Agenda, la nota del caso y el registro (decisión 10 de la fase 3). Cuentan
 * siempre nombres, apellidos, fecha de nacimiento y un teléfono o correo
 * (suyo o de quien habla por ella); además, lo que «Registro de pacientes»
 * marca obligatorio de lo que pide la clínica. Los datos censales nunca
 * cuentan. `representativeContact`: quien habla por ella tiene teléfono o correo.
 */
export function missingPersonData(
  config: Pick<RegistrationConfig, "fields">,
  data: Partial<Record<string, unknown>>,
  options: { representativeContact: boolean },
): MissingPersonDatum[] {
  const missing: MissingPersonDatum[] = []
  const blank = (key: string) => isUnanswered(data[key])
  if (blank("givenNames")) missing.push({ key: "givenNames", label: "Nombres" })
  if (blank("familyName")) missing.push({ key: "familyName", label: "Apellidos" })
  if (blank("birthDate")) missing.push({ key: "birthDate", label: "Fecha de nacimiento" })
  if (blank("phone") && blank("email") && !options.representativeContact)
    missing.push({ key: "phone", label: "Teléfono o correo" })
  for (const field of REGISTRATION_FIELDS) {
    if (field.group !== "clinic" || config.fields[field.key] !== "required") continue
    if (contactCoveredByRepresentative(field.key, options.representativeContact)) continue
    if (blank(field.key)) missing.push({ key: field.key as MissingPersonDatum["key"], label: field.label })
  }
  return missing
}

/**
 * Lo que la clínica pide y estas respuestas del registro no traen: la misma
 * regla del aviso (`missingPersonData`). Con el alcance `essentials` no impide
 * registrar: es lo que queda por completar en la clínica.
 */
export function pendingRegistrationFields(config: RegistrationConfig, answers: RegistrationAnswers): MissingPersonDatum[] {
  const representativeContact = !!answers.representative && !!(answers.representative.phone || answers.representative.email)
  return missingPersonData(config, answers.demographics, { representativeContact })
}

/**
 * Si el registro de esta clínica pregunta ese dato: «Procedencia» solo en
 * clínicas de Perú y lo de un producto (`dental.*`, «Tu boca»; `medical.*`)
 * solo en las de ese producto.
 */
export function registrationFieldAsked(
  config: Pick<RegistrationConfig, "fields">,
  key: RegistrationFieldKey,
  countryCode?: string | null,
  product: ClinicalProduct = "dental",
): boolean {
  if (key === "origin" && !clinicalProfileFor(countryCode).origin) return false
  const field = REGISTRATION_FIELDS.find((item) => item.key === key)
  if (field && "product" in field && field.product !== product) return false
  return config.fields[key] !== "hidden"
}

/**
 * Lo común del alcance `essentials`, lo registre la persona (enlace de reserva)
 * o el equipo (al reservar): solo datos de identidad y contacto, nada de salud,
 * y nombres y apellidos.
 */
function essentialIdentityErrors(data: RegistrationAnswers, errors: Record<string, string>, allowed: (key: string) => boolean): void {
  const demographics = data.demographics
  for (const [key, value] of Object.entries(demographics)) {
    if (!allowed(key) && value !== null && value !== "") errors[`demographics.${key}`] ??= "Este dato se completa en la clínica"
  }
  if (data.health !== undefined) errors.health = "Los datos de salud se completan en la clínica"
  if (!demographics.givenNames) errors["demographics.givenNames"] ??= "Escribe los nombres"
  if (!demographics.familyName) errors["demographics.familyName"] ??= "Escribe los apellidos"
}

/** El documento del representante, juzgado como el de la persona por el país de la clínica. */
function representativeDocumentErrors(
  representative: NonNullable<RegistrationAnswers["representative"]>,
  profile: ClinicalCountryProfile,
  errors: Record<string, string>,
): void {
  const repDocError = identityDocumentError(representative.docType, representative.docNumber)
  if (repDocError) errors["representative.docNumber"] = repDocError
  if (representative.docType && !documentTypeProfile(profile, representative.docType))
    errors["representative.docType"] = "Elige un tipo de documento de la lista"
  if (representative.docNumber && !documentIssuerCountry(profile, representative.docType, representative.docCountry))
    errors["representative.docCountry"] ??= "Elige el país que emitió el documento"
}

export function validateRegistrationAnswers(config: RegistrationConfig, answers: RegistrationAnswers, context: { mode: "internal" | "public"; today: string; scope?: RegistrationScope; countryCode?: string | null; product?: ClinicalProduct }): Record<string, string> {
  const errors: Record<string, string> = {}
  const parsed = registrationAnswersSchema.safeParse(answers)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) errors[issue.path.join(".")] ??= issue.message
    return errors
  }
  const data = parsed.data
  const profile = clinicalProfileFor(context.countryCode)
  for (const [key, message] of Object.entries(validateDemographics(data.demographics, context.today, context.countryCode))) errors[`demographics.${key}`] = message
  const minor = !!data.demographics.birthDate && isRealDate(data.demographics.birthDate) && isMinor(data.demographics.birthDate, context.today)
  const needsRepresentative = minor || data.respondent === "representative" || (context.mode === "internal" && data.respondent === "staff" && !!data.representative)
  if (needsRepresentative) {
    if (!data.representative) errors.representative = "Escribe los datos del responsable"
    else {
      if (!data.representative.phone && !data.representative.email) errors["representative.phone"] = "Escribe el teléfono o el correo del responsable"
      if (minor && data.representative.relationship !== "guardian") errors["representative.relationship"] = "Para menores corresponde tutor o responsable"
      if (minor && (!data.representative.docType || !data.representative.docNumber)) errors["representative.docNumber"] = "Escribe el documento del representante legal"
      representativeDocumentErrors(data.representative, profile, errors)
    }
  } else if (data.representative) errors.representative = "Selecciona registrar a otra persona"
  const representativeContact = needsRepresentative && !!(data.representative?.phone || data.representative?.email)
  if (context.mode === "public") {
    if (data.respondent === "staff") errors.respondent = "Selecciona quién declara la información"
    if (minor && data.respondent !== "representative") errors.respondent = "El responsable debe registrar al menor"
    if (!data.privacyAccepted) errors.privacyAccepted = "Debes aceptar el aviso de privacidad"
    if (context.scope === "essentials") {
      // Al reservar desde su enlace se pide, una sola vez, lo que la clínica
      // necesita para atenderla: la identidad, un celular, la fecha de
      // nacimiento y lo que ella marca «Obligatorio» de `BOOKING_ASKED_FIELDS`
      // (la misma regla de «Faltan datos», `missingPersonData`). Lo demás que
      // exija queda pendiente y lo pide «Tus datos» justo después. Lo censal y
      // la salud no se piden aquí.
      essentialIdentityErrors(data, errors, (key) => !NOT_FOR_BOOKING.includes(key))
      const demographics = data.demographics
      if (!demographics.docType) errors["demographics.docType"] ??= "Elige el tipo de documento"
      if (!demographics.docNumber) errors["demographics.docNumber"] ??= "Escribe el número de documento"
      if (!demographics.phone && !representativeContact) errors["demographics.phone"] ??= "Escribe un celular"
      for (const datum of missingPersonData(config, demographics, { representativeContact })) {
        if (!BOOKING_ASKED_FIELDS.includes(datum.key)) continue
        errors[`demographics.${datum.key}`] ??= datum.key === "birthDate" ? "Escribe la fecha de nacimiento" : `Completa: ${datum.label.toLowerCase()}`
      }
      return errors
    }
    for (const field of REGISTRATION_FIELDS) {
      const key = field.key
      const path = field.step === "datos" || field.step === "contacto" ? `demographics.${key}` : `health.${key}`
      const value = registrationFieldValue(data, field)
      if (!registrationFieldAsked(config, key, context.countryCode, context.product)) {
        if (value !== undefined) errors[path] = "Este dato no se pide en el registro"
        continue
      }
      if (contactCoveredByRepresentative(key, representativeContact)) continue
      // «Teléfono o correo»: cualquiera de los dos basta.
      if (key === "phone") continue
      if (config.fields[key] === "required" && isUnanswered(value)) errors[path] = "Este dato es obligatorio"
      if (["allergies", "conditions", "medications"].includes(key) && value === undefined) errors[path] = "Indica una respuesta, incluido Sin responder"
    }
    if (!data.demographics.phone && !data.demographics.email && !representativeContact) errors["demographics.phone"] = "Escribe un teléfono o un correo"
  } else if (context.scope === "essentials") {
    // Lo mínimo que registra el equipo al reservar: nombres, apellidos y, si se
    // conoce, el teléfono (a quien escribe ya se le conocen sus canales; a quien
    // llega por la Agenda el servicio le exige el teléfono). Como en el enlace
    // de reserva, lo que la clínica exige y aquí no se pide no bloquea: queda
    // pendiente (`pendingRegistrationFields`).
    essentialIdentityErrors(data, errors, (key) => (ESSENTIAL_DEMOGRAPHICS as readonly string[]).includes(key))
  } else if (config.version > 0) {
    // Alta interna: lo que la clínica configuró como obligatorio también lo es
    // para recepción (el aviso de privacidad y los campos ocultos no aplican).
    // Sin configuración guardada rige el alta rápida.
    for (const field of REGISTRATION_FIELDS) {
      if (config.fields[field.key] !== "required" || field.group === "health") continue
      if (field.key === "phone") {
        if (!data.demographics.phone && !data.demographics.email && !representativeContact)
          errors["demographics.phone"] = "Teléfono o correo: hace falta uno para atenderla"
        continue
      }
      if (needsRepresentative && (field.key === "email") && representativeContact) continue
      const value = data.demographics[field.key as keyof RegistrationDemographics]
      if (value === undefined || value === null || value === "")
        errors[`demographics.${field.key}`] = `${field.label}: obligatorio según la configuración del registro`
    }
  }
  return errors
}

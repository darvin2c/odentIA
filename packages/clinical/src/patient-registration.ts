import { z } from "zod"
import {
  EDUCATION_LEVELS,
  FOREIGN_DOC_TYPES,
  IDENTITY_DOC_TYPES,
  identityDocumentError,
  ISO_COUNTRY_RE,
  KINSHIP,
  MARITAL_STATUSES,
  normalizePhone,
  phoneFormatError,
  SEX_CODES,
  UBIGEO_RE,
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
export type RegistrationFieldMode = "hidden" | "optional" | "required"
/**
 * Alcance del registro. `essentials` son los datos esenciales para reservar:
 * desde el enlace de cita, identidad y un celular; cuando el equipo registra
 * al reservar a la persona de una conversación, su nombre. Lo demás que la
 * clínica configuró no se pide ahí y queda por completar en la clínica.
 */
export type RegistrationScope = "full" | "essentials"
/** Datos de la persona que admite el alcance `essentials`; cualquier otro se rechaza. */
export const ESSENTIAL_DEMOGRAPHICS = [
  "displayName", "givenNames", "paternalSurname", "maternalSurname",
  "docType", "docNumber", "docCountry", "phone", "birthDate",
] as const
export const DOC_TYPES = IDENTITY_DOC_TYPES
export const INSURANCE_TYPES = ["PARTICULAR", "SIS", "ESSALUD", "EPS", "OTRO"] as const
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const REGISTRATION_FIELDS = [
  { key: "displayName", label: "Nombre completo", step: "datos" },
  { key: "birthDate", label: "Fecha de nacimiento", step: "datos" },
  { key: "docType", label: "Tipo de documento", step: "datos" },
  { key: "docNumber", label: "Número de documento", step: "datos" },
  { key: "sex", label: "Sexo", step: "datos" },
  { key: "phone", label: "Teléfono", step: "contacto" },
  { key: "email", label: "Correo", step: "contacto" },
  { key: "address", label: "Dirección", step: "contacto" },
  { key: "maritalStatus", label: "Estado civil", step: "contacto" },
  { key: "educationLevel", label: "Grado de instrucción", step: "contacto" },
  { key: "occupation", label: "Ocupación", step: "contacto" },
  { key: "origin", label: "Procedencia", step: "contacto" },
  { key: "emergencyContactName", label: "Contacto de emergencia", step: "contacto" },
  { key: "emergencyContactPhone", label: "Teléfono de emergencia", step: "contacto" },
  { key: "insuranceType", label: "Seguro", step: "contacto" },
  { key: "insuranceDetail", label: "Detalle del seguro", step: "contacto" },
  { key: "referralSource", label: "Referencia", step: "contacto" },
  { key: "bloodGroup", label: "Grupo sanguíneo", step: "salud" },
  { key: "allergies", label: "Alergias", step: "salud" },
  { key: "conditions", label: "Enfermedades", step: "salud" },
  { key: "medications", label: "Medicación", step: "salud" },
  { key: "dental.ultimaVisita", label: "Última visita dental", step: "odontologicos" },
  { key: "dental.experienciaPrevia", label: "Experiencia previa", step: "odontologicos" },
  { key: "dental.ansiedadDental", label: "Ansiedad dental", step: "odontologicos" },
] as const
export type RegistrationFieldKey = (typeof REGISTRATION_FIELDS)[number]["key"]
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
    ["displayName", "birthDate", "phone"].includes(key) ? "required" : optionalDefaults[key] ? "optional" : "hidden",
  ])) as RegistrationConfig["fields"],
}
const text = (max: number) => z.string().trim().max(max, `Máximo ${max} caracteres`)
const optionalText = (max: number) => text(max).nullable().optional()
const email = text(200).refine(v => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Ingresa un correo válido")
const codeOrEmpty = <T extends readonly [string, ...string[]]>(values: T) => z.enum([...values, ""]).nullable().optional()
export const demographicsSchema = z.strictObject({
  displayName: text(200).min(1, "Ingresa el nombre del paciente"),
  /** Nombre separado (ADR 0004); el nombre visible se deriva de él. */
  givenNames: optionalText(100), paternalSurname: optionalText(100), maternalSurname: optionalText(100),
  birthDate: optionalText(10), docType: codeOrEmpty(DOC_TYPES),
  docNumber: optionalText(20), docCountry: optionalText(2), nationality: optionalText(2),
  sex: codeOrEmpty(SEX_CODES),
  phone: optionalText(50), email: email.nullable().optional(), address: optionalText(500),
  addressUbigeo: optionalText(6), addressReference: optionalText(300), birthPlaceUbigeo: optionalText(6),
  maritalStatus: codeOrEmpty(MARITAL_STATUSES), educationLevel: codeOrEmpty(EDUCATION_LEVELS), occupation: optionalText(200),
  origin: optionalText(200), emergencyContactName: optionalText(200), emergencyContactPhone: optionalText(50),
  emergencyContactRelationship: codeOrEmpty(KINSHIP),
  insuranceType: z.enum([...INSURANCE_TYPES, ""]).nullable().optional(), insuranceDetail: optionalText(500),
  insurerName: optionalText(200), affiliationNumber: optionalText(50), referralSource: optionalText(500),
})
export type RegistrationDemographics = z.infer<typeof demographicsSchema>
export const healthAllergyDeclarationSchema = z.strictObject({
  substance: text(200).min(1), reaction: text(2000).optional(), severity: z.enum(["leve", "moderada", "severa", "desconocida"]),
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
  contactId: z.uuid(), relationship: z.enum(CONTACT_RELATIONSHIPS), relationshipDetail: text(100).nullable().optional(), isPreferred: z.boolean(),
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
    dental: z.strictObject({
      ultimaVisita: text(2000).optional(), experienciaPrevia: z.enum(["positiva", "regular", "traumatica"]).optional(),
      ansiedadDental: z.enum(["ninguna", "leve", "moderada", "alta"]).optional(),
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
  for (const key of ["displayName", "birthDate"] as const) {
    if (config.fields[key] !== "required") issue(["fields", key], "Este campo es obligatorio en el formulario público")
  }
  if (config.fields.docType !== config.fields.docNumber) issue(["fields", "docNumber"], "Configura el documento como pareja")
  if (config.fields.phone !== "required" && config.fields.email !== "required") issue(["fields", "email"], "Exige al menos un medio de contacto")
  if (config.fields.insuranceType === "hidden" && config.fields.insuranceDetail !== "hidden") issue(["fields", "insuranceDetail"], "Habilita primero el seguro")
  if (config.enabled && !config.privacyNotice) issue(["privacyNotice"], "Ingresa el aviso de privacidad antes de publicar")
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
 * `countryCode` es el país de la clínica (ISO 3166-1 alfa-2): con él se acepta
 * un teléfono nacional escrito sin prefijo; sin él, solo con código de país.
 */
export function validateDemographics(value: unknown, today?: string, countryCode?: string | null): Record<string, string> {
  const errors: Record<string, string> = {}
  const parsed = demographicsSchema.safeParse(value)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) errors[issue.path.join(".")] ??= issue.message
    return errors
  }
  const data = parsed.data
  const docError = documentNumberError(data.docType, data.docNumber)
  if (docError) errors.docNumber = docError
  if (data.docNumber && !data.docType) errors.docType = "Indica el tipo de documento"
  if (data.docType && !data.docNumber) errors.docNumber = "Indica el número de documento"
  if (data.birthDate && (!isRealDate(data.birthDate) || (today && data.birthDate > today))) errors.birthDate = "Ingresa una fecha real no futura"
  if (data.insuranceDetail && !data.insuranceType) errors.insuranceDetail = "Indica primero el seguro"
  if (data.docCountry && !ISO_COUNTRY_RE.test(data.docCountry.toUpperCase())) errors.docCountry = "País emisor en código ISO de dos letras (p. ej. VE)"
  if (data.docType && FOREIGN_DOC_TYPES.includes(data.docType as never) && !data.docCountry) errors.docCountry = "Indica el país que emitió el documento"
  if (data.nationality && !ISO_COUNTRY_RE.test(data.nationality.toUpperCase())) errors.nationality = "Nacionalidad en código ISO de dos letras (p. ej. PE)"
  for (const key of ["addressUbigeo", "birthPlaceUbigeo"] as const)
    if (data[key] && !UBIGEO_RE.test(data[key] as string)) errors[key] = "Ubigeo de seis dígitos (INEI)"
  for (const key of ["phone", "emergencyContactPhone"] as const)
    if (data[key] && !normalizePhone(data[key], countryCode)) errors[key] = phoneFormatError(countryCode)
  if ((data.givenNames || data.maternalSurname) && !data.paternalSurname && !data.maternalSurname) errors.paternalSurname = "Indica al menos un apellido"
  if ((data.paternalSurname || data.maternalSurname) && !data.givenNames) errors.givenNames = "Indica los nombres"
  return errors
}
function registrationFieldValue(data: RegistrationAnswers, field: (typeof REGISTRATION_FIELDS)[number]): unknown {
  const key = field.key
  if (key.startsWith("dental.")) return data.health?.dental?.[key.slice(7) as keyof NonNullable<NonNullable<RegistrationAnswers["health"]>["dental"]>]
  if (field.step === "salud") return data.health?.[key as keyof NonNullable<RegistrationAnswers["health"]>]
  return data.demographics[key as keyof RegistrationDemographics]
}
function isUnanswered(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (typeof value === "object" && "state" in value && value.state === "unanswered")
}
/**
 * Lo que la clínica configuró como obligatorio y estas respuestas no traen.
 * Con el alcance `essentials` no impide registrar: es lo que queda por
 * completar en la clínica.
 */
export function pendingRegistrationFields(config: RegistrationConfig, answers: RegistrationAnswers): Array<{ key: RegistrationFieldKey; label: string }> {
  const representativeContact = !!answers.representative && !!(answers.representative.phone || answers.representative.email)
  return REGISTRATION_FIELDS.filter((field) => {
    if (config.fields[field.key] !== "required") return false
    if (field.key === "insuranceDetail" && !answers.demographics.insuranceType) return false
    if (representativeContact && (field.key === "phone" || field.key === "email")) return false
    return isUnanswered(registrationFieldValue(answers, field))
  }).map(({ key, label }) => ({ key, label }))
}
/**
 * Lo común del alcance `essentials`, lo registre la persona (enlace de reserva)
 * o el equipo (al reservar): solo datos de identidad y contacto, nada de salud,
 * y nombres y apellidos.
 */
function essentialIdentityErrors(data: RegistrationAnswers, errors: Record<string, string>): void {
  const demographics = data.demographics
  for (const [key, value] of Object.entries(demographics)) {
    if (!(ESSENTIAL_DEMOGRAPHICS as readonly string[]).includes(key) && value !== null && value !== "") errors[`demographics.${key}`] ??= "Este dato se completa en la clínica"
  }
  if (data.health !== undefined) errors.health = "Los datos de salud se completan en la clínica"
  if (!demographics.givenNames) errors["demographics.givenNames"] ??= "Indica los nombres"
  if (!demographics.paternalSurname && !demographics.maternalSurname) errors["demographics.paternalSurname"] ??= "Indica los apellidos"
}
export function validateRegistrationAnswers(config: RegistrationConfig, answers: RegistrationAnswers, context: { mode: "internal" | "public"; today: string; scope?: RegistrationScope; countryCode?: string | null }): Record<string, string> {
  const errors: Record<string, string> = {}
  const parsed = registrationAnswersSchema.safeParse(answers)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) errors[issue.path.join(".")] ??= issue.message
    return errors
  }
  const data = parsed.data
  for (const [key, message] of Object.entries(validateDemographics(data.demographics, context.today, context.countryCode))) errors[`demographics.${key}`] = message
  const minor = !!data.demographics.birthDate && isRealDate(data.demographics.birthDate) && isMinor(data.demographics.birthDate, context.today)
  const needsRepresentative = minor || data.respondent === "representative" || (context.mode === "internal" && data.respondent === "staff" && !!data.representative)
  if (needsRepresentative) {
    if (!data.representative) errors.representative = "Ingresa los datos del responsable"
    else {
      if (!data.representative.phone && !data.representative.email) errors["representative.phone"] = "Indica teléfono o correo del responsable"
      if (minor && data.representative.relationship !== "guardian") errors["representative.relationship"] = "Para menores corresponde tutor o responsable"
      if (minor && (!data.representative.docType || !data.representative.docNumber)) errors["representative.docNumber"] = "Indica el documento del representante legal"
      const repDocError = identityDocumentError(data.representative.docType, data.representative.docNumber)
      if (repDocError) errors["representative.docNumber"] = repDocError
    }
  } else if (data.representative) errors.representative = "Selecciona registrar a otra persona"
  if (context.mode === "public") {
    if (data.respondent === "staff") errors.respondent = "Selecciona quién declara la información"
    if (minor && data.respondent !== "representative") errors.respondent = "El responsable debe registrar al menor"
    if (!data.privacyAccepted) errors.privacyAccepted = "Debes aceptar el aviso de privacidad"
    const representativeContact = needsRepresentative && !!(data.representative?.phone || data.representative?.email)
    if (context.scope === "essentials") {
      // Datos esenciales para reservar: la identidad y un celular, siempre los
      // mismos. La configuración de la clínica no los quita ni añade otros: lo
      // que ella exige y aquí no se pide queda pendiente (`pendingRegistrationFields`).
      essentialIdentityErrors(data, errors)
      const demographics = data.demographics
      if (!demographics.docType) errors["demographics.docType"] ??= "Indica el tipo de documento"
      if (!demographics.docNumber) errors["demographics.docNumber"] ??= "Indica el número de documento"
      if (!demographics.phone && !representativeContact) errors["demographics.phone"] ??= "Indica un celular"
      // De la edad depende que haga falta un representante legal: se pide solo
      // cuando alguien registra a otra persona.
      if (data.respondent === "representative" && !demographics.birthDate) errors["demographics.birthDate"] ??= "Indica su fecha de nacimiento"
      return errors
    }
    for (const field of REGISTRATION_FIELDS) {
      const key = field.key
      const path = field.step === "datos" || field.step === "contacto" ? `demographics.${key}` : `health.${key}`
      const value = registrationFieldValue(data, field)
      if (config.fields[key] === "hidden") {
        if (value !== undefined) errors[path] = "Este campo no está habilitado"
        continue
      }
      if (key === "insuranceDetail" && !data.demographics.insuranceType) continue
      if (needsRepresentative && (key === "phone" || key === "email") && (data.representative?.phone || data.representative?.email)) continue
      if (config.fields[key] === "required" && isUnanswered(value)) errors[path] = "Este campo es obligatorio"
      if (["allergies", "conditions", "medications"].includes(key) && value === undefined) errors[path] = "Indica una respuesta, incluido Sin responder"
    }
    if (!data.demographics.phone && !data.demographics.email && !(needsRepresentative && (data.representative?.phone || data.representative?.email))) errors["demographics.phone"] = "Indica al menos un medio de contacto"
  } else if (context.scope === "essentials") {
    // Lo mínimo que registra el equipo al reservar: nombres, apellidos y, si se
    // conoce, el teléfono (a quien escribe ya se le conocen sus canales; a quien
    // llega por la Agenda el servicio le exige el teléfono). Como en el enlace
    // de reserva, lo que la clínica exige y aquí no se pide no bloquea: queda
    // pendiente (`pendingRegistrationFields`) y la identidad, por revisar.
    essentialIdentityErrors(data, errors)
  } else if (config.version > 0) {
    // Alta interna: lo que la clínica configuró como obligatorio también lo es
    // para recepción (el aviso de privacidad y los campos ocultos no aplican).
    // Sin configuración guardada rige el alta rápida.
    for (const field of REGISTRATION_FIELDS) {
      if (config.fields[field.key] !== "required" || field.step === "salud" || field.step === "odontologicos") continue
      if (needsRepresentative && (field.key === "phone" || field.key === "email") && (data.representative?.phone || data.representative?.email)) continue
      const value = data.demographics[field.key as keyof RegistrationDemographics]
      if (value === undefined || value === null || value === "")
        errors[`demographics.${field.key}`] = `${field.label}: obligatorio según la configuración del registro`
    }
  }
  return errors
}

import { z } from "zod"
import { ALLERGY_SEVERITIES, REFERRAL_KINDS } from "./catalogs.js"
import { CLINICAL_PRODUCTS, type ClinicalProduct } from "./products.js"
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
  ISO_COUNTRY_RE,
  identityDocumentError,
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
/** «No se pide», «Opcional» y «Obligatorio» en «Preguntas al paciente». */
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
 * - `clinic`: los que la clínica decide en «Preguntas al paciente»; cuentan
 *   solo si los marca obligatorios.
 * - `census`: opcionales y nunca obligatorios (nadie los usa para atender: ni
 *   impresos ni el agente; Reportes solo suma «Cómo nos conoció»). Nunca cuentan.
 * - `health`: los antecedentes que el registro puede preguntar. Los de la
 *   entrevista (`personal.*` y `dental.*`) llegan a «Entrevista de salud»
 *   de la ficha con las mismas claves y solo pueden ser opcionales.
 *
 * Un dato con `products` es solo de esos productos (ADR 0079): «Tu boca»
 * (`dental.*`), el corazón y la anestesia del dentista solo los preguntan las
 * clínicas dentales; el alcohol, los consultorios de latidIA. La lactancia y el
 * tabaco nacieron en latidIA (issue 229, decisión 13; por eso `medical.*`) y
 * también los pregunta odentIA, con la misma clave y la misma forma de guardarlos:
 * no hay dos datos para lo mismo.
 *
 * `step` es el paso en que se pregunta: «Tu salud» (`salud`) y, aparte y una sola
 * vez, «Tus medicinas» (`medicinas`): primero las dos que cambian lo que se hace
 * en la cita (anticoagulantes y medicinas para los huesos) y al final «algún otro».
 *
 * Solo entran aquí datos que el paciente sabe responder solo y que la ficha ya
 * guarda. Lo que se pregunta junto (la referencia con la dirección, el
 * parentesco con el contacto de emergencia, la aseguradora con el seguro) sigue
 * a su dato y nunca es obligatorio.
 */
export type RegistrationFieldGroup = "always" | "clinic" | "census" | "health"

interface RegistrationFieldDef {
  key: string
  label: string
  step: string
  group: RegistrationFieldGroup
  products?: readonly ClinicalProduct[]
}

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
  { key: "allergies", label: "Alergias y qué le pasó", step: "salud", group: "health" },
  { key: "conditions", label: "Enfermedades", step: "salud", group: "health" },
  { key: "dental.corazon", label: "Corazón", step: "salud", group: "health", products: ["dental"] },
  { key: "dental.problemaAnestesia", label: "Problemas con la anestesia", step: "salud", group: "health", products: ["dental"] },
  { key: "anticoagulants", label: "Anticoagulantes", step: "medicinas", group: "health", products: ["dental", "medical"] },
  { key: "boneMedicines", label: "Medicinas para los huesos", step: "medicinas", group: "health", products: ["dental", "medical"] },
  { key: "medications", label: "Otros medicamentos", step: "medicinas", group: "health" },
  { key: "personal.embarazo", label: "Embarazo", step: "personales", group: "health" },
  { key: "personal.cirugias", label: "Operaciones", step: "personales", group: "health" },
  { key: "personal.hospitalizaciones", label: "Hospitalizaciones", step: "personales", group: "health" },
  { key: "personal.transfusiones", label: "Transfusiones", step: "personales", group: "health" },
  { key: "medical.lactancia", label: "Lactancia", step: "personales", group: "health", products: ["medical", "dental"] },
  { key: "medical.tabaco", label: "Si fuma y cuánto", step: "habitos", group: "health", products: ["medical", "dental"] },
  { key: "medical.alcohol", label: "Alcohol", step: "habitos", group: "health", products: ["dental", "medical"] },
  { key: "dental.ultimaVisita", label: "Última visita dental", step: "odontologicos", group: "health", products: ["dental"] },
  { key: "dental.experienciaPrevia", label: "Experiencia previa", step: "odontologicos", group: "health", products: ["dental"] },
  { key: "dental.ansiedadDental", label: "Ansiedad dental", step: "odontologicos", group: "health", products: ["dental"] },
  { key: "dental.cepilladosAlDia", label: "Cepillado diario", step: "odontologicos", group: "health", products: ["dental"] },
  { key: "dental.hiloDental", label: "Hilo dental", step: "odontologicos", group: "health", products: ["dental"] },
  { key: "dental.bruxismo", label: "Bruxismo", step: "odontologicos", group: "health", products: ["dental"] },
  { key: "dental.habitos", label: "Hábitos", step: "odontologicos", group: "health", products: ["dental"] },
] as const satisfies readonly RegistrationFieldDef[]
export type RegistrationFieldKey = (typeof REGISTRATION_FIELDS)[number]["key"]

/**
 * La versión de la lista de preguntas: sube cuando se suman preguntas, para
 * avisarle a quien administra una clínica que ya existía («Hay preguntas nuevas»).
 * `QUESTIONS_SINCE` dice desde qué versión existe cada pregunta nueva; con un
 * mapa por producto, desde cuándo la pregunta ese producto (la lactancia y el
 * tabaco ya eran de latidIA: son nuevos solo en odentIA). Lo que no figura es de
 * la versión 1.
 */
export const REGISTRATION_QUESTIONS_VERSION = 2
const QUESTIONS_SINCE: Partial<Record<RegistrationFieldKey, number | Partial<Record<ClinicalProduct, number>>>> = {
  "dental.corazon": 2,
  "dental.problemaAnestesia": 2,
  anticoagulants: 2,
  boneMedicines: 2,
  "medical.lactancia": { dental: 2 },
  "medical.tabaco": { dental: 2 },
  "medical.alcohol": { dental: 2 },
}

const fieldProducts = (field: (typeof REGISTRATION_FIELDS)[number]): readonly ClinicalProduct[] | null =>
  "products" in field ? field.products : null

/**
 * Las preguntas que la lista sumó después de la versión que la clínica ya vio
 * (`seenVersion`), para su producto: las que nacieron encendidas sin que nadie
 * de la clínica las mirara todavía.
 */
export function newRegistrationQuestions(
  seenVersion: number,
  product: ClinicalProduct = "dental",
): Array<{ key: RegistrationFieldKey; label: string }> {
  return REGISTRATION_FIELDS.filter((field) => {
    const products = fieldProducts(field)
    if (products && !products.includes(product)) return false
    const since = QUESTIONS_SINCE[field.key]
    const version = typeof since === "number" ? since : (since?.[product] ?? 1)
    return version > seenVersion
  }).map(({ key, label }) => ({ key, label }))
}
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
/**
 * Lo que se pregunta como «Opcional» mientras la clínica no diga otra cosa. Las
 * preguntas de salud que suma la lista nacen aquí: una clínica nueva las trae
 * encendidas y una que ya existía las recibe igual (su configuración guardada no
 * las nombra y toman este valor; mesa del 13 nov, decisión 10), con el aviso de
 * `newRegistrationQuestions` a quien la administra.
 */
const optionalDefaults: Record<string, true> = {
  docType: true, docNumber: true, email: true, sex: true, address: true, bloodGroup: true,
  allergies: true, conditions: true, medications: true,
  anticoagulants: true, boneMedicines: true, "dental.corazon": true, "dental.problemaAnestesia": true,
  "medical.lactancia": true, "medical.tabaco": true, "medical.alcohol": true,
}
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
/** `emptyYes`: un Sí sin decir cuál vale (los medicamentos, QA del 14 nov, B15). */
const declaration = <T extends z.ZodType>(item: T, options: { emptyYes?: boolean } = {}) => z.strictObject({
  state: z.enum(["unanswered", "unknown", "none", "recorded"]), items: z.array(item).max(50),
}).refine(v => v.state === "recorded" ? options.emptyYes === true || v.items.length > 0 : v.items.length === 0, "Indica entradas solo cuando la respuesta sea Sí")
/**
 * Una medicina que se pregunta por su clase («¿Tomas algún anticoagulante?»):
 * Sí (`recorded`), No (`none`) o No sé (`unknown`), con los mismos estados de
 * los demás grupos de salud, y «¿Cuál?» solo con el Sí. La marca de la ficha
 * sale de esta respuesta, no de reconocer el nombre escrito.
 */
export const directedMedicineSchema = z.strictObject({
  state: z.enum(["unanswered", "unknown", "none", "recorded"]), detail: text(200).optional(),
}).refine(v => v.state === "recorded" || !v.detail, "Indica cuál solo cuando la respuesta sea Sí")
export type DirectedMedicineDeclaration = z.infer<typeof directedMedicineSchema>
/** Sí, No o No sé de una pregunta de la entrevista, como lo dice quien responde. */
export const INTERVIEW_ANSWERS = ["si", "no", "no_sabe"] as const
export type InterviewAnswer = (typeof INTERVIEW_ANSWERS)[number]
export const INTERVIEW_ANSWER_LABELS: Record<InterviewAnswer, string> = { si: "Sí", no: "No", no_sabe: "No sabe" }
/**
 * Cuánto fuma quien fuma, como lo responde el paciente: el corte de 10 al día
 * es el del grado de la periodontitis (AAP/EFP 2018) y el de los implantes. Va
 * junto a `habitos.tabaco` de la entrevista (la forma de latidIA); el número
 * exacto (`cigarrillosDia`) lo anota el profesional si lo pregunta.
 */
export const CIGARETTE_BANDS = ["menos_10", "10_o_mas"] as const
/** Si fuma, como lo responde el paciente (la forma de `habitos.tabaco` en la entrevista). */
export const TOBACCO_ANSWERS = ["nunca", "fuma", "dejo"] as const
export type CigaretteBand = (typeof CIGARETTE_BANDS)[number]
export const CIGARETTE_BAND_LABELS: Record<CigaretteBand, string> = { menos_10: "menos de 10 al día", "10_o_mas": "10 o más al día" }
/**
 * Las enfermedades que el paciente marca de una lista, en sus palabras; lo que
 * no está lo escribe en «Otra». Cada una entra a Antecedentes con este nombre y
 * sin código: lo que marca un paciente no es un diagnóstico, y el código de la
 * lista de la clínica (CIE-10) lo pone el profesional al revisarlo, como en
 * cualquier enfermedad declarada. «Problemas de sangrado» y «Radioterapia en
 * cabeza o cuello» cambian una extracción (historia de salud de la ADA).
 */
export const DECLARED_CONDITION_OPTIONS = [
  "Diabetes", "Presión alta", "Problema del corazón (infarto, angina, arritmia, marcapasos)", "Asma", "Epilepsia", "Hepatitis",
  "Problemas de sangrado", "Radioterapia en cabeza o cuello",
] as const
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
    /** «¿Algún otro medicamento todos los días?»: lo que no es anticoagulante ni para los huesos. */
    medications: declaration(healthMedicationDeclarationSchema, { emptyYes: true }).optional(),
    /** Anticoagulantes o aspirina diaria (grupo ATC B01A) y medicinas para los huesos (M05B), ahora o antes. */
    anticoagulants: directedMedicineSchema.optional(),
    boneMedicines: directedMedicineSchema.optional(),
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
      /**
       * Lo que decide un antibiótico antes de atender (AHA 2021, prevención de la endocarditis): una
       * válvula operada, un problema del corazón de nacimiento o una endocarditis previa, y si un
       * médico ya se lo indicó.
       */
      corazon: z.strictObject({
        riesgoEndocarditis: z.enum(INTERVIEW_ANSWERS).optional(), antibioticoPrevio: z.enum(INTERVIEW_ANSWERS).optional(),
      }).refine(v => v.riesgoEndocarditis !== undefined || v.antibioticoPrevio !== undefined, "Responde al menos una de las dos").optional(),
      /** Un problema con la anestesia del dentista o un sangrado largo tras una extracción. */
      problemaAnestesia: z.enum(INTERVIEW_ANSWERS).optional(),
    }).optional(),
    /**
     * Lactancia y hábitos: van a «Embarazo y lactancia» y «Hábitos» de la entrevista, con la forma
     * de latidIA. La lactancia y el tabaco los pregunta también odentIA; el alcohol, solo latidIA.
     */
    medical: z.strictObject({
      lactancia: z.boolean().optional(), tabaco: z.enum(TOBACCO_ANSWERS).optional(),
      /** Cuánto, solo de quien fuma. */
      cigarrillos: z.enum(CIGARETTE_BANDS).optional(),
      alcohol: z.enum(["no", "ocasional", "frecuente"]).optional(),
    }).refine(v => v.cigarrillos === undefined || v.tabaco === "fuma", { message: "Cuántos al día se dice solo de quien fuma", path: ["cigarrillos"] }).optional(),
    /** vistIA todavía no pregunta nada propio en el registro: sus antecedentes de la vista llegan con el examen. */
    optical: z.strictObject({}).optional(),
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
 * errores dicen qué arreglar, nunca «formato inválido». `partialName`: quien
 * aún no es paciente puede tener solo sus nombres o solo sus apellidos, lo que
 * se sepa (ADR 0130); un paciente lleva los dos.
 */
export function validateDemographics(
  value: unknown,
  today?: string,
  countryCode?: string | null,
  previous?: Partial<Record<string, unknown>>,
  options?: { partialName?: boolean },
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
  if (!options?.partialName) {
    if (data.givenNames && !data.familyName) errors.familyName = "Escribe los apellidos"
    if (data.familyName && !data.givenNames) errors.givenNames = "Escribe los nombres"
  }
  countryErrors(data, profile, previous, errors)
  return errors
}
/**
 * Los apartados de la salud con nombre propio: la entrevista (`personal.*`) y lo
 * de cada producto (`dental.*`, `medical.*`). Un producto nuevo trae el suyo en
 * `health`, o el compilador lo pide aquí.
 */
const HEALTH_SECTIONS = ["personal", ...CLINICAL_PRODUCTS] as const
type HealthSection = (typeof HEALTH_SECTIONS)[number]

/** El apartado de la salud de una clave del registro («dental.bruxismo» → «dental»); null si no es de uno. */
export function registrationHealthSection(key: string): HealthSection | null {
  const prefix = key.slice(0, key.indexOf("."))
  return HEALTH_SECTIONS.find((section) => section === prefix) ?? null
}

function registrationFieldValue(data: RegistrationAnswers, field: (typeof REGISTRATION_FIELDS)[number]): unknown {
  const key = field.key
  const section = registrationHealthSection(key)
  if (section) {
    const answers: Record<string, unknown> | undefined = data.health?.[section]
    return answers?.[key.slice(section.length + 1)]
  }
  if (field.group === "health") return data.health?.[key as keyof NonNullable<RegistrationAnswers["health"]>]
  return data.demographics[key as keyof RegistrationDemographics]
}

/**
 * Si de su salud se respondió algo: un grupo con respuesta, el grupo sanguíneo o
 * cualquier dato de la entrevista. Un registro que solo dice el embarazo o que
 * no toma anticoagulantes también es una declaración: no se pierde.
 */
export function declaredHealthAnswered(health: RegistrationAnswers["health"]): boolean {
  if (!health) return false
  if (health.bloodGroup != null) return true
  for (const group of [health.allergies, health.conditions, health.medications, health.anticoagulants, health.boneMedicines])
    if (group && group.state !== "unanswered") return true
  return [health.personal, health.dental, health.medical].some((group) =>
    Object.values(group ?? {}).some((value) => value !== undefined && value !== ""),
  )
}

/**
 * La lactancia y el tabaco que declaró, con las claves de la entrevista de la
 * ficha: la lactancia con el día en que se dijo (`embarazoLactancia.lactancia`,
 * como el embarazo) y el tabaco con cuánto fuma (`habitos.tabaco` y
 * `habitos.cigarrillos`). Una sola forma para odentIA y latidIA: no hay dos
 * datos para lo mismo. El alcohol lo suma solo latidIA.
 */
export function declaredLactationAndTobacco(
  medical: NonNullable<RegistrationAnswers["health"]>["medical"],
  today: string,
): { embarazoLactancia?: { lactancia: { estado: "si" | "no"; fecha: string } }; habitos?: Record<string, string> } {
  const out: ReturnType<typeof declaredLactationAndTobacco> = {}
  if (typeof medical?.lactancia === "boolean")
    out.embarazoLactancia = { lactancia: { estado: medical.lactancia ? "si" : "no", fecha: today } }
  if (medical?.tabaco)
    out.habitos = {
      tabaco: medical.tabaco,
      ...(medical.tabaco === "fuma" && medical.cigarrillos ? { cigarrillos: medical.cigarrillos } : {}),
    }
  // El alcohol, con la misma clave en los dos productos (QA del 14 nov, C4: también en odentIA).
  if (medical?.alcohol) out.habitos = { ...(out.habitos ?? {}), alcohol: medical.alcohol }
  return out
}

/**
 * A quién se le pregunta cada dato de salud: el embarazo y la lactancia, solo a
 * mujeres de 12 a 55 años (sin el sexo o la edad en la ficha se pregunta: no se
 * supone). Una sola regla para el registro, «Su enlace» y lo que el servidor
 * cuenta como «falta preguntar».
 */
export function registrationFieldApplies(
  key: RegistrationFieldKey,
  person: { sex?: string | null; age?: number | null },
): boolean {
  // El tabaco y el alcohol, desde los 12 años: a un niño de 7 no se le pregunta si fuma (QA del 14 nov, B4).
  if (key === "medical.tabaco" || key === "medical.alcohol") return person.age == null || person.age >= 12
  if (key !== "personal.embarazo" && key !== "medical.lactancia") return true
  if (person.sex === "M") return false
  return person.age == null || (person.age >= 12 && person.age <= 55)
}

/** Los años cumplidos a una fecha (YYYY-MM-DD); null si la fecha de nacimiento no es real. */
export function ageInYears(birthDate: string | null | undefined, today: string): number | null {
  if (!birthDate || !isRealDate(birthDate)) return null
  return Number(today.slice(0, 4)) - Number(birthDate.slice(0, 4)) - (today.slice(5) < birthDate.slice(5) ? 1 : 0)
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

/**
 * Un dato que le falta a la persona para atenderla, con su nombre en pantalla.
 * `representativeDoc` no es de ella: un menor cuyo representante legal no tiene
 * documento (lo pide la firma de su consentimiento). Solo lo ve el equipo: su
 * enlace no lo pide (`getStaffMissingData` en los servicios).
 */
export interface MissingPersonDatum {
  key:
    | "givenNames" | "familyName" | "birthDate" | "phone" | "docType" | "docNumber"
    | "sex" | "nationality" | "birthPlace" | "email" | "address" | "emergencyContactName" | "emergencyContactPhone"
    | "insuranceType"
    | "representativeDoc"
  label: string
}

/** Lo que falta de su representante legal, dicho como un dato más de «Faltan datos». */
export const REPRESENTATIVE_DOC_GAP: MissingPersonDatum = {
  key: "representativeDoc",
  label: "Documento de su representante",
}

/**
 * «Faltan datos para atenderla»: una sola regla para la página de la persona,
 * la Agenda, la nota del caso y el registro (decisión 10 de la fase 3). Cuentan
 * siempre nombres, apellidos, fecha de nacimiento y un teléfono o correo
 * (suyo o de quien habla por ella); además, lo que «Preguntas al paciente»
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
 * clínicas de Perú y lo de un producto (`products`: «Tu boca», el alcohol)
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
  const products = field ? fieldProducts(field) : null
  if (products && !products.includes(product)) return false
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
      // En la clínica, el documento de quien lo representa no frena registrar al menor: se pide al
      // firmar un consentimiento (la firma lo exige y lo deja escribir). Desde fuera sí: es lo que
      // identifica a quien registra (QA de la ficha del 9 nov; lo legal, NTS 139, queda por validar).
      if (minor && context.mode === "public" && (!data.representative.docType || !data.representative.docNumber))
        errors["representative.docNumber"] = "Escribe el documento del representante legal"
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
    // Lo mínimo que registra el equipo: nombres, apellidos y, si lo tiene, el
    // teléfono (a quien escribe ya se le conocen sus canales; quien llega sin
    // celular se registra igual y la pantalla avisa que no le llegarán sus
    // avisos). Como en el enlace de reserva, lo que la clínica exige y aquí no
    // se pide no bloquea: queda pendiente (`pendingRegistrationFields`).
    essentialIdentityErrors(data, errors, (key) => (ESSENTIAL_DEMOGRAPHICS as readonly string[]).includes(key))
  } else if (config.version > 0) {
    // Alta interna: lo que la clínica configuró como obligatorio también lo es
    // para recepción (el aviso de privacidad y los campos ocultos no aplican).
    // Sin configuración guardada rige el alta rápida.
    for (const field of REGISTRATION_FIELDS) {
      if (config.fields[field.key] !== "required" || field.group === "health") continue
      if (field.key === "phone") {
        if (!data.demographics.phone && !data.demographics.email && !representativeContact)
          errors["demographics.phone"] = "Teléfono o correo: hace falta uno para la atención"
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

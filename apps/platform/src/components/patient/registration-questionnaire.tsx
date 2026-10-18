import {
  clinicalProfileFor,
  composeDisplayName,
  DOC_TYPE_LABELS,
  EDUCATION_LEVEL_LABELS,
  EDUCATION_LEVELS,
  type IdentityDocType,
  INSURANCE_TYPE_LABELS,
  type InsuranceType,
  isMinor,
  isRealDate,
  KINSHIP,
  KINSHIP_LABELS,
  MARITAL_STATUS_LABELS,
  type RegistrationAnswers,
  type RegistrationConfig,
  type RegistrationFieldKey,
  registrationFieldAsked,
  SEX_CODES,
  SEX_LABELS,
  validateRegistrationAnswers,
} from "@odentia/clinical"
import {
  Button,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSkip,
  QuestionnaireSubmit,
  QuestionnaireTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@odentia/ui"
import { BirthDateInput, normalizeCountry, PhoneInput } from "@odentia/ui-patterns"
import { createContext, useContext, useId, useState } from "react"
import { asksDocumentCountry, countryChoices } from "../../lib/person-data"
import { ChoiceButtons, MultiChoiceButtons } from "../choice-buttons"
import { SearchSelect } from "../settings/search-select"
import { DocTypeChoice } from "./doc-type-choice"
import { BLOOD_GROUP_LABELS } from "./patient-health-fields"

/**
 * El registro que llena el paciente (código QR, enlace de la clínica) y su
 * vista previa en Configuración: el Questionnaire de shadcn con una pantalla
 * por tema («Tus datos», «Tu documento», «¿Cómo te contactamos?», «Tu
 * salud»…), cada una con sus campos juntos, «(opcional)» en lo que puede
 * quedar en blanco y «Saltar» cuando todo el tema es opcional. Solo aparece lo
 * que la clínica pide. Al enviar valida con la misma regla del servidor
 * (`validateRegistrationAnswers`) y lo que falla lleva a su pantalla y su campo.
 *
 * «Nombres» y «Apellidos» son dos campos (ADR 0058).
 */
type Respondent = "patient" | "representative"
type Declared = "" | "none" | "recorded" | "unknown"
type Relation = "" | "guardian" | "family" | "other"
type YesNo = "" | "si" | "no"
type YesNoUnknown = "" | "si" | "no" | "nose"

interface Draft {
  respondent: Respondent
  givenNames: string
  surnames: string
  birthDate: string
  sex: string
  nationality: string
  birthPlace: string
  repName: string
  repRelation: Relation
  repPhone: string
  repPhoneDigits: number
  repDoc: string
  docType: IdentityDocType | null
  docCountry: string
  docNumber: string
  phone: string
  phoneDigits: number
  email: string
  address: string
  addressCity: string
  addressReference: string
  emergencyName: string
  emergencyPhone: string
  emergencyPhoneDigits: number
  emergencyRelationship: string
  insurance: string
  insurerName: string
  affiliationNumber: string
  allergies: Declared
  allergiesText: string
  conditions: Declared
  conditionsText: string
  medications: Declared
  medicationsText: string
  bloodGroup: string
  pregnant: YesNoUnknown
  pregnancyWeeks: string
  surgeries: YesNo
  surgeriesText: string
  hospitalized: YesNo
  hospitalizedText: string
  transfusion: YesNo
  transfusionText: string
  dentalLast: string
  dentalExperience: string
  dentalAnxiety: string
  brushing: string
  floss: YesNo
  bruxism: YesNoUnknown
  habits: string[]
  maritalStatus: string
  educationLevel: string
  occupation: string
  origin: string
  referralSource: string
  messages: "" | "si" | "no"
  privacy: boolean
}

const EMPTY: Draft = {
  respondent: "patient",
  givenNames: "",
  surnames: "",
  birthDate: "",
  sex: "",
  nationality: "",
  birthPlace: "",
  repName: "",
  repRelation: "",
  repPhone: "",
  repPhoneDigits: 0,
  repDoc: "",
  docType: null,
  docCountry: "",
  docNumber: "",
  phone: "",
  phoneDigits: 0,
  email: "",
  address: "",
  addressCity: "",
  addressReference: "",
  emergencyName: "",
  emergencyPhone: "",
  emergencyPhoneDigits: 0,
  emergencyRelationship: "",
  insurance: "",
  insurerName: "",
  affiliationNumber: "",
  allergies: "",
  allergiesText: "",
  conditions: "",
  conditionsText: "",
  medications: "",
  medicationsText: "",
  bloodGroup: "",
  pregnant: "",
  pregnancyWeeks: "",
  surgeries: "",
  surgeriesText: "",
  hospitalized: "",
  hospitalizedText: "",
  transfusion: "",
  transfusionText: "",
  dentalLast: "",
  dentalExperience: "",
  dentalAnxiety: "",
  brushing: "",
  floss: "",
  bruxism: "",
  habits: [],
  maritalStatus: "",
  educationLevel: "",
  occupation: "",
  origin: "",
  referralSource: "",
  messages: "",
  privacy: false,
}

const DECLARED: ReadonlyArray<{ value: Exclude<Declared, "">; label: string }> = [
  { value: "none", label: "No" },
  { value: "recorded", label: "Sí" },
  { value: "unknown", label: "No sé" },
]
const YES_NO: ReadonlyArray<{ value: Exclude<YesNo, "">; label: string }> = [
  { value: "no", label: "No" },
  { value: "si", label: "Sí" },
]
const YES_NO_UNKNOWN: ReadonlyArray<{ value: Exclude<YesNoUnknown, "">; label: string }> = [
  { value: "no", label: "No" },
  { value: "si", label: "Sí" },
  { value: "nose", label: "No sé" },
]
const RELATIONS: ReadonlyArray<{ value: Exclude<Relation, "">; label: string; detail: string }> = [
  { value: "guardian", label: "Madre, padre o tutor", detail: "Madre, padre o tutor" },
  { value: "family", label: "Familiar", detail: "Familiar" },
  { value: "other", label: "Otra relación", detail: "Otra relación" },
]
const EXPERIENCES = [
  { value: "positiva", label: "Bien" },
  { value: "regular", label: "Regular" },
  { value: "traumatica", label: "Mal" },
] as const
const ANXIETY = [
  { value: "ninguna", label: "No" },
  { value: "leve", label: "Un poco" },
  { value: "moderada", label: "Bastante" },
  { value: "alta", label: "Mucho" },
] as const
const BRUSHING = [
  { value: "0", label: "Ninguna" },
  { value: "1", label: "1" },
  { value: "2", label: "2" },
  { value: "3", label: "3 o más" },
] as const
/** Los hábitos que más pesan en la boca, en palabras del paciente. */
const HABITS = [
  "Fumar",
  "Morderse las uñas",
  "Morder lápices u objetos",
  "Respirar por la boca",
  "Chuparse el dedo",
].map((habit) => ({ value: habit, label: habit }))
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_PROBLEM = "Revisa el número: está incompleto o no es un celular."

/** La pantalla y el campo donde se corrige cada dato que rechaza la validación (el primer prefijo que coincide). */
const WHERE: ReadonlyArray<readonly [string, string, string?]> = [
  ["respondent", "respondent"],
  ["demographics.givenNames", "person", "givenNames"],
  ["demographics.familyName", "person", "surnames"],
  ["demographics.displayName", "person", "givenNames"],
  ["demographics.birthDate", "person", "birthDate"],
  ["demographics.sex", "person", "sex"],
  ["demographics.nationality", "person", "nationality"],
  ["demographics.birthPlace", "person", "birthPlace"],
  ["demographics.docType", "document", "docType"],
  ["demographics.docCountry", "document", "docCountry"],
  ["demographics.docNumber", "document", "docNumber"],
  ["demographics.phone", "contact", "phone"],
  ["demographics.email", "contact", "email"],
  ["demographics.addressCity", "contact", "addressCity"],
  ["demographics.address", "contact", "address"],
  ["demographics.emergencyContactName", "emergency", "emergencyName"],
  ["demographics.emergencyContactPhone", "emergency", "emergencyPhone"],
  ["demographics.emergencyContact", "emergency", "emergencyRelationship"],
  ["demographics.insurerName", "insurance", "insurerName"],
  ["demographics.affiliationNumber", "insurance", "affiliationNumber"],
  ["demographics.insurance", "insurance", "insurance"],
  ["demographics.maritalStatus", "census", "maritalStatus"],
  ["demographics.educationLevel", "census", "educationLevel"],
  ["demographics.occupation", "census", "occupation"],
  ["demographics.origin", "census", "origin"],
  ["demographics.referralSource", "census", "referralSource"],
  ["representative.relationship", "rep", "repRelation"],
  ["representative.phone", "rep", "repPhone"],
  ["representative.doc", "rep", "repDoc"],
  ["representative", "rep", "repName"],
  ["health.allergies", "health", "allergies"],
  ["health.conditions", "health", "conditions"],
  ["health.medications", "health", "medications"],
  ["health.bloodGroup", "health", "bloodGroup"],
  ["health.personal", "history"],
  ["health.dental", "dental"],
  ["privacyAccepted", "send"],
]

type Problem = { item: string; field?: string; message: string } | null
type Found = { field: string; message: string } | null
/** En una pantalla donde todo es opcional, los campos no repiten «(opcional)»: lo dice la pantalla. */
const AllOptionalContext = createContext(false)
const ProblemContext = createContext<{ problem: Problem; setProblem: (next: Problem) => void }>({
  problem: null,
  setProblem: () => {},
})

/**
 * «Su enlace»: quien ya es paciente completa solo lo que le falta y, si nadie
 * la registró aún, su salud. Lo guardado no se muestra.
 */
export interface RegistrationFill {
  /** Las claves de lo que falta (`missingData` del servidor). */
  missing: ReadonlySet<string>
  /** Si se le pregunta su salud. */
  health: boolean
  /** Si ya tiene representante legal: un menor sin él lo deja aquí mismo. */
  hasRepresentative: boolean
  /** Su nombre, para saludarla. */
  firstName?: string | null
}

const HEALTH_KEYS = new Set(["allergies", "conditions", "medications", "bloodGroup"])
const PERSON_KEYS = ["givenNames", "familyName", "birthDate", "sex", "nationality", "birthPlace"] as const

/** De lo que falta, lo que se escribe para completarlo (la misma regla del servidor). */
function fillWants(fill: RegistrationFill, key: string): boolean {
  const has = (name: string) => fill.missing.has(name)
  if (key === "docType" || key === "docNumber" || key === "docCountry") return has("docType") || has("docNumber")
  if (key === "email") return has("email") || has("phone")
  return has(key)
}

function ageOn(birthDate: string, today: string): number | null {
  if (!isRealDate(birthDate)) return null
  const [by = 0, bm = 0, bd = 0] = birthDate.split("-").map(Number)
  const [ty = 0, tm = 0, td = 0] = today.split("-").map(Number)
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0)
}

export function RegistrationQuestionnaire({
  config,
  today,
  countryCode,
  ownRecord = false,
  fill,
  submitLabel = "Enviar registro",
  shortcuts = true,
  onSubmit,
}: {
  config: RegistrationConfig
  today: string
  countryCode: string | null
  /** Quien abrió su enlace ya tiene su ficha: registra a otra persona. */
  ownRecord?: boolean
  /** «Su enlace»: solo lo que falta (y su salud), sin registrar a nadie. */
  fill?: RegistrationFill
  submitLabel?: string
  /** Letras de atajo para el teclado; la vista previa imita un celular y no las lleva. */
  shortcuts?: boolean
  /** Recibe las respuestas ya validadas. Si lanza un error, su mensaje se muestra en la última pantalla. */
  onSubmit: (answers: RegistrationAnswers) => Promise<void>
}) {
  const uid = useId()
  const id = (name: string) => `${uid}-${name}`
  const profile = clinicalProfileFor(countryCode)
  const phoneCountry = normalizeCountry(countryCode)
  const [draft, setDraft] = useState<Draft>(() => ({
    ...EMPTY,
    respondent: ownRecord ? "representative" : "patient",
  }))
  const [item, setItem] = useState(() => {
    if (!fill) return ownRecord ? "person" : "respondent"
    const wants = (key: string) => fillWants(fill, key)
    if (PERSON_KEYS.some(wants)) return "person"
    if (wants("docType")) return "document"
    if (wants("phone") || wants("email") || wants("address")) return "contact"
    if (wants("emergencyContactName")) return "emergency"
    if (wants("insuranceType")) return "insurance"
    return fill.health ? "health" : "send"
  })
  const [problem, setProblem] = useState<Problem>(null)
  const [sending, setSending] = useState(false)

  const set = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }))
    // Corregir el campo quita su aviso; un aviso sin campo (del servidor) se quita con cualquier cambio.
    if (problem && (!problem.field || problem.field in patch)) setProblem(null)
  }
  // En «Su enlace» se pregunta solo lo que falta; la salud, si nadie la registró, como la pide la clínica.
  const wants = (key: string) => !fill || fillWants(fill, key)
  const asked = (key: RegistrationFieldKey) =>
    !fill
      ? registrationFieldAsked(config, key, countryCode)
      : HEALTH_KEYS.has(key) || key.startsWith("personal.") || key.startsWith("dental.")
        ? fill.health && registrationFieldAsked(config, key, countryCode)
        : fillWants(fill, key)
  const required = (key: RegistrationFieldKey) => config.fields[key] === "required"
  // Menor sin representante legal: en «Su enlace» deja los datos de su madre, padre o tutor.
  const repInFill = !!fill && !fill.hasRepresentative
  const flag = (field: string) => (problem?.field === field ? true : undefined)
  const forOther = draft.respondent === "representative"
  const minor = isRealDate(draft.birthDate) && isMinor(draft.birthDate, today)
  const age = ageOn(draft.birthDate, today)
  const docTypes = profile.documentTypes.map(({ code }) => ({
    value: code,
    label: DOC_TYPE_LABELS[code],
  }))
  const repDocType = (docTypes[0]?.value ?? "DNI") as IdentityDocType
  const countries = countryChoices(profile.country)
  // «¿Cuándo nació Mateo?»: con su nombre en cuanto se sabe.
  const first = draft.givenNames.trim().split(/\s+/)[0] ?? ""
  const name = first || "la persona"
  const you = (self: string, other: string) => (forOther ? other : self)
  // Con el correo en el registro, basta el celular o el correo.
  const phoneRequired = !forOther && !asked("email") && wants("phone")

  // El seguro se elige por su nombre del país (SIS, EsSalud, EPS) o por su tipo general.
  const insuranceOptions: Array<{
    value: string
    label: string
    type: InsuranceType
    scheme?: string
  }> = [
    ...profile.insuranceSchemes.map((scheme) => ({
      value: `scheme:${scheme.code}`,
      label: scheme.label,
      type: scheme.type,
      scheme: scheme.code,
    })),
    ...(profile.insuranceSchemes.length === 0
      ? [{ value: "type:PUBLICO", label: INSURANCE_TYPE_LABELS.PUBLICO, type: "PUBLICO" as const }]
      : []),
    {
      value: "type:PRIVADO",
      label: profile.insuranceSchemes.some((scheme) => scheme.type === "PRIVADO")
        ? "Otro seguro privado"
        : "Privado",
      type: "PRIVADO",
    },
    { value: "type:PARTICULAR", label: "No tengo seguro", type: "PARTICULAR" },
    { value: "type:OTRO", label: "Otro", type: "OTRO" },
  ]
  const insurance = insuranceOptions.find((option) => option.value === draft.insurance)
  const privateInsurance = insurance?.type === "PRIVADO" || insurance?.type === "OTRO"

  const healthAsked = (["allergies", "conditions", "medications", "bloodGroup"] as const).some(
    asked,
  )
  const pregnancyAsked =
    asked("personal.embarazo") && draft.sex !== "M" && (age === null || (age >= 12 && age <= 55))
  const historyAsked =
    pregnancyAsked ||
    (["personal.cirugias", "personal.hospitalizaciones", "personal.transfusiones"] as const).some(
      asked,
    )
  const dentalKeys = [
    "dental.ultimaVisita",
    "dental.experienciaPrevia",
    "dental.ansiedadDental",
    "dental.cepilladosAlDia",
    "dental.hiloDental",
    "dental.bruxismo",
    "dental.habitos",
  ] as const
  const censusKeys = [
    "maritalStatus",
    "educationLevel",
    "occupation",
    "origin",
    "referralSource",
  ] as const
  // A un menor no se le pregunta su estado civil ni su ocupación.
  const censusAsked = (key: (typeof censusKeys)[number]) =>
    asked(key) && !(minor && (key === "maritalStatus" || key === "occupation"))

  function buildAnswers(): RegistrationAnswers {
    const d = draft
    const familyName = d.surnames.trim()
    const demographics: Record<string, string> = {
      displayName: composeDisplayName({
        givenNames: d.givenNames.trim(),
        familyName,
      }),
      givenNames: d.givenNames.trim(),
      familyName,
      birthDate: d.birthDate,
      phone: d.phone,
    }
    const put = (key: string, value: string) => {
      if (value.trim()) demographics[key] = value.trim()
    }
    if (asked("sex")) put("sex", d.sex)
    if (asked("nationality")) put("nationality", d.nationality)
    if (asked("birthPlace")) put("birthPlace", d.birthPlace)
    if (asked("docType") && d.docType) {
      put("docType", d.docType)
      put("docNumber", d.docNumber)
      if (asksDocumentCountry(profile, d.docType)) put("docCountry", d.docCountry)
    }
    if (asked("email")) put("email", d.email)
    if (asked("address")) {
      put("address", d.address)
      put("addressCity", d.addressCity)
      if (profile.address.reference) put("addressReference", d.addressReference)
    }
    if (asked("emergencyContactName")) {
      put("emergencyContactName", d.emergencyName)
      put("emergencyContactPhone", d.emergencyPhone)
      put("emergencyContactRelationship", d.emergencyRelationship)
    }
    if (asked("insuranceType") && insurance) {
      put("insuranceType", insurance.type)
      if (insurance.scheme) put("insuranceScheme", insurance.scheme)
      if (privateInsurance) {
        put("insurerName", d.insurerName)
        put("affiliationNumber", d.affiliationNumber)
      }
    }
    for (const key of censusKeys) if (censusAsked(key)) put(key, d[key])
    for (const key of Object.keys(demographics))
      if (demographics[key] === "") delete demographics[key]

    const answers: RegistrationAnswers = {
      demographics: demographics as RegistrationAnswers["demographics"],
      respondent: d.respondent,
      privacyAccepted: d.privacy,
    }
    if (forOther || (repInFill && minor && d.repName.trim())) {
      const relation = RELATIONS.find((option) => option.value === d.repRelation) ?? RELATIONS[0]
      answers.representative = {
        displayName: d.repName.trim(),
        relationship: relation.value,
        relationshipDetail: relation.detail,
        ...(d.repPhone ? { phone: d.repPhone } : {}),
        ...(minor && d.repDoc.trim() ? { docType: repDocType, docNumber: d.repDoc.trim() } : {}),
      }
    }

    type Health = NonNullable<RegistrationAnswers["health"]>
    const health: Health = {}
    const listed = (state: Declared, text: string) =>
      state === "recorded"
        ? text
            .split(/[,;\n]/)
            .map((value) => value.trim())
            .filter(Boolean)
        : []
    const stateOf = (state: Declared) => state || "unanswered"
    if (asked("allergies"))
      health.allergies = {
        state: stateOf(d.allergies),
        items: listed(d.allergies, d.allergiesText).map((substance) => ({
          substance,
          severity: "desconocida",
        })),
      }
    if (asked("conditions"))
      health.conditions = {
        state: stateOf(d.conditions),
        items: listed(d.conditions, d.conditionsText).map((value) => ({ name: value })),
      }
    if (asked("medications"))
      health.medications = {
        state: stateOf(d.medications),
        items: listed(d.medications, d.medicationsText).map((value) => ({ name: value })),
      }
    if (asked("bloodGroup") && d.bloodGroup)
      health.bloodGroup = d.bloodGroup as NonNullable<Health["bloodGroup"]>

    // Lo de la entrevista de salud, con las mismas claves de la ficha.
    const personal: NonNullable<Health["personal"]> = {}
    if (pregnancyAsked && (d.pregnant === "si" || d.pregnant === "no")) {
      personal.embarazo = d.pregnant === "si"
      const weeks = Number(d.pregnancyWeeks)
      if (
        d.pregnant === "si" &&
        d.pregnancyWeeks.trim() &&
        Number.isInteger(weeks) &&
        weeks >= 0 &&
        weeks <= 42
      )
        personal.semanasEmbarazo = weeks
    }
    const yesNoText = (answer: YesNo, text: string) =>
      answer === "si" ? text.trim() || "Sí" : answer === "no" ? "No" : undefined
    const surgeries = asked("personal.cirugias")
      ? yesNoText(d.surgeries, d.surgeriesText)
      : undefined
    if (surgeries) personal.cirugias = surgeries
    const hospitalized = asked("personal.hospitalizaciones")
      ? yesNoText(d.hospitalized, d.hospitalizedText)
      : undefined
    if (hospitalized) personal.hospitalizaciones = hospitalized
    const transfusion = asked("personal.transfusiones")
      ? yesNoText(d.transfusion, d.transfusionText)
      : undefined
    if (transfusion) personal.transfusiones = transfusion
    if (Object.keys(personal).length) health.personal = personal

    type Dental = NonNullable<Health["dental"]>
    const dental: Dental = {}
    if (asked("dental.ultimaVisita") && d.dentalLast.trim())
      dental.ultimaVisita = d.dentalLast.trim()
    if (asked("dental.experienciaPrevia") && d.dentalExperience)
      dental.experienciaPrevia = d.dentalExperience as Dental["experienciaPrevia"]
    if (asked("dental.ansiedadDental") && d.dentalAnxiety)
      dental.ansiedadDental = d.dentalAnxiety as Dental["ansiedadDental"]
    if (asked("dental.cepilladosAlDia") && d.brushing) dental.cepilladosAlDia = Number(d.brushing)
    if (asked("dental.hiloDental") && d.floss) dental.hiloDental = d.floss === "si"
    if (asked("dental.bruxismo") && (d.bruxism === "si" || d.bruxism === "no"))
      dental.bruxismo = d.bruxism === "si"
    if (asked("dental.habitos") && d.habits.length) dental.habitos = d.habits
    if (Object.keys(dental).length) health.dental = dental
    if (Object.keys(health).length) answers.health = health
    if (config.askMessages && d.privacy && d.messages) answers.acceptsMessages = d.messages === "si"
    return answers
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // Solo se envía desde «Antes de enviar», con su botón: nunca con un Enter en otra pantalla.
    if (sending || item !== "send") return
    const answers = buildAnswers()
    // En «Su enlace» no se registra a nadie: las reglas de la ficha las aplica el servidor al guardar.
    const errors = fill
      ? {}
      : validateRegistrationAnswers(config, answers, {
          mode: "public",
          today,
          countryCode,
        })
    const found = Object.entries(errors)[0]
    if (found) {
      const [key, message] = found
      const where = WHERE.find(([prefix]) => key.startsWith(prefix))
      const target = where?.[1] ?? "send"
      setItem(target)
      setProblem({ item: target, ...(where?.[2] ? { field: where[2] } : {}), message })
      return
    }
    setSending(true)
    setProblem(null)
    try {
      await onSubmit(answers)
    } catch (error) {
      setProblem({
        item: "send",
        message:
          error instanceof Error
            ? error.message
            : "No pudimos enviar el registro. Inténtalo de nuevo.",
      })
    } finally {
      setSending(false)
    }
  }

  const phoneFound = (
    field: string,
    value: string,
    digits: number,
    needed: boolean,
    empty: string,
  ): Found =>
    digits > 0 && !value
      ? { field, message: PHONE_PROBLEM }
      : needed && !value
        ? { field, message: empty }
        : null
  const needs = (condition: boolean, field: string, message: string): Found =>
    condition ? { field, message } : null

  return (
    <ProblemContext.Provider value={{ problem, setProblem }}>
      <Questionnaire
        item={item}
        onItemChange={(next) => {
          setItem(next)
          setProblem(null)
        }}
        onSubmit={handleSubmit}
        shortcuts={shortcuts ? "letters" : undefined}
        // Las letras de atajo son del teclado: en el celular sobran.
        className="gap-8 max-sm:[&_[data-slot=questionnaire-choice-shortcut]]:hidden!"
      >
        <QuestionnaireProgress
          render={(props, state) => (
            <div {...props} className="flex w-full flex-col gap-2">
              <span className="text-xs font-medium text-muted-foreground tabular-nums">
                Paso {state.current} de {state.total}
              </span>
              <span
                className="block h-1.5 w-full overflow-hidden rounded-full bg-muted"
                aria-hidden
              >
                <span
                  className="block h-full rounded-full bg-primary transition-[width] duration-300 motion-reduce:transition-none"
                  style={{
                    width: `${Math.round((state.current / Math.max(state.total, 1)) * 100)}%`,
                  }}
                />
              </span>
            </div>
          )}
        />

        <Question
          name="respondent"
          required
          disabled={ownRecord || !!fill}
          title="¿Para quién es el registro?"
        >
          <QuestionnaireChoices>
            <QuestionnaireChoice
              value="patient"
              checked={draft.respondent === "patient"}
              onChange={() => set({ respondent: "patient" })}
            >
              Para mí
            </QuestionnaireChoice>
            <QuestionnaireChoice
              value="representative"
              checked={draft.respondent === "representative"}
              onChange={() => set({ respondent: "representative" })}
            >
              Para otra persona
              <QuestionnaireChoiceDescription>
                Un hijo, un familiar o alguien a tu cargo
              </QuestionnaireChoiceDescription>
            </QuestionnaireChoice>
          </QuestionnaireChoices>
        </Question>

        <Question
          name="person"
          grouped
          required
          disabled={!!fill && !PERSON_KEYS.some(wants)}
          title={you("Tus datos", "Datos de quien se atenderá")}
          description={
            fill
              ? "Lo que ya tenemos no se muestra."
              : you("Como figuran en tu documento.", "Como figuran en su documento.")
          }
          check={() =>
            needs(wants("givenNames") && !draft.givenNames.trim(), "givenNames", "Escribe los nombres.") ??
            needs(wants("familyName") && !draft.surnames.trim(), "surnames", "Escribe los apellidos.") ??
            needs(wants("birthDate") && !draft.birthDate, "birthDate", "Escribe la fecha de nacimiento.") ??
            needs(
              wants("birthDate") && !isRealDate(draft.birthDate),
              "birthDate",
              "Revisa la fecha: escribe día, mes y año.",
            ) ??
            needs(
              !fill && !forOther && minor,
              "birthDate",
              "Eres menor de edad: te registra tu madre, padre o tutor.",
            ) ??
            needs(asked("sex") && required("sex") && !draft.sex, "sex", "Elige una opción.") ??
            needs(
              required("nationality") && !draft.nationality,
              "nationality",
              "Elige la nacionalidad.",
            ) ??
            needs(
              required("birthPlace") && !draft.birthPlace.trim(),
              "birthPlace",
              "Escribe dónde nació.",
            )
          }
        >
          {wants("givenNames") ? (
          <Labeled name="givenNames" label="Nombres" htmlFor={id("given")}>
            <Input
              id={id("given")}
              autoComplete={forOther ? "off" : "given-name"}
              maxLength={100}
              value={draft.givenNames}
              aria-invalid={flag("givenNames")}
              onChange={(event) => set({ givenNames: event.target.value })}
            />
          </Labeled>
          ) : null}
          {wants("familyName") ? (
          <Labeled
            name="surnames"
            label="Apellidos"
            hint={you("Los dos, si tienes dos.", "Los dos, si tiene dos.")}
            htmlFor={id("surnames")}
          >
            <Input
              id={id("surnames")}
              autoComplete={forOther ? "off" : "family-name"}
              maxLength={200}
              value={draft.surnames}
              aria-invalid={flag("surnames")}
              onChange={(event) => set({ surnames: event.target.value })}
            />
          </Labeled>
          ) : null}
          {wants("birthDate") ? (
          <Labeled name="birthDate" label="Fecha de nacimiento" htmlFor={id("birth")}>
            <BirthDateInput
              id={id("birth")}
              value={draft.birthDate}
              onChange={(value) => set({ birthDate: value })}
              today={today}
              country={countryCode}
              invalid={flag("birthDate")}
            />
          </Labeled>
          ) : null}
          {!fill && !forOther && !ownRecord && minor ? (
            <div className="flex flex-col items-start gap-2 rounded-2xl bg-muted/60 p-4 text-sm">
              <p>Eres menor de edad: tu registro lo hace tu madre, padre o tutor.</p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => set({ respondent: "representative" })}
              >
                Lo registra mi madre, padre o tutor
              </Button>
            </div>
          ) : null}
          {asked("sex") ? (
            <Labeled name="sex" label="Sexo" optional={!required("sex")}>
              <ChoiceButtons
                label="Sexo"
                value={draft.sex || null}
                // «Desconocido» es para quien registra a otro sin saberlo; quien responde aquí lo sabe o lo deja en blanco.
                options={SEX_CODES.filter((code) => code !== "D").map((code) => ({
                  value: code,
                  label: SEX_LABELS[code],
                }))}
                onChange={(value) => set({ sex: value })}
                columns={3}
              />
            </Labeled>
          ) : null}
          {asked("nationality") ? (
            <Labeled name="nationality" label="Nacionalidad" optional={!required("nationality")}>
              <SearchSelect
                id={id("nationality")}
                label="Nacionalidad"
                placeholder="Buscar país…"
                value={draft.nationality}
                options={countries}
                invalid={flag("nationality")}
                onChange={(value) => set({ nationality: value })}
              />
            </Labeled>
          ) : null}
          {asked("birthPlace") ? (
            <Labeled
              name="birthPlace"
              label="Lugar de nacimiento"
              optional={!required("birthPlace")}
              htmlFor={id("birthPlace")}
            >
              <Input
                id={id("birthPlace")}
                placeholder="Ciudad y país"
                maxLength={200}
                value={draft.birthPlace}
                aria-invalid={flag("birthPlace")}
                onChange={(event) => set({ birthPlace: event.target.value })}
              />
            </Labeled>
          ) : null}
        </Question>

        <Question
          name="rep"
          grouped
          required
          disabled={fill ? !(repInFill && minor) : !forOther}
          title={fill ? "Tu madre, padre o tutor" : "Ahora tus datos"}
          description={
            fill
              ? "Eres menor de edad: déjanos los datos de quien responde por ti. La clínica lo registra con su documento cuando vengan."
              : `Quedas como quien habla por ${name} con la clínica.`
          }
          check={() =>
            needs(!draft.repName.trim(), "repName", "Escribe tu nombre y apellidos.") ??
            needs(!draft.repRelation, "repRelation", `Elige qué eres de ${name}.`) ??
            needs(
              minor && draft.repRelation !== "guardian",
              "repRelation",
              `${first || "La persona"} es menor de edad: lo registra su madre, padre o tutor.`,
            ) ??
            phoneFound(
              "repPhone",
              draft.repPhone,
              draft.repPhoneDigits,
              true,
              "Escribe tu celular.",
            ) ??
            needs(minor && !draft.repDoc.trim(), "repDoc", "Escribe tu número de documento.")
          }
        >
          <Labeled name="repName" label="Tu nombre y apellidos" htmlFor={id("repName")}>
            <Input
              id={id("repName")}
              autoComplete="name"
              maxLength={200}
              value={draft.repName}
              aria-invalid={flag("repName")}
              onChange={(event) => set({ repName: event.target.value })}
            />
          </Labeled>
          <Labeled name="repRelation" label={`¿Qué eres de ${name}?`}>
            <ChoiceButtons
              label={`Qué eres de ${name}`}
              value={draft.repRelation || null}
              options={RELATIONS}
              onChange={(value) => set({ repRelation: value })}
              columns={3}
            />
          </Labeled>
          <Labeled
            name="repPhone"
            label="Tu celular"
            hint={`Te avisaremos por WhatsApp sobre las citas de ${name}.`}
            htmlFor={id("repPhone")}
          >
            <PhoneInput
              id={id("repPhone")}
              value={draft.repPhone || null}
              onChange={(value, meta) =>
                set({ repPhone: value ?? "", repPhoneDigits: meta.digits.length })
              }
              defaultCountry={phoneCountry}
              invalid={flag("repPhone")}
            />
          </Labeled>
          {minor ? (
            <Labeled
              name="repDoc"
              label={`Tu ${DOC_TYPE_LABELS[repDocType]}`}
              hint={`${first || "La persona"} es menor de edad: quedas como su representante.`}
              htmlFor={id("repDoc")}
            >
              <Input
                id={id("repDoc")}
                inputMode="numeric"
                autoComplete="off"
                maxLength={20}
                value={draft.repDoc}
                aria-invalid={flag("repDoc")}
                onChange={(event) => set({ repDoc: event.target.value })}
              />
            </Labeled>
          ) : null}
        </Question>

        <Question
          name="document"
          grouped
          required={required("docType")}
          disabled={!asked("docType")}
          title={you("Tu documento", `El documento de ${name}`)}
          onSkip={() => set({ docType: null, docNumber: "", docCountry: "" })}
          check={() =>
            needs(
              required("docType") && !draft.docType,
              "docType",
              "Elige el tipo de documento.",
            ) ??
            needs(
              (required("docNumber") || Boolean(draft.docType)) && !draft.docNumber.trim(),
              "docNumber",
              "Escribe el número.",
            ) ??
            needs(
              Boolean(draft.docType) &&
                asksDocumentCountry(profile, draft.docType) &&
                !draft.docCountry,
              "docCountry",
              "Elige el país que lo emitió.",
            )
          }
        >
          <Labeled name="docType" label="Tipo de documento" optional={!required("docType")}>
            <DocTypeChoice
              label="Tipo de documento"
              value={draft.docType}
              options={docTypes}
              onChange={(value) => set({ docType: value, docCountry: "" })}
            />
          </Labeled>
          {draft.docType ? (
            <Labeled
              name="docNumber"
              label={`Número de ${DOC_TYPE_LABELS[draft.docType]}`}
              htmlFor={id("docNumber")}
            >
              <Input
                id={id("docNumber")}
                autoComplete="off"
                maxLength={20}
                value={draft.docNumber}
                aria-invalid={flag("docNumber")}
                onChange={(event) => set({ docNumber: event.target.value })}
              />
            </Labeled>
          ) : null}
          {draft.docType && asksDocumentCountry(profile, draft.docType) ? (
            <Labeled name="docCountry" label="País que lo emitió">
              <SearchSelect
                id={id("docCountry")}
                label="País que emitió el documento"
                placeholder="Buscar país…"
                value={draft.docCountry}
                options={countries}
                invalid={flag("docCountry")}
                onChange={(value) => set({ docCountry: value })}
              />
            </Labeled>
          ) : null}
        </Question>

        <Question
          name="contact"
          grouped
          // Para uno mismo hace falta el celular o el correo: no se salta.
          required={fill ? wants("phone") || wants("email") || wants("address") : !forOther || required("email") || required("address")}
          disabled={!!fill && !wants("phone") && !wants("email") && !wants("address")}
          title={you("¿Cómo te contactamos?", `¿Cómo contactamos a ${name}?`)}
          onSkip={() =>
            set({
              phone: "",
              phoneDigits: 0,
              email: "",
              address: "",
              addressCity: "",
              addressReference: "",
            })
          }
          check={() =>
            phoneFound(
              "phone",
              draft.phone,
              draft.phoneDigits,
              phoneRequired,
              "Escribe tu celular.",
            ) ??
            needs(
              !forOther && wants("phone") && !draft.phone && asked("email") && !draft.email.trim(),
              "phone",
              "Escribe tu celular o tu correo: uno de los dos.",
            ) ??
            needs(
              Boolean(draft.email.trim()) && !EMAIL.test(draft.email.trim()),
              "email",
              "Escribe el correo completo, como nombre@correo.com.",
            ) ??
            needs(
              required("email") && !forOther && !draft.email.trim(),
              "email",
              "Escribe tu correo.",
            ) ??
            needs(
              required("address") && !draft.address.trim(),
              "address",
              "Escribe la dirección.",
            ) ??
            needs(
              required("address") && !draft.addressCity.trim(),
              "addressCity",
              `Escribe el ${profile.address.cityLabel.toLowerCase()}.`,
            )
          }
        >
          {wants("phone") ? (
          <Labeled
            name="phone"
            label={you("Tu celular", "Su celular")}
            optional={!phoneRequired}
            hint={
              forOther
                ? "Si no tiene, sus avisos te llegan a ti."
                : "Te avisaremos por WhatsApp sobre tus citas."
            }
            htmlFor={id("phone")}
          >
            <PhoneInput
              id={id("phone")}
              value={draft.phone || null}
              onChange={(value, meta) =>
                set({ phone: value ?? "", phoneDigits: meta.digits.length })
              }
              defaultCountry={phoneCountry}
              autoComplete={forOther ? "off" : "tel"}
              invalid={flag("phone")}
            />
          </Labeled>
          ) : null}
          {asked("email") ? (
            <Labeled
              name="email"
              label={you("Tu correo", "Su correo")}
              optional={!required("email") || forOther}
              hint="Para enviarte comprobantes y recetas."
              htmlFor={id("email")}
            >
              <Input
                id={id("email")}
                type="email"
                placeholder="nombre@correo.com"
                autoComplete={forOther ? "off" : "email"}
                maxLength={200}
                value={draft.email}
                aria-invalid={flag("email")}
                onChange={(event) => set({ email: event.target.value })}
              />
            </Labeled>
          ) : null}
          {asked("address") ? (
            <>
              <Labeled
                name="address"
                label="Dirección"
                optional={!required("address")}
                htmlFor={id("address")}
              >
                <Input
                  id={id("address")}
                  placeholder="Calle y número"
                  autoComplete={forOther ? "off" : "street-address"}
                  maxLength={500}
                  value={draft.address}
                  aria-invalid={flag("address")}
                  onChange={(event) => set({ address: event.target.value })}
                />
              </Labeled>
              <Labeled
                name="addressCity"
                label={profile.address.cityLabel}
                optional={!required("address")}
                htmlFor={id("addressCity")}
              >
                <Input
                  id={id("addressCity")}
                  autoComplete={forOther ? "off" : "address-level2"}
                  maxLength={100}
                  value={draft.addressCity}
                  aria-invalid={flag("addressCity")}
                  onChange={(event) => set({ addressCity: event.target.value })}
                />
              </Labeled>
              {profile.address.reference ? (
                <Labeled
                  name="addressReference"
                  label="Referencia"
                  optional
                  htmlFor={id("addressReference")}
                >
                  <Input
                    id={id("addressReference")}
                    placeholder="Por ejemplo, frente al parque"
                    autoComplete="off"
                    maxLength={300}
                    value={draft.addressReference}
                    onChange={(event) => set({ addressReference: event.target.value })}
                  />
                </Labeled>
              ) : null}
            </>
          ) : null}
        </Question>

        <Question
          name="emergency"
          grouped
          required={required("emergencyContactName")}
          disabled={!asked("emergencyContactName")}
          title="¿A quién llamamos en una emergencia?"
          onSkip={() =>
            set({
              emergencyName: "",
              emergencyPhone: "",
              emergencyPhoneDigits: 0,
              emergencyRelationship: "",
            })
          }
          check={() => {
            const needed = required("emergencyContactName") || Boolean(draft.emergencyName.trim())
            return (
              needs(needed && !draft.emergencyName.trim(), "emergencyName", "Escribe su nombre.") ??
              phoneFound(
                "emergencyPhone",
                draft.emergencyPhone,
                draft.emergencyPhoneDigits,
                needed,
                "Escribe su teléfono.",
              )
            )
          }}
        >
          <Labeled name="emergencyName" label="Nombre" htmlFor={id("emergencyName")}>
            <Input
              id={id("emergencyName")}
              autoComplete="off"
              maxLength={200}
              value={draft.emergencyName}
              aria-invalid={flag("emergencyName")}
              onChange={(event) => set({ emergencyName: event.target.value })}
            />
          </Labeled>
          <Labeled name="emergencyPhone" label="Teléfono" htmlFor={id("emergencyPhone")}>
            <PhoneInput
              id={id("emergencyPhone")}
              value={draft.emergencyPhone || null}
              onChange={(value, meta) =>
                set({ emergencyPhone: value ?? "", emergencyPhoneDigits: meta.digits.length })
              }
              defaultCountry={phoneCountry}
              autoComplete="off"
              invalid={flag("emergencyPhone")}
            />
          </Labeled>
          <Labeled
            name="emergencyRelationship"
            label={you("¿Qué es tuyo?", `¿Qué es de ${name}?`)}
            optional
          >
            <Pick
              label="Parentesco del contacto de emergencia"
              value={draft.emergencyRelationship}
              options={KINSHIP.map((code) => ({ value: code, label: KINSHIP_LABELS[code] }))}
              onChange={(value) => set({ emergencyRelationship: value })}
            />
          </Labeled>
        </Question>

        <Question
          name="insurance"
          grouped
          required={required("insuranceType")}
          disabled={!asked("insuranceType")}
          title={you(
            "¿Tienes seguro de salud?",
            `¿${first || "La persona"} tiene seguro de salud?`,
          )}
          onSkip={() => set({ insurance: "", insurerName: "", affiliationNumber: "" })}
          check={() =>
            needs(required("insuranceType") && !insurance, "insurance", "Elige una opción.")
          }
        >
          <Labeled name="insurance" label="¿Cuál?" optional={!required("insuranceType")}>
            <ChoiceButtons
              label="Seguro de salud"
              value={draft.insurance || null}
              options={insuranceOptions}
              onChange={(value) => set({ insurance: value })}
              columns={2}
            />
          </Labeled>
          {privateInsurance ? (
            <>
              <Labeled name="insurerName" label="Aseguradora" optional htmlFor={id("insurer")}>
                <Input
                  id={id("insurer")}
                  autoComplete="off"
                  maxLength={200}
                  value={draft.insurerName}
                  onChange={(event) => set({ insurerName: event.target.value })}
                />
              </Labeled>
              <Labeled
                name="affiliationNumber"
                label="Número de afiliación o póliza"
                optional
                htmlFor={id("affiliation")}
              >
                <Input
                  id={id("affiliation")}
                  autoComplete="off"
                  maxLength={50}
                  value={draft.affiliationNumber}
                  onChange={(event) => set({ affiliationNumber: event.target.value })}
                />
              </Labeled>
            </>
          ) : null}
        </Question>

        <Question
          name="health"
          grouped
          required={(["allergies", "conditions", "medications", "bloodGroup"] as const).some(
            required,
          )}
          disabled={!healthAsked}
          title={you("Tu salud", `La salud de ${name}`)}
          description="Así quien te atiende lo sabe antes de empezar."
          onSkip={() =>
            set({
              allergies: "",
              allergiesText: "",
              conditions: "",
              conditionsText: "",
              medications: "",
              medicationsText: "",
              bloodGroup: "",
            })
          }
          check={() =>
            declaredFound(
              "allergies",
              asked("allergies") && required("allergies"),
              draft.allergies,
              draft.allergiesText,
            ) ??
            declaredFound(
              "conditions",
              asked("conditions") && required("conditions"),
              draft.conditions,
              draft.conditionsText,
            ) ??
            declaredFound(
              "medications",
              asked("medications") && required("medications"),
              draft.medications,
              draft.medicationsText,
            ) ??
            needs(
              asked("bloodGroup") && required("bloodGroup") && !draft.bloodGroup,
              "bloodGroup",
              "Elige una opción.",
            )
          }
        >
          {asked("allergies") ? (
            <DeclaredField
              name="allergies"
              optional={!required("allergies")}
              label={you(
                "¿Eres alérgico a algún medicamento o material?",
                `¿${first || "La persona"} es alérgico a algún medicamento o material?`,
              )}
              hint="Por ejemplo, penicilina, anestesia o látex."
              detailLabel="¿A qué? Si son varias cosas, sepáralas con comas."
              state={draft.allergies}
              text={draft.allergiesText}
              onState={(value) => set({ allergies: value })}
              onText={(value) => set({ allergiesText: value })}
            />
          ) : null}
          {asked("conditions") ? (
            <DeclaredField
              name="conditions"
              optional={!required("conditions")}
              label={you(
                "¿Tienes alguna enfermedad?",
                `¿${first || "La persona"} tiene alguna enfermedad?`,
              )}
              hint="Por ejemplo, diabetes, presión alta o del corazón."
              detailLabel="¿Cuál? Si son varias, sepáralas con comas."
              state={draft.conditions}
              text={draft.conditionsText}
              onState={(value) => set({ conditions: value })}
              onText={(value) => set({ conditionsText: value })}
            />
          ) : null}
          {asked("medications") ? (
            <DeclaredField
              name="medications"
              optional={!required("medications")}
              label={you(
                "¿Tomas algún medicamento todos los días?",
                `¿${first || "La persona"} toma algún medicamento todos los días?`,
              )}
              detailLabel="¿Cuál? Si son varios, sepáralos con comas."
              state={draft.medications}
              text={draft.medicationsText}
              onState={(value) => set({ medications: value })}
              onText={(value) => set({ medicationsText: value })}
            />
          ) : null}
          {asked("bloodGroup") ? (
            <Labeled name="bloodGroup" label="Grupo sanguíneo" optional={!required("bloodGroup")}>
              <Pick
                label="Grupo sanguíneo"
                value={draft.bloodGroup}
                options={Object.entries(BLOOD_GROUP_LABELS).map(([value, label]) => ({
                  value,
                  label,
                }))}
                onChange={(value) => set({ bloodGroup: value })}
              />
            </Labeled>
          ) : null}
        </Question>

        <Question
          name="history"
          grouped
          disabled={!historyAsked}
          title={you("Algo más sobre tu salud", `Algo más sobre la salud de ${name}`)}
          onSkip={() =>
            set({
              pregnant: "",
              pregnancyWeeks: "",
              surgeries: "",
              surgeriesText: "",
              hospitalized: "",
              hospitalizedText: "",
              transfusion: "",
              transfusionText: "",
            })
          }
        >
          {pregnancyAsked ? (
            <Labeled
              name="pregnant"
              label={you("¿Estás embarazada?", `¿${first || "La persona"} está embarazada?`)}
              optional
            >
              <ChoiceButtons
                label="Embarazo"
                value={draft.pregnant || null}
                options={YES_NO_UNKNOWN}
                onChange={(value) => set({ pregnant: value })}
                columns={3}
              />
              {draft.pregnant === "si" ? (
                <div className="flex items-center gap-3">
                  <Input
                    aria-label="Semanas de embarazo"
                    className="w-24"
                    inputMode="numeric"
                    maxLength={2}
                    value={draft.pregnancyWeeks}
                    onChange={(event) =>
                      set({ pregnancyWeeks: event.target.value.replace(/\D/g, "") })
                    }
                  />
                  <span className="text-sm text-muted-foreground">semanas (si lo sabes)</span>
                </div>
              ) : null}
            </Labeled>
          ) : null}
          {asked("personal.cirugias") ? (
            <YesNoField
              label={you("¿Te han operado alguna vez?", `¿A ${name} lo han operado alguna vez?`)}
              detail="¿De qué y cuándo?"
              answer={draft.surgeries}
              text={draft.surgeriesText}
              onAnswer={(value) => set({ surgeries: value })}
              onText={(value) => set({ surgeriesText: value })}
            />
          ) : null}
          {asked("personal.hospitalizaciones") ? (
            <YesNoField
              label={you(
                "¿Has estado internado en un hospital?",
                `¿${first || "La persona"} ha estado internada en un hospital?`,
              )}
              detail="¿Por qué y cuándo?"
              answer={draft.hospitalized}
              text={draft.hospitalizedText}
              onAnswer={(value) => set({ hospitalized: value })}
              onText={(value) => set({ hospitalizedText: value })}
            />
          ) : null}
          {asked("personal.transfusiones") ? (
            <YesNoField
              label={you(
                "¿Te han hecho una transfusión de sangre?",
                `¿A ${name} le han hecho una transfusión de sangre?`,
              )}
              detail="¿Cuándo?"
              answer={draft.transfusion}
              text={draft.transfusionText}
              onAnswer={(value) => set({ transfusion: value })}
              onText={(value) => set({ transfusionText: value })}
            />
          ) : null}
        </Question>

        <Question
          name="dental"
          grouped
          disabled={!dentalKeys.some(asked)}
          title={you("Tu boca", `La boca de ${name}`)}
          description="Nos ayuda a preparar la primera visita."
          onSkip={() =>
            set({
              dentalLast: "",
              dentalExperience: "",
              dentalAnxiety: "",
              brushing: "",
              floss: "",
              bruxism: "",
              habits: [],
            })
          }
        >
          {asked("dental.ultimaVisita") ? (
            <Labeled
              name="dentalLast"
              label="¿Cuándo fue la última visita al dentista?"
              optional
              htmlFor={id("dentalLast")}
            >
              <Input
                id={id("dentalLast")}
                placeholder="Por ejemplo, hace un año"
                autoComplete="off"
                maxLength={200}
                value={draft.dentalLast}
                onChange={(event) => set({ dentalLast: event.target.value })}
              />
            </Labeled>
          ) : null}
          {asked("dental.experienciaPrevia") ? (
            <Labeled name="dentalExperience" label="¿Cómo le fue esa vez?" optional>
              <ChoiceButtons
                label="Cómo le fue la última vez"
                value={draft.dentalExperience || null}
                options={EXPERIENCES}
                onChange={(value) => set({ dentalExperience: value })}
                columns={3}
              />
            </Labeled>
          ) : null}
          {asked("dental.ansiedadDental") ? (
            <Labeled
              name="dentalAnxiety"
              label={you("¿Te da miedo ir al dentista?", `¿A ${name} le da miedo ir al dentista?`)}
              optional
            >
              <ChoiceButtons
                label="Miedo al dentista"
                value={draft.dentalAnxiety || null}
                options={ANXIETY}
                onChange={(value) => set({ dentalAnxiety: value })}
                columns={4}
              />
            </Labeled>
          ) : null}
          {asked("dental.cepilladosAlDia") ? (
            <Labeled name="brushing" label="¿Cuántas veces al día se cepilla los dientes?" optional>
              <ChoiceButtons
                label="Veces que se cepilla al día"
                value={draft.brushing || null}
                options={BRUSHING}
                onChange={(value) => set({ brushing: value })}
                columns={4}
              />
            </Labeled>
          ) : null}
          {asked("dental.hiloDental") ? (
            <Labeled name="floss" label="¿Usa hilo dental?" optional>
              <ChoiceButtons
                label="Hilo dental"
                value={draft.floss || null}
                options={YES_NO}
                onChange={(value) => set({ floss: value })}
                columns={2}
              />
            </Labeled>
          ) : null}
          {asked("dental.bruxismo") ? (
            <Labeled
              name="bruxism"
              label="¿Aprieta o rechina los dientes, por ejemplo al dormir?"
              optional
            >
              <ChoiceButtons
                label="Aprieta o rechina los dientes"
                value={draft.bruxism || null}
                options={YES_NO_UNKNOWN}
                onChange={(value) => set({ bruxism: value })}
                columns={3}
              />
            </Labeled>
          ) : null}
          {asked("dental.habitos") ? (
            <Labeled
              name="habits"
              label="¿Tiene alguno de estos hábitos?"
              hint="Marca todos los que correspondan."
              optional
            >
              <MultiChoiceButtons
                label="Hábitos"
                value={draft.habits}
                options={HABITS}
                onChange={(value) => set({ habits: value })}
                columns={2}
              />
            </Labeled>
          ) : null}
        </Question>

        <Question
          name="census"
          grouped
          disabled={!censusKeys.some(censusAsked)}
          title={you("Para conocerte mejor", `Para conocer mejor a ${name}`)}
          onSkip={() =>
            set({
              maritalStatus: "",
              educationLevel: "",
              occupation: "",
              origin: "",
              referralSource: "",
            })
          }
        >
          {censusAsked("maritalStatus") ? (
            <Labeled name="maritalStatus" label="Estado civil" optional>
              <Pick
                label="Estado civil"
                value={draft.maritalStatus}
                options={profile.maritalStatuses.map((status) => ({
                  value: status,
                  label: MARITAL_STATUS_LABELS[status],
                }))}
                onChange={(value) => set({ maritalStatus: value })}
              />
            </Labeled>
          ) : null}
          {asked("educationLevel") ? (
            <Labeled name="educationLevel" label="Hasta qué nivel estudió" optional>
              <Pick
                label="Nivel educativo"
                value={draft.educationLevel}
                options={EDUCATION_LEVELS.map((level) => ({
                  value: level,
                  label: EDUCATION_LEVEL_LABELS[level],
                }))}
                onChange={(value) => set({ educationLevel: value })}
              />
            </Labeled>
          ) : null}
          {censusAsked("occupation") ? (
            <Labeled name="occupation" label="Ocupación" optional htmlFor={id("occupation")}>
              <Input
                id={id("occupation")}
                autoComplete="off"
                maxLength={200}
                value={draft.occupation}
                onChange={(event) => set({ occupation: event.target.value })}
              />
            </Labeled>
          ) : null}
          {asked("origin") ? (
            <Labeled
              name="origin"
              label="Procedencia"
              hint="La ciudad o región de donde viene."
              optional
              htmlFor={id("origin")}
            >
              <Input
                id={id("origin")}
                autoComplete="off"
                maxLength={200}
                value={draft.origin}
                onChange={(event) => set({ origin: event.target.value })}
              />
            </Labeled>
          ) : null}
          {asked("referralSource") ? (
            <Labeled
              name="referralSource"
              label="¿Cómo nos conoció?"
              optional
              htmlFor={id("referral")}
            >
              <Input
                id={id("referral")}
                placeholder="Por ejemplo, me recomendó un amigo"
                autoComplete="off"
                maxLength={200}
                value={draft.referralSource}
                onChange={(event) => set({ referralSource: event.target.value })}
              />
            </Labeled>
          ) : null}
        </Question>

        {fill ? (
          <Question
            name="send"
            grouped
            required
            title="Antes de enviar"
            description="Tus respuestas llegan a la clínica al tocar «Enviar». Lo que ya tenemos no cambia."
            submit={sending ? "Enviando…" : submitLabel}
            sending={sending}
          >
            {null}
          </Question>
        ) : (
        <Question
          name="send"
          required
          multiple
          missing="Marca la casilla para enviar tu registro."
          title="Antes de enviar"
          submit={sending ? "Enviando…" : submitLabel}
          sending={sending}
        >
          {config.privacyNotice.trim() ? (
            <QuestionnaireDescription className="max-h-48 overflow-y-auto rounded-2xl bg-muted/60 p-4 whitespace-pre-wrap">
              {config.privacyNotice}
            </QuestionnaireDescription>
          ) : null}
          <QuestionnaireChoices>
            <QuestionnaireChoice
              value="si"
              checked={draft.privacy}
              onChange={(event) => set({ privacy: event.target.checked })}
            >
              Autorizo el tratamiento de mis datos personales para el registro en la clínica.
            </QuestionnaireChoice>
          </QuestionnaireChoices>
          {config.askMessages ? (
            <Labeled
              name="messages"
              label="¿Te podemos escribir para enviarte novedades y promociones?"
              hint="Los avisos de tus citas te llegan igual. Puedes darte de baja cuando quieras."
              optional
            >
              <ChoiceButtons
                label="Novedades y promociones"
                value={draft.messages || null}
                options={[
                  { value: "si", label: "Sí, acepto" },
                  { value: "no", label: "No, gracias" },
                ]}
                onChange={(value) => set({ messages: value })}
                columns={2}
              />
            </Labeled>
          ) : null}
        </Question>
        )}
      </Questionnaire>
    </ProblemContext.Provider>
  )
}

/** Lo que falta en una declaración de salud: la respuesta o, si es «Sí», cuál. */
function declaredFound(field: string, needed: boolean, state: Declared, text: string): Found {
  if (needed && !state) return { field, message: "Elige una respuesta." }
  if (state === "recorded" && !text.trim())
    return { field, message: "Escribe cuál, o elige «No sé»." }
  return null
}

/**
 * Una pantalla del registro: un tema con su título y sus campos, y «Anterior /
 * Saltar / Siguiente». `check` dice qué falta antes de seguir, con el botón o
 * con Enter. Las pantallas de varios campos (`grouped`) llevan una respuesta
 * oculta para que el cuestionario las dé por respondidas: lo que falta lo dice
 * `check`, junto al campo.
 */
function Question({
  name,
  title,
  description,
  required = false,
  multiple = false,
  disabled = false,
  grouped = false,
  check,
  onSkip,
  submit,
  sending = false,
  missing,
  children,
}: {
  name: string
  title: string
  description?: string
  required?: boolean
  multiple?: boolean
  disabled?: boolean
  grouped?: boolean
  check?: () => Found
  onSkip?: () => void
  /** Última pantalla: el texto del botón que envía. */
  submit?: string
  sending?: boolean
  /** Qué decir si se intenta seguir sin responder. */
  missing?: string
  children: React.ReactNode
}) {
  const { problem, setProblem } = useContext(ProblemContext)
  const mine = problem?.item === name ? problem : null
  const allOptional = grouped && !required
  // Un aviso sin campo (lo rechazó el servidor) va al pie de la pantalla.
  const loose = mine && !mine.field ? mine.message : null

  function blocked(fieldset: HTMLElement): boolean {
    const found = check?.() ?? null
    if (!found) return false
    setProblem({ item: name, ...found })
    requestAnimationFrame(() => {
      fieldset
        .querySelector<HTMLElement>(
          `[data-field="${found.field}"] :is(input:not([hidden]), button, [role=combobox])`,
        )
        ?.focus()
    })
    return true
  }

  return (
    <QuestionnaireItem
      name={name}
      required={required}
      multiple={multiple}
      disabled={disabled}
      invalid={loose !== null}
      onStatusChange={(status) => {
        if (status === "skipped") onSkip?.()
      }}
      onKeyDown={(event) => {
        const target = event.target
        if (!grouped || !(target instanceof HTMLElement)) return
        const typing =
          target instanceof HTMLInputElement && !["radio", "checkbox"].includes(target.type)
        // En una pantalla de varios campos las flechas son de cada campo, no para cambiar de pantalla.
        if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !typing) {
          event.preventDefault()
          return
        }
        if (event.key !== "Enter" || event.nativeEvent.isComposing || !typing) return
        // En el buscador de país, Enter elige el país; nunca envía el formulario.
        if (target.getAttribute("role") === "combobox") {
          event.preventDefault()
          return
        }
        // Enter pasa al campo siguiente; en el último, sigue a la otra pantalla.
        event.preventDefault()
        const fields = [
          ...event.currentTarget.querySelectorAll<HTMLInputElement>(
            "input:not([hidden]):not([type=hidden]):not([type=radio]):not([type=checkbox]):not(:disabled)",
          ),
        ].filter((input) => input.tabIndex !== -1)
        const next = fields[fields.indexOf(target as HTMLInputElement) + 1]
        if (next) {
          next.focus()
          return
        }
        if (!blocked(event.currentTarget))
          event.currentTarget
            .querySelector<HTMLButtonElement>(
              "[data-slot=questionnaire-next]:not([hidden]), [data-slot=questionnaire-submit]:not([hidden])",
            )
            ?.click()
      }}
    >
      <QuestionnaireTitle className="text-xl leading-snug">{title}</QuestionnaireTitle>
      {description || allOptional ? (
        <QuestionnaireDescription>
          {[description, allOptional ? "Todo es opcional." : null].filter(Boolean).join(" ")}
        </QuestionnaireDescription>
      ) : null}
      <AllOptionalContext.Provider value={allOptional}>
        {grouped ? <div className="flex min-w-0 flex-col gap-5">{children}</div> : children}
      </AllOptionalContext.Provider>
      {grouped ? <Carry /> : null}
      {loose ? (
        <p role="alert" className="text-sm text-destructive">
          {loose}
        </p>
      ) : grouped ? null : (
        <QuestionnaireError>
          {missing ?? (required ? "Responde para seguir." : "Responde o toca «Saltar».")}
        </QuestionnaireError>
      )}
      <QuestionnaireActions>
        <QuestionnairePrevious>Anterior</QuestionnairePrevious>
        {required ? null : <QuestionnaireSkip>Saltar</QuestionnaireSkip>}
        {submit ? (
          <QuestionnaireSubmit disabled={sending}>{submit}</QuestionnaireSubmit>
        ) : (
          <QuestionnaireNext
            onClick={(event) => {
              const fieldset = event.currentTarget.closest("fieldset")
              if (fieldset && blocked(fieldset)) event.preventDefault()
            }}
          >
            Siguiente
          </QuestionnaireNext>
        )}
      </QuestionnaireActions>
    </QuestionnaireItem>
  )
}

/** Un campo con su nombre, «(opcional)» si puede quedar en blanco, su ayuda y su aviso. */
function Labeled({
  name,
  label,
  optional = false,
  hint,
  htmlFor,
  children,
}: {
  name: string
  label: string
  optional?: boolean
  hint?: string
  htmlFor?: string
  children: React.ReactNode
}) {
  const { problem } = useContext(ProblemContext)
  const allOptional = useContext(AllOptionalContext)
  const message = problem?.field === name ? problem.message : null
  return (
    <Field data-field={name} data-invalid={message ? true : undefined}>
      <FieldLabel htmlFor={htmlFor}>
        {/* Un solo bloque: en el celular «(opcional)» sigue al texto, no en otra columna. */}
        <span>
          {label}
          {optional && !allOptional ? (
            <span className="font-normal text-muted-foreground"> (opcional)</span>
          ) : null}
        </span>
      </FieldLabel>
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
      {children}
      {message ? <FieldError>{message}</FieldError> : null}
    </Field>
  )
}

/** Pocas opciones cortas, como botones; si son muchas o largas, una lista. */
function Pick({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: ReadonlyArray<{ value: string; label: string }>
  onChange: (value: string) => void
}) {
  if (options.length <= 4 && options.every((option) => option.label.length <= 20))
    return (
      <ChoiceButtons
        label={label}
        value={value || null}
        options={options}
        onChange={onChange}
        columns={options.length as 2 | 3 | 4}
      />
    )
  return (
    <Select
      value={value || null}
      items={Object.fromEntries(options.map((option) => [option.value, option.label]))}
      onValueChange={(next) => onChange(typeof next === "string" ? next : "")}
    >
      <SelectTrigger aria-label={label} className="w-full">
        <SelectValue placeholder="Elegir…" />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** «No / Sí / No sé» y, si es «Sí», cuál, en el mismo lugar. */
function DeclaredField({
  name,
  optional,
  label,
  hint,
  detailLabel,
  state,
  text,
  onState,
  onText,
}: {
  name: string
  optional: boolean
  label: string
  hint?: string
  detailLabel: string
  state: Declared
  text: string
  onState: (value: Declared) => void
  onText: (value: string) => void
}) {
  const { problem } = useContext(ProblemContext)
  return (
    <Labeled name={name} label={label} hint={hint} optional={optional}>
      <ChoiceButtons
        label={label}
        value={state || null}
        options={DECLARED}
        onChange={onState}
        columns={3}
      />
      {state === "recorded" ? (
        <Input
          aria-label={detailLabel}
          placeholder={detailLabel}
          autoComplete="off"
          maxLength={600}
          value={text}
          aria-invalid={problem?.field === name && !text.trim() ? true : undefined}
          onChange={(event) => onText(event.target.value)}
        />
      ) : null}
    </Labeled>
  )
}

/** «No / Sí» y, si es «Sí», el detalle; todo opcional. */
function YesNoField({
  label,
  detail,
  answer,
  text,
  onAnswer,
  onText,
}: {
  label: string
  detail: string
  answer: YesNo
  text: string
  onAnswer: (value: YesNo) => void
  onText: (value: string) => void
}) {
  return (
    <Labeled name={label} label={label} optional>
      <ChoiceButtons
        label={label}
        value={answer || null}
        options={YES_NO}
        onChange={onAnswer}
        columns={2}
      />
      {answer === "si" ? (
        <Input
          aria-label={detail}
          placeholder={detail}
          autoComplete="off"
          maxLength={500}
          value={text}
          onChange={(event) => onText(event.target.value)}
        />
      ) : null}
    </Labeled>
  )
}

/**
 * Una pantalla de varios campos no es una respuesta del cuestionario: esta,
 * oculta, la da por respondida. Lo que falta lo dice la propia pantalla.
 */
function Carry() {
  return <QuestionnaireInput value="ok" readOnly hidden tabIndex={-1} aria-hidden="true" />
}

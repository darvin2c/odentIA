/**
 * Composición de dominio del registro de pacientes compartida entre el alta
 * interna (drawer), el registro público y la vista previa de configuración.
 *
 * Una sola instancia de TanStack Form con render-prop: los contenedores
 * aportan el <form> (FormDrawer en interno, form propio en público/preview)
 * mediante los slots de RegistrationFormView. Sin queries, sin useCanWrite,
 * sin navegación: todo lo privado (config/today/contacto/sucursales) llega
 * por props. Sin localStorage ni PII en URL.
 */

import {
  type BloodGroup,
  type ClinicalCountryProfile,
  clinicalProfileFor,
  CONTACT_RELATIONSHIP_LABELS,
  composeDisplayName,
  type DeclarationState,
  type DOC_TYPES,
  EDUCATION_LEVEL_LABELS,
  EDUCATION_LEVELS,
  type HealthAllergyDeclaration,
  type HealthConditionDeclaration,
  type HealthMedicationDeclaration,
  isMinor,
  isRealDate,
  MARITAL_STATUS_LABELS,
  MARITAL_STATUSES,
  REFERRAL_KIND_LABELS,
  REFERRAL_KINDS,
  type RegistrationAnswers,
  type RegistrationConfig,
  type RegistrationContactInput,
  type RegistrationDemographics,
  type RegistrationFieldKey,
  type RegistrationRespondent,
  registrationFieldAsked,
  SEX_LABELS,
  validateRegistrationAnswers,
} from "@odentia/clinical"
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  buttonVariants,
  Checkbox,
  Field,
  FieldError,
} from "@odentia/ui"
import {
  BirthDateInput,
  clinicDateLocale,
  type CountryCode,
  isValidE164,
  normalizeCountry,
  PhoneInput,
  WizardSteps,
  writeDate,
  writtenDateFormat,
} from "@odentia/ui-patterns"
import { useForm } from "@tanstack/react-form"
import { useEffect, useRef, useState } from "react"
import {
  addressLine,
  asksDocumentCountry,
  countryChoices,
  documentChoices,
  documentLine,
  insuranceChoiceOf,
  insuranceChoices,
  insuranceFromChoice,
  insuranceText,
  maritalChoices,
  referralText,
} from "../../lib/person-data"
import { SearchSelect } from "../settings/search-select"
import {
  SEX_OPTIONS,
  SectionCard,
  SelectRow,
  TextRow,
} from "./patient-demographics-form"
import { RegistrationHealthFields } from "./patient-health-fields"
export type RegistrationFormMode = "internal" | "public" | "preview"
/** La persona desde cuya página se registra: quién es y si ya tiene ficha propia. */
export interface RegistrationPerson {
  id: string
  displayName: string
  selfPatient: { id: string; displayName: string } | null
}

export interface RegistrationFormContext {
  kind: "generic" | "contact" | "conversation"
  contact?: RegistrationPerson
  /**
   * Público: quien abrió su enlace ya tiene su ficha. Registra siempre a otra
   * persona y no se le ofrece registrarse a sí misma.
   */
  ownRecord?: boolean
}

export interface RegistrationFormBranch {
  id: string
  name: string
}

/** Borrador que el formulario entrega al contenedor para el envío. */
export interface RegistrationSubmitDraft {
  answers: RegistrationAnswers
  contacts?: RegistrationContactInput[]
  registeredBranchId?: string
}

export interface RegistrationFormView {
  body: React.ReactNode
  progress: React.ReactNode
  previous: React.ReactNode
  onSubmit: (event: React.FormEvent) => void
  isDirty: boolean
  isSubmitting: boolean
  submitLabel: string
  submitDisabled: boolean
  error: string | null
}

export interface PatientRegistrationFormProps {
  mode: RegistrationFormMode
  config: RegistrationConfig
  today: string
  context: RegistrationFormContext
  branches?: RegistrationFormBranch[]
  initialValues?: Partial<RegistrationAnswers>
  /** Registrar a otra persona (un hijo) desde la página de quien responde por ella. */
  defaultRecipient?: "self" | "other"
  /**
   * País de los teléfonos que se capturan: el de la organización en el alta
   * interna. En el formulario público (sin sesión) queda el de partida.
   */
  defaultCountry?: CountryCode
  /**
   * País de la clínica (ISO 3166-1 alfa-2): de él dependen los documentos,
   * seguros, regiones y la procedencia que se piden (ADR 0036). Sin él, el
   * núcleo internacional.
   */
  countryCode?: string | null
  onSubmit: (draft: RegistrationSubmitDraft) => Promise<void>
  children: (view: RegistrationFormView) => React.ReactNode
}

type StepId = "datos" | "contacto" | "salud" | "odontologicos" | "revision"

const STEP_LABELS: Record<StepId, string> = {
  datos: "Datos personales",
  contacto: "Contacto y filiación",
  salud: "Salud",
  odontologicos: "Salud dental",
  revision: "Revisión",
}

const CONTACTO_KEYS = [
  "phone",
  "email",
  "address",
  "maritalStatus",
  "educationLevel",
  "occupation",
  "origin",
  "emergencyContactName",
  "emergencyContactPhone",
  "insuranceType",
  "referralSource",
] as const
const SALUD_KEYS = ["bloodGroup", "allergies", "conditions", "medications"] as const
const DENTAL_KEYS = [
  "dental.ultimaVisita",
  "dental.experienciaPrevia",
  "dental.ansiedadDental",
] as const

type RepresentativeValue = NonNullable<RegistrationAnswers["representative"]>
type HealthValue = NonNullable<RegistrationAnswers["health"]>
type DocTypeValue = (typeof DOC_TYPES)[number] | ""
type SexValue = "M" | "F" | "I" | "D" | ""

interface RegistrationFormValues {
  answers: Omit<RegistrationAnswers, "representative" | "health"> & {
    representative: RepresentativeValue
    health: HealthValue
  }
  recipient: "self" | "other"
  registeredBranchId: string
}

/** El representante empieza con el primer documento que se usa en el país de la clínica. */
function emptyRepresentative(profile: ClinicalCountryProfile): RepresentativeValue {
  return {
    displayName: "",
    relationship: "guardian",
    relationshipDetail: "",
    docType: profile.documentTypes[0]!.code,
    docNumber: "",
  }
}

const EDUCATION_OPTIONS = [
  { value: "", label: "—" },
  ...EDUCATION_LEVELS.map((value) => ({ value, label: EDUCATION_LEVEL_LABELS[value] })),
]

/** «Cómo nos conoció»: la misma lista en todas las clínicas (decisión 3 de Reportes v2). */
const REFERRAL_OPTIONS = [{ value: "", label: "—" }, ...REFERRAL_KINDS.map((value) => ({ value, label: REFERRAL_KIND_LABELS[value] }))]

function emptyGroup<T>(): { state: DeclarationState; items: T[] } {
  return { state: "unanswered", items: [] }
}

function emptyHealth(): HealthValue {
  return {
    bloodGroup: null,
    allergies: emptyGroup<HealthAllergyDeclaration>(),
    conditions: emptyGroup<HealthConditionDeclaration>(),
    medications: emptyGroup<HealthMedicationDeclaration>(),
    dental: {},
  }
}

function withoutUndefined<T extends Record<string, unknown>>(value: T | undefined): Partial<T> {
  if (!value) return {}
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry
  }
  return out as Partial<T>
}

function buildDefaults(
  mode: RegistrationFormMode,
  initialValues: Partial<RegistrationAnswers> | undefined,
  profile: ClinicalCountryProfile,
): RegistrationFormValues {
  const initialDemographics = withoutUndefined(initialValues?.demographics)
  const initialRepresentative = withoutUndefined(initialValues?.representative)
  const initialHealth = initialValues?.health
  let respondent: RegistrationRespondent = mode === "internal" ? "staff" : "patient"
  const initialRespondent = initialValues?.respondent
  if (initialRespondent === "patient" || initialRespondent === "representative") {
    respondent = initialRespondent
  } else if (initialRespondent === "staff" && mode === "internal") {
    respondent = "staff"
  }
  return {
    answers: {
      demographics: {
        displayName: "",
        givenNames: "",
        paternalSurname: "",
        maternalSurname: "",
        birthDate: "",
        docType: "",
        docNumber: "",
        docCountry: "",
        sex: "",
        phone: "",
        email: "",
        address: "",
        addressCity: "",
        addressDistrict: "",
        addressRegion: "",
        addressPostalCode: "",
        addressCountry: "",
        addressReference: "",
        maritalStatus: "",
        educationLevel: "",
        occupation: "",
        origin: "",
        emergencyContactName: "",
        emergencyContactPhone: "",
        insuranceType: "",
        insuranceScheme: "",
        referralKind: "",
        referralSource: "",
        ...initialDemographics,
      } as RegistrationDemographics,
      respondent: respondent as RegistrationRespondent,
      representative: { ...emptyRepresentative(profile), ...initialRepresentative },
      health: {
        ...emptyHealth(),
        ...withoutUndefined({
          bloodGroup: initialHealth?.bloodGroup,
          allergies: initialHealth?.allergies,
          conditions: initialHealth?.conditions,
          medications: initialHealth?.medications,
        }),
        dental: { ...initialHealth?.dental },
      },
      privacyAccepted: initialValues?.privacyAccepted ?? false,
      acceptsReminders: initialValues?.acceptsReminders ?? false,
      acceptsMessages: initialValues?.acceptsMessages ?? false,
    },
    recipient: "self",
    registeredBranchId: "",
  }
}

const trim = (value: unknown): string => (typeof value === "string" ? value.trim() : "")

function representativeStatus(
  birthDate: string | null | undefined,
  respondent: RegistrationRespondent,
  recipient: "self" | "other",
  today: string,
  mode: RegistrationFormMode,
  hasContact: boolean,
): { minor: boolean; needed: boolean } {
  const clean = trim(birthDate)
  const minor = clean !== "" && isRealDate(clean) && isMinor(clean, today)
  const effective = mode === "internal" ? "staff" : respondent
  const needed =
    minor ||
    effective === "representative" ||
    (mode === "internal" && hasContact && recipient === "other")
  return { minor, needed }
}

function buildAnswers(
  values: RegistrationFormValues,
  options: {
    mode: RegistrationFormMode
    config: RegistrationConfig
    countryCode: string | null
    hasContact: boolean
    minor: boolean
    needsRepresentative: boolean
  },
): RegistrationAnswers {
  const { mode, config, countryCode, minor, needsRepresentative } = options
  const pub = mode === "public" || mode === "preview"
  const profile = clinicalProfileFor(countryCode)
  const demographics = values.answers.demographics
  const keptDemographics: Record<string, unknown> = {}
  // Cada dato va con el campo del registro que lo pide: la dirección completa
  // con «Dirección», el régimen con «Seguro». Lo que no se pide no viaja.
  const owner: Record<string, RegistrationFieldKey> = {
    addressCity: "address",
    addressDistrict: "address",
    addressRegion: "address",
    addressPostalCode: "address",
    addressCountry: "address",
    addressReference: "address",
    insuranceScheme: "insuranceType",
    referralKind: "referralSource",
  }
  for (const [key, raw] of Object.entries(demographics)) {
    const field = (owner[key] ?? key) as RegistrationFieldKey
    if (pub && config.fields[field] !== undefined && !registrationFieldAsked(config, field, countryCode)) continue
    if (key === "origin" && !profile.origin) continue
    if (key === "docCountry" && !asksDocumentCountry(profile, demographics.docType)) continue
    keptDemographics[key] = typeof raw === "string" ? raw.trim() : (raw ?? "")
  }
  const representative = values.answers.representative
  const health = values.answers.health
  const keptHealth: Record<string, unknown> = {}
  if (!pub || config.fields.bloodGroup !== "hidden") {
    keptHealth.bloodGroup = health.bloodGroup ?? null
  }
  for (const key of ["allergies", "conditions", "medications"] as const) {
    if (pub && config.fields[key] === "hidden") continue
    keptHealth[key] = health[key] ?? emptyGroup()
  }
  const dental: Record<string, unknown> = {}
  const sourceDental: {
    ultimaVisita?: unknown
    experienciaPrevia?: unknown
    ansiedadDental?: unknown
  } = health.dental ?? {}
  if (!pub || config.fields["dental.ultimaVisita"] !== "hidden") {
    const ultimaVisita = trim(sourceDental.ultimaVisita)
    if (ultimaVisita) dental.ultimaVisita = ultimaVisita
  }
  for (const key of ["experienciaPrevia", "ansiedadDental"] as const) {
    if (pub && config.fields[`dental.${key}` as RegistrationFieldKey] === "hidden") continue
    const entry = sourceDental[key]
    if (entry) dental[key] = entry
  }
  if (Object.keys(dental).length > 0) keptHealth.dental = dental
  return {
    demographics: keptDemographics as unknown as RegistrationDemographics,
    respondent: mode === "internal" ? "staff" : values.answers.respondent,
    representative: needsRepresentative
      ? {
          displayName: trim(representative.displayName),
          relationship: minor ? "guardian" : representative.relationship,
          relationshipDetail: trim(representative.relationshipDetail),
          ...(trim(representative.phone) ? { phone: trim(representative.phone) } : {}),
          ...(trim(representative.email) ? { email: trim(representative.email) } : {}),
          ...(trim(representative.docNumber)
            ? {
                docType: representative.docType ?? profile.documentTypes[0]!.code,
                docNumber: trim(representative.docNumber),
                ...(asksDocumentCountry(profile, representative.docType) && representative.docCountry
                  ? { docCountry: representative.docCountry }
                  : {}),
              }
            : {}),
        }
      : undefined,
    health: keptHealth as HealthValue,
    privacyAccepted: values.answers.privacyAccepted,
    // Solo viaja lo que el registro de la clínica pregunta: lo demás no se da por respondido.
    ...(config.askMessages ? { acceptsMessages: values.answers.acceptsMessages === true } : {}),
  }
}

const FIELD_ORDER: string[] = [
  "demographics.displayName",
  "demographics.paternalSurname",
  "demographics.givenNames",
  "demographics.birthDate",
  "demographics.docType",
  "demographics.docNumber",
  "demographics.docCountry",
  "demographics.sex",
  "respondent",
  ...CONTACTO_KEYS.map((key) => `demographics.${key}`),
  "representative",
  "representative.displayName",
  "representative.relationship",
  "representative.relationshipDetail",
  "representative.docNumber",
  "representative.phone",
  "representative.email",
  "health.bloodGroup",
  "health.allergies",
  "health.conditions",
  "health.medications",
  "health.dental.ultimaVisita",
  "health.dental.experienciaPrevia",
  "health.dental.ansiedadDental",
  "privacyAccepted",
]

function stepPrefixes(step: StepId): string[] {
  switch (step) {
    case "datos":
      return [
        "demographics.displayName",
        "demographics.birthDate",
        "demographics.docType",
        "demographics.docNumber",
        "demographics.sex",
        "respondent",
      ]
    case "contacto":
      return [
        "demographics.phone",
        "demographics.email",
        "demographics.address",
        "demographics.maritalStatus",
        "demographics.educationLevel",
        "demographics.occupation",
        "demographics.origin",
        "demographics.emergencyContact",
        "demographics.insurance",
        "demographics.referral",
        "representative",
      ]
    case "salud":
      return ["health.bloodGroup", "health.allergies", "health.conditions", "health.medications"]
    case "odontologicos":
      return ["health.dental"]
    case "revision":
      return ["privacyAccepted"]
  }
}

function focusFirstError(errors: Record<string, string>): void {
  const ordered = [...FIELD_ORDER, ...Object.keys(errors)]
  const first = ordered.find((key) => errors[key])
  if (!first) return
  requestAnimationFrame(() => {
    const anchor = document.querySelector(`[data-reg-field="${CSS.escape(first)}"]`)
    if (!anchor) return
    anchor.scrollIntoView({ behavior: "smooth", block: "center" })
    const target =
      anchor.querySelector<HTMLElement>("input, select, textarea, button:not([type])") ??
      (anchor as HTMLElement)
    target.focus({ preventScroll: true })
  })
}

const RESPONDENT_LABELS: Record<RegistrationRespondent, string> = {
  patient: "Paciente",
  representative: "Representante",
  staff: "Personal de la clínica",
}

const STATE_LABELS: Record<DeclarationState, string> = {
  unanswered: "Sin responder",
  unknown: "No sé",
  none: "No",
  recorded: "Sí",
}

function bloodLabel(value: BloodGroup | null | undefined): string {
  if (value === null || value === undefined) return "Sin responder"
  if (value === "unknown") return "No determinado"
  return value
}

/** Un solo formulario TanStack compartido por drawer interno, página pública y vista previa. */
export function PatientRegistrationForm({
  mode,
  config,
  today,
  context,
  branches,
  initialValues,
  defaultRecipient,
  defaultCountry: defaultCountryProp,
  countryCode = null,
  onSubmit,
  children,
}: PatientRegistrationFormProps): React.JSX.Element {
  // El teléfono parte del país de la clínica; el núcleo no supone ninguno.
  const defaultCountry = defaultCountryProp ?? normalizeCountry(countryCode)
  const profile = clinicalProfileFor(countryCode)
  const countries = countryChoices(profile.country)
  const hasContact = context.kind !== "generic" && Boolean(context.contact)
  const contact = context.contact
  const selfPatient = contact?.selfPatient ?? null

  // Ya tiene su ficha: el registro público es siempre de otra persona.
  const onlyOthers = mode === "public" && context.ownRecord === true
  const [initialForm] = useState(() => {
    const defaults = buildDefaults(mode, initialValues, profile)
    if (selfPatient || defaultRecipient === "other") defaults.recipient = "other"
    if (onlyOthers) defaults.answers.respondent = "representative"
    return defaults
  })
  const [blankForm] = useState(() => {
    const blank = buildDefaults(mode, undefined, profile)
    if (onlyOthers) blank.answers.respondent = "representative"
    return blank
  })
  const form = useForm({ defaultValues: initialForm })

  const [current, setCurrent] = useState(0)
  const [visited, setVisited] = useState<readonly number[]>([0])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const versionRef = useRef(config.version)
  const goReviewRef = useRef<() => void>(() => {})

  useEffect(() => {
    if (versionRef.current !== config.version) {
      versionRef.current = config.version
      setError(null)
      goReviewRef.current()
    }
  }, [config.version])

  const pub = mode === "public" || mode === "preview"

  function validateAll(values: RegistrationFormValues): Record<string, string> {
    const status = representativeStatus(
      values.answers.demographics.birthDate,
      values.answers.respondent,
      values.recipient,
      today,
      mode,
      hasContact,
    )
    const answers = buildAnswers(values, {
      mode,
      config,
      countryCode,
      hasContact,
      minor: status.minor,
      needsRepresentative: status.needed,
    })
    const found = validateRegistrationAnswers(config, answers, {
      mode: mode === "preview" ? "public" : mode,
      today,
      countryCode: countryCode ?? null,
    })
    // El campo emite E.164: si hay un teléfono escrito, tiene que ser un número
    // real de su país (el servidor sigue aceptando texto, esto es la pantalla).
    const patientPhone = trim(answers.demographics.phone)
    if (patientPhone && !isValidE164(patientPhone)) {
      found["demographics.phone"] = "Teléfono inválido"
    }
    const emergencyPhone = trim(answers.demographics.emergencyContactPhone)
    if (emergencyPhone && !isValidE164(emergencyPhone)) {
      found["demographics.emergencyContactPhone"] = "Teléfono inválido"
    }
    if (mode === "internal" && hasContact && values.recipient === "other" && !status.minor) {
      const representative = values.answers.representative
      if (!trim(representative.displayName)) {
        found["representative.displayName"] = "Ingresa el nombre del responsable"
      }
      if (!trim(representative.phone) && !trim(representative.email)) {
        found["representative.phone"] = "Indica teléfono o correo del responsable"
      } else if (trim(representative.phone) && !isValidE164(trim(representative.phone))) {
        found["representative.phone"] = "Teléfono inválido"
      }
    }
    return found
  }

  function clearError(key: string): void {
    setErrors((previous) => {
      if (!previous[key]) return previous
      const next = { ...previous }
      delete next[key]
      return next
    })
  }

  return (
    <form.Subscribe
      selector={(state) => ({
        isDirty: state.isDirty,
        birthDate: state.values.answers.demographics.birthDate,
        respondent: state.values.answers.respondent,
        recipient: state.values.recipient,
      })}
    >
      {(slice) => {
        const status = representativeStatus(
          slice.birthDate,
          slice.respondent,
          slice.recipient,
          today,
          mode,
          hasContact,
        )
        // «Procedencia» solo en clínicas de Perú; lo demás, como lo pide el registro.
        const visible = (key: RegistrationFieldKey): boolean =>
          mode === "internal"
            ? key !== "origin" || profile.origin
            : registrationFieldAsked(config, key, countryCode)
        const steps: StepId[] = ["datos"]
        if (mode === "internal" || status.needed || CONTACTO_KEYS.some((key) => visible(key))) {
          steps.push("contacto")
        }
        if (mode === "internal" || SALUD_KEYS.some((key) => visible(key))) steps.push("salud")
        if (mode === "internal" || DENTAL_KEYS.some((key) => visible(key))) {
          steps.push("odontologicos")
        }
        steps.push("revision")
        const safeCurrent = Math.min(current, steps.length - 1)
        const step = steps[safeCurrent]
        const last = steps.length - 1
        // «Teléfono o correo»: basta uno de los dos, así que ninguno lleva asterisco.
        const required = (key: RegistrationFieldKey): boolean =>
          mode === "internal" ? key === "displayName" : key !== "phone" && config.fields[key] === "required"
        const label = (text: string, key: RegistrationFieldKey): string =>
          required(key) ? `${text} *` : text

        function go(index: number): void {
          setCurrent(index)
          setVisited((previous) => (previous.includes(index) ? previous : [...previous, index]))
        }
        goReviewRef.current = () => go(last)

        function advance(): void {
          if (submitting) return
          const found = validateAll(form.state.values)
          const prefixes = stepPrefixes(step)
          const blocked = Object.fromEntries(
            Object.entries(found).filter(([key]) =>
              prefixes.some((prefix) => key.startsWith(prefix)),
            ),
          )
          setErrors(blocked)
          setError(null)
          if (Object.keys(blocked).length > 0) {
            focusFirstError(blocked)
            return
          }
          go(Math.min(safeCurrent + 1, last))
        }

        async function finish(): Promise<void> {
          if (submitting) return
          const values = form.state.values
          const found = validateAll(values)
          setErrors(found)
          setError(null)
          if (Object.keys(found).length > 0) {
            const firstStep = steps.findIndex((candidate) =>
              Object.keys(found).some((key) =>
                stepPrefixes(candidate).some((prefix) => key.startsWith(prefix)),
              ),
            )
            if (firstStep >= 0) go(firstStep)
            focusFirstError(found)
            return
          }
          const statusNow = representativeStatus(
            values.answers.demographics.birthDate,
            values.answers.respondent,
            values.recipient,
            today,
            mode,
            hasContact,
          )
          const answers = buildAnswers(values, {
            mode,
            config,
            countryCode,
            hasContact,
            minor: statusNow.minor,
            needsRepresentative: statusNow.needed,
          })
          let contacts: RegistrationContactInput[] | undefined
          if (mode === "internal" && contact) {
            const representative = values.answers.representative
            const detail = trim(representative.relationshipDetail)
            contacts = [
              {
                contactId: contact.id,
                relationship:
                  values.recipient === "self"
                    ? "self"
                    : statusNow.minor
                      ? "guardian"
                      : representative.relationship,
                relationshipDetail: detail ? detail : null,
                isPreferred: true,
              },
            ]
          }
          const draft: RegistrationSubmitDraft = {
            answers,
            ...(contacts ? { contacts } : {}),
            ...(mode === "internal" && values.registeredBranchId
              ? { registeredBranchId: values.registeredBranchId }
              : {}),
          }
          setSubmitting(true)
          try {
            await onSubmit(draft)
          } catch (submitError) {
            setError(
              submitError instanceof Error
                ? (submitError.message ?? "No se pudo enviar el registro")
                : "No se pudo enviar el registro",
            )
          } finally {
            setSubmitting(false)
          }
        }

        const submitLabel =
          safeCurrent < last
            ? "Siguiente"
            : mode === "public"
              ? "Enviar registro"
              : mode === "preview"
                ? "Finalizar vista previa"
                : "Registrar paciente"

        const healthErrors = Object.fromEntries(
          Object.entries(errors).filter(([key]) => key.startsWith("health.")),
        )
        const internalFields = { ...config.fields }
        if (mode === "internal") {
          internalFields.bloodGroup = "optional"
          internalFields.allergies = "optional"
          internalFields.conditions = "optional"
          internalFields.medications = "optional"
        }

        const body = (
          <div className="flex min-w-0 flex-col gap-4">
            <div hidden={step !== "datos"} className="flex min-w-0 flex-col gap-4">
              <SectionCard title="Datos personales">
                {mode === "internal" ? (
                  <p className="text-xs text-muted-foreground sm:col-span-2">
                    En el registro interno basta el nombre; la clínica completa el resto en la
                    ficha.
                  </p>
                ) : null}
                {hasContact && mode === "internal" ? (
                  <div className="sm:col-span-2" data-reg-field="recipient">
                    <form.Field name="recipient">
                      {(field) => (
                        <SelectRow
                          label="¿A quién se registra?"
                          value={field.state.value}
                          options={[
                            { value: "self", label: "Esta persona" },
                            { value: "other", label: "Otra persona" },
                          ]}
                          onChange={(next) => {
                            const toOther = next === "other"
                            field.handleChange(toOther ? "other" : "self")
                            // Lo que se sabía de esta persona es suyo: al registrar a otra
                            // (un hijo) los datos empiezan en blanco, y vuelven si se cambia de nuevo.
                            if (initialValues?.demographics && !selfPatient)
                              form.setFieldValue(
                                "answers.demographics",
                                toOther ? blankForm.answers.demographics : initialForm.answers.demographics,
                              )
                            clearError("representative")
                          }}
                        />
                      )}
                    </form.Field>
                    {selfPatient ? (
                      <Alert className="mt-2">
                        <AlertTitle>Este contacto ya tiene ficha propia</AlertTitle>
                        <AlertDescription>
                          <span className="block">
                            {selfPatient.displayName}. Para continuar con esa ficha, ábrela en lugar
                            de registrarla de nuevo.
                          </span>
                          <span className="mt-1 flex flex-wrap items-center gap-2">
                            {/* Enlace con aspecto de botón: lleva a la ficha, no es una acción. */}
                            <a
                              href={`/patients/${selfPatient.id}`}
                              className={buttonVariants({ variant: "outline", size: "sm" })}
                            >
                              Ver paciente
                            </a>
                          </span>
                        </AlertDescription>
                      </Alert>
                    ) : (
                      <p className="mt-1 text-xs text-muted-foreground">
                        «Esta persona» vincula la ficha al contacto como propio paciente; «Otra
                        persona» pide la relación y los datos del responsable.
                      </p>
                    )}
                  </div>
                ) : null}
                {pub && !onlyOthers ? (
                  <div className="sm:col-span-2" data-reg-field="respondent">
                    <form.Field name="answers.respondent">
                      {(field) => (
                        <SelectRow
                          label="¿Quién completa el registro?"
                          value={
                            field.state.value === "representative" ? "representative" : "patient"
                          }
                          error={errors.respondent}
                          options={[
                            { value: "patient", label: "Soy el paciente" },
                            { value: "representative", label: "Registro a otra persona" },
                          ]}
                          onChange={(next) => {
                            field.handleChange(
                              next === "representative" ? "representative" : "patient",
                            )
                            clearError("respondent")
                            clearError("representative")
                          }}
                        />
                      )}
                    </form.Field>
                  </div>
                ) : null}
                {visible("displayName") ? (
                  <>
                    {(
                      [
                        ["givenNames", "Nombres"],
                        ["paternalSurname", "Primer apellido"],
                        ["maternalSurname", "Segundo apellido"],
                      ] as const
                    ).map(([key, text]) => (
                      <div key={key} data-reg-field="demographics.displayName" className="min-w-0">
                        <form.Field name={`answers.demographics.${key}`}>
                          {(field) => (
                            <TextRow
                              // Hay personas con un solo apellido: el materno no es obligatorio.
                              label={key === "maternalSurname" ? text : label(text, "displayName")}
                              value={field.state.value ?? ""}
                              error={
                                key === "givenNames"
                                  ? (errors["demographics.givenNames"] ??
                                    errors["demographics.displayName"])
                                  : errors[`demographics.${key}`]
                              }
                              inputProps={{ "aria-label": text, maxLength: 100 }}
                              onChange={(next) => {
                                field.handleChange(next)
                                // El nombre visible se compone del nombre separado.
                                const parts = form.state.values.answers.demographics
                                form.setFieldValue(
                                  "answers.demographics.displayName",
                                  composeDisplayName({ ...parts, [key]: next }),
                                )
                                clearError("demographics.displayName")
                                clearError(`demographics.${key}`)
                              }}
                            />
                          )}
                        </form.Field>
                      </div>
                    ))}
                  </>
                ) : null}
                {visible("birthDate") ? (
                  <div data-reg-field="demographics.birthDate" className="min-w-0">
                    <form.Field name="answers.demographics.birthDate">
                      {(field) => (
                        <TextRow
                          label={label("Fecha de nacimiento", "birthDate")}
                          error={errors["demographics.birthDate"]}
                          renderControl={(id) => (
                            <BirthDateInput
                              id={id}
                              aria-label="Fecha de nacimiento"
                              today={today}
                              country={countryCode}
                              value={field.state.value ?? ""}
                              invalid={Boolean(errors["demographics.birthDate"])}
                              onChange={(next) => {
                                field.handleChange(next)
                                clearError("demographics.birthDate")
                                clearError("representative")
                                clearError("respondent")
                              }}
                            />
                          )}
                        />
                      )}
                    </form.Field>
                  </div>
                ) : null}
                {visible("docType") ? (
                  <div data-reg-field="demographics.docType" className="min-w-0">
                    <form.Field name="answers.demographics.docType">
                      {(field) => (
                        <SelectRow
                          label={label("Tipo de documento", "docType")}
                          value={field.state.value ?? ""}
                          error={errors["demographics.docType"]}
                          options={[{ value: "", label: "—" }, ...documentChoices(profile, field.state.value)]}
                          onChange={(next) => {
                            field.handleChange(next as DocTypeValue)
                            clearError("demographics.docType")
                            clearError("demographics.docNumber")
                          }}
                        />
                      )}
                    </form.Field>
                  </div>
                ) : null}
                {visible("docNumber") ? (
                  <div data-reg-field="demographics.docNumber" className="min-w-0">
                    <form.Field name="answers.demographics.docNumber">
                      {(field) => (
                        <TextRow
                          label={label("Número de documento", "docNumber")}
                          value={field.state.value ?? ""}
                          error={errors["demographics.docNumber"]}
                          inputProps={{ "aria-label": "Número de documento" }}
                          onChange={(next) => {
                            field.handleChange(next)
                            clearError("demographics.docNumber")
                          }}
                        />
                      )}
                    </form.Field>
                  </div>
                ) : null}
                {visible("docNumber") ? (
                  <form.Subscribe selector={(state) => state.values.answers.demographics.docType}>
                    {(docType) =>
                      asksDocumentCountry(profile, docType) ? (
                        <div data-reg-field="demographics.docCountry" className="min-w-0">
                          <form.Field name="answers.demographics.docCountry">
                            {(field) => (
                              <TextRow
                                label="País que lo emitió *"
                                error={errors["demographics.docCountry"]}
                                renderControl={(id) => (
                                  <SearchSelect
                                    id={id}
                                    label="País que lo emitió"
                                    placeholder="Buscar país…"
                                    value={field.state.value ?? ""}
                                    options={countries}
                                    invalid={Boolean(errors["demographics.docCountry"])}
                                    onChange={(next) => {
                                      field.handleChange(next)
                                      clearError("demographics.docCountry")
                                    }}
                                  />
                                )}
                              />
                            )}
                          </form.Field>
                        </div>
                      ) : null
                    }
                  </form.Subscribe>
                ) : null}
                {visible("sex") ? (
                  <div data-reg-field="demographics.sex" className="min-w-0">
                    <form.Field name="answers.demographics.sex">
                      {(field) => (
                        <SelectRow
                          label={label("Sexo", "sex")}
                          value={field.state.value ?? ""}
                          error={errors["demographics.sex"]}
                          options={SEX_OPTIONS}
                          onChange={(next) => {
                            field.handleChange(next as SexValue)
                            clearError("demographics.sex")
                          }}
                        />
                      )}
                    </form.Field>
                  </div>
                ) : null}
              </SectionCard>
            </div>

            <div hidden={step !== "contacto"} className="flex min-w-0 flex-col gap-4">
              {status.needed ? (
                <SectionCard title="Responsable">
                  <p className="text-xs text-muted-foreground sm:col-span-2">
                    {status.minor
                      ? "El paciente es menor de edad: el responsable queda registrado como tutor."
                      : "Completa los datos de quien declara por el paciente."}
                  </p>
                  <div data-reg-field="representative.displayName" className="min-w-0">
                    <form.Field name="answers.representative.displayName">
                      {(field) => (
                        <TextRow
                          label="Nombre del responsable *"
                          value={field.state.value}
                          error={errors["representative.displayName"] ?? errors.representative}
                          inputProps={{ "aria-label": "Nombre del responsable" }}
                          onChange={(next) => {
                            field.handleChange(next)
                            clearError("representative.displayName")
                            clearError("representative")
                          }}
                        />
                      )}
                    </form.Field>
                  </div>
                  <div data-reg-field="representative.relationship" className="min-w-0">
                    <form.Field name="answers.representative.relationship">
                      {(field) => (
                        <SelectRow
                          label="Relación *"
                          value={status.minor ? "guardian" : field.state.value}
                          error={errors["representative.relationship"]}
                          disabled={status.minor}
                          options={[
                            { value: "guardian", label: CONTACT_RELATIONSHIP_LABELS.guardian },
                            { value: "family", label: CONTACT_RELATIONSHIP_LABELS.family },
                            { value: "other", label: CONTACT_RELATIONSHIP_LABELS.other },
                          ]}
                          onChange={(next) => {
                            field.handleChange(
                              next === "family"
                                ? "family"
                                : next === "other"
                                  ? "other"
                                  : "guardian",
                            )
                            clearError("representative.relationship")
                          }}
                        />
                      )}
                    </form.Field>
                  </div>
                  <div data-reg-field="representative.relationshipDetail" className="min-w-0">
                    <form.Field name="answers.representative.relationshipDetail">
                      {(field) => (
                        <TextRow
                          label="Detalle (Madre, Padre…)"
                          value={field.state.value ?? ""}
                          error={errors["representative.relationshipDetail"]}
                          inputProps={{ "aria-label": "Detalle de la relación", maxLength: 100 }}
                          onChange={(next) => {
                            field.handleChange(next)
                            clearError("representative.relationshipDetail")
                          }}
                        />
                      )}
                    </form.Field>
                  </div>
                  {status.minor ? (
                    <>
                      <div data-reg-field="representative.docType" className="min-w-0">
                        <form.Field name="answers.representative.docType">
                          {(field) => (
                            <SelectRow
                              label="Documento del representante *"
                              value={field.state.value ?? profile.documentTypes[0]!.code}
                              error={errors["representative.docType"]}
                              options={documentChoices(profile, field.state.value)}
                              onChange={(next) => field.handleChange(next as never)}
                            />
                          )}
                        </form.Field>
                      </div>
                      <form.Subscribe selector={(state) => state.values.answers.representative.docType}>
                        {(repDocType) =>
                          asksDocumentCountry(profile, repDocType) ? (
                            <div data-reg-field="representative.docCountry" className="min-w-0">
                              <form.Field name="answers.representative.docCountry">
                                {(field) => (
                                  <TextRow
                                    label="País que emitió su documento *"
                                    error={errors["representative.docCountry"]}
                                    renderControl={(id) => (
                                      <SearchSelect
                                        id={id}
                                        label="País que emitió su documento"
                                        placeholder="Buscar país…"
                                        value={field.state.value ?? ""}
                                        options={countries}
                                        invalid={Boolean(errors["representative.docCountry"])}
                                        onChange={(next) => {
                                          field.handleChange(next)
                                          clearError("representative.docCountry")
                                        }}
                                      />
                                    )}
                                  />
                                )}
                              </form.Field>
                            </div>
                          ) : null
                        }
                      </form.Subscribe>
                      <div data-reg-field="representative.docNumber" className="min-w-0">
                        <form.Field name="answers.representative.docNumber">
                          {(field) => (
                            <TextRow
                              label="Número de documento del representante *"
                              value={field.state.value ?? ""}
                              error={errors["representative.docNumber"]}
                              inputProps={{
                                "aria-label": "Documento del representante",
                                maxLength: 20,
                              }}
                              onChange={(next) => {
                                field.handleChange(next)
                                clearError("representative.docNumber")
                              }}
                            />
                          )}
                        </form.Field>
                      </div>
                    </>
                  ) : null}
                  <div data-reg-field="representative.phone" className="min-w-0">
                    <form.Field name="answers.representative.phone">
                      {(field) => (
                        <TextRow
                          label="Teléfono del responsable *"
                          error={errors["representative.phone"]}
                          renderControl={(id) => (
                            <PhoneInput
                              id={id}
                              value={field.state.value || null}
                              defaultCountry={defaultCountry}
                              onChange={(next) => {
                                field.handleChange(next ?? "")
                                clearError("representative.phone")
                              }}
                            />
                          )}
                        />
                      )}
                    </form.Field>
                  </div>
                  <div data-reg-field="representative.email" className="min-w-0">
                    <form.Field name="answers.representative.email">
                      {(field) => (
                        <TextRow
                          label="Correo del responsable"
                          value={field.state.value ?? ""}
                          error={errors["representative.email"]}
                          inputProps={{ "aria-label": "Correo del responsable", type: "email" }}
                          onChange={(next) => {
                            field.handleChange(next)
                            clearError("representative.email")
                          }}
                        />
                      )}
                    </form.Field>
                  </div>
                  <p className="text-xs text-muted-foreground sm:col-span-2">
                    * Nombre y al menos un medio de contacto (teléfono o correo) del responsable.
                  </p>
                </SectionCard>
              ) : null}
              <SectionCard title="Contacto y filiación">
                {visible("phone") ? (
                  <div data-reg-field="demographics.phone" className="min-w-0">
                    <form.Field name="answers.demographics.phone">
                      {(field) => (
                        <TextRow
                          label={label("Teléfono", "phone")}
                          error={errors["demographics.phone"]}
                          renderControl={(id) => (
                            <PhoneInput
                              id={id}
                              value={field.state.value || null}
                              defaultCountry={defaultCountry}
                              onChange={(next) => {
                                field.handleChange(next ?? "")
                                clearError("demographics.phone")
                              }}
                            />
                          )}
                        />
                      )}
                    </form.Field>
                  </div>
                ) : null}
                {visible("email") ? (
                  <div data-reg-field="demographics.email" className="min-w-0">
                    <form.Field name="answers.demographics.email">
                      {(field) => (
                        <TextRow
                          label={label("Correo electrónico", "email")}
                          value={field.state.value ?? ""}
                          error={errors["demographics.email"]}
                          inputProps={{ "aria-label": "Correo electrónico", type: "email" }}
                          onChange={(next) => {
                            field.handleChange(next)
                            clearError("demographics.email")
                          }}
                        />
                      )}
                    </form.Field>
                  </div>
                ) : null}
                {visible("address") ? (
                  <div data-reg-field="demographics.address" className="min-w-0">
                    <form.Field name="answers.demographics.address">
                      {(field) => (
                        <TextRow
                          label={label("Dirección: calle y número", "address")}
                          value={field.state.value ?? ""}
                          error={errors["demographics.address"]}
                          inputProps={{ "aria-label": "Dirección: calle y número" }}
                          onChange={(next) => {
                            field.handleChange(next)
                            clearError("demographics.address")
                          }}
                        />
                      )}
                    </form.Field>
                  </div>
                ) : null}
                {visible("address") ? (
                  <>
                    {/* La dirección internacional, con los nombres del país de la clínica. */}
                    {(
                      [
                        ["addressCity", profile.address.cityLabel, 100],
                        ...(profile.address.districtLabel
                          ? ([["addressDistrict", profile.address.districtLabel, 100]] as const)
                          : []),
                      ] as const
                    ).map(([key, text, max]) => (
                      <div key={key} data-reg-field={`demographics.${key}`} className="min-w-0">
                        <form.Field name={`answers.demographics.${key}`}>
                          {(field) => (
                            <TextRow
                              label={text}
                              value={field.state.value ?? ""}
                              error={errors[`demographics.${key}`]}
                              inputProps={{ "aria-label": text, maxLength: max }}
                              onChange={(next) => {
                                field.handleChange(next)
                                clearError(`demographics.${key}`)
                              }}
                            />
                          )}
                        </form.Field>
                      </div>
                    ))}
                    <div data-reg-field="demographics.addressRegion" className="min-w-0">
                      <form.Field name="answers.demographics.addressRegion">
                        {(field) =>
                          profile.address.regions ? (
                            <SelectRow
                              label={profile.address.regionLabel}
                              value={field.state.value ?? ""}
                              error={errors["demographics.addressRegion"]}
                              options={[
                                { value: "", label: "—" },
                                ...profile.address.regions.map((region) => ({
                                  value: region.code,
                                  label: region.label,
                                })),
                              ]}
                              onChange={(next) => {
                                field.handleChange(next)
                                clearError("demographics.addressRegion")
                              }}
                            />
                          ) : (
                            <TextRow
                              label={profile.address.regionLabel}
                              value={field.state.value ?? ""}
                              error={errors["demographics.addressRegion"]}
                              inputProps={{ "aria-label": profile.address.regionLabel, maxLength: 100 }}
                              onChange={(next) => {
                                field.handleChange(next)
                                clearError("demographics.addressRegion")
                              }}
                            />
                          )
                        }
                      </form.Field>
                    </div>
                    {profile.address.postalCode ? (
                      <div data-reg-field="demographics.addressPostalCode" className="min-w-0">
                        <form.Field name="answers.demographics.addressPostalCode">
                          {(field) => (
                            <TextRow
                              label="Código postal"
                              value={field.state.value ?? ""}
                              error={errors["demographics.addressPostalCode"]}
                              inputProps={{ "aria-label": "Código postal", maxLength: 20 }}
                              onChange={(next) => {
                                field.handleChange(next)
                                clearError("demographics.addressPostalCode")
                              }}
                            />
                          )}
                        </form.Field>
                      </div>
                    ) : null}
                    <div data-reg-field="demographics.addressCountry" className="min-w-0">
                      <form.Field name="answers.demographics.addressCountry">
                        {(field) => (
                          <TextRow
                            label="País"
                            error={errors["demographics.addressCountry"]}
                            renderControl={(id) => (
                              <SearchSelect
                                id={id}
                                label="País"
                                placeholder="Buscar país…"
                                value={field.state.value || profile.country || ""}
                                options={countries}
                                onChange={(next) => {
                                  field.handleChange(next)
                                  clearError("demographics.addressCountry")
                                }}
                              />
                            )}
                          />
                        )}
                      </form.Field>
                    </div>
                    {profile.address.reference ? (
                      <div data-reg-field="demographics.addressReference" className="min-w-0">
                        <form.Field name="answers.demographics.addressReference">
                          {(field) => (
                            <TextRow
                              label="Referencia"
                              value={field.state.value ?? ""}
                              error={errors["demographics.addressReference"]}
                              inputProps={{ "aria-label": "Referencia del domicilio", maxLength: 300 }}
                              onChange={(next) => {
                                field.handleChange(next)
                                clearError("demographics.addressReference")
                              }}
                            />
                          )}
                        </form.Field>
                      </div>
                    ) : null}
                  </>
                ) : null}
                {visible("maritalStatus") ? (
                  <div data-reg-field="demographics.maritalStatus" className="min-w-0">
                    <form.Field name="answers.demographics.maritalStatus">
                      {(field) => (
                        <SelectRow
                          label={label("Estado civil", "maritalStatus")}
                          value={field.state.value ?? ""}
                          error={errors["demographics.maritalStatus"]}
                          options={[{ value: "", label: "—" }, ...maritalChoices(profile)]}
                          onChange={(next) => {
                            field.handleChange(next as never)
                            clearError("demographics.maritalStatus")
                          }}
                        />
                      )}
                    </form.Field>
                  </div>
                ) : null}
                {visible("educationLevel") ? (
                  <div data-reg-field="demographics.educationLevel" className="min-w-0">
                    <form.Field name="answers.demographics.educationLevel">
                      {(field) => (
                        <SelectRow
                          label={label("Nivel educativo", "educationLevel")}
                          value={field.state.value ?? ""}
                          error={errors["demographics.educationLevel"]}
                          options={EDUCATION_OPTIONS}
                          onChange={(next) => {
                            field.handleChange(next as never)
                            clearError("demographics.educationLevel")
                          }}
                        />
                      )}
                    </form.Field>
                  </div>
                ) : null}
                {visible("occupation") ? (
                  <div data-reg-field="demographics.occupation" className="min-w-0">
                    <form.Field name="answers.demographics.occupation">
                      {(field) => (
                        <TextRow
                          label={label("Ocupación", "occupation")}
                          value={field.state.value ?? ""}
                          error={errors["demographics.occupation"]}
                          inputProps={{ "aria-label": "Ocupación" }}
                          onChange={(next) => {
                            field.handleChange(next)
                            clearError("demographics.occupation")
                          }}
                        />
                      )}
                    </form.Field>
                  </div>
                ) : null}
                {visible("origin") ? (
                  <div data-reg-field="demographics.origin" className="min-w-0">
                    <form.Field name="answers.demographics.origin">
                      {(field) => (
                        <TextRow
                          label={label("Procedencia", "origin")}
                          value={field.state.value ?? ""}
                          error={errors["demographics.origin"]}
                          inputProps={{ "aria-label": "Procedencia" }}
                          onChange={(next) => {
                            field.handleChange(next)
                            clearError("demographics.origin")
                          }}
                        />
                      )}
                    </form.Field>
                  </div>
                ) : null}
                {visible("emergencyContactName") ? (
                  <div data-reg-field="demographics.emergencyContactName" className="min-w-0">
                    <form.Field name="answers.demographics.emergencyContactName">
                      {(field) => (
                        <TextRow
                          label={label("Contacto de emergencia", "emergencyContactName")}
                          value={field.state.value ?? ""}
                          error={errors["demographics.emergencyContactName"]}
                          inputProps={{ "aria-label": "Contacto de emergencia" }}
                          onChange={(next) => {
                            field.handleChange(next)
                            clearError("demographics.emergencyContactName")
                          }}
                        />
                      )}
                    </form.Field>
                  </div>
                ) : null}
                {visible("emergencyContactPhone") ? (
                  <div data-reg-field="demographics.emergencyContactPhone" className="min-w-0">
                    <form.Field name="answers.demographics.emergencyContactPhone">
                      {(field) => (
                        <TextRow
                          label={label("Teléfono de emergencia", "emergencyContactPhone")}
                          error={errors["demographics.emergencyContactPhone"]}
                          renderControl={(id) => (
                            <PhoneInput
                              id={id}
                              value={field.state.value || null}
                              defaultCountry={defaultCountry}
                              onChange={(next) => {
                                field.handleChange(next ?? "")
                                clearError("demographics.emergencyContactPhone")
                              }}
                            />
                          )}
                        />
                      )}
                    </form.Field>
                  </div>
                ) : null}
                {visible("insuranceType") ? (
                  <div data-reg-field="demographics.insuranceType" className="min-w-0">
                    <form.Subscribe selector={(state) => state.values.answers.demographics.insuranceScheme}>
                      {(scheme) => (
                        <form.Field name="answers.demographics.insuranceType">
                          {(field) => (
                            <SelectRow
                              label={label("Seguro", "insuranceType")}
                              value={insuranceChoiceOf(field.state.value, scheme)}
                              error={errors["demographics.insuranceType"] ?? errors["demographics.insuranceScheme"]}
                              options={[{ value: "", label: "—" }, ...insuranceChoices(profile)]}
                              onChange={(next) => {
                                // Una sola lista: el tipo general y, si lo tiene, el régimen del país.
                                const chosen = insuranceFromChoice(profile, next)
                                field.handleChange((chosen.insuranceType ?? "") as never)
                                form.setFieldValue("answers.demographics.insuranceScheme", chosen.insuranceScheme ?? "")
                                clearError("demographics.insuranceType")
                                clearError("demographics.insuranceScheme")
                              }}
                            />
                          )}
                        </form.Field>
                      )}
                    </form.Subscribe>
                  </div>
                ) : null}
                {visible("referralSource") ? (
                  <div data-reg-field="demographics.referralSource" className="min-w-0">
                    <form.Field name="answers.demographics.referralKind">
                      {(field) => (
                        <SelectRow
                          label={label("Cómo nos conoció", "referralSource")}
                          value={field.state.value ?? ""}
                          error={errors["demographics.referralKind"]}
                          options={REFERRAL_OPTIONS}
                          onChange={(next) => {
                            field.handleChange(next as never)
                            // Solo «Otro» lleva su texto.
                            if (next !== "otro") form.setFieldValue("answers.demographics.referralSource", "")
                            clearError("demographics.referralKind")
                          }}
                        />
                      )}
                    </form.Field>
                  </div>
                ) : null}
                {visible("referralSource") ? (
                  <form.Subscribe selector={(state) => state.values.answers.demographics.referralKind}>
                    {(kind) =>
                      kind === "otro" ? (
                        <div data-reg-field="demographics.referralSourceText" className="min-w-0">
                          <form.Field name="answers.demographics.referralSource">
                            {(field) => (
                              <TextRow
                                label="¿Cuál?"
                                value={field.state.value ?? ""}
                                error={errors["demographics.referralSource"]}
                                inputProps={{ "aria-label": "Cómo nos conoció: ¿cuál?" }}
                                onChange={(next) => {
                                  field.handleChange(next)
                                  clearError("demographics.referralSource")
                                }}
                              />
                            )}
                          </form.Field>
                        </div>
                      ) : null
                    }
                  </form.Subscribe>
                ) : null}
                {mode === "internal" && branches !== undefined ? (
                  <div data-reg-field="registeredBranchId" className="min-w-0">
                    <form.Field name="registeredBranchId">
                      {(field) => (
                        <SelectRow
                          label="Sede de registro"
                          value={field.state.value}
                          options={[
                            { value: "", label: "—" },
                            ...branches.map((branch) => ({
                              value: branch.id,
                              label: branch.name,
                            })),
                          ]}
                          onChange={(next) => field.handleChange(next)}
                        />
                      )}
                    </form.Field>
                  </div>
                ) : null}
              </SectionCard>
            </div>

            <div hidden={step !== "salud"} className="flex min-w-0 flex-col gap-4">
              <form.Field name="answers.health">
                {(field) => (
                  <RegistrationHealthFields
                    value={field.state.value}
                    onChange={(next) => {
                      field.handleChange(next)
                      setErrors((previous) => {
                        const nextErrors = { ...previous }
                        for (const key of Object.keys(nextErrors)) {
                          if (key.startsWith("health.") && !key.startsWith("health.dental")) {
                            delete nextErrors[key]
                          }
                        }
                        return nextErrors
                      })
                    }}
                    fields={internalFields}
                    errors={healthErrors}
                  />
                )}
              </form.Field>
            </div>

            <div hidden={step !== "odontologicos"} className="flex min-w-0 flex-col gap-4">
              <SectionCard title="Salud dental">
                {visible("dental.ultimaVisita") ? (
                  <div data-reg-field="health.dental.ultimaVisita" className="min-w-0">
                    <form.Field name="answers.health.dental.ultimaVisita">
                      {(field) => (
                        <TextRow
                          label={label("Última visita dental", "dental.ultimaVisita")}
                          value={field.state.value ?? ""}
                          error={errors["health.dental.ultimaVisita"]}
                          inputProps={{ "aria-label": "Última visita dental" }}
                          onChange={(next) => {
                            field.handleChange(next === "" ? undefined : next)
                            clearError("health.dental.ultimaVisita")
                          }}
                        />
                      )}
                    </form.Field>
                  </div>
                ) : null}
                {visible("dental.experienciaPrevia") ? (
                  <div data-reg-field="health.dental.experienciaPrevia" className="min-w-0">
                    <form.Field name="answers.health.dental.experienciaPrevia">
                      {(field) => (
                        <SelectRow
                          label={label("Experiencia previa", "dental.experienciaPrevia")}
                          value={field.state.value ?? ""}
                          error={errors["health.dental.experienciaPrevia"]}
                          options={[
                            { value: "", label: "—" },
                            { value: "positiva", label: "Positiva" },
                            { value: "regular", label: "Regular" },
                            { value: "traumatica", label: "Traumática" },
                          ]}
                          onChange={(next) => {
                            field.handleChange(
                              next === "positiva" || next === "regular" || next === "traumatica"
                                ? next
                                : undefined,
                            )
                            clearError("health.dental.experienciaPrevia")
                          }}
                        />
                      )}
                    </form.Field>
                  </div>
                ) : null}
                {visible("dental.ansiedadDental") ? (
                  <div data-reg-field="health.dental.ansiedadDental" className="min-w-0">
                    <form.Field name="answers.health.dental.ansiedadDental">
                      {(field) => (
                        <SelectRow
                          label={label("Ansiedad dental", "dental.ansiedadDental")}
                          value={field.state.value ?? ""}
                          error={errors["health.dental.ansiedadDental"]}
                          options={[
                            { value: "", label: "—" },
                            { value: "ninguna", label: "Ninguna" },
                            { value: "leve", label: "Leve" },
                            { value: "moderada", label: "Moderada" },
                            { value: "alta", label: "Alta" },
                          ]}
                          onChange={(next) => {
                            field.handleChange(
                              next === "ninguna" ||
                                next === "leve" ||
                                next === "moderada" ||
                                next === "alta"
                                ? next
                                : undefined,
                            )
                            clearError("health.dental.ansiedadDental")
                          }}
                        />
                      )}
                    </form.Field>
                  </div>
                ) : null}
              </SectionCard>
            </div>

            <div hidden={step !== "revision"} className="flex min-w-0 flex-col gap-4">
              <ReviewSummary
                values={form.state.values}
                today={today}
                mode={mode}
                config={config}
                countryCode={countryCode}
                contactName={contact?.displayName}
                branches={branches}
              />
              {config.privacyNotice.trim() ? (
                <div className="flex flex-col gap-6 elevated rounded-xl border bg-card p-6">
                  <div className="flex flex-col gap-1.5">
                    <div className="font-heading text-base font-medium">Aviso de privacidad</div>
                  </div>
                  <div>
                    <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                      {config.privacyNotice}
                    </p>
                  </div>
                </div>
              ) : null}
              <div data-reg-field="privacyAccepted">
                <form.Field name="answers.privacyAccepted">
                  {(field) => (
                    <Field>
                      <label
                        htmlFor="registration-privacy"
                        className="flex cursor-pointer items-start gap-2 text-sm"
                      >
                        <Checkbox
                          id="registration-privacy"
                          checked={field.state.value === true}
                          onCheckedChange={(checked) => {
                            field.handleChange(checked === true)
                            clearError("privacyAccepted")
                          }}
                        />
                        <span>
                          {pub
                            ? "Autorizo el tratamiento de mis datos personales para el registro como paciente. *"
                            : "Declaro que informé al paciente (o a su responsable) sobre el tratamiento de sus datos."}
                        </span>
                      </label>
                      {errors.privacyAccepted ? (
                        <FieldError>{errors.privacyAccepted}</FieldError>
                      ) : null}
                    </Field>
                  )}
                </form.Field>
              </div>
              {/* Lo de su atención es parte del servicio (ADR 0030): solo se pregunta por novedades y promociones. */}
              {config.askMessages ? (
                <fieldset className="flex flex-col gap-3">
                  <legend className="mb-3 text-sm font-medium">
                    {pub ? "Mensajes de la clínica (opcional)" : "Mensajes de la clínica: lo que aceptó recibir"}
                  </legend>
                  {config.askMessages ? (
                    <form.Field name="answers.acceptsMessages">
                      {(field) => (
                        <label htmlFor="registration-messages" className="flex cursor-pointer items-start gap-2 text-sm">
                          <Checkbox
                            id="registration-messages"
                            checked={field.state.value === true}
                            onCheckedChange={(checked) => field.handleChange(checked === true)}
                          />
                          <span>
                            {pub
                              ? "¿Te podemos escribir para enviarte novedades y promociones de la clínica? Sí, acepto."
                              : "Novedades y promociones de la clínica."}
                          </span>
                        </label>
                      )}
                    </form.Field>
                  ) : null}
                  <p className="text-sm text-muted-foreground">
                    {pub
                      ? "Puedes dejar de recibirlos cuando quieras, con un toque desde cualquier mensaje."
                      : "Queda en su ficha, en «Mensajes de la clínica», y se puede cambiar ahí."}
                  </p>
                </fieldset>
              ) : null}
            </div>
          </div>
        )

        const view: RegistrationFormView = {
          body,
          progress: (
            <WizardSteps
              steps={steps.map((id) => ({ id, label: STEP_LABELS[id] }))}
              current={safeCurrent}
              visited={visited.filter((index) => index < steps.length)}
              onGo={(index) => {
                if (!submitting) go(index)
              }}
            />
          ),
          previous:
            safeCurrent > 0 ? (
              <Button
                type="button"
                variant="outline"
                disabled={submitting}
                onClick={() => go(safeCurrent - 1)}
              >
                Anterior
              </Button>
            ) : null,
          onSubmit: (event) => {
            event.preventDefault()
            if (safeCurrent < last) void advance()
            else void finish()
          },
          isDirty: slice.isDirty,
          isSubmitting: submitting,
          submitLabel,
          submitDisabled: submitting,
          error,
        }
        return children(view)
      }}
    </form.Subscribe>
  )
}

function ReviewSummary({
  values,
  today,
  mode,
  config,
  countryCode,
  contactName,
  branches,
}: {
  values: RegistrationFormValues
  today: string
  mode: RegistrationFormMode
  config: RegistrationConfig
  countryCode: string | null
  contactName: string | undefined
  branches: RegistrationFormBranch[] | undefined
}): React.JSX.Element {
  const status = representativeStatus(
    values.answers.demographics.birthDate,
    values.answers.respondent,
    values.recipient,
    today,
    mode,
    contactName !== undefined,
  )
  const answers = buildAnswers(values, {
    mode,
    config,
    countryCode,
    hasContact: contactName !== undefined,
    minor: status.minor,
    needsRepresentative: status.needed,
  })
  const profile = clinicalProfileFor(countryCode)
  const demographics = answers.demographics
  const health = answers.health
  const rows: Array<[string, string]> = [
    ["Nombre", trim(demographics.displayName) || "—"],
    // En el orden de la clínica, como se escribió (se guarda en ISO 8601).
    ["Nacimiento", writeDate(trim(demographics.birthDate), writtenDateFormat(clinicDateLocale(countryCode))) || "—"],
    ["Documento", documentLine(demographics.docType, trim(demographics.docNumber), demographics.docCountry) ?? "—"],
    [
      "Sexo",
      demographics.sex ? (SEX_LABELS[demographics.sex as keyof typeof SEX_LABELS] ?? "—") : "—",
    ],
    ["Teléfono", trim(demographics.phone) || "—"],
    ["Correo", trim(demographics.email) || "—"],
    ["Dirección", addressLine(profile, demographics) ?? "—"],
    [
      "Estado civil",
      demographics.maritalStatus
        ? MARITAL_STATUS_LABELS[demographics.maritalStatus as keyof typeof MARITAL_STATUS_LABELS]
        : "—",
    ],
    [
      "Nivel educativo",
      demographics.educationLevel
        ? EDUCATION_LEVEL_LABELS[demographics.educationLevel as keyof typeof EDUCATION_LEVEL_LABELS]
        : "—",
    ],
    ["Ocupación", trim(demographics.occupation) || "—"],
    ...(profile.origin ? ([["Procedencia", trim(demographics.origin) || "—"]] as Array<[string, string]>) : []),
    [
      "Contacto de emergencia",
      [trim(demographics.emergencyContactName), trim(demographics.emergencyContactPhone)]
        .filter(Boolean)
        .join(" · ") || "—",
    ],
    ["Seguro", insuranceText(profile, demographics.insuranceType, demographics.insuranceScheme) ?? "—"],
    ["Cómo nos conoció", referralText(demographics.referralKind, demographics.referralSource) ?? "—"],
  ]
  if (answers.representative) {
    rows.push(
      ["Responsable", trim(answers.representative.displayName) || "—"],
      [
        "Relación",
        [
          CONTACT_RELATIONSHIP_LABELS[
            answers.representative.relationship as keyof typeof CONTACT_RELATIONSHIP_LABELS
          ] ?? answers.representative.relationship,
          trim(answers.representative.relationshipDetail),
        ]
          .filter(Boolean)
          .join(" · ") || "—",
      ],
      [
        "Contacto del responsable",
        [trim(answers.representative.phone), trim(answers.representative.email)]
          .filter(Boolean)
          .join(" · ") || "—",
      ],
    )
  }
  if (health) {
    rows.push(["Grupo sanguíneo", bloodLabel(health.bloodGroup)])
    for (const [key, singular] of [
      ["allergies", "alergias"],
      ["conditions", "enfermedades"],
      ["medications", "medicación"],
    ] as const) {
      const group = health[key]
      if (!group) continue
      rows.push([
        singular[0].toUpperCase() + singular.slice(1),
        group.state === "recorded"
          ? `${group.items.length} registrada(s)`
          : (STATE_LABELS[group.state] ?? group.state),
      ])
    }
    if (health.dental) {
      const dentalParts = [
        trim(health.dental.ultimaVisita),
        health.dental.experienciaPrevia ? `Experiencia ${health.dental.experienciaPrevia}` : "",
        health.dental.ansiedadDental ? `Ansiedad ${health.dental.ansiedadDental}` : "",
      ].filter(Boolean)
      if (dentalParts.length > 0) rows.push(["Salud dental", dentalParts.join(" · ")])
    }
  }
  rows.push([
    "Declarante",
    answers.respondent === "staff" && mode === "internal"
      ? `Personal de la clínica${status.minor ? " (menor con responsable)" : ""}`
      : (RESPONDENT_LABELS[answers.respondent] ?? answers.respondent),
  ])
  if (mode === "internal" && contactName) {
    rows.push([
      "Vínculo",
      values.recipient === "self"
        ? `Se vinculará a ${contactName} como propio paciente`
        : `Se vinculará a ${contactName} como ${(
            CONTACT_RELATIONSHIP_LABELS[
              (status.minor
                ? "guardian"
                : values.answers.representative
                    .relationship) as keyof typeof CONTACT_RELATIONSHIP_LABELS
            ] ?? ""
          ).toLowerCase()}`,
    ])
  }
  if (mode === "internal" && values.registeredBranchId) {
    rows.push([
      "Sede",
      branches?.find((branch) => branch.id === values.registeredBranchId)?.name ??
        values.registeredBranchId,
    ])
  }
  return (
    <div className="flex flex-col gap-6 elevated rounded-xl border bg-card p-6">
      <div className="flex flex-col gap-1.5">
        <div className="font-heading text-base font-medium">Revisa los datos antes de enviar</div>
      </div>
      <div>
        <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          {rows.map(([labelText, value]) => (
            <div key={labelText} className="min-w-0">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {labelText}
              </dt>
              <dd className="break-words text-sm">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  )
}

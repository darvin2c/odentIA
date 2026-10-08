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
  CONTACT_RELATIONSHIP_LABELS,
  type DeclarationState,
  type DOC_TYPES,
  type HealthAllergyDeclaration,
  type HealthConditionDeclaration,
  type HealthMedicationDeclaration,
  type INSURANCE_TYPES,
  isMinor,
  isRealDate,
  type RegistrationAnswers,
  type RegistrationConfig,
  type RegistrationContactInput,
  type RegistrationDemographics,
  type RegistrationFieldKey,
  type RegistrationRespondent,
  validateRegistrationAnswers,
} from "@odentia/clinical"
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Checkbox,
  Field,
  FieldError,
} from "@odentia/ui"
import {
  type CountryCode,
  DEFAULT_COUNTRY,
  isValidE164,
  PhoneInput,
  WizardSteps,
} from "@odentia/ui-patterns"
import { useForm } from "@tanstack/react-form"
import { useEffect, useRef, useState } from "react"
import type { ContactFull } from "../../lib/crm"
import {
  DOC_TYPE_OPTIONS,
  INSURANCE_OPTIONS,
  SEX_OPTIONS,
  SectionCard,
  SelectRow,
  TextRow,
} from "./patient-demographics-form"
import { RegistrationHealthFields } from "./patient-health-fields"
export type RegistrationFormMode = "internal" | "public" | "preview"
export interface RegistrationFormContext {
  kind: "generic" | "contact" | "conversation"
  contact?: ContactFull
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
  /**
   * País de los teléfonos que se capturan: el de la organización en el alta
   * interna. En el formulario público (sin sesión) queda el de partida.
   */
  defaultCountry?: CountryCode
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
  "insuranceDetail",
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
type SexValue = "M" | "F" | ""
type InsuranceValue = (typeof INSURANCE_TYPES)[number] | ""

interface RegistrationFormValues {
  answers: Omit<RegistrationAnswers, "representative" | "health"> & {
    representative: RepresentativeValue
    health: HealthValue
  }
  recipient: "self" | "other"
  registeredBranchId: string
}

const EMPTY_REPRESENTATIVE: RepresentativeValue = {
  displayName: "",
  relationship: "guardian",
  relationshipDetail: "",
}

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
        birthDate: "",
        docType: "",
        docNumber: "",
        sex: "",
        phone: "",
        email: "",
        address: "",
        maritalStatus: "",
        educationLevel: "",
        occupation: "",
        origin: "",
        emergencyContactName: "",
        emergencyContactPhone: "",
        insuranceType: "",
        insuranceDetail: "",
        referralSource: "",
        ...initialDemographics,
      } as RegistrationDemographics,
      respondent: respondent as RegistrationRespondent,
      representative: { ...EMPTY_REPRESENTATIVE, ...initialRepresentative },
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
    hasContact: boolean
    minor: boolean
    needsRepresentative: boolean
  },
): RegistrationAnswers {
  const { mode, config, minor, needsRepresentative } = options
  const pub = mode === "public" || mode === "preview"
  const demographics = values.answers.demographics
  const keptDemographics: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(demographics)) {
    if (pub && config.fields[key as RegistrationFieldKey] === "hidden") continue
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
        }
      : undefined,
    health: keptHealth as HealthValue,
    privacyAccepted: values.answers.privacyAccepted,
  }
}

const FIELD_ORDER: string[] = [
  "demographics.displayName",
  "demographics.birthDate",
  "demographics.docType",
  "demographics.docNumber",
  "demographics.sex",
  "respondent",
  ...CONTACTO_KEYS.map((key) => `demographics.${key}`),
  "representative",
  "representative.displayName",
  "representative.relationship",
  "representative.relationshipDetail",
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
  defaultCountry = DEFAULT_COUNTRY,
  onSubmit,
  children,
}: PatientRegistrationFormProps): React.JSX.Element {
  const hasContact = context.kind !== "generic" && Boolean(context.contact)
  const contact = context.contact
  const selfPatient = contact?.patients.find((entry) => entry.relationship === "self")

  const [initialForm] = useState(() => {
    const defaults = buildDefaults(mode, initialValues)
    if (selfPatient) defaults.recipient = "other"
    return defaults
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
      hasContact,
      minor: status.minor,
      needsRepresentative: status.needed,
    })
    const found = validateRegistrationAnswers(config, answers, {
      mode: mode === "preview" ? "public" : mode,
      today,
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
        const visible = (key: RegistrationFieldKey): boolean =>
          mode === "internal" || config.fields[key] !== "hidden"
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
        const required = (key: RegistrationFieldKey): boolean =>
          mode === "internal" ? key === "displayName" : config.fields[key] === "required"
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
                contactId: contact.contact.id,
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
                            field.handleChange(next === "other" ? "other" : "self")
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
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              nativeButton={false}
                              render={<a href={`/patients/${selfPatient.id}`} />}
                            >
                              Ver paciente
                            </Button>
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
                {pub ? (
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
                  <div data-reg-field="demographics.displayName" className="min-w-0">
                    <form.Field name="answers.demographics.displayName">
                      {(field) => (
                        <TextRow
                          label={label("Nombre del paciente", "displayName")}
                          value={field.state.value}
                          error={errors["demographics.displayName"]}
                          inputProps={{
                            "aria-label": "Nombre del paciente",
                            placeholder: "Nombres y apellidos",
                          }}
                          onChange={(next) => {
                            field.handleChange(next)
                            clearError("demographics.displayName")
                          }}
                        />
                      )}
                    </form.Field>
                  </div>
                ) : null}
                {visible("birthDate") ? (
                  <div data-reg-field="demographics.birthDate" className="min-w-0">
                    <form.Field name="answers.demographics.birthDate">
                      {(field) => (
                        <TextRow
                          label={label("Fecha de nacimiento", "birthDate")}
                          value={field.state.value ?? ""}
                          error={errors["demographics.birthDate"]}
                          inputProps={{ "aria-label": "Fecha de nacimiento", type: "date" }}
                          onChange={(next) => {
                            field.handleChange(next)
                            clearError("demographics.birthDate")
                            clearError("representative")
                            clearError("respondent")
                          }}
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
                          options={DOC_TYPE_OPTIONS}
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
                          inputProps={{ "aria-label": "Número de documento", inputMode: "numeric" }}
                          onChange={(next) => {
                            field.handleChange(next)
                            clearError("demographics.docNumber")
                          }}
                        />
                      )}
                    </form.Field>
                  </div>
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
                          label={label("Dirección", "address")}
                          value={field.state.value ?? ""}
                          error={errors["demographics.address"]}
                          inputProps={{ "aria-label": "Dirección" }}
                          onChange={(next) => {
                            field.handleChange(next)
                            clearError("demographics.address")
                          }}
                        />
                      )}
                    </form.Field>
                  </div>
                ) : null}
                {visible("maritalStatus") ? (
                  <div data-reg-field="demographics.maritalStatus" className="min-w-0">
                    <form.Field name="answers.demographics.maritalStatus">
                      {(field) => (
                        <TextRow
                          label={label("Estado civil", "maritalStatus")}
                          value={field.state.value ?? ""}
                          error={errors["demographics.maritalStatus"]}
                          inputProps={{ "aria-label": "Estado civil" }}
                          onChange={(next) => {
                            field.handleChange(next)
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
                        <TextRow
                          label={label("Grado de instrucción", "educationLevel")}
                          value={field.state.value ?? ""}
                          error={errors["demographics.educationLevel"]}
                          inputProps={{ "aria-label": "Grado de instrucción" }}
                          onChange={(next) => {
                            field.handleChange(next)
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
                    <form.Field name="answers.demographics.insuranceType">
                      {(field) => (
                        <SelectRow
                          label={label("Seguro", "insuranceType")}
                          value={field.state.value ?? ""}
                          error={errors["demographics.insuranceType"]}
                          options={INSURANCE_OPTIONS}
                          onChange={(next) => {
                            field.handleChange(next as InsuranceValue)
                            clearError("demographics.insuranceType")
                            clearError("demographics.insuranceDetail")
                          }}
                        />
                      )}
                    </form.Field>
                  </div>
                ) : null}
                {visible("insuranceDetail") ? (
                  <div data-reg-field="demographics.insuranceDetail" className="min-w-0">
                    <form.Field name="answers.demographics.insuranceDetail">
                      {(field) => (
                        <TextRow
                          label={label("Detalle del seguro", "insuranceDetail")}
                          value={field.state.value ?? ""}
                          error={errors["demographics.insuranceDetail"]}
                          inputProps={{ "aria-label": "Detalle del seguro" }}
                          onChange={(next) => {
                            field.handleChange(next)
                            clearError("demographics.insuranceDetail")
                          }}
                        />
                      )}
                    </form.Field>
                  </div>
                ) : null}
                {visible("referralSource") ? (
                  <div data-reg-field="demographics.referralSource" className="min-w-0">
                    <form.Field name="answers.demographics.referralSource">
                      {(field) => (
                        <TextRow
                          label={label("Referencia", "referralSource")}
                          value={field.state.value ?? ""}
                          error={errors["demographics.referralSource"]}
                          inputProps={{ "aria-label": "Cómo nos conoció" }}
                          onChange={(next) => {
                            field.handleChange(next)
                            clearError("demographics.referralSource")
                          }}
                        />
                      )}
                    </form.Field>
                  </div>
                ) : null}
                {mode === "internal" && branches !== undefined ? (
                  <div data-reg-field="registeredBranchId" className="min-w-0">
                    <form.Field name="registeredBranchId">
                      {(field) => (
                        <SelectRow
                          label="Sucursal de registro"
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
                contactName={contact?.contact.displayName}
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
  contactName,
  branches,
}: {
  values: RegistrationFormValues
  today: string
  mode: RegistrationFormMode
  config: RegistrationConfig
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
    hasContact: contactName !== undefined,
    minor: status.minor,
    needsRepresentative: status.needed,
  })
  const demographics = answers.demographics
  const health = answers.health
  const rows: Array<[string, string]> = [
    ["Nombre", trim(demographics.displayName) || "—"],
    ["Nacimiento", trim(demographics.birthDate) || "—"],
    [
      "Documento",
      [trim(demographics.docType), trim(demographics.docNumber)].filter(Boolean).join(" ") || "—",
    ],
    ["Sexo", demographics.sex === "M" ? "Masculino" : demographics.sex === "F" ? "Femenino" : "—"],
    ["Teléfono", trim(demographics.phone) || "—"],
    ["Correo", trim(demographics.email) || "—"],
    ["Dirección", trim(demographics.address) || "—"],
    ["Estado civil", trim(demographics.maritalStatus) || "—"],
    ["Grado de instrucción", trim(demographics.educationLevel) || "—"],
    ["Ocupación", trim(demographics.occupation) || "—"],
    ["Procedencia", trim(demographics.origin) || "—"],
    [
      "Contacto de emergencia",
      [trim(demographics.emergencyContactName), trim(demographics.emergencyContactPhone)]
        .filter(Boolean)
        .join(" · ") || "—",
    ],
    [
      "Seguro",
      [trim(demographics.insuranceType), trim(demographics.insuranceDetail)]
        .filter(Boolean)
        .join(" · ") || "—",
    ],
    ["Referencia", trim(demographics.referralSource) || "—"],
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
      "Sucursal",
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

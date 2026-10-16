import {
  type ClinicalCountryProfile,
  clinicalProfileFor,
  CONTACT_RELATIONSHIP_LABELS,
  composeDisplayName,
  DOC_TYPE_LABELS,
  type IdentityDocType,
  isMinor,
  isRealDate,
  type RegistrationAnswers,
  validateRegistrationAnswers,
} from "@odentia/clinical"
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@odentia/ui"
import { BirthDateInput, ErrorState, LoadingState, PhoneInput, SubmitButton } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { type FormEvent, type InputHTMLAttributes, useState } from "react"
import { ApiError } from "../lib/api"
import { fetchBookingRegistrationForm, submitBookingRegistration } from "../lib/booking-link"
import { asksDocumentCountry, countryChoices } from "../lib/person-data"
import { SearchSelect } from "./settings/search-select"

type Relationship = "guardian" | "family" | "other"
const RELATIONSHIPS: readonly Relationship[] = ["guardian", "family", "other"]

/** Nombre y documento de una persona, tal como se escriben en la pantalla. */
interface PersonDraft {
  givenNames: string
  /** Primer y segundo apellido por separado (decisión 10 de la fase 3). */
  paternalSurname: string
  maternalSurname: string
  /** Vacío mientras no se elija: vale el primero de los que se usan en el país de la clínica. */
  docType: IdentityDocType | ""
  docNumber: string
  docCountry: string
}

/** Lo escrito en «Tus datos». Vive en la página para no perderse al cambiar de horario ni si el envío falla. */
export interface BookingDataDraft {
  /** Quien escribe y reserva. */
  me: PersonDraft
  /** `null` mientras la persona no lo toque: entonces vale el celular que el sistema conoce, si conoce alguno. */
  phone: string | null
  phoneTouched: boolean
  /** Hay dígitos escritos que aún no forman un número. */
  phoneIncomplete: boolean
  who: "patient" | "representative"
  /** Solo si la cita es para otra persona: quien se va a atender. */
  other: PersonDraft
  /** De la edad de esa persona depende que haga falta un representante legal. */
  otherBirthDate: string
  relationship: Relationship
  privacyAccepted: boolean
}

export function emptyBookingDataDraft(): BookingDataDraft {
  // El primer tipo de documento del país de la clínica, no uno fijo de esta pantalla.
  const person = (): PersonDraft => ({ givenNames: "", paternalSurname: "", maternalSurname: "", docType: "", docNumber: "", docCountry: "" })
  return {
    me: person(),
    phone: null,
    phoneTouched: false,
    phoneIncomplete: false,
    who: "patient",
    other: person(),
    otherBirthDate: "",
    relationship: "family",
    privacyAccepted: false,
  }
}

type PersonField = "givenNames" | "paternalSurname" | "maternalSurname" | "docNumber" | "docCountry"
type FieldKey = `me.${PersonField}` | `other.${PersonField}` | "phone" | "otherBirthDate" | "relationship" | "privacyAccepted"
/** En el orden de la pantalla: el primero con error recibe el foco. */
const FIELD_ORDER: readonly FieldKey[] = [
  "me.givenNames",
  "me.paternalSurname",
  "me.docNumber",
  "me.docCountry",
  "phone",
  "other.givenNames",
  "other.paternalSurname",
  "other.docNumber",
  "other.docCountry",
  "otherBirthDate",
  "relationship",
  "privacyAccepted",
]
type Errors = Partial<Record<FieldKey, string>>
const fieldId = (key: string) => `reserva-datos-${key.replace(".", "-")}`
/** El tipo elegido o, sin elegir, el primero de los que se usan en el país de la clínica. */
const docTypeOf = (profile: ClinicalCountryProfile, person: PersonDraft): IdentityDocType =>
  person.docType || profile.documentTypes[0]!.code
/** El país que lo emitió se pregunta solo si hace falta (`asksDocumentCountry`). */
const asksCountry = (profile: ClinicalCountryProfile, person: PersonDraft) =>
  asksDocumentCountry(profile, docTypeOf(profile, person))

/**
 * Las respuestas del registro de pacientes que salen de este formulario corto:
 * solo los datos esenciales. Si la cita es para otra persona, ella es la
 * paciente y quien escribe queda como su responsable, con su celular.
 */
function buildAnswers(profile: ClinicalCountryProfile, draft: BookingDataDraft, phone: string | null, minor: boolean): RegistrationAnswers {
  const forOther = draft.who === "representative"
  const patient = forOther ? draft.other : draft.me
  const givenNames = patient.givenNames.trim()
  const paternalSurname = patient.paternalSurname.trim().replace(/\s+/g, " ")
  const maternalSurname = patient.maternalSurname.trim().replace(/\s+/g, " ")
  const myDocNumber = draft.me.docNumber.trim()
  return {
    demographics: {
      displayName: composeDisplayName({ givenNames, paternalSurname, maternalSurname }),
      givenNames,
      paternalSurname,
      ...(maternalSurname ? { maternalSurname } : {}),
      docType: docTypeOf(profile, patient),
      docNumber: patient.docNumber.trim(),
      ...(asksCountry(profile, patient) && patient.docCountry ? { docCountry: patient.docCountry } : {}),
      ...(forOther ? { birthDate: draft.otherBirthDate } : { phone: phone ?? "" }),
    },
    respondent: forOther ? "representative" : "patient",
    ...(forOther
      ? {
          representative: {
            displayName: composeDisplayName({
              givenNames: draft.me.givenNames.trim(),
              paternalSurname: draft.me.paternalSurname.trim(),
              maternalSurname: draft.me.maternalSurname.trim(),
            }),
            relationship: minor ? "guardian" : draft.relationship,
            relationshipDetail: "",
            ...(phone ? { phone } : {}),
            ...(myDocNumber
              ? {
                  docType: docTypeOf(profile, draft.me),
                  docNumber: myDocNumber,
                  ...(asksCountry(profile, draft.me) && draft.me.docCountry ? { docCountry: draft.me.docCountry } : {}),
                }
              : {}),
          },
        }
      : {}),
    privacyAccepted: draft.privacyAccepted,
  }
}

function TextField({
  name,
  label,
  value,
  onChange,
  error,
  hint,
  ...input
}: {
  name: FieldKey
  label: string
  value: string
  onChange: (value: string) => void
  error: string | undefined
  hint?: string
} & Omit<InputHTMLAttributes<HTMLInputElement>, "name" | "value" | "onChange">) {
  const id = fieldId(name)
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        className="min-h-11"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        {...input}
      />
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : hint ? <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription> : null}
    </Field>
  )
}

/** Nombres, apellidos y documento de una persona. Los tipos de documento son los del país de la clínica. */
function PersonFields({
  scope,
  profile,
  person,
  errors,
  mine,
  onChange,
}: {
  scope: "me" | "other"
  profile: ClinicalCountryProfile
  person: PersonDraft
  errors: Errors
  /** Los datos son de quien escribe: el navegador puede proponerlos. */
  mine: boolean
  onChange: (patch: Partial<PersonDraft>, ...cleared: PersonField[]) => void
}) {
  const typeId = fieldId(`${scope}.docType`)
  const numberId = fieldId(`${scope}.docNumber`)
  const countryId = fieldId(`${scope}.docCountry`)
  const numberError = errors[`${scope}.docNumber`]
  const countryError = errors[`${scope}.docCountry`]
  const docType = docTypeOf(profile, person)
  return (
    <>
      <TextField
        name={`${scope}.givenNames`}
        label="Nombres"
        autoComplete={mine ? "given-name" : "off"}
        maxLength={100}
        value={person.givenNames}
        error={errors[`${scope}.givenNames`]}
        onChange={(givenNames) => onChange({ givenNames }, "givenNames")}
      />
      <TextField
        name={`${scope}.paternalSurname`}
        label="Primer apellido"
        autoComplete={mine ? "family-name" : "off"}
        maxLength={100}
        value={person.paternalSurname}
        error={errors[`${scope}.paternalSurname`]}
        onChange={(paternalSurname) => onChange({ paternalSurname }, "paternalSurname")}
      />
      <TextField
        name={`${scope}.maternalSurname`}
        label="Segundo apellido"
        autoComplete="off"
        maxLength={100}
        value={person.maternalSurname}
        error={errors[`${scope}.maternalSurname`]}
        onChange={(maternalSurname) => onChange({ maternalSurname }, "maternalSurname")}
      />
      <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-2 gap-y-3">
        <Field>
          <FieldLabel htmlFor={typeId}>Documento</FieldLabel>
          <Select<IdentityDocType>
            value={docType}
            onValueChange={(next) => {
              if (next) onChange({ docType: next }, "docNumber", "docCountry")
            }}
          >
            <SelectTrigger id={typeId} aria-label="Tipo de documento" className="min-h-11 w-full min-w-0">
              <SelectValue>{DOC_TYPE_LABELS[docType]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {profile.documentTypes.map(({ code }) => (
                <SelectItem key={code} value={code}>
                  {DOC_TYPE_LABELS[code]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor={numberId}>Número</FieldLabel>
          <Input
            id={numberId}
            className="min-h-11"
            autoComplete="off"
            maxLength={20}
            value={person.docNumber}
            onChange={(event) => onChange({ docNumber: event.target.value }, "docNumber")}
            aria-invalid={numberError ? true : undefined}
            aria-describedby={numberError ? `${numberId}-error` : undefined}
          />
        </Field>
        {numberError ? (
          <FieldError id={`${numberId}-error`} className="col-span-2">
            {numberError}
          </FieldError>
        ) : null}
      </div>
      {asksCountry(profile, person) ? (
        <Field>
          <FieldLabel htmlFor={countryId}>País que emitió el documento</FieldLabel>
          <SearchSelect
            id={countryId}
            label="País que emitió el documento"
            placeholder="Buscar país…"
            value={person.docCountry}
            options={countryChoices(profile.country)}
            invalid={Boolean(countryError)}
            aria-describedby={countryError ? `${countryId}-error` : undefined}
            onChange={(docCountry) => onChange({ docCountry }, "docCountry")}
          />
          {countryError ? <FieldError id={`${countryId}-error`}>{countryError}</FieldError> : null}
        </Field>
      ) : null}
    </>
  )
}

/**
 * «Tus datos» de la reserva por enlace: lo esencial para reservar, en una sola
 * pantalla. No decide nada del registro: arma las respuestas del registro de
 * pacientes con su alcance «datos esenciales», las valida con las reglas
 * compartidas y las envía; la ficha, el consentimiento y la identidad los
 * resuelve el servidor. Lo demás que pide la clínica se completa allí.
 */
export function BookingDataForm({
  slug,
  token,
  submissionId,
  draft,
  onDraftChange,
  reserving,
  onRegistered,
}: {
  slug: string
  token: string
  submissionId: string
  draft: BookingDataDraft
  onDraftChange: (next: BookingDataDraft) => void
  /** Los datos ya se guardaron y la página está reservando el horario. */
  reserving: boolean
  onRegistered: () => void
}) {
  const queryClient = useQueryClient()
  const [errors, setErrors] = useState<Errors>({})
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [noticeOpen, setNoticeOpen] = useState(false)
  const infoKey = ["booking-registration", slug, token]
  const infoQuery = useQuery({
    queryKey: infoKey,
    queryFn: () => fetchBookingRegistrationForm(slug, token),
    retry: false,
    staleTime: 30_000,
  })

  if (infoQuery.isPending) return <LoadingState kind="indeterminate" message="Cargando…" />
  if (infoQuery.isError) {
    // Ya tiene ficha (por ejemplo, sus datos llegaron y la página se quedó sin la respuesta): solo falta reservar.
    if (infoQuery.error instanceof ApiError && infoQuery.error.shape.code === "BOOKING_ALREADY_PATIENT") {
      return (
        <div className="flex flex-col gap-3">
          <p className="text-sm">Ya tenemos tus datos. Solo falta reservar el horario que elegiste.</p>
          <SubmitButton type="button" className="min-h-11 w-full" pending={reserving} onClick={onRegistered}>
            Reservar mi cita
          </SubmitButton>
        </div>
      )
    }
    return <ErrorState title="No pudimos abrir tus datos" message="Vuelve a intentarlo en un momento o escríbenos por el chat." onRetry={() => void infoQuery.refetch()} />
  }
  const info = infoQuery.data.data
  const profile = clinicalProfileFor(info.countryCode)
  const forOther = draft.who === "representative"
  const minor = forOther && isRealDate(draft.otherBirthDate) && isMinor(draft.otherBirthDate, info.today)
  // El celular solo se propone si el sistema lo conoce de verdad; lo que la persona escriba manda.
  const phone = draft.phoneTouched ? draft.phone : (draft.phone ?? info.phone)
  const phoneFromConversation = info.phone !== null && phone === info.phone
  const busy = submitting || reserving

  const set = (patch: Partial<BookingDataDraft>, ...cleared: FieldKey[]) => {
    onDraftChange({ ...draft, ...patch })
    if (cleared.some((key) => errors[key])) {
      const next = { ...errors }
      for (const key of cleared) delete next[key]
      setErrors(next)
    }
  }

  /** Las reglas son las del registro de pacientes; aquí solo se reparten por campo y se dicen con las palabras de la pantalla. */
  const validate = (answers: RegistrationAnswers): Errors => {
    const found = validateRegistrationAnswers(info.config, answers, { mode: "public", today: info.today, scope: "essentials", countryCode: info.countryCode })
    const next: Errors = {}
    const put = (key: FieldKey, message: string | undefined) => {
      if (message && !next[key]) next[key] = message
    }
    const patient = forOther ? "other" : "me"
    if (!draft.me.givenNames.trim()) put("me.givenNames", "Escribe tus nombres")
    if (!draft.me.paternalSurname.trim()) put("me.paternalSurname", "Escribe tu primer apellido")
    if (forOther) {
      if (!draft.other.givenNames.trim()) put("other.givenNames", "Escribe sus nombres")
      if (!draft.other.paternalSurname.trim()) put("other.paternalSurname", "Escribe su primer apellido")
      if (!draft.otherBirthDate) put("otherBirthDate", "Indica su fecha de nacimiento")
      // De quien escribe, el registro solo exige el documento si representa a un menor.
      put("me.docNumber", found["representative.docNumber"])
      put("relationship", found["representative.relationship"])
    }
    if (!draft[patient].docNumber.trim()) put(`${patient}.docNumber`, "Escribe el número de documento")
    put(`${patient}.givenNames`, found["demographics.givenNames"])
    put(`${patient}.paternalSurname`, found["demographics.paternalSurname"])
    put(`${patient}.docNumber`, found["demographics.docNumber"] ?? found["demographics.docType"])
    put(`${patient}.docCountry`, found["demographics.docCountry"])
    put("otherBirthDate", found["demographics.birthDate"])
    if (draft.phoneIncomplete) put("phone", "Revisa el celular: está incompleto")
    if (!phone) put("phone", "Escribe un celular para avisarte de tu cita")
    put("phone", found["demographics.phone"] ?? found["representative.phone"])
    if (!draft.privacyAccepted) put("privacyAccepted", "Para reservar necesitamos que aceptes el uso de estos datos")
    return next
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    const answers = buildAnswers(profile, draft, phone, minor)
    const found = validate(answers)
    setErrors(found)
    setSubmitError(null)
    const first = FIELD_ORDER.find((key) => found[key])
    if (first) {
      document.getElementById(fieldId(first))?.focus()
      return
    }
    setSubmitting(true)
    try {
      await submitBookingRegistration(slug, { token, submissionId, formVersion: info.config.version, answers })
      onRegistered()
    } catch (error) {
      const shape = error instanceof ApiError ? error.shape : null
      if (shape?.code === "BOOKING_ALREADY_PATIENT") {
        // Un envío anterior sí llegó: los datos ya están guardados y solo falta reservar.
        onRegistered()
      } else if (shape?.code === "FORM_CHANGED") {
        await queryClient.invalidateQueries({ queryKey: infoKey })
        setSubmitError("La clínica actualizó su aviso de privacidad. Revísalo y vuelve a enviar.")
      } else if (shape?.message) {
        setSubmitError(shape.message)
      } else {
        setSubmitError("No pudimos guardar tus datos. Revisa tu conexión y vuelve a intentarlo.")
      }
    } finally {
      setSubmitting(false)
    }
  }

  const setPerson = (scope: "me" | "other") => (patch: Partial<PersonDraft>, ...cleared: PersonField[]) =>
    set({ [scope]: { ...draft[scope], ...patch } }, ...cleared.map((key): FieldKey => `${scope}.${key}`))
  const phoneId = fieldId("phone")
  const relationshipId = fieldId("relationship")
  const privacyId = fieldId("privacyAccepted")

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-4">
      <PersonFields scope="me" profile={profile} person={draft.me} errors={errors} mine onChange={setPerson("me")} />

      <Field>
        <FieldLabel htmlFor={phoneId}>Celular</FieldLabel>
        <PhoneInput
          id={phoneId}
          className="[&_[data-slot=input-group]]:min-h-11 [&_[data-slot=select-trigger]]:min-h-11"
          value={phone}
          invalid={Boolean(errors.phone)}
          aria-describedby={errors.phone ? `${phoneId}-error` : phoneFromConversation ? `${phoneId}-hint` : undefined}
          onChange={(next, meta) => set({ phone: next, phoneTouched: true, phoneIncomplete: meta.digits.length > 0 && next === null }, "phone")}
        />
        {errors.phone ? (
          <FieldError id={`${phoneId}-error`}>{errors.phone}</FieldError>
        ) : phoneFromConversation ? (
          <FieldDescription id={`${phoneId}-hint`}>Es el número desde el que nos escribes. Cámbialo si prefieres otro.</FieldDescription>
        ) : null}
      </Field>

      <FieldSet className="gap-2">
        <FieldLegend variant="label" className="mb-0">
          ¿Para quién es la cita?
        </FieldLegend>
        <RadioGroup
          value={draft.who}
          onValueChange={(next) =>
            set(
              { who: next === "representative" ? "representative" : "patient" },
              "me.docNumber",
              "other.givenNames",
              "other.paternalSurname",
              "other.docNumber",
              "other.docCountry",
              "otherBirthDate",
              "relationship",
            )
          }
          className="grid-cols-2"
        >
          {(
            [
              ["patient", "Para mí"],
              ["representative", "Para otra persona"],
            ] as const
          ).map(([value, label]) => (
            <label
              key={value}
              htmlFor={fieldId(`who-${value}`)}
              className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border bg-card px-3 py-2 text-sm font-medium has-[[data-checked]]:border-primary has-[[data-checked]]:bg-primary-soft has-[[data-checked]]:text-primary-soft-foreground"
            >
              <RadioGroupItem id={fieldId(`who-${value}`)} value={value} />
              {label}
            </label>
          ))}
        </RadioGroup>
      </FieldSet>

      {forOther ? (
        <FieldSet className="gap-4 rounded-2xl border bg-card p-4">
          <FieldLegend variant="label" className="mb-0">
            La persona que se va a atender
          </FieldLegend>
          <PersonFields scope="other" profile={profile} person={draft.other} errors={errors} mine={false} onChange={setPerson("other")} />
          {/* Mismo control que el registro de pacientes: una fecha de nacimiento se escribe, en el orden de la clínica. */}
          <Field>
            <FieldLabel htmlFor={fieldId("otherBirthDate")}>Fecha de nacimiento</FieldLabel>
            <BirthDateInput
              id={fieldId("otherBirthDate")}
              className="[&_input]:min-h-11"
              today={info.today}
              value={draft.otherBirthDate}
              invalid={Boolean(errors.otherBirthDate)}
              aria-describedby={`${fieldId("otherBirthDate")}-${errors.otherBirthDate ? "error" : "hint"}`}
              onChange={(otherBirthDate) => set({ otherBirthDate }, "otherBirthDate", "relationship", "me.docNumber")}
            />
            {errors.otherBirthDate ? (
              <FieldError id={`${fieldId("otherBirthDate")}-error`}>{errors.otherBirthDate}</FieldError>
            ) : (
              <FieldDescription id={`${fieldId("otherBirthDate")}-hint`}>
                Si es menor de edad, quedas como su responsable.
              </FieldDescription>
            )}
          </Field>
          <Field>
            <FieldLabel htmlFor={relationshipId}>Tu relación con esa persona</FieldLabel>
            <Select<Relationship>
              value={minor ? "guardian" : draft.relationship}
              disabled={minor}
              onValueChange={(next) => {
                if (next) set({ relationship: next }, "relationship")
              }}
            >
              <SelectTrigger id={relationshipId} className="min-h-11 w-full">
                <SelectValue>{CONTACT_RELATIONSHIP_LABELS[minor ? "guardian" : draft.relationship]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {RELATIONSHIPS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {CONTACT_RELATIONSHIP_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.relationship ? (
              <FieldError>{errors.relationship}</FieldError>
            ) : minor ? (
              <FieldDescription>Es menor de edad: quedas como su tutor o responsable, con tu documento.</FieldDescription>
            ) : null}
          </Field>
        </FieldSet>
      ) : null}

      <div className="flex flex-col gap-1">
        <div className="flex items-start gap-3">
          <Checkbox
            id={privacyId}
            className="mt-3.5"
            checked={draft.privacyAccepted}
            onCheckedChange={(checked) => set({ privacyAccepted: checked === true }, "privacyAccepted")}
            aria-invalid={errors.privacyAccepted ? true : undefined}
            aria-describedby={errors.privacyAccepted ? `${privacyId}-error` : undefined}
          />
          <div className="flex min-w-0 flex-col items-start">
            <label htmlFor={privacyId} className="flex min-h-11 cursor-pointer items-center text-sm">
              Acepto que la clínica use estos datos para gestionar mi cita.
            </label>
            <Button type="button" variant="link" className="h-auto min-h-11 p-0 text-sm" onClick={() => setNoticeOpen(true)}>
              Ver el aviso de privacidad
            </Button>
          </div>
        </div>
        {errors.privacyAccepted ? <FieldError id={`${privacyId}-error`}>{errors.privacyAccepted}</FieldError> : null}
      </div>

      {/* En teléfono el botón queda a la vista mientras se llena el formulario. */}
      <div className="sticky bottom-0 -mx-4 flex flex-col gap-2 border-t bg-canvas p-4 sm:static sm:mx-0 sm:border-t-0 sm:p-0">
        {submitError ? (
          <p role="alert" className="text-sm text-destructive">
            {submitError}
          </p>
        ) : null}
        <SubmitButton type="submit" className="min-h-11 w-full" pending={busy}>
          Reservar mi cita
        </SubmitButton>
      </div>

      <Dialog open={noticeOpen} onOpenChange={setNoticeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Aviso de privacidad</DialogTitle>
            <DialogDescription>Así usa la clínica los datos que nos das.</DialogDescription>
          </DialogHeader>
          <p className="max-h-[60svh] overflow-y-auto whitespace-pre-wrap text-sm">{info.config.privacyNotice}</p>
        </DialogContent>
      </Dialog>
    </form>
  )
}

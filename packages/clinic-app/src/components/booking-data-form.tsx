import {
  type ClinicalCountryProfile,
  clinicalProfileFor,
  CONTACT_RELATIONSHIP_LABELS,
  composeDisplayName,
  DOC_TYPE_LABELS,
  documentNumberError,
  type IdentityDocType,
  isMinor,
  isRealDate,
  type RegistrationAnswers,
  SEX_LABELS,
  validateRegistrationAnswers,
} from "@odentia/clinical"
import {
  Button,
  Checkbox,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  RadioGroup,
  RadioGroupItem,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@odentia/ui"
import { BirthDateInput, ErrorState, internationalText, LoadingState, PhoneInput, SubmitButton } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { type FormEvent, type InputHTMLAttributes, useEffect, useState } from "react"
import { ApiError } from "../lib/api"
import {
  type BookingRegistrationForm,
  type BookingYou,
  fetchBookingRegistrationForm,
  type MissingDatum,
  type PersonalLinkView,
  submitBookingRegistration,
} from "../lib/booking-link"
import { fetchPublicPrivacyNotice } from "../lib/patient-registration"
import { asksDocumentCountry, countryChoices } from "../lib/person-data"
import { SearchSelect } from "./settings/search-select"

type Relationship = "guardian" | "family" | "other"
const RELATIONSHIPS: readonly Relationship[] = ["guardian", "family", "other"]
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * El sexo en lo que llena la persona: «Femenino» o «Masculino». «Indeterminado»
 * es un dato clínico (un recién nacido, por ejemplo) y lo registra el equipo en
 * la ficha.
 */
export type PersonSex = "" | "F" | "M"
const SEX_OPTIONS: ReadonlyArray<readonly [Exclude<PersonSex, "">, string]> = [
  ["F", SEX_LABELS.F],
  ["M", SEX_LABELS.M],
]
/** La primera opción del sexo: recibe el foco si falta elegir. */
const FIRST_SEX = "F"
const PROMOTION_OPTIONS: ReadonlyArray<readonly ["si" | "no", string]> = [
  ["si", "Sí, quiero"],
  ["no", "No, gracias"],
]

/**
 * Pocas opciones en tarjetas, como «¿Para quién es la cita?»: un grupo de
 * radios con su leyenda, su ayuda y su error junto al grupo. Nada viene
 * elegido si `value` es null. Cada opción tiene el id `${id}-${valor}`: la
 * primera recibe el foco cuando falta elegir.
 */
export function ChoiceCards<T extends string>({
  id,
  legend,
  description,
  options,
  value,
  onChange,
  error,
  strong = false,
}: {
  id: string
  legend: string
  description?: string
  options: ReadonlyArray<readonly [T, string]>
  value: T | null
  onChange: (value: T) => void
  error?: string
  /** La pregunta es el contenido (novedades), no la etiqueta de un dato. */
  strong?: boolean
}) {
  const legendId = `${id}-legend`
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  return (
    <FieldSet className="gap-2" data-invalid={error ? true : undefined}>
      <FieldLegend id={legendId} variant="label" className={cn("mb-0", strong && "text-base font-semibold")}>
        {legend}
      </FieldLegend>
      {description ? (
        <FieldDescription id={hintId} className="-mt-1">
          {description}
        </FieldDescription>
      ) : null}
      <RadioGroup
        aria-labelledby={legendId}
        aria-describedby={[description ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined}
        value={value}
        onValueChange={(next) => {
          if (typeof next === "string") onChange(next as T)
        }}
        className="grid-cols-2"
      >
        {options.map(([option, label]) => (
          <label
            key={option}
            htmlFor={`${id}-${option}`}
            className="flex min-h-11 min-w-0 cursor-pointer items-center gap-2 rounded-xl border bg-card px-3 py-2 text-sm font-medium has-[[data-checked]]:border-primary has-[[data-checked]]:bg-primary-soft has-[[data-checked]]:text-primary-soft-foreground"
          >
            <RadioGroupItem id={`${id}-${option}`} value={option} aria-invalid={error ? true : undefined} />
            {label}
          </label>
        ))}
      </RadioGroup>
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </FieldSet>
  )
}

/**
 * «¿Quieres recibir novedades y promociones…?»: se responde una sola vez, en
 * todo camino donde aún no respondió. Nunca viene marcada: así no valdría.
 * «Sí, quiero» va primero.
 */
export function PromotionsQuestion({
  id,
  clinicName,
  value,
  onChange,
  error,
}: {
  id: string
  clinicName: string
  value: boolean | null
  onChange: (accepts: boolean) => void
  error?: string
}) {
  return (
    <ChoiceCards
      id={id}
      strong
      legend={`¿Quieres recibir novedades y promociones de ${clinicName} por WhatsApp?`}
      description={`Descuentos y campañas de ${clinicName}. Puedes darte de baja cuando quieras.`}
      options={PROMOTION_OPTIONS}
      value={value === null ? null : value ? "si" : "no"}
      onChange={(next) => onChange(next === "si")}
      error={error}
    />
  )
}

/** El control de las novedades que recibe el foco si falta responder. */
export const promotionsFocusId = (id: string) => `${id}-si`

/**
 * «Acepto el aviso de privacidad de…», obligatoria, con «Ver el aviso de
 * privacidad». Quien ya es paciente no trae el aviso en su enlace: se lee el
 * vigente de la clínica al abrirlo.
 */
export function PrivacyCheck({
  id,
  slug,
  clinicName,
  notice,
  checked,
  onChange,
  error,
}: {
  id: string
  slug: string
  clinicName: string
  /** El texto del aviso, si ya llegó con el formulario. */
  notice?: string
  checked: boolean
  onChange: (accepted: boolean) => void
  error?: string
}) {
  const [open, setOpen] = useState(false)
  const fetched = useQuery({
    queryKey: ["public-privacy-notice", slug],
    queryFn: () => fetchPublicPrivacyNotice(slug),
    enabled: open && notice === undefined,
    retry: false,
    staleTime: 5 * 60_000,
  })
  const text = notice ?? fetched.data?.data.notice
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start gap-3">
        <Checkbox
          id={id}
          className="mt-3.5"
          checked={checked}
          onCheckedChange={(next) => onChange(next === true)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
        />
        <div className="flex min-w-0 flex-col items-start">
          <label htmlFor={id} className="flex min-h-11 cursor-pointer items-center text-sm">
            Acepto el aviso de privacidad de {clinicName}.
          </label>
          <Button type="button" variant="link" className="h-auto min-h-11 p-0 text-sm" onClick={() => setOpen(true)}>
            Ver el aviso de privacidad
          </Button>
        </div>
      </div>
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Aviso de privacidad</DialogTitle>
            <DialogDescription>Así usa {clinicName} los datos que nos das.</DialogDescription>
          </DialogHeader>
          <ScrollArea className="flex max-h-[60svh] flex-col">
            {text ? (
              <p className="whitespace-pre-wrap text-sm">{text}</p>
            ) : fetched.isError ? (
              <p role="alert" className="text-sm text-destructive">
                No pudimos abrir el aviso. Vuelve a intentarlo en un momento.
              </p>
            ) : (
              <LoadingState kind="indeterminate" message="Abriendo el aviso…" />
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** El tipo elegido o, sin elegir, el primero de los que se usan en el país de la clínica. */
const docTypeOf = (profile: ClinicalCountryProfile, docType: IdentityDocType | ""): IdentityDocType =>
  docType || profile.documentTypes[0]!.code

/** Tipo y número de documento (y el país que lo emitió, solo si hace falta: `asksDocumentCountry`). */
function DocumentFields({
  idOf,
  profile,
  docType: chosenType,
  docNumber,
  docCountry,
  numberError,
  countryError,
  onChange,
}: {
  idOf: (part: "docType" | "docNumber" | "docCountry") => string
  profile: ClinicalCountryProfile
  docType: IdentityDocType | ""
  docNumber: string
  docCountry: string
  numberError: string | undefined
  countryError: string | undefined
  onChange: (patch: { docType?: IdentityDocType; docNumber?: string; docCountry?: string }) => void
}) {
  const typeId = idOf("docType")
  const numberId = idOf("docNumber")
  const countryId = idOf("docCountry")
  const docType = docTypeOf(profile, chosenType)
  return (
    <>
      <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-2 gap-y-3">
        <Field>
          <FieldLabel htmlFor={typeId}>Documento</FieldLabel>
          <Select<IdentityDocType>
            value={docType}
            onValueChange={(next) => {
              if (next) onChange({ docType: next, docCountry: "" })
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
        <Field data-invalid={numberError ? true : undefined}>
          <FieldLabel htmlFor={numberId}>Número</FieldLabel>
          <Input
            id={numberId}
            className="min-h-11"
            autoComplete="off"
            maxLength={20}
            value={docNumber}
            onChange={(event) => onChange({ docNumber: event.target.value })}
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
      {asksDocumentCountry(profile, docType) ? (
        <Field data-invalid={countryError ? true : undefined}>
          <FieldLabel htmlFor={countryId}>País que emitió el documento</FieldLabel>
          <SearchSelect
            id={countryId}
            label="País que emitió el documento"
            placeholder="Buscar país…"
            value={docCountry}
            options={countryChoices(profile.country)}
            invalid={Boolean(countryError)}
            aria-describedby={countryError ? `${countryId}-error` : undefined}
            onChange={(next) => onChange({ docCountry: next })}
          />
          {countryError ? <FieldError id={`${countryId}-error`}>{countryError}</FieldError> : null}
        </Field>
      ) : null}
    </>
  )
}

function TextField({
  id,
  label,
  value,
  onChange,
  error,
  hint,
  ...input
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  error: string | undefined
  hint?: string
} & Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "value" | "onChange">) {
  return (
    <Field data-invalid={error ? true : undefined}>
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

function BirthDateField({
  id,
  today,
  countryCode,
  value,
  error,
  hint,
  onChange,
}: {
  id: string
  today: string
  countryCode: string | null
  value: string
  error: string | undefined
  hint?: string
  onChange: (value: string) => void
}) {
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>Fecha de nacimiento</FieldLabel>
      {/* El mismo control del registro de pacientes: una fecha de nacimiento se escribe, en el orden de la clínica. */}
      <BirthDateInput
        id={id}
        className="[&_input]:min-h-11"
        today={today}
        country={countryCode}
        value={value}
        invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        onChange={onChange}
      />
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : hint ? <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription> : null}
    </Field>
  )
}

/** Nombre, documento y lo demás que se pide de una persona. */
interface PersonDraft {
  givenNames: string
  /** Los apellidos juntos, en un solo campo (ADR 0058). */
  familyName: string
  /** Vacío mientras no se elija: vale el primero de los que se usan en el país de la clínica. */
  docType: IdentityDocType | ""
  docNumber: string
  docCountry: string
  birthDate: string
  sex: PersonSex
  email: string
}

/** Lo escrito en «Revisa y reserva». Vive en la página para no perderse al cambiar de horario ni si el envío falla. */
export interface BookingDataDraft {
  /** Ya se escribió lo que sabíamos de quien escribe (una sola vez: lo que corrija manda). */
  known: boolean
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
  relationship: Relationship
  /** Novedades y promociones: null mientras no responda. */
  promotions: boolean | null
  privacyAccepted: boolean
}

const emptyPerson = (): PersonDraft => ({ givenNames: "", familyName: "", docType: "", docNumber: "", docCountry: "", birthDate: "", sex: "", email: "" })

export function emptyBookingDataDraft(): BookingDataDraft {
  return {
    known: false,
    me: emptyPerson(),
    phone: null,
    phoneTouched: false,
    phoneIncomplete: false,
    who: "patient",
    other: emptyPerson(),
    relationship: "family",
    promotions: null,
    privacyAccepted: false,
  }
}

/** Lo que ya sabemos de quien escribe, escrito en lo que aún esté en blanco. Todo se puede corregir. */
function withKnown(draft: BookingDataDraft, info: BookingRegistrationForm): BookingDataDraft {
  const profile = clinicalProfileFor(info.countryCode)
  const known = info.known
  const knownType = profile.documentTypes.some(({ code }) => code === known.docType) ? (known.docType as IdentityDocType) : null
  const me = draft.me
  // El número solo con un tipo que se usa en el país de la clínica, o sin tipo (vale el primero).
  const document: Partial<PersonDraft> =
    !me.docNumber && known.docNumber && (knownType || !known.docType) ? { docType: me.docType || knownType || "", docNumber: known.docNumber } : {}
  return {
    ...draft,
    known: true,
    me: {
      ...me,
      givenNames: me.givenNames || known.givenNames || "",
      familyName: me.familyName || known.familyName || "",
      ...document,
      birthDate: me.birthDate || (known.birthDate && isRealDate(known.birthDate) ? known.birthDate : ""),
      sex: me.sex || (known.sex === "F" || known.sex === "M" ? known.sex : ""),
      email: me.email || known.email || "",
    },
  }
}

type PersonField = "givenNames" | "familyName" | "docNumber" | "docCountry" | "birthDate" | "sex" | "email"
type FieldKey = `me.${PersonField}` | `other.${PersonField}` | "phone" | "relationship" | "promotions" | "privacyAccepted"
/** En el orden de la pantalla: el primero con error recibe el foco. */
const FIELD_ORDER: readonly FieldKey[] = [
  "me.givenNames",
  "me.familyName",
  "me.docNumber",
  "me.docCountry",
  "me.birthDate",
  "me.sex",
  "me.email",
  "phone",
  "other.givenNames",
  "other.familyName",
  "other.docNumber",
  "other.docCountry",
  "other.birthDate",
  "other.sex",
  "relationship",
  "promotions",
  "privacyAccepted",
]
type Errors = Partial<Record<FieldKey, string>>
const fieldId = (key: string) => `reserva-datos-${key.replace(".", "-")}`
/** Lo que recibe el foco: el campo o, en las tarjetas, su primera opción. */
const focusId = (key: FieldKey) =>
  key.endsWith(".sex") ? `${fieldId(key)}-${FIRST_SEX}` : key === "promotions" ? promotionsFocusId(fieldId(key)) : fieldId(key)
const asksCountry = (profile: ClinicalCountryProfile, person: PersonDraft) => asksDocumentCountry(profile, docTypeOf(profile, person.docType))

/**
 * Las respuestas del registro de pacientes que salen de este formulario: lo
 * que la clínica necesita para reservar. Si la cita es para otra persona, ella
 * es la paciente y quien escribe queda como su responsable, con su celular.
 */
function buildAnswers(
  profile: ClinicalCountryProfile,
  draft: BookingDataDraft,
  phone: string | null,
  minor: boolean,
  asks: { sex: boolean; email: boolean; promotions: boolean },
): RegistrationAnswers {
  const forOther = draft.who === "representative"
  const patient = forOther ? draft.other : draft.me
  const givenNames = patient.givenNames.trim()
  const familyName = patient.familyName.trim().replace(/\s+/g, " ")
  const myDocNumber = draft.me.docNumber.trim()
  const email = draft.me.email.trim()
  return {
    demographics: {
      displayName: composeDisplayName({ givenNames, familyName }),
      givenNames,
      familyName,
      docType: docTypeOf(profile, patient.docType),
      docNumber: patient.docNumber.trim(),
      ...(asksCountry(profile, patient) && patient.docCountry ? { docCountry: patient.docCountry } : {}),
      ...(patient.birthDate ? { birthDate: patient.birthDate } : {}),
      ...(asks.sex && patient.sex ? { sex: patient.sex } : {}),
      ...(!forOther && asks.email && email ? { email } : {}),
      ...(forOther ? {} : { phone: phone ?? "" }),
    },
    respondent: forOther ? "representative" : "patient",
    ...(forOther
      ? {
          representative: {
            displayName: composeDisplayName({
              givenNames: draft.me.givenNames.trim(),
              familyName: draft.me.familyName.trim(),
            }),
            relationship: minor ? "guardian" : draft.relationship,
            relationshipDetail: "",
            ...(phone ? { phone } : {}),
            ...(myDocNumber
              ? {
                  docType: docTypeOf(profile, draft.me.docType),
                  docNumber: myDocNumber,
                  ...(asksCountry(profile, draft.me) && draft.me.docCountry ? { docCountry: draft.me.docCountry } : {}),
                }
              : {}),
          },
        }
      : {}),
    privacyAccepted: draft.privacyAccepted,
    // Se le dijo que le escribiremos por WhatsApp sobre su cita: queda guardado.
    acceptsReminders: true,
    ...(asks.promotions && draft.promotions !== null ? { acceptsMessages: draft.promotions } : {}),
  }
}

/** Nombres, apellidos, documento y, si se piden, fecha de nacimiento, sexo y correo de una persona. */
function PersonFields({
  scope,
  profile,
  person,
  errors,
  mine,
  asks,
  today,
  countryCode,
  nameHint,
  birthHint,
  onChange,
}: {
  scope: "me" | "other"
  profile: ClinicalCountryProfile
  person: PersonDraft
  errors: Errors
  /** Los datos son de quien escribe: el navegador puede proponerlos. */
  mine: boolean
  asks: { birthDate: boolean; sex: boolean; email: boolean }
  today: string
  countryCode: string | null
  /** De dónde salió el nombre que ya viene escrito. */
  nameHint?: string
  birthHint?: string
  onChange: (patch: Partial<PersonDraft>, ...cleared: PersonField[]) => void
}) {
  return (
    <>
      <TextField
        id={fieldId(`${scope}.givenNames`)}
        label="Nombres"
        autoComplete={mine ? "given-name" : "off"}
        maxLength={100}
        value={person.givenNames}
        error={errors[`${scope}.givenNames`]}
        onChange={(givenNames) => onChange({ givenNames }, "givenNames")}
      />
      <TextField
        id={fieldId(`${scope}.familyName`)}
        label="Apellidos"
        autoComplete={mine ? "family-name" : "off"}
        maxLength={200}
        value={person.familyName}
        error={errors[`${scope}.familyName`]}
        hint={nameHint}
        onChange={(familyName) => onChange({ familyName }, "familyName")}
      />
      <DocumentFields
        idOf={(part) => fieldId(`${scope}.${part}`)}
        profile={profile}
        docType={person.docType}
        docNumber={person.docNumber}
        docCountry={person.docCountry}
        numberError={errors[`${scope}.docNumber`]}
        countryError={errors[`${scope}.docCountry`]}
        onChange={(patch) => onChange(patch, "docNumber", "docCountry")}
      />
      {asks.birthDate ? (
        <BirthDateField
          id={fieldId(`${scope}.birthDate`)}
          today={today}
          countryCode={countryCode}
          value={person.birthDate}
          error={errors[`${scope}.birthDate`]}
          hint={birthHint}
          onChange={(birthDate) => onChange({ birthDate }, "birthDate")}
        />
      ) : null}
      {asks.sex ? (
        <ChoiceCards
          id={fieldId(`${scope}.sex`)}
          legend="Sexo"
          options={SEX_OPTIONS}
          value={person.sex || null}
          error={errors[`${scope}.sex`]}
          onChange={(sex) => onChange({ sex }, "sex")}
        />
      ) : null}
      {asks.email ? (
        <TextField
          id={fieldId(`${scope}.email`)}
          label="Correo"
          type="email"
          inputMode="email"
          placeholder="nombre@correo.com"
          autoComplete={mine ? "email" : "off"}
          maxLength={200}
          value={person.email}
          error={errors[`${scope}.email`]}
          onChange={(email) => onChange({ email }, "email")}
        />
      ) : null}
    </>
  )
}

/**
 * «Revisa y reserva» de quien aún no es paciente: lo que la clínica necesita
 * para atenderla, en una sola pantalla y una sola vez. Lo que ya sabemos viene
 * escrito y se puede corregir. No decide nada del registro: arma las
 * respuestas del registro de pacientes con su alcance «datos esenciales», las
 * valida con las reglas compartidas y las envía; la ficha, el consentimiento y
 * la identidad los resuelve el servidor. Lo demás que pide la clínica, «Tus
 * datos» lo pide justo después de reservar.
 */
export function BookingDataForm({
  slug,
  token,
  clinicName,
  submissionId,
  draft,
  onDraftChange,
  reserving,
  onRegistered,
}: {
  slug: string
  token: string
  clinicName: string
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
  const infoKey = ["booking-registration", slug, token]
  const infoQuery = useQuery({
    queryKey: infoKey,
    queryFn: () => fetchBookingRegistrationForm(slug, token),
    retry: false,
    staleTime: 30_000,
  })
  const loaded = infoQuery.data?.data
  // Lo que ya sabemos se escribe una sola vez, al llegar: después manda lo que la persona corrija.
  // biome-ignore lint/correctness/useExhaustiveDependencies: solo cuando llegan los datos o se reinicia el borrador.
  useEffect(() => {
    if (loaded && !draft.known) onDraftChange(withKnown(draft, loaded))
  }, [loaded, draft.known])

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
  const patientScope = forOther ? "other" : "me"
  const minor = forOther && isRealDate(draft.other.birthDate) && isMinor(draft.other.birthDate, info.today)
  // El celular solo se propone si el sistema lo conoce de verdad; lo que la persona escriba manda.
  const phone = draft.phoneTouched ? draft.phone : (draft.phone ?? info.phone)
  const busy = submitting || reserving
  // Lo que la clínica marca «Obligatorio» de lo que esta pantalla pide; del correo de otra persona responde tu celular.
  const asks = {
    sex: info.config.fields.sex === "required",
    email: info.config.fields.email === "required",
    promotions: info.asksPromotions,
  }
  const nameHint =
    info.known.from === "conversacion"
      ? "Lo tomamos de nuestra conversación. Corrígelo si hace falta."
      : info.known.from === "perfil"
        ? "Lo tomamos de tu WhatsApp. Corrígelo si hace falta."
        : undefined

  const set = (patch: Partial<BookingDataDraft>, ...cleared: FieldKey[]) => {
    onDraftChange({ ...draft, ...patch })
    if (cleared.some((key) => errors[key])) {
      const next = { ...errors }
      for (const key of cleared) delete next[key]
      setErrors(next)
    }
  }

  /**
   * Las reglas son las del registro de pacientes; aquí solo se reparten por
   * campo y se dicen con las palabras de la pantalla. Lo que la regla rechaza
   * y esta pantalla no sabe ubicar se dice al pie, sin enviar.
   */
  const validate = (answers: RegistrationAnswers): { errors: Errors; loose: string | null } => {
    const found = validateRegistrationAnswers(info.config, answers, { mode: "public", today: info.today, scope: "essentials", countryCode: info.countryCode })
    const next: Errors = {}
    const used = new Set<string>()
    const put = (key: FieldKey, message: string | undefined) => {
      if (message && !next[key]) next[key] = message
    }
    const take = (key: FieldKey, ...sources: string[]) => {
      for (const source of sources) {
        if (!found[source]) continue
        used.add(source)
        put(key, found[source])
      }
    }
    const patient = draft[patientScope]
    if (!draft.me.givenNames.trim()) put("me.givenNames", "Escribe tus nombres")
    if (!draft.me.familyName.trim()) put("me.familyName", "Escribe tus apellidos")
    if (forOther) {
      if (!draft.other.givenNames.trim()) put("other.givenNames", "Escribe sus nombres")
      if (!draft.other.familyName.trim()) put("other.familyName", "Escribe sus apellidos")
      // De quien escribe, el registro solo exige el documento si representa a un menor.
      take("me.docNumber", "representative.docNumber", "representative.docType")
      take("relationship", "representative.relationship")
    }
    if (!patient.docNumber.trim()) put(`${patientScope}.docNumber`, "Escribe el número de documento")
    if (!patient.birthDate) put(`${patientScope}.birthDate`, forOther ? "Escribe su fecha de nacimiento" : "Escribe tu fecha de nacimiento")
    else if (!isRealDate(patient.birthDate)) put(`${patientScope}.birthDate`, "Revisa la fecha: escribe día, mes y año")
    // Quien reserva para sí y es menor de edad: la reserva su madre, padre o tutor.
    if (found.respondent) {
      used.add("respondent")
      put("me.birthDate", "Eres menor de edad: tu cita la reserva tu madre, padre o tutor, con «Para otra persona».")
    }
    if (asks.sex && !patient.sex) put(`${patientScope}.sex`, "Elige una opción")
    if (!forOther && asks.email) {
      const email = draft.me.email.trim()
      if (!email) put("me.email", "Escribe tu correo")
      else if (!EMAIL.test(email)) put("me.email", "Escribe el correo completo, como nombre@correo.com")
    }
    take(`${patientScope}.givenNames`, "demographics.givenNames", "demographics.displayName")
    take(`${patientScope}.familyName`, "demographics.familyName")
    take(`${patientScope}.docNumber`, "demographics.docNumber", "demographics.docType")
    take(`${patientScope}.docCountry`, "demographics.docCountry")
    take(`${patientScope}.birthDate`, "demographics.birthDate")
    take(`${patientScope}.sex`, "demographics.sex")
    if (!forOther) take("me.email", "demographics.email")
    if (draft.phoneIncomplete) put("phone", "Revisa el celular: está incompleto")
    if (!phone) put("phone", "Escribe un celular para avisarte de tu cita")
    take("phone", "demographics.phone", "representative.phone")
    if (asks.promotions && draft.promotions === null) put("promotions", "Elige una opción")
    used.add("privacyAccepted")
    if (!draft.privacyAccepted) put("privacyAccepted", "Para reservar necesitamos que aceptes el aviso de privacidad")
    const loose = Object.entries(found).find(([key]) => !used.has(key))?.[1] ?? null
    return { errors: next, loose }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    const answers = buildAnswers(profile, draft, phone, minor, asks)
    const found = validate(answers)
    setErrors(found.errors)
    setSubmitError(null)
    const first = FIELD_ORDER.find((key) => found.errors[key])
    if (first) {
      document.getElementById(focusId(first))?.focus()
      return
    }
    if (found.loose) {
      setSubmitError(found.loose)
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
        setSubmitError(`${clinicName} actualizó su aviso de privacidad. Revísalo y vuelve a tocar «Reservar mi cita».`)
      } else if (shape?.message) {
        setSubmitError(shape.message)
      } else {
        setSubmitError("No pudimos guardar tus datos. Revisa tu conexión y vuelve a intentarlo.")
      }
    } finally {
      setSubmitting(false)
    }
  }

  const setPerson = (scope: "me" | "other") => (patch: Partial<PersonDraft>, ...cleared: PersonField[]) => {
    const keys = cleared.map((key): FieldKey => `${scope}.${key}`)
    // De la edad de quien se atiende depende la relación y el documento de quien escribe.
    if (scope === "other" && patch.birthDate !== undefined) keys.push("relationship", "me.docNumber")
    set({ [scope]: { ...draft[scope], ...patch } }, ...keys)
  }
  const phoneId = fieldId("phone")
  const relationshipId = fieldId("relationship")
  const whatsappLine = `Te escribiremos por WhatsApp a este número sobre ${forOther ? "la" : "tu"} cita: la confirmación, los recordatorios y los cambios.`

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-4">
      <FieldGroup className="gap-4">
        <ChoiceCards
          id={fieldId("who")}
          legend="¿Para quién es la cita?"
          options={[
            ["patient", "Para mí"],
            ["representative", "Para otra persona"],
          ]}
          value={draft.who}
          onChange={(next) =>
            set(
              { who: next },
              "me.docNumber",
              "me.birthDate",
              "me.sex",
              "me.email",
              "other.givenNames",
              "other.familyName",
              "other.docNumber",
              "other.docCountry",
              "other.birthDate",
              "other.sex",
              "relationship",
            )
          }
        />

        <div className="flex flex-col gap-1">
          <h3 className="font-semibold">Tus datos</h3>
          <p className="text-sm text-muted-foreground">Revisa lo que ya tenemos y completa lo que falta.</p>
        </div>
        <PersonFields
          scope="me"
          profile={profile}
          person={draft.me}
          errors={errors}
          mine
          asks={{ birthDate: !forOther, sex: !forOther && asks.sex, email: !forOther && asks.email }}
          today={info.today}
          countryCode={info.countryCode}
          nameHint={nameHint}
          onChange={setPerson("me")}
        />

        <Field data-invalid={errors.phone ? true : undefined}>
          <FieldLabel htmlFor={phoneId}>Celular</FieldLabel>
          <PhoneInput
            id={phoneId}
            className="[&_[data-slot=input-group]]:min-h-11 [&_[data-slot=select-trigger]]:min-h-11"
            value={phone}
            invalid={Boolean(errors.phone)}
            aria-describedby={errors.phone ? `${phoneId}-error ${phoneId}-hint` : `${phoneId}-hint`}
            onChange={(next, meta) => set({ phone: next, phoneTouched: true, phoneIncomplete: meta.digits.length > 0 && next === null }, "phone")}
          />
          {errors.phone ? <FieldError id={`${phoneId}-error`}>{errors.phone}</FieldError> : null}
          {/* El aviso previo que pide WhatsApp para los mensajes de servicio (ADR 0040): queda guardado. */}
          <FieldDescription id={`${phoneId}-hint`} className="text-foreground">
            {whatsappLine}
          </FieldDescription>
        </Field>

        {forOther ? (
          <FieldSet className="gap-4 rounded-2xl border bg-card p-4">
            <FieldLegend variant="label" className="mb-0">
              La persona que se va a atender
            </FieldLegend>
            <PersonFields
              scope="other"
              profile={profile}
              person={draft.other}
              errors={errors}
              mine={false}
              asks={{ birthDate: true, sex: asks.sex, email: false }}
              today={info.today}
              countryCode={info.countryCode}
              birthHint="Si es menor de edad, quedas como su responsable."
              onChange={setPerson("other")}
            />
            <Field data-invalid={errors.relationship ? true : undefined}>
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

        {asks.promotions ? (
          <PromotionsQuestion
            id={fieldId("promotions")}
            clinicName={clinicName}
            value={draft.promotions}
            error={errors.promotions}
            onChange={(promotions) => set({ promotions }, "promotions")}
          />
        ) : null}

        <PrivacyCheck
          id={fieldId("privacyAccepted")}
          slug={slug}
          clinicName={clinicName}
          notice={info.config.privacyNotice}
          checked={draft.privacyAccepted}
          error={errors.privacyAccepted}
          onChange={(privacyAccepted) => set({ privacyAccepted }, "privacyAccepted")}
        />
      </FieldGroup>

      {/* En teléfono el botón queda a la vista mientras se llena el formulario. */}
      <div className="sticky bottom-0 -mx-4 flex flex-col gap-2 border-t bg-canvas p-4 sm:static sm:mx-0 sm:border-t-0 sm:p-0">
        {submitError ? (
          <p role="alert" className="text-sm text-destructive">
            {submitError}
          </p>
        ) : null}
        <SubmitButton type="submit" className="min-h-12 w-full text-base" pending={busy}>
          Reservar mi cita
        </SubmitButton>
        <p className="text-center text-sm text-muted-foreground">Tus datos y tu cita se guardan al tocar «Reservar mi cita».</p>
      </div>
    </form>
  )
}

/** Lo que el paso de reservar sabe pedir a quien ya es paciente, de lo que le falta; lo demás lo pide «Tus datos» después. */
export type YouField = "givenNames" | "familyName" | "document" | "birthDate" | "sex" | "email" | "phone"
/** En el orden de la pantalla (el mismo de quien es nueva). */
const YOU_FIELDS: readonly YouField[] = ["givenNames", "familyName", "document", "birthDate", "sex", "email", "phone"]

export function youFieldsOf(missing: readonly MissingDatum[]): YouField[] {
  const keys = new Set(missing.map((item) => item.key))
  return YOU_FIELDS.filter((field) => (field === "document" ? keys.has("docType") || keys.has("docNumber") : keys.has(field)))
}

/** Lo que escribe en «Revisa y reserva» quien ya es paciente; vive en la página como el de quien es nueva. */
export interface YouDraft {
  givenNames: string
  familyName: string
  docType: IdentityDocType | ""
  docNumber: string
  docCountry: string
  birthDate: string
  sex: PersonSex
  email: string
  phone: string | null
  phoneIncomplete: boolean
  /** Novedades y promociones: null mientras no responda. */
  promotions: boolean | null
  privacy: boolean
}

export function emptyYouDraft(): YouDraft {
  return { givenNames: "", familyName: "", docType: "", docNumber: "", docCountry: "", birthDate: "", sex: "", email: "", phone: null, phoneIncomplete: false, promotions: null, privacy: false }
}

type YouKey = Exclude<YouField, "document"> | "docNumber" | "docCountry" | "promotions" | "privacy"
export type YouErrors = Partial<Record<YouKey, string>>
const YOU_ORDER: readonly YouKey[] = ["givenNames", "familyName", "docNumber", "docCountry", "birthDate", "sex", "email", "phone", "promotions", "privacy"]
const youId = (key: string) => `reserva-tu-${key}`
const youFocusId = (key: YouKey) => (key === "sex" ? `${youId(key)}-${FIRST_SEX}` : key === "promotions" ? promotionsFocusId(youId(key)) : youId(key))

/** Lo pendiente de quien ya es paciente: lo que falta de lo que este paso pide, y lo que aún no aceptó o respondió. */
export function checkYou(
  draft: YouDraft,
  fields: readonly YouField[],
  pending: { privacy: boolean; promotions: boolean } | null,
  profile: ClinicalCountryProfile,
): YouErrors {
  const errors: YouErrors = {}
  const asks = (field: YouField) => fields.includes(field)
  if (asks("givenNames") && !draft.givenNames.trim()) errors.givenNames = "Escribe tus nombres"
  if (asks("familyName") && !draft.familyName.trim()) errors.familyName = "Escribe tus apellidos"
  if (asks("document")) {
    const docType = docTypeOf(profile, draft.docType)
    const problem = documentNumberError(docType, draft.docNumber)
    if (!draft.docNumber.trim()) errors.docNumber = "Escribe el número de documento"
    else if (problem) errors.docNumber = problem
    if (asksDocumentCountry(profile, docType) && !draft.docCountry) errors.docCountry = "Elige el país que emitió el documento"
  }
  if (asks("birthDate")) {
    if (!draft.birthDate) errors.birthDate = "Escribe tu fecha de nacimiento"
    else if (!isRealDate(draft.birthDate)) errors.birthDate = "Revisa la fecha: escribe día, mes y año"
  }
  if (asks("sex") && !draft.sex) errors.sex = "Elige una opción"
  if (asks("email")) {
    const email = draft.email.trim()
    if (!email) errors.email = "Escribe tu correo"
    else if (!EMAIL.test(email)) errors.email = "Escribe el correo completo, como nombre@correo.com"
  }
  if (asks("phone")) {
    if (draft.phoneIncomplete) errors.phone = "Revisa el celular: está incompleto"
    else if (!draft.phone) errors.phone = "Escribe un celular para avisarte de tu cita"
  }
  if (pending?.promotions && draft.promotions === null) errors.promotions = "Elige una opción"
  if (pending?.privacy && !draft.privacy) errors.privacy = "Para reservar necesitamos que aceptes el aviso de privacidad"
  return errors
}

/** Lleva el foco al primer dato con error; dice si había alguno. */
export function focusFirstYouError(errors: YouErrors): boolean {
  const first = YOU_ORDER.find((key) => errors[key])
  if (!first) return false
  document.getElementById(youFocusId(first))?.focus()
  return true
}

/** Lo que guarda la reserva junto con la cita: lo que faltaba y lo que acepta o responde. */
export function youInput(
  draft: YouDraft,
  fields: readonly YouField[],
  pending: { privacy: boolean; promotions: boolean } | null,
  profile: ClinicalCountryProfile,
): BookingYou {
  const data: Partial<Record<string, string>> = {}
  const put = (key: string, value: string | null) => {
    if (value?.trim()) data[key] = value.trim()
  }
  if (fields.includes("givenNames")) put("givenNames", draft.givenNames)
  if (fields.includes("familyName")) put("familyName", draft.familyName.replace(/\s+/g, " "))
  if (fields.includes("document")) {
    const docType = docTypeOf(profile, draft.docType)
    put("docType", docType)
    put("docNumber", draft.docNumber)
    if (asksDocumentCountry(profile, docType)) put("docCountry", draft.docCountry)
  }
  if (fields.includes("birthDate")) put("birthDate", draft.birthDate)
  if (fields.includes("sex")) put("sex", draft.sex)
  if (fields.includes("email")) put("email", draft.email)
  if (fields.includes("phone")) put("phone", draft.phone)
  return {
    data,
    ...(pending?.privacy ? { privacyAccepted: draft.privacy } : {}),
    ...(pending?.promotions && draft.promotions !== null ? { acceptsPromotions: draft.promotions } : {}),
  }
}

/**
 * «Revisa y reserva» de quien ya es paciente: lo que ya sabemos (el documento
 * abreviado; no se editan datos guardados desde el enlace, que prueba que
 * tiene su chat, no quién es), lo que le falta de lo que este paso sabe pedir,
 * los mensajes de su cita y, si aún no respondió o no aceptó, las novedades y
 * el aviso de privacidad. Se guarda con la cita, al tocar «Reservar mi cita».
 */
export function YouReview({
  you,
  fields,
  pending,
  draft,
  errors,
  onChange,
  profile,
  today,
  countryCode,
  clinicName,
  slug,
}: {
  you: NonNullable<PersonalLinkView["you"]>
  fields: readonly YouField[]
  pending: { privacy: boolean; promotions: boolean } | null
  draft: YouDraft
  errors: YouErrors
  /** Lo que cambió y los errores que deja de tener. */
  onChange: (patch: Partial<YouDraft>, ...cleared: YouKey[]) => void
  profile: ClinicalCountryProfile
  today: string
  countryCode: string | null
  clinicName: string
  slug: string
}) {
  const phoneShown = you.phone ? internationalText(you.phone) : null
  const asks = (field: YouField) => fields.includes(field)
  const whatsappLine = asks("phone")
    ? "Te escribiremos por WhatsApp a este número sobre esta cita: la confirmación, los recordatorios y los cambios."
    : `Te escribiremos por WhatsApp ${phoneShown ? `al ${phoneShown}` : "a tu número"} sobre esta cita: la confirmación, los recordatorios y los cambios.`
  return (
    <FieldGroup className="gap-4">
      <section aria-label="Tus datos" className="flex flex-col gap-1 rounded-2xl border bg-card px-4 py-3.5">
        <h3 className="text-sm font-semibold text-muted-foreground">Tus datos</h3>
        <p className="font-semibold">{you.name}</p>
        {you.document || phoneShown ? <p className="text-sm text-muted-foreground">{[you.document, phoneShown].filter(Boolean).join(" · ")}</p> : null}
      </section>

      {fields.length > 0 ? (
        <FieldSet className="gap-4">
          <FieldLegend variant="label" className="mb-0 text-base font-semibold">
            {fields.length === 1 ? "Nos falta un dato:" : `Nos faltan ${fields.length} datos:`}
          </FieldLegend>
          {asks("givenNames") ? (
            <TextField
              id={youId("givenNames")}
              label="Nombres"
              autoComplete="given-name"
              maxLength={100}
              value={draft.givenNames}
              error={errors.givenNames}
              onChange={(givenNames) => onChange({ givenNames }, "givenNames")}
            />
          ) : null}
          {asks("familyName") ? (
            <TextField
              id={youId("familyName")}
              label="Apellidos"
              autoComplete="family-name"
              maxLength={200}
              value={draft.familyName}
              error={errors.familyName}
              onChange={(familyName) => onChange({ familyName }, "familyName")}
            />
          ) : null}
          {asks("document") ? (
            <DocumentFields
              idOf={(part) => youId(part)}
              profile={profile}
              docType={draft.docType}
              docNumber={draft.docNumber}
              docCountry={draft.docCountry}
              numberError={errors.docNumber}
              countryError={errors.docCountry}
              onChange={(patch) => onChange(patch, "docNumber", "docCountry")}
            />
          ) : null}
          {asks("birthDate") ? (
            <BirthDateField
              id={youId("birthDate")}
              today={today}
              countryCode={countryCode}
              value={draft.birthDate}
              error={errors.birthDate}
              onChange={(birthDate) => onChange({ birthDate }, "birthDate")}
            />
          ) : null}
          {asks("sex") ? (
            <ChoiceCards
              id={youId("sex")}
              legend="Sexo"
              options={SEX_OPTIONS}
              value={draft.sex || null}
              error={errors.sex}
              onChange={(sex) => onChange({ sex }, "sex")}
            />
          ) : null}
          {asks("email") ? (
            <TextField
              id={youId("email")}
              label="Correo"
              type="email"
              inputMode="email"
              placeholder="nombre@correo.com"
              autoComplete="email"
              maxLength={200}
              value={draft.email}
              error={errors.email}
              onChange={(email) => onChange({ email }, "email")}
            />
          ) : null}
          {asks("phone") ? (
            <Field data-invalid={errors.phone ? true : undefined}>
              <FieldLabel htmlFor={youId("phone")}>Celular</FieldLabel>
              <PhoneInput
                id={youId("phone")}
                className="[&_[data-slot=input-group]]:min-h-11 [&_[data-slot=select-trigger]]:min-h-11"
                value={draft.phone}
                invalid={Boolean(errors.phone)}
                aria-describedby={errors.phone ? `${youId("phone")}-error` : undefined}
                onChange={(next, meta) => onChange({ phone: next, phoneIncomplete: meta.digits.length > 0 && next === null }, "phone")}
              />
              {errors.phone ? <FieldError id={`${youId("phone")}-error`}>{errors.phone}</FieldError> : null}
            </Field>
          ) : null}
        </FieldSet>
      ) : null}

      {/* El aviso previo que pide WhatsApp para los mensajes de servicio (ADR 0040): queda guardado al reservar. */}
      <p className="text-sm">{whatsappLine}</p>

      {pending?.promotions ? (
        <PromotionsQuestion
          id={youId("promotions")}
          clinicName={clinicName}
          value={draft.promotions}
          error={errors.promotions}
          onChange={(promotions) => onChange({ promotions }, "promotions")}
        />
      ) : null}
      {pending?.privacy ? (
        <PrivacyCheck
          id={youId("privacy")}
          slug={slug}
          clinicName={clinicName}
          checked={draft.privacy}
          error={errors.privacy}
          onChange={(privacy) => onChange({ privacy }, "privacy")}
        />
      ) : null}
    </FieldGroup>
  )
}

/** La pregunta de novedades al cambiar la cita o agendar lo aceptado: su id, para el foco. */
export const youPromotionsId = youId("promotions")

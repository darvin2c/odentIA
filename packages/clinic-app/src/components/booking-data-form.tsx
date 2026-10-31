import {
  type ClinicalCountryProfile,
  CONTACT_RELATIONSHIP_LABELS,
  clinicalProfileFor,
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
import {
  BirthDateInput,
  clearSubmitErrors,
  ErrorState,
  internationalText,
  LoadingState,
  PhoneInput,
  SubmitButton,
  type SubmitOptions,
  useAppForm,
  useFieldContext,
  useFieldControl,
  useFormSurface,
  withFieldGroup,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
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
import { placeErrors } from "./patient/form-errors"
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
const PROMOTION_OPTIONS: ReadonlyArray<readonly ["si" | "no", string]> = [
  ["si", "Sí, quiero"],
  ["no", "No, gracias"],
]
const WHO_OPTIONS: ReadonlyArray<readonly ["patient" | "representative", string]> = [
  ["patient", "Para mí"],
  ["representative", "Para otra persona"],
]

/**
 * Pocas opciones en tarjetas, como «¿Para quién es la cita?»: un grupo de
 * radios con su leyenda, su ayuda y el error de su campo (`form.AppField`)
 * junto al grupo. Nada viene elegido si `value` es null. Cada opción tiene el
 * id `${id}-${valor}`.
 */
function ChoiceCards<T extends string>({
  id,
  legend,
  description,
  options,
  value,
  onChange,
  strong = false,
}: {
  id: string
  legend: string
  description?: string
  options: ReadonlyArray<readonly [T, string]>
  value: T | null
  onChange: (value: T) => void
  /** La pregunta es el contenido (novedades), no la etiqueta de un dato. */
  strong?: boolean
}) {
  const { control, errors, descriptionId, errorId } = useFieldControl({ id, hasDescription: Boolean(description) })
  const legendId = `${id}-legend`
  return (
    <FieldSet
      className="gap-2"
      data-invalid={control.invalid || undefined}
      onBlur={(event) => {
        // Se da por visitado al salir del grupo, no al pasar de una opción a otra.
        if (!event.currentTarget.contains(event.relatedTarget)) control.onBlur()
      }}
    >
      <FieldLegend id={legendId} variant="label" className={cn("mb-0", strong && "text-base font-semibold")}>
        {legend}
      </FieldLegend>
      {description ? (
        <FieldDescription id={descriptionId} className="-mt-1">
          {description}
        </FieldDescription>
      ) : null}
      <RadioGroup
        aria-labelledby={legendId}
        aria-describedby={control.describedBy}
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
            <RadioGroupItem id={`${id}-${option}`} value={option} aria-invalid={control.invalid || undefined} />
            {label}
          </label>
        ))}
      </RadioGroup>
      {control.invalid ? <FieldError id={errorId} errors={errors.map((message) => ({ message }))} /> : null}
    </FieldSet>
  )
}

/**
 * «¿Quieres recibir novedades y promociones…?»: se responde una sola vez, en
 * todo camino donde aún no respondió. Nunca viene marcada: así no valdría.
 * «Sí, quiero» va primero. Va dentro del `form.AppField` de la respuesta
 * (`boolean | null`).
 */
export function PromotionsQuestion({ id, clinicName }: { id: string; clinicName: string }) {
  const field = useFieldContext<boolean | null>()
  const value = field.state.value
  return (
    <ChoiceCards
      id={id}
      strong
      legend={`¿Quieres recibir novedades y promociones de ${clinicName} por WhatsApp?`}
      description={`Descuentos y campañas de ${clinicName}. Puedes darte de baja cuando quieras.`}
      options={PROMOTION_OPTIONS}
      value={value === null ? null : value ? "si" : "no"}
      onChange={(next) => field.handleChange(next === "si")}
    />
  )
}

/**
 * «Acepto el aviso de privacidad de…», obligatoria, con «Ver el aviso de
 * privacidad». Quien ya es paciente no trae el aviso en su enlace: se lee el
 * vigente de la clínica al abrirlo. Va dentro del `form.AppField` de la casilla.
 */
function PrivacyCheck({
  id,
  slug,
  clinicName,
  notice,
}: {
  id: string
  slug: string
  clinicName: string
  /** El texto del aviso, si ya llegó con el formulario. */
  notice?: string
}) {
  const field = useFieldContext<boolean>()
  const { control, errors, errorId } = useFieldControl({ id, hasDescription: false })
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
          id={control.id}
          className="mt-3.5"
          checked={field.state.value}
          onCheckedChange={(next) => field.handleChange(next === true)}
          onBlur={control.onBlur}
          aria-invalid={control.invalid || undefined}
          aria-describedby={control.describedBy}
        />
        <div className="flex min-w-0 flex-col items-start">
          <label htmlFor={control.id} className="flex min-h-11 cursor-pointer items-center text-sm">
            Acepto el aviso de privacidad de {clinicName}.
          </label>
          <Button type="button" variant="link" className="h-auto min-h-11 p-0 text-sm" onClick={() => setOpen(true)}>
            Ver el aviso de privacidad
          </Button>
        </div>
      </div>
      {control.invalid ? <FieldError id={errorId} errors={errors.map((message) => ({ message }))} /> : null}
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

/**
 * «Celular» con el aviso de WhatsApp debajo. Lo escrito a medias deja el
 * número vacío y lo dice `onIncomplete`; cualquier cambio quita lo que se dijo
 * del campo, también mientras el número sigue a medias.
 */
function CellField({ id, description, onIncomplete }: { id: string; description?: string; onIncomplete: (incomplete: boolean) => void }) {
  const field = useFieldContext<string | null>()
  const { control, errors, descriptionId, errorId } = useFieldControl({ id, hasDescription: Boolean(description) })
  return (
    <Field data-invalid={control.invalid || undefined}>
      <FieldLabel htmlFor={control.id}>Celular</FieldLabel>
      <PhoneInput
        id={control.id}
        name={control.name}
        className="[&_[data-slot=input-group]]:min-h-11 [&_[data-slot=select-trigger]]:min-h-11"
        value={field.state.value}
        invalid={control.invalid}
        aria-describedby={control.describedBy}
        onBlur={control.onBlur}
        onChange={(next, meta) => {
          field.handleChange(next)
          onIncomplete(meta.digits.length > 0 && next === null)
          clearSubmitErrors(field.form, (name) => name === field.name)
        }}
      />
      {control.invalid ? <FieldError id={errorId} errors={errors.map((message) => ({ message }))} /> : null}
      {/* El aviso previo que pide WhatsApp para los mensajes de servicio (ADR 0040): queda guardado. */}
      {description ? (
        <FieldDescription id={descriptionId} className="text-foreground">
          {description}
        </FieldDescription>
      ) : null}
    </Field>
  )
}

/** El número del documento: su error ocupa la fila entera, bajo el tipo y el número. */
function DocumentNumberField({ id, onChanged }: { id: string; onChanged: () => void }) {
  const field = useFieldContext<string>()
  const { control, errors, errorId } = useFieldControl({ id, hasDescription: false })
  return (
    <>
      <Field data-invalid={control.invalid || undefined}>
        <FieldLabel htmlFor={control.id}>Número</FieldLabel>
        <Input
          {...control.props}
          className="min-h-11"
          autoComplete="off"
          maxLength={20}
          value={field.state.value}
          onChange={(event) => {
            field.handleChange(event.target.value)
            onChanged()
          }}
        />
      </Field>
      {control.invalid ? <FieldError id={errorId} className="col-span-2" errors={errors.map((message) => ({ message }))} /> : null}
    </>
  )
}

/** El tipo elegido o, sin elegir, el primero de los que se usan en el país de la clínica. */
const docTypeOf = (profile: ClinicalCountryProfile, docType: IdentityDocType | ""): IdentityDocType =>
  docType || profile.documentTypes[0]!.code

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

const emptyPerson = (): PersonDraft => ({ givenNames: "", familyName: "", docType: "", docNumber: "", docCountry: "", birthDate: "", sex: "", email: "" })

/** Lo que se pide de la persona: nombres, apellidos y documento, y lo demás si hace falta. */
interface PersonAsks {
  givenNames: boolean
  familyName: boolean
  document: boolean
  birthDate: boolean
  sex: boolean
  email: boolean
}

/**
 * Nombres, apellidos, documento (con el país que lo emitió solo si hace falta:
 * `asksDocumentCountry`) y, si se piden, fecha de nacimiento, sexo y correo de
 * una persona, en el formulario de quien es nueva (`fields="me"`/`"other"`) y
 * en el de quien ya es paciente. Cambiar cualquier parte del documento quita
 * lo que se dijo del número y del país.
 */
const PersonFields = withFieldGroup({
  defaultValues: emptyPerson(),
  props: {} as {
    /** Cada campo tiene el id `${idPrefix}-${dato}`. */
    idPrefix: string
    profile: ClinicalCountryProfile
    asks: PersonAsks
    /** Los datos son de quien escribe: el navegador puede proponerlos. */
    mine: boolean
    today: string
    countryCode: string | null
    /** De dónde salió el nombre que ya viene escrito. */
    nameHint?: string
    birthHint?: string
    /** `clearSubmitErrors` del formulario que la contiene: el del grupo no tiene el tipo de un formulario cualquiera. */
    clearErrors: (which: (name: string) => boolean) => void
    /** Lo que depende de la fecha de nacimiento (la relación con un menor). */
    onBirthDateChange?: () => void
  },
  render: function PersonFieldsRender({ group, idPrefix, profile, asks, mine, today, countryCode, nameHint, birthHint, clearErrors, onBirthDateChange }) {
    const idOf = (key: keyof PersonDraft) => `${idPrefix}-${key}`
    const docType = docTypeOf(profile, useStore(group.store, (state) => state.values.docType))
    const clearDocument = () => {
      const number = group.getFormFieldName("docNumber")
      const country = group.getFormFieldName("docCountry")
      clearErrors((name) => name === number || name === country)
    }
    return (
      <>
        {asks.givenNames ? (
          <group.AppField name="givenNames">
            {(field) => (
              <field.TextField id={idOf("givenNames")} label="Nombres" inputClassName="min-h-11" autoComplete={mine ? "given-name" : "off"} maxLength={100} />
            )}
          </group.AppField>
        ) : null}
        {asks.familyName ? (
          <group.AppField name="familyName">
            {(field) => (
              <field.TextField
                id={idOf("familyName")}
                label="Apellidos"
                description={nameHint}
                inputClassName="min-h-11"
                autoComplete={mine ? "family-name" : "off"}
                maxLength={200}
              />
            )}
          </group.AppField>
        ) : null}
        {asks.document ? (
          <>
            <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-2 gap-y-3">
              <group.AppField name="docType">
                {(field) => (
                  <Field>
                    <FieldLabel htmlFor={idOf("docType")}>Documento</FieldLabel>
                    <Select<IdentityDocType>
                      value={docType}
                      onValueChange={(next) => {
                        if (!next) return
                        field.handleChange(next)
                        group.setFieldValue("docCountry", "")
                        clearDocument()
                      }}
                    >
                      <SelectTrigger id={idOf("docType")} aria-label="Tipo de documento" className="min-h-11 w-full min-w-0">
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
                )}
              </group.AppField>
              <group.AppField name="docNumber">{() => <DocumentNumberField id={idOf("docNumber")} onChanged={clearDocument} />}</group.AppField>
            </div>
            {asksDocumentCountry(profile, docType) ? (
              <group.AppField name="docCountry">
                {(field) => (
                  <field.Control id={idOf("docCountry")} label="País que emitió el documento">
                    {(control) => (
                      <SearchSelect
                        id={control.id}
                        label="País que emitió el documento"
                        placeholder="Buscar país…"
                        value={field.state.value}
                        options={countryChoices(profile.country)}
                        invalid={control.invalid}
                        aria-describedby={control.describedBy}
                        onChange={(next) => {
                          field.handleChange(next)
                          clearDocument()
                        }}
                      />
                    )}
                  </field.Control>
                )}
              </group.AppField>
            ) : null}
          </>
        ) : null}
        {asks.birthDate ? (
          <group.AppField name="birthDate">
            {(field) => (
              <field.Control id={idOf("birthDate")} label="Fecha de nacimiento" description={birthHint}>
                {(control) => (
                  // El mismo control del registro de pacientes: una fecha de nacimiento se escribe, en el orden de la clínica.
                  <BirthDateInput
                    id={control.id}
                    className="[&_input]:min-h-11"
                    today={today}
                    country={countryCode}
                    value={field.state.value}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onBlur={control.onBlur}
                    onChange={(next) => {
                      field.handleChange(next)
                      onBirthDateChange?.()
                    }}
                  />
                )}
              </field.Control>
            )}
          </group.AppField>
        ) : null}
        {asks.sex ? (
          <group.AppField name="sex">
            {(field) => (
              <ChoiceCards id={idOf("sex")} legend="Sexo" options={SEX_OPTIONS} value={field.state.value || null} onChange={(sex) => field.handleChange(sex)} />
            )}
          </group.AppField>
        ) : null}
        {asks.email ? (
          <group.AppField name="email">
            {(field) => (
              <field.TextField
                id={idOf("email")}
                label="Correo"
                type="email"
                inputMode="email"
                placeholder="nombre@correo.com"
                inputClassName="min-h-11"
                autoComplete={mine ? "email" : "off"}
                maxLength={200}
              />
            )}
          </group.AppField>
        ) : null}
      </>
    )
  },
})

/** Lo escrito en «Revisa y reserva». Vive en la página para no perderse al cambiar de horario ni si el envío falla. */
export interface BookingDataDraft {
  /** Ya se escribió lo que sabíamos de quien escribe (una sola vez: lo que corrija manda). */
  known: boolean
  /** Quien escribe y reserva. */
  me: PersonDraft
  /** Al llegar, el celular que el sistema conoce, si conoce alguno; después, lo que escriba la persona. */
  phone: string | null
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

export function emptyBookingDataDraft(): BookingDataDraft {
  return {
    known: false,
    me: emptyPerson(),
    phone: null,
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
    // El celular solo se propone si el sistema lo conoce de verdad; lo que la persona escriba manda.
    phone: draft.phone ?? info.phone,
    // Quien ya tiene su registro reserva para otra persona: no se le pregunta para quién es.
    ...(info.ownRecord ? { who: "representative" as const } : {}),
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
const fieldId = (key: string) => `reserva-datos-${key.replace(".", "-")}`
const asksCountry = (profile: ClinicalCountryProfile, person: PersonDraft) => asksDocumentCountry(profile, docTypeOf(profile, person.docType))
/** Lo que deja de valer al cambiar para quién es la cita. */
const WHO_CLEARS: Partial<Record<string, true>> = {
  "me.docNumber": true,
  "me.birthDate": true,
  "me.sex": true,
  "me.email": true,
  "other.givenNames": true,
  "other.familyName": true,
  "other.docNumber": true,
  "other.docCountry": true,
  "other.birthDate": true,
  "other.sex": true,
  relationship: true,
}

/**
 * Lo que la regla del registro señala (`demographics.familyName`), en el
 * campo de esta pantalla donde se escribió; en el orden en que se dice si dos
 * reglas señalan el mismo campo. Lo que no tiene campo aquí, nada.
 */
const RULE_SOURCES = [
  "representative.docNumber",
  "representative.docType",
  "representative.relationship",
  "demographics.givenNames",
  "demographics.displayName",
  "demographics.familyName",
  "demographics.docNumber",
  "demographics.docType",
  "demographics.docCountry",
  "demographics.birthDate",
  "demographics.sex",
  "demographics.email",
  "demographics.phone",
  "representative.phone",
] as const

function ruleField(source: string, forOther: boolean): FieldKey | undefined {
  const patient = forOther ? "other" : "me"
  switch (source) {
    // De quien escribe, el registro solo exige el documento si representa a un menor.
    case "representative.docNumber":
    case "representative.docType":
      return forOther ? "me.docNumber" : undefined
    case "representative.relationship":
      return forOther ? "relationship" : undefined
    case "demographics.givenNames":
    case "demographics.displayName":
      return `${patient}.givenNames`
    case "demographics.familyName":
      return `${patient}.familyName`
    case "demographics.docNumber":
    case "demographics.docType":
      return `${patient}.docNumber`
    case "demographics.docCountry":
      return `${patient}.docCountry`
    case "demographics.birthDate":
      return `${patient}.birthDate`
    case "demographics.sex":
      return `${patient}.sex`
    case "demographics.email":
      return forOther ? undefined : "me.email"
    case "demographics.phone":
    case "representative.phone":
      return "phone"
    default:
      return undefined
  }
}

/** Lo que rechaza el servidor por su nombre en el cuerpo (`answers.demographics.familyName`), en su campo. */
function answerField(key: string, forOther: boolean): FieldKey | undefined {
  if (!key.startsWith("answers.")) return undefined
  const source = key.slice("answers.".length)
  if (source === "privacyAccepted") return "privacyAccepted"
  if (source === "acceptsMessages") return "promotions"
  return ruleField(source, forOther)
}

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

/**
 * «Revisa y reserva» de quien aún no es paciente: lo que la clínica necesita
 * para atenderla, en una sola pantalla y una sola vez. Lo que ya sabemos viene
 * escrito y se puede corregir. No decide nada del registro: arma las
 * respuestas del registro de pacientes con su alcance «datos esenciales», las
 * valida con las reglas compartidas y las envía; la ficha, el consentimiento y
 * la identidad los resuelve el servidor. Lo demás que pide la clínica, «Tus
 * datos» lo pide justo después de reservar.
 */
export function BookingDataForm(props: {
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
  const { slug, token, reserving, onRegistered } = props
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
  return <BookingDataFields {...props} info={infoQuery.data.data} infoKey={infoKey} />
}

function BookingDataFields({
  slug,
  token,
  clinicName,
  submissionId,
  draft,
  onDraftChange,
  reserving,
  onRegistered,
  info,
  infoKey,
}: {
  slug: string
  token: string
  clinicName: string
  submissionId: string
  draft: BookingDataDraft
  onDraftChange: (next: BookingDataDraft) => void
  reserving: boolean
  onRegistered: () => void
  info: BookingRegistrationForm
  infoKey: readonly unknown[]
}) {
  const queryClient = useQueryClient()
  const profile = clinicalProfileFor(info.countryCode)
  const reserveLabel = info.ownRecord ? "Reservar la cita" : "Reservar mi cita"
  // Lo que la clínica marca «Obligatorio» de lo que esta pantalla pide; del correo de otra persona responde tu celular.
  const asks = {
    sex: info.config.fields.sex === "required",
    email: info.config.fields.email === "required",
    promotions: info.asksPromotions,
  }
  const minorOf = (value: BookingDataDraft) =>
    value.who === "representative" && isRealDate(value.other.birthDate) && isMinor(value.other.birthDate, info.today)

  /**
   * Las reglas son las del registro de pacientes; aquí solo se reparten por
   * campo y se dicen con las palabras de la pantalla. Lo que la regla rechaza
   * y esta pantalla no sabe ubicar se dice al pie, sin enviar.
   */
  const validate = (value: BookingDataDraft, answers: RegistrationAnswers): { errors: Partial<Record<FieldKey, string>>; loose: string | null } => {
    const found = validateRegistrationAnswers(info.config, answers, { mode: "public", today: info.today, scope: "essentials", countryCode: info.countryCode })
    const forOther = value.who === "representative"
    const patientScope = forOther ? "other" : "me"
    const next: Partial<Record<FieldKey, string>> = {}
    const used = new Set<string>()
    const put = (key: FieldKey, message: string | undefined) => {
      if (message && !next[key]) next[key] = message
    }
    const patient = value[patientScope]
    if (!value.me.givenNames.trim()) put("me.givenNames", "Escribe tus nombres")
    if (!value.me.familyName.trim()) put("me.familyName", "Escribe tus apellidos")
    if (forOther) {
      if (!value.other.givenNames.trim()) put("other.givenNames", "Escribe sus nombres")
      if (!value.other.familyName.trim()) put("other.familyName", "Escribe sus apellidos")
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
      const email = value.me.email.trim()
      if (!email) put("me.email", "Escribe tu correo")
      else if (!EMAIL.test(email)) put("me.email", "Escribe el correo completo, como nombre@correo.com")
    }
    if (value.phoneIncomplete) put("phone", "Revisa el celular: está incompleto")
    if (!value.phone) put("phone", "Escribe un celular para avisarte de tu cita")
    for (const source of RULE_SOURCES) {
      const key = found[source] ? ruleField(source, forOther) : undefined
      if (!key) continue
      used.add(source)
      put(key, found[source])
    }
    if (asks.promotions && value.promotions === null) put("promotions", "Elige una opción")
    used.add("privacyAccepted")
    if (!value.privacyAccepted) put("privacyAccepted", "Para reservar necesitamos que aceptes el aviso de privacidad")
    const loose = Object.entries(found).find(([key]) => !used.has(key))?.[1] ?? null
    return { errors: next, loose }
  }

  // Lo que ya sabemos se escribe una sola vez, al llegar: después manda lo que la persona corrija.
  const [initial] = useState(() => (draft.known ? draft : withKnown(draft, info)))
  const form = useAppForm({
    defaultValues: initial,
    validators: {
      onSubmit: ({ value, formApi }) => {
        const found = validate(value, buildAnswers(profile, value, value.phone, minorOf(value), asks))
        const errors = Object.fromEntries(Object.entries(found.errors).filter((entry): entry is [string, string] => !!entry[1]))
        if (Object.keys(errors).length > 0) return placeErrors(formApi, errors)
        return found.loose ? { form: found.loose, fields: {} } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      const answers = buildAnswers(profile, value, value.phone, minorOf(value), asks)
      try {
        await submitBookingRegistration(slug, { token, submissionId, formVersion: info.config.version, answers })
        onRegistered()
      } catch (error) {
        const code = error instanceof ApiError ? error.shape.code : null
        // Un envío anterior sí llegó: los datos ya están guardados y solo falta reservar.
        if (code === "BOOKING_ALREADY_PATIENT") {
          onRegistered()
          return
        }
        if (code === "FORM_CHANGED") await queryClient.invalidateQueries({ queryKey: infoKey })
        throw error
      }
    },
  })
  const values = useStore(form.store, (state) => state.values)
  // Lo escrito vive en la página: no se pierde al cambiar de horario.
  useEffect(() => onDraftChange(values), [values, onDraftChange])

  const forOther = values.who === "representative"
  const minor = minorOf(values)
  const submitOptions: SubmitOptions = {
    fieldMap: (key) => answerField(key, forOther),
    formMessage: (error) => {
      if (!(error instanceof ApiError)) return "No pudimos guardar tus datos. Revisa tu conexión y vuelve a intentarlo."
      if (error.shape.code === "FORM_CHANGED") return `${clinicName} actualizó su aviso de privacidad. Revísalo y vuelve a tocar «${reserveLabel}».`
      return error.shape.message ?? "No pudimos guardar tus datos. Revisa tu conexión y vuelve a intentarlo."
    },
  }
  const surface = useFormSurface(form, submitOptions)
  const busy = surface.isSubmitting || reserving
  // A quien ya tiene su registro, su nombre le viene de ahí: no se le dice de dónde salió.
  const nameHint = info.ownRecord
    ? undefined
    : info.known.from === "conversacion"
      ? "Lo tomamos de nuestra conversación. Corrígelo si hace falta."
      : info.known.from === "perfil"
        ? "Lo tomamos de tu WhatsApp. Corrígelo si hace falta."
        : undefined
  const whatsappLine = `Te escribiremos por WhatsApp a este número sobre ${forOther ? "la" : "tu"} cita: la confirmación, los recordatorios y los cambios.`

  return (
    <form
      onSubmit={(event) => {
        if (busy) {
          event.preventDefault()
          return
        }
        surface.onSubmit(event)
      }}
      noValidate
      className="flex flex-col gap-4"
    >
      <FieldGroup className="gap-4">
        {info.ownRecord ? (
          <p className="text-sm">Ya tienes tu registro en {clinicName}. Aquí registras a la persona que se va a atender.</p>
        ) : (
          <form.AppField name="who">
            {(field) => (
              <ChoiceCards
                id={fieldId("who")}
                legend="¿Para quién es la cita?"
                options={WHO_OPTIONS}
                value={field.state.value}
                onChange={(next) => {
                  field.handleChange(next)
                  clearSubmitErrors(form, (name) => WHO_CLEARS[name] === true)
                }}
              />
            )}
          </form.AppField>
        )}

        <div className="flex flex-col gap-1">
          <h3 className="font-semibold">Tus datos</h3>
          <p className="text-sm text-muted-foreground">Revisa lo que ya tenemos y completa lo que falta.</p>
        </div>
        <PersonFields
          form={form}
          fields="me"
          idPrefix={fieldId("me")}
          clearErrors={(which) => clearSubmitErrors(form, which)}
          profile={profile}
          asks={{ givenNames: true, familyName: true, document: true, birthDate: !forOther, sex: !forOther && asks.sex, email: !forOther && asks.email }}
          mine
          today={info.today}
          countryCode={info.countryCode}
          nameHint={nameHint}
        />

        <form.AppField name="phone">
          {() => (
            <CellField id={fieldId("phone")} description={whatsappLine} onIncomplete={(incomplete) => form.setFieldValue("phoneIncomplete", incomplete)} />
          )}
        </form.AppField>

        {forOther ? (
          <FieldSet className="gap-4 rounded-2xl border bg-card p-4">
            <FieldLegend variant="label" className="mb-0">
              La persona que se va a atender
            </FieldLegend>
            <PersonFields
              form={form}
              fields="other"
              idPrefix={fieldId("other")}
              clearErrors={(which) => clearSubmitErrors(form, which)}
              profile={profile}
              asks={{ givenNames: true, familyName: true, document: true, birthDate: true, sex: asks.sex, email: false }}
              mine={false}
              today={info.today}
              countryCode={info.countryCode}
              birthHint="Si es menor de edad, quedas como su responsable."
              // De la edad de quien se atiende depende la relación y el documento de quien escribe.
              onBirthDateChange={() => clearSubmitErrors(form, (name) => name === "relationship" || name === "me.docNumber")}
            />
            <form.AppField name="relationship">
              {(field) => (
                <field.Control
                  id={fieldId("relationship")}
                  label="Tu relación con esa persona"
                  description={minor ? "Es menor de edad: quedas como su tutor o responsable, con tu documento." : undefined}
                >
                  {(control) => (
                    <Select<Relationship>
                      value={minor ? "guardian" : field.state.value}
                      disabled={minor}
                      onValueChange={(next) => {
                        if (next) field.handleChange(next)
                      }}
                    >
                      <SelectTrigger
                        id={control.id}
                        aria-invalid={control.invalid || undefined}
                        aria-describedby={control.describedBy}
                        className="min-h-11 w-full"
                      >
                        <SelectValue>{CONTACT_RELATIONSHIP_LABELS[minor ? "guardian" : field.state.value]}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {RELATIONSHIPS.map((value) => (
                          <SelectItem key={value} value={value}>
                            {CONTACT_RELATIONSHIP_LABELS[value]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </field.Control>
              )}
            </form.AppField>
          </FieldSet>
        ) : null}

        {asks.promotions ? (
          <form.AppField name="promotions">{() => <PromotionsQuestion id={fieldId("promotions")} clinicName={clinicName} />}</form.AppField>
        ) : null}

        <form.AppField name="privacyAccepted">
          {() => <PrivacyCheck id={fieldId("privacyAccepted")} slug={slug} clinicName={clinicName} notice={info.config.privacyNotice} />}
        </form.AppField>
      </FieldGroup>

      {/* En teléfono el botón queda a la vista mientras se llena el formulario. */}
      <div className="sticky bottom-0 -mx-4 flex flex-col gap-2 border-t bg-canvas p-4 sm:static sm:mx-0 sm:border-t-0 sm:p-0">
        {surface.error ? (
          <p role="alert" className="text-sm text-destructive">
            {surface.error}
          </p>
        ) : null}
        <SubmitButton type="submit" className="min-h-12 w-full text-base" pending={busy}>
          {reserveLabel}
        </SubmitButton>
        <p className="text-center text-sm text-muted-foreground">
          {info.ownRecord ? "Sus datos y la cita se guardan al tocar «Reservar la cita»." : "Tus datos y tu cita se guardan al tocar «Reservar mi cita»."}
        </p>
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
  /** Dijo que no a novedades antes y ahora marca la casilla que se le ofrece. */
  promotionsOptIn: boolean
  privacy: boolean
  /** Corrige su nombre («Corregir»); con documento en su ficha, se le pide entero. */
  renaming: boolean
  renameWithDocument: boolean
  renameGivenNames: string
  renameFamilyName: string
  renameDocNumber: string
}

function emptyYouDraft(): YouDraft {
  return {
    givenNames: "",
    familyName: "",
    docType: "",
    docNumber: "",
    docCountry: "",
    birthDate: "",
    sex: "",
    email: "",
    phone: null,
    phoneIncomplete: false,
    promotions: null,
    promotionsOptIn: false,
    privacy: false,
    renaming: false,
    renameWithDocument: false,
    renameGivenNames: "",
    renameFamilyName: "",
    renameDocNumber: "",
  }
}

type YouKey =
  | Exclude<YouField, "document">
  | "docNumber"
  | "docCountry"
  | "promotions"
  | "privacy"
  | "renameGivenNames"
  | "renameFamilyName"
  | "renameDocNumber"
export type YouErrors = Partial<Record<YouKey, string>>
const youId = (key: string) => `reserva-tu-${key}`
/** Los datos de la persona en el formulario de quien ya es paciente: con el mismo nombre. */
const YOU_PERSON = {
  givenNames: "givenNames",
  familyName: "familyName",
  docType: "docType",
  docNumber: "docNumber",
  docCountry: "docCountry",
  birthDate: "birthDate",
  sex: "sex",
  email: "email",
} as const

/** Lo pendiente de quien ya es paciente: lo que falta de lo que este paso pide, y lo que aún no aceptó o respondió. */
export function checkYou(
  draft: YouDraft,
  fields: readonly YouField[],
  pending: PersonalLinkView["pending"],
  profile: ClinicalCountryProfile,
): YouErrors {
  const errors: YouErrors = {}
  const asks = (field: YouField) => fields.includes(field)
  if (draft.renaming) {
    if (!draft.renameGivenNames.trim()) errors.renameGivenNames = "Escribe tus nombres"
    if (!draft.renameFamilyName.trim()) errors.renameFamilyName = "Escribe tus apellidos"
    if (draft.renameWithDocument && !draft.renameDocNumber.trim()) errors.renameDocNumber = "Escribe tu documento completo"
  }
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

/**
 * El formulario de lo que escribe quien ya es paciente al reservar, cambiar o
 * agendar: vive en la página, que decide qué pide (`validate`, con
 * `checkYou`) y qué hace al enviar (`submit`, que lanza si el servidor lo
 * rechaza).
 */
export function useYouForm({ validate, submit }: { validate: (value: YouDraft) => YouErrors; submit: (value: YouDraft) => Promise<void> }) {
  const [defaultValues] = useState(emptyYouDraft)
  return useAppForm({
    defaultValues,
    validators: {
      onSubmit: ({ value, formApi }) =>
        placeErrors(formApi, Object.fromEntries(Object.entries(validate(value)).filter((entry): entry is [string, string] => !!entry[1]))),
    },
    onSubmit: ({ value }) => submit(value),
  })
}
export type YouForm = ReturnType<typeof useYouForm>

/** Lo que guarda la reserva junto con la cita: lo que faltaba y lo que acepta o responde. */
export function youInput(
  draft: YouDraft,
  fields: readonly YouField[],
  pending: PersonalLinkView["pending"],
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
    ...(pending?.promotionsOffer && draft.promotionsOptIn ? { acceptsPromotions: true } : {}),
    ...(draft.renaming
      ? {
          name: {
            givenNames: draft.renameGivenNames.trim(),
            familyName: draft.renameFamilyName.trim().replace(/\s+/g, " "),
            ...(draft.renameWithDocument ? { docNumber: draft.renameDocNumber.trim() } : {}),
          },
        }
      : {}),
  }
}

/**
 * «Revisa y reserva» de quien ya es paciente: lo que ya sabemos (el documento
 * abreviado: el enlace prueba que tiene su chat, no quién es), lo que le falta
 * de lo que este paso sabe pedir, los mensajes de su cita y, si aún no
 * respondió o no aceptó, las novedades y el aviso de privacidad. De lo
 * guardado solo corrige su nombre («Corregir»), con su documento entero si la
 * ficha lo tiene; a quien dijo que no a novedades se le ofrece la casilla. Se
 * guarda con la cita, al tocar «Reservar mi cita».
 */
export function YouReview({
  you,
  fields,
  pending,
  form,
  profile,
  today,
  countryCode,
  clinicName,
  slug,
}: {
  you: NonNullable<PersonalLinkView["you"]>
  fields: readonly YouField[]
  pending: PersonalLinkView["pending"]
  form: YouForm
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
  // Corregir el nombre solo si ya hay uno; si falta, se pide abajo como cualquier dato.
  const canRename = !asks("givenNames") && !asks("familyName")
  const renaming = useStore(form.store, (state) => state.values.renaming)
  // «DNI ••••4243» → «DNI».
  const documentName = you.document?.split(" ")[0] ?? "documento"
  const startRename = () => {
    form.setFieldValue("renameGivenNames", you.givenNames ?? you.name)
    form.setFieldValue("renameFamilyName", you.familyName ?? "")
    form.setFieldValue("renameDocNumber", "")
    form.setFieldValue("renameWithDocument", !!you.document)
    form.setFieldValue("renaming", true)
  }
  const stopRename = () => {
    form.setFieldValue("renaming", false)
    clearSubmitErrors(form, (name) => name.startsWith("rename"))
  }
  return (
    <FieldGroup className="gap-4">
      <section aria-label="Tus datos" className="flex flex-col gap-1 rounded-2xl border bg-card px-4 py-3.5">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-muted-foreground">Tus datos</h3>
          {canRename && !renaming ? (
            <Button
              type="button"
              variant="link"
              className="-my-2 h-auto min-h-11 p-0 font-semibold underline"
              aria-label="Corregir tu nombre"
              onClick={startRename}
            >
              Corregir
            </Button>
          ) : null}
        </div>
        {renaming ? (
          <FieldSet className="mt-2 gap-4">
            <FieldLegend variant="label" className="mb-0">
              Tu nombre, como en tu documento
            </FieldLegend>
            <form.AppField name="renameGivenNames">
              {(field) => <field.TextField id={youId("renameGivenNames")} label="Nombres" inputClassName="min-h-11" autoComplete="given-name" maxLength={100} />}
            </form.AppField>
            <form.AppField name="renameFamilyName">
              {(field) => <field.TextField id={youId("renameFamilyName")} label="Apellidos" inputClassName="min-h-11" autoComplete="family-name" maxLength={200} />}
            </form.AppField>
            {you.document ? (
              <form.AppField name="renameDocNumber">
                {(field) => (
                  <field.TextField
                    id={youId("renameDocNumber")}
                    label={`Tu ${documentName} completo`}
                    description={`Para confirmar que es tu ficha: termina en ${you.document?.slice(-4)}.`}
                    inputClassName="min-h-11"
                    autoComplete="off"
                    maxLength={20}
                  />
                )}
              </form.AppField>
            ) : null}
            <p className="text-sm text-muted-foreground">Se guarda con tu cita. Si esta ficha no es tuya, escríbenos por el chat.</p>
            <Button type="button" variant="link" className="h-auto min-h-11 self-start p-0" onClick={stopRename}>
              Dejar el nombre como estaba
            </Button>
          </FieldSet>
        ) : (
          <p className="font-semibold">{you.name}</p>
        )}
        {you.document || phoneShown ? <p className="text-sm text-muted-foreground">{[you.document, phoneShown].filter(Boolean).join(" · ")}</p> : null}
      </section>

      {fields.length > 0 ? (
        <FieldSet className="gap-4">
          <FieldLegend variant="label" className="mb-0 text-base font-semibold">
            {fields.length === 1 ? "Nos falta un dato:" : `Nos faltan ${fields.length} datos:`}
          </FieldLegend>
          <PersonFields
            form={form}
            fields={YOU_PERSON}
            idPrefix="reserva-tu"
            clearErrors={(which) => clearSubmitErrors(form, which)}
            profile={profile}
            asks={{
              givenNames: asks("givenNames"),
              familyName: asks("familyName"),
              document: asks("document"),
              birthDate: asks("birthDate"),
              sex: asks("sex"),
              email: asks("email"),
            }}
            mine
            today={today}
            countryCode={countryCode}
          />
          {asks("phone") ? (
            <form.AppField name="phone">
              {() => <CellField id={youId("phone")} onIncomplete={(incomplete) => form.setFieldValue("phoneIncomplete", incomplete)} />}
            </form.AppField>
          ) : null}
        </FieldSet>
      ) : null}

      {/* El aviso previo que pide WhatsApp para los mensajes de servicio (ADR 0040): queda guardado al reservar. */}
      <p className="text-sm">{whatsappLine}</p>

      {pending?.promotions ? (
        <form.AppField name="promotions">{() => <PromotionsQuestion id={youId("promotions")} clinicName={clinicName} />}</form.AppField>
      ) : null}
      {/* Dijo que no antes: se le ofrece sin marcar y sin pedirle respuesta. */}
      {pending?.promotionsOffer ? (
        <form.AppField name="promotionsOptIn">
          {(field) => (
            <field.CheckboxField
              id={youId("promotionsOptIn")}
              label={`Quiero recibir novedades y promociones de ${clinicName} por WhatsApp. Puedo darme de baja cuando quiera.`}
            />
          )}
        </form.AppField>
      ) : null}
      {pending?.privacy ? (
        <form.AppField name="privacy">{() => <PrivacyCheck id={youId("privacy")} slug={slug} clinicName={clinicName} />}</form.AppField>
      ) : null}
    </FieldGroup>
  )
}

/** La pregunta de novedades al cambiar la cita o agendar lo aceptado: su id. */
export const youPromotionsId = youId("promotions")

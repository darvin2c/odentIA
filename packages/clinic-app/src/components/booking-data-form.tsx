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
  FieldError,
  FieldLegend,
  FieldSet,
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
  ErrorState,
  isUnconfirmedSubmit,
  LoadingState,
  SubmitButton,
  useAppForm,
  useFieldContext,
  useFieldControl,
  useFormSubmit,
  useFormSubmitError,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { ApiError } from "../lib/api"
import { type BookingRegistrationForm, fetchBookingRegistrationForm, submitBookingRegistration } from "../lib/booking-link"
import { asksDocumentCountry, countryChoices } from "../lib/person-data"
import { SearchSelect } from "./settings/search-select"

type Relationship = "guardian" | "family" | "other"
const RELATIONSHIPS: readonly Relationship[] = ["guardian", "family", "other"]

/** Nombre y documento de una persona, tal como se escriben en la pantalla. */
interface PersonDraft {
  givenNames: string
  /** Los apellidos juntos, en un solo campo (ADR 0058). */
  familyName: string
  /** Vacío mientras no se elija: vale el primero de los que se usan en el país de la clínica. */
  docType: IdentityDocType | ""
  docNumber: string
  docCountry: string
}

/** Lo escrito en «Tus datos». Vive en la página para no perderse al cambiar de horario ni si el envío falla. */
export interface BookingDataDraft {
  /** Quien escribe y reserva. */
  me: PersonDraft
  /**
   * `null` sin número. Mientras el formulario no se abrió (`phoneTouched` en falso), vale el celular
   * que el sistema conoce, si conoce alguno; después, lo que la persona dejó escrito.
   */
  phone: string | null
  phoneTouched: boolean
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
  const person = (): PersonDraft => ({ givenNames: "", familyName: "", docType: "", docNumber: "", docCountry: "" })
  return {
    me: person(),
    phone: null,
    phoneTouched: false,
    who: "patient",
    other: person(),
    otherBirthDate: "",
    relationship: "family",
    privacyAccepted: false,
  }
}

type PersonField = "givenNames" | "familyName" | "docNumber" | "docCountry"
type FieldKey = `me.${PersonField}` | `other.${PersonField}` | "phone" | "otherBirthDate" | "relationship" | "privacyAccepted"
type Errors = Partial<Record<FieldKey, string>>
const fieldId = (key: string) => `reserva-datos-${key.replace(".", "-")}`

/**
 * El campo de la pantalla para cada dato que el registro de pacientes señala
 * (`answers.…` del cuerpo). La paciente es quien escribe o, si la cita es para
 * otra persona, ella; quien escribe es entonces su representante.
 */
function screenFieldOf(serverField: string, forOther: boolean): FieldKey | undefined {
  const patient = forOther ? "other" : "me"
  const fields: Record<string, FieldKey> = {
    "answers.demographics.displayName": `${patient}.givenNames`,
    "answers.demographics.givenNames": `${patient}.givenNames`,
    "answers.demographics.familyName": `${patient}.familyName`,
    "answers.demographics.docType": `${patient}.docNumber`,
    "answers.demographics.docNumber": `${patient}.docNumber`,
    "answers.demographics.docCountry": `${patient}.docCountry`,
    "answers.demographics.birthDate": "otherBirthDate",
    "answers.demographics.phone": "phone",
    "answers.representative.displayName": "me.givenNames",
    "answers.representative.docType": "me.docNumber",
    "answers.representative.docNumber": "me.docNumber",
    "answers.representative.docCountry": "me.docCountry",
    "answers.representative.relationship": "relationship",
    "answers.representative.phone": "phone",
    "answers.privacyAccepted": "privacyAccepted",
  }
  return fields[serverField]
}

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
  const familyName = patient.familyName.trim().replace(/\s+/g, " ")
  const myDocNumber = draft.me.docNumber.trim()
  return {
    demographics: {
      displayName: composeDisplayName({ givenNames, familyName }),
      givenNames,
      familyName,
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
              familyName: draft.me.familyName.trim(),
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

/** La aceptación del aviso, con «Ver el aviso de privacidad» al lado y su error debajo. */
function PrivacyCheck({ onShowNotice }: { onShowNotice: () => void }) {
  const field = useFieldContext<boolean>()
  const { control, errors, errorId } = useFieldControl({ id: fieldId("privacyAccepted"), hasDescription: false })
  return (
    <Field data-invalid={control.invalid || undefined} className="gap-1">
      <div className="flex items-start gap-3">
        <Checkbox
          id={control.id}
          name={control.name}
          className="mt-3.5"
          checked={field.state.value === true}
          onCheckedChange={(checked) => {
            field.handleChange(checked === true)
            field.handleBlur()
          }}
          aria-invalid={control.invalid || undefined}
          aria-describedby={control.describedBy}
        />
        <div className="flex min-w-0 flex-col items-start">
          <label htmlFor={control.id} className="flex min-h-11 cursor-pointer items-center text-sm">
            Acepto que la clínica use estos datos para gestionar mi cita.
          </label>
          <Button type="button" variant="link" className="h-auto min-h-11 p-0 text-sm" onClick={onShowNotice}>
            Ver el aviso de privacidad
          </Button>
        </div>
      </div>
      {control.invalid ? <FieldError id={errorId} errors={errors.map((message) => ({ message }))} /> : null}
    </Field>
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
  return (
    <BookingDataFields
      slug={slug}
      token={token}
      submissionId={submissionId}
      info={infoQuery.data.data}
      infoKey={infoKey}
      draft={draft}
      onDraftChange={onDraftChange}
      reserving={reserving}
      onRegistered={onRegistered}
    />
  )
}

/** Sin respuesta del servidor: el envío lleva su `submissionId`, así que volver a enviar no repite nada. */
const UNCONFIRMED_TEXT = "No pudimos guardar tus datos. Revisa tu conexión y vuelve a intentarlo."

/** El formulario, ya con el registro de la clínica: los valores iniciales salen del borrador de la página, una vez. */
function BookingDataFields({
  slug,
  token,
  submissionId,
  info,
  infoKey,
  draft,
  onDraftChange,
  reserving,
  onRegistered,
}: {
  slug: string
  token: string
  submissionId: string
  info: BookingRegistrationForm
  infoKey: string[]
  draft: BookingDataDraft
  onDraftChange: (next: BookingDataDraft) => void
  reserving: boolean
  onRegistered: () => void
}) {
  const queryClient = useQueryClient()
  const [noticeOpen, setNoticeOpen] = useState(false)
  const profile = clinicalProfileFor(info.countryCode)
  const minorOf = (value: BookingDataDraft) =>
    value.who === "representative" && isRealDate(value.otherBirthDate) && isMinor(value.otherBirthDate, info.today)

  /** Las reglas son las del registro de pacientes; aquí solo se reparten por campo y se dicen con las palabras de la pantalla. */
  const validate = (value: BookingDataDraft): Errors => {
    const answers = buildAnswers(profile, value, value.phone, minorOf(value))
    const found = validateRegistrationAnswers(info.config, answers, { mode: "public", today: info.today, scope: "essentials", countryCode: info.countryCode })
    const next: Errors = {}
    const put = (key: FieldKey, message: string | undefined) => {
      if (message && !next[key]) next[key] = message
    }
    const forOther = value.who === "representative"
    const patient = forOther ? "other" : "me"
    if (!value.me.givenNames.trim()) put("me.givenNames", "Escribe tus nombres")
    if (!value.me.familyName.trim()) put("me.familyName", "Escribe tus apellidos")
    if (forOther) {
      if (!value.other.givenNames.trim()) put("other.givenNames", "Escribe sus nombres")
      if (!value.other.familyName.trim()) put("other.familyName", "Escribe sus apellidos")
      if (!value.otherBirthDate) put("otherBirthDate", "Indica su fecha de nacimiento")
      // De quien escribe, el registro solo exige el documento si representa a un menor.
      put("me.docNumber", found["representative.docNumber"] ?? found["representative.docType"])
      put("me.docCountry", found["representative.docCountry"])
      put("relationship", found["representative.relationship"])
    }
    if (!value[patient].docNumber.trim()) put(`${patient}.docNumber`, "Escribe el número de documento")
    put(`${patient}.givenNames`, found["demographics.givenNames"])
    put(`${patient}.familyName`, found["demographics.familyName"])
    put(`${patient}.docNumber`, found["demographics.docNumber"] ?? found["demographics.docType"])
    put(`${patient}.docCountry`, found["demographics.docCountry"])
    put("otherBirthDate", found["demographics.birthDate"])
    if (!value.phone) put("phone", "Escribe un celular para avisarte de tu cita")
    put("phone", found["demographics.phone"] ?? found["representative.phone"])
    if (!value.privacyAccepted) put("privacyAccepted", "Para reservar necesitamos que aceptes el uso de estos datos")
    return next
  }

  const form = useAppForm({
    // El celular que el sistema conoce se propone una vez, al abrir; lo que la persona escriba manda.
    defaultValues: { ...draft, phone: draft.phoneTouched ? draft.phone : (draft.phone ?? info.phone), phoneTouched: true } as BookingDataDraft,
    validators: {
      onSubmit: ({ value }) => {
        const fields = validate(value)
        return Object.keys(fields).length > 0 ? { fields } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      const answers = buildAnswers(profile, value, value.phone, minorOf(value))
      try {
        await submitBookingRegistration(slug, { token, submissionId, formVersion: info.config.version, answers })
      } catch (error) {
        const code = error instanceof ApiError ? error.shape.code : undefined
        // Un envío anterior sí llegó: los datos ya están guardados y solo falta reservar.
        if (code !== "BOOKING_ALREADY_PATIENT") {
          if (code === "FORM_CHANGED") {
            await queryClient.invalidateQueries({ queryKey: infoKey })
            throw new Error("La clínica actualizó su aviso de privacidad. Revísalo y vuelve a enviar.")
          }
          // Lo que el registro señala cae en su campo; un documento ya registrado se dice neutro, junto al botón.
          throw error
        }
      }
      onRegistered()
    },
  })
  const values = useStore(form.store, (state) => state.values)
  const submitting = useStore(form.store, (state) => state.isSubmitting)
  const submitError = useFormSubmitError(form)
  const submit = useFormSubmit(form, {
    fieldMap: (serverField) => screenFieldOf(serverField, form.state.values.who === "representative"),
    formMessage: (error) => (isUnconfirmedSubmit(error) ? UNCONFIRMED_TEXT : null),
  })
  // Lo escrito vive en la página: no se pierde al cambiar de horario.
  useEffect(() => onDraftChange(values), [values, onDraftChange])

  const forOther = values.who === "representative"
  const minor = minorOf(values)
  const phoneFromConversation = info.phone !== null && values.phone === info.phone
  const busy = submitting || reserving

  /** Nombres, apellidos y documento de una persona. Los tipos de documento son los del país de la clínica. */
  const personFields = (scope: "me" | "other") => {
    const person = values[scope]
    // Los datos de quien escribe: el navegador puede proponerlos.
    const mine = scope === "me"
    const docType = docTypeOf(profile, person)
    return (
      <>
        <form.AppField name={`${scope}.givenNames`}>
          {(field) => (
            <field.TextField
              id={fieldId(`${scope}.givenNames`)}
              label="Nombres"
              inputClassName="min-h-11"
              autoComplete={mine ? "given-name" : "off"}
              maxLength={100}
            />
          )}
        </form.AppField>
        <form.AppField name={`${scope}.familyName`}>
          {(field) => (
            <field.TextField
              id={fieldId(`${scope}.familyName`)}
              label="Apellidos"
              inputClassName="min-h-11"
              autoComplete={mine ? "family-name" : "off"}
              maxLength={200}
            />
          )}
        </form.AppField>
        <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-start gap-x-2 gap-y-3">
          <form.AppField name={`${scope}.docType`}>
            {(field) => (
              <field.Control id={fieldId(`${scope}.docType`)} label="Documento">
                {(control) => (
                  <Select<IdentityDocType>
                    value={docType}
                    onValueChange={(next) => {
                      if (next) field.handleChange(next)
                    }}
                  >
                    <SelectTrigger
                      id={control.id}
                      aria-label="Tipo de documento"
                      aria-invalid={control.invalid || undefined}
                      aria-describedby={control.describedBy}
                      className="min-h-11 w-full min-w-0"
                    >
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
                )}
              </field.Control>
            )}
          </form.AppField>
          <form.AppField name={`${scope}.docNumber`}>
            {(field) => <field.TextField id={fieldId(`${scope}.docNumber`)} label="Número" inputClassName="min-h-11" autoComplete="off" maxLength={20} />}
          </form.AppField>
        </div>
        {asksCountry(profile, person) ? (
          <form.AppField name={`${scope}.docCountry`}>
            {(field) => (
              <field.Control id={fieldId(`${scope}.docCountry`)} label="País que emitió el documento">
                {(control) => (
                  <SearchSelect
                    id={control.id}
                    label="País que emitió el documento"
                    placeholder="Buscar país…"
                    value={field.state.value}
                    options={countryChoices(profile.country)}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onChange={(docCountry) => field.handleChange(docCountry)}
                  />
                )}
              </field.Control>
            )}
          </form.AppField>
        ) : null}
      </>
    )
  }

  return (
    <form
      onSubmit={(event) => {
        // Un segundo toque mientras se guarda o se reserva no envía otra vez.
        if (busy) event.preventDefault()
        else submit(event)
      }}
      noValidate
      className="flex flex-col gap-4"
    >
      {personFields("me")}

      <form.AppField name="phone">
        {(field) => (
          <field.PhoneField
            id={fieldId("phone")}
            label="Celular"
            className="[&_[data-slot=input-group]]:min-h-11 [&_[data-slot=select-trigger]]:min-h-11"
            description={
              <>
                {phoneFromConversation ? "Es el número desde el que nos escribes. Cámbialo si prefieres otro. " : null}
                {/* El aviso previo que pide WhatsApp para los mensajes de servicio (ADR 0040). */}
                Te avisaremos por WhatsApp sobre tus citas.
              </>
            }
          />
        )}
      </form.AppField>

      <FieldSet className="gap-2">
        <FieldLegend variant="label" className="mb-0">
          ¿Para quién es la cita?
        </FieldLegend>
        <form.Field name="who">
          {(field) => (
            <RadioGroup
              value={field.state.value}
              onValueChange={(next) => field.handleChange(next === "representative" ? "representative" : "patient")}
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
          )}
        </form.Field>
      </FieldSet>

      {forOther ? (
        <FieldSet className="gap-4 rounded-2xl border bg-card p-4">
          <FieldLegend variant="label" className="mb-0">
            La persona que se va a atender
          </FieldLegend>
          {personFields("other")}
          {/* Mismo control que el registro de pacientes: una fecha de nacimiento se escribe, en el orden de la clínica. */}
          <form.AppField name="otherBirthDate">
            {(field) => (
              <field.Control id={fieldId("otherBirthDate")} label="Fecha de nacimiento" description="Si es menor de edad, quedas como su responsable.">
                {(control) => (
                  <BirthDateInput
                    id={control.id}
                    className="[&_input]:min-h-11"
                    today={info.today}
                    value={field.state.value}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onChange={(otherBirthDate) => field.handleChange(otherBirthDate)}
                  />
                )}
              </field.Control>
            )}
          </form.AppField>
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

      <form.AppField name="privacyAccepted">{() => <PrivacyCheck onShowNotice={() => setNoticeOpen(true)} />}</form.AppField>

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
          <ScrollArea className="flex max-h-[60svh] flex-col">
            <p className="whitespace-pre-wrap text-sm">{info.config.privacyNotice}</p>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </form>
  )
}

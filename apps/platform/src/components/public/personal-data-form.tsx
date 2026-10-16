import {
  clinicalProfileFor,
  DOC_TYPE_LABELS,
  type IdentityDocType,
  INSURANCE_TYPE_LABELS,
  INSURANCE_TYPES,
  isMinor,
  isRealDate,
  SEX_CODES,
  SEX_LABELS,
} from "@odentia/clinical"
import { Field, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@odentia/ui"
import { BirthDateInput, ErrorState, LoadingState, PhoneInput, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery } from "@tanstack/react-query"
import { CircleCheck } from "lucide-react"
import { type FormEvent, useState } from "react"
import { ApiError } from "../../lib/api"
import { fetchPersonalDataForm, type PersonalDataInput, submitPersonalData } from "../../lib/booking-link"
import { asksDocumentCountry, countryChoices } from "../../lib/person-data"
import { SearchSelect } from "../settings/search-select"

/** Lo que se escribe: solo los datos que faltan. */
type Draft = Partial<Record<string, string>>

/**
 * «Tus datos» de «Su enlace»: solo lo que falta, una sola vez, y nunca lo
 * guardado. Si la fecha dice que es menor y aún no tiene representante legal,
 * la misma pantalla pide los datos de su madre, padre o tutor. Las reglas
 * (qué se acepta, el documento repetido) son del servidor.
 */
export function PersonalDataForm({
  slug,
  token,
  clinicName,
  onDone,
}: {
  slug: string
  token: string
  clinicName: string
  onDone: () => void
}) {
  const [draft, setDraft] = useState<Draft>({})
  const [rep, setRep] = useState<{ displayName: string; docType: IdentityDocType | ""; docNumber: string; phone: string | null }>({
    displayName: "",
    docType: "",
    docNumber: "",
    phone: null,
  })
  const [problem, setProblem] = useState<string | null>(null)
  const formQuery = useQuery({
    queryKey: ["personal-link-data", slug, token],
    queryFn: () => fetchPersonalDataForm(slug, token),
    retry: false,
  })
  const send = useMutation({
    retry: false,
    mutationFn: (input: PersonalDataInput) => submitPersonalData(slug, token, input),
    onSuccess: () => setProblem(null),
    onError: (error) => {
      setProblem(
        error instanceof ApiError
          ? error.shape.code === "DATA_ALREADY_SENT"
            ? null
            : (error.shape.message ?? "No pudimos guardar tus datos.")
          : "No pudimos guardar tus datos. Revisa tu conexión y vuelve a intentarlo.",
      )
    },
  })
  const alreadySent = send.error instanceof ApiError && send.error.shape.code === "DATA_ALREADY_SENT"
  if (send.isSuccess || alreadySent) {
    return (
      <div role="status" className="flex flex-col items-center gap-2 rounded-2xl bg-success-soft p-6 text-center">
        <CircleCheck className="size-8 text-success" aria-hidden />
        <p className="text-lg font-semibold">Recibido, gracias</p>
        <p className="text-sm">Tus datos ya están en la clínica. Este paso no se puede volver a llenar desde aquí.</p>
        <SubmitButton type="button" variant="outline" className="mt-2 min-h-11" pending={false} onClick={onDone}>
          Volver a lo pendiente
        </SubmitButton>
      </div>
    )
  }
  if (formQuery.isPending) return <LoadingState kind="indeterminate" message="Cargando…" />
  if (formQuery.isError) {
    if (formQuery.error instanceof ApiError && formQuery.error.shape.code === "BOOKING_LINK_EXPIRED") {
      return <ErrorState title="Tus datos ya están en la clínica" message="Este paso ya no está pendiente." />
    }
    return <ErrorState title="No pudimos abrir tus datos" message="Vuelve a intentarlo en un momento." onRetry={() => void formQuery.refetch()} />
  }
  const form = formQuery.data.data
  const profile = clinicalProfileFor(form.countryCode)
  const keys = new Set(form.missing.map((item) => item.key))
  const firstType: IdentityDocType = profile.documentTypes[0]?.code ?? "NACIONAL"
  const docType = (draft.docType as IdentityDocType | undefined) || firstType
  const minor = !!draft.birthDate && isRealDate(draft.birthDate) && isMinor(draft.birthDate, form.today)
  const needsRep = minor && !form.hasRepresentative
  const repDocType = rep.docType || firstType
  const set = (key: string, value: string) => setDraft((current) => ({ ...current, [key]: value }))

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const data: Draft = { ...draft }
    if (keys.has("docType") || keys.has("docNumber")) data.docType = docType
    send.mutate({
      data,
      representative: needsRep ? { displayName: rep.displayName, docType: repDocType, docNumber: rep.docNumber, ...(rep.phone ? { phone: rep.phone } : {}) } : null,
    })
  }

  const text = (key: string, label: string, autoComplete: string, type = "text") => (
    <Field key={key}>
      <FieldLabel htmlFor={`datos-${key}`}>{label}</FieldLabel>
      <Input id={`datos-${key}`} className="min-h-11" type={type} autoComplete={autoComplete} maxLength={200} value={draft[key] ?? ""} onChange={(event) => set(key, event.target.value)} />
    </Field>
  )
  const choice = (key: string, label: string, options: Array<[string, string]>) => (
    <Field key={key}>
      <FieldLabel htmlFor={`datos-${key}`}>{label}</FieldLabel>
      <Select value={draft[key] ?? ""} onValueChange={(value) => set(key, value ?? "")}>
        <SelectTrigger id={`datos-${key}`} className="min-h-11 w-full">
          <SelectValue placeholder="Elige una opción">{options.find(([code]) => code === draft[key])?.[1]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map(([code, name]) => (
            <SelectItem key={code} value={code}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">Solo lo que falta. No mostramos nada de lo que ya tenemos.</p>
      {keys.has("givenNames") ? text("givenNames", "Nombres", "given-name") : null}
      {keys.has("paternalSurname") ? (
        <>
          {text("paternalSurname", "Primer apellido", "family-name")}
          {text("maternalSurname", "Segundo apellido", "off")}
        </>
      ) : null}
      {keys.has("docType") || keys.has("docNumber") ? (
        <>
          <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2">
            <Field>
              <FieldLabel htmlFor="datos-docType">Documento</FieldLabel>
              <Select<IdentityDocType> value={docType} onValueChange={(next) => next && set("docType", next)}>
                <SelectTrigger id="datos-docType" className="min-h-11 w-full min-w-0">
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
              <FieldLabel htmlFor="datos-docNumber">Número</FieldLabel>
              <Input id="datos-docNumber" className="min-h-11" autoComplete="off" maxLength={20} value={draft.docNumber ?? ""} onChange={(event) => set("docNumber", event.target.value)} />
            </Field>
          </div>
          {asksDocumentCountry(profile, docType) ? (
            <Field>
              <FieldLabel htmlFor="datos-docCountry">País que emitió el documento</FieldLabel>
              <SearchSelect
                id="datos-docCountry"
                label="País que emitió el documento"
                placeholder="Buscar país…"
                value={draft.docCountry ?? ""}
                options={countryChoices(profile.country)}
                onChange={(value) => set("docCountry", value)}
              />
            </Field>
          ) : null}
        </>
      ) : null}
      {keys.has("birthDate") ? (
        <Field>
          <FieldLabel htmlFor="datos-birthDate">Fecha de nacimiento</FieldLabel>
          <BirthDateInput id="datos-birthDate" className="[&_input]:min-h-11" today={form.today} country={form.countryCode} value={draft.birthDate ?? ""} onChange={(value) => set("birthDate", value)} />
        </Field>
      ) : null}
      {keys.has("sex") ? choice("sex", "Sexo", SEX_CODES.map((code) => [code, SEX_LABELS[code]])) : null}
      {keys.has("phone") ? (
        <>
          <Field>
            <FieldLabel htmlFor="datos-phone">Celular</FieldLabel>
            <PhoneInput id="datos-phone" className="[&_[data-slot=input-group]]:min-h-11" value={draft.phone ?? null} onChange={(next) => set("phone", next ?? "")} />
          </Field>
          {keys.has("email") ? null : text("email", "Correo (opcional)", "email", "email")}
        </>
      ) : null}
      {keys.has("email") ? text("email", "Correo", "email", "email") : null}
      {keys.has("address") ? text("address", "Dirección", "street-address") : null}
      {keys.has("emergencyContactName") ? text("emergencyContactName", "Contacto de emergencia", "off") : null}
      {keys.has("emergencyContactPhone") ? (
        <Field>
          <FieldLabel htmlFor="datos-emergencyContactPhone">Teléfono de emergencia</FieldLabel>
          <PhoneInput
            id="datos-emergencyContactPhone"
            className="[&_[data-slot=input-group]]:min-h-11"
            value={draft.emergencyContactPhone ?? null}
            onChange={(next) => set("emergencyContactPhone", next ?? "")}
          />
        </Field>
      ) : null}
      {keys.has("insuranceType") ? choice("insuranceType", "Seguro", INSURANCE_TYPES.map((code) => [code, INSURANCE_TYPE_LABELS[code]])) : null}

      {needsRep ? (
        <FieldSet className="gap-4 rounded-2xl border bg-card p-4">
          <FieldLegend variant="label" className="mb-0">
            Su madre, padre o tutor
          </FieldLegend>
          <FieldDescription>Es menor de edad: necesitamos los datos de quien responde por él o ella.</FieldDescription>
          <Field>
            <FieldLabel htmlFor="datos-rep-name">Nombres y apellidos</FieldLabel>
            <Input id="datos-rep-name" className="min-h-11" maxLength={200} value={rep.displayName} onChange={(event) => setRep({ ...rep, displayName: event.target.value })} />
          </Field>
          <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2">
            <Field>
              <FieldLabel htmlFor="datos-rep-docType">Documento</FieldLabel>
              <Select<IdentityDocType> value={repDocType} onValueChange={(next) => next && setRep({ ...rep, docType: next })}>
                <SelectTrigger id="datos-rep-docType" className="min-h-11 w-full min-w-0">
                  <SelectValue>{DOC_TYPE_LABELS[repDocType]}</SelectValue>
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
              <FieldLabel htmlFor="datos-rep-docNumber">Número</FieldLabel>
              <Input id="datos-rep-docNumber" className="min-h-11" maxLength={20} value={rep.docNumber} onChange={(event) => setRep({ ...rep, docNumber: event.target.value })} />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="datos-rep-phone">Celular</FieldLabel>
            <PhoneInput id="datos-rep-phone" className="[&_[data-slot=input-group]]:min-h-11" value={rep.phone} onChange={(next) => setRep({ ...rep, phone: next })} />
          </Field>
        </FieldSet>
      ) : null}

      <p className="text-sm text-muted-foreground">Lo pide {clinicName} para atenderte.</p>
      {problem ? <FieldError>{problem}</FieldError> : null}
      <SubmitButton type="submit" className="min-h-11 w-full" pending={send.isPending}>
        Enviar
      </SubmitButton>
    </form>
  )
}

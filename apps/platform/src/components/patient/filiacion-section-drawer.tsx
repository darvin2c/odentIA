import {
  documentTypeProfile,
  EDUCATION_LEVEL_LABELS,
  KINSHIP_LABELS,
  MARITAL_STATUS_LABELS,
  type MissingPersonDatum,
  SEX_LABELS,
} from "@odentia/clinical"
import { Badge, Button, Field, FieldDescription, FieldLabel, Input } from "@odentia/ui"
import { FormDrawer, normalizeCountry, PhoneInput } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useId, useMemo, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { useClinicalProfile } from "../../lib/org"
import type { PersonPage } from "../../lib/people"
import {
  countryChoices,
  documentChoices,
  documentCountryChosen,
  insuranceChoiceOf,
  insuranceChoices,
  insuranceFromChoice,
} from "../../lib/person-data"
import type { Patient } from "../../lib/patients"
import { SearchSelect } from "../settings/search-select"
import { ChoiceSelect } from "../ui/choice-select"

type FieldKind =
  | { kind: "text"; max: number; wide?: boolean }
  | { kind: "date" }
  | { kind: "select"; options: Array<{ value: string; label: string }> }
  | { kind: "country" }
  | { kind: "phone" }
  /** Seguro: una lista que guarda el tipo general y, si lo tiene, el régimen del país. */
  | { kind: "insurance" }

interface SectionField {
  key: keyof Patient & string
  label: string
  hint?: string
  type: FieldKind
}

/** Las tres tarjetas, «Más datos» y «Completar» (solo lo que falta). */
export type FiliacionSectionKey = "identidad" | "contacto" | "seguro" | "mas" | "completar"

const options = (labels: Record<string, string>) =>
  Object.entries(labels).map(([value, label]) => ({ value, label }))

/**
 * Los campos de cada grupo según el país de la clínica (ADR 0036): en Perú el
 * documento lleva DNI, CE, CNV y DIE; la dirección, departamento de la lista,
 * provincia, distrito y referencia; el seguro, SIS, EsSalud y EPS; y «Más
 * datos», la procedencia. En los demás, el núcleo internacional.
 */
function useSectionFields(stored: Partial<Record<string, unknown>>): Record<
  Exclude<FiliacionSectionKey, "completar">,
  { title: string; description: string; fields: SectionField[] }
> {
  const profile = useClinicalProfile()
  return useMemo(() => {
    const address = profile.address
    const docType = typeof stored.docType === "string" ? stored.docType : null
    const addressFields: SectionField[] = [
      { key: "address", label: "Calle y número", type: { kind: "text", max: 500, wide: true } },
      { key: "addressCity", label: address.cityLabel, type: { kind: "text", max: 100 } },
      ...(address.districtLabel
        ? [{ key: "addressDistrict" as const, label: address.districtLabel, type: { kind: "text" as const, max: 100 } }]
        : []),
      address.regions
        ? {
            key: "addressRegion",
            label: address.regionLabel,
            type: { kind: "select", options: address.regions.map((r) => ({ value: r.code, label: r.label })) },
          }
        : {
            key: "addressRegion",
            label: address.regionLabel,
            hint: "Se escribe hasta tener la lista oficial de regiones del país.",
            type: { kind: "text", max: 100 },
          },
      ...(address.postalCode
        ? [{ key: "addressPostalCode" as const, label: "Código postal", type: { kind: "text" as const, max: 20 } }]
        : []),
      { key: "addressCountry", label: "País", type: { kind: "country" } },
      ...(address.reference
        ? [{ key: "addressReference" as const, label: "Referencia", type: { kind: "text" as const, max: 300, wide: true } }]
        : []),
    ]
    return {
      identidad: {
        title: "Identidad",
        description: "Nombre separado, documento con su país emisor y nacimiento.",
        fields: [
          { key: "givenNames", label: "Nombres", type: { kind: "text", max: 100 } },
          { key: "paternalSurname", label: "Primer apellido", type: { kind: "text", max: 100 } },
          { key: "maternalSurname", label: "Segundo apellido", type: { kind: "text", max: 100 } },
          { key: "docType", label: "Tipo de documento", type: { kind: "select", options: documentChoices(profile, docType) } },
          { key: "docNumber", label: "Número de documento", type: { kind: "text", max: 20 } },
          { key: "docCountry", label: "País que lo emitió", type: { kind: "country" } },
          { key: "birthDate", label: "Fecha de nacimiento", type: { kind: "date" } },
          { key: "sex", label: "Sexo", type: { kind: "select", options: options(SEX_LABELS) } },
        ],
      },
      contacto: {
        title: "Contacto",
        description: "Cómo ubicarla, dónde vive y a quién llamar en una emergencia.",
        fields: [
          { key: "phone", label: "Teléfono", type: { kind: "phone" } },
          { key: "email", label: "Correo", type: { kind: "text", max: 200 } },
          ...addressFields,
          { key: "emergencyContactName", label: "Contacto de emergencia", type: { kind: "text", max: 200 } },
          {
            key: "emergencyContactRelationship",
            label: "Parentesco",
            type: { kind: "select", options: options(KINSHIP_LABELS) },
          },
          { key: "emergencyContactPhone", label: "Teléfono de emergencia", type: { kind: "phone" } },
        ],
      },
      seguro: {
        title: "Seguro",
        description: "Tipo de seguro, aseguradora y número de afiliación.",
        fields: [
          { key: "insuranceType", label: "Seguro", type: { kind: "insurance" } },
          { key: "insurerName", label: "Aseguradora", type: { kind: "text", max: 200 } },
          { key: "affiliationNumber", label: "N.º de afiliación", type: { kind: "text", max: 50 } },
        ],
      },
      mas: {
        title: "Más datos",
        description: "Opcionales: no cuentan para el aviso de datos que faltan.",
        fields: [
          { key: "nationality", label: "Nacionalidad", type: { kind: "country" } },
          { key: "birthCountry", label: "País de nacimiento", type: { kind: "country" } },
          { key: "birthPlace", label: "Lugar de nacimiento", hint: "Ciudad o localidad.", type: { kind: "text", max: 200 } },
          { key: "maritalStatus", label: "Estado civil", type: { kind: "select", options: options(MARITAL_STATUS_LABELS) } },
          {
            key: "educationLevel",
            label: "Nivel educativo",
            type: { kind: "select", options: options(EDUCATION_LEVEL_LABELS) },
          },
          { key: "occupation", label: "Ocupación", type: { kind: "text", max: 200 } },
          { key: "referralSource", label: "Cómo nos conoció", type: { kind: "text", max: 500, wide: true } },
          ...(profile.origin
            ? [{ key: "origin" as const, label: "Procedencia", type: { kind: "text" as const, max: 200 } }]
            : []),
        ],
      },
    }
  }, [profile, stored.docType])
}

/** Qué campos abre «Completar» por cada dato que falta. */
const COMPLETE_FIELDS: Record<MissingPersonDatum["key"], Array<keyof Patient & string>> = {
  givenNames: ["givenNames"],
  paternalSurname: ["paternalSurname", "maternalSurname"],
  birthDate: ["birthDate"],
  phone: ["phone", "email"],
  docType: ["docType", "docNumber", "docCountry"],
  docNumber: ["docType", "docNumber", "docCountry"],
  sex: ["sex"],
  email: ["email"],
  address: ["address", "addressCity", "addressDistrict", "addressRegion", "addressPostalCode", "addressCountry", "addressReference"],
  emergencyContactName: ["emergencyContactName", "emergencyContactRelationship", "emergencyContactPhone"],
  emergencyContactPhone: ["emergencyContactName", "emergencyContactRelationship", "emergencyContactPhone"],
  insuranceType: ["insuranceType", "insurerName", "affiliationNumber"],
}

/**
 * Lo que guarda la persona aunque aún no sea paciente (ADR 0001): su
 * identidad y cómo ubicarla. El resto de la filiación es de la ficha.
 */
const PERSON_FIELD_KEYS = new Set<string>([
  "paternalSurname",
  "maternalSurname",
  "givenNames",
  "docType",
  "docNumber",
  "docCountry",
  "birthDate",
  "sex",
  "phone",
  "email",
])

/** Las secciones que se editan en una persona que aún no es paciente. */
export const PERSON_SECTIONS: FiliacionSectionKey[] = ["identidad", "contacto"]

function initialValues(source: Partial<Record<string, unknown>>, fields: SectionField[]): Record<string, string> {
  return Object.fromEntries(
    fields.map((f) => {
      const raw = f.type.kind === "insurance" ? insuranceChoiceOf(source.insuranceType as string, source.insuranceScheme as string) : source[f.key]
      return [f.key, typeof raw === "string" ? raw : ""]
    }),
  )
}

/** «Abrirla»: la página de quien ya tiene ese documento. Nunca se unen solas. */
function OpenDuplicate({ docType, docNumber }: { docType: string; docNumber: string }) {
  const found = useQuery({
    queryKey: ["patient-duplicates", docType, docNumber],
    queryFn: () =>
      apiFetch<{ data: Array<{ id: string; displayName: string; reason: string }> }>(
        `/api/patients/duplicates?${new URLSearchParams({ docType, docNumber })}`,
      ),
    retry: false,
  })
  const match = found.data?.data.find((row) => row.reason === "document")
  if (!match) return null
  return (
    <p className="text-sm sm:col-span-2">
      <Link to="/patients/$patientId" params={{ patientId: match.id }} className="font-medium underline">
        Abrir la página de {match.displayName}
      </Link>
    </p>
  )
}

/**
 * Cajón de los datos de la persona: el único formulario de datos de la
 * aplicación (ADR 0029), con los mismos campos y catálogos que el registro,
 * según el país de la clínica, y validado en servidor con las reglas de la
 * ficha. «Completar» abre solo lo que falta, con los apellidos a la vista.
 * Guardar confirma el nombre separado (sin casilla). Con ficha guarda en la
 * ficha; sin ella, en la persona (solo identidad y contacto). Solo envía lo
 * que cambió.
 */
export function FiliacionSectionDrawer({
  patient,
  person,
  section,
  missing,
  open,
  onClose,
}: {
  section: FiliacionSectionKey
  /** Lo que falta, como lo entrega el servidor; lo usa «Completar». */
  missing?: readonly MissingPersonDatum[]
  open: boolean
  onClose: () => void
} & ({ patient: Patient; person?: undefined } | { patient?: undefined; person: PersonPage })): React.JSX.Element {
  const uid = useId()
  const queryClient = useQueryClient()
  const profile = useClinicalProfile()
  const countryCode = normalizeCountry(profile.country ?? undefined)
  const countries = useMemo(() => countryChoices(profile.country), [profile.country])
  const source = (patient ?? person ?? {}) as unknown as Partial<Record<string, unknown>>
  const sections = useSectionFields(source)
  const completing = section === "completar"
  const all = [...sections.identidad.fields, ...sections.contacto.fields, ...sections.seguro.fields, ...sections.mas.fields]
  const wanted = completing
    ? new Set((missing ?? []).flatMap((datum) => COMPLETE_FIELDS[datum.key]))
    : null
  const sectionFields = (completing ? all.filter((field) => wanted?.has(field.key)) : sections[section].fields)
    .filter((field) => patient || PERSON_FIELD_KEYS.has(field.key))
  const [values, setValues] = useState(() => initialValues(source, sectionFields))
  const original = initialValues(source, sectionFields)
  // El país emisor solo se elige cuando el tipo lo permite (el DNI lo emite el Perú).
  const fields = sectionFields.filter(
    (field) => field.key !== "docCountry" || documentCountryChosen(profile, values.docType || null),
  )
  const changed = sectionFields.filter((f) => (values[f.key] ?? "") !== (original[f.key] ?? ""))
  const set = (key: string, value: string) => setValues((prev) => ({ ...prev, [key]: value }))
  // Guardar confirma los apellidos: los que se ven al guardar quedan revisados.
  const confirmsNames = Boolean(patient?.identityNeedsReview) && (completing || section === "identidad")
  const save = useMutation({
    mutationFn: () => {
      const patch: Record<string, unknown> = {}
      for (const f of changed) {
        const value = values[f.key]?.trim() ? values[f.key]!.trim() : null
        if (f.type.kind === "insurance") Object.assign(patch, insuranceFromChoice(profile, value ?? ""))
        else patch[f.key] = value
      }
      // Si cambia el tipo a uno que fija su país, el país lo pone el servidor.
      if (patch.docType !== undefined && !documentCountryChosen(profile, values.docType || null)) delete patch.docCountry
      // El documento nacional sin país elegido es del país de la clínica (el
      // servidor hace lo mismo); el pasaporte y el extranjero piden elegirlo.
      if (
        (patch.docNumber || patch.docType) &&
        documentTypeProfile(profile, values.docType || null)?.issuer.kind === "any" &&
        !values.docCountry &&
        profile.country
      )
        patch.docCountry = profile.country
      if (!patient)
        return apiFetch(`/api/people/${person.id}/identity`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        })
      if (confirmsNames) patch.identityConfirmed = true
      return apiFetch(`/api/patients/${patient.id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      })
    },
    onSuccess: async () => {
      if (patient) await queryClient.invalidateQueries({ queryKey: ["patient", patient.id] })
      await queryClient.invalidateQueries({ queryKey: ["person"] })
      await queryClient.invalidateQueries({ queryKey: ["people"] })
      onClose()
    },
  })
  const duplicate = save.error instanceof ApiError && save.error.shape.code === "DUPLICATE_DOCUMENT"
  const message =
    save.error instanceof ApiError
      ? (save.error.shape.message ?? "No se pudo guardar.")
      : save.error
        ? "No se pudo guardar."
        : null
  const name = patient?.givenNames ?? person?.givenNames ?? patient?.displayName ?? person?.displayName ?? ""
  const title = completing ? `Completar datos de ${name}` : `Editar ${sections[section].title.toLowerCase()}`
  const description = completing
    ? "Solo lo que falta para atenderla. Al guardar, los apellidos quedan confirmados."
    : sections[section].description
  // Apellidos a la vista en «Completar», aunque no falten.
  const namesInView = completing && !wanted?.has("givenNames") && !wanted?.has("paternalSurname")
  return (
    <FormDrawer
      open={open}
      title={title}
      description={description}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault()
        if (changed.length === 0 && !confirmsNames) {
          onClose()
          return
        }
        save.mutate()
      }}
      isSubmitting={save.isPending}
      isDirty={changed.length > 0}
      error={message}
      submitLabel="Guardar"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {completing ? (
          <div className="flex items-center gap-2 sm:col-span-2">
            <Badge variant="warning">
              {missing?.length === 1 ? "Falta 1" : `Faltan ${missing?.length ?? 0}`}
            </Badge>
          </div>
        ) : null}
        {namesInView ? (
          <dl className="grid grid-cols-3 gap-3 text-sm sm:col-span-2">
            {(
              [
                ["Nombres", source.givenNames],
                ["Primer apellido", source.paternalSurname],
                ["Segundo apellido", source.maternalSurname],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
                <dd className="break-words">{typeof value === "string" && value ? value : "—"}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {fields.map((field) => {
          const id = `${uid}-${field.key}`
          const value = values[field.key] ?? ""
          const t = field.type
          const wide = (t.kind === "text" && t.wide) || t.kind === "insurance"
          return (
            <Field key={field.key} className={wide ? "sm:col-span-2" : undefined}>
              <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
              {t.kind === "select" || t.kind === "insurance" ? (
                <ChoiceSelect id={id} value={value} onChange={(event) => set(field.key, event.target.value)}>
                  <option value="">No registrado</option>
                  {(t.kind === "insurance" ? insuranceChoices(profile) : t.options).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </ChoiceSelect>
              ) : t.kind === "country" ? (
                <SearchSelect
                  id={id}
                  label={field.label}
                  placeholder="Buscar país…"
                  value={value}
                  options={countries}
                  onChange={(next) => set(field.key, next)}
                />
              ) : t.kind === "phone" ? (
                <PhoneInput
                  id={id}
                  value={value || null}
                  defaultCountry={countryCode}
                  onChange={(next) => set(field.key, next ?? "")}
                />
              ) : (
                <Input
                  id={id}
                  type={t.kind === "date" ? "date" : "text"}
                  maxLength={t.kind === "text" ? t.max : undefined}
                  value={value}
                  onChange={(event) => set(field.key, event.target.value)}
                />
              )}
              {field.hint ? <FieldDescription>{field.hint}</FieldDescription> : null}
            </Field>
          )
        })}
        {duplicate && values.docType && values.docNumber ? (
          <OpenDuplicate docType={values.docType} docNumber={values.docNumber.trim()} />
        ) : null}
        {completing && fields.length === 0 ? (
          <p className="text-sm text-muted-foreground sm:col-span-2">No le falta nada para atenderla.</p>
        ) : null}
      </div>
    </FormDrawer>
  )
}

/** Sedes para mostrar la de registro. */
export function useBranches(enabled: boolean) {
  return useQuery({
    queryKey: ["branches"],
    queryFn: () => apiFetch<{ data: Array<{ id: string; name: string }> }>("/api/branches"),
    enabled,
  })
}

/** Para el resumen de «Completar»: el botón que abre el cajón con lo que falta. */
export function CompleteDataButton({ onClick }: { onClick: () => void }) {
  return (
    <Button size="sm" variant="outline" onClick={onClick}>
      Completar
    </Button>
  )
}

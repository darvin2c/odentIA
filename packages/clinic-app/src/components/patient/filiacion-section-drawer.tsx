import {
  demographicsSchema,
  documentTypeProfile,
  EDUCATION_LEVEL_LABELS,
  KINSHIP_LABELS,
  MARITAL_STATUS_LABELS,
  type MissingPersonDatum,
  REFERRAL_KIND_LABELS,
  SEX_LABELS,
  validateDemographics,
} from "@odentia/clinical"
import { Badge, Button } from "@odentia/ui"
import {
  BirthDateInput,
  FormDrawer,
  normalizeCountry,
  regionToday,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useId, useMemo, useState } from "react"
import { staffAddressSource } from "../../lib/address-suggestions"
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
  maritalChoices,
} from "../../lib/person-data"
import { filiationGapsText, type Patient } from "../../lib/patients"
import { AddressStreetField } from "../address/address-street-field"
import { SearchSelect } from "../settings/search-select"
import { ChoiceSelect } from "../ui/choice-select"
import { placeErrors } from "./form-errors"
import { PersonalLinkActions } from "./send-personal-link"
import { attendWord } from "../../lib/patient-overview"

type FieldKind =
  | { kind: "text"; max: number; wide?: boolean }
  /** «Calle y número» con sugerencias de Geoapify (issue 36): llena lo demás de la dirección. */
  | { kind: "street"; max: number }
  | { kind: "date" }
  | { kind: "select"; options: Array<{ value: string; label: string }> }
  | { kind: "country" }
  | { kind: "phone" }
  /** Seguro: una lista que guarda el tipo general y, si lo tiene, el régimen del país. */
  | { kind: "insurance" }

/**
 * Lo que se declara como contacto de emergencia: no es un dato de la ficha,
 * el servidor lo vuelve una persona vinculada con la marca (decisión 25).
 * Solo lo pide «Completar» cuando falta; lo demás se cambia en Personas vinculadas.
 */
type EmergencyKey = "emergencyContactName" | "emergencyContactRelationship" | "emergencyContactPhone"

interface SectionField {
  key: (keyof Patient & string) | EmergencyKey
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
    const maritalStatus = typeof stored.maritalStatus === "string" ? stored.maritalStatus : null
    const addressFields: SectionField[] = [
      { key: "address", label: "Calle y número", type: { kind: "street", max: 500 } },
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
        description: "Nombres y apellidos, documento con su país emisor y nacimiento.",
        fields: [
          { key: "givenNames", label: "Nombres", type: { kind: "text", max: 100 } },
          { key: "familyName", label: "Apellidos", type: { kind: "text", max: 200 } },
          { key: "docType", label: "Tipo de documento", type: { kind: "select", options: documentChoices(profile, docType) } },
          { key: "docNumber", label: "Número de documento", type: { kind: "text", max: 20 } },
          { key: "docCountry", label: "País que lo emitió", type: { kind: "country" } },
          { key: "birthDate", label: "Fecha de nacimiento", type: { kind: "date" } },
          { key: "sex", label: "Sexo", type: { kind: "select", options: options(SEX_LABELS) } },
        ],
      },
      contacto: {
        title: "Contacto",
        description: "Cómo ubicarla y dónde vive. El contacto de emergencia se marca en Personas vinculadas.",
        fields: [
          { key: "phone", label: "Teléfono", type: { kind: "phone" } },
          { key: "email", label: "Correo", type: { kind: "text", max: 200 } },
          ...addressFields,
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
          { key: "maritalStatus", label: "Estado civil", type: { kind: "select", options: maritalChoices(profile, maritalStatus) } },
          {
            key: "educationLevel",
            label: "Nivel educativo",
            type: { kind: "select", options: options(EDUCATION_LEVEL_LABELS) },
          },
          { key: "occupation", label: "Ocupación", type: { kind: "text", max: 200 } },
          { key: "referralKind", label: "Cómo nos conoció", type: { kind: "select", options: options(REFERRAL_KIND_LABELS) } },
          { key: "referralSource", label: "¿Cuál?", hint: "Lo que dijo, cuando no está en la lista.", type: { kind: "text", max: 500, wide: true } },
          ...(profile.origin
            ? [{ key: "origin" as const, label: "Procedencia", type: { kind: "text" as const, max: 200 } }]
            : []),
        ],
      },
    }
  }, [profile, stored.docType, stored.maritalStatus])
}

/** Qué campos abre «Completar» por cada dato que falta. */
const EMERGENCY_FIELDS: SectionField[] = [
  { key: "emergencyContactName", label: "Contacto de emergencia", type: { kind: "text", max: 200 } },
  { key: "emergencyContactRelationship", label: "Parentesco", type: { kind: "select", options: options(KINSHIP_LABELS) } },
  { key: "emergencyContactPhone", label: "Teléfono de emergencia", type: { kind: "phone" } },
]

const COMPLETE_FIELDS: Record<MissingPersonDatum["key"], Array<SectionField["key"]>> = {
  givenNames: ["givenNames"],
  familyName: ["familyName"],
  birthDate: ["birthDate"],
  phone: ["phone", "email"],
  docType: ["docType", "docNumber", "docCountry"],
  docNumber: ["docType", "docNumber", "docCountry"],
  sex: ["sex"],
  nationality: ["nationality"],
  birthPlace: ["birthPlace"],
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
  "familyName",
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

/**
 * El campo que corresponde a un dato que la regla o el servidor señalan con
 * otro nombre: el nombre completo se arma con los apellidos y el régimen del
 * seguro se elige en «Seguro».
 */
const FIELD_OF_ERROR: Record<string, string> = {
  displayName: "familyName",
  insuranceScheme: "insuranceType",
}

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
    <Link to="/patients/$patientId" params={{ patientId: match.id }} className="font-medium underline">
      Abrir la página de {match.displayName}
    </Link>
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
  const patientAddressSource = useMemo(() => staffAddressSource("paciente"), [])
  const source = (patient ?? person ?? {}) as unknown as Partial<Record<string, unknown>>
  const sections = useSectionFields(source)
  const completing = section === "completar"
  const all = [
    ...sections.identidad.fields,
    ...sections.contacto.fields,
    ...sections.seguro.fields,
    ...sections.mas.fields,
    ...EMERGENCY_FIELDS,
  ]
  const wanted = completing
    ? new Set((missing ?? []).flatMap((datum) => COMPLETE_FIELDS[datum.key]))
    : null
  const sectionFields = (completing ? all.filter((field) => wanted?.has(field.key)) : sections[section].fields)
    .filter((field) => patient || PERSON_FIELD_KEYS.has(field.key))
  const original = initialValues(source, sectionFields)
  // Guardar confirma los apellidos: los que se ven al guardar quedan revisados.
  const confirmsNames = Boolean(patient?.identityNeedsReview) && (completing || section === "identidad")
  // El documento repetido: además del error en el número, el enlace a quien ya lo tiene.
  const [duplicateOf, setDuplicateOf] = useState<{ docType: string; docNumber: string } | null>(null)

  /** Solo lo que cambió, como lo recibe el servidor. */
  function patchOf(values: Record<string, string | null>): Record<string, unknown> {
    const patch: Record<string, unknown> = {}
    for (const f of sectionFields) {
      if ((values[f.key] ?? "") === (original[f.key] ?? "")) continue
      const value = values[f.key]?.trim() ? values[f.key]!.trim() : null
      if (f.type.kind === "insurance") Object.assign(patch, insuranceFromChoice(profile, value ?? ""))
      else patch[f.key] = value
    }
    // Salir de «Otro» borra también lo que dijo: con el texto guardado, el
    // servidor volvería a ponerlo como «Otro».
    if (patch.referralKind !== undefined && patch.referralKind !== "otro") patch.referralSource = null
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
    return patch
  }

  /**
   * La regla de la ficha (`validateDemographics`), la misma del servidor, sobre
   * lo guardado más lo que cambió: lo guardado que no cambia no se vuelve a
   * juzgar por el país de la clínica.
   */
  function patchErrors(patch: Record<string, unknown>): Record<string, string> {
    const stored = Object.fromEntries(
      Object.keys(demographicsSchema.shape).map((key) => [key, source[key] ?? null]),
    )
    const errors = validateDemographics({ ...stored, ...patch }, regionToday(), profile.country, stored)
    const found: Record<string, string> = {}
    for (const [key, message] of Object.entries(errors)) found[FIELD_OF_ERROR[key] ?? key] ??= message
    return found
  }

  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => {
      if (!patient)
        return apiFetch(`/api/people/${person.id}/identity`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        })
      return apiFetch(`/api/patients/${patient.id}`, {
        method: "PATCH",
        body: JSON.stringify(confirmsNames ? { ...patch, identityConfirmed: true } : patch),
      })
    },
  })

  const form = useAppForm({
    defaultValues: original as Record<string, string | null>,
    validators: {
      onSubmit: ({ value, formApi }) => placeErrors(formApi, patchErrors(patchOf(value))),
    },
    onSubmit: async ({ value }) => {
      const patch = patchOf(value)
      if (Object.keys(patch).length === 0 && !confirmsNames) {
        onClose()
        return
      }
      setDuplicateOf(null)
      try {
        await save.mutateAsync(patch)
      } catch (error) {
        if (error instanceof ApiError && error.shape.code === "DUPLICATE_DOCUMENT" && value.docType && value.docNumber)
          setDuplicateOf({ docType: value.docType, docNumber: value.docNumber.trim() })
        throw error
      }
      if (patient) await queryClient.invalidateQueries({ queryKey: ["patient", patient.id] })
      await queryClient.invalidateQueries({ queryKey: ["person"] })
      await queryClient.invalidateQueries({ queryKey: ["people"] })
      onClose()
    },
  })
  const surface = useFormSurface(form, { fieldMap: FIELD_OF_ERROR })
  const values = useStore(form.store, (state) => state.values)
  // El país emisor solo se elige cuando el tipo lo permite (el DNI lo emite el
  // Perú); «¿Cuál?», solo con «Otro» (el servidor vacía el texto de lo demás).
  const fields = sectionFields.filter(
    (field) =>
      (field.key !== "docCountry" || documentCountryChosen(profile, values.docType || null)) &&
      (field.key !== "referralSource" || values.referralKind === "otro"),
  )
  const name = patient?.givenNames ?? person?.givenNames ?? patient?.displayName ?? person?.displayName ?? ""
  const title = completing ? `Completar datos de ${name}` : `Editar ${sections[section].title.toLowerCase()}`
  const description = completing
    ? `Solo lo que falta para ${attendWord(patient?.sex ?? person?.sex)}. Al guardar, los apellidos quedan confirmados.`
    : sections[section].description
  // Apellidos a la vista en «Completar», aunque no falten.
  const namesInView = completing && !wanted?.has("givenNames") && !wanted?.has("familyName")
  return (
    <FormDrawer
      {...surface}
      open={open}
      title={title}
      description={description}
      onClose={onClose}
      submitLabel="Guardar"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {completing ? (
          // La etiqueta arriba y el aviso con sus botones debajo, a lo ancho: juntos en una fila se apretaban.
          <div className="flex flex-col items-start gap-2 sm:col-span-2">
            <Badge variant="warning">
              {missing?.length === 1 ? "Falta 1" : `Faltan ${missing?.length ?? 0}`}
            </Badge>
            {/* O que lo complete ella desde su teléfono, con «Su enlace» (decisión 8). */}
            {patient && missing && missing.length > 0 ? (
              <PersonalLinkActions patientId={patient.id} missing={filiationGapsText(missing)} />
            ) : null}
          </div>
        ) : null}
        {namesInView ? (
          <dl className="grid grid-cols-2 gap-3 text-sm sm:col-span-2">
            {(
              [
                ["Nombres", source.givenNames],
                ["Apellidos", source.familyName],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
                <dd className="break-words">{typeof value === "string" && value ? value : "—"}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {fields.map((item) => {
          const id = `${uid}-${item.key}`
          const t = item.type
          // El teléfono lleva el país al lado: en media columna el número quedaba en 38 px.
          const wide = (t.kind === "text" && t.wide) || t.kind === "insurance" || t.kind === "street" || t.kind === "phone"
          const className = wide ? "sm:col-span-2" : undefined
          // Bajo el número repetido, el enlace a la página de quien ya lo tiene.
          const hint =
            item.key === "docNumber" && duplicateOf && (values.docNumber ?? "").trim() === duplicateOf.docNumber ? (
              <OpenDuplicate docType={duplicateOf.docType} docNumber={duplicateOf.docNumber} />
            ) : (
              item.hint
            )
          return (
            <form.AppField key={item.key} name={item.key}>
              {(field) =>
                t.kind === "phone" ? (
                  <field.PhoneField label={item.label} id={id} className={className} description={hint} defaultCountry={countryCode} />
                ) : t.kind === "text" ? (
                  <field.TextField label={item.label} id={id} className={className} description={hint} maxLength={t.max} />
                ) : (
                  <field.Control label={item.label} id={id} className={className} description={hint}>
                    {(control) => {
                      const value = field.state.value ?? ""
                      if (t.kind === "select" || t.kind === "insurance")
                        return (
                          <ChoiceSelect
                            id={control.id}
                            name={control.name}
                            aria-invalid={control.invalid || undefined}
                            aria-describedby={control.describedBy}
                            onBlur={control.onBlur}
                            value={value}
                            onChange={(event) => field.handleChange(event.target.value)}
                          >
                            <option value="">No registrado</option>
                            {(t.kind === "insurance" ? insuranceChoices(profile) : t.options).map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </ChoiceSelect>
                        )
                      if (t.kind === "street")
                        return (
                          <AddressStreetField
                            id={control.id}
                            invalid={control.invalid}
                            aria-describedby={control.describedBy}
                            onBlur={control.onBlur}
                            value={value}
                            maxLength={t.max}
                            source={patientAddressSource}
                            placeholder="Escribe la calle; te sugerimos la dirección completa"
                            pickedHint="Lo llenó la sugerencia; puedes corregirlo. Agrega el dpto. o interior en la calle."
                            onChange={(next) => field.handleChange(next)}
                            onPick={(pick) => {
                              form.setFieldValue("addressCity", pick.city ?? "")
                              if (profile.address.districtLabel) form.setFieldValue("addressDistrict", pick.district ?? "")
                              form.setFieldValue("addressRegion", pick.region ?? "")
                              if (profile.address.postalCode) form.setFieldValue("addressPostalCode", pick.postalCode ?? "")
                              if (pick.country) form.setFieldValue("addressCountry", pick.country)
                            }}
                          />
                        )
                      if (t.kind === "country")
                        return (
                          <SearchSelect
                            id={control.id}
                            label={item.label}
                            placeholder="Buscar país…"
                            value={value}
                            options={countries}
                            invalid={control.invalid}
                            aria-describedby={control.describedBy}
                            onChange={(next) => field.handleChange(next)}
                          />
                        )
                      return (
                        <BirthDateInput
                          id={control.id}
                          name={control.name}
                          value={value}
                          invalid={control.invalid}
                          aria-describedby={control.describedBy}
                          onBlur={control.onBlur}
                          onChange={(next) => field.handleChange(next)}
                        />
                      )
                    }}
                  </field.Control>
                )
              }
            </form.AppField>
          )
        })}
        {completing && fields.length === 0 ? (
          <p className="text-sm text-muted-foreground sm:col-span-2">No le falta nada para {attendWord(patient?.sex ?? person?.sex)}.</p>
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

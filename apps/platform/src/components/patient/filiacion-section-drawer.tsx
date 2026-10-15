import {
  DOC_TYPE_LABELS,
  EDUCATION_LEVEL_LABELS,
  IDENTITY_DOC_TYPES,
  KINSHIP_LABELS,
  MARITAL_STATUS_LABELS,
  SEX_LABELS,
} from "@odentia/clinical"
import { Field, FieldDescription, FieldLabel, Input } from "@odentia/ui"
import { FormDrawer, normalizeCountry, PhoneInput } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useId, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { useOrgProfile } from "../../lib/org"
import type { PersonPage } from "../../lib/people"
import type { Patient } from "../../lib/patients"
import { ChoiceSelect } from "../ui/choice-select"
import { UbigeoField } from "./ubigeo-field"

/** Países frecuentes (ISO 3166-1 alfa-2); otro se escribe con su código. */
export const COUNTRY_LABELS: Record<string, string> = {
  PE: "Perú",
  VE: "Venezuela",
  CO: "Colombia",
  EC: "Ecuador",
  BO: "Bolivia",
  CL: "Chile",
  AR: "Argentina",
  BR: "Brasil",
  US: "Estados Unidos",
  ES: "España",
  CN: "China",
}

export const INSURANCE_LABELS: Record<string, string> = {
  PARTICULAR: "Particular",
  SIS: "SIS",
  ESSALUD: "EsSalud",
  EPS: "EPS",
  OTRO: "Otro",
}

type FieldKind =
  | { kind: "text"; max: number; placeholder?: string }
  | { kind: "date" }
  | { kind: "select"; options: Record<string, string> }
  | { kind: "country" }
  | { kind: "phone" }
  | { kind: "ubigeo" }

interface SectionField {
  key: keyof Patient & string
  label: string
  hint?: string
  type: FieldKind
}

export type FiliacionSectionKey = "identidad" | "domicilio" | "contacto" | "seguro" | "emergencia"

export const FILIACION_SECTIONS: Record<
  FiliacionSectionKey,
  { title: string; description: string; fields: SectionField[] }
> = {
  identidad: {
    title: "Identidad",
    description:
      "Nombre separado, documento y datos personales, como en el formato de historia clínica.",
    fields: [
      { key: "paternalSurname", label: "Apellido paterno", type: { kind: "text", max: 100 } },
      { key: "maternalSurname", label: "Apellido materno", type: { kind: "text", max: 100 } },
      { key: "givenNames", label: "Nombres", type: { kind: "text", max: 100 } },
      {
        key: "docType",
        label: "Tipo de documento",
        type: {
          kind: "select",
          options: Object.fromEntries(IDENTITY_DOC_TYPES.map((t) => [t, DOC_TYPE_LABELS[t]])),
        },
      },
      {
        key: "docNumber",
        label: "Número de documento",
        hint: "DNI: 8 dígitos. CE y pasaporte: letras y dígitos; el pasaporte pide país emisor.",
        type: { kind: "text", max: 20 },
      },
      { key: "docCountry", label: "País emisor", type: { kind: "country" } },
      { key: "nationality", label: "Nacionalidad", type: { kind: "country" } },
      { key: "birthDate", label: "Fecha de nacimiento", type: { kind: "date" } },
      { key: "sex", label: "Sexo", type: { kind: "select", options: SEX_LABELS } },
      {
        key: "maritalStatus",
        label: "Estado civil",
        type: { kind: "select", options: MARITAL_STATUS_LABELS },
      },
      {
        key: "educationLevel",
        label: "Grado de instrucción",
        type: { kind: "select", options: EDUCATION_LEVEL_LABELS },
      },
      { key: "occupation", label: "Ocupación", type: { kind: "text", max: 200 } },
    ],
  },
  domicilio: {
    title: "Nacimiento y domicilio",
    description: "Lugar de nacimiento y domicilio con ubigeo del INEI.",
    fields: [
      { key: "birthPlaceUbigeo", label: "Lugar de nacimiento", type: { kind: "ubigeo" } },
      { key: "address", label: "Domicilio", type: { kind: "text", max: 500 } },
      { key: "addressUbigeo", label: "Ubigeo del domicilio", type: { kind: "ubigeo" } },
      { key: "addressReference", label: "Referencia", type: { kind: "text", max: 300 } },
      { key: "origin", label: "Procedencia", type: { kind: "text", max: 200 } },
    ],
  },
  contacto: {
    title: "Contacto",
    description: "Teléfono en formato internacional y correo de la persona.",
    fields: [
      { key: "phone", label: "Teléfono", type: { kind: "phone" } },
      { key: "email", label: "Correo", type: { kind: "text", max: 200 } },
      { key: "referralSource", label: "Cómo nos conoció", type: { kind: "text", max: 500 } },
    ],
  },
  seguro: {
    title: "Seguro",
    description: "Tipo de seguro, aseguradora y número de afiliación.",
    fields: [
      { key: "insuranceType", label: "Tipo", type: { kind: "select", options: INSURANCE_LABELS } },
      { key: "insurerName", label: "Aseguradora", type: { kind: "text", max: 200 } },
      { key: "affiliationNumber", label: "N.º de afiliación", type: { kind: "text", max: 50 } },
      { key: "insuranceDetail", label: "Detalle", type: { kind: "text", max: 500 } },
    ],
  },
  emergencia: {
    title: "Contacto de emergencia",
    description: "A quién llamar en una emergencia y su parentesco.",
    fields: [
      { key: "emergencyContactName", label: "Nombre", type: { kind: "text", max: 200 } },
      {
        key: "emergencyContactRelationship",
        label: "Parentesco",
        type: { kind: "select", options: KINSHIP_LABELS },
      },
      { key: "emergencyContactPhone", label: "Teléfono", type: { kind: "phone" } },
    ],
  },
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

function sectionFields(section: FiliacionSectionKey, forPatient: boolean): SectionField[] {
  const fields = FILIACION_SECTIONS[section].fields
  return forPatient ? fields : fields.filter((field) => PERSON_FIELD_KEYS.has(field.key))
}

function initialValues(source: Partial<Record<string, unknown>>, fields: SectionField[]): Record<string, string> {
  return Object.fromEntries(
    fields.map((f) => {
      const raw = source[f.key]
      return [f.key, typeof raw === "string" ? raw : ""]
    }),
  )
}

/**
 * Cajón de una sección de los datos de la persona: el único formulario de
 * datos de la aplicación (ADR 0029), con los mismos campos y catálogos que el
 * registro y validado en servidor con las reglas de la ficha. Con ficha guarda
 * en la ficha; sin ella, en la persona (solo identidad y contacto, que es lo
 * que la persona tiene). Solo envía lo que cambió.
 */
export function FiliacionSectionDrawer({
  patient,
  person,
  section,
  open,
  onClose,
}: {
  section: FiliacionSectionKey
  open: boolean
  onClose: () => void
} & ({ patient: Patient; person?: undefined } | { patient?: undefined; person: PersonPage })): React.JSX.Element {
  const uid = useId()
  const queryClient = useQueryClient()
  const profile = useOrgProfile()
  const countryCode = normalizeCountry(profile.data?.countryCode)
  const config = FILIACION_SECTIONS[section]
  const fields = sectionFields(section, Boolean(patient))
  const source = (patient ?? person ?? {}) as unknown as Partial<Record<string, unknown>>
  const [values, setValues] = useState(() => initialValues(source, fields))
  const [confirmIdentity, setConfirmIdentity] = useState(false)
  const original = initialValues(source, fields)
  const changed = fields.filter((f) => (values[f.key] ?? "") !== (original[f.key] ?? ""))
  const set = (key: string, value: string) => setValues((prev) => ({ ...prev, [key]: value }))
  const save = useMutation({
    mutationFn: () => {
      const patch: Record<string, unknown> = Object.fromEntries(
        changed.map((f) => [f.key, values[f.key]?.trim() ? values[f.key]?.trim() : null]),
      )
      if (!patient)
        return apiFetch(`/api/people/${person.id}/identity`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        })
      if (confirmIdentity) patch.identityConfirmed = true
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
  const error =
    save.error instanceof ApiError
      ? (save.error.shape.message ?? "No se pudo guardar.")
      : save.error
        ? "No se pudo guardar."
        : null
  return (
    <FormDrawer
      open={open}
      title={`Editar ${config.title.toLowerCase()}`}
      description={config.description}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault()
        if (changed.length === 0 && !confirmIdentity) {
          onClose()
          return
        }
        save.mutate()
      }}
      isSubmitting={save.isPending}
      isDirty={changed.length > 0 || confirmIdentity}
      error={error}
      submitLabel="Guardar"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map((field) => {
          const id = `${uid}-${field.key}`
          const value = values[field.key] ?? ""
          const t = field.type
          if (t.kind === "ubigeo")
            return (
              <div key={field.key} className="sm:col-span-2">
                <UbigeoField
                  label={field.label}
                  value={value}
                  onChange={(code) => set(field.key, code)}
                />
              </div>
            )
          return (
            <Field
              key={field.key}
              className={t.kind === "text" && t.max > 200 ? "sm:col-span-2" : undefined}
            >
              <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
              {t.kind === "select" ? (
                <ChoiceSelect
                  id={id}
                  
                  value={value}
                  onChange={(event) => set(field.key, event.target.value)}
                >
                  <option value="">No registrado</option>
                  {Object.entries(t.options).map(([code, label]) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
                </ChoiceSelect>
              ) : t.kind === "country" ? (
                <>
                  <Input
                    id={id}
                    list={`${uid}-countries`}
                    maxLength={2}
                    className="w-24 uppercase"
                    placeholder="PE"
                    value={value}
                    onChange={(event) => set(field.key, event.target.value.toUpperCase())}
                  />
                  <FieldDescription>
                    {value
                      ? (COUNTRY_LABELS[value] ?? "Código ISO de dos letras")
                      : "Código ISO de dos letras"}
                  </FieldDescription>
                </>
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
        <datalist id={`${uid}-countries`}>
          {Object.entries(COUNTRY_LABELS).map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </datalist>
        {section === "identidad" && patient?.identityNeedsReview ? (
          <label className="flex items-start gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={confirmIdentity}
              onChange={(event) => setConfirmIdentity(event.target.checked)}
            />
            Confirmo que apellidos y nombres están bien separados (verificados con el documento).
          </label>
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

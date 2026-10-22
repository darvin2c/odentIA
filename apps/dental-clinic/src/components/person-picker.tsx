import { documentText } from "@odentia/clinical"
import {
  Button,
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  Field,
  FieldDescription,
  FieldLabel,
} from "@odentia/ui"
import { internationalText } from "@odentia/ui-patterns"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { X } from "lucide-react"
import { useEffect, useId, useState } from "react"
import { apiFetch } from "../lib/api"
import { hcLabel } from "../lib/patients"
import type { PersonListItem } from "../lib/people"

/** Una persona elegida: su persona (contacto), cómo se llama y su ficha si es paciente. */
export interface PickedPerson {
  id: string
  name: string
  phone?: string | null
  /** Su ficha clínica, si ya es paciente. */
  patientId?: string | null
  patientNumber?: number | null
  /** Su documento, como se muestra («DNI 70214589»). */
  document?: string | null
  sex?: string | null
}

/** Lo que el buscador devuelve, como persona elegida. */
export function pickedOf(row: PersonListItem): PickedPerson {
  return {
    id: row.id,
    name: row.displayName,
    phone: row.phone,
    patientId: row.patient?.id ?? null,
    patientNumber: row.patient?.patientNumber ?? null,
    document: row.docNumber ? documentText(row.docType, row.docNumber) : null,
    sex: row.sex,
  }
}

/**
 * El buscador de personas de la aplicación (ADR 0029): se escribe el nombre,
 * el teléfono o el documento y el servidor busca (los teléfonos por sus
 * dígitos) en la misma lista que «Pacientes». Elegir es tocar la persona; no
 * se teclea un identificador ni se recorre una lista de botones. Lo usan la
 * cita, el cobro, la tarea, la oportunidad, el portal, vincular personas y
 * los responsables. Con `patientsOnly` solo ofrece pacientes (lo que exige una
 * ficha). Lo puede usar quien ve a las personas (`patients.read`).
 */
export function PersonPicker({
  label = "Persona",
  value,
  onChange,
  disabled = false,
  description,
  placeholder = "Buscar por nombre, teléfono o documento",
  patientsOnly = false,
  includeArchived = false,
  excludeId,
  onCreate,
  createLabel = (typed) => `Crear a ${typed}`,
}: {
  label?: string
  value: PickedPerson | null
  onChange: (person: PickedPerson | null) => void
  disabled?: boolean
  description?: string
  placeholder?: string
  /** Solo pacientes: para lo que necesita una ficha (cita, cobro, portal). */
  patientsOnly?: boolean
  /** También personas archivadas (p. ej. a quién pasar un canal). */
  includeArchived?: boolean
  /** Una persona que no se ofrece (la de la propia página). */
  excludeId?: string
  /** Si nadie coincide, crear a la persona con lo que se escribió (p. ej. registrarla). */
  onCreate?: (query: string) => void
  /** Texto del botón de crear: «Registrar a …». */
  createLabel?: (query: string) => string
}) {
  const id = useId()
  const [query, setQuery] = useState("")
  const [debounced, setDebounced] = useState("")
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250)
    return () => clearTimeout(timer)
  }, [query])
  const view = patientsOnly ? "pacientes" : includeArchived ? "todos" : "activos"
  const results = useQuery({
    queryKey: ["person-picker", view, debounced],
    queryFn: () => {
      const params = new URLSearchParams({ ver: view, limit: "10" })
      if (debounced) params.set("q", debounced)
      return apiFetch<{ data: PersonListItem[] }>(`/api/people?${params}`)
    },
    enabled: open && !disabled,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  })
  const items: PickedPerson[] = (results.data?.data ?? [])
    .filter((row) => row.id !== excludeId)
    .map(pickedOf)

  if (value) {
    return (
      <Field>
        <FieldLabel>{label}</FieldLabel>
        <div className="flex min-h-11 items-center justify-between gap-2 rounded-md border px-3 py-1.5">
          <span className="min-w-0">
            <span className="block truncate font-medium">{value.name}</span>
            {value.patientNumber || value.phone ? (
              <span className="block text-xs text-muted-foreground">
                {[
                  value.patientNumber ? hcLabel(value.patientNumber) : null,
                  value.phone ? internationalText(value.phone) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            ) : null}
          </span>
          {!disabled ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange(null)}
              aria-label={`Quitar a ${value.name}`}
            >
              <X aria-hidden />
              Cambiar
            </Button>
          ) : null}
        </div>
        {description ? <FieldDescription>{description}</FieldDescription> : null}
      </Field>
    )
  }

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Combobox
        items={items}
        filter={null}
        disabled={disabled}
        open={open && !disabled}
        onOpenChange={setOpen}
        value={null}
        isItemEqualToValue={(a: PickedPerson, b: PickedPerson) => a.id === b.id}
        itemToStringValue={(item: PickedPerson) => item.id}
        itemToStringLabel={(item: PickedPerson) => item.name}
        inputValue={query}
        onInputValueChange={(next, details) => {
          if (details.reason === "input-change") {
            setQuery(next)
            setOpen(true)
          } else if (details.reason === "input-clear" || details.reason === "clear-press") {
            setQuery("")
          }
        }}
        onValueChange={(item: PickedPerson | null) => {
          if (item) {
            onChange(item)
            setQuery("")
            setOpen(false)
          }
        }}
      >
        <ComboboxInput
          id={id}
          disabled={disabled}
          placeholder={placeholder}
          aria-label={label}
          triggerLabel={`Mostrar personas: ${label}`}
        />
        <ComboboxContent aria-label={label}>
          {results.isError ? (
            <div role="alert" className="flex flex-col gap-2 p-2">
              <p className="text-sm text-destructive">No se pudo buscar.</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void results.refetch()}
              >
                Reintentar
              </Button>
            </div>
          ) : (
            <>
              <ComboboxList aria-label={label}>
                {(item: PickedPerson) => (
                  <ComboboxItem
                    key={item.id}
                    value={item}
                    className="flex-col items-start gap-0 py-2"
                  >
                    <span className="font-medium">{item.name}</span>
                    {item.patientNumber || item.phone ? (
                      <span className="text-muted-foreground">
                        {[
                          item.patientNumber ? hcLabel(item.patientNumber) : null,
                          item.phone ? internationalText(item.phone) : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    ) : null}
                  </ComboboxItem>
                )}
              </ComboboxList>
              <ComboboxEmpty>
                {results.isFetching ? (
                  "Buscando…"
                ) : onCreate && query.trim().length >= 2 ? (
                  <span className="grid w-full gap-1.5 px-2">
                    <span>Nadie con ese nombre, teléfono o documento.</span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        onCreate(query.trim())
                        setOpen(false)
                      }}
                    >
                      {createLabel(query.trim())}
                    </Button>
                  </span>
                ) : patientsOnly ? (
                  "Ningún paciente con ese nombre, teléfono o documento."
                ) : (
                  "Nadie con ese nombre, teléfono o documento."
                )}
              </ComboboxEmpty>
            </>
          )}
        </ComboboxContent>
      </Combobox>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  )
}

import {
  Badge,
  Button,
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  Field,
  FieldLabel,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@odentia/ui"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useId, useMemo, useState } from "react"
import { ApiError } from "../../lib/api"
import { useCanWrite } from "../../lib/crm"
import {
  fetchServices,
  formatMoney,
  type ServiceCatalogItem,
  TREATMENT_SCOPE_LABELS,
  TREATMENT_SPECIALTIES,
  TREATMENT_SPECIALTY_LABELS,
} from "../../lib/services"

interface ServicePickerProps {
  value: string
  onChange: (service: ServiceCatalogItem) => void
  disabled?: boolean
  currentService?: { id: string; name: string }
  label?: string
}

const NO_SPECIALTY = "todas"

/**
 * Selector de tratamiento del tarifario para planes y procedimientos.
 * La tarifa se muestra solo como lectura; sin tarifa no se puede cotizar.
 * Tras elegir se mantiene abierto para seguir añadiendo uno por uno.
 */
export function ServicePicker({
  value,
  onChange,
  disabled = false,
  currentService,
  label = "Tratamiento",
}: ServicePickerProps) {
  const id = useId()
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState(false)
  const [specialty, setSpecialty] = useState<string>(NO_SPECIALTY)
  const canAdmin = useCanWrite()

  const servicesQuery = useQuery({
    queryKey: ["services", "picker", query.trim(), specialty],
    queryFn: () =>
      fetchServices({
        q: query.trim() || undefined,
        specialty: specialty === NO_SPECIALTY ? undefined : specialty,
        state: "active",
        limit: 30,
      }),
    enabled: !disabled,
    staleTime: 30_000,
  })

  const items = useMemo(() => servicesQuery.data?.data ?? [], [servicesQuery.data])

  const selectedItem = items.find((row) => row.id === value) ?? null

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex flex-col gap-2">
        <Select
          value={specialty}
          items={{
            [NO_SPECIALTY]: "Todas las especialidades",
            ...Object.fromEntries(
              TREATMENT_SPECIALTIES.map((s) => [s, TREATMENT_SPECIALTY_LABELS[s]]),
            ),
          }}
          onValueChange={(next) => setSpecialty(next ?? NO_SPECIALTY)}
          disabled={disabled}
        >
          <SelectTrigger id={`${id}-especialidad`} aria-label="Especialidad">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_SPECIALTY}>Todas las especialidades</SelectItem>
            {TREATMENT_SPECIALTIES.map((s) => (
              <SelectItem key={s} value={s}>
                {TREATMENT_SPECIALTY_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Combobox
          items={items}
          filter={null}
          disabled={disabled}
          open={open && !disabled}
          onOpenChange={setOpen}
          value={selectedItem}
          isItemEqualToValue={(a, b) => a.id === b.id}
          itemToStringValue={(item) => item.id}
          inputValue={query}
          onInputValueChange={(next, details) => {
            const { reason } = details
            if (reason === "input-change") {
              setQuery(next)
              setOpen(true)
              return
            }
            if (reason === "input-clear" || reason === "clear-press") {
              setQuery("")
              setOpen(false)
            }
          }}
          onValueChange={(item) => {
            if (item && item.priceCents !== null) {
              onChange(item)
              setQuery("")
              setOpen(true)
            }
          }}
        >
          <ComboboxInput
            id={id}
            disabled={disabled}
            placeholder="Buscar tratamiento por nombre, código o especialidad…"
            showTrigger={false}
          />
          <ComboboxContent>
            {servicesQuery.isPending ? (
              <p className="p-2 text-sm text-muted-foreground">Cargando tratamientos…</p>
            ) : servicesQuery.isError ? (
              <div role="alert" className="flex flex-col gap-2 p-2">
                <p className="text-sm text-destructive">
                  {servicesQuery.error instanceof ApiError
                    ? (servicesQuery.error.shape.message ?? servicesQuery.error.message)
                    : servicesQuery.error.message}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void servicesQuery.refetch()}
                >
                  Reintentar
                </Button>
              </div>
            ) : items.length === 0 ? (
              <div className="flex flex-col gap-2 p-2">
                <p className="text-sm text-muted-foreground">Sin tratamientos con ese criterio.</p>
                {canAdmin ? (
                  <Link
                    to="/services"
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm font-medium text-accent hover:text-accent-foreground"
                  >
                    Administrar tarifario
                  </Link>
                ) : null}
              </div>
            ) : (
              <>
                <ComboboxList aria-label="Tratamientos disponibles">
                  {items.map((item) => {
                    const priced = item.priceCents !== null
                    return (
                      <ComboboxItem
                        key={item.id}
                        value={item}
                        disabled={!priced}
                        className="flex-col items-start gap-0 py-2"
                      >
                        <span className="font-medium">{item.name}</span>
                        <span className="text-muted-foreground">
                          {item.specialty
                            ? `${TREATMENT_SPECIALTY_LABELS[item.specialty] ?? item.specialty} · `
                            : ""}
                          {item.scope
                            ? `${TREATMENT_SCOPE_LABELS[item.scope] ?? item.scope} · `
                            : ""}
                          {item.code ? `${item.code} · ` : ""}
                          {priced
                            ? formatMoney(item.priceCents as number, item.currency)
                            : "Sin tarifa: configúrala en el tarifario antes de cotizar"}
                          {item.durationMin !== null ? ` · ${item.durationMin} min` : ""}
                        </span>
                      </ComboboxItem>
                    )
                  })}
                </ComboboxList>
                <ComboboxEmpty>Sin resultados.</ComboboxEmpty>
              </>
            )}
          </ComboboxContent>
        </Combobox>
      </div>
      {selectedItem ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{selectedItem.name}</Badge>
          <span className="text-sm text-muted-foreground">
            Tarifa de catálogo:{" "}
            {selectedItem.priceCents !== null
              ? formatMoney(selectedItem.priceCents, selectedItem.currency)
              : "sin tarifa"}
            {selectedItem.durationMin !== null ? ` · ${selectedItem.durationMin} min` : ""}
          </span>
        </div>
      ) : currentService?.id === value ? (
        <p className="text-sm text-muted-foreground">
          {currentService.name} · Tratamiento guardado; no disponible para nuevas selecciones.
        </p>
      ) : null}
    </Field>
  )
}

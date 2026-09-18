import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  cn,
} from "@odentia/ui"
import * as React from "react"
import { common } from "../common.js"
import { normalizeSearchText } from "../text.js"
import {
  canonicalTimeZone,
  type TimeZoneMeta,
  type TimeZoneOption,
  timeZoneMeta,
  timeZoneOption,
  timeZoneOptions,
} from "./time-zone.js"

export interface TimeZoneSelectProps {
  /** Identificador IANA (`America/Lima`) o `null`. */
  value: string | null
  /** Recibe la zona elegida (o `null`) y su lectura para la fecha de referencia. */
  onChange: (value: string | null, meta: TimeZoneMeta | undefined) => void
  /**
   * Zonas que se ofrecen al principio de la lista (las del país de la
   * organización con `zonesForCountry`, o la detectada con `detectedTimeZone`).
   */
  suggested?: readonly string[]
  /**
   * Fecha de referencia del desfase y de la hora local mostrados. La agenda
   * pasa la fecha de la cita; por defecto, el momento en que se abrió el campo.
   */
  referenceDate?: Date
  invalid?: boolean
  disabled?: boolean
  id?: string
  name?: string
  placeholder?: string
  className?: string
  "aria-describedby"?: string
}

/**
 * Zona horaria con búsqueda. El valor canónico es el identificador IANA, el
 * mismo que guardan `organization.timezone` y `branch.timezone`; la lista, los
 * desfases y la hora local salen del runtime (`Intl`), no de una tabla propia.
 *
 * Se busca por ciudad, por identificador y por desfase a la vez: `bogota`,
 * `america/bogota` y `gmt-5` encuentran lo mismo. La normalización quita
 * diacríticos (la misma función que usa el filtro de listas).
 *
 * El componente elige **una** zona: la política de «heredar de la organización»
 * (sucursal con `timezone` en `null`) la compone la pantalla, que puede usar
 * este campo con `disabled` mientras la sucursal hereda.
 */
export function TimeZoneSelect({
  value,
  onChange,
  suggested,
  referenceDate,
  invalid = false,
  disabled = false,
  id,
  name,
  placeholder = common.timeZone.search,
  className,
  "aria-describedby": ariaDescribedBy,
}: TimeZoneSelectProps) {
  // Referencia estable por montaje: el desfase mostrado no cambia mientras el
  // campo está abierto, y las listas memoizadas no se rehacen en cada render.
  const [openedAt] = React.useState(() => new Date())
  const reference = referenceDate ?? openedAt
  const selected = React.useMemo(() => timeZoneMeta(value, reference), [reference, value])

  const options = React.useMemo(() => {
    const all = timeZoneOptions(reference)
    if (!suggested?.length && !selected) return all

    // La zona guardada y las sugeridas encabezan la lista aunque no estén en el
    // catálogo del runtime (p. ej. `UTC`): un valor guardado nunca se esconde.
    const pinned: string[] = []
    for (const zone of [selected?.timeZone, ...(suggested ?? [])]) {
      const canonicalZone = canonicalTimeZone(zone)
      if (canonicalZone && !pinned.includes(canonicalZone)) pinned.push(canonicalZone)
    }
    const head = pinned
      .map(
        (zone) => all.find((option) => option.timeZone === zone) ?? timeZoneOption(zone, reference),
      )
      .filter((option): option is TimeZoneOption => option !== undefined)
    return [...head, ...all.filter((option) => !pinned.includes(option.timeZone))]
  }, [reference, selected, suggested])

  const selectedOption = options.find((option) => option.timeZone === selected?.timeZone) ?? null
  const labelOf = (option: TimeZoneOption) => `${option.city} (${option.offsetLabel})`

  // El texto lo controla el componente: Base UI solo rellena el input al pulsar
  // una fila, así que un valor que llega de fuera (ficha ya guardada) se perdería.
  // Lo tecleado se recuerda junto al valor para el que se tecleó: si el valor
  // cambia desde fuera, vuelve a mostrarse la selección sin necesidad de efecto.
  const [typed, setTyped] = React.useState<{ text: string; forValue: string | null } | null>(null)
  const showingLabel = !typed || typed.forValue !== value
  const inputValue = showingLabel ? (selectedOption ? labelOf(selectedOption) : "") : typed.text

  return (
    <Combobox
      items={options}
      value={selectedOption}
      inputValue={inputValue}
      onInputValueChange={(next) => setTyped({ text: next, forValue: value })}
      onValueChange={(option) => {
        const next = option?.timeZone ?? null
        setTyped(null)
        onChange(next, timeZoneMeta(next, reference))
      }}
      itemToStringLabel={labelOf}
      filter={(option, query) => {
        const normalized = normalizedQuery(query)
        return !normalized || option.search.includes(normalized)
      }}
      disabled={disabled}
    >
      <ComboboxInput
        id={id}
        name={name}
        className={cn("w-full", className)}
        aria-label={common.timeZone.label}
        aria-invalid={invalid || undefined}
        aria-describedby={ariaDescribedBy}
        placeholder={placeholder}
        disabled={disabled}
        // El texto del campo es la etiqueta de la zona elegida, no una consulta
        // editable: al entrar a buscar se vacía (y se ve el catálogo completo), y
        // al salir sin elegir vuelve la etiqueta. Sin esto, teclear añadiría al
        // nombre de la zona y el filtro no encontraría nada.
        onFocus={() => {
          if (showingLabel) setTyped({ text: "", forValue: value })
        }}
        onBlur={() => setTyped(null)}
      />
      <ComboboxContent>
        <ComboboxList aria-label={common.timeZone.label}>
          {/* Hijo función: Base UI renderiza solo las zonas que pasan el filtro
              (el catálogo completo son cientos de filas). */}
          {(option: TimeZoneOption) => (
            <ComboboxItem key={option.timeZone} value={option} className="items-start gap-1">
              <span className="flex flex-col">
                <span>
                  {option.city} <span className="text-muted-foreground">{option.offsetLabel}</span>
                </span>
                <span className="text-xs font-normal text-muted-foreground">{option.timeZone}</span>
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
        <ComboboxEmpty>{common.timeZone.empty}</ComboboxEmpty>
      </ComboboxContent>
    </Combobox>
  )
}

// El filtro recibe la misma consulta para cada una de las cientos de zonas: se
// normaliza una vez por consulta en lugar de una vez por fila.
let lastQuery = ""
let lastNormalized = ""

function normalizedQuery(query: string): string {
  if (query !== lastQuery) {
    lastQuery = query
    lastNormalized = normalizeSearchText(query.trim())
  }
  return lastNormalized
}

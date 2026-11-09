import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
  cn,
} from "@odentia/ui"
import * as React from "react"
import { normalizeSearchText } from "../text.js"
import {
  type CountryCode,
  type CountryOption,
  countryOptions,
  getCountryCallingCode,
  mainCountryOfCallingCode,
  regionCountry,
} from "./phone.js"

export interface CountrySelectProps {
  value: CountryCode
  onChange: (country: CountryCode) => void
  /** Acota la lista; sin esto se ofrecen todos los países con plan telefónico. */
  countries?: readonly CountryCode[]
  disabled?: boolean
  /** Para asociar la etiqueta de la pantalla (`FieldLabel htmlFor`). */
  id?: string
  /** Nombre accesible cuando la pantalla no le pone etiqueta visible («País»). */
  "aria-label"?: string
  invalid?: boolean
  "aria-describedby"?: string
  onBlur?: () => void
}

interface CountryItem extends CountryOption {
  /** Nombre y código, sin tildes y en minúsculas: «reino unido gb». */
  search: string
}

/** Lo tecleado, sin tildes; un prefijo («+44», «44») se busca por sus dígitos. */
function queryOf(text: string): { words: string; digits: string } {
  const trimmed = text.trim()
  const digits = /^\+?\d+$/.test(trimmed) ? trimmed.replace(/\D/g, "") : ""
  return { words: digits ? "" : normalizeSearchText(trimmed), digits }
}

/**
 * Selector de país del teléfono. El disparador muestra ISO + prefijo
 * (`PE +51`) porque el nombre completo no cabe en el ancho del campo; al
 * abrirlo, un buscador encuentra el país por su nombre («reino»), su código
 * («gb») o su prefijo («44», «+44»), con el país principal de ese prefijo
 * primero (QA del 8 nov: una lista de 200 sin buscar). Los nombres salen de
 * `Intl.DisplayNames`.
 */
export function CountrySelect({
  value,
  onChange,
  countries,
  disabled = false,
  id,
  "aria-label": ariaLabel,
  invalid = false,
  "aria-describedby": describedBy,
  onBlur,
}: CountrySelectProps) {
  const items = React.useMemo<CountryItem[]>(
    () =>
      countryOptions(value || regionCountry(), countries).map((option) => ({
        ...option,
        search: normalizeSearchText(`${option.label} ${option.value}`),
      })),
    [value, countries],
  )
  const selected = items.find((item) => item.value === value) ?? null
  const [query, setQuery] = React.useState("")
  // Lo que pasa el filtro, con el país principal del prefijo primero («44»: Reino Unido antes que Jersey).
  const shown = React.useMemo(() => {
    const { words, digits } = queryOf(query)
    if (!words && !digits) return items
    const found = items.filter((item) => (digits ? item.callingCode.startsWith(digits) : item.search.includes(words)))
    if (!digits) return found
    const main = mainCountryOfCallingCode(digits)
    return [...found.filter((item) => item.value === main), ...found.filter((item) => item.value !== main)]
  }, [items, query])

  return (
    <Combobox<CountryItem>
      items={shown}
      value={selected}
      inputValue={query}
      onInputValueChange={(next) => setQuery(next)}
      onValueChange={(item) => {
        setQuery("")
        if (item) onChange(item.value)
      }}
      onOpenChange={(open) => {
        if (!open) setQuery("")
      }}
      itemToStringLabel={(item) => `${item.label} (+${item.callingCode})`}
      isItemEqualToValue={(a, b) => a.value === b.value}
      // El filtro ya lo hizo `shown`: así el prefijo puede ordenar la lista.
      filter={null}
      // Con el teclado, Enter elige la primera coincidencia («reino» → Reino Unido).
      autoHighlight
      disabled={disabled}
    >
      <ComboboxTrigger
        id={id}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onBlur={onBlur}
        disabled={disabled}
        className={cn(
          "flex h-9 w-28 shrink-0 items-center justify-between gap-1.5 rounded-3xl border border-transparent bg-input/50 px-3 py-2 text-sm whitespace-nowrap text-foreground transition-[color,box-shadow,background-color] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20",
        )}
      >
        {`${value} +${getCountryCallingCode(value)}`}
      </ComboboxTrigger>
      <ComboboxContent className="w-72 min-w-72" aria-label="Países">
        <ComboboxInput showTrigger={false} aria-label="Buscar país" placeholder="Buscar país o prefijo…" />
        <ComboboxList aria-label="Países">
          {(item: CountryItem) => (
            <ComboboxItem key={item.value} value={item}>
              {`${item.label} (+${item.callingCode})`}
            </ComboboxItem>
          )}
        </ComboboxList>
        <ComboboxEmpty>{`Ningún país con «${query.trim()}»`}</ComboboxEmpty>
      </ComboboxContent>
    </Combobox>
  )
}

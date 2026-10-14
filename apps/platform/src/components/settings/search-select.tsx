import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@odentia/ui"
import { normalizeSearchText } from "@odentia/ui-patterns"
import { useMemo, useState } from "react"

interface SearchItem {
  value: string
  label: string
  /** Nombre y código, sin acentos y en minúsculas. */
  search: string
}

/**
 * Lista larga de la que se elige una opción por su nombre (país, moneda,
 * idioma): se guarda el código y nunca se teclea. Mismo comportamiento que el
 * selector de zona horaria: al entrar el campo se vacía para buscar y, al salir
 * sin elegir, vuelve el nombre de lo elegido.
 */
export function SearchSelect({
  id,
  label,
  value,
  options,
  onChange,
  placeholder = "Buscar…",
  invalid = false,
  disabled = false,
  "aria-describedby": describedBy,
}: {
  id: string
  /** Nombre del campo: lo anuncian el campo y su lista. */
  label: string
  value: string
  options: readonly { value: string; label: string }[]
  onChange: (value: string) => void
  placeholder?: string
  invalid?: boolean
  disabled?: boolean
  "aria-describedby"?: string
}) {
  // También se encuentra por el código (`pen`, `es-pe`), aunque no se muestre suelto.
  const items = useMemo<SearchItem[]>(
    () =>
      options.map((option) => ({
        ...option,
        search: normalizeSearchText(`${option.label} ${option.value}`),
      })),
    [options],
  )
  const selected = items.find((item) => item.value === value) ?? null
  // Lo tecleado se recuerda junto al valor para el que se tecleó: si el valor
  // cambia desde fuera (otro país propone otra moneda), vuelve a verse el nombre.
  const [typed, setTyped] = useState<{ text: string; forValue: string } | null>(null)
  const showingLabel = !typed || typed.forValue !== value
  const inputValue = showingLabel ? (selected?.label ?? "") : typed.text

  return (
    <Combobox
      items={items}
      value={selected}
      inputValue={inputValue}
      onInputValueChange={(next) => setTyped({ text: next, forValue: value })}
      onValueChange={(item) => {
        setTyped(null)
        if (item) onChange(item.value)
      }}
      itemToStringLabel={(item: SearchItem) => item.label}
      filter={(item: SearchItem, query: string) => {
        const needle = normalizeSearchText(query.trim())
        return !needle || item.search.includes(needle)
      }}
      disabled={disabled}
    >
      <ComboboxInput
        id={id}
        className="w-full"
        aria-label={label}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        placeholder={placeholder}
        triggerLabel={`Mostrar la lista: ${label}`}
        disabled={disabled}
        onFocus={() => {
          if (showingLabel) setTyped({ text: "", forValue: value })
        }}
        onBlur={() => setTyped(null)}
      />
      <ComboboxContent aria-label={label}>
        <ComboboxList aria-label={label}>
          {/* Hijo función: solo se montan las opciones que pasan el filtro. */}
          {(item: SearchItem) => (
            <ComboboxItem key={item.value} value={item}>
              {item.label}
            </ComboboxItem>
          )}
        </ComboboxList>
        <ComboboxEmpty>Sin coincidencias</ComboboxEmpty>
      </ComboboxContent>
    </Combobox>
  )
}

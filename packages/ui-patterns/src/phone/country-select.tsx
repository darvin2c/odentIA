import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@odentia/ui"
import * as React from "react"
import {
  type CountryCode,
  countryOptions,
  getCountryCallingCode,
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

/**
 * Selector de país del teléfono. El disparador muestra ISO + prefijo
 * (`PE +51`) porque el nombre completo no cabe en el ancho del campo; el
 * nombre va en las opciones, que salen de `Intl.DisplayNames`.
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
  const options = React.useMemo(
    () => countryOptions(value || regionCountry(), countries),
    [value, countries],
  )

  return (
    <Select<CountryCode>
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next)
      }}
      disabled={disabled}
    >
      <SelectTrigger
        id={id}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onBlur={onBlur}
        className="w-28 shrink-0"
      >
        <SelectValue>
          {(selected: CountryCode) => `${selected} +${getCountryCallingCode(selected)}`}
        </SelectValue>
      </SelectTrigger>
      <SelectContent className="min-w-44">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {`${option.label} (+${option.callingCode})`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

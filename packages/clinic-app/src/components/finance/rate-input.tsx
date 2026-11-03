/** Campo del cambio, dicho como se dice: «S/ [3.75] por USD 1». */
import { currencySymbol } from "@odentia/clinical"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@odentia/ui"

export function RateInput({
  id,
  business,
  other,
  locale,
  value,
  invalid,
  disabled,
  onChange,
  onBlur,
  "aria-describedby": describedBy,
}: {
  id?: string
  /** Moneda del negocio: la del cambio. */
  business: string
  /** La otra moneda: el cambio es por 1 de ella. */
  other: string
  locale: string
  value: string
  invalid?: boolean
  disabled?: boolean
  onChange: (value: string) => void
  onBlur?: () => void
  "aria-describedby"?: string
}): React.JSX.Element {
  return (
    <InputGroup>
      <InputGroupAddon>{currencySymbol(business, locale)}</InputGroupAddon>
      <InputGroupInput
        id={id}
        inputMode="decimal"
        autoComplete="off"
        className="tabular-nums"
        value={value}
        disabled={disabled}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
      />
      <InputGroupAddon align="inline-end">por {currencySymbol(other, locale)} 1</InputGroupAddon>
    </InputGroup>
  )
}

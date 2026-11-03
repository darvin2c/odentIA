/** Campo del cambio, dicho como se dice: «S/ [3.75] por USD 1». */
import { currencySymbol, formatExchangeRateInput } from "@odentia/clinical"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@odentia/ui"
import { FormField, useFieldContext } from "@odentia/ui-patterns"
import { rateIsFar } from "../../lib/finance-collect"

export function RateInput({
  id,
  name,
  className,
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
  name?: string
  className?: string
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
    <InputGroup className={className}>
      <InputGroupAddon>{currencySymbol(business, locale)}</InputGroupAddon>
      <InputGroupInput
        id={id}
        name={name}
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

/** El campo del cambio de un formulario, con su etiqueta, su ayuda y su error. Va dentro de `form.AppField`. */
export function RateField({
  id,
  label = "Cambio",
  description,
  className,
  business,
  other,
  locale,
}: {
  id?: string
  label?: string
  description?: string
  className?: string
  business: string
  other: string
  locale: string
}): React.JSX.Element {
  const field = useFieldContext<string>()
  return (
    <FormField id={id} label={label} description={description}>
      {(control) => (
        <RateInput
          id={control.id}
          name={control.name}
          className={className}
          business={business}
          other={other}
          locale={locale}
          value={field.state.value}
          invalid={control.invalid}
          aria-describedby={control.describedBy}
          onBlur={control.onBlur}
          onChange={(value) => field.handleChange(value)}
        />
      )}
    </FormField>
  )
}

/** Muy distinto del de hoy: se avisa, porque queda guardado, y nunca se frena. */
export function RateFarNote({
  rate,
  today,
  locale,
  keptIn,
}: {
  rate: string
  today: string
  locale: string
  /** Dónde queda: «en el ticket», «guardado». */
  keptIn: string
}): React.JSX.Element | null {
  if (!rateIsFar(rate, today)) return null
  return (
    <p role="status" className="rounded-xl bg-warning-soft px-3 py-2 text-sm font-medium">
      Es muy distinto del cambio de hoy ({formatExchangeRateInput(today, locale)}). Revísalo: este
      cambio queda {keptIn}.
    </p>
  )
}

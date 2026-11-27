import { cn, Input } from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import { type FieldControl, FormChoiceField, useFieldContext } from "@odentia/ui-patterns"
import type * as React from "react"
import { currencySymbol } from "./lib/tienda"

/**
 * Lo que gestorIA suma a los formularios comunes (`@odentia/ui-patterns`). El monto lleva el
 * símbolo de la moneda de la tienda delante. Va dentro de `field.Control`, que le pasa su
 * etiqueta, su ayuda y su error:
 *
 * ```tsx
 * <form.AppField name="price">
 *   {(field) => (
 *     <field.Control label="Precio">
 *       {(control) => (
 *         <MoneyInput control={control} currency={store.currency}
 *           value={field.state.value} onChange={field.handleChange} />
 *       )}
 *     </field.Control>
 *   )}
 * </form.AppField>
 * ```
 */
export function MoneyInput({
  control,
  currency,
  value,
  onChange,
  className,
  ...input
}: {
  control: FieldControl
  currency: string
  value: string
  onChange: (value: string) => void
  className?: string
} & Omit<
  React.ComponentProps<typeof Input>,
  | "id"
  | "name"
  | "value"
  | "onChange"
  | "onBlur"
  | "aria-invalid"
  | "aria-describedby"
  | "className"
>) {
  const symbol = currencySymbol(currency)
  return (
    <div className={cn("relative", className)}>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground"
      >
        {symbol}
      </span>
      <Input
        inputMode="decimal"
        {...input}
        {...control.props}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        /* «S/» cabe en pl-9; «US$» o «MX$» necesitan más, o el número queda debajo del símbolo. */
        className={symbol.length > 2 ? "pl-12" : "pl-9"}
      />
    </div>
  )
}

/**
 * Un interruptor dentro de un formulario de `useAppForm`, con el `Switch` común: su texto puede
 * decir cómo queda («Encendido: Sofi lo ofrece»). Va dentro de `form.AppField`:
 *
 * ```tsx
 * <form.AppField name="isActive">
 *   {() => <ToggleField label={(on) => (on ? "Encendido" : "Apagado")} />}
 * </form.AppField>
 * ```
 */
export function ToggleField({
  label,
  description,
  disabled,
}: {
  label: string | ((on: boolean) => string)
  description?: React.ReactNode
  disabled?: boolean
}) {
  const field = useFieldContext<boolean>()
  const on = field.state.value
  return (
    <FormChoiceField
      label={typeof label === "function" ? label(on) : label}
      description={description}
    >
      {(control) => (
        <Switch
          {...control.props}
          checked={on}
          disabled={disabled}
          onCheckedChange={(next) => field.handleChange(next)}
        />
      )}
    </FormChoiceField>
  )
}

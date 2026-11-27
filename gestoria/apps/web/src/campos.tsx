import { cn, Input } from "@odentia/ui"
import type { FieldControl } from "@odentia/ui-patterns"
import type * as React from "react"
import { currencySymbol } from "./lib/tienda"

/**
 * Lo único de los formularios que gestorIA suma a lo común (`@odentia/ui-patterns`): el monto
 * con el símbolo de la moneda de la tienda delante. Va dentro de `field.Control`, que le pasa su
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
  "id" | "name" | "value" | "onChange" | "onBlur" | "aria-invalid" | "aria-describedby" | "className"
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

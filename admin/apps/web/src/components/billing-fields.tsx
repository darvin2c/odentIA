/**
 * Campos compartidos de facturación (admin): selector de moneda por nombre
 * (se guarda el código ISO) y montos en unidades mayores convertidos con la
 * precisión de la moneda (sin "centavos" fijos).
 */
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@odentia/ui"

/** Dígitos de la moneda según Intl (sin listas propias). */
export function currencyDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    )
  } catch {
    return 2
  }
}

/** Texto en unidades mayores → unidad menor. null si no es un importe válido. */
export function majorToCents(text: string, currency: string): number | null {
  const amount = Number(text.trim().replace(/\s/g, "").replace(",", "."))
  if (!Number.isFinite(amount) || amount < 0) return null
  const cents = Math.round(amount * 10 ** currencyDigits(currency))
  return Number.isSafeInteger(cents) ? cents : null
}

/** Unidad menor → texto en unidades mayores para editar. */
export function centsToMajor(cents: number, currency: string): string {
  const value = cents / 10 ** currencyDigits(currency)
  return Number.isInteger(value) ? String(value) : String(value)
}

function currencyName(code: string): string {
  try {
    return new Intl.DisplayNames(["es"], { type: "currency" }).of(code) ?? code
  } catch {
    return code
  }
}

function supportedCurrencies(): string[] {
  if (typeof Intl === "object" && Intl !== null && "supportedValuesOf" in Intl) {
    const lookup: unknown = Intl.supportedValuesOf
    if (typeof lookup === "function") {
      const values: unknown = lookup("currency")
      if (Array.isArray(values)) {
        return values.filter((code): code is string => typeof code === "string")
      }
    }
  }
  return ["PEN", "USD", "EUR", "MXN", "CLP", "COP", "ARS"]
}

/**
 * Moneda por su nombre; se guarda el código ISO 4217. No pinta etiqueta ni
 * error: dentro de `field.Control` recibe `id`, `invalid`, `aria-describedby`
 * y `onBlur` del campo.
 */
export function CurrencySelect({
  id,
  value,
  onChange,
  invalid,
  onBlur,
  disabled,
  "aria-describedby": describedBy,
}: {
  id: string
  value: string
  onChange: (code: string) => void
  invalid?: boolean
  onBlur?: () => void
  disabled?: boolean
  "aria-describedby"?: string
}) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(code) => {
        if (code) onChange(code)
      }}
    >
      <SelectTrigger id={id} aria-invalid={invalid || undefined} aria-describedby={describedBy} onBlur={onBlur}>
        <SelectValue placeholder="Elige la moneda" />
      </SelectTrigger>
      <SelectContent>
        {supportedCurrencies().map((code) => (
          <SelectItem key={code} value={code}>
            {currencyName(code)} ({code})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Moneda para el panel (sin @odentia/clinical: el panel solo depende de ui/ui-patterns). */
export function currencyFractionDigits(currency: string): number {
  if (currency === "JPY" || currency === "CLP" || currency === "COP") return 0
  return 2
}

export function formatPlanMoney(cents: number, currency: string, locale = "es-PE"): string {
  const digits = currencyFractionDigits(currency)
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 10 ** digits)
  } catch {
    return `${cents} ${currency}`
  }
}

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
  if (!Number.isFinite(amount) || amount <= 0) return null
  const cents = Math.round(amount * 10 ** currencyDigits(currency))
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null
}

/** Unidad menor → texto en unidades mayores. */
export function centsToMajor(cents: number, currency: string): string {
  return String(cents / 10 ** currencyDigits(currency))
}

/** Precio por acción en millonésimas: hasta tres decimales (USD 0,425). */
export function formatMicros(micros: number, currency: string, locale = "es-PE"): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 3,
    }).format(micros / 1_000_000)
  } catch {
    return `${micros / 1_000_000} ${currency}`
  }
}

/** «10 %» desde puntos básicos. */
export function formatBps(bps: number, locale = "es-PE"): string {
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bps / 100)} %`
}

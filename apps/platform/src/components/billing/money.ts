import { currencyFractionDigits, formatMoney } from "@odentia/clinical"
import { activeOrgLocale } from "../../lib/locale"

/**
 * Montos de Plan y pagos con el formato de la clínica (issue 36): el idioma
 * y país de su perfil, no los de Perú. Sin perfil cargado, el español sin país.
 */
function clinicLocale(locale?: string): string {
  return locale ?? activeOrgLocale() ?? "es"
}

export function formatPlanMoney(cents: number, currency: string, locale?: string): string {
  try {
    return formatMoney(Math.round(cents), currency, clinicLocale(locale))
  } catch {
    return `${cents} ${currency}`
  }
}

/** Dígitos de la moneda según ISO 4217 (los mismos que en el resto de la aplicación). */
export function currencyDigits(currency: string): number {
  try {
    return currencyFractionDigits(currency)
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
export function formatMicros(micros: number, currency: string, locale?: string): string {
  try {
    return new Intl.NumberFormat(clinicLocale(locale), {
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
export function formatBps(bps: number, locale?: string): string {
  return `${new Intl.NumberFormat(clinicLocale(locale), { maximumFractionDigits: 1 }).format(bps / 100)} %`
}

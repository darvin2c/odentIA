import { currencyFractionDigits, formatMoney, formatMoneyInput, parseMoney } from "@odentia/clinical"
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

/**
 * Lo escrito en unidades mayores → unidad menor, con los separadores de la
 * clínica, los mismos con que se muestra: «50.000» son cincuenta mil en Chile.
 * null si no es un importe válido.
 */
export function majorToCents(text: string, currency: string, locale?: string): number | null {
  try {
    const cents = parseMoney(text, currency, clinicLocale(locale))
    return cents > 0 ? cents : null
  } catch {
    return null
  }
}

/** Unidad menor → texto para editar, el que lee `majorToCents`. */
export function centsToMajor(cents: number, currency: string, locale?: string): string {
  try {
    return formatMoneyInput(cents, currency, clinicLocale(locale))
  } catch {
    return String(cents / 10 ** currencyDigits(currency))
  }
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

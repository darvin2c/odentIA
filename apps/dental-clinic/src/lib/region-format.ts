import { currencyFractionDigits, formatMoney } from "@odentia/clinical"

/**
 * Moneda e idioma dichos con su nombre. Se guardan los códigos de siempre
 * (ISO 4217, BCP 47); los nombres salen de los datos de referencia del entorno
 * (`Intl`, Unicode CLDR), no de una tabla propia.
 */

/** Una opción de un selector: lo que se guarda y lo que se lee. */
export interface NamedOption {
  value: string
  label: string
}

/** La interfaz está en español: los nombres también, con la variante de la clínica si es española. */
export function displayLanguage(orgLocale: string | undefined): string {
  return orgLocale?.toLowerCase().startsWith("es") ? orgLocale : "es"
}

function capitalize(text: string, language: string): string {
  return text.charAt(0).toLocaleUpperCase(language) + text.slice(1)
}

/** «Sol peruano (PEN)»; un código sin nombre conocido se lee tal cual. */
export function currencyLabel(code: string, language: string): string {
  try {
    const name = new Intl.DisplayNames([language], { type: "currency", fallback: "none" }).of(code)
    return name ? `${capitalize(name, language)} (${code})` : code
  } catch {
    return code
  }
}

/**
 * Las monedas que conoce el entorno, por nombre. La guardada va siempre, aunque
 * el entorno no la liste: un valor guardado nunca se esconde.
 */
export function currencyOptions(language: string, saved?: string): NamedOption[] {
  const codes = new Set<string>(Intl.supportedValuesOf("currency"))
  if (saved) codes.add(saved)
  const collator = new Intl.Collator(language, { sensitivity: "base" })
  return [...codes]
    .map((code) => ({ value: code, label: currencyLabel(code, language) }))
    .sort((a, b) => collator.compare(a.label, b.label))
}

/** «Español (Perú)»: el idioma con su región, como lo escribe la interfaz. */
export function localeLabel(tag: string, language: string): string {
  try {
    const name = new Intl.DisplayNames([language], {
      type: "language",
      languageDisplay: "standard",
      fallback: "none",
    }).of(tag)
    return name ? capitalize(name, language) : tag
  } catch {
    return tag
  }
}

/**
 * Los formatos que el servidor ofrece para el país, en su orden (el propuesto
 * primero). El guardado va siempre, aunque no sea de ese país.
 */
export function localeOptions(
  offered: readonly string[],
  saved: string,
  language: string,
): NamedOption[] {
  const tags = [...new Set([...offered, ...(saved ? [saved] : [])])]
  return tags.map((tag) => ({ value: tag, label: localeLabel(tag, language) }))
}

/** Una fecha, una hora y un importe escritos con lo elegido en el formulario. */
export interface RegionPreview {
  date: string
  time: string
  amount: string
}

/** Importe del ejemplo, en la unidad mayor de la moneda. */
const SAMPLE_AMOUNT = 1250

/**
 * Cómo se verán una fecha, una hora y un importe con ese formato, esa zona y
 * esa moneda: las mismas opciones con las que la aplicación escribe la fecha
 * corta y la hora. `null` mientras falte elegir algo o no sea válido.
 */
export function regionPreview(
  now: Date,
  region: { locale: string; timeZone: string; currency: string },
): RegionPreview | null {
  if (!region.locale || !region.timeZone || !region.currency) return null
  try {
    const zone = { timeZone: region.timeZone }
    const minor = SAMPLE_AMOUNT * 10 ** currencyFractionDigits(region.currency)
    return {
      date: new Intl.DateTimeFormat(region.locale, {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        ...zone,
      }).format(now),
      time: new Intl.DateTimeFormat(region.locale, {
        hour: "2-digit",
        minute: "2-digit",
        ...zone,
      }).format(now),
      amount: formatMoney(minor, region.currency, region.locale),
    }
  } catch {
    return null
  }
}

/** «Perú»: el país con su nombre; un código que el entorno no nombra se lee tal cual. */
export function countryName(code: string, language: string): string {
  try {
    return new Intl.DisplayNames([language], { type: "region", fallback: "none" }).of(code) ?? code
  } catch {
    return code
  }
}

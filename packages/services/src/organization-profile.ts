import {
  clinicalProfileFor,
  currencyFractionDigits,
  isSelectableDiagnosisSystem,
  type SelectableDiagnosisSystem,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { auditEvent, orgProfile } from "@odentia/db/schema/org"
import { eq, sql } from "drizzle-orm"
import { ServiceError, notFound, validation } from "./errors.js"
import { ensureDefaultPaymentMethods } from "./payment-methods.js"

type OrgProfileRow = typeof orgProfile.$inferSelect

/** Anchos de ticket térmico admitidos (mm). */
export const RECEIPT_WIDTHS = ["58", "80"] as const
export type ReceiptWidth = (typeof RECEIPT_WIDTHS)[number]

/** Tamaños de hoja para el presupuesto. */
export const SHEET_SIZES = ["A4", "Letter"] as const
export type SheetSize = (typeof SHEET_SIZES)[number]

/**
 * Propuesta regional al elegir país. No es un «perfil» por país escrito a
 * mano: sale de datos de referencia de Unicode CLDR (moneda de curso legal,
 * papel) y sirve para cualquier país. Lo que no se puede deducir con
 * seguridad queda en `null` y lo completa la persona; todo se puede cambiar.
 */
export interface RegionDefaults {
  /** ISO 4217 de curso legal; `null` si el país no está en la tabla. */
  currency: string | null
  /** BCP 47: idioma principal del país (o el indicado) con su región. */
  locale: string
  /**
   * BCP 47 que se ofrecen para ese país, el propuesto primero. Quien los
   * muestra escribe su nombre («Español (Perú)»); nadie teclea el código.
   */
  locales: string[]
  /** IANA; `null` cuando el país tiene varias zonas o no está en la tabla. */
  timezone: string | null
  sheetSize: SheetSize
}

/** Moneda de curso legal por país (CLDR `currencyData`, vigente). */
const COUNTRY_CURRENCY: Record<string, string> = {
  // América
  AR: "ARS", BB: "BBD", BO: "BOB", BR: "BRL", BS: "BSD", BZ: "BZD", CA: "CAD", CL: "CLP",
  CO: "COP", CR: "CRC", CU: "CUP", DO: "DOP", EC: "USD", GT: "GTQ", GY: "GYD", HN: "HNL",
  HT: "HTG", JM: "JMD", MX: "MXN", NI: "NIO", PA: "PAB", PE: "PEN", PR: "USD", PY: "PYG",
  SR: "SRD", SV: "USD", TT: "TTD", US: "USD", UY: "UYU", VE: "VES",
  // Zona euro y quienes usan el euro
  AD: "EUR", AT: "EUR", BE: "EUR", BG: "EUR", CY: "EUR", DE: "EUR", EE: "EUR", ES: "EUR",
  FI: "EUR", FR: "EUR", GR: "EUR", HR: "EUR", IE: "EUR", IT: "EUR", LT: "EUR", LU: "EUR",
  LV: "EUR", MC: "EUR", ME: "EUR", MT: "EUR", NL: "EUR", PT: "EUR", SI: "EUR", SK: "EUR",
  SM: "EUR", VA: "EUR", XK: "EUR",
  // Resto de Europa
  CH: "CHF", CZ: "CZK", DK: "DKK", GB: "GBP", HU: "HUF", IS: "ISK", NO: "NOK", PL: "PLN",
  RO: "RON", RS: "RSD", RU: "RUB", SE: "SEK", TR: "TRY", UA: "UAH",
  // África, Asia y Oceanía
  AE: "AED", AU: "AUD", CN: "CNY", EG: "EGP", GQ: "XAF", HK: "HKD", ID: "IDR", IL: "ILS",
  IN: "INR", JP: "JPY", KE: "KES", KR: "KRW", KW: "KWD", MA: "MAD", MY: "MYR", NG: "NGN",
  NZ: "NZD", PH: "PHP", QA: "QAR", SA: "SAR", SG: "SGD", TH: "THB", TW: "TWD", VN: "VND",
  ZA: "ZAR",
}

/** Idioma principal para el formato de números y fechas (no traduce la interfaz). */
const COUNTRY_LANGUAGE: Record<string, string> = {
  AR: "es", BO: "es", CL: "es", CO: "es", CR: "es", CU: "es", DO: "es", EC: "es", ES: "es",
  GQ: "es", GT: "es", HN: "es", MX: "es", NI: "es", PA: "es", PE: "es", PR: "es", PY: "es",
  SV: "es", UY: "es", VE: "es",
  AO: "pt", BR: "pt", MZ: "pt", PT: "pt",
  AU: "en", BB: "en", BS: "en", BZ: "en", CA: "en", GB: "en", GY: "en", IE: "en", IN: "en",
  JM: "en", KE: "en", NG: "en", NZ: "en", PH: "en", SG: "en", TT: "en", US: "en", ZA: "en",
  AT: "de", DE: "de", FR: "fr", HT: "fr", IT: "it", NL: "nl",
}

/**
 * Idiomas en los que se ofrece escribir fechas y números, combinados con el
 * país de la clínica. No traducen la interfaz; son los de `COUNTRY_LANGUAGE`.
 */
const FORMAT_LANGUAGES = ["es", "en", "pt", "fr", "de", "it", "nl"] as const

/** Países donde la hoja habitual es Carta (CLDR `paperSize` US-Letter); el resto usa A4 (ISO 216). */
const LETTER_COUNTRIES = new Set([
  "BZ", "CA", "CL", "CO", "CR", "GT", "MX", "NI", "PA", "PH", "PR", "SV", "US", "VE",
])

/** Zona horaria cuando el país tiene una sola de uso general. */
const COUNTRY_TIMEZONE: Record<string, string> = {
  AR: "America/Argentina/Buenos_Aires", BO: "America/La_Paz", CL: "America/Santiago",
  CO: "America/Bogota", CR: "America/Costa_Rica", CU: "America/Havana",
  DO: "America/Santo_Domingo", EC: "America/Guayaquil", ES: "Europe/Madrid",
  GT: "America/Guatemala", HN: "America/Tegucigalpa", NI: "America/Managua",
  PA: "America/Panama", PE: "America/Lima", PR: "America/Puerto_Rico", PY: "America/Asuncion",
  SV: "America/El_Salvador", UY: "America/Montevideo", VE: "America/Caracas",
}

/**
 * Lo que se propone al elegir país. `language` es el idioma de respaldo
 * cuando el país no tiene uno principal conocido (el del perfil actual).
 */
export function regionPresetForCountry(countryCode: string, language = "es"): RegionDefaults {
  const code = countryCode.trim().toUpperCase()
  const locale = `${COUNTRY_LANGUAGE[code] ?? language}-${code}`
  return {
    currency: COUNTRY_CURRENCY[code] ?? null,
    locale,
    locales: [...new Set([locale, ...FORMAT_LANGUAGES.map((item) => `${item}-${code}`)])],
    timezone: COUNTRY_TIMEZONE[code] ?? null,
    sheetSize: LETTER_COUNTRIES.has(code) ? "Letter" : "A4",
  }
}

function assertCountryCode(value: string | null | undefined): string {
  const code = (value ?? "").trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(code)) throw validation("countryCode debe ser ISO 3166 de 2 letras")
  return code
}

function assertCurrency(value: string | null | undefined): string {
  const code = (value ?? "").trim().toUpperCase()
  try {
    currencyFractionDigits(code)
  } catch {
    throw validation("La moneda debe ser un código ISO 4217 válido")
  }
  return code
}

function assertLocale(value: string | null | undefined): string {
  const locale = (value ?? "").trim()
  try {
    const canonical = Intl.getCanonicalLocales(locale)[0]
    if (!canonical) throw new Error("Idioma vacío")
    return canonical
  } catch {
    throw validation("El idioma y formato debe ser una etiqueta BCP 47 válida")
  }
}

function assertTimezone(value: string | null | undefined): string {
  const zone = (value ?? "").trim()
  if (!zone || zone.length > 80) throw validation("timezone es obligatorio (IANA)")
  try {
    Intl.DateTimeFormat("en", { timeZone: zone })
  } catch {
    throw validation("timezone debe ser un identificador IANA válido")
  }
  return zone
}

function assertReceiptWidth(value: string | null | undefined): ReceiptWidth {
  const width = (value ?? "80").trim()
  if (width !== "58" && width !== "80") throw validation("receiptWidth debe ser 58|80")
  return width
}

function assertSheetSize(value: string | null | undefined): SheetSize {
  const size = (value ?? "A4").trim()
  if (size !== "A4" && size !== "Letter") throw validation("sheetSize debe ser A4|Letter")
  return size
}

function assertTicketFooter(value: string | null | undefined): string {
  const footer = (value ?? "Recibo interno. No es un documento fiscal.").trim()
  if (!footer || footer.length > 280) {
    throw validation("ticketFooter debe tener 1–280 caracteres")
  }
  return footer
}

export interface UpdateOrgRegionInput {
  countryCode?: string | null
  currency?: string | null
  locale?: string | null
  timezone?: string | null
  receiptWidth?: string | null
  sheetSize?: string | null
  ticketFooter?: string | null
  /** Al cambiar de país se proponen moneda/formato/papel; todo se puede cambiar. */
  applyCountryPreset?: boolean
}
/** Perfil regional completo con el que nace `org_profile`. */
export interface InitialOrgRegion {
  countryCode: string
  currency: string
  timezone: string
  locale: string
  sheetSize: SheetSize
  /** La lista de diagnósticos que recomienda su país (decisión 26); la clínica la puede cambiar. */
  diagnosisSystem: SelectableDiagnosisSystem
}

/**
 * Región con la que se crea el perfil de una clínica. La base no tiene valores
 * por defecto de ningún país: el país se indica siempre y de él se deriva lo
 * demás (`regionPresetForCountry`); lo indicado a mano manda, y lo que no se
 * puede deducir (moneda desconocida, país con varias zonas) se exige.
 */
export function initialOrgRegion(
  input: Pick<UpdateOrgRegionInput, "countryCode" | "currency" | "timezone" | "locale" | "sheetSize">,
): InitialOrgRegion {
  if (!input.countryCode?.trim()) throw validation("Indica el país de la clínica")
  const countryCode = assertCountryCode(input.countryCode)
  let language = "es"
  if (input.locale) {
    try {
      language = new Intl.Locale(input.locale).language
    } catch {
      // Se valida abajo con su propio mensaje.
    }
  }
  const preset = regionPresetForCountry(countryCode, language)
  if (!input.currency && !preset.currency) {
    throw validation("Indica la moneda de la clínica: no la conocemos para ese país")
  }
  if (!input.timezone && !preset.timezone) {
    throw validation("Indica la zona horaria de la clínica: ese país tiene más de una")
  }
  return {
    countryCode,
    currency: assertCurrency(input.currency || preset.currency),
    timezone: assertTimezone(input.timezone || preset.timezone),
    locale: assertLocale(input.locale || preset.locale),
    sheetSize: input.sheetSize ? assertSheetSize(input.sheetSize) : preset.sheetSize,
    diagnosisSystem: recommendedSelectableSystem(countryCode),
  }
}

/** La lista que recomienda el país, entre las que una clínica puede elegir. */
function recommendedSelectableSystem(countryCode: string): SelectableDiagnosisSystem {
  const recommended = clinicalProfileFor(countryCode).diagnosis.recommended
  return isSelectableDiagnosisSystem(recommended) ? recommended : "ICD-10"
}

/**
 * La moneda no reinterpreta históricos: si existen cargos, pagos,
 * presupuestos o turnos en otra moneda, el cambio se bloquea (409
 * CURRENCY_HISTORY_EXISTS) salvo procedimiento de migración explícito.
 * No se convierten importes existentes.
 */
export async function assertNoForeignCurrencyHistory(
  tx: Db,
  orgId: string,
  nextCurrency: string,
): Promise<void> {
  const tables = ["patient_charge", "patient_payment", "treatment_budget", "cash_shift", "expense", "service_catalog", "treatment_plan_item"] as const
  for (const table of tables) {
    const rows = await tx.execute<{ found: number }>(sql`
      select 1 as "found" from ${sql.identifier(table)}
      where "organization_id" = ${orgId} and "currency" <> ${nextCurrency} limit 1`)
    if (rows.length > 0) {
      throw new ServiceError(
        "CURRENCY_HISTORY_EXISTS",
        409,
        "La clínica ya tiene movimientos en otra moneda: el cambio requiere migración explícita",
      )
    }
  }
}

/**
 * Guarda región e impresión sin reinterpretar importes. El alta del perfil y
 * este cambio comparten transacción; los medios iniciales salen del país.
 */
export async function updateOrgRegion(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: UpdateOrgRegionInput,
): Promise<OrgProfileRow> {
  const [current] = await tx
    .select()
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .limit(1)
    .for("update")
  if (!current) throw notFound("Perfil de organización")
  const set: Partial<typeof orgProfile.$inferInsert> = {}
  const fields: string[] = []
  let countryCode = current.countryCode
  if (input.countryCode !== undefined && input.countryCode !== null) {
    countryCode = assertCountryCode(input.countryCode)
    set.countryCode = countryCode
    fields.push("countryCode")
  }
  if (input.applyCountryPreset) {
    // Lo que el país propone; cada valor indicado a mano lo reemplaza abajo.
    // Sirve para cualquier país: solo se pide lo que no se puede deducir.
    let language = "es"
    try {
      language = new Intl.Locale(current.locale).language
    } catch {
      // Idioma guardado ilegible: vale el de respaldo.
    }
    const preset = regionPresetForCountry(countryCode, language)
    if (preset.currency) {
      set.currency = preset.currency
      fields.push("currency")
    } else if (!input.currency) {
      throw validation("Indica la moneda de la clínica: no la conocemos para ese país")
    }
    if (preset.timezone) {
      set.timezone = preset.timezone
      fields.push("timezone")
    } else if (!input.timezone) {
      throw validation("Indica la zona horaria de la clínica: ese país tiene más de una")
    }
    set.locale = preset.locale
    set.sheetSize = preset.sheetSize
    fields.push("locale", "sheetSize")
  }
  if (input.currency !== undefined && input.currency !== null) {
    set.currency = assertCurrency(input.currency)
    fields.push("currency")
  }
  if (input.locale !== undefined && input.locale !== null) {
    set.locale = assertLocale(input.locale)
    fields.push("locale")
  }
  if (input.timezone !== undefined && input.timezone !== null) {
    set.timezone = assertTimezone(input.timezone)
    fields.push("timezone")
  }
  if (input.receiptWidth !== undefined && input.receiptWidth !== null) {
    set.receiptWidth = assertReceiptWidth(input.receiptWidth)
    fields.push("receiptWidth")
  }
  if (input.sheetSize !== undefined && input.sheetSize !== null) {
    set.sheetSize = assertSheetSize(input.sheetSize)
    fields.push("sheetSize")
  }
  if (input.ticketFooter !== undefined && input.ticketFooter !== null) {
    set.ticketFooter = assertTicketFooter(input.ticketFooter)
    fields.push("ticketFooter")
  }
  if (fields.length === 0) {
    await ensureDefaultPaymentMethods(tx, orgId, actorUserId, current.countryCode)
    return current
  }
  if (set.currency && set.currency !== current.currency) {
    await assertNoForeignCurrencyHistory(tx, orgId, set.currency)
  }
  const [updated] = await tx
    .update(orgProfile)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(orgProfile.organizationId, orgId))
    .returning()
  if (!updated) throw notFound("Perfil de organización")
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "settings.region_updated",
    entity: "org_profile",
    entityId: orgId,
    metadata: { fields },
  })
  await ensureDefaultPaymentMethods(tx, orgId, actorUserId, updated.countryCode)
  return updated
}

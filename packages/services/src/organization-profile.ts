import {
  clinicalProfileFor,
  type CurrencyInUse,
  currencyFractionDigits,
  currencyRemovalWords,
  exchangeFactor,
  isSelectableDiagnosisSystem,
  normalizeExchangeRate,
  type SelectableDiagnosisSystem,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { auditEvent, orgProfile } from "@odentia/db/schema/org"
import { eq, sql } from "drizzle-orm"
import { type OrgTaxInput, taxColumnsFor } from "./clinic-taxes.js"
import { invalidField, notFound, ServiceError } from "./errors.js"
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
  /**
   * BCP 47: español con la región del país (`es-PE`, `es-BR`). odentIA, sus
   * mensajes y sus documentos están en español: una fecha escrita en otro
   * idioma quedaría en medio de una frase en español (#48).
   */
  locale: string
  /** IANA; `null` cuando el país tiene varias zonas o no está en la tabla. */
  timezone: string | null
  sheetSize: SheetSize
}

/** Moneda de curso legal por país (CLDR `currencyData`, vigente). */
const COUNTRY_CURRENCY: Record<string, string> = {
  // América
  AR: "ARS",
  BB: "BBD",
  BO: "BOB",
  BR: "BRL",
  BS: "BSD",
  BZ: "BZD",
  CA: "CAD",
  CL: "CLP",
  CO: "COP",
  CR: "CRC",
  CU: "CUP",
  DO: "DOP",
  EC: "USD",
  GT: "GTQ",
  GY: "GYD",
  HN: "HNL",
  HT: "HTG",
  JM: "JMD",
  MX: "MXN",
  NI: "NIO",
  PA: "PAB",
  PE: "PEN",
  PR: "USD",
  PY: "PYG",
  SR: "SRD",
  SV: "USD",
  TT: "TTD",
  US: "USD",
  UY: "UYU",
  VE: "VES",
  // Zona euro y quienes usan el euro
  AD: "EUR",
  AT: "EUR",
  BE: "EUR",
  BG: "EUR",
  CY: "EUR",
  DE: "EUR",
  EE: "EUR",
  ES: "EUR",
  FI: "EUR",
  FR: "EUR",
  GR: "EUR",
  HR: "EUR",
  IE: "EUR",
  IT: "EUR",
  LT: "EUR",
  LU: "EUR",
  LV: "EUR",
  MC: "EUR",
  ME: "EUR",
  MT: "EUR",
  NL: "EUR",
  PT: "EUR",
  SI: "EUR",
  SK: "EUR",
  SM: "EUR",
  VA: "EUR",
  XK: "EUR",
  // Resto de Europa
  CH: "CHF",
  CZ: "CZK",
  DK: "DKK",
  GB: "GBP",
  HU: "HUF",
  IS: "ISK",
  NO: "NOK",
  PL: "PLN",
  RO: "RON",
  RS: "RSD",
  RU: "RUB",
  SE: "SEK",
  TR: "TRY",
  UA: "UAH",
  // África, Asia y Oceanía
  AE: "AED",
  AU: "AUD",
  CN: "CNY",
  EG: "EGP",
  GQ: "XAF",
  HK: "HKD",
  ID: "IDR",
  IL: "ILS",
  IN: "INR",
  JP: "JPY",
  KE: "KES",
  KR: "KRW",
  KW: "KWD",
  MA: "MAD",
  MY: "MYR",
  NG: "NGN",
  NZ: "NZD",
  PH: "PHP",
  QA: "QAR",
  SA: "SAR",
  SG: "SGD",
  TH: "THB",
  TW: "TWD",
  VN: "VND",
  ZA: "ZAR",
}

/** Países donde la hoja habitual es Carta (CLDR `paperSize` US-Letter); el resto usa A4 (ISO 216). */
const LETTER_COUNTRIES = new Set([
  "BZ",
  "CA",
  "CL",
  "CO",
  "CR",
  "GT",
  "MX",
  "NI",
  "PA",
  "PH",
  "PR",
  "SV",
  "US",
  "VE",
])

/** Zona horaria cuando el país tiene una sola de uso general. */
const COUNTRY_TIMEZONE: Record<string, string> = {
  AR: "America/Argentina/Buenos_Aires",
  BO: "America/La_Paz",
  CL: "America/Santiago",
  CO: "America/Bogota",
  CR: "America/Costa_Rica",
  CU: "America/Havana",
  DO: "America/Santo_Domingo",
  EC: "America/Guayaquil",
  ES: "Europe/Madrid",
  GT: "America/Guatemala",
  HN: "America/Tegucigalpa",
  NI: "America/Managua",
  PA: "America/Panama",
  PE: "America/Lima",
  PR: "America/Puerto_Rico",
  PY: "America/Asuncion",
  SV: "America/El_Salvador",
  UY: "America/Montevideo",
  VE: "America/Caracas",
}

/** Lo que se propone al elegir país. */
export function regionPresetForCountry(countryCode: string): RegionDefaults {
  const code = countryCode.trim().toUpperCase()
  return {
    currency: COUNTRY_CURRENCY[code] ?? null,
    locale: `es-${code}`,
    timezone: COUNTRY_TIMEZONE[code] ?? null,
    sheetSize: LETTER_COUNTRIES.has(code) ? "Letter" : "A4",
  }
}

function assertCountryCode(value: string | null | undefined): string {
  const code = (value ?? "").trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(code)) throw invalidField("countryCode", "Elige el país de la lista")
  return code
}

function assertCurrency(value: string | null | undefined, field = "currency"): string {
  const code = (value ?? "").trim().toUpperCase()
  try {
    currencyFractionDigits(code)
  } catch {
    throw invalidField(field, "Elige la moneda de la lista")
  }
  return code
}

function assertLocale(value: string | null | undefined): string {
  const locale = (value ?? "").trim()
  try {
    const canonical = Intl.getCanonicalLocales(locale)[0]
    if (!canonical) throw new Error("Idioma vacío")
    if (new Intl.Locale(canonical).language !== "es")
      throw invalidField(
        "locale",
        "odentIA está en español: el formato es el español del país de la clínica",
      )
    return canonical
  } catch (error) {
    if (error instanceof ServiceError) throw error
    throw invalidField("locale", "El idioma y formato debe ser una etiqueta BCP 47 válida")
  }
}

function assertTimezone(value: string | null | undefined): string {
  const zone = (value ?? "").trim()
  if (!zone || zone.length > 80)
    throw invalidField("timezone", "Elige la zona horaria de la clínica")
  try {
    Intl.DateTimeFormat("en", { timeZone: zone })
  } catch {
    throw invalidField("timezone", "Elige la zona horaria de la lista")
  }
  return zone
}

function assertReceiptWidth(value: string | null | undefined): ReceiptWidth {
  const width = (value ?? "80").trim()
  if (width !== "58" && width !== "80")
    throw invalidField("receiptWidth", "Elige el ancho del ticket: 58 u 80 mm")
  return width
}

function assertSheetSize(value: string | null | undefined): SheetSize {
  const size = (value ?? "A4").trim()
  if (size !== "A4" && size !== "Letter")
    throw invalidField("sheetSize", "Elige el tamaño de hoja: A4 o Carta")
  return size
}

function assertTicketFooter(value: string | null | undefined): string {
  const footer = (value ?? "Recibo interno. No es un documento fiscal.").trim()
  if (!footer) throw invalidField("ticketFooter", "Escribe la frase al pie del ticket")
  if (footer.length > 280)
    throw invalidField("ticketFooter", "La frase al pie admite hasta 280 caracteres")
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
  /** Días de vigencia del presupuesto al entregarlo (1 a 365). */
  budgetValidDays?: number | null
  /** «Cómo se paga» y «Si el importe cambia»: vacíos, esa sección no sale. */
  budgetPaymentTerms?: string | null
  budgetChangeTerms?: string | null
  /** Al cambiar de país se proponen moneda/formato/papel; todo se puede cambiar. */
  applyCountryPreset?: boolean
  /** Impuestos de lo cobrado (ADR 0083): null en una cifra es volver a lo del país. */
  taxes?: OrgTaxInput | null
  /** La otra moneda: omitida, sigue la que hay; `null`, deja de cobrar en ella. */
  secondCurrency?: string | null
  /** El «Cambio de hoy», en texto decimal; lo escribe `setOrgExchangeRate`. */
  exchangeRate?: string | null
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
  input: Pick<
    UpdateOrgRegionInput,
    "countryCode" | "currency" | "timezone" | "locale" | "sheetSize"
  >,
): InitialOrgRegion {
  if (!input.countryCode?.trim()) throw invalidField("countryCode", "Indica el país de la clínica")
  const countryCode = assertCountryCode(input.countryCode)
  const preset = regionPresetForCountry(countryCode)
  if (!input.currency && !preset.currency) {
    throw invalidField("currency", "Indica la moneda de la clínica: no la conocemos para ese país")
  }
  if (!input.timezone && !preset.timezone) {
    throw invalidField(
      "timezone",
      "Indica la zona horaria de la clínica: ese país tiene más de una",
    )
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

/** Dónde guarda una moneda lo que hace la clínica. Un dato nuevo con moneda se agrega aquí. */
const CURRENCY_COLUMNS = [
  ["patient_charge", "currency"],
  ["patient_payment", "currency"],
  ["patient_payment", "tender_currency"],
  ["treatment_budget", "currency"],
  ["treatment_budget_item", "currency"],
  ["cash_shift", "currency"],
  ["expense", "currency"],
  ["expense", "tender_currency"],
  ["expense_recurring", "currency"],
  ["service_catalog", "currency"],
  ["treatment_plan_item", "currency"],
  ["opportunity", "currency"],
  ["promotion_service_price", "currency"],
  ["product", "sale_currency"],
  ["purchase_order", "currency"],
  ["commission_settlement", "currency"],
] as const

/**
 * La moneda no reinterpreta históricos: si existen cargos, pagos, presupuestos,
 * turnos, oportunidades, promociones, productos, compras o comisiones en otra
 * moneda, el cambio se bloquea (409 CURRENCY_HISTORY_EXISTS) salvo procedimiento
 * de migración explícito. No se convierten importes existentes. Con `second`, la
 * otra moneda de la clínica tampoco cuenta: dos monedas como máximo, nunca una tercera.
 */
export async function assertNoForeignCurrencyHistory(
  tx: Db,
  orgId: string,
  nextCurrency: string,
  options: { second: string; field: string } | null = null,
): Promise<void> {
  for (const [table, column] of CURRENCY_COLUMNS) {
    const rows = await tx.execute<{ found: string }>(sql`
      select trim(${sql.identifier(column)}::text) as "found" from ${sql.identifier(table)}
      where "organization_id" = ${orgId} and ${sql.identifier(column)} <> ${nextCurrency}
        ${options ? sql`and ${sql.identifier(column)} <> ${options.second}` : sql``}
      limit 1`)
    const found = rows[0]?.found
    if (found) {
      const message = options
        ? `La clínica ya tiene movimientos en ${found}: es la única otra moneda en que puede cobrar`
        : "La clínica ya tiene movimientos en otra moneda: el cambio requiere migración explícita"
      throw new ServiceError("CURRENCY_HISTORY_EXISTS", 409, message, {
        [options?.field ?? "currency"]: message,
      })
    }
  }
}

/**
 * Guarda región, impresión y la otra moneda sin reinterpretar importes. El alta del
 * perfil y este cambio comparten transacción; los medios iniciales salen del país.
 * Quitar la otra moneda va primero: con ella activa, la del negocio no cambia.
 */
export async function updateOrgRegion(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: UpdateOrgRegionInput,
): Promise<OrgProfileRow> {
  const { secondCurrency, exchangeRate, ...region } = input
  if (secondCurrency === null) await setOrgExchangeRate(tx, orgId, actorUserId, { secondCurrency })
  const updated = await writeOrgRegion(tx, orgId, actorUserId, region)
  return secondCurrency || exchangeRate
    ? setOrgExchangeRate(tx, orgId, actorUserId, { secondCurrency, exchangeRate })
    : updated
}

async function writeOrgRegion(
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
    const preset = regionPresetForCountry(countryCode)
    if (preset.currency) {
      set.currency = preset.currency
      fields.push("currency")
    } else if (!input.currency) {
      throw invalidField(
        "currency",
        "Indica la moneda de la clínica: no la conocemos para ese país",
      )
    }
    if (preset.timezone) {
      set.timezone = preset.timezone
      fields.push("timezone")
    } else if (!input.timezone) {
      throw invalidField(
        "timezone",
        "Indica la zona horaria de la clínica: ese país tiene más de una",
      )
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
  if (input.budgetValidDays !== undefined && input.budgetValidDays !== null) {
    if (
      !Number.isInteger(input.budgetValidDays) ||
      input.budgetValidDays < 1 ||
      input.budgetValidDays > 365
    )
      throw invalidField("budgetValidDays", "La vigencia del presupuesto va de 1 a 365 días")
    set.budgetValidDays = input.budgetValidDays
    fields.push("budgetValidDays")
  }
  if (input.budgetPaymentTerms !== undefined) {
    set.budgetPaymentTerms = input.budgetPaymentTerms?.trim() || null
    fields.push("budgetPaymentTerms")
  }
  if (input.budgetChangeTerms !== undefined) {
    set.budgetChangeTerms = input.budgetChangeTerms?.trim() || null
    fields.push("budgetChangeTerms")
  }
  if (input.ticketFooter !== undefined && input.ticketFooter !== null) {
    set.ticketFooter = assertTicketFooter(input.ticketFooter)
    fields.push("ticketFooter")
  }
  if (input.taxes !== undefined && input.taxes !== null) {
    // Solo queda lo que difiere de lo del país (ADR 0083).
    Object.assign(set, taxColumnsFor(countryCode, input.taxes))
    fields.push("taxes")
  } else if (countryCode !== current.countryCode) {
    // Otro país, otro impuesto: vale lo que propone el nuevo.
    Object.assign(set, taxColumnsFor(countryCode, {}))
    fields.push("taxes")
  }
  if (fields.length === 0) {
    await ensureDefaultPaymentMethods(tx, orgId, actorUserId, current.countryCode)
    return current
  }
  if (set.currency && set.currency !== current.currency) {
    // El cambio de hoy y sus factores están en la moneda del negocio: con otra moneda activa, no cambia.
    if (current.secondCurrency) {
      const message = `La clínica también cobra en ${current.secondCurrency}: quita esa moneda para cambiar la del negocio`
      throw new ServiceError("SECOND_CURRENCY_ACTIVE", 409, message, { currency: message })
    }
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

export interface OrgExchangeRateInput {
  /** La otra moneda de la clínica: omitida, sigue la que hay; `null`, deja de cobrar en ella. */
  secondCurrency?: string | null
  /** El «Cambio de hoy», en texto decimal: moneda del negocio por 1 de la otra. Al activar, obligatorio. */
  exchangeRate?: string | null
}

/**
 * La única operación que escribe la otra moneda y el «Cambio de hoy», con quién y
 * cuándo: `exchange_factor` va siempre junto a `exchange_rate`. Bloquea el perfil,
 * así que un cobro (`lockOrgCurrency`, FOR SHARE) nunca la llama: el cambio que usa
 * un cobro se guarda en el cobro. Escribir el mismo cambio no cambia quién lo puso.
 */
export async function setOrgExchangeRate(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: OrgExchangeRateInput,
): Promise<OrgProfileRow> {
  const [current] = await tx
    .select()
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .limit(1)
    .for("update")
  if (!current) throw notFound("Perfil de organización")
  const requested = input.secondCurrency === undefined ? current.secondCurrency : input.secondCurrency
  if (requested === null) {
    if (input.secondCurrency === undefined)
      throw invalidField("exchangeRate", "Primero elige en qué otra moneda cobra la clínica")
    if (!current.secondCurrency) return current
    // Mientras algo la necesite, quitarla dejaría deudas, saldos y una caja sin cómo cobrarse.
    const usage = await getCurrencyUsage(tx, orgId, current.secondCurrency)
    const missing = currencyRemovalWords(usage, current.currency, current.locale)
    if (missing)
      throw new ServiceError("SECOND_CURRENCY_IN_USE", 409, missing, { secondCurrency: missing })
    return writeExchange(tx, orgId, actorUserId, current, {
      secondCurrency: null,
      exchangeRate: null,
      exchangeFactor: null,
      exchangeRateAt: null,
      exchangeRateBy: null,
    })
  }
  const second = assertCurrency(requested, "secondCurrency")
  if (second === current.currency)
    throw invalidField("secondCurrency", "Esa ya es la moneda del negocio: elige otra")
  const isNew = second !== current.secondCurrency
  if (isNew)
    await assertNoForeignCurrencyHistory(tx, orgId, current.currency, { second, field: "secondCurrency" })
  const written = input.exchangeRate?.trim() || (isNew ? null : current.exchangeRate)
  if (!written) throw invalidField("exchangeRate", `Escribe el cambio de hoy para cobrar en ${second}`)
  const rate = assertExchangeRate(written)
  if (!isNew && current.exchangeRate && rate === normalizeExchangeRate(current.exchangeRate))
    return current
  return writeExchange(tx, orgId, actorUserId, current, {
    secondCurrency: second,
    exchangeRate: rate,
    exchangeFactor: exchangeFactor(rate, current.currency, second),
    exchangeRateAt: new Date(),
    exchangeRateBy: actorUserId,
  })
}

function assertExchangeRate(value: string): string {
  try {
    return normalizeExchangeRate(value)
  } catch (error) {
    throw invalidField("exchangeRate", error instanceof Error ? error.message : "Revisa el cambio")
  }
}

async function writeExchange(
  tx: Db,
  orgId: string,
  actorUserId: string,
  current: OrgProfileRow,
  values: Pick<
    OrgProfileRow,
    "secondCurrency" | "exchangeRate" | "exchangeFactor" | "exchangeRateAt" | "exchangeRateBy"
  >,
): Promise<OrgProfileRow> {
  const [updated] = await tx
    .update(orgProfile)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(orgProfile.organizationId, orgId))
    .returning()
  if (!updated) throw notFound("Perfil de organización")
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "settings.exchange_rate_updated",
    entity: "org_profile",
    entityId: orgId,
    metadata: {
      secondCurrency: values.secondCurrency,
      exchangeRate: values.exchangeRate,
      previousSecondCurrency: current.secondCurrency,
      previousExchangeRate: current.exchangeRate,
    },
  })
  return updated
}

/** El nombre de quien puso el «Cambio de hoy»; `null` si no hay cambio o ya no está. */
export async function exchangeRateAuthor(
  tx: Db,
  profile: Pick<OrgProfileRow, "exchangeRateBy">,
): Promise<string | null> {
  if (!profile.exchangeRateBy) return null
  const [row] = await tx
    .select({ name: user.name })
    .from(user)
    .where(eq(user.id, profile.exchangeRateBy))
    .limit(1)
  return row?.name ?? null
}

/** Lo que la clínica ya tiene en una moneda: lo que hay que saber antes de activarla o quitarla. */
export type CurrencyUsage = CurrencyInUse

export async function getCurrencyUsage(tx: Db, orgId: string, currency: string): Promise<CurrencyUsage> {
  const code = assertCurrency(currency, "currency")
  const [due] = await tx.execute<{ cents: string | null }>(sql`
    select sum(greatest(c."amount_cents" - coalesce(paid."cents", 0), 0)) as "cents"
    from "patient_charge" c
    left join lateral (
      select sum(a."amount_cents") as "cents" from "patient_payment_application" a
      where a."organization_id" = c."organization_id" and a."charge_id" = c."id" and a."voided_at" is null
    ) paid on true
    where c."organization_id" = ${orgId} and c."currency" = ${code} and c."voided_at" is null`)
  const [services] = await tx.execute<{ total: string }>(sql`
    select count(*) as "total" from "service_catalog"
    where "organization_id" = ${orgId} and "currency" = ${code} and "is_active"`)
  // La misma cuenta del esperado de la caja: solo el efectivo (UN/CEFACT 4461, tipo 10).
  const [cash] = await tx.execute<{ cents: string | null }>(sql`
    select sum(case
      when m."direction" = 'ingreso' and (m."kind" <> 'cobro' or m."method_type_code" is null or m."method_type_code" = '10') then m."amount_cents"
      when m."direction" = 'egreso' and (m."method_type_code" is null or m."method_type_code" = '10') then -m."amount_cents"
      else 0 end) as "cents"
    from "cash_movement" m
    join "cash_shift" s on s."organization_id" = m."organization_id" and s."id" = m."shift_id"
    where m."organization_id" = ${orgId} and s."currency" = ${code} and s."status" = 'abierta' and m."voided_at" is null`)
  // Lo que cada pago vigente tiene sin aplicar ni devolver.
  const [favor] = await tx.execute<{ cents: string | null }>(sql`
    select sum(greatest(p."amount_cents" - coalesce(used."cents", 0) - coalesce(back."cents", 0), 0)) as "cents"
    from "patient_payment" p
    left join lateral (
      select sum(a."amount_cents") as "cents" from "patient_payment_application" a
      where a."organization_id" = p."organization_id" and a."payment_id" = p."id" and a."voided_at" is null
    ) used on true
    left join lateral (
      select sum(r."amount_cents") as "cents" from "patient_payment_refund" r
      where r."organization_id" = p."organization_id" and r."payment_id" = p."id"
    ) back on true
    where p."organization_id" = ${orgId} and p."currency" = ${code} and p."voided_at" is null`)
  const [pending] = await tx.execute<{ total: string }>(sql`
    select count(*) as "total" from "treatment_plan_item"
    where "organization_id" = ${orgId} and "currency" = ${code}
      and "status" in ('pendiente', 'programado', 'en_curso', 'suspendido')`)
  // Las comisiones de lo cobrado en esa moneda van en esa moneda: sin ella no se podrían pagar.
  const [commissions] = await tx.execute<{ cents: string | null }>(sql`
    select round(sum(l."own_commission")) as "cents" from "commission_live" l
    where l."organization_id" = ${orgId} and l."currency" = ${code} and l."has_rule"`)
  return {
    currency: code,
    dueCents: Number(due?.cents ?? 0),
    favorCents: Number(favor?.cents ?? 0),
    cashCents: Number(cash?.cents ?? 0),
    services: Number(services?.total ?? 0),
    pending: Number(pending?.total ?? 0),
    commissionsCents: Number(commissions?.cents ?? 0),
  }
}

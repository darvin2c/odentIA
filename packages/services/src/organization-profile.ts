import { currencyFractionDigits } from "@odentia/clinical"
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

/** Países con preset; otros países usan el perfil genérico (moneda ISO libre). */
export const COUNTRY_PRESETS: Record<
  string,
  { currency: string; locale: string; timezone: string; sheetSize: SheetSize }
> = {
  PE: { currency: "PEN", locale: "es-PE", timezone: "America/Lima", sheetSize: "A4" },
  MX: { currency: "MXN", locale: "es-MX", timezone: "America/Mexico_City", sheetSize: "Letter" },
  CO: { currency: "COP", locale: "es-CO", timezone: "America/Bogota", sheetSize: "Letter" },
  CL: { currency: "CLP", locale: "es-CL", timezone: "America/Santiago", sheetSize: "A4" },
  AR: { currency: "ARS", locale: "es-AR", timezone: "America/Argentina/Buenos_Aires", sheetSize: "A4" },
  ES: { currency: "EUR", locale: "es-ES", timezone: "Europe/Madrid", sheetSize: "A4" },
  US: { currency: "USD", locale: "en-US", timezone: "America/New_York", sheetSize: "Letter" },
}

/** Propuesta regional/impresión al elegir país (PUT /api/org-profile la aplica; Main integra). */
export function regionPresetForCountry(countryCode: string): {
  currency: string
  locale: string
  timezone: string
  sheetSize: SheetSize
} | null {
  return COUNTRY_PRESETS[countryCode.trim().toUpperCase()] ?? null
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
    const preset = regionPresetForCountry(countryCode)
    if (preset) {
      set.currency = preset.currency
      set.locale = preset.locale
      set.timezone = preset.timezone
      set.sheetSize = preset.sheetSize
      fields.push("currency", "locale", "timezone", "sheetSize")
    }
    else if (!input.currency || !input.locale || !input.timezone) {
      throw validation("Indica moneda, idioma y zona horaria para este país")
    }
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

/** Región e impresión efectivas para formatos, papel y pie del ticket. */
export async function getOrgRegion(
  tx: Db,
  orgId: string,
): Promise<Pick<
  OrgProfileRow,
  "countryCode" | "currency" | "locale" | "timezone" | "receiptWidth" | "sheetSize" | "ticketFooter"
>> {
  const [row] = await tx
    .select({
      countryCode: orgProfile.countryCode,
      currency: orgProfile.currency,
      locale: orgProfile.locale,
      timezone: orgProfile.timezone,
      receiptWidth: orgProfile.receiptWidth,
      sheetSize: orgProfile.sheetSize,
      ticketFooter: orgProfile.ticketFooter,
    })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .limit(1)
  if (!row) throw notFound("Perfil de organización")
  return row
}

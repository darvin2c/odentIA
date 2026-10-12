import { formatMoney } from "@odentia/clinical"
import { sql } from "drizzle-orm"
import type { Db } from "@odentia/db"
import { notFound, ServiceError } from "./errors.js"

/** Configuración regional efectiva de la organización (`org_profile`). */
export interface OrgLocale {
  countryCode: string
  currency: string
  timezone: string
  locale: string
}

export async function getOrgLocale(tx: Db, orgId: string): Promise<OrgLocale> {
  const [row] = await tx.execute<{ countryCode: string; currency: string; timezone: string; locale: string }>(sql`
    select country_code as "countryCode", currency, timezone, locale
    from org_profile where organization_id = ${orgId}`)
  if (!row) throw notFound("Perfil de organización")
  return row
}

/**
 * Valores neutros para cuando la clínica aún no tiene perfil regional: UTC y
 * el idioma de los textos del producto sin país. Nunca los de un país concreto.
 */
export const NEUTRAL_TIMEZONE = "UTC"
export const NEUTRAL_LOCALE = "es"

/** Formato regional de la clínica, o los valores neutros si no hay perfil. */
export async function findOrgLocale(
  tx: Db,
  orgId: string,
): Promise<Pick<OrgLocale, "timezone" | "locale">> {
  const [row] = await tx.execute<{ timezone: string; locale: string }>(sql`
    select timezone, locale from org_profile where organization_id = ${orgId}`)
  return {
    timezone: row?.timezone || NEUTRAL_TIMEZONE,
    locale: row?.locale || NEUTRAL_LOCALE,
  }
}

/** Importe (unidad menor ISO 4217) escrito con su moneda en el formato de la clínica. */
export function formatOrgMoney(
  amountMinor: number,
  currency: string,
  zone: Pick<OrgLocale, "locale">,
): string {
  return formatMoney(amountMinor, currency, zone.locale || NEUTRAL_LOCALE)
}

/**
 * Presentación de un instante en la zona/locale indicadas. Nunca reinterpreta
 * el instante: cambiar la configuración no altera lo ya persistido (los
 * instantes y la moneda histórica se conservan tal cual).
 */
export function formatZoned(date: Date, zone: Pick<OrgLocale, "timezone" | "locale">): string {
  return date.toLocaleString(zone.locale, { timeZone: zone.timezone })
}


/**
 * Moneda de la clínica para un importe nuevo que no indica la suya. Sin perfil
 * no se asume ninguna (`ORG_PROFILE_REQUIRED`).
 */
export async function requireOrgCurrency(tx: Db, orgId: string): Promise<string> {
  const [row] = await tx.execute<{ currency: string }>(sql`
    select currency from org_profile where organization_id = ${orgId}`)
  if (!row?.currency) throw orgProfileRequired()
  return row.currency
}

/**
 * ISO 4217 «XXX»: el código del estándar para «sin moneda». Es lo que lleva un
 * registro sin importe de una clínica que aún no configuró su moneda, en vez
 * de la moneda de un país.
 */
export const NO_CURRENCY = "XXX"

/** Moneda de la clínica si ya tiene perfil; `null` si no. */
export async function findOrgCurrency(tx: Db, orgId: string): Promise<string | null> {
  const [row] = await tx.execute<{ currency: string }>(sql`
    select currency from org_profile where organization_id = ${orgId}`)
  return row?.currency || null
}

/**
 * Sin perfil regional no se registra dinero: no se asume la moneda de ningún
 * país. Es una precondición de configuración, no un «no encontrado».
 */
export function orgProfileRequired(): ServiceError {
  return new ServiceError(
    "ORG_PROFILE_REQUIRED",
    409,
    "Configura el país y la moneda de la clínica antes de registrar importes",
  )
}

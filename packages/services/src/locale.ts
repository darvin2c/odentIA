import { type ClinicalCountryProfile, clinicalProfileFor, formatMoney } from "@odentia/clinical"
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
  // Sin segundos: lo que se lee en pantalla y en los mensajes es fecha y hora
  // («17/10/2026, 3:00 p. m.»), nunca «3:00:00 p. m.».
  return date.toLocaleString(zone.locale, {
    timeZone: zone.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  })
}


/**
 * Un día y una hora como se dicen en la conversación: «lun 19 oct, 3:00 p. m.»
 * (el año solo si no es el en curso). Para avisos y resúmenes que lee una persona.
 */
export function formatZonedShort(
  date: Date,
  zone: Pick<OrgLocale, "timezone" | "locale">,
  now: Date = new Date(),
): string {
  const year = (value: Date) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: zone.timezone, year: "numeric" }).format(value)
  const day = date
    .toLocaleDateString(zone.locale, {
      timeZone: zone.timezone,
      weekday: "short",
      day: "numeric",
      month: "short",
      ...(year(date) !== year(now) ? { year: "numeric" as const } : {}),
    })
    .replace(/\./g, "")
  const time = date.toLocaleTimeString(zone.locale, {
    timeZone: zone.timezone,
    hour: "numeric",
    minute: "2-digit",
  })
  return `${day}, ${time}`
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
 * País de la clínica (ISO 3166-1 alfa-2) si ya tiene perfil; `null` si no. Con
 * él se aplica lo nacional (p. ej. un teléfono escrito sin código de país);
 * sin él no se asume el de ningún país.
 */
export async function findOrgCountry(tx: Db, orgId: string): Promise<string | null> {
  const [row] = await tx.execute<{ countryCode: string }>(sql`
    select country_code as "countryCode" from org_profile where organization_id = ${orgId}`)
  return row?.countryCode || null
}

/**
 * Lo que vale en las clínicas del país de esta (ADR 0036): documentos, seguro,
 * dirección y odontograma. Sin país, el núcleo internacional.
 */
export async function orgClinicalProfile(tx: Db, orgId: string): Promise<ClinicalCountryProfile> {
  return clinicalProfileFor(await findOrgCountry(tx, orgId))
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

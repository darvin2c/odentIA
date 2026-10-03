import { sql } from "drizzle-orm"
import type { Db } from "@odentia/db"
import { notFound } from "./errors.js"

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
 * Presentación de un instante en la zona/locale indicadas. Nunca reinterpreta
 * el instante: cambiar la configuración no altera lo ya persistido (los
 * instantes y la moneda histórica se conservan tal cual).
 */
export function formatZoned(date: Date, zone: Pick<OrgLocale, "timezone" | "locale">): string {
  return date.toLocaleString(zone.locale, { timeZone: zone.timezone })
}


/**
 * Cuánto vale algo en moneda del negocio, en las consultas de Reportes: la misma
 * cuenta que usan las vistas de Argos (`org_money_value`, sobre `money_value`). Lo
 * que ya pasó usa el valor congelado de su cobro o su gasto; lo que se debe o falta
 * cobrar, el cambio de hoy. Nunca se redondea fila por fila: el `round` va sobre la
 * suma. Lo viejo en otra moneda, sin valor ni factor, da nulo y no entra en la suma:
 * una clínica que no activó nada ve lo mismo que veía filtrando por moneda.
 *
 * Sin dependencias de otros servicios, para que cualquiera lo use sin ciclos.
 */
import { convertCents } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { sql, type SQL } from "drizzle-orm"

/** Lo que hace falta saber de la clínica para valorar. */
export interface OrgMoney {
  /** La moneda del negocio. */
  currency: string
  secondCurrency: string | null
  /** El «Cambio de hoy», en palabras: moneda del negocio por 1 de la otra. */
  exchangeRate: string | null
  /** El mismo cambio por unidad menor, para las cuentas. */
  exchangeFactor: string | null
}

export async function orgMoney(tx: Db, orgId: string): Promise<OrgMoney> {
  const [row] = await tx.execute<{
    currency: string
    secondCurrency: string | null
    exchangeRate: string | null
    exchangeFactor: string | null
  }>(sql`
    select currency, second_currency as "secondCurrency", exchange_rate::text as "exchangeRate", exchange_factor::text as "exchangeFactor"
    from org_profile where organization_id = ${orgId}`)
  return {
    currency: row?.currency ?? "",
    secondCurrency: row?.secondCurrency ?? null,
    exchangeRate: row?.exchangeRate ?? null,
    exchangeFactor: row?.exchangeFactor ?? null,
  }
}

/** La clínica como tabla `op(currency, second_currency, exchange_factor)` para unirla a una consulta. */
export function orgMoneySql(orgId: string): SQL {
  return sql`(select currency, second_currency, exchange_factor from org_profile where organization_id = ${orgId}) as op`
}

/** Una parte de un importe con su valor congelado (o nulo): un pago o un gasto. Pide `op` en la consulta. */
export function frozenValueSql(input: { part: SQL; amount: SQL; value: SQL; currency: SQL }): SQL {
  return sql`org_money_value(${input.part}, ${input.amount}, ${input.value}, ${input.currency}, op.currency, op.second_currency, op.exchange_factor)`
}

/** Una parte de un pago `p` (o del alias que se diga), con su valor congelado. */
export function paymentValueSql(part: SQL, alias = "p"): SQL {
  const column = (name: string) => sql.raw(`${alias}.${name}`)
  return frozenValueSql({
    part,
    amount: column("amount_cents"),
    value: column("business_cents"),
    currency: column("currency"),
  })
}

/** Un importe que aún no se cobra ni se paga, al cambio de hoy. Pide `op` en la consulta. */
export function todayValueSql(cents: SQL, currency: SQL): SQL {
  return sql`org_money_value(${cents}, null, null, ${currency}, op.currency, op.second_currency, op.exchange_factor)`
}

/** Lo mismo que `todayValueSql` para un total ya sumado; nulo si esa moneda no tiene valor. */
export function todayValueCents(cents: number, currency: string, money: OrgMoney): number | null {
  if (currency === money.currency) return cents
  if (currency !== money.secondCurrency || money.exchangeFactor === null) return null
  return convertCents({
    amountCents: cents,
    from: currency,
    to: money.currency,
    businessCurrency: money.currency,
    factor: money.exchangeFactor,
  })
}

/** Un importe por moneda: lo que se debe se dice así, además de su total aproximado. */
export interface CurrencyAmount {
  currency: string
  cents: number
}

/** Moneda del negocio primero: es la que se lee primero en pantalla. */
export function businessFirst<T extends { currency: string }>(list: T[], business: string): T[] {
  return [...list].sort(
    (a, b) =>
      Number(b.currency === business) - Number(a.currency === business) ||
      a.currency.localeCompare(b.currency),
  )
}

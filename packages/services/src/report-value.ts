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
import { convertCents, type MoneyFraction, moneyValue } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { sql, type SQL } from "drizzle-orm"
import type { OrgLocale } from "./locale.js"

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

/** Lo mismo, de lo que ya se leyó con `getOrgLocale`: una operación no relee el perfil. */
export function orgMoneyOf(zone: OrgLocale): OrgMoney {
  return {
    currency: zone.currency,
    secondCurrency: zone.secondCurrency ?? null,
    exchangeRate: zone.exchangeRate ?? null,
    exchangeFactor: zone.exchangeFactor ?? null,
  }
}

/**
 * Cuánto vale una parte de un pago o de un gasto, lo mismo que `org_money_value`: el
 * factor de hoy solo vale para la otra moneda de la clínica.
 */
export function orgPartValue(
  partCents: number,
  source: { amountCents: number; businessCents: number | null; currency: string },
  money: OrgMoney,
): MoneyFraction | null {
  return moneyValue({
    partCents,
    amountCents: source.amountCents,
    valueCents: source.businessCents,
    currency: source.currency,
    businessCurrency: money.currency,
    factor: source.currency === money.secondCurrency ? money.exchangeFactor : null,
  })
}

/** La clínica como tabla `op(currency, second_currency, exchange_factor)` para unirla a una consulta. */
export function orgMoneySql(orgId: string): SQL {
  return sql`(select currency, second_currency, exchange_factor from org_profile where organization_id = ${orgId}) as op`
}

/**
 * Una parte de un pago `p` (o del alias que se diga, también un gasto), con su valor
 * congelado o nulo. Pide `op` en la consulta.
 */
export function paymentValueSql(part: SQL, alias = "p"): SQL {
  const column = (name: string) => sql.raw(`${alias}.${name}`)
  return sql`org_money_value(${part}, ${column("amount_cents")}, ${column("business_cents")}, ${column("currency")}, op.currency, op.second_currency, op.exchange_factor)`
}

/**
 * Lo cobrado de un tramo, fila por fila y con signo: los cobros que siguen en pie al
 * cerrarlo, menos las anulaciones del tramo de cobros anteriores y las devoluciones
 * del tramo. `cents` y `tax` en lo que cancela; `entered`, lo que de verdad entró o
 * salió, en `entered_currency`. Se valora con `paymentValueSql(parte, alias)`.
 */
export function paymentFlowSql(orgId: string, start: SQL, end: SQL, branchId?: string): SQL {
  const branch = branchId ? sql`and p.branch_id = ${branchId}` : sql``
  const payment = sql`coalesce(p.tender_currency, p.currency)::text as entered_currency, p.method_name as method, p.method_type_code = '10' as cash, p.amount_cents, p.business_cents, p.currency::text as currency`
  return sql`
    select p.amount_cents::bigint as cents, p.tax_cents::bigint as tax, coalesce(p.tender_cents, p.amount_cents)::numeric as entered, ${payment} from patient_payment p
    where p.organization_id = ${orgId} and p.paid_at >= ${start} and p.paid_at < ${end}
      and (p.voided_at is null or p.voided_at >= ${end}) ${branch}
    union all
    select -p.amount_cents::bigint, -p.tax_cents::bigint, -coalesce(p.tender_cents, p.amount_cents)::numeric, ${payment} from patient_payment p
    where p.organization_id = ${orgId} and p.paid_at < ${start}
      and p.voided_at >= ${start} and p.voided_at < ${end} ${branch}
    union all
    select -r.amount_cents::bigint, -r.tax_cents::bigint, -coalesce(r.tender_cents, r.amount_cents)::numeric, ${payment} from patient_payment_refund r
    join patient_payment p on p.organization_id = r.organization_id and p.id = r.payment_id
    where r.organization_id = ${orgId} and r.refunded_at >= ${start} and r.refunded_at < ${end} ${branch}`
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

/** Lo que hay en cada moneda, solo si hay algo en otra: sin eso, la respuesta es la de siempre. */
export function foreignBreakdown(
  parts: CurrencyAmount[],
  business: string,
): { byCurrency?: CurrencyAmount[] } {
  return parts.some((item) => item.currency !== business)
    ? { byCurrency: businessFirst(parts, business) }
    : {}
}

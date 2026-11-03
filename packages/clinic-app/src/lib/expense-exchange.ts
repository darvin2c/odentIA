/**
 * Lo que dicen los formularios de un gasto con dos monedas: en qué salió, a qué
 * cambio y cuánto vale. La regla es la del servidor (`expenseExchange`): aquí solo se
 * lee lo escrito y se arma lo que se envía. Sin otra moneda no hay nada que preguntar
 * y el cuerpo sale igual que siempre.
 */
import {
  type ExpenseExchange,
  exchangeRateWords,
  expenseExchange,
  readExchangeRate,
} from "@odentia/clinical"
import { parseAmount } from "./finance-cash"
import type { OrgSecondCurrency } from "./org"

export interface ExpenseMoney {
  /** Se puede elegir: la moneda de lo que se paga es una de las dos de la clínica. */
  asks: boolean
  /** En qué sale el dinero: de esa caja. */
  payIn: string
  /** Salió en otra moneda que la que cancela: se escribe lo que salió y el cambio se calcula solo. */
  crossed: boolean
  /** Hace falta escribir un cambio: se cancela y sale en la otra moneda. */
  needsRate: boolean
  /** Lo que sale, en `payIn`; null mientras no se entienda. */
  outCents: number | null
  tenderError: string | null
  rateError: string | null
  /** Lo que se congelaría, para decirlo antes de guardar. */
  frozen: ExpenseExchange | null
  /** Lo que viaja al servidor además del importe. */
  body: { tenderCents?: number; tenderCurrency?: string; exchangeRate?: string }
}

export function readExpenseMoney(input: {
  second: OrgSecondCurrency | null
  business: string
  /** Lo que cancela, en `currency`. */
  cents: number | null
  currency: string
  /** En qué se paga. */
  payIn: string
  tenderText: string
  rateText: string
  locale: string
}): ExpenseMoney {
  const { second, business, cents, currency, tenderText, rateText, locale } = input
  const asks = second !== null && (currency === business || currency === second.currency)
  const payIn = asks ? input.payIn : currency
  const nothing = {
    asks,
    payIn,
    crossed: false,
    needsRate: false,
    outCents: cents,
    tenderError: null,
    rateError: null,
    frozen: null,
    body: {},
  }
  if (!asks) return nothing
  const crossed = payIn !== currency
  const needsRate = !crossed && currency !== business
  const base = { ...nothing, crossed, needsRate }
  // Solo se paga con lo que se tenía a favor: no sale dinero, no hay nada que valorar.
  if (cents === 0) return { ...base, outCents: 0 }
  if (crossed) {
    const tender = tenderText.trim() === "" ? null : parseAmount(tenderText, payIn, locale)
    const tenderError =
      tenderText.trim() === ""
        ? "Escribe lo que salió."
        : tender === null
          ? "Ese importe no se entiende. Revísalo."
          : tender <= 0
            ? "Escribe un importe mayor que cero."
            : null
    if (tenderError || tender === null) return { ...base, outCents: null, tenderError }
    let frozen: ExpenseExchange | null = null
    // Lo que sale del cambio puede no decirse: un céntimo por un millón de dólares da 0.
    try {
      if (cents !== null)
        frozen = expenseExchange({
          amountCents: cents,
          currency,
          businessCurrency: business,
          tender: { cents: tender, currency: payIn },
        })
    } catch (error) {
      return {
        ...base,
        outCents: tender,
        tenderError: error instanceof Error ? error.message : "Revisa lo que salió.",
      }
    }
    return { ...base, outCents: tender, frozen, body: { tenderCents: tender, tenderCurrency: payIn } }
  }
  if (!needsRate) return nothing
  const { rate, error } = readExchangeRate(rateText, locale)
  if (rate === undefined) return { ...base, rateError: error }
  return {
    ...base,
    frozen:
      cents !== null
        ? expenseExchange({ amountCents: cents, currency, businessCurrency: business, rate })
        : null,
    body: { exchangeRate: rate },
  }
}

/** El cambio que quedó en un gasto, dicho como se dice: «S/ 3.76 por USD 1». */
export function expenseRateWords(
  row: { exchangeRate: string; currency: string; tenderCurrency?: string | null },
  business: string,
  locale: string,
): string {
  const other = row.currency === business ? (row.tenderCurrency ?? row.currency) : row.currency
  return exchangeRateWords(row.exchangeRate, business, other, locale)
}

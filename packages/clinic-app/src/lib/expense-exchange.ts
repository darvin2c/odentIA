/**
 * Lo que dicen los formularios de un gasto con dos monedas: en qué salió, a qué
 * cambio y cuánto vale. La regla es la del servidor (`expenseExchange`): aquí solo se
 * lee lo escrito y se arma lo que se envía. Sin otra moneda no hay nada que preguntar
 * y el cuerpo sale igual que siempre.
 */
import {
  currencyWord,
  type ExpenseExchange,
  exchangeRateWords,
  expenseExchange,
  parseExchangeRate,
} from "@odentia/clinical"
import { parseAmount } from "./finance-cash"
import type { OrgSecondCurrency } from "./org"

/** «Soles» y «Dólares»: las monedas para elegir, por su nombre. */
export function currencyChoices(
  codes: readonly string[],
  locale: string,
): Array<{ value: string; label: string }> {
  return codes.map((code) => {
    const word = currencyWord(code, locale)
    return { value: code, label: `${word.charAt(0).toUpperCase()}${word.slice(1)}` }
  })
}

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
  // Solo se paga con lo que se tenía a favor: no sale dinero, no hay nada que valorar.
  if (cents === 0) return { ...nothing, crossed, needsRate, outCents: 0 }
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
    if (tenderError || tender === null)
      return { ...nothing, crossed, needsRate, outCents: null, tenderError }
    let frozen: ExpenseExchange | null = null
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
        ...nothing,
        crossed,
        needsRate,
        outCents: tender,
        tenderError: error instanceof Error ? error.message : "Revisa lo que salió.",
      }
    }
    return {
      ...nothing,
      crossed,
      needsRate,
      outCents: tender,
      frozen,
      body: { tenderCents: tender, tenderCurrency: payIn },
    }
  }
  if (!needsRate) return nothing
  let rate: string
  try {
    rate = parseExchangeRate(rateText, locale)
  } catch (error) {
    return {
      ...nothing,
      crossed,
      needsRate,
      rateError: error instanceof Error ? error.message : "Escribe el cambio",
    }
  }
  return {
    ...nothing,
    crossed,
    needsRate,
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

// Las cifras de la presentación de Fundadores (/presentacion), de la administración como el resto de
// la web: en deck.html cada una es una marca {{nombre}} que se llena al servir la página. Sin los
// dos planes publicados con todos sus precios no hay presentación: no se inventa ninguna cifra.
import {
  businessDays,
  days,
  hours,
  money,
  type PlanPrices,
  type Pricing,
  type TierPrices,
} from "../lib/pricing"

type Tier = keyof TierPrices

/** El plan con todos los precios que nombra la presentación, o null. */
function complete(
  plan: PlanPrices | null,
): (PlanPrices & { recovered: number; tiers: Record<Tier, number> }) | null {
  if (!plan || plan.recovered === null) return null
  if (Object.values(plan.tiers).some((value) => value === null)) return null
  return plan as PlanPrices & { recovered: number; tiers: Record<Tier, number> }
}

/**
 * Las marcas de la presentación. `day` son los tipos que cobra el día de ejemplo además de la cita
 * recuperada (en odentIA, una conversación que gestiona y una consulta estándar). Null si falta un
 * plan, el regalo o una condición del plan Fundador.
 */
export function deckFigures(pricing: Pricing, day: Tier[]): Record<string, string> | null {
  const list = complete(pricing.list)
  const founders = complete(pricing.founders)
  const discount = pricing.founders?.discountPercent ?? null
  const months = pricing.founders?.guaranteeMonths ?? null
  if (!list || !founders || discount === null || months === null || founders.trialCredit <= 0)
    return null
  const cur = founders.currency
  // «0,50» y «1,00»: la cifra sin la moneda y siempre con dos decimales, para las filas que dicen
  // tres precios seguidos.
  const bare = (value: number) => (Math.round(value * 100) / 100).toFixed(2).replace(".", ",")
  const plan = (p: typeof list, key: "L" | "F") => {
    const out: Record<string, string> = {
      [`${key}.fee$`]: money(p.plan, p.currency),
      [`${key}.feeN`]: String(p.plan),
      [`${key}.recovered$`]: money(p.recovered, p.currency),
      [`${key}.day$`]: money(
        day.reduce((sum, tier) => sum + p.tiers[tier], p.recovered),
        p.currency,
      ),
    }
    for (const [tier, value] of Object.entries(p.tiers) as [Tier, number][]) {
      out[`${key}.${tier}`] = bare(value)
      out[`${key}.${tier}$`] = money(value, p.currency)
    }
    return out
  }
  // Lo de Argos y el espacio solo si el plan Fundador los cobra.
  const extras = [
    founders.argos &&
      `${founders.argos.packQuestions} preguntas más a Argos (${founders.argos.included} al mes incluidas) por ${money(founders.argos.pack, cur)}`,
    founders.storage &&
      `cada GB extra sobre ${founders.storage.includedGb} por ${money(founders.storage.perGb, cur)}`,
  ].filter(Boolean)
  return {
    ...plan(list, "L"),
    ...plan(founders, "F"),
    cur,
    currencyWord: cur === "USD" ? "dólares" : cur,
    gift: money(founders.trialCredit, cur),
    giftN: String(founders.trialCredit),
    giftDays: days(founders.trialDays),
    discount: `${discount} %`,
    discountN: String(discount),
    months: `${months} meses`,
    monthsN: String(months),
    window: hours(pricing.terms.conversationWindowHours),
    answer: businessDays(pricing.terms.waitlistAnswerDays),
    extras: extras.length ? `También con precio de Fundador: ${extras.join(" y ")}. ` : "",
  }
}

/** Llena las marcas {{nombre}} de deck.html; una marca sin valor es un error, no un hueco en pantalla. */
export function fillDeck(html: string, values: Record<string, string>): string {
  return html.replace(/\{\{([\w.$]+)\}\}/g, (_, key: string) => {
    const value = values[key]
    if (value === undefined) throw new Error(`presentación: falta la cifra «${key}»`)
    return value
  })
}

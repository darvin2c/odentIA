// Las cifras de la presentación de Fundadores (/presentacion/fundadores), de la administración como el resto de
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

/**
 * La presentación que reciben las clínicas, sin el guion de quien presenta: fuera las notas de cada
 * parte, su panel y el botón «Guion (N)». Con /presentacion/fundadores?guion la página las conserva.
 */
export function withoutGuide(html: string): string {
  const out = html
    .replace(/<aside class="notes">[\s\S]*?<\/aside>\n?/g, "")
    .replace(/<div class="notes-panel"[^>]*>[\s\S]*?<\/div>\n?/, "")
    .replace(/[ \t]*<button type="button" id="notesBtn"[^>]*>[\s\S]*?<\/button>\n?/, "")
  if (/class="notes"|id="notesBtn"|class="notes-panel"/.test(out))
    throw new Error("presentación: quedó parte del guion")
  return out
}

/**
 * Las partes de la v1 que en la v2 pasan a la clínica: lo que se ve pasar se explica ahí. Quedan aparte las
 * que hay que leer para decidir: el inicio, «Todo lo de siempre», el cobro, la semana, el precio y el cierre.
 */
const INSIDE_THE_CLINIC = [
  "Mensajes fuera de horario",
  "Omnicanal",
  "Clío, agente clínico",
  "Argos, agente administrador",
  "Reportes",
  "Buscador",
  "Tú tienes el control",
  "Un solo caso, dos formas de trabajar",
]

/**
 * La v2 de la presentación de odentIA (/presentacion/fundadores?v2): «Tus agentes» pasa a ser la
 * clínica en 3D y se lleva las partes que explica. Convive con la v1 hasta que pase una llamada real.
 */
export function withClinic(deck: string, slide: string): string {
  const section = (name: string) =>
    new RegExp(
      `(?:<!-- =+ [^\\n]* -->\\r?\\n)?<section class="slide" aria-label="${name}">[\\s\\S]*?</section>\\r?\\n?`,
    )
  const part = section("Tus agentes")
  if (!part.test(deck)) throw new Error("presentación: no está la parte «Tus agentes»")
  let out = deck.replace(part, () => `${slide}\n`)
  for (const name of INSIDE_THE_CLINIC) {
    if (!section(name).test(out)) throw new Error(`presentación: no está la parte «${name}»`)
    out = out.replace(section(name), "")
  }
  return out
}

/** Llena las marcas {{nombre}} de deck.html; una marca sin valor es un error, no un hueco en pantalla. */
export function fillDeck(html: string, values: Record<string, string>): string {
  return html.replace(/\{\{([\w.$]+)\}\}/g, (_, key: string) => {
    const value = values[key]
    if (value === undefined) throw new Error(`presentación: falta la cifra «${key}»`)
    return value
  })
}

// Las cifras de la presentación (/presentacion), de la administración como el resto de la web: en
// deck.html cada una es una marca {{nombre}} que se llena al servir la página. Todas salen del plan
// de lista; sin él publicado con todos sus precios y su regalo de prueba no hay presentación: no se
// inventa ninguna cifra.
import { afterTrialText } from "../lib/offer"
import { days, hours, money, type PlanPrices, type Pricing, type TierPrices } from "../lib/pricing"
import type { WebProduct } from "../lib/product"
import { ctaOf } from "../lib/site"
import clinicStyle from "./clinic/clinic.css?raw"

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
 * recuperada (en odentIA, una conversación que gestiona y una consulta estándar). Null si falta el
 * plan, uno de sus precios o el regalo de la prueba. Si el plan no tiene cuota, las frases de la
 * cuota (`feeNote`, `systemLine`, `dayNote`) dicen eso en vez de un crédito que no existe.
 */
export function deckFigures(pricing: Pricing, day: Tier[]): Record<string, string> | null {
  const list = complete(pricing.list)
  if (!list || list.trialCredit <= 0) return null
  const cur = list.currency
  // «0,50» y «1,00»: la cifra sin la moneda y siempre con dos decimales, para las filas que dicen
  // tres precios seguidos.
  const bare = (value: number) => (Math.round(value * 100) / 100).toFixed(2).replace(".", ",")
  const out: Record<string, string> = {
    "L.fee$": money(list.plan, cur),
    "L.feeN": String(list.plan),
    "L.credit$": money(list.credit, cur),
    "L.recovered$": money(list.recovered, cur),
    "L.day$": money(
      day.reduce((sum, tier) => sum + list.tiers[tier], list.recovered),
      cur,
    ),
  }
  for (const [tier, value] of Object.entries(list.tiers) as [Tier, number][]) {
    out[`L.${tier}`] = bare(value)
    out[`L.${tier}$`] = money(value, cur)
  }
  const fee = money(list.plan, cur)
  const credit = money(list.credit, cur)
  const whole = list.plan > 0 && list.credit === list.plan
  // Lo de Argos y el espacio solo si el plan los cobra.
  const extras = [
    list.argos &&
      `${list.argos.packQuestions} preguntas más a Argos (${list.argos.included} al mes incluidas) por ${money(list.argos.pack, cur)}`,
    list.storage && `cada GB extra sobre ${list.storage.includedGb} por ${money(list.storage.perGb, cur)}`,
  ].filter(Boolean)
  // El botón del cierre es el de toda la web: «Empieza gratis», al registro.
  const cta = ctaOf(pricing)
  return {
    ...out,
    ctaHref: cta.href,
    ctaLabel: cta.label,
    /** La dirección del botón, para leerla en pantalla: «app.odentia32.com/register». */
    ctaUrl: cta.href.replace(/^https?:\/\//, ""),
    cur,
    currencyWord: cur === "USD" ? "dólares" : cur,
    gift: money(list.trialCredit, cur),
    giftN: String(list.trialCredit),
    giftDays: days(list.trialDays),
    window: hours(pricing.terms.conversationWindowHours),
    afterTrial: afterTrialText(pricing) ?? "",
    feeNote:
      list.plan === 0
        ? "Sin cuota: pagas solo lo que hacen tus agentes"
        : whole
          ? "Vuelve entero como crédito para tus agentes"
          : list.credit > 0
            ? `Con ${credit} de crédito para tus agentes`
            : "Lo que hacen tus agentes se suma",
    systemLine:
      list.plan === 0
        ? "El sistema completo va incluido, sin cuota."
        : whole
          ? `El sistema completo va incluido en tu plan de ${fee} al mes, que vuelven enteros como crédito para tus agentes.`
          : `El sistema completo va incluido en tu plan de ${fee} al mes.`,
    dayNote: list.plan > 0 && list.credit > 0 ? `que se descuentan de tus ${credit} de crédito.` : "y es lo que pagas ese día.",
    extras: extras.length ? `También: ${extras.join(" y ")}. ` : "",
  }
}

/**
 * La presentación que reciben las clínicas, sin el guion de quien presenta: fuera las notas de cada
 * parte, su panel y el botón «Guion (N)». Con /presentacion?guion la página las conserva.
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
 * Las partes de la v1 que cambian en la v2. `inside` pasan a la clínica: lo que se ve pasar se explica ahí.
 * Quedan aparte las que hay que leer para decidir: el inicio, «Todo lo de siempre», el cobro, la semana, el
 * precio y el cierre. `after` también quedan aparte, pero justo después de la clínica: en latidIA, lo que un
 * médico pregunta enseguida (qué pasa con una urgencia y con la receta) y habla de agentes ya presentados.
 */
const CLINIC_PARTS: Record<WebProduct, { inside: string[]; after: string[] } | null> = {
  dental: {
    inside: [
      "Mensajes fuera de horario",
      "Omnicanal",
      "Clío, agente clínico",
      "Argos, agente administrador",
      "Reportes",
      "Buscador",
      "Tú tienes el control",
      "Un solo caso, dos formas de trabajar",
    ],
    after: [],
  },
  medical: {
    inside: [
      "Mensajes fuera de horario",
      "Omnicanal",
      "Clío, agente clínico",
      "Argos, agente administrador",
      "Reportes",
      "Tú tienes el control",
      "Un solo caso, dos formas de trabajar",
    ],
    after: ["Señales de alarma", "Receta y descanso médico"],
  },
  // vistIA todavía no tiene presentación.
  optical: null,
}

/**
 * La v2 de la presentación (/presentacion?v2): «Tus agentes» pasa a ser la clínica en 3D, con
 * sus estilos comunes y el texto de cada producto, y se lleva las partes que explica. Convive con la v1
 * hasta que pase una llamada real.
 */
export function withClinic(deck: string, slide: string, product: WebProduct): string {
  const section = (name: string) =>
    new RegExp(
      `(?:<!-- =+ [^\\n]* -->\\r?\\n)?<section class="slide" aria-label="${name}">[\\s\\S]*?</section>\\r?\\n?`,
    )
  const take = (from: string, name: string) => {
    const found = section(name).exec(from)
    if (!found) throw new Error(`presentación: no está la parte «${name}»`)
    return { part: found[0], rest: from.replace(found[0], "") }
  }
  const parts = CLINIC_PARTS[product]
  if (!parts) throw new Error(`presentación: ${product} todavía no tiene la suya`)
  const { inside, after } = parts
  let out = deck
  const moved: string[] = []
  for (const name of after) {
    const { part, rest } = take(out, name)
    moved.push(part)
    out = rest
  }
  const clinic = `<style>\n${clinicStyle}</style>\n${slide}\n${moved.join("")}`
  const agents = section("Tus agentes")
  if (!agents.test(out)) throw new Error("presentación: no está la parte «Tus agentes»")
  out = out.replace(agents, () => clinic)
  for (const name of inside) out = take(out, name).rest
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

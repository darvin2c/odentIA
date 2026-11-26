/**
 * Lo que Kairós puede decir de cada producto cuando responde solo en un chat
 * (Kairós vende, ADR 0189): solo lo que ya dicen las webs (`apps/web`: la
 * portada y sus preguntas, Precios y la oferta de la prueba), en
 * frases cortas y sin prometer nada más. Si una web cambia lo que promete, se
 * cambia aquí en el mismo cambio.
 *
 * Los precios no se escriben aquí: salen al momento de `getPublicPricing` (los
 * planes con «Mostrar en la web», un solo lugar) y se dicen con el mismo
 * formato que la web (`money` de `apps/web/src/lib/pricing.ts`: «USD 0,50»,
 * «USD 1.560»). La comprobación antes de enviar acepta solo esos importes.
 */
import { type ClinicalProduct, isClinicalProduct } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { productDomainOf, publicLinksConfigured } from "./public-links.js"
import { getPublicPricing, type PublicPlanPrices, type PublicPricing } from "./saas-founders.js"

/** Lo que Kairós sabe de un producto para vender. */
export interface KairosSalesFacts {
  product: ClinicalProduct
  /** «odentIA». */
  name: string
  /** Para quién es: «clínicas dentales». */
  audience: string
  /** Frases de las webs, una por línea. */
  facts: string[]
  /** Los precios vigentes en palabras, uno por línea (vacío si no hay un plan publicado). */
  prices: string[]
  /** Cada importe que puede decir, con su moneda: la comprobación no deja salir otro. */
  amounts: Array<{ value: number; currency: string }>
  /** Los porcentajes que dice la web (hoy ninguno): cualquier otro es un descuento inventado. */
  percents: number[]
}

interface ProductLine {
  name: string
  audience: string
  /** El lugar con su artículo: «tu clínica». */
  yourPlace: string
  /** Quién atiende, en plural. */
  clinicians: string
  /** A quién se atiende, en plural. */
  patients: string
  /** Clío trabaja en este producto (en vistIA no dicta). */
  clio: boolean
}

const LINES: Record<ClinicalProduct, ProductLine> = {
  dental: {
    name: "odentIA",
    audience: "clínicas dentales",
    yourPlace: "tu clínica",
    clinicians: "odontólogos",
    patients: "pacientes",
    clio: true,
  },
  medical: {
    name: "latidIA",
    audience: "consultorios médicos",
    yourPlace: "tu consultorio",
    clinicians: "médicos",
    patients: "pacientes",
    clio: true,
  },
  optical: {
    name: "vistIA",
    audience: "ópticas",
    yourPlace: "tu óptica",
    clinicians: "optómetras",
    patients: "clientes",
    clio: false,
  },
}

/** «USD 1.560», «USD 0,50»: la moneda ISO, punto de miles y coma decimal; sin decimales si son ceros (como la web). */
export function salesMoney(value: number, currency: string): string {
  const rounded = Math.round(value * 100) / 100
  const fixed = rounded.toFixed(2).replace(".", ",")
  const trimmed = fixed.endsWith(",00") ? fixed.slice(0, -3) : fixed
  return `${currency} ${trimmed.replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`
}

/** La web pública de un producto (`https://odentia32.com`), si está configurada. */
function webOrigin(product: ClinicalProduct): string | null {
  if (!publicLinksConfigured()) return null
  const domain = productDomainOf(product)
  return domain ? `https://${domain}` : null
}

/** Lo fijo de cada producto: lo que dicen la portada y sus preguntas. */
function productFacts(product: ClinicalProduct, line: ProductLine): string[] {
  const web = webOrigin(product)
  const agents = line.clio
    ? `Trae tres agentes: Sofi (recepción: responde, agenda, mueve citas y recuerda), Clío (asistente clínico: prepara la nota mientras el profesional atiende, y el profesional confirma) y Argos (responde con las cifras de ${line.yourPlace} y escribe para recuperar ${line.patients}).`
    : `Trae dos agentes: Sofi (recepción: responde, agenda, mueve citas y recuerda) y Argos (responde con las cifras de ${line.yourPlace} y escribe para recuperar ${line.patients}).`
  return [
    `${line.name} es el software de Sallca para ${line.audience}: omnicanal y agéntico.`,
    `Omnicanal: atiendes por WhatsApp, Instagram, Messenger, Telegram, el chat de tu web y el correo, y todo queda en una sola ficha por persona.`,
    agents,
    "Los agentes actúan siempre dentro de lo que la clínica les permite; si no saben algo, se lo pasan al equipo con todo lo hablado.",
    `Todas las ${line.audience} tienen el sistema completo, incluido en el plan: no hay planes con más o menos funciones.`,
    `Carga de datos: nos envías tu Excel o lo que exporta tu sistema y el equipo de Sallca carga a tus ${line.patients}; lo dudoso se revisa contigo. Las citas, los saldos y la historia anterior todavía no se cargan.`,
    "Se usa desde el celular en el navegador, y se puede instalar como una app con su ícono, sin tienda.",
    "Usa ChatGPT 6, de OpenAI, con la cuenta de Sallca: no hace falta una cuenta ni una clave propia.",
    "WhatsApp lo cobra Meta directamente a la clínica, con sus tarifas; Sallca no lo cobra ni lo estima.",
    "Está hecho para clínicas de habla hispana; la moneda, la zona horaria y los documentos se configuran por clínica.",
    "La prueba no pide tarjeta.",
    "Para verlo funcionando, Sallca agenda una presentación de 45 minutos por videollamada con alguien del equipo.",
    ...(web
      ? [
          `Precios y cómo se calcula el mes: ${web}/precios`,
        ]
      : ["Los precios y cómo se calcula el mes están en la página Precios de la web."]),
  ]
}

/** Lo que cobra cada acción de un plan, en palabras, con los importes que se dijeron. */
function planPrices(
  plan: PublicPlanPrices,
  line: ProductLine,
  money: (cents: number | null, unit: "centavos" | "micros") => string | null,
): string[] {
  const t = plan.tiers
  const m = (micros: number | null) => money(micros, "micros")
  const sofi = [
    m(t.informa) ? `${m(t.informa)} por responder lo que preguntan (informa)` : null,
    m(t.gestiona) ? `${m(t.gestiona)} por gestionar una cita (gestiona)` : null,
    m(t.agenda) ? `${m(t.agenda)} si la cita se da (agenda)` : null,
  ].filter((part): part is string => part !== null)
  const clio = line.clio
    ? [
        m(t.simple) ? `${m(t.simple)} una consulta simple` : null,
        m(t.estandar) ? `${m(t.estandar)} una estándar` : null,
        m(t.completa) ? `${m(t.completa)} una completa` : null,
      ].filter((part): part is string => part !== null)
    : []
  const out: string[] = []
  if (sofi.length) out.push(`Sofi cobra ${sofi.join(", ")}.`)
  // Como la web de Clío: se cobra por consulta dictada, según lo que dejó listo; sin el borrador, nada.
  if (clio.length)
    out.push(
      `Clío cobra por cada consulta que deja lista con el dictado: ${clio.join(", ")}; si se descarta su borrador, no se cobra.`,
    )
  if (m(plan.recoveryMicros))
    out.push(`Una cita recuperada por Argos cuesta ${m(plan.recoveryMicros)}.`)
  if (plan.argosPackMicros !== null && m(plan.argosPackMicros))
    out.push(
      `Argos trae ${plan.argosIncludedQuestions} preguntas al mes incluidas; ${plan.argosPackQuestions} más cuestan ${m(plan.argosPackMicros)}.`,
    )
  if (plan.storageGbMicros !== null && m(plan.storageGbMicros))
    out.push(
      `Incluye ${plan.storageIncludedGb} GB de espacio; cada GB extra cuesta ${m(plan.storageGbMicros)} al mes.`,
    )
  return out
}

/**
 * Lo que Kairós puede decir de un producto, con los precios vigentes de su web
 * (`getPublicPricing`). Un producto que no existe cae en el base.
 */
export async function kairosSalesFacts(tx: Db, product: string): Promise<KairosSalesFacts> {
  const known: ClinicalProduct = isClinicalProduct(product) ? product : "dental"
  return kairosSalesFactsOf(known, await getPublicPricing(tx, known))
}

/**
 * Lo mismo con los precios ya leídos: sin base. Lo usa la medición
 * (`eval:kairos-vende`) con los planes fijos de su banco, para que Kairós lea
 * exactamente el texto de producción.
 */
export function kairosSalesFactsOf(product: string, pricing: PublicPricing): KairosSalesFacts {
  const known: ClinicalProduct = isClinicalProduct(product) ? product : "dental"
  const line = LINES[known]
  const amounts: Array<{ value: number; currency: string }> = []
  const percents: number[] = []
  const prices: string[] = []
  const say = (plan: PublicPlanPrices) => (value: number | null, unit: "centavos" | "micros") => {
    if (value === null) return null
    const units = unit === "centavos" ? value / 100 : value / 1_000_000
    amounts.push({ value: Math.round(units * 100) / 100, currency: plan.currency })
    return salesMoney(units, plan.currency)
  }
  const list = pricing.list
  if (list) {
    const money = say(list)
    const fee =
      list.priceCents > 0
        ? `${money(list.priceCents, "centavos")} al mes, que vuelven como ${money(list.creditCents, "centavos")} de crédito para los agentes`
        : "sin cuota"
    const trial =
      list.trialCreditCents > 0
        ? `; prueba de ${list.trialDays} días con ${money(list.trialCreditCents, "centavos")} de crédito`
        : `; prueba de ${list.trialDays} días`
    prices.push(`Plan ${list.name} (precio de lista): ${fee}${trial}.`)
    prices.push(...planPrices(list, line, money).map((text) => `${list.name}: ${text}`))
  }
  // El alta es libre (ADR 0221): sin plan publicado, el producto todavía no abre cuentas por la web.
  prices.push(
    list
      ? `Se empieza gratis: se crea la cuenta y se abre ${line.yourPlace} al momento y sin tarjeta. El programa Fundadores ya terminó: no hay invitación, cupos ni precio de Fundadores; hoy se empieza gratis y después rige el plan de lista.`
      : `Todavía no se abren cuentas nuevas de ${line.name} por la web: para empezar, el equipo de Sallca agenda una presentación.`,
  )
  // La moneda de los planes, dicha una vez además de en cada importe.
  const currencies = [...new Set(amounts.map((amount) => amount.currency))]
  if (currencies.length === 1)
    prices.push(
      `Todos los importes están en ${currencies[0]}${currencies[0] === "USD" ? " (dólares de Estados Unidos)" : ""}.`,
    )
  return {
    product: known,
    name: line.name,
    audience: line.audience,
    facts: productFacts(known, line),
    prices,
    amounts,
    percents,
  }
}

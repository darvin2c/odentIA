// Cómo se empieza y qué pasa al terminar la prueba: una sola historia para las tres webs, en la
// portada, el cierre de cada página, las preguntas y Precios. Lo que dice es lo que hace el producto
// (ADR 0031): el alta es libre, cualquiera crea su cuenta y abre su clínica al momento con su prueba
// (días y regalo para los agentes del plan de lista). El plan se elige en Plan y pagos: si se eligió,
// empieza al terminar la prueba; si no, la clínica queda en solo lectura hasta elegirlo, sin perder
// datos, y los agentes se pausan. Si el saldo de prueba se acaba antes, los agentes se pausan hasta
// que termina la prueba y el equipo ve las conversaciones en la Bandeja. No se pide tarjeta: el pago
// se registra con su comprobante. Ninguna cifra va aquí: todas salen de `Astro.locals.pricing`.
import type { FaqItem } from "./faq"
import { days, money, type Pricing, shownPlan } from "./pricing"

/**
 * Los avisos de que la prueba termina: los días antes en que la clínica sin plan ve el aviso y luego
 * la alarma. No es una condición comercial sino lo que hace el producto (`dias_prueba` en
 * `packages/services/src/saas-terms.ts`, «daysLeft <= 7» y «<= 2»): si cambia allí, cambia aquí.
 */
const TRIAL_NOTICE_DAYS = [7, 2] as const

export interface Offer {
  /** El regalo para los agentes («USD 100»), si el plan lo trae. */
  gift: string | null
  /** «30 días», o null si no hay plan publicado. */
  trial: string | null
  /** La cuota del mes («USD 59»); null sin plan publicado o si el plan no tiene cuota. */
  fee: string | null
  /** Lo que vuelve cada mes como crédito para los agentes («USD 59»); null si no vuelve nada. */
  credit: string | null
  /** El plan publicado no tiene cuota. */
  noFee: boolean
}

export function offerOf(pricing: Pricing): Offer {
  const plan = shownPlan(pricing)
  return {
    gift: plan && plan.trialCredit > 0 ? money(plan.trialCredit, plan.currency) : null,
    trial: plan ? days(plan.trialDays) : null,
    fee: plan && plan.plan > 0 ? money(plan.plan, plan.currency) : null,
    credit: plan && plan.credit > 0 ? money(plan.credit, plan.currency) : null,
    noFee: plan !== null && plan.plan === 0,
  }
}

/** «30 días con USD 100 de regalo para tus agentes»; sin regalo, «30 días de prueba»; null sin plan. */
export function trialText(pricing: Pricing): string | null {
  const o = offerOf(pricing)
  if (!o.trial) return null
  return o.gift ? `${o.trial} con ${o.gift} de regalo para tus agentes` : `${o.trial} de prueba`
}

/**
 * La cuota en pocas palabras: «USD 59 al mes, que vuelven enteros como crédito». Si el crédito no es
 * toda la cuota, lo dice aparte; sin cuota, «Sin cuota: pagas lo que hacen tus agentes». Null sin plan.
 */
export function feeText(pricing: Pricing): string | null {
  const plan = shownPlan(pricing)
  const o = offerOf(pricing)
  if (!plan) return null
  if (!o.fee) return "Sin cuota: pagas lo que hacen tus agentes"
  if (o.credit && plan.credit === plan.plan) return `${o.fee} al mes, que vuelven enteros como crédito`
  return o.credit ? `${o.fee} al mes, con ${o.credit} de crédito para tus agentes` : `${o.fee} al mes`
}

/** «Después, USD 59 al mes que vuelven como crédito.»: lo que sigue a la prueba. Null sin plan. */
export function afterTrialText(pricing: Pricing): string | null {
  const plan = shownPlan(pricing)
  const o = offerOf(pricing)
  if (!plan) return null
  if (!o.fee) return "Después, pagas solo lo que hacen tus agentes."
  if (o.credit && plan.credit === plan.plan) return `Después, ${o.fee} al mes que vuelven como crédito.`
  return o.credit ? `Después, ${o.fee} al mes, con ${o.credit} de crédito para tus agentes.` : `Después, ${o.fee} al mes.`
}

/**
 * El cierre de cada página: la prueba, sin tarjeta, los límites que no hay y lo que sigue. Con plan:
 * «30 días con USD 100 de regalo para tus agentes, sin tarjeta y sin límite de odontólogos, sedes ni
 * usuarios. Después, USD 59 al mes que vuelven como crédito.». Sin plan publicado, null: cada página
 * dice lo suyo sin cifras.
 */
export function startText(pricing: Pricing, limits: string): string | null {
  const trial = trialText(pricing)
  const after = afterTrialText(pricing)
  return trial && after ? `${trial}, sin tarjeta y ${limits}. ${after}` : null
}

/**
 * La nota bajo el botón de cada portada, con el precio de después junto a «Empieza gratis»: «Empieza
 * hoy, sin invitación ni tarjeta: 30 días con USD 100 de regalo para tus agentes. Después, USD 59 al
 * mes que vuelven como crédito.». Null sin plan publicado.
 */
export function startNote(pricing: Pricing): string | null {
  const trial = trialText(pricing)
  const after = afterTrialText(pricing)
  return trial && after ? `Empieza hoy, sin invitación ni tarjeta: ${trial}. ${after}` : null
}

/** Parte un texto en lo que va antes del regalo, el regalo y lo que sigue, para pintarlo en ámbar. */
export function splitGift(text: string, gift: string | null): [string, string | null, string] {
  const at = gift ? text.indexOf(gift) : -1
  return at < 0 || !gift ? [text, null, ""] : [text.slice(0, at), gift, text.slice(at + gift.length)]
}

/** «¿La prueba pide tarjeta?» y «¿Qué pasa cuando termina la prueba?», con las palabras de cada web. */
export function trialFaq(pricing: Pricing, place: string): FaqItem[] {
  const o = offerOf(pricing)
  const [first, last] = TRIAL_NOTICE_DAYS
  return [
    {
      q: "¿La prueba pide tarjeta?",
      a: `No. Creas tu cuenta, abres tu ${place} y tus agentes trabajan ${o.trial ?? "la prueba"} con ${o.gift ? `${o.gift} de regalo` : "el crédito de prueba"}. No te pedimos tarjeta, ni ahora ni después: cuando eliges tu plan, pagas y subes el comprobante.`,
    },
    {
      q: "¿Qué pasa cuando termina la prueba?",
      a: `Eliges tu plan en Plan y pagos y sigues donde estabas: tu mes empieza ese día. Te avisamos ${first} y ${last} días antes de que termine. Si no lo eliges, tu ${place} queda en solo lectura, sin perder ningún dato, y los agentes se pausan hasta que lo elijas. Si el regalo se acaba antes, los agentes se pausan hasta que termine la prueba y tu equipo ve las conversaciones en la Bandeja.`,
    },
  ]
}

/** «¿Cómo se cobra?» de las portadas de latidIA y vistIA: la cuota que vuelve como crédito y el trabajo. */
export function chargeFaq(pricing: Pricing, people: string): FaqItem {
  const o = offerOf(pricing)
  const fee = feeText(pricing)
  const trial = trialText(pricing)
  const base = !o.fee
    ? "Por lo que hacen tus agentes."
    : o.credit
      ? `Un plan de ${fee}: cada trabajo de tus agentes se descuenta de ahí y, si un mes hacen más, pagas la diferencia.`
      : `Un plan de ${fee}, más lo que hacen tus agentes.`
  return {
    q: "¿Cómo se cobra?",
    a: `${base} Lo simple cuesta poco, lo que te trae ${people} cuesta más y no se cobra por usuario.${trial ? ` Para probarlo, ${trial}.` : ""}`,
  }
}

/** «¿Cada cuánto me cobran?» de Precios: cuándo empieza el mes. */
export function billingStartText(): string {
  return "Tu mes empieza el día que termina la prueba, si ya elegiste tu plan, o el día que lo eliges."
}

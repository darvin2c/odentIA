// Cómo se empieza y qué pasa al terminar la prueba: una sola historia para las tres webs, en la
// portada, el cierre, las preguntas y Precios. Lo que dice es lo que hace el producto (ADR 0031):
// - Fundadores (por invitación): la clínica entra con su plan ya puesto. Al terminar la prueba el
//   plan sigue solo, sin activar nada: su mes empieza ese día y paga lo que hicieron los agentes.
// - Alta abierta: el plan se elige en Plan y pagos. Si se eligió, empieza al terminar la prueba; si
//   no, la clínica queda en solo lectura hasta elegirlo, sin perder datos.
// En los dos, si el saldo de prueba se acaba antes, los agentes se pausan hasta que termina la
// prueba y el equipo ve las conversaciones en la Bandeja. No se pide tarjeta: el pago se registra
// con su comprobante. Ninguna cifra va aquí: todas salen de `Astro.locals.pricing`.
import type { FaqItem } from "./faq"
import { days, money, type Pricing, shownPlan } from "./pricing"

export interface Offer {
  /** El plan que se muestra es el de Fundadores. */
  founder: boolean
  /** El regalo para los agentes («USD 100»), si el plan lo trae. */
  gift: string | null
  /** «30 días», o null si no hay plan publicado. */
  trial: string | null
  /** El plan no tiene cuota. */
  noFee: boolean
  /** «50 % menos en cada trabajo durante 12 meses», solo para Fundadores con descuento. */
  discount: string | null
}

export function offerOf(pricing: Pricing): Offer {
  const plan = shownPlan(pricing)
  const founder = plan !== null && plan === pricing.founders
  const percent = founder ? pricing.founders?.discountPercent : null
  const months = founder ? pricing.founders?.guaranteeMonths : null
  return {
    founder,
    gift: plan && plan.trialCredit > 0 ? money(plan.trialCredit, plan.currency) : null,
    trial: plan ? days(plan.trialDays) : null,
    noFee: plan !== null && plan.plan === 0,
    discount: percent ? `${percent} % menos en cada trabajo${months ? ` durante ${months} meses` : ""}` : null,
  }
}

/** «¿La prueba pide tarjeta?» y «¿Qué pasa cuando termina la prueba?», con las palabras de cada web. */
export function trialFaq(pricing: Pricing, place: string): FaqItem[] {
  const o = offerOf(pricing)
  const gift = o.gift ? `los ${o.gift} de regalo` : "el crédito de regalo"
  if (o.founder) {
    const pays = o.noFee ? "pagas solo lo que hacen tus agentes" : "pagas tu plan y lo que hacen tus agentes"
    return [
      {
        q: "¿La prueba pide tarjeta?",
        a: `No. Pides tu invitación, abres tu ${place} y tus agentes empiezan con ${gift}. La tarjeta no se pide.`,
      },
      {
        q: "¿Qué pasa cuando termina la prueba?",
        a: `Tu plan Fundadores sigue solo: no activas nada. Desde ese día empieza tu mes y ${pays}${o.discount ? `, con ${o.discount}` : ""}. El regalo es para ${o.trial ? `tus primeros ${o.trial}` : "la prueba"}: si se acaba antes, los agentes se pausan hasta que termine y tu equipo ve las conversaciones en la Bandeja.`,
      },
    ]
  }
  return [
    {
      q: "¿La prueba pide tarjeta?",
      a: `No. Te registras, conectas tus canales y tus agentes trabajan ${o.trial ?? "la prueba"} con ${o.gift ? `${o.gift} de crédito` : "el crédito de prueba"}. La tarjeta no se pide.`,
    },
    {
      q: "¿Qué pasa cuando termina la prueba?",
      a: "Si ya elegiste tu plan en Plan y pagos, empieza ese día y sigues donde estabas. Si no lo elegiste, el sistema queda en solo lectura hasta que lo elijas, sin perder ningún dato. Si el crédito de prueba se acaba antes, los agentes se pausan hasta que termine la prueba y tu equipo ve las conversaciones en la Bandeja.",
    },
  ]
}

/** «¿Cada cuánto me cobran?» de Precios: cuándo empieza el mes en cada caso. */
export function billingStartText(pricing: Pricing): string {
  const o = offerOf(pricing)
  return o.founder
    ? "Tu mes empieza el día que termina tu prueba, sin que actives nada."
    : "Tu mes empieza el día que termina la prueba, si ya elegiste tu plan, o el día que lo eliges."
}

// Precios publicados de odentIA (ADR 0031) y el programa Fundadores (issue 165). No hay cifras en
// el código: salen de la administración (planes con «Mostrar en la web») por la ruta pública de la
// API y se guardan 30 segundos, así un cambio se ve en menos de un minuto (decisión 14).

// Este archivo también lo importan las islas (por `money` y los tipos): nada de lo que lee la
// configuración del servidor se evalúa al cargarlo.
import { DEFAULT_DOMAIN, MEDICAL } from "./product"

const FRESH_MS = 30_000

/** Dentro del stack la web llama a la API por la red interna; en local, por su dirección pública. Solo en el servidor. */
function apiBase(): string {
  const domain = import.meta.env.VITE_BASE_DOMAIN || DEFAULT_DOMAIN
  const port = import.meta.env.VITE_BASE_PORT ? `:${import.meta.env.VITE_BASE_PORT}` : ""
  return (process.env.ODENTIA_API_INTERNAL_URL || `https://api.${domain}${port}`).replace(/\/+$/, "")
}

/** El precio de cada tipo de acción (ADR 0085), en unidades. */
export interface TierPrices {
  informa: number | null
  gestiona: number | null
  agenda: number | null
  simple: number | null
  estandar: number | null
  completa: number | null
}

export interface PlanPrices {
  name: string
  currency: string
  /** Cuota al mes, en unidades (no centavos). */
  plan: number
  credit: number
  /** Gestiona y Completa, los de antes de los tipos. */
  conversation: number | null
  consultation: number | null
  recovered: number | null
  tiers: TierPrices
  /** Preguntas a Argos incluidas al mes y el paquete de más; null si el plan no los cobra. */
  argos: { included: number; packQuestions: number; pack: number } | null
  /** GB incluidos y lo que cuesta cada GB extra al mes; null si el plan no cobra el almacenamiento. */
  storage: { includedGb: number; perGb: number } | null
  trialCredit: number
  trialDays: number
}

export interface Pricing {
  /** El plan de lista (el por defecto), si se muestra en la web. */
  list: PlanPrices | null
  /** El plan por invitación (Fundadores), si se muestra en la web. */
  founders: (PlanPrices & { discountPercent: number | null; guaranteeMonths: number | null }) | null
  /** «invitacion»: abrir una clínica pide invitación y la web lleva a la lista de espera. */
  signupMode: "invitacion" | "abierta"
  /** Las condiciones comerciales que se prometen (issue 167, ADR 0074): también de la administración. */
  terms: Terms
}

export interface Terms {
  /** Una conversación por persona en esta ventana. */
  conversationWindowHours: number
  /** Días entre el mensaje del agente y la reserva para que la cita cuente como recuperada. */
  recoveryWindowDays: number
  /** Parte de las conversaciones del mes cuyo spam se devuelve al instante. */
  reviewAutoPercent: number
  /** Días hábiles para responder una revisión de cobro. */
  reviewAnswerDays: number
  /** Con cobro quincenal, a los cuántos días del mes. */
  halfCycleDays: number
  /** Días de gracia antes de restringir. */
  graceDays: number
  /** Prueba cuando no hay un plan por defecto. */
  trialDays: number
  /** Días hábiles para responder una solicitud de invitación. */
  waitlistAnswerDays: number
  /** Días antes del fin de los meses de Fundadores en que se avisa; falta si la API es anterior. */
  guaranteeNoticeDays?: number
}

interface ApiPlan {
  name: string
  currency: string
  priceCents: number
  creditCents: number
  conversationMicros: number | null
  consultationMicros: number | null
  recoveryMicros: number | null
  /** Por tipo (ADR 0085); una API anterior no los trae y se usan los de la acción. */
  tiers?: Record<keyof TierPrices, number | null>
  argosIncludedQuestions?: number
  argosPackQuestions?: number
  argosPackMicros?: number | null
  storageIncludedGb?: number
  storageGbMicros?: number | null
  trialCreditCents: number
  trialDays: number
}

const fromMicros = (micros: number | null) => (micros === null ? null : micros / 1_000_000)

function planOf(plan: ApiPlan): PlanPrices {
  return {
    name: plan.name,
    currency: plan.currency,
    plan: plan.priceCents / 100,
    credit: plan.creditCents / 100,
    conversation: fromMicros(plan.conversationMicros),
    consultation: fromMicros(plan.consultationMicros),
    recovered: fromMicros(plan.recoveryMicros),
    tiers: {
      informa: fromMicros(plan.tiers?.informa ?? plan.conversationMicros),
      gestiona: fromMicros(plan.tiers?.gestiona ?? plan.conversationMicros),
      agenda: fromMicros(plan.tiers?.agenda ?? plan.conversationMicros),
      simple: fromMicros(plan.tiers?.simple ?? plan.consultationMicros),
      estandar: fromMicros(plan.tiers?.estandar ?? plan.consultationMicros),
      completa: fromMicros(plan.tiers?.completa ?? plan.consultationMicros),
    },
    argos:
      plan.argosPackMicros != null
        ? { included: plan.argosIncludedQuestions ?? 0, packQuestions: plan.argosPackQuestions ?? 100, pack: plan.argosPackMicros / 1_000_000 }
        : null,
    storage: plan.storageGbMicros != null ? { includedGb: plan.storageIncludedGb ?? 0, perGb: plan.storageGbMicros / 1_000_000 } : null,
    trialCredit: plan.trialCreditCents / 100,
    trialDays: plan.trialDays,
  }
}

let cached: { at: number; value: Pricing } | null = null
let inflight: Promise<Pricing> | null = null

async function fetchPricing(): Promise<Pricing> {
  // La lista de este producto (ADR 0092): la red interna no lleva el dominio, así que se dice.
  const res = await fetch(`${apiBase()}/api/public/founders/pricing?product=${MEDICAL ? "medical" : "dental"}`, {
    signal: AbortSignal.timeout(3000),
  })
  if (!res.ok) throw new Error(`precios: la API respondió ${res.status}`)
  const body = (await res.json()) as {
    list: ApiPlan | null
    founders: (ApiPlan & { discountPercent: number | null; guaranteeMonths: number | null }) | null
    signupMode: "invitacion" | "abierta"
    terms?: Terms
  }
  // Sin condiciones la respuesta no sirve: la web no las inventa (se sigue con lo último leído).
  if (!body.terms) throw new Error("precios: la API no entregó las condiciones")
  return {
    list: body.list ? planOf(body.list) : null,
    founders: body.founders
      ? { ...planOf(body.founders), discountPercent: body.founders.discountPercent, guaranteeMonths: body.founders.guaranteeMonths }
      : null,
    signupMode: body.signupMode === "abierta" ? "abierta" : "invitacion",
    terms: body.terms,
  }
}

/**
 * Los precios vigentes. Si la API no responde, se sigue mostrando lo último
 * leído; si nunca se pudo leer, lanza (la página responde 503 y no inventa
 * cifras).
 */
export async function loadPricing(): Promise<Pricing> {
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.value
  inflight ??= fetchPricing()
    .then((value) => {
      cached = { at: Date.now(), value }
      return value
    })
    .finally(() => {
      inflight = null
    })
  try {
    return await inflight
  } catch (error) {
    if (cached) return cached.value
    throw error
  }
}

/** Las cifras que usan las islas (calculadoras y escenas), en unidades. */
export interface ValuePrices {
  plan: number
  credit: number
  /** Lo que cuesta en promedio una conversación y una consulta, con la mezcla de tipos de una clínica mediana. */
  conversation: number
  consultation: number
  recovered: number
  /** El precio de cada tipo, para la portada. */
  tiers: Record<keyof TierPrices, number>
}

/**
 * La mezcla de tipos de la clínica mediana del estudio de precios (ADR 0085):
 * de cada 100 conversaciones, 50 informan y 50 gestionan una cita, y 25 de
 * esas citas se dan; de cada 100 consultas, 40 son simples, 35 estándar y 25
 * completas. En latidIA «Completa» es dejar indicada una prestación (un
 * análisis, una ecografía), mucho más frecuente que un presupuesto dental:
 * se supone 15 simples, 40 estándar y 45 completas hasta medir los pilotos.
 * Es un promedio para la calculadora, no lo que se cobra.
 */
export const MIX = {
  informa: 0.5,
  gestiona: 0.5,
  agenda: 0.25,
  ...(MEDICAL ? { simple: 0.15, estandar: 0.4, completa: 0.45 } : { simple: 0.4, estandar: 0.35, completa: 0.25 }),
}

/** Las cifras de un plan para las islas; null si alguna acción no tiene precio. */
export function valuePricesOf(plan: PlanPrices | null): ValuePrices | null {
  if (!plan || plan.recovered === null) return null
  const t = plan.tiers
  if (t.informa === null || t.gestiona === null || t.agenda === null || t.simple === null || t.estandar === null || t.completa === null) return null
  const tiers = { informa: t.informa, gestiona: t.gestiona, agenda: t.agenda, simple: t.simple, estandar: t.estandar, completa: t.completa }
  return {
    plan: plan.plan,
    credit: plan.credit,
    conversation: MIX.informa * tiers.informa + MIX.gestiona * tiers.gestiona + MIX.agenda * (tiers.agenda - tiers.gestiona),
    consultation: MIX.simple * tiers.simple + MIX.estandar * tiers.estandar + MIX.completa * tiers.completa,
    recovered: plan.recovered,
    tiers,
  }
}

/** El plan con que se muestran las cifras: el Fundador mientras se entra por invitación, si no, el de lista. */
export function shownPlan(pricing: Pricing): PlanPrices | null {
  return (pricing.signupMode === "invitacion" ? pricing.founders : null) ?? pricing.list ?? pricing.founders
}

/** El regalo que se promete: el saldo de prueba del plan que se muestra. */
export function giftOf(pricing: Pricing): string | null {
  const plan = shownPlan(pricing)
  return plan && plan.trialCredit > 0 ? money(plan.trialCredit, plan.currency) : null
}

/** «USD 1.560», «USD 0,50»: la moneda ISO, punto de miles y coma decimal; sin decimales si son ceros. */
export function money(value: number, currency: string): string {
  const rounded = Math.round(value * 100) / 100
  const fixed = rounded.toFixed(2).replace(".", ",")
  const trimmed = fixed.endsWith(",00") ? fixed.slice(0, -3) : fixed
  return `${currency} ${trimmed.replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`
}

/** Lo de antes, para quien aún llama `usd`: todos los planes publicados hoy están en dólares. */
export const usd = (value: number) => money(value, "USD")

/** «24 horas», «1 hora». */
export const hours = (n: number) => `${n} ${n === 1 ? "hora" : "horas"}`
/** «7 días», «1 día». */
export const days = (n: number) => `${n} ${n === 1 ? "día" : "días"}`
/** «2 días hábiles», «1 día hábil». */
export const businessDays = (n: number) => `${n} ${n === 1 ? "día hábil" : "días hábiles"}`

// Precios publicados de odentIA (ADR 0031) y el programa Fundadores (issue 165). No hay cifras en
// el código: salen de la administración (planes con «Mostrar en la web») por la ruta pública de la
// API y se guardan 30 segundos, así un cambio se ve en menos de un minuto (decisión 14).

// Este archivo también lo importan las islas (por `money` y los tipos): nada de lo que lee la
// configuración del servidor se evalúa al cargarlo.
const FRESH_MS = 30_000

/** Dentro del stack la web llama a la API por la red interna; en local, por su dirección pública. Solo en el servidor. */
function apiBase(): string {
  const domain = import.meta.env.VITE_BASE_DOMAIN || "odentia.localhost"
  const port = import.meta.env.VITE_BASE_PORT ? `:${import.meta.env.VITE_BASE_PORT}` : ""
  return (process.env.ODENTIA_API_INTERNAL_URL || `https://api.${domain}${port}`).replace(/\/+$/, "")
}

export interface PlanPrices {
  name: string
  currency: string
  /** Cuota al mes, en unidades (no centavos). */
  plan: number
  credit: number
  conversation: number | null
  consultation: number | null
  recovered: number | null
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
}

interface ApiPlan {
  name: string
  currency: string
  priceCents: number
  creditCents: number
  conversationMicros: number | null
  consultationMicros: number | null
  recoveryMicros: number | null
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
    trialCredit: plan.trialCreditCents / 100,
    trialDays: plan.trialDays,
  }
}

let cached: { at: number; value: Pricing } | null = null
let inflight: Promise<Pricing> | null = null

async function fetchPricing(): Promise<Pricing> {
  const res = await fetch(`${apiBase()}/api/public/founders/pricing`, { signal: AbortSignal.timeout(3000) })
  if (!res.ok) throw new Error(`precios: la API respondió ${res.status}`)
  const body = (await res.json()) as {
    list: ApiPlan | null
    founders: (ApiPlan & { discountPercent: number | null; guaranteeMonths: number | null }) | null
    signupMode: "invitacion" | "abierta"
  }
  return {
    list: body.list ? planOf(body.list) : null,
    founders: body.founders
      ? { ...planOf(body.founders), discountPercent: body.founders.discountPercent, guaranteeMonths: body.founders.guaranteeMonths }
      : null,
    signupMode: body.signupMode === "abierta" ? "abierta" : "invitacion",
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
  conversation: number
  consultation: number
  recovered: number
}

/** Las cifras de un plan para las islas; null si alguna acción no tiene precio. */
export function valuePricesOf(plan: PlanPrices | null): ValuePrices | null {
  if (!plan || plan.conversation === null || plan.consultation === null || plan.recovered === null) return null
  return { plan: plan.plan, credit: plan.credit, conversation: plan.conversation, consultation: plan.consultation, recovered: plan.recovered }
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

/**
 * Condiciones de la revisión de cobros (ADR 0054). Siguen fijas en el código
 * de la API (`saas-action-review.ts`) hasta el issue 167; cambian juntas.
 */
export const REVIEW = { spamRefundPercent: 10, answerDays: 2 } as const

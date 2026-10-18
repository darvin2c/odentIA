// Precios publicados de odentIA (ADR 0031). Es la única fuente de cifras de la web:
// solo la sección de precio del inicio y la página Precios las muestran.
// TODO: leerlos del plan por defecto de la administración al generar la web.

export const PRICING = {
  currency: "USD",
  planCents: 2900,
  conversationMicros: 500_000,
  consultationMicros: 400_000,
  recoveredAppointmentMicros: 4_000_000,
  trialCreditCents: 10_000,
  trialDays: 30,
  /** Hasta qué parte de las conversaciones del mes se devuelve el spam sin revisar (ADR 0054). */
  spamRefundPercent: 10,
  /** Días hábiles en que odentIA responde una revisión de cobro (ADR 0054). */
  reviewAnswerDays: 2,
} as const

export const PLAN = PRICING.planCents / 100
export const CONVERSATION = PRICING.conversationMicros / 1_000_000
export const CONSULTATION = PRICING.consultationMicros / 1_000_000
export const RECOVERED = PRICING.recoveredAppointmentMicros / 1_000_000
export const TRIAL_CREDIT = PRICING.trialCreditCents / 100

/** «USD 1.560», «USD 0,50»: punto de miles y coma decimal; sin decimales si son ceros. */
export function usd(value: number): string {
  const rounded = Math.round(value * 100) / 100
  const fixed = rounded.toFixed(2).replace(".", ",")
  const trimmed = fixed.endsWith(",00") ? fixed.slice(0, -3) : fixed
  return `USD ${trimmed.replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`
}

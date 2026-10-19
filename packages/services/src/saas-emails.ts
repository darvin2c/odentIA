// Correos de Plan y pagos con el molde común de `@odentia/mail` (issue 163):
// la variante «Plazo» lleva banda ámbar mientras corre un plazo y roja cuando
// ya pasó; cada aviso tiene su botón a Plan y pagos del panel.
import { type EmailFact, type MailTemplate, renderEmail } from "@odentia/mail"
import type { SaasAlert, SaasAlertFamily } from "./saas-terms.js"

const ALERT_TOPIC: Record<SaasAlertFamily, string> = {
  saldo_prueba: "tu saldo de prueba",
  dias_prueba: "tu prueba termina pronto",
  credito: "el crédito del mes",
  tope: "tu tope de gasto",
  precio_especial: "tu precio especial termina",
  condiciones: "tus condiciones de Fundador terminan",
}

const ALERT_ACTION: Record<SaasAlert["action"], string> = {
  elegir_plan: "Elegir un plan",
  cambiar_tope: "Cambiar mi tope",
  ver_consumo: "Ver mi consumo",
  ver_plan: "Ver mi plan",
}

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** Plan y pagos de la clínica en el panel; sin el origen del panel, el correo va sin botón. */
export function saasBillingUrl(panelUrl: string | undefined, orgId: string): string | null {
  return panelUrl ? `${panelUrl.replace(/\/+$/, "")}/billing/${orgId}` : null
}

const reason = (clinic: string) => `Te escribimos porque administras el plan de ${clinic} en odentIA.`
const action = (label: string, url: string | null) => (url ? { action: { label, url } } : {})

/** Avisos del saldo de prueba, los días de prueba, el crédito y el tope (ADR 0031). */
export function saasAlertEmail(alert: SaasAlert, clinic: string, url: string | null): MailTemplate {
  const topic = ALERT_TOPIC[alert.family]
  return renderEmail({
    subject: `${alert.title}: ${topic}`,
    preview: alert.message,
    title: capitalized(topic),
    ...(alert.level === "aviso" ? {} : { band: { tone: alert.level === "limite" ? "vencido" : "plazo", text: alert.title } }),
    paragraphs: [alert.message],
    ...action(ALERT_ACTION[alert.action], url),
    note: "Lo que hicieron tus agentes está en Plan y pagos.",
    reason: reason(clinic),
  })
}

export function saasTrialEndedEmail(clinic: string, url: string | null): MailTemplate {
  return renderEmail({
    subject: "Tu prueba terminó",
    preview: "El sistema queda en solo lectura hasta que elijas un plan. No se pierde ningún dato.",
    title: "Tu prueba terminó",
    band: { tone: "vencido", text: "Solo lectura desde hoy" },
    paragraphs: [
      "Tu prueba terminó sin un plan elegido: el sistema queda en solo lectura hasta que lo elijas en Plan y pagos. No se pierde ningún dato.",
    ],
    ...action("Elegir un plan", url),
    reason: reason(clinic),
  })
}

export function saasPlanStartedEmail(clinic: string, url: string | null): MailTemplate {
  return renderEmail({
    subject: "Tu plan empezó hoy",
    preview: "Tu mes va de este día al mismo día del mes que viene.",
    title: "Tu plan empezó hoy",
    paragraphs: [
      "Tu prueba terminó y tu plan empezó hoy: tu mes va de este día al mismo día del mes que viene.",
      "La cuota vuelve en crédito para tus agentes y lo que pase del crédito se cobra por acción.",
    ],
    ...action("Ver Plan y pagos", url),
    reason: reason(clinic),
  })
}

export function saasRestrictedEmail(clinic: string, url: string | null): MailTemplate {
  return renderEmail({
    subject: "Tu acceso quedó restringido",
    preview: "Registra tu comprobante en Plan y pagos para reanudarlo.",
    title: "Tu acceso quedó restringido",
    band: { tone: "vencido", text: "Acceso restringido desde hoy" },
    paragraphs: [
      "Tu acceso se restringió por falta de pago. Puedes ver tu plan, registrar tu comprobante y contactar soporte desde el panel.",
    ],
    ...action("Registrar mi comprobante", url),
    reason: reason(clinic),
  })
}

/** Cargo vencido: el plazo de gracia, con el día escrito como se lee («sábado 25 de octubre de 2026»). */
export function saasOverdueEmail(input: {
  clinic: string
  lastDay: string
  amounts: readonly string[]
  url: string | null
}): MailTemplate {
  const facts: EmailFact[] = [
    ...input.amounts.map((value) => ({ label: "Monto pendiente", value })),
    { label: "Último día", value: capitalized(input.lastDay) },
  ]
  return renderEmail({
    subject: "Tienes un cargo vencido",
    preview: `Regístralo hasta el ${input.lastDay} para no perder acceso.`,
    title: "Tienes un cargo vencido",
    band: { tone: "plazo", text: `Plazo: hasta el ${input.lastDay}` },
    paragraphs: [
      `El cargo de ${input.clinic} no está pagado. Registra tu comprobante en Plan y pagos antes del plazo para que el equipo siga trabajando sin cortes.`,
    ],
    facts,
    ...action("Registrar mi comprobante", input.url),
    note: "Si no se registra a tiempo, el acceso se restringe. No se pierde ningún dato.",
    reason: reason(input.clinic),
  })
}

/** Una fila del detalle de la liquidación: clínica con su comisión o ajuste con su motivo. */
export interface SaasSettlementLine {
  label: string
  amount: string
}

/** Liquidación de comisiones a quien vende odentIA: los montos con su moneda y el total destacado. */
export function saasSettlementEmail(input: {
  sellerName: string
  /** «septiembre de 2026». */
  monthText: string
  clinics: number
  gross: string
  adjustments: string
  total: string
  /** Detalle congelado: una fila por clínica y una por ajuste, antes del total. */
  lines: readonly SaasSettlementLine[]
}): MailTemplate {
  return renderEmail({
    subject: `Tu liquidación de ${input.monthText}`,
    preview: `Total a pagarte: ${input.total}.`,
    title: `Tu liquidación de ${input.monthText}`,
    paragraphs: [`Hola, ${input.sellerName}. Cerramos tus comisiones de ${input.monthText}. Este es el resumen.`],
    facts: [
      { label: "Clínicas con cobros", value: String(input.clinics) },
      { label: "Comisión por cobros", value: input.gross },
      ...input.lines.map((line) => ({ label: line.label, value: line.amount })),
      { label: "Ajustes", value: input.adjustments },
      { label: "Total a pagarte", value: input.total, total: true },
    ],
    reason: "Te escribimos porque vendes odentIA y cerramos tu mes.",
    replies: "Este correo no recibe respuestas: si algo no cuadra, escríbele a tu contacto en odentIA.",
  })
}

/* ---------- Fundadores (issue 165) ---------- */

/** «USD 100», «USD 0,50»: la moneda ISO antes de la cifra, coma decimal y sin «,00». */
export function moneyText(currency: string, cents: number): string {
  const fixed = (Math.round(cents) / 100).toFixed(2).replace(".", ",")
  const trimmed = fixed.endsWith(",00") ? fixed.slice(0, -3) : fixed
  return `${currency} ${trimmed.replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`
}

/** Copia a quien pidió entrar: qué sigue y en cuánto respondemos. Sin botón: no hay nada que hacer todavía. */
export function waitlistReceivedEmail(input: {
  firstName: string
  clinicName: string
  phone: string
  answerDays: number
  /** Buzón de Fundadores (FOUNDERS_EMAIL); sin él, el correo no promete que alguien lea las respuestas. */
  replyTo?: string | undefined
}): MailTemplate {
  return renderEmail({
    subject: `${input.clinicName} está en la lista de odentIA`,
    preview: `Revisamos tu solicitud en ${input.answerDays} días hábiles.`,
    title: `Listo, ${input.firstName}. ${input.clinicName} está en la lista`,
    paragraphs: ["Mientras dure el programa Fundadores, se entra a odentIA por invitación. Esto es lo que sigue:"],
    list: [
      `Revisamos tu solicitud en ${input.answerDays} días hábiles.`,
      `Te escribimos por WhatsApp al ${input.phone} para una llamada corta.`,
      "Te llega tu invitación por correo y abres tu clínica como Fundadora.",
    ],
    note: input.replyTo ? "Si te equivocaste en un dato, responde este correo." : "Si te equivocaste en un dato, te lo preguntamos cuando te escribamos.",
    reason: "Te escribimos porque pediste una invitación en la web de odentIA.",
    ...(input.replyTo ? { replyTo: input.replyTo, replies: "Si respondes, te lee el equipo de odentIA." } : {}),
  })
}

/** La invitación Fundadores: lo que recibe, en cifras del plan, y hasta cuándo vale el enlace. */
export function founderInvitationEmail(input: {
  firstName: string
  clinicName: string
  email: string
  url: string
  /** «domingo 1 de noviembre». */
  expiresText: string
  offer: { currency: string; priceCents: number; trialCreditCents: number; discountPercent: number | null; guaranteeMonths: number | null }
  /** Buzón de Fundadores (FOUNDERS_EMAIL); sin él, se pide otra invitación desde la web. */
  replyTo?: string | undefined
}): MailTemplate {
  const credit = moneyText(input.offer.currency, input.offer.trialCreditCents)
  const fee = input.offer.priceCents === 0 ? "y no pagas cuota" : `y tu cuota es de ${moneyText(input.offer.currency, input.offer.priceCents)} al mes`
  const after = input.offer.discountPercent
    ? `Después pagas solo lo que hacen, con ${input.offer.discountPercent} % menos que el precio de lista`
    : "Después pagas solo lo que hacen"
  const months = input.offer.guaranteeMonths ? `, durante ${input.offer.guaranteeMonths} meses.` : "."
  return renderEmail({
    subject: "Tu lugar en odentIA Fundadores está listo",
    preview: `Los primeros ${credit} de tus agentes los pagamos nosotros.`,
    title: `${input.firstName}, ${input.clinicName} ya puede entrar`,
    paragraphs: [`Te guardamos un lugar en el programa Fundadores. Los primeros ${credit} de tus agentes los pagamos nosotros, ${fee}. ${after}${months}`],
    action: { label: "Crear mi cuenta", url: input.url },
    note: `El enlace sirve para ${input.email} y vence el ${input.expiresText}. ${
      input.replyTo ? "Si vence, responde este correo y te enviamos otro." : "Si vence, pídela de nuevo desde la web de odentIA y te enviamos otra."
    }`,
    reason: "Te escribimos porque pediste una invitación en la web de odentIA.",
    ...(input.replyTo ? { replyTo: input.replyTo, replies: "Si respondes, te lee el equipo de odentIA." } : {}),
  })
}

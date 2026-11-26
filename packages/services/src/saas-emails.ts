// Correos de Plan y pagos con el molde común de `@odentia/mail` (issue 163):
// la variante «Plazo» lleva banda ámbar mientras corre un plazo y roja cuando
// ya pasó; cada aviso tiene su botón a Plan y pagos del panel.
import { type ClinicalProduct, countryDisplayName, productWords } from "@odentia/clinical"
import { type EmailFact, type MailBrand, mailBrandName, type MailTemplate, renderEmail } from "@odentia/mail"
import type { SaasAlert, SaasAlertFamily } from "./saas-terms.js"

const ALERT_TOPIC: Record<SaasAlertFamily, string> = {
  saldo_prueba: "tu saldo de prueba",
  dias_prueba: "tu prueba termina pronto",
  credito: "el crédito del mes",
  tope: "tu presupuesto del mes",
  precio_especial: "tu precio especial termina",
  condiciones: "tus precios garantizados terminan",
}

const ALERT_ACTION: Record<SaasAlert["action"], string> = {
  elegir_plan: "Elegir un plan",
  cambiar_tope: "Cambiar mi presupuesto",
  ver_consumo: "Ver mi consumo",
  ver_plan: "Ver mi plan",
}

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/**
 * Plan y pagos de la clínica: el enlace va al panel, que lleva a la página
 * dentro de la clínica (ADR 0065) sin que el correo necesite su dirección.
 * Sin el origen del panel, el correo va sin botón.
 */
export function saasBillingUrl(panelUrl: string | undefined, orgId: string): string | null {
  return panelUrl ? `${panelUrl.replace(/\/+$/, "")}/billing/${orgId}` : null
}

/** Por qué lo recibe, con el nombre de la marca de la clínica (odentIA o latidIA, issue 229). */
const reason = (clinic: string, brand?: MailBrand) =>
  `Te escribimos porque administras el plan de ${clinic} en ${mailBrandName(brand)}.`
const action = (label: string, url: string | null) => (url ? { action: { label, url } } : {})

/** Avisos del saldo de prueba, los días de prueba, el crédito y el tope (ADR 0031). */
export function saasAlertEmail(alert: SaasAlert, clinic: string, url: string | null, brand?: MailBrand): MailTemplate {
  const topic = ALERT_TOPIC[alert.family]
  return renderEmail({
    brand,
    subject: `${alert.title}: ${topic}`,
    preview: alert.message,
    title: capitalized(topic),
    ...(alert.level === "aviso" ? {} : { band: { tone: alert.level === "limite" ? "vencido" : "plazo", text: alert.title } }),
    paragraphs: [alert.message],
    ...action(ALERT_ACTION[alert.action], url),
    note: "Lo que hicieron tus agentes está en Plan y pagos.",
    reason: reason(clinic, brand),
  })
}

export function saasTrialEndedEmail(clinic: string, url: string | null, brand?: MailBrand): MailTemplate {
  return renderEmail({
    brand,
    subject: "Tu prueba terminó",
    preview: "El sistema queda en solo lectura hasta que elijas un plan. No se pierde ningún dato.",
    title: "Tu prueba terminó",
    band: { tone: "vencido", text: "Solo lectura desde hoy" },
    paragraphs: [
      "Tu prueba terminó sin un plan elegido: el sistema queda en solo lectura hasta que lo elijas en Plan y pagos. No se pierde ningún dato.",
    ],
    ...action("Elegir un plan", url),
    reason: reason(clinic, brand),
  })
}

export function saasPlanStartedEmail(clinic: string, url: string | null, brand?: MailBrand): MailTemplate {
  return renderEmail({
    brand,
    subject: "Tu plan empezó hoy",
    preview: "Tu mes va de este día al mismo día del mes que viene.",
    title: "Tu plan empezó hoy",
    paragraphs: [
      "Tu prueba terminó y tu plan empezó hoy: tu mes va de este día al mismo día del mes que viene.",
      "La cuota vuelve en crédito para tus agentes y lo que pase del crédito se cobra por acción.",
    ],
    ...action("Ver Plan y pagos", url),
    reason: reason(clinic, brand),
  })
}

export function saasRestrictedEmail(clinic: string, url: string | null, brand?: MailBrand): MailTemplate {
  return renderEmail({
    brand,
    subject: "Tu acceso quedó restringido",
    preview: "Registra tu comprobante en Plan y pagos para reanudarlo.",
    title: "Tu acceso quedó restringido",
    band: { tone: "vencido", text: "Acceso restringido desde hoy" },
    paragraphs: [
      "Tu acceso se restringió por falta de pago: la clínica queda en solo lectura. Dentro de la clínica, en Configuración › Plan y pagos, puedes ver tu plan y registrar tu comprobante.",
    ],
    ...action("Registrar mi comprobante", url),
    reason: reason(clinic, brand),
  })
}

/** Cargo vencido: el plazo de gracia, con el día escrito como se lee («sábado 25 de octubre de 2026»). */
export function saasOverdueEmail(input: {
  clinic: string
  lastDay: string
  amounts: readonly string[]
  url: string | null
  brand?: MailBrand
}): MailTemplate {
  const facts: EmailFact[] = [
    ...input.amounts.map((value) => ({ label: "Monto pendiente", value })),
    { label: "Último día", value: capitalized(input.lastDay) },
  ]
  return renderEmail({
    brand: input.brand,
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
    reason: reason(input.clinic, input.brand),
  })
}

/** Llegó el cargo del mes (ADR 0065): vence 7 días después, y se dice el día. */
export function saasChargeIssuedEmail(input: {
  clinic: string
  monthText: string
  amount: string
  dueDay: string
  url: string | null
  brand?: MailBrand
}): MailTemplate {
  return renderEmail({
    brand: input.brand,
    subject: `Tu cargo de ${input.monthText}`,
    preview: `Vence el ${input.dueDay}.`,
    title: `Tu cargo de ${input.monthText}`,
    paragraphs: [
      `Ya está el cargo de ${input.monthText} de ${input.clinic}. Regístralo en Plan y pagos antes de que venza para que el equipo siga trabajando sin cortes.`,
    ],
    facts: [
      { label: "Monto", value: input.amount },
      { label: "Vence", value: capitalized(input.dueDay), total: true },
    ],
    ...action("Registrar mi comprobante", input.url),
    reason: reason(input.clinic, input.brand),
  })
}

/**
 * Mañana termina la gracia (ADR 0065): el último aviso antes de pasar a solo
 * lectura. Con un comprobante en revisión (`inReview`) no pide registrar otro
 * (el cargo no lo acepta mientras ese espera) y dice lo mismo que la franja:
 * se está revisando y, si no se confirma antes, mañana pasa a solo lectura.
 */
export function saasRestrictionSoonEmail(input: {
  clinic: string
  amounts: readonly string[]
  url: string | null
  brand?: MailBrand
  inReview?: boolean
}): MailTemplate {
  if (input.inReview) {
    const who = mailBrandName(input.brand)
    return renderEmail({
      brand: input.brand,
      subject: "Mañana tu clínica pasa a solo lectura",
      preview: `${who} está revisando tu comprobante: si no se confirma hoy, mañana la clínica pasa a solo lectura.`,
      title: "Mañana tu clínica pasa a solo lectura",
      band: { tone: "vencido", text: "Comprobante en revisión" },
      paragraphs: [
        `${who} está revisando el comprobante de ${input.clinic}. Si no se confirma antes, mañana el equipo podrá ver todo, pero no guardar, y Sofi no responderá.`,
      ],
      facts: input.amounts.map((value) => ({ label: "Monto pendiente", value })),
      ...action("Ver Plan y pagos", input.url),
      note: "No tienes que registrar otro comprobante. No se pierde ningún dato.",
      reason: reason(input.clinic, input.brand),
    })
  }
  return renderEmail({
    brand: input.brand,
    subject: "Mañana tu clínica pasa a solo lectura",
    preview: "Registra tu comprobante hoy para que el equipo siga trabajando.",
    title: "Mañana tu clínica pasa a solo lectura",
    band: { tone: "vencido", text: "Último día para registrar el pago" },
    paragraphs: [
      `El cargo de ${input.clinic} sigue sin pagar. Si hoy no se registra el comprobante, mañana el equipo podrá ver todo, pero no guardar, y Sofi no responderá.`,
    ],
    facts: input.amounts.map((value) => ({ label: "Monto pendiente", value })),
    ...action("Registrar mi comprobante", input.url),
    note: "No se pierde ningún dato.",
    reason: reason(input.clinic, input.brand),
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
    reason: "Te escribimos porque vendes odentIA, latidIA o vistIA y cerramos tu mes.",
    replies: "Este correo no recibe respuestas: si algo no cuadra, escríbele a tu contacto en la administración.",
  })
}

/* ---------- La web y la invitación de la administración ---------- */

/** «USD 100», «USD 0,50»: la moneda ISO antes de la cifra, coma decimal y sin «,00». */
export function moneyText(currency: string, cents: number): string {
  const fixed = (Math.round(cents) / 100).toFixed(2).replace(".", ",")
  const trimmed = fixed.endsWith(",00") ? fixed.slice(0, -3) : fixed
  return `${currency} ${trimmed.replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`
}

/**
 * Las plantillas que pidió quien dejó su correo en una guía de la web (ADR 0216): van
 * adjuntas en PDF, con el enlace a la guía y la puerta para empezar («Empieza gratis»). Las
 * cifras llegan de los precios publicados.
 */
export function webContactEmail(input: {
  /** Los nombres de las plantillas adjuntas: «Odontograma», «Odontograma de niños». */
  sheets: readonly string[]
  /** La guía donde lo dejó, en la web. */
  guideUrl: string
  /** Cómo se hace en la app, en una línea. */
  pitch: string
  /** La demo de la guía («Pruébalo aquí»), donde se ve cómo se hace sin crear una cuenta. */
  tryUrl?: string | null
  /** La puerta para empezar, como el botón de la web; nula si no hay. */
  start: { label: string; url: string } | null
  /** Lo que promete el plan que se muestra («30 días con USD 100 de regalo para tus agentes»); nulo si nada. */
  offer: string | null
  replyTo?: string | undefined
  brand?: MailBrand
}): MailTemplate {
  const name = mailBrandName(input.brand)
  const one = input.sheets.length === 1
  return renderEmail({
    brand: input.brand,
    subject: one ? `Tu plantilla para imprimir: ${input.sheets[0]}` : "Tus plantillas para imprimir",
    preview: one ? "Va adjunta en PDF, lista para imprimir en A4." : "Van adjuntas en PDF, listas para imprimir en A4.",
    title: one ? "Aquí tienes tu plantilla" : "Aquí tienes tus plantillas",
    // Con enlaces de verdad (la guía y su demo): por eso va con formato y no en párrafos sueltos.
    formatted: [
      `${one ? "Va adjunta" : "Van adjuntas"} en PDF, ${one ? "lista" : "listas"} para imprimir en A4: ${input.sheets.join(" y ")}.`,
      `Los pasos para ${one ? "llenarla" : "llenarlas"} siguen en [la guía](${input.guideUrl}).`,
      input.pitch,
      ...(input.tryUrl ? [`[Míralo funcionando](${input.tryUrl}), sin crear una cuenta.`] : []),
      ...(input.offer ? [input.offer] : []),
    ].join("\n\n"),
    paragraphs: [],
    ...(input.start ? action(input.start.label, input.start.url) : {}),
    reason: `Te escribimos porque dejaste tu correo en una guía de la web de ${name}.`,
    ...(input.replyTo ? { replyTo: input.replyTo, replies: `Si respondes, te lee el equipo de ${name}.` } : {}),
  })
}

/**
 * La invitación que el equipo le manda a un cliente desde su venta: su cuenta lista con el
 * plan negociado, lo que recibe en cifras de ese plan y hasta cuándo vale el enlace. Ya no
 * hace falta para entrar (ADR 0221): es como llega lo que se negoció.
 */
export function founderInvitationEmail(input: {
  firstName: string
  clinicName: string
  email: string
  url: string
  /** «domingo 1 de noviembre». */
  expiresText: string
  offer: { planName?: string; currency: string; priceCents: number; trialCreditCents: number; discountPercent: number | null; guaranteeMonths: number | null }
  /** hola@ de la marca, que entra al ARM; sin él, se pide otro enlace a quien lo mandó. */
  replyTo?: string | undefined
  /** La marca de la solicitud (issue 229). */
  brand?: MailBrand
}): MailTemplate {
  const name = mailBrandName(input.brand)
  const credit = moneyText(input.offer.currency, input.offer.trialCreditCents)
  const plan = input.offer.planName ? `con el plan ${input.offer.planName}` : "con tu plan"
  const fee = input.offer.priceCents === 0 ? "sin cuota" : `con una cuota de ${moneyText(input.offer.currency, input.offer.priceCents)} al mes`
  const discount = input.offer.discountPercent ? `, con ${input.offer.discountPercent} % menos que el precio de lista` : ""
  const months = input.offer.guaranteeMonths ? ` Esos precios valen ${input.offer.guaranteeMonths} meses.` : ""
  return renderEmail({
    brand: input.brand,
    subject: `Tu cuenta en ${name} está lista`,
    preview: `Tus agentes empiezan con ${credit} de regalo.`,
    title: `${input.firstName}, ${input.clinicName} ya puede entrar`,
    paragraphs: [
      `Te preparamos tu cuenta ${plan}: tus agentes empiezan con ${credit} de regalo y después pagas ${fee} lo que hacen${discount}.${months}`,
    ],
    action: { label: "Crear mi cuenta", url: input.url },
    note: `El enlace sirve para ${input.email} y vence el ${input.expiresText}. ${
      input.replyTo ? "Si vence, responde este correo y te enviamos otro." : `Si vence, pídele otro a quien te escribió de ${name}.`
    }`,
    reason: `Te escribimos porque hablaste con el equipo de ${name} y te preparó tu cuenta.`,
    ...(input.replyTo ? { replyTo: input.replyTo, replies: `Si respondes, te lee el equipo de ${name}.` } : {}),
  })
}

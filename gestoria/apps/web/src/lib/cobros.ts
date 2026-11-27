import type { PaymentCollection, PaymentTypeCode } from "./tienda"

/**
 * Cobros (lienzo «gestorIA · Configuración, de nuevo», tablero 6): las dos formas de cobrar,
 * la que confirma la pasarela sola (el link) y la que confirma una persona (Yape, Plin y la
 * transferencia a la tienda, y lo que se cobra al recibir). Qué vale y qué no lo decide el
 * servidor (`apps/api/src/cobros.ts`); aquí, cómo se dice.
 */

export type PaymentKind = "yape" | "plin" | "transferencia" | "efectivo" | "pos" | "link" | "otro"

export interface PaymentMethod {
  id: string
  name: string
  kind: PaymentKind
  typeCode: PaymentTypeCode
  collection: PaymentCollection
  /** Lo que Sofi envía para pagar (en Yape, Plin y la transferencia lo arma el servidor). */
  details: string
  phone: string | null
  holder: string | null
  bankCode: string | null
  accountNumber: string | null
  cci: string | null
  isActive: boolean
  /** Cuándo se subió su QR (la versión de la imagen); null sin QR. */
  qrAt: string | null
}

export interface Bank {
  code: string
  short: string
  name: string
}

/** Las formas que se agregan con sus datos, en el orden en que se ofrecen. */
export const KINDS: Record<
  Exclude<PaymentKind, "link">,
  { name: string; hint: string; badge: string; tone: string }
> = {
  yape: {
    name: "Yape",
    hint: "A tu celular, con tu QR",
    badge: "Y",
    tone: "bg-[#742284] text-white",
  },
  plin: {
    name: "Plin",
    hint: "A tu celular, con tu QR",
    badge: "P",
    tone: "bg-[#00b5c8] text-white",
  },
  transferencia: {
    name: "Transferencia",
    hint: "A tu cuenta, con su CCI",
    badge: "BAN",
    tone: "bg-[#0a3d8f] text-white",
  },
  efectivo: {
    name: "Efectivo al recibir",
    hint: "Lo cobra quien entrega",
    badge: "S/",
    tone: "bg-success-soft text-success-strong",
  },
  pos: {
    name: "Tarjeta con tu POS",
    hint: "Al recibir, con tu POS",
    badge: "POS",
    tone: "bg-surface-muted text-foreground",
  },
  otro: {
    name: "Otra forma",
    hint: "Con tu propio texto",
    badge: "+",
    tone: "bg-surface-muted text-foreground",
  },
}

/** Quién confirma cada forma (tablero 6): sin pago confirmado no se entrega. */
export function whoConfirms(method: Pick<PaymentMethod, "kind" | "collection">): string {
  switch (method.kind) {
    case "transferencia":
      return "Tú o Ventas, con la constancia"
    case "efectivo":
      return "El repartidor, al recibirlo"
    case "pos":
      return "El repartidor, con la foto del voucher"
    case "link":
      return "La pasarela, sola"
    default:
      return method.collection === "al_recibir"
        ? "Quien entrega, al recibirlo"
        : "Tú o Ventas, con la captura"
  }
}

/** «+51987654321» → «987 654 321». */
export function phoneText(e164: string | null): string {
  const peru = e164 ? /^\+51(9\d{2})(\d{3})(\d{3})$/.exec(e164) : null
  return peru ? `${peru[1]} ${peru[2]} ${peru[3]}` : (e164 ?? "")
}

/** «002 191 002345678012 53», como lo muestran los bancos. */
export function cciText(digits: string): string {
  return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 18)} ${digits.slice(18)}`
}

/** Solo los números del CCI. */
export function cciDigits(text: string): string {
  return text.replace(/[\s.-]/g, "")
}

/**
 * Los dígitos de control del CCI, para decirlo mientras se escribe: la misma cuenta del servidor
 * (`apps/api/src/cci.ts`, con sus casos publicados), que es quien decide al guardar.
 */
function controlDigit(digits: string): number {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    const product = Number(digits[i]) * (i % 2 === 0 ? 1 : 2)
    sum += product > 9 ? product - 9 : product
  }
  return (10 - (sum % 10)) % 10
}

export type CciCheck = "vacio" | "incompleto" | "numeros" | "control" | "ok"

export function cciCheck(text: string): CciCheck {
  const digits = cciDigits(text)
  if (!digits) return "vacio"
  if (!/^\d+$/.test(digits)) return "numeros"
  if (digits.length !== 20) return "incompleto"
  const ok =
    digits.slice(18) === `${controlDigit(digits.slice(0, 6))}${controlDigit(digits.slice(6, 18))}`
  return ok ? "ok" : "control"
}

/** Lo que dice la clienta que recibe el dato de Yape o Plin (la vista previa del formulario). */
export function walletPreview(
  kind: "yape" | "plin",
  phone: string | null,
  holder: string,
  amount: string,
  withQr: boolean,
): string {
  const verb = kind === "yape" ? "yapear" : "plinear"
  const who = holder.trim() ? ` (${holder.trim()})` : ""
  const number = phone ? phoneText(phone) : "tu número"
  return `Puedes ${verb} ${amount} al ${number}${who}${withQr ? " o escanear este QR" : ""}. Mándame la captura y te confirmo.`
}

/**
 * Cuánto cobra la pasarela, en soles (tablero 6 y 12): la comisión publicada por Mercado Pago
 * Perú en noviembre de 2026 para recibir el dinero al instante, 3,49 % + S/ 1 + IGV (18 %). Cambia
 * por rubro y contrato: la pantalla dice que es la publicada. Otra moneda, no se dice.
 */
export const MERCADO_PAGO_FEE = { currency: "PEN", percent: 3.49, fixedCents: 100, tax: 0.18 }

/** Lo que recibe la tienda por un cobro (en céntimos), con la comisión publicada. */
export function netOf(cents: number): number {
  const fee = (cents * MERCADO_PAGO_FEE.percent) / 100 + MERCADO_PAGO_FEE.fixedCents
  return Math.round(cents - fee * (1 + MERCADO_PAGO_FEE.tax))
}

export interface LinkStatus {
  /** Si gestorIA puede conectar una pasarela (tiene su aplicación en Mercado Pago). */
  available: boolean
  connection: {
    provider: "mercadopago"
    state: "conectada" | "vencida" | "sin_permiso"
    mode: "prueba" | "real"
    account: string | null
    connectedAt: string
    connectedByName: string | null
    expiresAt: string | null
  } | null
  openLinks: number
  trial: {
    id: string
    url: string
    amountCents: number
    createdAt: string
    paidAt: string | null
    paidCents: number | null
  } | null
  method: { id: string; isActive: boolean } | null
}

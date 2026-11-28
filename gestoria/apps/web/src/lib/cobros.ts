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

/**
 * Lo que está mal en el CCI, dicho como error del campo (null si está bien o vacío): sus números,
 * sus dígitos de control y que sea del banco elegido (sus 3 primeros números), lo mismo que
 * revisa el servidor al guardar (`apps/api/src/cobros.ts`).
 */
export function cciIssue(text: string, bankCode: string, banks: Bank[]): string | null {
  const check = cciCheck(text)
  const digits = cciDigits(text).length
  if (check === "vacio") return null
  if (check === "numeros") return "El CCI lleva solo números."
  if (check === "incompleto")
    return digits < 20
      ? "Faltan números: el CCI tiene 20."
      : "El CCI tiene 20 números: sobran algunos."
  if (check === "control") return "Algún número no coincide con sus dígitos de control: revísalo."
  const chosen = banks.find((bank) => bank.code === bankCode)
  const own = cciDigits(text).slice(0, 3)
  if (chosen && own !== chosen.code)
    return `Ese CCI es de ${banks.find((bank) => bank.code === own)?.short ?? "otro banco"}, no de ${chosen.short}: revisa el banco o el CCI.`
  return null
}

/** El CCI ya se puede juzgar mientras se escribe: tiene sus 20 números, más, o algo que no es número. */
export function cciReady(text: string): boolean {
  const check = cciCheck(text)
  return check === "numeros" || cciDigits(text).length >= 20
}

/**
 * Lo que recibe la clienta con el dato de Yape o Plin (la vista previa del formulario). El QR no va:
 * hoy ningún canal manda imágenes; se guarda y Sofi lo enviará cuando el chat por WhatsApp esté
 * conectado.
 */
export function walletPreview(
  kind: "yape" | "plin",
  phone: string | null,
  holder: string,
  amount: string,
): string {
  const verb = kind === "yape" ? "yapear" : "plinear"
  const who = holder.trim() ? ` (${holder.trim()})` : ""
  const number = phone ? phoneText(phone) : "tu número"
  return `Puedes ${verb} ${amount} al ${number}${who}. Mándame la captura y te confirmo.`
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
  /** Si se puede conectar una pasarela: con las claves de la tienda. */
  available: boolean
  /** Si además se puede entrar a la cuenta (gestorIA tiene su aplicación en Mercado Pago). */
  accountDoor: boolean
  connection: {
    provider: "mercadopago"
    /** Cómo se conectó: entrando a la cuenta, o con las claves (el Access Token) de la tienda. */
    via: "cuenta" | "claves"
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

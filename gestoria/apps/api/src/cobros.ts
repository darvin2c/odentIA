import {
  type Db,
  MAX_PHOTO_BYTES,
  PAYMENT_COLLECTIONS,
  PAYMENT_TYPE_CODES,
  type PaymentCollection,
  type PaymentKind,
  type PaymentTypeCode,
  storeEvent,
  storePaymentMethod,
  storePaymentQr,
} from "@gestoria/db"
import { and, eq, sql } from "drizzle-orm"
import { z } from "zod"
import { imageType } from "./catalogo.js"
import { cciBank, cciDigits, cciProblem, cciText } from "./cci.js"
import type { Person } from "./cuenta.js"
import { inStore, StoreError } from "./tiendas.js"

/**
 * Cobros (lienzo «gestorIA · Configuración, de nuevo», tablero 6; ADR 0232): cada forma de cobro
 * con sus datos, no con un texto libre. Yape y Plin con su celular en E.164, su titular y su QR;
 * la transferencia con su banco de una lista, su cuenta y su CCI revisado con sus dígitos de
 * control; el efectivo y el POS al recibir, con una nota. Lo que Sofi envía para pagar
 * (`details`) lo arma el servidor con esos datos: Sofi lee lo mismo que antes.
 *
 * Los tipos de UN/CEFACT 4461 y el orden de cobro de Sofi (link, captura, al recibir) no cambian:
 * cada forma lleva su tipo y su manera de confirmarse fijos (`KIND_RULES`), y «otro» elige.
 */

/** Lo más que una tienda puede tener de cada lista (también las formas de entrega). */
export const MAX_METHODS = 30

/**
 * Los bancos y cajas del Perú que reciben transferencias con CCI, con su código de entidad de la
 * Cámara de Compensación Electrónica (los tres primeros números del CCI). Tomados de la lista de
 * «Bancos que validan CCI» del MEF (SIAF, 2015), con los nombres de hoy (Banco Financiero es hoy
 * Pichincha; Continental, BBVA). Una entidad que falte se suma aquí.
 */
export const BANKS = [
  { code: "002", short: "BCP", name: "Banco de Crédito del Perú (BCP)" },
  { code: "003", short: "Interbank", name: "Interbank" },
  { code: "011", short: "BBVA", name: "BBVA" },
  { code: "009", short: "Scotiabank", name: "Scotiabank" },
  { code: "018", short: "Banco de la Nación", name: "Banco de la Nación" },
  { code: "038", short: "BanBif", name: "BanBif" },
  { code: "035", short: "Pichincha", name: "Banco Pichincha" },
  { code: "023", short: "Banco de Comercio", name: "Banco de Comercio" },
  { code: "053", short: "GNB", name: "Banco GNB" },
  { code: "056", short: "Santander", name: "Banco Santander" },
  { code: "007", short: "Citibank", name: "Citibank" },
  { code: "803", short: "Caja Arequipa", name: "Caja Arequipa" },
  { code: "802", short: "Caja Trujillo", name: "Caja Trujillo" },
  { code: "805", short: "Caja Sullana", name: "Caja Sullana" },
] as const
export type BankCode = (typeof BANKS)[number]["code"]
const BANK_CODES = BANKS.map((bank) => bank.code) as [BankCode, ...BankCode[]]

export function bankOf(code: string | null) {
  return BANKS.find((bank) => bank.code === code) ?? null
}

/** Cada forma con su tipo de 4461 y su manera de confirmarse (lo mismo exige la base). */
export const KIND_RULES: Record<
  Exclude<PaymentKind, "otro" | "link">,
  { typeCode: PaymentTypeCode; collection: PaymentCollection; name: string }
> = {
  yape: { typeCode: "68", collection: "comprobante", name: "Yape" },
  plin: { typeCode: "68", collection: "comprobante", name: "Plin" },
  transferencia: { typeCode: "30", collection: "comprobante", name: "Transferencia" },
  efectivo: { typeCode: "10", collection: "al_recibir", name: "Efectivo al recibir" },
  pos: { typeCode: "48", collection: "al_recibir", name: "Tarjeta con tu POS" },
}

/** «+51987654321» → «987 654 321». Otro país, tal cual. */
export function phoneText(e164: string): string {
  const peru = /^\+51(9\d{2})(\d{3})(\d{3})$/.exec(e164)
  return peru ? `${peru[1]} ${peru[2]} ${peru[3]}` : e164
}

const holder = z
  .string("Escribe a nombre de quién está")
  .trim()
  .min(1, "Escribe a nombre de quién está, como aparece en la app")
  .max(80, "Máximo 80 caracteres")
const isActive = z.boolean().default(true)
const note = z.string().trim().max(300, "Máximo 300 caracteres").default("")

/** Yape y Plin funcionan con celulares del Perú: +51 y 9 números que empiezan con 9. */
const walletPhone = z
  .string("Escribe el celular con el que cobras")
  .trim()
  .regex(/^\+519\d{8}$/, "Escribe el celular de 9 números con el que cobras (empieza con 9)")

const walletInput = (kind: "yape" | "plin") =>
  z.object({ kind: z.literal(kind), phone: walletPhone, holder, isActive })

const transferInput = z
  .object({
    kind: z.literal("transferencia"),
    bankCode: z.enum(BANK_CODES, "Elige tu banco de la lista"),
    accountNumber: z
      .string("Escribe el número de cuenta")
      .trim()
      .regex(/^[0-9][0-9 -]{4,28}[0-9]$/, "Escribe el número de cuenta, con números y guiones"),
    cci: z
      .string()
      .trim()
      .default("")
      .transform((value) => cciDigits(value)),
    holder,
    isActive,
  })
  .superRefine((input, ctx) => {
    if (!input.cci) return
    const problem = cciProblem(input.cci)
    if (problem)
      ctx.addIssue({
        code: "custom",
        path: ["cci"],
        message:
          problem === "control"
            ? "Revisa el CCI: algún número no coincide con sus dígitos de control"
            : "El CCI tiene 20 números",
      })
    else if (cciBank(input.cci) !== input.bankCode)
      ctx.addIssue({
        code: "custom",
        path: ["cci"],
        message: `Ese CCI es de ${bankOf(cciBank(input.cci))?.short ?? "otro banco"}, no de ${bankOf(input.bankCode)?.short}`,
      })
  })

const atDeliveryInput = (kind: "efectivo" | "pos") =>
  z.object({ kind: z.literal(kind), details: note, isActive })

/** «Otro» (y el link): como antes, un nombre, su tipo, cómo se confirma y lo que envía Sofi. */
const otherInput = z
  .object({
    kind: z.enum(["otro", "link"]),
    name: z.string().trim().min(1, "Escribe cómo lo dirá Sofi").max(80, "Máximo 80 caracteres"),
    typeCode: z.enum(PAYMENT_TYPE_CODES),
    collection: z.enum(PAYMENT_COLLECTIONS),
    details: z.string().trim().max(500, "Máximo 500 caracteres").default(""),
    isActive,
  })
  .refine((m) => m.typeCode !== "10" || m.collection === "al_recibir", {
    message: "El efectivo se cobra al recibir",
    path: ["collection"],
  })
  .refine((m) => (m.kind === "link") === (m.collection === "link"), {
    message: "El link de pago se conecta en «Cobrar con link»",
    path: ["collection"],
  })

const anyInput = z.discriminatedUnion("kind", [
  walletInput("yape"),
  walletInput("plin"),
  transferInput,
  atDeliveryInput("efectivo"),
  atDeliveryInput("pos"),
  otherInput,
])

export interface PaymentValues {
  kind: PaymentKind
  name: string
  typeCode: PaymentTypeCode
  collection: PaymentCollection
  details: string
  phone: string | null
  holder: string | null
  bankCode: string | null
  accountNumber: string | null
  cci: string | null
  isActive: boolean
}

/** Lo que Sofi envía para pagar, armado con los datos de cada forma. */
export function detailsOf(values: Omit<PaymentValues, "details" | "name"> & { note: string }) {
  if ((values.kind === "yape" || values.kind === "plin") && values.phone && values.holder)
    return `${KIND_RULES[values.kind].name} al ${phoneText(values.phone)} a nombre de ${values.holder}`
  if (values.kind === "transferencia" && values.bankCode && values.accountNumber && values.holder)
    return [
      bankOf(values.bankCode)?.short ?? values.bankCode,
      `cuenta ${values.accountNumber}`,
      values.cci ? `CCI ${cciText(values.cci)}` : null,
      `a nombre de ${values.holder}`,
    ]
      .filter(Boolean)
      .join(" · ")
  return values.note
}

/**
 * Lo que manda la pantalla, en una forma de cobro completa. Sin `kind` (lo de antes y las
 * pruebas), es «otro», o el link si se confirma por link.
 */
export const paymentInput = z
  .unknown()
  .transform((raw) =>
    typeof raw === "object" && raw !== null && !("kind" in raw)
      ? {
          ...raw,
          kind: (raw as { collection?: unknown }).collection === "link" ? "link" : "otro",
        }
      : raw,
  )
  .pipe(anyInput)
  .transform((input): PaymentValues => {
    const empty = { phone: null, holder: null, bankCode: null, accountNumber: null, cci: null }
    switch (input.kind) {
      case "yape":
      case "plin": {
        const values = { ...empty, ...KIND_RULES[input.kind], ...input }
        return { ...values, details: detailsOf({ ...values, note: "" }) }
      }
      case "transferencia": {
        const bank = bankOf(input.bankCode)
        const values = {
          ...empty,
          ...KIND_RULES.transferencia,
          ...input,
          name: `Transferencia ${bank?.short ?? ""}`.trim(),
          cci: input.cci || null,
        }
        return { ...values, details: detailsOf({ ...values, note: "" }) }
      }
      case "efectivo":
      case "pos":
        return { ...empty, ...KIND_RULES[input.kind], ...input }
      default:
        return { ...empty, ...input }
    }
  })

/**
 * Un cambio es encender o apagar (solo `isActive`) o el medio entero. Se elige por lo que trae,
 * no probando uno y otro: así un dato inválido vuelve con su campo y nunca se guarda a medias.
 */
export function patchOf<T>(full: z.ZodType<T>) {
  const toggle = z.object({ isActive: z.boolean() }).strict()
  return z.unknown().transform((raw, ctx): T | { isActive: boolean } => {
    const onlyToggle =
      typeof raw === "object" && raw !== null && Object.keys(raw).join() === "isActive"
    const result = (onlyToggle ? toggle : full).safeParse(raw)
    if (result.success) return result.data
    for (const issue of result.error.issues)
      ctx.addIssue({ code: "custom", message: issue.message, path: issue.path })
    return z.NEVER
  })
}

export const paymentPatch = patchOf(paymentInput)

const uuid = z.uuid()
function methodId(id: string): string {
  if (!uuid.safeParse(id).success)
    throw new StoreError(404, "NOT_FOUND", "Ese medio de pago ya no está")
  return id
}

/** Los medios de la tienda para la pantalla: con si tienen QR (y su versión), sin la imagen. */
export async function paymentMethodsIn(tx: Db, storeId: string) {
  return tx
    .select({
      id: storePaymentMethod.id,
      name: storePaymentMethod.name,
      kind: storePaymentMethod.kind,
      typeCode: storePaymentMethod.typeCode,
      collection: storePaymentMethod.collection,
      details: storePaymentMethod.details,
      phone: storePaymentMethod.phone,
      holder: storePaymentMethod.holder,
      bankCode: storePaymentMethod.bankCode,
      accountNumber: storePaymentMethod.accountNumber,
      cci: storePaymentMethod.cci,
      isActive: storePaymentMethod.isActive,
      createdAt: storePaymentMethod.createdAt,
      updatedAt: storePaymentMethod.updatedAt,
      qrAt: storePaymentQr.updatedAt,
    })
    .from(storePaymentMethod)
    .leftJoin(storePaymentQr, eq(storePaymentQr.methodId, storePaymentMethod.id))
    .where(eq(storePaymentMethod.storeId, storeId))
    .orderBy(storePaymentMethod.createdAt)
}

export async function createPayment(
  appDb: Db,
  person: Person,
  storeId: string,
  input: PaymentValues,
) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const rows = await tx
      .select({ id: storePaymentMethod.id })
      .from(storePaymentMethod)
      .where(eq(storePaymentMethod.storeId, storeId))
    if (rows.length >= MAX_METHODS)
      throw new StoreError(
        409,
        "TOO_MANY",
        `Hasta ${MAX_METHODS} por tienda. Borra los que ya no usas.`,
      )
    const [row] = await tx
      .insert(storePaymentMethod)
      .values({ storeId, ...input })
      .returning()
    await tx.insert(storeEvent).values({
      storeId,
      actorUserId: person.userId,
      action: "configuracion.pago",
      subject: input.name,
      detail: { creado: row!.id },
    })
    return row!
  })
}

export async function updatePayment(
  appDb: Db,
  person: Person,
  storeId: string,
  id: string,
  patch: z.infer<typeof paymentPatch>,
) {
  methodId(id)
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const [row] = await tx
      .update(storePaymentMethod)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(storePaymentMethod.id, id), eq(storePaymentMethod.storeId, storeId)))
      .returning()
    if (!row) throw new StoreError(404, "NOT_FOUND", "Ese medio de pago ya no está")
    // Un QR solo es de Yape o Plin: si pasó a otra forma, se quita.
    if (row.kind !== "yape" && row.kind !== "plin")
      await tx.delete(storePaymentQr).where(eq(storePaymentQr.methodId, id))
    // Lo que se anota no lleva el celular ni la cuenta: solo qué cambió.
    const {
      phone: _p,
      accountNumber: _a,
      cci: _c,
      holder: _h,
      details: _d,
      ...said
    } = patch as Partial<PaymentValues>
    await tx.insert(storeEvent).values({
      storeId,
      actorUserId: person.userId,
      action: "configuracion.pago",
      subject: row.name,
      detail: { cambiado: id, ...said },
    })
    return row
  })
}

export async function deletePayment(appDb: Db, person: Person, storeId: string, id: string) {
  methodId(id)
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const [row] = await tx
      .delete(storePaymentMethod)
      .where(and(eq(storePaymentMethod.id, id), eq(storePaymentMethod.storeId, storeId)))
      .returning({ name: storePaymentMethod.name })
    if (!row) throw new StoreError(404, "NOT_FOUND", "Ese medio de pago ya no está")
    await tx.insert(storeEvent).values({
      storeId,
      actorUserId: person.userId,
      action: "configuracion.pago",
      subject: row.name,
      detail: { borrado: id },
    })
  })
}

/* ------------------------------------------------------------------ el QR de Yape o Plin */

async function walletIn(tx: Db, storeId: string, id: string) {
  const [method] = await tx
    .select({ name: storePaymentMethod.name, kind: storePaymentMethod.kind })
    .from(storePaymentMethod)
    .where(and(eq(storePaymentMethod.id, id), eq(storePaymentMethod.storeId, storeId)))
  if (!method) throw new StoreError(404, "NOT_FOUND", "Ese medio de pago ya no está")
  if (method.kind !== "yape" && method.kind !== "plin")
    throw new StoreError(409, "NOT_A_WALLET", "El QR va solo en Yape o Plin")
  return method
}

/** Sube (o cambia) el QR: su contenido tal cual, mirado por sus primeros bytes. */
export async function putPaymentQr(
  appDb: Db,
  person: Person,
  storeId: string,
  id: string,
  bytes: Uint8Array,
) {
  methodId(id)
  if (bytes.length === 0 || bytes.length > MAX_PHOTO_BYTES)
    throw new StoreError(400, "PHOTO_TOO_LARGE", "El QR pesa demasiado. Prueba con otra imagen.")
  const contentType = imageType(bytes)
  if (!contentType) throw new StoreError(400, "PHOTO_TYPE", "Sube el QR en JPG, PNG o WebP")
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const method = await walletIn(tx, storeId, id)
    const values = {
      contentType,
      content: Buffer.from(bytes),
      updatedBy: person.userId,
      updatedAt: sql`clock_timestamp()`,
    }
    const [row] = await tx
      .insert(storePaymentQr)
      .values({ storeId, methodId: id, ...values })
      .onConflictDoUpdate({ target: storePaymentQr.methodId, set: values })
      .returning({ updatedAt: storePaymentQr.updatedAt })
    await tx.insert(storeEvent).values({
      storeId,
      actorUserId: person.userId,
      action: "configuracion.pago",
      subject: method.name,
      detail: { qr: "cambiado", metodo: id },
    })
    return { qrAt: row!.updatedAt }
  })
}

export async function removePaymentQr(appDb: Db, person: Person, storeId: string, id: string) {
  methodId(id)
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const method = await walletIn(tx, storeId, id)
    const removed = await tx
      .delete(storePaymentQr)
      .where(and(eq(storePaymentQr.methodId, id), eq(storePaymentQr.storeId, storeId)))
      .returning({ methodId: storePaymentQr.methodId })
    if (removed.length === 0) throw new StoreError(404, "NOT_FOUND", "Ese QR ya no está")
    await tx.insert(storeEvent).values({
      storeId,
      actorUserId: person.userId,
      action: "configuracion.pago",
      subject: method.name,
      detail: { qr: "quitado", metodo: id },
    })
  })
}

/** El QR, para quien ve la tienda (también Ventas, que lo reenvía a una clienta). */
export async function paymentQrContent(appDb: Db, person: Person, storeId: string, id: string) {
  methodId(id)
  return inStore(appDb, person, storeId, "tienda.ver", async (tx) => {
    const [row] = await tx
      .select({ contentType: storePaymentQr.contentType, content: storePaymentQr.content })
      .from(storePaymentQr)
      .where(and(eq(storePaymentQr.methodId, id), eq(storePaymentQr.storeId, storeId)))
    if (!row) throw new StoreError(404, "NOT_FOUND", "Ese QR ya no está")
    return row
  })
}

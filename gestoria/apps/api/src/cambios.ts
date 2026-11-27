import {
  type Db,
  type PaymentCollection,
  saleOrder,
  saleOrderLine,
  saleOrderReturn,
  storeDeliveryMethod,
  storePaymentMethod,
} from "@gestoria/db"
import { and, asc, eq } from "drizzle-orm"
import { z } from "zod"
import type { Person } from "./cuenta.js"
import { formatMoney } from "./dinero.js"
import {
  dayText,
  lockOrder,
  logEvent,
  nextNumber,
  notifyCustomer,
  type OrderRow,
  orderDetailIn,
  pad,
  returnableIn,
  storeRow,
  todayIn,
  trySale,
  uuidOr404,
  variantPrices,
} from "./pedidos.js"
import { autoUnitCents, floorUnitCents, MAX_ORDER_CENTS } from "./precio.js"
import { inStore, StoreError } from "./tiendas.js"

/**
 * Cambiar o devolver después de entregar (entrega 8 de «gestorIA como odentIA», tablero 17,
 * decisión 7). El pedido entregado no se toca: su total y su pago siguen siendo verdad. El cambio
 * es un pedido nuevo, enlazado al entregado («Cambio del 0147»), con su entrega y su cobro:
 *
 * - Lo que vuelve (variantes y cantidades del entregado) vale lo que se pagó por ello y se
 *   descuenta del total. Entra al stock como «devolución», con su motivo, cuando llega a la tienda
 *   (al marcar «Entregado» el cambio, `pedidos.ts`).
 * - Lo que se lleva va en sus líneas, al precio de hoy. Otra talla u otro color del mismo producto
 *   cuesta lo que pagó por lo que vuelve, sin bajar de su mínimo ni pasar del precio de hoy: un
 *   cambio de talla no cobra la promoción que ya terminó. Sin stock se crea igual: solo frena al
 *   salir, como «Cambiar».
 * - El envío del cambio lo paga la clienta o la tienda; no gasta el margen de negociar.
 * - La diferencia sale del saldo único (`order_balance`): si lo nuevo cuesta más, falta cobrar y se
 *   cobra como cualquier pago; si cuesta menos o es una devolución, el total queda bajo cero y el
 *   saldo dice lo que sobra, que se devuelve y se anota con su medio.
 * - Lo arma una persona: Sofi pasa los cambios a una persona (tablero 24) y la base no la deja.
 *   El cambio no lleva la conversación del entregado, así Sofi y Argos no lo tocan ni lo siguen.
 */

/** Por qué vuelve, como lo dice la tienda (tablero 17); si es otro, se escribe. */
export const RETURN_REASONS = ["Le quedó chica", "Le quedó grande", "No le gustó", "Llegó fallado"]

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Elige una fecha")
const cents = z.number().int("Escribe un monto válido").min(0).max(100_000_000)
const units = z.number().int("Escribe un número entero").min(1, "Al menos 1").max(1000)

export const exchangeInput = z.object({
  /** Lo que vuelve: variantes del pedido entregado, con cuántas. */
  returns: z
    .array(z.object({ variantId: z.uuid("Elige lo que vuelve"), quantity: units }))
    .min(1, "Elige lo que vuelve")
    .max(30),
  /** Por qué vuelve: uno de la lista u otro escrito. */
  reason: z.string().trim().min(3, "Escribe por qué vuelve").max(120, "Máximo 120 caracteres"),
  /** Lo que se lleva (otra talla u otro producto); vacío: es una devolución. */
  takes: z
    .array(z.object({ variantId: z.uuid("Elige el producto"), quantity: units }))
    .max(30, "Hasta 30 productos")
    .default([]),
  deliveryMethodId: z.uuid("Elige cómo se entrega"),
  zone: z.string().trim().max(60).nullable().default(null),
  /** Con «se acuerda en el chat»: cuánto cuesta el envío del cambio. */
  deliveryListCents: cents.nullable().default(null),
  /** El envío del cambio lo paga la tienda (si no, la clienta). */
  storePaysDelivery: z.boolean().default(false),
  address: z.string().trim().max(300, "Máximo 300 caracteres").default(""),
  deliverOn: dateOnly.nullable().default(null),
  /** Con qué paga la diferencia, si falta cobrar; vacío: el que propone gestorIA. */
  paymentMethodId: z.uuid("Elige cómo paga").nullable().default(null),
  /** Abrió el WhatsApp de su celular con el aviso del cambio (decisión 4). */
  whatsapp: z.boolean().default(false),
})
export type ExchangeInput = z.infer<typeof exchangeInput>

/* ------------------------------------------------------------------ el precio del cambio */

export interface TakeLine {
  productId: string
  quantity: number
  listUnitCents: number
  autoUnitCents: number
  floorUnitCents: number
}

export interface BackLine {
  productId: string
  quantity: number
  /** Lo que pagó por cada una (0 si fue de regalo). */
  unitCents: number
}

/**
 * El precio de lo que se lleva: el de hoy; si es del mismo producto que lo que vuelve (otra talla u
 * otro color), lo que pagó por eso, sin bajar del mínimo ni pasar del precio de hoy.
 */
export function takePrices(takes: TakeLine[], back: BackLine[]): number[] {
  const paid = new Map<string, number>()
  for (const line of back)
    if (line.unitCents > 0 && !paid.has(line.productId)) paid.set(line.productId, line.unitCents)
  return takes.map((take) => {
    const before = paid.get(take.productId)
    if (before === undefined) return take.autoUnitCents
    return Math.min(take.autoUnitCents, Math.max(take.floorUnitCents, before))
  })
}

export interface ExchangeTotals {
  /** Lo que se lleva, a lo que se cobra. */
  subtotalCents: number
  /** Lo que se lleva, a su precio de hoy sin negociar. */
  itemsAutoCents: number
  discountCents: number
  marginCents: number
  /** Lo que vuelve, a lo que se pagó: se descuenta. */
  creditCents: number
  deliveryListCents: number
  deliveryCents: number
  /** Lo que se lleva + el envío que paga − lo que vuelve. Bajo cero: lo que la tienda devuelve. */
  totalCents: number
}

/** Las cifras del cambio, sin base: lo que se lleva, lo que vuelve y el envío que paga la clienta. */
export function exchangeTotals(
  takes: (TakeLine & { unitCents: number })[],
  back: BackLine[],
  delivery: { listCents: number; storePays: boolean },
): ExchangeTotals {
  const sum = <T extends { quantity: number }>(list: T[], of: (line: T) => number) =>
    list.reduce((total, line) => total + of(line) * line.quantity, 0)
  const subtotalCents = sum(takes, (l) => l.unitCents)
  const itemsAutoCents = sum(takes, (l) => l.autoUnitCents)
  const creditCents = sum(back, (l) => l.unitCents)
  const deliveryCents = delivery.storePays ? 0 : delivery.listCents
  return {
    subtotalCents,
    itemsAutoCents,
    discountCents: itemsAutoCents - subtotalCents,
    marginCents: sum(takes, (l) => l.autoUnitCents - l.floorUnitCents),
    creditCents,
    deliveryListCents: delivery.listCents,
    deliveryCents,
    totalCents: subtotalCents + deliveryCents - creditCents,
  }
}

/** «Sandalia beige 38», «Medias × 2». */
function itemName(line: { productName: string; variantName: string; quantity: number }) {
  return `${line.productName}${line.variantName === "Única" ? "" : ` ${line.variantName}`}${line.quantity > 1 ? ` × ${line.quantity}` : ""}`
}

const listText = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} y ${names.at(-1)}`

/**
 * El aviso del cambio a la clienta (decisión 4: se ve antes y lo envía la persona desde su
 * WhatsApp mientras no esté conectado). Solo dice lo que quedó anotado.
 */
export function exchangeNotice(input: {
  customerName: string
  number: string
  back: string[]
  takes: string[]
  deliverOn: string | null
  pickup: boolean
  dueCents: number
  refundCents: number
  payOnDelivery: boolean
  currency: string
}): string {
  const first = input.customerName.trim().split(/\s+/)[0] ?? ""
  const money = (cents: number) => formatMoney(cents, input.currency)
  const what = input.takes.length
    ? `anotamos tu cambio (pedido ${input.number}): vuelve ${listText(input.back)} y te llevas ${listText(input.takes)}.`
    : `anotamos tu devolución (pedido ${input.number}): vuelve ${listText(input.back)}.`
  const day = input.deliverOn
    ? input.pickup
      ? ` Te esperamos en la tienda el ${dayText(input.deliverOn)}.`
      : ` Pasamos el ${dayText(input.deliverOn)}.`
    : ""
  const money_ =
    input.dueCents > 0
      ? ` Falta pagar ${money(input.dueCents)}${input.payOnDelivery ? " al entregar" : ""}.`
      : input.refundCents > 0
        ? ` Te devolvemos ${money(input.refundCents)}.`
        : ""
  return `Hola${first ? ` ${first}` : ""}, ${what}${day}${money_}`
}

/** Lo que el cambio va a guardar, o lo que falta, campo por campo. */
interface PricedExchange {
  back: (BackLine & {
    variantId: string
    productName: string
    variantName: string
    sku: string
  })[]
  takes: (TakeLine & {
    variantId: string
    productName: string
    variantName: string
    sku: string
    stock: number
    unitCents: number
  })[]
  totals: ExchangeTotals
  delivery: typeof storeDeliveryMethod.$inferSelect
  zone: string | null
  payment: {
    id: string | null
    name: string
    collection: PaymentCollection
    details: string
  }
}

/** El pedido del que sale un cambio: entregado, de verdad (no de «Probar a Sofi») y sin anular. */
function mustBeDelivered(original: OrderRow) {
  if (original.test)
    throw new StoreError(409, "ORDER_STATE", "Un pedido de prueba no tiene cambios.")
  if (original.state !== "entregado")
    throw new StoreError(
      409,
      "ORDER_STATE",
      `El pedido ${pad(original.number)} todavía no se entregó: usa «Cambiar».`,
    )
}

/**
 * Arma el cambio de un pedido entregado con lo que la tienda tiene hoy: lo que vuelve (de lo que
 * se entregó y todavía no volvió), lo que se lleva, la entrega y con qué paga. Devuelve lo que va a
 * guardar o lo que falta, campo por campo.
 */
async function priceExchange(
  tx: Db,
  storeId: string,
  original: OrderRow,
  input: ExchangeInput,
  today: string,
  currency: string,
): Promise<{ ok: true; priced: PricedExchange } | { ok: false; fields: Record<string, string> }> {
  const fields: Record<string, string> = {}
  const money = (cents: number) => formatMoney(cents, currency)
  const lines = await tx
    .select()
    .from(saleOrderLine)
    .where(eq(saleOrderLine.orderId, original.id))
    .orderBy(asc(saleOrderLine.position))
  const free = new Map(
    (await returnableIn(tx, storeId, original.id, lines)).map((r) => [r.variantId, r.quantity]),
  )
  const back: PricedExchange["back"] = []
  input.returns.forEach((ret, i) => {
    const line = lines.find((l) => l.variantId === ret.variantId)
    if (!line) {
      fields[`returns.${i}.variantId`] = `Eso no va en el pedido ${pad(original.number)}`
      return
    }
    if (input.returns.findIndex((r) => r.variantId === ret.variantId) !== i) {
      fields[`returns.${i}.variantId`] = "Ya está en lo que vuelve: cambia su cantidad"
      return
    }
    const left = free.get(ret.variantId) ?? 0
    if (left === 0) fields[`returns.${i}.quantity`] = "Ya vuelve en otro cambio"
    else if (ret.quantity > left)
      fields[`returns.${i}.quantity`] =
        left === 1 ? "Vuelve 1 como máximo" : `Vuelven ${left} como máximo`
    back.push({
      variantId: line.variantId,
      productId: line.productId,
      productName: line.productName,
      variantName: line.variantName,
      sku: line.sku,
      quantity: ret.quantity,
      unitCents: line.gift ? 0 : line.unitCents,
    })
  })

  const ids = input.takes.map((t) => t.variantId)
  const rows = ids.length ? await variantPrices(tx, storeId, today, ids) : []
  const byId = new Map(rows.map((row) => [row.id, row]))
  // El precio por cantidad cuenta lo que se lleva del producto, sumando sus variantes.
  const bought = new Map<string, number>()
  for (const take of input.takes) {
    const row = byId.get(take.variantId)
    if (row) bought.set(row.productId, (bought.get(row.productId) ?? 0) + take.quantity)
  }
  const takeLines: (Omit<PricedExchange["takes"][number], "unitCents"> & { i: number })[] = []
  input.takes.forEach((take, i) => {
    const row = byId.get(take.variantId)
    if (ids.indexOf(take.variantId) !== i) {
      fields[`takes.${i}.variantId`] = "Ya está en lo que se lleva: cambia su cantidad"
      return
    }
    if (!row) {
      fields[`takes.${i}.variantId`] = "Ese producto ya no está en el catálogo"
      return
    }
    if (row.removedAt) {
      fields[`takes.${i}.variantId`] = "Esa variante ya no se vende"
      return
    }
    const auto = autoUnitCents(row.pricing, bought.get(row.productId) ?? 0)
    takeLines.push({
      i,
      variantId: row.id,
      productId: row.productId,
      productName: row.productName,
      variantName: row.variantName,
      sku: row.sku,
      stock: row.stock,
      quantity: take.quantity,
      listUnitCents: row.pricing.listUnitCents,
      autoUnitCents: auto,
      floorUnitCents: floorUnitCents(auto, row.pricing.minPriceCents),
    })
  })
  const prices = takePrices(takeLines, back)
  const takes = takeLines.map(({ i: _, ...line }, k) => ({ ...line, unitCents: prices[k]! }))

  const [delivery] = await tx
    .select()
    .from(storeDeliveryMethod)
    .where(
      and(
        eq(storeDeliveryMethod.id, input.deliveryMethodId),
        eq(storeDeliveryMethod.storeId, storeId),
      ),
    )
  let listCents = 0
  if (!delivery?.isActive) fields.deliveryMethodId = "Esa forma de entrega ya no está encendida"
  else if (delivery.cost === "fijo") listCents = delivery.priceCents ?? 0
  else if (delivery.cost === "por_zona") {
    const zone = delivery.zones.find((z) => z.name === input.zone)
    if (!zone) fields.zone = "Elige la zona"
    else listCents = zone.priceCents
  } else if (delivery.cost === "se_acuerda") {
    if (input.deliveryListCents === null)
      fields.deliveryListCents = "Escribe cuánto cuesta el envío"
    else listCents = input.deliveryListCents
  }
  const totals = exchangeTotals(takes, back, {
    listCents,
    storePays: input.storePaysDelivery,
  })
  if (totals.subtotalCents + totals.deliveryCents > MAX_ORDER_CENTS)
    fields.takes = "El cambio es demasiado grande: divídelo en dos"

  // Con qué paga la diferencia: solo si falta cobrar. Si no, queda el medio del pedido entregado.
  let payment: PricedExchange["payment"] = {
    id: original.paymentMethodId,
    name: original.paymentName,
    collection: original.paymentCollection,
    details: original.paymentDetails,
  }
  if (totals.totalCents > 0 && delivery) {
    const methods = (
      await tx
        .select()
        .from(storePaymentMethod)
        .where(eq(storePaymentMethod.storeId, storeId))
        .orderBy(asc(storePaymentMethod.createdAt))
    ).filter((m) => m.isActive)
    const usable = (m: (typeof methods)[number]) =>
      m.collection !== "al_recibir" || delivery.acceptsPayOnDelivery
    const chosen = input.paymentMethodId
      ? methods.find((m) => m.id === input.paymentMethodId)
      : // Lo que propone gestorIA: cobrar en la puerta, en el mismo viaje; si no se puede, el medio
        // del pedido entregado; si no, el primero que sirva.
        (methods.find((m) => m.collection === "al_recibir" && usable(m)) ??
        methods.find((m) => m.id === original.paymentMethodId && usable(m)) ??
        methods.find(usable))
    if (!chosen)
      fields.paymentMethodId = input.paymentMethodId
        ? "Ese medio de pago ya no está encendido"
        : `Falta cobrar ${money(totals.totalCents)}: enciende un medio de pago en Configuración`
    else if (!usable(chosen))
      fields.paymentMethodId = "Esa forma de entrega no acepta pago al recibir"
    else
      payment = {
        id: chosen.id,
        name: chosen.name,
        collection: chosen.collection,
        details: chosen.details,
      }
  }
  if (Object.keys(fields).length > 0 || !delivery) return { ok: false, fields }
  return {
    ok: true,
    priced: {
      back,
      takes,
      totals,
      delivery,
      zone: delivery.cost === "por_zona" ? input.zone : null,
      payment,
    },
  }
}

/** Lo que ve la persona antes de crear el cambio, con las mismas cifras que se guardarían. */
function summaryOf(priced: PricedExchange) {
  const { totals } = priced
  return {
    /** Lo que vuelve, a lo que se pagó. */
    backCents: totals.creditCents,
    /** Lo que se lleva, a lo que se cobra. */
    takesCents: totals.subtotalCents,
    deliveryCents: totals.deliveryCents,
    deliveryListCents: totals.deliveryListCents,
    totalCents: totals.totalCents,
    /** Lo que falta cobrar, si lo nuevo cuesta más. */
    dueCents: Math.max(totals.totalCents, 0),
    /** Lo que la tienda devuelve, si cuesta menos o es una devolución. */
    refundCents: Math.max(-totals.totalCents, 0),
    paymentName: priced.payment.name,
    payOnDelivery: priced.payment.collection === "al_recibir",
    takes: priced.takes.map((t) => ({
      variantId: t.variantId,
      unitCents: t.unitCents,
      stock: t.stock,
      short: t.stock < t.quantity,
    })),
  }
}

/** El resumen del cambio sin guardarlo: lo que vuelve, lo que se lleva, la diferencia y el envío. */
export async function previewExchange(
  appDb: Db,
  person: Person,
  storeId: string,
  orderId: string,
  input: ExchangeInput,
  now = new Date(),
) {
  uuidOr404(orderId)
  return inStore(appDb, person, storeId, "ventas.atender", async (tx) => {
    const [original] = await tx
      .select()
      .from(saleOrder)
      .where(and(eq(saleOrder.id, orderId), eq(saleOrder.storeId, storeId)))
    if (!original) throw new StoreError(404, "NOT_FOUND", "Ese pedido ya no está")
    mustBeDelivered(original)
    const { currency } = await storeRow(tx, storeId)
    const result = await priceExchange(
      tx,
      storeId,
      original,
      input,
      await todayIn(tx, storeId, now),
      currency,
    )
    return result.ok
      ? { summary: summaryOf(result.priced), fields: {} as Record<string, string> }
      : { summary: null, fields: result.fields }
  })
}

/**
 * Crea el cambio de un pedido entregado, dentro de la transacción de la tienda: un pedido nuevo con
 * lo que se lleva, lo que vuelve, su entrega y su cobro, enlazado al entregado. El entregado no
 * cambia: solo su historia dice «Cambio en el 0171». Si no queda nada que cobrar, sale ya del stock
 * lo que se lleva (como un pedido pagado); si falta cobrar, como cualquier pedido: al confirmar el
 * pago o al salir si se cobra en la puerta.
 */
export async function createExchangeIn(
  tx: Db,
  storeId: string,
  actorUserId: string,
  orderId: string,
  input: ExchangeInput,
  now = new Date(),
) {
  // El entregado, tomado: dos cambios a la vez no devuelven dos veces lo mismo.
  const original = await lockOrder(tx, storeId, orderId)
  mustBeDelivered(original)
  const { currency } = await storeRow(tx, storeId)
  const today = await todayIn(tx, storeId, now)
  if (input.deliverOn && input.deliverOn < today)
    throw new StoreError(400, "VALIDATION_ERROR", "Elige hoy o un día que viene", {
      deliverOn: "Elige hoy o un día que viene",
    })
  const result = await priceExchange(tx, storeId, original, input, today, currency)
  if (!result.ok)
    throw new StoreError(
      400,
      "VALIDATION_ERROR",
      Object.values(result.fields)[0] ?? "Revisa el cambio",
      result.fields,
    )
  const { back, takes, totals, delivery, zone, payment } = result.priced
  const number = await nextNumber(tx, storeId)
  const owes = totals.totalCents > 0
  const [order] = await tx
    .insert(saleOrder)
    .values({
      storeId,
      number,
      state: owes && payment.collection !== "al_recibir" ? "por_pagar" : "por_salir",
      channel: original.channel,
      // Sin la conversación: el cambio lo atiende una persona, no Sofi.
      conversationId: null,
      customerId: original.customerId,
      customerName: original.customerName,
      customerPhone: original.customerPhone,
      address: input.address,
      notes: "",
      deliveryMethodId: delivery.id,
      deliveryName: delivery.name,
      deliveryType: delivery.type,
      deliveryZone: zone,
      deliveryListCents: totals.deliveryListCents,
      deliveryCents: totals.deliveryCents,
      deliveryFreeByPolicy: false,
      paymentMethodId: payment.id,
      paymentName: payment.name,
      paymentCollection: payment.collection,
      paymentDetails: payment.details,
      itemsAutoCents: totals.itemsAutoCents,
      subtotalCents: totals.subtotalCents,
      discountCents: totals.discountCents,
      giftCents: 0,
      totalCents: totals.totalCents,
      marginCents: totals.marginCents,
      marginUsedCents: totals.discountCents,
      priceExpiresAt: null,
      deliverOn: input.deliverOn,
      test: false,
      createdBy: actorUserId,
      exchangeOfId: original.id,
      returnCreditCents: totals.creditCents,
    })
    .returning()
  if (takes.length > 0)
    await tx.insert(saleOrderLine).values(
      takes.map((t, position) => ({
        storeId,
        orderId: order!.id,
        position,
        productId: t.productId,
        variantId: t.variantId,
        productName: t.productName,
        variantName: t.variantName,
        sku: t.sku,
        quantity: t.quantity,
        listUnitCents: t.listUnitCents,
        autoUnitCents: t.autoUnitCents,
        floorUnitCents: t.floorUnitCents,
        unitCents: t.unitCents,
        gift: false,
      })),
    )
  await tx.insert(saleOrderReturn).values(
    back.map((b, position) => ({
      storeId,
      orderId: order!.id,
      position,
      productId: b.productId,
      variantId: b.variantId,
      productName: b.productName,
      variantName: b.variantName,
      sku: b.sku,
      quantity: b.quantity,
      unitCents: b.unitCents,
      reason: input.reason,
    })),
  )
  const backNames = back.map(itemName)
  const takeNames = takes.map(itemName)
  const n = pad(number)
  await logEvent(tx, storeId, order!.id, actorUserId, "creado", {
    canal: original.channel,
    cambioDe: pad(original.number),
    vuelve: backNames,
    motivo: input.reason,
    ...(takeNames.length ? { sale: takeNames } : {}),
  })
  await logEvent(tx, storeId, original.id, actorUserId, "cambio", {
    pedido: n,
    vuelve: backNames,
    motivo: input.reason,
    ...(takeNames.length ? { sale: takeNames } : {}),
  })
  // Sin nada que cobrar, lo que se lleva sale ya del stock: es como un pedido pagado.
  const stockPending = !owes && takes.length > 0 ? !(await trySale(tx, order!, actorUserId)) : false
  const notice = exchangeNotice({
    customerName: original.customerName,
    number: n,
    back: backNames,
    takes: takeNames,
    deliverOn: input.deliverOn,
    pickup: delivery.type === "OnSitePickup",
    dueCents: Math.max(totals.totalCents, 0),
    refundCents: Math.max(-totals.totalCents, 0),
    payOnDelivery: payment.collection === "al_recibir",
    currency,
  })
  await notifyCustomer(tx, order!, actorUserId, currency, "cambio", {
    text: notice,
    opened: input.whatsapp,
  })
  return { id: order!.id, number: n, notice, stockPending }
}

/** «Crear el cambio»: el pedido nuevo, con el aviso para abrirlo en WhatsApp si se eligió. */
export async function createExchange(
  appDb: Db,
  person: Person,
  storeId: string,
  orderId: string,
  input: ExchangeInput,
) {
  uuidOr404(orderId)
  return inStore(appDb, person, storeId, "ventas.atender", async (tx) => {
    const created = await createExchangeIn(tx, storeId, person.userId, orderId, input)
    return { order: await orderDetailIn(tx, storeId, created.id), notice: created.notice }
  })
}

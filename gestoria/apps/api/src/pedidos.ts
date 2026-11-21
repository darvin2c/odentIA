import {
  accountCopy,
  type Db,
  MAX_PHOTO_BYTES,
  ORDER_CHANNELS,
  type OrderEventAction,
  type OrderState,
  orderEvent,
  orderPayment,
  product,
  productPhoto,
  productPromotion,
  productQuantityPrice,
  productVariant,
  saleOrder,
  saleOrderLine,
  stockMovement,
  store,
  storeDeliveryMethod,
  storeEvent,
  storePaymentLink,
  storePaymentMethod,
} from "@gestoria/db"
import { and, asc, count, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm"
import { z } from "zod"
import { agentName, SOFI_ACTOR } from "./agente.js"
import { imageType } from "./catalogo.js"
import type { Person } from "./cuenta.js"
import { formatMoney } from "./dinero.js"
import type { LinkAdapters } from "./link-de-pago.js"
import { can } from "./permisos.js"
import {
  autoUnitCents,
  floorUnitCents,
  NEGOTIATED_PRICE_MS,
  type PricedVariant,
  type Quote,
  type QuoteLine,
  quote,
} from "./precio.js"
import { openSecret, sealSecret } from "./secretos.js"
import { cancelSale, recordSale } from "./stock.js"
import { inStore, StoreError } from "./tiendas.js"

/**
 * Los pedidos de una tienda (paso B4 del lienzo B, tableros 2, 5 y 14): armarlos, cobrarlos y
 * entregarlos. Es la única operación de negocio: la usa el equipo desde «Pedidos» y la usará
 * Sofi desde la conversación (B2 y B5), con los mismos precios, límites y estados.
 *
 * - El precio sigue `precio.ts`: nunca bajo el mínimo y todo lo cedido queda escrito.
 * - El stock baja con el kardex al confirmar el pago, o al salir si se paga al recibir
 *   (decisión 3), y vuelve al anular. Si al pagar no alcanza, el pago se confirma igual (el
 *   dinero ya llegó) y el stock se descuenta al salir: sin stock, no sale.
 * - El cobro va en orden: link de pago (se confirma solo), captura (la confirma una persona) y
 *   al recibir. Una captura es lo único que espera a alguien.
 * - Los avisos al cliente quedan escritos en la historia del pedido; hoy no salen, porque
 *   WhatsApp llega con B2.
 */

export const pad = (number: number) => String(number).padStart(4, "0")
/** La referencia del pedido en el kardex: «Pedido 0142». */
const stockReference = (number: number) => `Pedido ${pad(number)}`

const OPEN: OrderState[] = ["por_pagar", "por_confirmar", "por_salir", "en_camino"]
const TO_DELIVER: OrderState[] = ["por_salir", "en_camino"]

/** Los filtros de la lista (tablero 5). */
export const ORDER_FILTERS = {
  abiertos: OPEN,
  por_confirmar: ["por_confirmar"],
  por_pagar: ["por_pagar"],
  para_entregar: TO_DELIVER,
  hoy: TO_DELIVER,
  entregados: ["entregado"],
  anulados: ["anulado"],
} satisfies Record<string, OrderState[]>
export type OrderFilter = keyof typeof ORDER_FILTERS

/** El remitente de lo que hace el proveedor del link en el kardex (no es una persona). */
export const LINK_ACTOR = "link-de-pago"

/** Lo que dice el aviso que no se envió. */
const NOT_SENT = "Sin enviar: WhatsApp todavía no está conectado"

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Elige una fecha")
const cents = z.number().int("Escribe un monto válido").min(0).max(100_000_000)

export const orderInput = z.object({
  customerName: z
    .string()
    .trim()
    .min(1, "Escribe el nombre del cliente")
    .max(120, "Máximo 120 caracteres"),
  customerPhone: z
    .string()
    .trim()
    .max(30, "Máximo 30 caracteres")
    .regex(/^[+\d\s()-]*$/, "Escribe solo el número")
    .default("")
    .transform((value) => value || null),
  channel: z.enum(ORDER_CHANNELS).default("otro"),
  address: z.string().trim().max(300, "Máximo 300 caracteres").default(""),
  notes: z.string().trim().max(500, "Máximo 500 caracteres").default(""),
  lines: z
    .array(
      z.object({
        variantId: z.uuid("Elige el producto"),
        quantity: z.number().int("Escribe un número entero").min(1, "Al menos 1").max(1000),
        /** El precio acordado por unidad; null: el de la tienda. */
        unitCents: cents.nullable().default(null),
        gift: z.boolean().default(false),
      }),
    )
    .min(1, "Agrega al menos un producto")
    .max(30, "Hasta 30 productos por pedido"),
  deliveryMethodId: z.uuid("Elige cómo se entrega"),
  zone: z.string().trim().max(60).nullable().default(null),
  /** Con «se acuerda en el chat»: cuánto cuesta el envío. */
  deliveryListCents: cents.nullable().default(null),
  /** Lo que paga de envío; null: lo que corresponde. */
  deliveryCents: cents.nullable().default(null),
  paymentMethodId: z.uuid("Elige cómo paga"),
  deliverOn: dateOnly.nullable().default(null),
})
export type OrderInput = z.infer<typeof orderInput>

/** El resumen antes de guardar: el nombre del cliente todavía puede faltar. */
export const quoteInput = orderInput.extend({
  customerName: z.string().trim().max(120).default(""),
})

export const receiptInput = z.object({
  amountCents: cents.min(1, "Escribe el monto que se ve en la captura"),
  operation: z
    .string()
    .trim()
    .max(60, "Máximo 60 caracteres")
    .default("")
    .transform((value) => value || null),
})

const reason = z.string().trim().min(3, "Escribe el motivo").max(300, "Máximo 300 caracteres")

export const reviewInput = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("confirmar") }),
  z.object({ decision: z.literal("no_coincide"), reason }),
])

export const shipInput = z.object({
  tracking: z
    .string()
    .trim()
    .max(80, "Máximo 80 caracteres")
    .default("")
    .transform((value) => value || null),
})

export const deliverInput = z.object({
  /** Con pago al recibir: lo que cobró en la puerta. */
  collectedCents: cents.nullable().default(null),
})

export const cancelInput = z.object({ reason })

/** Hoy, en UTC (como las promociones de B3; la zona horaria de la tienda llega con B5). */
export function todayUTC(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

function uuidOr404(id: string) {
  if (!z.uuid().safeParse(id).success)
    throw new StoreError(404, "NOT_FOUND", "Ese pedido ya no está")
}

async function storeRow(tx: Db, storeId: string) {
  const [row] = await tx
    .select({ name: store.name, currency: store.currency })
    .from(store)
    .where(eq(store.id, storeId))
  if (!row) throw new StoreError(404, "NOT_FOUND", "No encontramos esa tienda en tu cuenta")
  return row
}

/* ---------------------------------------------------------------- el precio de un pedido */

interface Priced {
  quote: Quote
  variants: Map<
    string,
    { productId: string; productName: string; variantName: string; sku: string }
  >
  delivery: typeof storeDeliveryMethod.$inferSelect
  payment: typeof storePaymentMethod.$inferSelect
}

/**
 * Las variantes con lo que hace falta para su precio de hoy: lista, mínimo, la promoción vigente
 * y el precio por cantidad. Lo usan el pedido y la lista para venderlo: el mismo precio en los dos.
 * Con `ids`, solo esas (también las quitadas, para decir que ya no se venden); sin ellos, las que
 * se venden.
 */
export async function variantPrices(tx: Db, storeId: string, today: string, ids?: string[]) {
  const rows = await tx
    .select({
      id: productVariant.id,
      optionValues: productVariant.optionValues,
      sku: productVariant.sku,
      priceCents: productVariant.priceCents,
      stock: productVariant.stock,
      removedAt: productVariant.removedAt,
      productId: product.id,
      productName: product.name,
      listPriceCents: product.listPriceCents,
      minPriceCents: product.minPriceCents,
    })
    .from(productVariant)
    .innerJoin(product, eq(product.id, productVariant.productId))
    .where(
      and(
        eq(productVariant.storeId, storeId),
        ids ? inArray(productVariant.id, ids) : isNull(productVariant.removedAt),
      ),
    )
    .orderBy(asc(product.name), asc(productVariant.optionValues))
  const productIds = [...new Set(rows.map((row) => row.productId))]
  if (productIds.length === 0) return []
  const promotions = await tx
    .select({
      productId: productPromotion.productId,
      name: productPromotion.name,
      percentOff: productPromotion.percentOff,
    })
    .from(productPromotion)
    .where(
      and(
        inArray(productPromotion.productId, productIds),
        lte(productPromotion.startsOn, today),
        gte(productPromotion.endsOn, today),
      ),
    )
  const tiers = await tx
    .select({
      productId: productQuantityPrice.productId,
      minQuantity: productQuantityPrice.minQuantity,
      unitPriceCents: productQuantityPrice.unitPriceCents,
    })
    .from(productQuantityPrice)
    .where(inArray(productQuantityPrice.productId, productIds))
  const promoBy = new Map(promotions.map((p) => [p.productId, p]))
  const tiersBy = Map.groupBy(tiers, (t) => t.productId)
  return rows.map((row) => ({
    ...row,
    variantName: row.optionValues.join(" · ") || "Única",
    promotion: promoBy.get(row.productId)?.name ?? null,
    pricing: {
      listUnitCents: row.priceCents ?? row.listPriceCents,
      minPriceCents: row.minPriceCents,
      percentOff: promoBy.get(row.productId)?.percentOff ?? null,
      quantityPrices: tiersBy.get(row.productId) ?? [],
    } satisfies PricedVariant,
  }))
}

/**
 * Arma el precio de un pedido con lo que la tienda tiene hoy: variantes que se venden y con
 * stock, la forma de entrega y el medio de pago encendidos. Devuelve el precio o lo que falta,
 * campo por campo.
 */
async function priceOrder(
  tx: Db,
  storeId: string,
  currency: string,
  input: OrderInput,
  today: string,
): Promise<{ ok: true; priced: Priced } | { ok: false; fields: Record<string, string> }> {
  const fields: Record<string, string> = {}
  const ids = input.lines.map((line) => line.variantId)
  input.lines.forEach((line, i) => {
    if (ids.indexOf(line.variantId) !== i)
      fields[`lines.${i}.variantId`] = "Ya está en el pedido: cambia su cantidad"
  })
  const rows = await variantPrices(tx, storeId, today, ids)
  const byId = new Map(rows.map((row) => [row.id, row]))
  // El precio por cantidad cuenta lo que se compra del producto, sumando sus variantes.
  const bought = new Map<string, number>()
  for (const line of input.lines) {
    const row = byId.get(line.variantId)
    if (row && !line.gift)
      bought.set(row.productId, (bought.get(row.productId) ?? 0) + line.quantity)
  }
  const lines: QuoteLine[] = []
  input.lines.forEach((line, i) => {
    const row = byId.get(line.variantId)
    if (!row) {
      fields[`lines.${i}.variantId`] = "Ese producto ya no está en el catálogo"
      return
    }
    if (row.removedAt) fields[`lines.${i}.variantId`] = "Esa variante ya no se vende"
    else if (row.stock < line.quantity)
      fields[`lines.${i}.quantity`] =
        row.stock === 0 ? "Está agotado" : `Quedan ${row.stock}: registra una entrada si hay más`
    const auto = autoUnitCents(row.pricing, bought.get(row.productId) ?? 0)
    lines.push({
      quantity: line.quantity,
      listUnitCents: row.pricing.listUnitCents,
      autoUnitCents: auto,
      floorUnitCents: floorUnitCents(auto, row.pricing.minPriceCents),
      unitCents: line.unitCents,
      gift: line.gift,
    })
  })

  const [delivery] = await tx
    .select()
    .from(storeDeliveryMethod)
    .where(
      and(
        eq(storeDeliveryMethod.id, input.deliveryMethodId),
        eq(storeDeliveryMethod.storeId, storeId),
      ),
    )
  let deliveryList = 0
  if (!delivery?.isActive) fields.deliveryMethodId = "Esa forma de entrega ya no está encendida"
  else if (delivery.cost === "fijo") deliveryList = delivery.priceCents ?? 0
  else if (delivery.cost === "por_zona") {
    const zone = delivery.zones.find((z) => z.name === input.zone)
    if (!zone) fields.zone = "Elige la zona"
    else deliveryList = zone.priceCents
  } else if (delivery.cost === "se_acuerda") {
    if (input.deliveryListCents === null)
      fields.deliveryListCents = "Escribe cuánto cuesta el envío"
    else deliveryList = input.deliveryListCents
  }

  const [payment] = await tx
    .select()
    .from(storePaymentMethod)
    .where(
      and(
        eq(storePaymentMethod.id, input.paymentMethodId),
        eq(storePaymentMethod.storeId, storeId),
      ),
    )
  if (!payment?.isActive) fields.paymentMethodId = "Ese medio de pago ya no está encendido"
  else if (payment.collection === "al_recibir" && delivery && !delivery.acceptsPayOnDelivery)
    fields.paymentMethodId = "Esa forma de entrega no acepta pago al recibir"

  if (Object.keys(fields).length > 0 || !delivery || !payment) return { ok: false, fields }
  const result = quote(
    lines,
    {
      listCents: deliveryList,
      maxDiscountCents: delivery.cost === "se_acuerda" ? null : delivery.maxDiscountCents,
      freeFromCents: delivery.freeFromCents,
      chargedCents: input.deliveryCents,
    },
    currency,
  )
  if (!result.ok) return result
  return {
    ok: true,
    priced: {
      quote: result.quote,
      variants: new Map(
        rows.map((row) => [
          row.id,
          {
            productId: row.productId,
            productName: row.productName,
            variantName: row.variantName,
            sku: row.sku,
          },
        ]),
      ),
      delivery,
      payment,
    },
  }
}

/**
 * El precio de un pedido sin guardarlo, dentro de la transacción de la tienda: el resumen de
 * «Anotar un pedido» y lo que cotiza Sofi (la misma regla).
 */
export async function quoteOrderIn(tx: Db, storeId: string, input: OrderInput, today: string) {
  const { currency } = await storeRow(tx, storeId)
  const result = await priceOrder(tx, storeId, currency, input, today)
  return result.ok
    ? { quote: result.priced.quote, fields: {} as Record<string, string>, currency }
    : { quote: null, fields: result.fields, currency }
}

/** El precio de un pedido sin guardarlo, para el resumen de «Anotar un pedido». */
export async function quoteOrder(
  appDb: Db,
  person: Person,
  storeId: string,
  input: OrderInput,
  today = todayUTC(),
) {
  return inStore(appDb, person, storeId, "ventas.atender", async (tx) => {
    const { quote: q, fields } = await quoteOrderIn(tx, storeId, input, today)
    return { quote: q, fields }
  })
}

/* ------------------------------------------------------------- la historia y los avisos */

async function logEvent(
  tx: Db,
  storeId: string,
  orderId: string,
  actorUserId: string | null,
  action: OrderEventAction,
  detail: Record<string, unknown> = {},
) {
  await tx.insert(orderEvent).values({ storeId, orderId, actorUserId, action, detail })
}

type Notice =
  | "resumen"
  | "link"
  | "pago_confirmado"
  | "pago_no_coincide"
  | "en_camino"
  | "entregado"
  | "anulado"

/**
 * Un aviso al cliente. Queda en la historia del pedido con lo que diría; hoy no sale (B2 lo
 * enviará por la conversación del pedido, con la plantilla de Meta si pasaron 24 horas).
 */
async function notifyCustomer(
  tx: Db,
  order: { id: string; storeId: string; number: number; totalCents: number },
  actorUserId: string | null,
  currency: string,
  kind: Notice,
  extra: { url?: string; tracking?: string | null } = {},
) {
  const n = pad(order.number)
  const total = formatMoney(order.totalCents, currency)
  const text: Record<Notice, string> = {
    resumen: `Tu pedido ${n} quedó anotado. Total: ${total}.`,
    link: `Puedes pagar tu pedido ${n} (${total}) aquí: ${extra.url ?? ""}`,
    pago_confirmado: `Recibimos tu pago del pedido ${n}. ¡Gracias! Te avisamos cuando salga.`,
    pago_no_coincide: `No pudimos confirmar el pago de tu pedido ${n}. ¿Puedes revisarlo y enviarnos la captura otra vez?`,
    en_camino: `Tu pedido ${n} va en camino.${extra.tracking ? ` Número de envío: ${extra.tracking}.` : ""}`,
    entregado: `Tu pedido ${n} fue entregado. ¡Gracias por tu compra!`,
    anulado: `Tu pedido ${n} fue anulado. Si es un error, escríbenos.`,
  }
  await logEvent(tx, order.storeId, order.id, actorUserId, "aviso", {
    tipo: kind,
    texto: text[kind],
    enviado: false,
    motivo: NOT_SENT,
  })
}

/* ---------------------------------------------------------------------- armar un pedido */

/**
 * Arma un pedido dentro de la transacción de la tienda. Es la operación que llamará la
 * conversación (B2 y Sofi en B5) con su `conversationId`; el equipo la usa con «Anotar un
 * pedido». Con pago al recibir, empieza en «por salir»: se cobra en la puerta.
 */
export async function createOrderIn(
  tx: Db,
  storeId: string,
  actorUserId: string,
  input: OrderInput,
  options: { conversationId?: string | null; now?: Date; today?: string; test?: boolean } = {},
) {
  const now = options.now ?? new Date()
  const { currency } = await storeRow(tx, storeId)
  const result = await priceOrder(tx, storeId, currency, input, options.today ?? todayUTC(now))
  if (!result.ok)
    throw new StoreError(
      400,
      "VALIDATION_ERROR",
      Object.values(result.fields)[0] ?? "Revisa el pedido",
      result.fields,
    )
  const { quote: q, variants, delivery, payment } = result.priced
  // El número sigue al último de la tienda; dos pedidos a la vez esperan su turno.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`pedido:${storeId}`}))`)
  const [last] = await tx
    .select({ number: sql<number>`coalesce(max(${saleOrder.number}), 0)` })
    .from(saleOrder)
    .where(eq(saleOrder.storeId, storeId))
  const number = Number(last?.number ?? 0) + 1
  const [order] = await tx
    .insert(saleOrder)
    .values({
      storeId,
      number,
      state: payment.collection === "al_recibir" ? "por_salir" : "por_pagar",
      channel: input.channel,
      conversationId: options.conversationId ?? null,
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      address: input.address,
      notes: input.notes,
      deliveryMethodId: delivery.id,
      deliveryName: delivery.name,
      deliveryType: delivery.type,
      deliveryZone: delivery.cost === "por_zona" ? input.zone : null,
      deliveryListCents: q.deliveryListCents,
      deliveryCents: q.deliveryCents,
      deliveryFreeByPolicy: q.deliveryFreeByPolicy,
      paymentMethodId: payment.id,
      paymentName: payment.name,
      paymentCollection: payment.collection,
      paymentDetails: payment.details,
      itemsAutoCents: q.itemsAutoCents,
      subtotalCents: q.subtotalCents,
      discountCents: q.discountCents,
      giftCents: q.giftCents,
      totalCents: q.totalCents,
      marginCents: q.marginCents,
      marginUsedCents: q.marginUsedCents,
      priceExpiresAt: q.negotiated ? new Date(now.getTime() + NEGOTIATED_PRICE_MS) : null,
      deliverOn: input.deliverOn,
      test: options.test ?? false,
      createdBy: actorUserId,
    })
    .returning()
  await tx.insert(saleOrderLine).values(
    input.lines.map((line, i) => {
      const v = variants.get(line.variantId)!
      const priced = q.lines[i]!
      return {
        storeId,
        orderId: order!.id,
        position: i,
        productId: v.productId,
        variantId: line.variantId,
        productName: v.productName,
        variantName: v.variantName,
        sku: v.sku,
        quantity: line.quantity,
        listUnitCents: priced.listUnitCents,
        autoUnitCents: priced.autoUnitCents,
        floorUnitCents: priced.floorUnitCents,
        unitCents: priced.unitCents,
        gift: priced.gift,
      }
    }),
  )
  await logEvent(tx, storeId, order!.id, actorUserId, "creado", {
    canal: input.channel,
    ...(q.negotiated
      ? {
          cedido: {
            descuento: q.discountCents,
            envio: q.deliveryFreeByPolicy ? 0 : q.deliveryListCents - q.deliveryCents,
            regalo: q.giftCents,
          },
        }
      : {}),
  })
  await notifyCustomer(tx, order!, actorUserId, currency, "resumen")
  return {
    id: order!.id,
    number: pad(number),
    state: order!.state,
    paymentCollection: order!.paymentCollection,
    totalCents: q.totalCents,
    priceExpiresAt: order!.priceExpiresAt,
  }
}

export async function createOrder(
  appDb: Db,
  person: Person,
  storeId: string,
  input: OrderInput,
  today = todayUTC(),
) {
  return inStore(appDb, person, storeId, "ventas.atender", async (tx) => {
    const created = await createOrderIn(tx, storeId, person.userId, input, { today })
    return orderDetailIn(tx, storeId, created.id)
  })
}

/* ------------------------------------------------------------------ la lista y el detalle */

export async function listOrders(
  appDb: Db,
  person: Person,
  storeId: string,
  filter: OrderFilter,
  today = todayUTC(),
) {
  return inStore(appDb, person, storeId, "ventas.atender", async (tx) => {
    const dueToday = and(inArray(saleOrder.state, TO_DELIVER), lte(saleOrder.deliverOn, today))
    const where = and(
      eq(saleOrder.storeId, storeId),
      inArray(saleOrder.state, ORDER_FILTERS[filter]),
      filter === "hoy" ? dueToday : undefined,
    )
    const rows = await tx
      .select({
        id: saleOrder.id,
        number: saleOrder.number,
        state: saleOrder.state,
        channel: saleOrder.channel,
        customerName: saleOrder.customerName,
        totalCents: saleOrder.totalCents,
        paymentName: saleOrder.paymentName,
        paymentCollection: saleOrder.paymentCollection,
        deliveryName: saleOrder.deliveryName,
        deliveryZone: saleOrder.deliveryZone,
        deliverOn: saleOrder.deliverOn,
        priceExpiresAt: saleOrder.priceExpiresAt,
        createdAt: saleOrder.createdAt,
        test: saleOrder.test,
        bySofi: sql<boolean>`${saleOrder.createdBy} = ${SOFI_ACTOR}`,
      })
      .from(saleOrder)
      .where(where)
      .orderBy(
        ...(filter === "hoy" || filter === "para_entregar"
          ? [asc(saleOrder.deliverOn), asc(saleOrder.number)]
          : [desc(saleOrder.createdAt)]),
      )
      .limit(200)
    const ids = rows.map((row) => row.id)
    const lines = ids.length
      ? await tx
          .select({
            orderId: saleOrderLine.orderId,
            productName: saleOrderLine.productName,
            variantName: saleOrderLine.variantName,
            quantity: saleOrderLine.quantity,
            gift: saleOrderLine.gift,
          })
          .from(saleOrderLine)
          .where(inArray(saleOrderLine.orderId, ids))
          .orderBy(asc(saleOrderLine.position))
      : []
    // Quién confirmó el pago: «Yape · confirmado por Rosa».
    const confirmed = ids.length
      ? await tx
          .select({
            orderId: orderPayment.orderId,
            name: accountCopy.name,
            kind: orderPayment.kind,
          })
          .from(orderPayment)
          .leftJoin(accountCopy, eq(accountCopy.userId, orderPayment.reviewedBy))
          .where(and(inArray(orderPayment.orderId, ids), eq(orderPayment.status, "confirmado")))
      : []
    const counts = await tx
      .select({ state: saleOrder.state, n: count() })
      .from(saleOrder)
      .where(eq(saleOrder.storeId, storeId))
      .groupBy(saleOrder.state)
    const [today_] = await tx
      .select({ n: count() })
      .from(saleOrder)
      .where(and(eq(saleOrder.storeId, storeId), dueToday))
    const byState = Object.fromEntries(counts.map((c) => [c.state, c.n])) as Partial<
      Record<OrderState, number>
    >
    const total = (states: OrderState[]) => states.reduce((n, s) => n + (byState[s] ?? 0), 0)
    const linesBy = Map.groupBy(lines, (line) => line.orderId)
    const confirmedBy = new Map(confirmed.map((c) => [c.orderId, c]))
    return {
      orders: rows.map((row) => {
        const own = linesBy.get(row.id) ?? []
        const paid = confirmedBy.get(row.id)
        return {
          ...row,
          number: pad(row.number),
          lines: own.map(({ orderId: _, ...line }) => line),
          confirmedBy: paid ? (paid.kind === "link" ? "el link" : paid.name) : null,
        }
      }),
      counts: {
        abiertos: total(OPEN),
        por_confirmar: total(["por_confirmar"]),
        por_pagar: total(["por_pagar"]),
        para_entregar: total(TO_DELIVER),
        hoy: today_?.n ?? 0,
        entregados: total(["entregado"]),
        anulados: total(["anulado"]),
      } satisfies Record<OrderFilter, number>,
    }
  })
}

async function orderDetailIn(tx: Db, storeId: string, orderId: string) {
  const [order] = await tx
    .select()
    .from(saleOrder)
    .where(and(eq(saleOrder.id, orderId), eq(saleOrder.storeId, storeId)))
  if (!order) throw new StoreError(404, "NOT_FOUND", "Ese pedido ya no está")
  const lines = await tx
    .select({
      id: saleOrderLine.id,
      productId: saleOrderLine.productId,
      variantId: saleOrderLine.variantId,
      productName: saleOrderLine.productName,
      variantName: saleOrderLine.variantName,
      sku: saleOrderLine.sku,
      quantity: saleOrderLine.quantity,
      listUnitCents: saleOrderLine.listUnitCents,
      autoUnitCents: saleOrderLine.autoUnitCents,
      floorUnitCents: saleOrderLine.floorUnitCents,
      unitCents: saleOrderLine.unitCents,
      gift: saleOrderLine.gift,
    })
    .from(saleOrderLine)
    .where(eq(saleOrderLine.orderId, orderId))
    .orderBy(asc(saleOrderLine.position))
  const payments = await tx
    .select({
      id: orderPayment.id,
      kind: orderPayment.kind,
      status: orderPayment.status,
      amountCents: orderPayment.amountCents,
      operation: orderPayment.operation,
      hasPhoto: sql<boolean>`${orderPayment.photo} is not null`,
      note: orderPayment.note,
      createdAt: orderPayment.createdAt,
      createdBy: orderPayment.createdBy,
      reviewedAt: orderPayment.reviewedAt,
      reviewedBy: orderPayment.reviewedBy,
    })
    .from(orderPayment)
    .where(eq(orderPayment.orderId, orderId))
    .orderBy(asc(orderPayment.createdAt))
  const events = await tx
    .select({
      id: orderEvent.id,
      action: orderEvent.action,
      detail: orderEvent.detail,
      createdAt: orderEvent.createdAt,
      actorName: accountCopy.name,
      actorUserId: orderEvent.actorUserId,
    })
    .from(orderEvent)
    .leftJoin(accountCopy, eq(accountCopy.userId, orderEvent.actorUserId))
    .where(eq(orderEvent.orderId, orderId))
    .orderBy(asc(orderEvent.seq))
  const people = [...new Set(payments.flatMap((p) => [p.createdBy, p.reviewedBy]))].filter(
    (id): id is string => Boolean(id),
  )
  const names = new Map(
    people.length
      ? (
          await tx
            .select({ userId: accountCopy.userId, name: accountCopy.name })
            .from(accountCopy)
            .where(inArray(accountCopy.userId, people))
        ).map((row) => [row.userId, row.name])
      : [],
  )
  // Pagado y por salir sin venta en el kardex: no alcanzaba el stock al pagar.
  const stockPending =
    order.state === "por_salir" &&
    order.paymentCollection !== "al_recibir" &&
    (
      await tx
        .select({ id: stockMovement.id })
        .from(stockMovement)
        .where(
          and(
            eq(stockMovement.storeId, storeId),
            eq(stockMovement.reference, stockReference(order.number)),
            eq(stockMovement.kind, "venta"),
          ),
        )
        .limit(1)
    ).length === 0
  // La primera foto de cada producto.
  const photos = await tx
    .selectDistinctOn([productPhoto.productId], {
      productId: productPhoto.productId,
      id: productPhoto.id,
    })
    .from(productPhoto)
    .where(
      and(
        eq(productPhoto.storeId, storeId),
        inArray(
          productPhoto.productId,
          lines.map((l) => l.productId),
        ),
      ),
    )
    .orderBy(productPhoto.productId, asc(productPhoto.position))
  const photoBy = new Map(photos.map((p) => [p.productId, p.id]))
  const {
    storeId: _s,
    linkRef: _r,
    paymentMethodId: _p,
    deliveryMethodId: _d,
    conversationId: _c,
    ...rest
  } = order
  // El link solo se ofrece a un pedido por pagar.
  const linkConnected =
    order.state === "por_pagar" &&
    (
      await tx
        .select({ provider: storePaymentLink.provider })
        .from(storePaymentLink)
        .where(eq(storePaymentLink.storeId, storeId))
    ).length > 0
  const now = Date.now()
  return {
    ...rest,
    number: pad(order.number),
    /** Lo armó Sofi en la conversación. */
    bySofi: order.createdBy === SOFI_ACTOR,
    /** La tienda conectó su link de pago: se puede ofrecer «Link de pago». */
    linkConnected,
    linkUrl: order.linkExpiresAt && order.linkExpiresAt.getTime() <= now ? null : order.linkUrl,
    priceExpired: Boolean(order.priceExpiresAt && order.priceExpiresAt.getTime() <= now),
    /** Ya entró dinero: un pago confirmado, o uno por el link que espera a una persona. */
    paid: payments.some(
      (p) => p.status === "confirmado" || (p.kind === "link" && p.status === "por_confirmar"),
    ),
    /** Pagado, pero el stock no alcanzaba: se descuenta al salir. */
    stockPending,
    lines: lines.map((line) => ({
      ...line,
      photoId: photoBy.get(line.productId) ?? null,
    })),
    payments: payments.map(({ createdBy, reviewedBy, ...p }) => ({
      ...p,
      createdByName: createdBy ? (names.get(createdBy) ?? agentName(createdBy)) : null,
      reviewedByName: reviewedBy ? (names.get(reviewedBy) ?? null) : null,
      byLink: p.kind === "link" && createdBy === null,
    })),
    events: events.map(({ actorUserId, ...event }) => ({
      ...event,
      actorName: event.actorName ?? agentName(actorUserId),
      byLink: actorUserId === null,
    })),
  }
}

export async function orderDetail(appDb: Db, person: Person, storeId: string, orderId: string) {
  uuidOr404(orderId)
  return inStore(appDb, person, storeId, "ventas.atender", (tx) =>
    orderDetailIn(tx, storeId, orderId),
  )
}

/** Lo que se puede vender hoy, con su precio sin negociar y su mínimo, para armar un pedido. */
export async function sellable(appDb: Db, person: Person, storeId: string, today = todayUTC()) {
  return inStore(appDb, person, storeId, "ventas.atender", async (tx) => {
    const rows = await variantPrices(tx, storeId, today)
    return {
      // El precio de una unidad; el precio por cantidad lo aplica el resumen del pedido.
      variants: rows.map((row) => {
        const auto = autoUnitCents(row.pricing, 1)
        return {
          id: row.id,
          productName: row.productName,
          variantName: row.variantName,
          sku: row.sku,
          stock: row.stock,
          listUnitCents: row.pricing.listUnitCents,
          autoUnitCents: auto,
          floorUnitCents: floorUnitCents(auto, row.pricing.minPriceCents),
          promotion: row.promotion,
        }
      }),
    }
  })
}

/* --------------------------------------------------------------- cobrar y entregar */

async function lockOrder(tx: Db, storeId: string, orderId: string) {
  uuidOr404(orderId)
  const [order] = await tx
    .select()
    .from(saleOrder)
    .where(and(eq(saleOrder.id, orderId), eq(saleOrder.storeId, storeId)))
    .for("update")
  if (!order) throw new StoreError(404, "NOT_FOUND", "Ese pedido ya no está")
  return order
}

type OrderRow = typeof saleOrder.$inferSelect

function stateError(order: OrderRow): StoreError {
  const now: Record<OrderState, string> = {
    por_pagar: "está por pagar",
    por_confirmar: "tiene un pago por confirmar",
    por_salir: "ya está pagado y por salir",
    en_camino: "ya va en camino",
    entregado: "ya fue entregado",
    anulado: "está anulado",
  }
  return new StoreError(
    409,
    "ORDER_STATE",
    `El pedido ${pad(order.number)} ${now[order.state]}. Recarga para verlo.`,
  )
}

async function setState(tx: Db, order: OrderRow, state: OrderState, extra: Partial<OrderRow> = {}) {
  await tx
    .update(saleOrder)
    .set({ state, updatedAt: new Date(), ...extra })
    .where(eq(saleOrder.id, order.id))
}

async function saleLines(tx: Db, orderId: string) {
  return tx
    .select({ variantId: saleOrderLine.variantId, quantity: saleOrderLine.quantity })
    .from(saleOrderLine)
    .where(eq(saleOrderLine.orderId, orderId))
}

/**
 * Descuenta el stock del pedido en el kardex. Al confirmar un pago, si no alcanza, no frena: el
 * dinero ya llegó; queda «falta stock» y se descuenta al salir. Devuelve si se descontó.
 */
async function trySale(tx: Db, order: OrderRow, actor: string): Promise<boolean> {
  // Un pedido de prueba (de «Probar a Sofi») no mueve el stock.
  if (order.test) return true
  const lines = await saleLines(tx, order.id)
  try {
    await tx.transaction((sp) =>
      recordSale(sp as unknown as Db, order.storeId, actor, stockReference(order.number), lines),
    )
    return true
  } catch (error) {
    if (
      error instanceof StoreError &&
      (error.code === "NOT_ENOUGH_STOCK" || error.code === "VARIANT_REMOVED")
    )
      return false
    throw error
  }
}

/** Al salir (o entregar sin salir), el stock tiene que alcanzar: lo que no hay no sale. */
async function mustSale(tx: Db, order: OrderRow, actor: string) {
  if (order.test) return
  const lines = await saleLines(tx, order.id)
  try {
    await recordSale(tx, order.storeId, actor, stockReference(order.number), lines)
  } catch (error) {
    if (error instanceof StoreError && error.code === "NOT_ENOUGH_STOCK")
      throw new StoreError(
        409,
        "NOT_ENOUGH_STOCK",
        "No alcanza el stock para este pedido. Registra la entrada en el catálogo y vuelve a intentarlo.",
      )
    if (error instanceof StoreError && error.code === "VARIANT_REMOVED")
      throw new StoreError(
        409,
        "VARIANT_REMOVED",
        "Una de sus variantes ya no se vende. Anula el pedido y anótalo con otra.",
      )
    throw error
  }
}

/**
 * Si el pedido ya recibió dinero: un pago confirmado, o uno que llegó por el link y espera a una
 * persona (el dinero ya está en la cuenta aunque el monto no coincida).
 */
async function moneyReceived(tx: Db, orderId: string, except?: string): Promise<boolean> {
  const rows = await tx
    .select({ id: orderPayment.id, kind: orderPayment.kind, status: orderPayment.status })
    .from(orderPayment)
    .where(eq(orderPayment.orderId, orderId))
  return rows.some(
    (p) =>
      p.id !== except &&
      (p.status === "confirmado" || (p.kind === "link" && p.status === "por_confirmar")),
  )
}

/** Anota la captura de un pago: el pedido queda «pago por confirmar» hasta que una persona lo mire. */
export async function addReceipt(
  appDb: Db,
  person: Person,
  storeId: string,
  orderId: string,
  input: z.infer<typeof receiptInput>,
  photo: Uint8Array | null,
) {
  let photoType = null
  if (photo) {
    if (photo.length > MAX_PHOTO_BYTES)
      throw new StoreError(400, "PHOTO_TOO_LARGE", "La captura pesa demasiado. Prueba con otra.")
    photoType = imageType(photo)
    if (!photoType) throw new StoreError(400, "PHOTO_TYPE", "Sube la captura en JPG, PNG o WebP")
  }
  return inStore(appDb, person, storeId, "ventas.atender", async (tx) => {
    await addReceiptIn(tx, storeId, person.userId, orderId, input, photo, photoType)
    return orderDetailIn(tx, storeId, orderId)
  })
}

/**
 * Anota una captura dentro de la transacción de la tienda: la usan el equipo y Sofi. Queda
 * «pago por confirmar»; confirmarla es de una persona (`reviewPayment`).
 */
export async function addReceiptIn(
  tx: Db,
  storeId: string,
  actorUserId: string,
  orderId: string,
  input: z.infer<typeof receiptInput>,
  photo: Uint8Array | null = null,
  photoType: (typeof orderPayment.$inferInsert)["photoType"] = null,
) {
  const order = await lockOrder(tx, storeId, orderId)
  if (order.state !== "por_pagar") throw stateError(order)
  const { currency } = await storeRow(tx, storeId)
  await tx.insert(orderPayment).values({
    storeId,
    orderId,
    kind: "comprobante",
    status: "por_confirmar",
    amountCents: input.amountCents,
    operation: input.operation,
    photoType,
    photo: photo ? Buffer.from(photo) : null,
    createdBy: actorUserId,
  })
  await setState(tx, order, "por_confirmar")
  await logEvent(tx, storeId, orderId, actorUserId, "comprobante", {
    monto: input.amountCents,
    operacion: input.operation,
    moneda: currency,
  })
}

/** «Confirmar pago» o «No coincide» (con motivo escrito): solo una persona con permiso. */
export async function reviewPayment(
  appDb: Db,
  person: Person,
  storeId: string,
  orderId: string,
  paymentId: string,
  input: z.infer<typeof reviewInput>,
) {
  if (!z.uuid().safeParse(paymentId).success)
    throw new StoreError(404, "NOT_FOUND", "Ese pago ya no está")
  return inStore(appDb, person, storeId, "pagos.confirmar", async (tx) => {
    const order = await lockOrder(tx, storeId, orderId)
    const [payment] = await tx
      .select()
      .from(orderPayment)
      .where(and(eq(orderPayment.id, paymentId), eq(orderPayment.orderId, orderId)))
    if (!payment) throw new StoreError(404, "NOT_FOUND", "Ese pago ya no está")
    if (payment.status !== "por_confirmar")
      throw new StoreError(409, "PAYMENT_REVIEWED", "Ese pago ya se revisó. Recarga para verlo.")
    const { currency } = await storeRow(tx, storeId)
    const now = new Date()
    if (input.decision === "confirmar") {
      // Un pago más sobre un pedido que ya tenía dinero, o anulado: se confirma (el dinero llegó)
      // y queda escrito que hay que ver si se devuelve.
      const extra =
        order.state === "anulado"
          ? "Pago sobre un pedido anulado: revisa si hay que devolverlo"
          : (await moneyReceived(tx, orderId, paymentId))
            ? "Pago doble: el pedido ya tenía otro pago. Revisa si hay que devolver uno"
            : null
      await tx
        .update(orderPayment)
        .set({
          status: "confirmado",
          reviewedBy: person.userId,
          reviewedAt: now,
          ...(extra ? { note: payment.note ? `${payment.note}. ${extra}` : extra } : {}),
        })
        .where(eq(orderPayment.id, paymentId))
      let stockPending = false
      if (order.state === "por_confirmar") {
        stockPending = !(await trySale(tx, order, person.userId))
        await setState(tx, order, "por_salir")
      }
      await logEvent(tx, storeId, orderId, person.userId, "pago_confirmado", {
        monto: payment.amountCents,
        ...(stockPending ? { faltaStock: true } : {}),
        ...(order.state !== "por_confirmar" ? { estado: order.state } : {}),
        ...(extra ? { porRevisar: extra } : {}),
      })
      if (order.state === "por_confirmar")
        await notifyCustomer(tx, order, person.userId, currency, "pago_confirmado")
    } else {
      await tx
        .update(orderPayment)
        .set({
          status: "no_coincide",
          note: input.reason,
          reviewedBy: person.userId,
          reviewedAt: now,
        })
        .where(eq(orderPayment.id, paymentId))
      const [pending] = await tx
        .select({ n: count() })
        .from(orderPayment)
        .where(and(eq(orderPayment.orderId, orderId), eq(orderPayment.status, "por_confirmar")))
      if (order.state === "por_confirmar" && (pending?.n ?? 0) === 0)
        await setState(tx, order, "por_pagar")
      await logEvent(tx, storeId, orderId, person.userId, "pago_no_coincide", {
        monto: payment.amountCents,
        motivo: input.reason,
      })
      if (order.state === "por_confirmar")
        await notifyCustomer(tx, order, person.userId, currency, "pago_no_coincide")
    }
    return orderDetailIn(tx, storeId, orderId)
  })
}

/** «Salió»: el pedido va en camino. Si se paga al recibir, aquí baja el stock (decisión 3). */
export async function markShipped(
  appDb: Db,
  person: Person,
  storeId: string,
  orderId: string,
  input: z.infer<typeof shipInput>,
) {
  return inStore(appDb, person, storeId, "entregas", async (tx) => {
    const order = await lockOrder(tx, storeId, orderId)
    if (order.state !== "por_salir") throw stateError(order)
    await mustSale(tx, order, person.userId)
    await setState(tx, order, "en_camino", { tracking: input.tracking })
    const { currency } = await storeRow(tx, storeId)
    await logEvent(tx, storeId, orderId, person.userId, "salio", { envio: input.tracking })
    await notifyCustomer(tx, order, person.userId, currency, "en_camino", {
      tracking: input.tracking,
    })
    return orderDetailIn(tx, storeId, orderId)
  })
}

/**
 * «Entregado» (o «Entregado y cobrado» si se paga al recibir: queda quién cobró y cuánto). Un
 * recojo en tienda pasa de «por salir» a entregado sin «Salió».
 */
export async function markDelivered(
  appDb: Db,
  person: Person,
  storeId: string,
  orderId: string,
  input: z.infer<typeof deliverInput>,
) {
  return inStore(appDb, person, storeId, "entregas", async (tx) => {
    const order = await lockOrder(tx, storeId, orderId)
    if (order.state !== "por_salir" && order.state !== "en_camino") throw stateError(order)
    const paid = await moneyReceived(tx, orderId)
    const { currency } = await storeRow(tx, storeId)
    // Lo cobrado en la puerta se anota tal cual; si no es el total, queda escrito para revisarlo.
    const short =
      !paid && input.collectedCents !== null && input.collectedCents !== order.totalCents
        ? `Cobró ${formatMoney(input.collectedCents, currency)} de ${formatMoney(order.totalCents, currency)}`
        : null
    if (!paid) {
      if (input.collectedCents === null || input.collectedCents === 0)
        throw new StoreError(400, "VALIDATION_ERROR", "Escribe cuánto cobraste", {
          collectedCents: "Escribe cuánto cobraste al entregar",
        })
      const now = new Date()
      await tx.insert(orderPayment).values({
        storeId,
        orderId,
        kind: "al_recibir",
        status: "confirmado",
        amountCents: input.collectedCents,
        note: short,
        createdBy: person.userId,
        reviewedBy: person.userId,
        reviewedAt: now,
      })
    }
    await mustSale(tx, order, person.userId)
    await setState(tx, order, "entregado")
    await logEvent(tx, storeId, orderId, person.userId, "entregado", {
      ...(paid ? {} : { cobrado: input.collectedCents, moneda: currency }),
      ...(short ? { porRevisar: short } : {}),
    })
    await notifyCustomer(tx, order, person.userId, currency, "entregado")
    return orderDetailIn(tx, storeId, orderId)
  })
}

/**
 * Anular, con motivo escrito: el stock que salió vuelve con su movimiento. Un pedido pagado lo
 * anula quien puede confirmar pagos; uno entregado ya no se anula (los cambios y devoluciones
 * los ve una persona, fuera de B4).
 */
export async function cancelOrder(
  appDb: Db,
  person: Person,
  storeId: string,
  orderId: string,
  input: z.infer<typeof cancelInput>,
) {
  return inStore(appDb, person, storeId, "ventas.atender", async (tx, role) => {
    await cancelOrderIn(tx, storeId, person.userId, orderId, input.reason, {
      mayCancelPaid: can(role, "pagos.confirmar"),
    })
    return orderDetailIn(tx, storeId, orderId)
  })
}

/**
 * Anula dentro de la transacción de la tienda. Sofi lo usa solo para volver a anotar un pedido
 * suyo que nadie pagó (cambió la forma de pago): nunca uno pagado (tablero 8).
 */
export async function cancelOrderIn(
  tx: Db,
  storeId: string,
  actorUserId: string,
  orderId: string,
  reason: string,
  options: { mayCancelPaid: boolean; notify?: boolean },
) {
  const order = await lockOrder(tx, storeId, orderId)
  if (order.state === "entregado" || order.state === "anulado") throw stateError(order)
  const paid = await moneyReceived(tx, orderId)
  if (paid && !options.mayCancelPaid)
    throw new StoreError(403, "FORBIDDEN", "Un pedido pagado lo anula quien confirma pagos")
  const returned = await cancelSale(tx, storeId, actorUserId, stockReference(order.number))
  await setState(tx, order, "anulado", { cancelReason: reason })
  const { currency } = await storeRow(tx, storeId)
  await logEvent(tx, storeId, orderId, actorUserId, "anulado", {
    motivo: reason,
    ...(paid ? { pagado: true } : {}),
    ...(returned > 0 ? { stockDevuelto: returned } : {}),
  })
  if (options.notify ?? true) await notifyCustomer(tx, order, actorUserId, currency, "anulado")
}

/** La captura de un pago, con la sesión (no es pública). */
export async function receiptPhoto(
  appDb: Db,
  person: Person,
  storeId: string,
  orderId: string,
  paymentId: string,
) {
  uuidOr404(orderId)
  if (!z.uuid().safeParse(paymentId).success)
    throw new StoreError(404, "NOT_FOUND", "Esa captura ya no está")
  return inStore(appDb, person, storeId, "ventas.atender", async (tx) => {
    const [row] = await tx
      .select({ contentType: orderPayment.photoType, content: orderPayment.photo })
      .from(orderPayment)
      .where(
        and(
          eq(orderPayment.id, paymentId),
          eq(orderPayment.orderId, orderId),
          eq(orderPayment.storeId, storeId),
        ),
      )
    if (!row?.content || !row.contentType)
      throw new StoreError(404, "NOT_FOUND", "Esa captura ya no está")
    return { contentType: row.contentType, content: row.content }
  })
}

/* ------------------------------------------------------------------- el link de pago */

export interface LinkDeps {
  adapters: LinkAdapters
  /** La llave de las credenciales; null: el link de pago no está disponible. */
  secretsKey: Buffer | null
  /** La dirección pública de este servidor, adonde avisa el proveedor. */
  apiURL: string
}

export function linkNotificationURL(deps: LinkDeps, storeId: string): string {
  return new URL(`/avisos/link-de-pago/${storeId}`, deps.apiURL).toString()
}

/**
 * El link de pago de un pedido por pagar. Si ya tiene uno vigente, es ese. La llamada al
 * proveedor va fuera de la transacción: no se tiene el pedido tomado mientras responde. Si el
 * pedido cambió entre medio (se pagó o se anuló), el link nuevo no se guarda ni se muestra.
 */
export async function createPaymentLink(
  appDb: Db,
  person: Person,
  storeId: string,
  orderId: string,
  deps: LinkDeps,
) {
  return createPaymentLinkWith(
    (fn) => inStore(appDb, person, storeId, "ventas.atender", (tx) => fn(tx)),
    person.userId,
    storeId,
    orderId,
    deps,
  )
}

/** Corre algo dentro de la transacción de la tienda: la de una persona (`inStore`) o la de Sofi. */
export type StoreRun = <T>(fn: (tx: Db) => Promise<T>) => Promise<T>

/**
 * El link de pago con quien lo pide: el equipo o Sofi. Un pedido de prueba no crea un link real
 * (nadie va a pagarlo y el proveedor lo cobraría como intento).
 */
export async function createPaymentLinkWith(
  run: StoreRun,
  actorUserId: string,
  storeId: string,
  orderId: string,
  deps: LinkDeps,
) {
  uuidOr404(orderId)
  const prepared = await run(async (tx) => {
    const [order] = await tx
      .select()
      .from(saleOrder)
      .where(and(eq(saleOrder.id, orderId), eq(saleOrder.storeId, storeId)))
    if (!order) throw new StoreError(404, "NOT_FOUND", "Ese pedido ya no está")
    if (order.state !== "por_pagar") throw stateError(order)
    if (order.test)
      throw new StoreError(
        409,
        "TEST_ORDER",
        "En una prueba no se crea un link de pago real: en una conversación de verdad, aquí iría el link.",
      )
    const now = Date.now()
    if (order.linkUrl && (!order.linkExpiresAt || order.linkExpiresAt.getTime() > now))
      return { url: order.linkUrl }
    if (order.priceExpiresAt && order.priceExpiresAt.getTime() <= now)
      throw new StoreError(
        409,
        "PRICE_EXPIRED",
        "El precio acordado venció (vale 24 horas). Si sigue en pie, anula el pedido y anótalo de nuevo.",
      )
    const [connection] = await tx
      .select()
      .from(storePaymentLink)
      .where(eq(storePaymentLink.storeId, storeId))
    if (!connection || !deps.secretsKey)
      throw new StoreError(
        409,
        "LINK_NOT_CONNECTED",
        "La tienda todavía no conectó su link de pago. Se conecta en Pagos y entregas.",
      )
    const { name, currency } = await storeRow(tx, storeId)
    return {
      order,
      connection,
      name,
      currency,
      token: openSecret(deps.secretsKey, storeId, connection.accessTokenEnc),
    }
  })
  if ("url" in prepared) return { url: prepared.url }
  const { order, connection, name, currency, token } = prepared
  const link = await deps.adapters[connection.provider].create(token, {
    id: order.id,
    number: pad(order.number),
    storeName: name,
    totalCents: order.totalCents,
    currency,
    expiresAt: order.priceExpiresAt,
    notificationURL: linkNotificationURL(deps, storeId),
  })
  return run(async (tx) => {
    const current = await lockOrder(tx, storeId, orderId)
    if (current.state !== "por_pagar") throw stateError(current)
    // Otro lo creó entre medio (el mismo, porque el proveedor no repite, u otro): vale el que ya está.
    if (current.linkUrl && (!current.linkExpiresAt || current.linkExpiresAt.getTime() > Date.now()))
      return { url: current.linkUrl }
    await tx
      .update(saleOrder)
      .set({
        linkUrl: link.url,
        linkRef: link.ref,
        linkExpiresAt: order.priceExpiresAt,
        updatedAt: new Date(),
      })
      .where(eq(saleOrder.id, orderId))
    await logEvent(tx, storeId, orderId, actorUserId, "link", { proveedor: connection.provider })
    await notifyCustomer(tx, current, actorUserId, currency, "link", { url: link.url })
    return { url: link.url }
  })
}

/**
 * Un aviso del proveedor del link (sin persona: lo atiende el dueño de la base). El pago se lee
 * del proveedor con las credenciales de la tienda; el aviso solo dice cuál mirar. Si está
 * aprobado, es de un pedido de esta tienda, por el total y en su moneda, el pedido pasa a
 * pagado solo. Si algo no coincide, queda «pago por confirmar» para que lo vea una persona.
 * Un mismo pago no se anota dos veces: repetir el aviso no cambia nada.
 */
export async function receiveLinkNotice(
  ownerDb: Db,
  storeId: string,
  request: { query: URLSearchParams; headers: Headers; body: string },
  deps: LinkDeps,
): Promise<{ status: 200 | 401; message: string }> {
  // Lo que no se atiende responde igual que lo atendido: el aviso no le cuenta a nadie qué
  // tiendas, pagos o pedidos existen.
  const done = { status: 200 as const, message: "Recibido" }
  if (!z.uuid().safeParse(storeId).success) return done
  const [connection] = await ownerDb
    .select()
    .from(storePaymentLink)
    .where(eq(storePaymentLink.storeId, storeId))
  if (!connection || !deps.secretsKey) return done
  const adapter = deps.adapters[connection.provider]
  const secret = connection.webhookSecretEnc
    ? openSecret(deps.secretsKey, storeId, connection.webhookSecretEnc)
    : null
  const notice = adapter.read(request, secret)
  if (notice.kind === "firma_invalida") return { status: 401, message: "Firma inválida" }
  if (notice.kind === "ignorar") return done
  // Si el proveedor no responde, el error sube y el aviso vuelve a llegar (leer es seguro). Un
  // pago que su cuenta no conoce (de otra cuenta, o inventado) no se puede leer: no se anota.
  const payment = await adapter.payment(
    openSecret(deps.secretsKey, storeId, connection.accessTokenEnc),
    notice.ref,
  )
  if (!payment?.approved || !payment.orderId || !z.uuid().safeParse(payment.orderId).success)
    return done
  const orderId = payment.orderId
  return ownerDb.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(saleOrder)
      .where(and(eq(saleOrder.id, orderId), eq(saleOrder.storeId, storeId)))
      .for("update")
    if (!order) return done
    const [already] = await tx
      .select({ id: orderPayment.id })
      .from(orderPayment)
      .where(
        and(
          eq(orderPayment.storeId, storeId),
          eq(orderPayment.provider, connection.provider),
          eq(orderPayment.providerRef, payment.ref),
        ),
      )
    if (already) return done
    const { currency } = await storeRow(tx as unknown as Db, storeId)
    const waiting = order.state === "por_pagar" || order.state === "por_confirmar"
    const matches = payment.currency === currency && payment.amountCents === order.totalCents
    const note = !waiting
      ? `Llegó por el link cuando el pedido ${order.state === "anulado" ? "ya estaba anulado" : "ya estaba pagado"}: revisa si hay que devolverlo`
      : !matches
        ? `El monto pagado por el link (${formatMoney(payment.amountCents, /^[A-Z]{3}$/.test(payment.currency) ? payment.currency : currency)}) no coincide con el total`
        : null
    const now = new Date()
    const db = tx as unknown as Db
    if (waiting && matches) {
      await tx.insert(orderPayment).values({
        storeId,
        orderId,
        kind: "link",
        status: "confirmado",
        amountCents: payment.amountCents,
        provider: connection.provider,
        providerRef: payment.ref,
        reviewedAt: now,
      })
      const stockOk = await trySale(db, order, LINK_ACTOR)
      await setState(db, order, "por_salir")
      await logEvent(db, storeId, orderId, null, "pago_link", {
        monto: payment.amountCents,
        proveedor: connection.provider,
        ...(stockOk ? {} : { faltaStock: true }),
      })
      await notifyCustomer(db, order, null, currency, "pago_confirmado")
      return done
    }
    // No coincide: lo mira una persona. El dinero ya llegó, así que nunca se descarta.
    await tx.insert(orderPayment).values({
      storeId,
      orderId,
      kind: "link",
      status: "por_confirmar",
      amountCents: payment.amountCents,
      provider: connection.provider,
      providerRef: payment.ref,
      note,
    })
    if (order.state === "por_pagar") await setState(db, order, "por_confirmar")
    await logEvent(db, storeId, orderId, null, "pago_link", {
      monto: payment.amountCents,
      proveedor: connection.provider,
      porRevisar: note,
    })
    return done
  })
}

/* ----------------------------------------------- conectar el link de pago (configuración) */

export const linkConnectionInput = z.object({
  provider: z.literal("mercadopago"),
  accessToken: z
    .string()
    .trim()
    .min(20, "Pega el «Access token» completo")
    .max(300, "Ese token es demasiado largo")
    .regex(/^[A-Za-z0-9_-]+$/, "Pega solo el token, sin espacios"),
  /** Vacía: se queda la que había (al cambiar la cuenta no se pierde la firma sin querer). */
  webhookSecret: z
    .string()
    .trim()
    .max(200, "Esa clave es demasiado larga")
    .regex(/^[A-Za-z0-9_-]*$/, "Pega solo la clave, sin espacios")
    .default("")
    .transform((value) => value || null),
})

/**
 * Al cambiar o quitar la cuenta del link, los links ya creados de los pedidos por pagar dejan de
 * valer: eran de la otra cuenta, y sus pagos no se podrían leer. Se vuelve a crear uno.
 */
async function forgetOpenLinks(tx: Db, storeId: string) {
  await tx
    .update(saleOrder)
    .set({ linkUrl: null, linkRef: null, linkExpiresAt: null, updatedAt: new Date() })
    .where(and(eq(saleOrder.storeId, storeId), eq(saleOrder.state, "por_pagar")))
}

export async function paymentLinkStatus(
  appDb: Db,
  person: Person,
  storeId: string,
  deps: LinkDeps,
) {
  return inStore(appDb, person, storeId, "tienda.ver", async (tx) => {
    const [row] = await tx
      .select({
        provider: storePaymentLink.provider,
        hint: storePaymentLink.hint,
        signed: sql<boolean>`${storePaymentLink.webhookSecretEnc} is not null`,
        connectedAt: storePaymentLink.connectedAt,
        connectedByName: accountCopy.name,
      })
      .from(storePaymentLink)
      .leftJoin(accountCopy, eq(accountCopy.userId, storePaymentLink.connectedBy))
      .where(eq(storePaymentLink.storeId, storeId))
    return { available: Boolean(deps.secretsKey), connection: row ?? null }
  })
}

/** Conecta (o cambia) el link de pago: primero se comprueba el token con el proveedor. */
export async function connectPaymentLink(
  appDb: Db,
  person: Person,
  storeId: string,
  input: z.infer<typeof linkConnectionInput>,
  deps: LinkDeps,
) {
  const key = deps.secretsKey
  if (!key)
    throw new StoreError(
      409,
      "LINK_UNAVAILABLE",
      "El link de pago todavía no está disponible en gestorIA.",
    )
  // Antes de la llamada, el permiso: quien no puede configurar no prueba tokens con nuestro servidor.
  await inStore(appDb, person, storeId, "configuracion", async () => {})
  await deps.adapters[input.provider].verify(input.accessToken)
  await inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const [before] = await tx
      .select()
      .from(storePaymentLink)
      .where(eq(storePaymentLink.storeId, storeId))
    const sameAccount =
      before && openSecret(key, storeId, before.accessTokenEnc) === input.accessToken
    const values = {
      provider: input.provider,
      accessTokenEnc: sealSecret(key, storeId, input.accessToken),
      webhookSecretEnc: input.webhookSecret
        ? sealSecret(key, storeId, input.webhookSecret)
        : (before?.webhookSecretEnc ?? null),
      hint: input.accessToken.slice(-4),
      connectedBy: person.userId,
      connectedAt: new Date(),
    }
    await tx
      .insert(storePaymentLink)
      .values({ storeId, ...values })
      .onConflictDoUpdate({ target: storePaymentLink.storeId, set: values })
    if (!sameAccount) await forgetOpenLinks(tx, storeId)
    await tx.insert(storeEvent).values({
      storeId,
      actorUserId: person.userId,
      action: "configuracion.pago",
      subject: "Link de pago",
      detail: { conectado: input.provider, firma: Boolean(values.webhookSecretEnc) },
    })
  })
  return paymentLinkStatus(appDb, person, storeId, deps)
}

export async function disconnectPaymentLink(appDb: Db, person: Person, storeId: string) {
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const [row] = await tx
      .delete(storePaymentLink)
      .where(eq(storePaymentLink.storeId, storeId))
      .returning({ provider: storePaymentLink.provider })
    if (!row) throw new StoreError(404, "NOT_FOUND", "El link de pago ya estaba desconectado")
    await forgetOpenLinks(tx, storeId)
    await tx.insert(storeEvent).values({
      storeId,
      actorUserId: person.userId,
      action: "configuracion.pago",
      subject: "Link de pago",
      detail: { desconectado: row.provider },
    })
  })
}

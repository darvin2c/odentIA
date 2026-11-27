import {
  accountCopy,
  type Db,
  MAX_PHOTO_BYTES,
  ORDER_CHANNELS,
  ORDER_STATES,
  type OrderEventAction,
  type OrderState,
  orderEvent,
  orderPayment,
  type PaymentCollection,
  type PaymentTypeCode,
  type PhotoType,
  product,
  productPhoto,
  productPromotion,
  productQuantityPrice,
  productVariant,
  saleOrder,
  saleOrderLine,
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
import { customerForOrderIn, shownCustomerId } from "./clientes.js"
import type { Person } from "./cuenta.js"
import { formatMoney } from "./dinero.js"
import { storeClockIn } from "./hora.js"
import type { LinkAdapters } from "./link-de-pago.js"
import { can } from "./permisos.js"
import {
  autoUnitCents,
  floorUnitCents,
  negotiatedUntil,
  type PricedVariant,
  type Quote,
  type QuoteLine,
  quote,
} from "./precio.js"
import {
  checkSlotIn,
  courierChoice,
  courierFor,
  courierNamesIn,
  sameSlot,
  slotInput,
  slotLabel,
} from "./repartidores.js"
import { balanceIn, balancesIn, overIfConfirmed, unpaidBalance } from "./saldo.js"
import { openSecret, sealSecret } from "./secretos.js"
import { cancelSale, heldBy, recordSale } from "./stock.js"
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
 * - Un pedido acepta varios pagos, cada uno con su medio y su estado (ADR 0222). Lo que falta
 *   cobrar sale de un solo lugar (`saldo.ts`); el primer pago confirmado lo deja listo para salir
 *   y queda «Pagado» solo cuando no falta nada y todo está confirmado.
 * - «Hoy» es el de la tienda, con su hora (`hora.ts`): nunca el del servidor ni el del navegador.
 * - Los avisos al cliente quedan escritos en la historia del pedido; hoy no salen, porque
 *   WhatsApp llega con B2.
 * - Un pedido se corrige sin anularlo (ADR 0226): «Cambiar» (productos, entrega y total, con su
 *   pago y su número), «No se entregó» y «Pasar a…». Cada cambio mueve en el kardex solo la
 *   diferencia, con su propia referencia, y lo que sobra o falta queda en el saldo.
 */

export const pad = (number: number) => String(number).padStart(4, "0")
/** La referencia del pedido en el kardex: «Pedido 0142» (y cada cambio, «Pedido 0142 · cambio 1»). */
const stockReference = (number: number) => `Pedido ${pad(number)}`

/**
 * Si un pedido (`o`, el alias de `sale_order` en la consulta) no tiene fuera del stock lo que dicen
 * sus líneas: lo vendido menos lo que volvió, en todas sus referencias (`stock.ts`), no da sus
 * cantidades. Lo usan el pedido y Argos para decir «falta stock».
 */
export function stockShortSql(o: string) {
  const a = sql.raw(o)
  return sql`exists (
    select 1 from (
      select l.variant_id, sum(l.quantity)::int as q from sale_order_line l
        where l.order_id = ${a}.id group by l.variant_id
      union all
      select m.variant_id, sum(m.quantity)::int from stock_movement m
        where m.store_id = ${a}.store_id and m.kind in ('venta', 'anulacion')
          and (m.reference = 'Pedido ' || lpad(${a}.number::text, 4, '0')
            or m.reference like 'Pedido ' || lpad(${a}.number::text, 4, '0') || ' · %')
        group by m.variant_id
    ) d group by d.variant_id having sum(d.q) <> 0)`
}

/**
 * Si un pedido (`o`, el alias de `sale_order`) volvió sin entregar y todavía no sale otra vez: está
 * «Por salir» y lo último entre «Salió» y «No se entregó» de su historia es «No se entregó». Lo
 * usan Inicio y su cifra «Sale hoy»; la pantalla del pedido lo lee igual de su historia.
 */
export function missedSql(o: string) {
  const a = sql.raw(o)
  // Sin «Salió» ni «No se entregó» la subconsulta da null: `coalesce` deja siempre sí o no, para
  // que `not missedSql(…)` cuente los que nunca salieron.
  return sql`(${a}.state = 'por_salir' and coalesce((
    select e.action from order_event e
    where e.order_id = ${a}.id and e.action in ('salio', 'no_entregado')
    order by e.seq desc limit 1), '') = 'no_entregado')`
}

/**
 * Los pedidos con su pago confirmado (todo o una parte) que no pueden salir: no alcanzaba el stock
 * al pagar, o al cambiarlo (lo que tienen fuera no es lo de sus líneas). Los de prueba no cuentan.
 */
export async function paidWithoutStockIn(tx: Db, storeId: string) {
  const rows = await tx.execute<{ id: string; number: number; customer_name: string }>(sql`
    select o.id, o.number, o.customer_name from sale_order o
    where o.store_id = ${storeId} and o.state = 'por_salir' and o.test = false
      and o.payment_collection <> 'al_recibir'
      and ${stockShortSql("o")}
    order by o.number`)
  return [...rows].map((o) => ({ orderId: o.id, number: pad(o.number), customer: o.customer_name }))
}

const OPEN: OrderState[] = ["por_pagar", "por_confirmar", "por_salir", "en_camino"]
/** Lo que sale: «Para entregar hoy» es lo de estos estados con su día hasta hoy. */
export const TO_DELIVER: OrderState[] = ["por_salir", "en_camino"]
/** Lo que se cambia o se pasa a otro día: lo que todavía no salió. */
const NOT_SHIPPED: OrderState[] = ["por_pagar", "por_confirmar", "por_salir"]

/**
 * Los filtros de la lista (tablero 5). «Pago por confirmar» es todo pedido con un pago que espera
 * a una persona, también el segundo pago de uno que ya sale (el pago en partes).
 */
export const ORDER_FILTERS = {
  abiertos: OPEN,
  por_confirmar: [...ORDER_STATES],
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
/** Lo que dice el aviso que la persona envió desde su celular («Avisar», decisión 4). */
const SENT_BY_YOU = "Enviado por usted desde su WhatsApp: gestorIA no sabe si llegó"

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Elige una fecha")
const cents = z.number().int("Escribe un monto válido").min(0).max(100_000_000)

export const orderInput = z.object({
  /**
   * La ficha de la clienta, elegida en «Anotar un pedido» o en «Repetir pedido» (entrega 4). Sin
   * ella, el pedido abre su ficha con el nombre y el teléfono de abajo (`customerForOrderIn`).
   */
  customerId: z.uuid("Elige la clienta").nullable().default(null),
  /** Con una ficha elegida puede ir vacío: el pedido copia el de la ficha. */
  customerName: z.string().trim().max(120, "Máximo 120 caracteres").default(""),
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

/** El resumen antes de guardar: el nombre de la clienta todavía puede faltar. */
export const quoteInput = orderInput

/** El medio de pago de la tienda con que pagó; vacío: el del pedido, si se cobra así. */
const methodId = z
  .union([z.uuid("Elige el medio de pago"), z.literal("")])
  .nullish()
  .transform((value) => value || null)

export const receiptInput = z.object({
  amountCents: cents.min(1, "Escribe el monto que se ve en la captura"),
  operation: z
    .string()
    .trim()
    .max(60, "Máximo 60 caracteres")
    .default("")
    .transform((value) => value || null),
  methodId,
})

const reason = z.string().trim().min(3, "Escribe el motivo").max(300, "Máximo 300 caracteres")

export const reviewInput = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("confirmar") }),
  z.object({ decision: z.literal("no_coincide"), reason }),
])

const tracking = z
  .string()
  .trim()
  .max(80, "Máximo 80 caracteres")
  .default("")
  .transform((value) => value || null)

/** Con qué agencia va (tablero 17): una de las de siempre u otra escrita. Vacío: ninguna. */
const agency = z
  .string()
  .trim()
  .max(60, "Máximo 60 caracteres")
  .default("")
  .transform((value) => value.replace(/\s+/g, " ") || null)

/** «Salió»: por agencia, con cuál y su número de envío, que también se puede anotar después. */
export const shipInput = z.object({ tracking, agency })

/** El envío por agencia de un pedido que sale o ya salió: la agencia y su número de envío. */
export const shippingInput = z.object({ tracking, agency })

export const deliverInput = z.object({
  /** Si falta cobrar: lo que cobró en la puerta, con un solo medio. */
  collectedCents: cents.nullable().default(null),
  /** Con qué le pagaron en la puerta (un medio de la tienda que se cobra al recibir). */
  methodId,
  /** Si pagó una parte con cada medio («Agregar otro medio»): cada uno con su monto. */
  payments: z
    .array(
      z.object({
        methodId: z.uuid("Elige el medio de pago"),
        amountCents: cents.min(1, "Escribe cuánto cobraste"),
      }),
    )
    .max(3, "Hasta 3 medios")
    .default([]),
})

export const cancelInput = z.object({ reason })

/**
 * «Cambiar» un pedido: sus productos (talla, color, cantidad, otro producto), su forma de entrega,
 * su dirección y su día. El cliente, el canal y el medio de pago siguen siendo los suyos.
 */
export const changeInput = orderInput.pick({
  lines: true,
  deliveryMethodId: true,
  zone: true,
  deliveryListCents: true,
  deliveryCents: true,
  address: true,
  deliverOn: true,
})
export type ChangeInput = z.infer<typeof changeInput>

/**
 * Lo que se elige al mover una entrega (Despachos, tablero 6): su franja (null, sin franja) y quién
 * la lleva. Sin ellos, siguen los que tenía.
 */
const moveFields = {
  slot: slotInput.nullable().optional(),
  courier: courierChoice.optional(),
}

/** «No se entregó»: con su motivo (de la lista o escrito) y el día en que vuelve a salir. */
export const missedInput = z.object({ reason, deliverOn: dateOnly, ...moveFields })

/** «Pasar a…»: otro día, y si se quiere otra franja u otro repartidor. */
export const rescheduleInput = z.object({ deliverOn: dateOnly, ...moveFields })

/** «Cambiar repartidor». */
export const courierInput = z.object({ courier: courierChoice })

/**
 * «Avisar» (decisión 4): el texto que la persona envió desde el WhatsApp de su celular. Queda en la
 * historia como «enviado por usted»: gestorIA no sabe si llegó.
 */
export const sentByYouInput = z.object({
  text: z.string().trim().min(3, "Escribe el aviso").max(1000, "Máximo 1000 caracteres"),
})

/** «Deshacer» la confirmación de un pago, con motivo escrito. */
export const undoInput = z.object({ reason })

/** Qué día es en la tienda (su hora, `hora.ts`). */
async function todayIn(tx: Db, storeId: string, now = new Date()) {
  return (await storeClockIn(tx, storeId, now)).today
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
  /** Nulo al cambiar un pedido: su medio de pago no se vuelve a elegir. */
  payment: typeof storePaymentMethod.$inferSelect | null
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
  /**
   * Al cambiar un pedido: se cobra como ya se acordó (su medio de pago no se vuelve a elegir) y el
   * stock no frena (lo que el pedido ya tiene fuera cuenta; si falta, queda «falta stock»).
   */
  change: { collection: PaymentCollection } | null = null,
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
    else if (!change && row.stock < line.quantity)
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

  let payment: typeof storePaymentMethod.$inferSelect | null = null
  if (change) {
    if (change.collection === "al_recibir" && delivery && !delivery.acceptsPayOnDelivery)
      fields.deliveryMethodId =
        "Esa forma de entrega no acepta pago al recibir, y este pedido se paga así"
  } else {
    ;[payment = null] = await tx
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
  }

  if (Object.keys(fields).length > 0 || !delivery || (!change && !payment))
    return { ok: false, fields }
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
  now = new Date(),
) {
  return inStore(appDb, person, storeId, "ventas.atender", async (tx) => {
    const today = await todayIn(tx, storeId, now)
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
  | "cambiado"

/**
 * Un aviso al cliente. Queda en la historia del pedido con lo que diría; hoy no sale (B2 lo
 * enviará por la conversación del pedido, con la plantilla de Meta si pasaron 24 horas).
 */
async function notifyCustomer(
  tx: Db,
  order: { id: string; storeId: string; number: number; totalCents: number; state?: OrderState },
  actorUserId: string | null,
  currency: string,
  kind: Notice,
  extra: {
    url?: string
    tracking?: string | null
    agency?: string | null
    /** Con un pago confirmado: cuánto pagó y cuánto falta (el pago en partes). */
    paidCents?: number
    dueCents?: number
  } = {},
) {
  const n = pad(order.number)
  const total = formatMoney(order.totalCents, currency)
  const text: Record<Notice, string> = {
    resumen: `Tu pedido ${n} quedó anotado. Total: ${total}.`,
    link: `Puedes pagar tu pedido ${n} (${total}) aquí: ${extra.url ?? ""}`,
    pago_confirmado:
      extra.dueCents && extra.paidCents
        ? `Recibimos tu pago de ${formatMoney(extra.paidCents, currency)} del pedido ${n}. Falta pagar ${formatMoney(extra.dueCents, currency)}.`
        : order.state === "en_camino" || order.state === "entregado"
          ? `Recibimos tu pago del pedido ${n}. ¡Gracias!`
          : `Recibimos tu pago del pedido ${n}. ¡Gracias! Te avisamos cuando salga.`,
    pago_no_coincide: `No pudimos confirmar el pago de tu pedido ${n}. ¿Puedes revisarlo y enviarnos la captura otra vez?`,
    en_camino: `Tu pedido ${n} va en camino${extra.agency ? ` por ${extra.agency}` : ""}.${extra.tracking ? ` Número de envío: ${extra.tracking}.` : ""}`,
    entregado: `Tu pedido ${n} fue entregado. ¡Gracias por tu compra!`,
    anulado: `Tu pedido ${n} fue anulado. Si es un error, escríbenos.`,
    cambiado: extra.dueCents
      ? `Cambiamos tu pedido ${n}. Nuevo total: ${total}. Falta pagar ${formatMoney(extra.dueCents, currency)}.`
      : `Cambiamos tu pedido ${n}. Nuevo total: ${total}.`,
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
 *
 * Un precio negociado vence a las 24 horas (ADR 0207). Sofi puede pasar la hora que ya le dijo a
 * la clienta al ofrecerlo (`priceExpiresAt`): nunca más tarde que esas 24 horas, para que el
 * pedido venza a la misma hora que la oferta.
 */
export async function createOrderIn(
  tx: Db,
  storeId: string,
  actorUserId: string,
  input: OrderInput,
  options: {
    conversationId?: string | null
    now?: Date
    today?: string
    test?: boolean
    priceExpiresAt?: Date | null
  } = {},
) {
  const now = options.now ?? new Date()
  const { currency } = await storeRow(tx, storeId)
  const today = options.today ?? (await todayIn(tx, storeId, now))
  const result = await priceOrder(tx, storeId, currency, input, today)
  if (!result.ok)
    throw new StoreError(
      400,
      "VALIDATION_ERROR",
      Object.values(result.fields)[0] ?? "Revisa el pedido",
      result.fields,
    )
  const { quote: q, variants, delivery } = result.priced
  const payment = result.priced.payment!
  // El trato que ya venció no se renueva solo: quien arma el pedido vuelve a cotizar.
  const expiresAt = q.negotiated ? negotiatedUntil(now, options.priceExpiresAt) : null
  if (q.negotiated && !expiresAt)
    throw new StoreError(409, "PRICE_EXPIRED", "El precio acordado ya venció: vuelve a cotizar.")
  // La ficha de la clienta: la elegida, la de su conversación o una nueva (nunca por el teléfono).
  const client = await customerForOrderIn(tx, storeId, actorUserId, input, {
    conversationId: options.conversationId,
    test: options.test,
  })
  if (!client && !input.customerName)
    throw new StoreError(400, "VALIDATION_ERROR", "Escribe el nombre de la clienta", {
      customerName: "Escribe el nombre de la clienta",
    })
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
      customerId: client?.id ?? null,
      customerName: client?.name ?? input.customerName,
      customerPhone: client ? client.phone : input.customerPhone,
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
      priceExpiresAt: expiresAt,
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
    customerId: order!.customerId,
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
  now = new Date(),
) {
  return inStore(appDb, person, storeId, "ventas.atender", async (tx) => {
    const created = await createOrderIn(tx, storeId, person.userId, input, { now })
    return orderDetailIn(tx, storeId, created.id)
  })
}

/* ------------------------------------------------------------------ la lista y el detalle */

export async function listOrders(
  appDb: Db,
  person: Person,
  storeId: string,
  filter: OrderFilter,
  now = new Date(),
) {
  return inStore(appDb, person, storeId, "ventas.atender", async (tx) => {
    const today = await todayIn(tx, storeId, now)
    const dueToday = and(inArray(saleOrder.state, TO_DELIVER), lte(saleOrder.deliverOn, today))
    // Un pago que espera a una persona, en cualquier estado del pedido.
    const toConfirm = sql`exists (select 1 from ${orderPayment} where ${orderPayment.orderId} = ${saleOrder.id} and ${orderPayment.status} = 'por_confirmar')`
    const where = and(
      eq(saleOrder.storeId, storeId),
      inArray(saleOrder.state, ORDER_FILTERS[filter]),
      filter === "hoy" ? dueToday : undefined,
      filter === "por_confirmar" ? toConfirm : undefined,
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
    // Quién confirmó el pago: «Yape · confirmado por Rosa» (el último, si pagó en partes).
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
          .orderBy(asc(orderPayment.reviewedAt))
      : []
    const balances = await balancesIn(tx, ids)
    const counts = await tx
      .select({ state: saleOrder.state, n: count() })
      .from(saleOrder)
      .where(eq(saleOrder.storeId, storeId))
      .groupBy(saleOrder.state)
    const [today_] = await tx
      .select({ n: count() })
      .from(saleOrder)
      .where(and(eq(saleOrder.storeId, storeId), dueToday))
    const [toConfirm_] = await tx
      .select({ n: count() })
      .from(saleOrder)
      .where(and(eq(saleOrder.storeId, storeId), toConfirm))
    const byState = Object.fromEntries(counts.map((c) => [c.state, c.n])) as Partial<
      Record<OrderState, number>
    >
    const total = (states: OrderState[]) => states.reduce((n, s) => n + (byState[s] ?? 0), 0)
    const linesBy = Map.groupBy(lines, (line) => line.orderId)
    const confirmedBy = new Map(confirmed.map((c) => [c.orderId, c]))
    return {
      /** El día de hoy en la tienda: con él se dice «hoy», «mañana» o «ayer». */
      today,
      orders: rows.map((row) => {
        const own = linesBy.get(row.id) ?? []
        const paid = confirmedBy.get(row.id)
        const balance = balances.get(row.id) ?? unpaidBalance(row.totalCents)
        return {
          ...row,
          number: pad(row.number),
          lines: own.map(({ orderId: _, ...line }) => line),
          confirmedBy: paid ? (paid.kind === "link" ? "el link" : paid.name) : null,
          balance,
          paid: balance.paid,
        }
      }),
      counts: {
        abiertos: total(OPEN),
        por_confirmar: toConfirm_?.n ?? 0,
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
      methodName: orderPayment.methodName,
      methodType: orderPayment.methodType,
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
  // Pagado y por salir sin tener fuera lo de sus líneas: no alcanzaba el stock al pagar, o al
  // cambiarlo.
  const stockPending =
    order.state === "por_salir" &&
    order.paymentCollection !== "al_recibir" &&
    !order.test &&
    (
      await tx.execute<{ short: boolean }>(
        sql`select ${stockShortSql("o")} as short from sale_order o where o.id = ${order.id}`,
      )
    )[0]?.short === true
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
  const { storeId: _s, linkRef: _r, paymentMethodId: _p, conversationId: _c, ...rest } = order
  // El link solo se ofrece a un pedido por pagar.
  const linkConnected =
    order.state === "por_pagar" &&
    (
      await tx
        .select({ provider: storePaymentLink.provider })
        .from(storePaymentLink)
        .where(eq(storePaymentLink.storeId, storeId))
    ).length > 0
  const balance = await balanceIn(tx, order)
  const now = Date.now()
  const slot = slotOf(order)
  return {
    ...rest,
    number: pad(order.number),
    /** Su franja, «9–13 h»; null: sin franja. */
    slot: slot ? { ...slot, label: slotLabel(slot) } : null,
    /** Quién lo lleva. */
    courierName: order.courierId
      ? ((await courierNamesIn(tx, storeId)).get(order.courierId) ?? null)
      : null,
    /** Lo armó Sofi en la conversación. */
    bySofi: order.createdBy === SOFI_ACTOR,
    /** La tienda conectó su link de pago: se puede ofrecer «Link de pago». */
    linkConnected,
    /** La ficha de la clienta que se ve (si quedó dentro de otra, esa otra); nula sin ficha. */
    customerId: await shownCustomerId(tx, order.customerId),
    linkUrl: order.linkExpiresAt && order.linkExpiresAt.getTime() <= now ? null : order.linkUrl,
    priceExpired: Boolean(order.priceExpiresAt && order.priceExpiresAt.getTime() <= now),
    /** Lo cobrado, lo por confirmar y lo que falta cobrar (`saldo.ts`). */
    balance,
    /** «Pagado»: no falta cobrar y todo está confirmado. */
    paid: balance.paid,
    /** Ya entró dinero: un pago confirmado, o uno por el link que espera a una persona. */
    moneyIn: payments.some(
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
      /** Si se confirma, cuánto pasaría del total: más de 0 es un pago doble. */
      overIfConfirmedCents: overIfConfirmed(balance, order.totalCents, p),
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
export async function sellable(appDb: Db, person: Person, storeId: string, now = new Date()) {
  return inStore(appDb, person, storeId, "ventas.atender", async (tx) => {
    const rows = await variantPrices(tx, storeId, await todayIn(tx, storeId, now))
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

/** La franja de un pedido; null: sin franja. */
function slotOf(order: Pick<OrderRow, "slotStart" | "slotEnd">) {
  return order.slotStart === null || order.slotEnd === null
    ? null
    : { start: order.slotStart, end: order.slotEnd }
}

function stateError(order: OrderRow): StoreError {
  const now: Record<OrderState, string> = {
    por_pagar: "está por pagar",
    por_confirmar: "tiene un pago por confirmar",
    por_salir: "ya está por salir",
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
async function moneyReceived(tx: Db, orderId: string): Promise<boolean> {
  const rows = await tx
    .select({ kind: orderPayment.kind, status: orderPayment.status })
    .from(orderPayment)
    .where(eq(orderPayment.orderId, orderId))
  return rows.some(
    (p) => p.status === "confirmado" || (p.kind === "link" && p.status === "por_confirmar"),
  )
}

type MethodCopy = { methodName: string; methodType: PaymentTypeCode }

/**
 * El medio de un pago, copiado del de la tienda como se copia en el pedido. Con `methodId`, ese
 * (de la tienda y que se cobre de esa forma); si no, el del pedido si se cobra así, o el primero
 * encendido que se cobre así. Si la tienda ya no tiene ninguno, el nombre del pedido con su tipo
 * (o «1», otro, si ya no se sabe); por el link, «Link de pago».
 */
async function methodFor(
  tx: Db,
  storeId: string,
  order: OrderRow,
  collection: PaymentCollection,
  methodId: string | null = null,
): Promise<MethodCopy> {
  const methods = await tx
    .select({
      id: storePaymentMethod.id,
      name: storePaymentMethod.name,
      typeCode: storePaymentMethod.typeCode,
      collection: storePaymentMethod.collection,
      isActive: storePaymentMethod.isActive,
    })
    .from(storePaymentMethod)
    .where(eq(storePaymentMethod.storeId, storeId))
    .orderBy(asc(storePaymentMethod.createdAt))
  const usable = methods.filter((m) => m.collection === collection)
  const copy = (m: { name: string; typeCode: PaymentTypeCode }) => ({
    methodName: m.name,
    methodType: m.typeCode,
  })
  if (methodId) {
    const chosen = usable.find((m) => m.id === methodId)
    if (!chosen)
      throw new StoreError(400, "VALIDATION_ERROR", "Elige un medio de pago de la lista", {
        methodId: "Elige un medio de pago de la lista",
      })
    return copy(chosen)
  }
  const found = usable.find((m) => m.id === order.paymentMethodId) ?? usable.find((m) => m.isActive)
  if (found) return copy(found)
  if (collection === "link") return { methodName: "Link de pago", methodType: "68" }
  const own = methods.find((m) => m.id === order.paymentMethodId)
  return { methodName: order.paymentName, methodType: own?.typeCode ?? "1" }
}

/**
 * Anota la captura de un pago: queda «por confirmar» hasta que una persona lo mire. Se puede
 * mientras falte cobrar (el pago en partes): el adelanto y después el resto.
 */
export async function addReceipt(
  appDb: Db,
  person: Person,
  storeId: string,
  orderId: string,
  input: ReceiptData,
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

/** Lo que se anota de una captura: el monto, el número de operación y, si se elige, su medio. */
export type ReceiptData = {
  amountCents: number
  operation: string | null
  methodId?: string | null
}

/**
 * Anota una captura dentro de la transacción de la tienda: la usan el equipo y Sofi. Queda
 * «pago por confirmar»; confirmarla es de una persona (`reviewPayment`). Un pedido por pagar pasa
 * a «pago por confirmar»; uno que ya sale sigue como está, con su pago esperando.
 */
export async function addReceiptIn(
  tx: Db,
  storeId: string,
  actorUserId: string,
  orderId: string,
  input: ReceiptData,
  photo: Uint8Array | null = null,
  photoType: (typeof orderPayment.$inferInsert)["photoType"] = null,
) {
  const order = await lockOrder(tx, storeId, orderId)
  if (order.state === "anulado") throw stateError(order)
  const before = await balanceIn(tx, order)
  if (before.dueCents === 0)
    throw new StoreError(
      409,
      "NOTHING_DUE",
      before.pendingCents > 0
        ? `Lo que falta del pedido ${pad(order.number)} ya está en un pago por confirmar: confírmalo o di que no coincide.`
        : `El pedido ${pad(order.number)} ya no debe nada. Recarga para verlo.`,
    )
  const { currency } = await storeRow(tx, storeId)
  const method = await methodFor(tx, storeId, order, "comprobante", input.methodId ?? null)
  await tx.insert(orderPayment).values({
    storeId,
    orderId,
    kind: "comprobante",
    status: "por_confirmar",
    amountCents: input.amountCents,
    ...method,
    operation: input.operation,
    photoType,
    photo: photo ? Buffer.from(photo) : null,
    createdBy: actorUserId,
  })
  if (order.state === "por_pagar") await setState(tx, order, "por_confirmar")
  await logEvent(tx, storeId, orderId, actorUserId, "comprobante", {
    monto: input.amountCents,
    medio: method.methodName,
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
      // Un pago en partes no es un pago doble: solo lo es si lo confirmado pasa del total. Ese, o
      // uno sobre un pedido anulado, se confirma igual (el dinero llegó) y queda escrito que hay
      // que ver si se devuelve.
      const over = overIfConfirmed(await balanceIn(tx, order), order.totalCents, payment)
      const extra =
        order.state === "anulado"
          ? "Pago sobre un pedido anulado: revisa si hay que devolverlo"
          : over > 0
            ? `Pago doble: con este pago se cobró ${formatMoney(over, currency)} más que el total. Revisa si hay que devolverlo`
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
      // El primer pago confirmado lo deja listo para salir, aunque falte cobrar el resto.
      let stockPending = false
      if (order.state === "por_confirmar") {
        stockPending = !(await trySale(tx, order, person.userId))
        await setState(tx, order, "por_salir")
      }
      const after = await balanceIn(tx, order)
      await logEvent(tx, storeId, orderId, person.userId, "pago_confirmado", {
        monto: payment.amountCents,
        medio: payment.methodName,
        ...(after.dueCents > 0 ? { falta: after.dueCents } : {}),
        ...(stockPending ? { faltaStock: true } : {}),
        ...(order.state !== "por_confirmar" ? { estado: order.state } : {}),
        ...(extra ? { porRevisar: extra } : {}),
      })
      // Lo que hay que revisar (un pago doble, un pedido anulado) no se le avisa al cliente.
      if (!extra)
        await notifyCustomer(tx, order, person.userId, currency, "pago_confirmado", {
          paidCents: payment.amountCents,
          dueCents: after.dueCents,
        })
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
      // También la captura del resto de un pedido que ya sale (el pago en partes); no la de un
      // pedido anulado, ni la de un link que llegó cuando ya no se esperaba.
      if (
        order.state === "por_confirmar" ||
        (payment.kind === "comprobante" && order.state !== "anulado")
      )
        await notifyCustomer(tx, order, person.userId, currency, "pago_no_coincide")
    }
    return orderDetailIn(tx, storeId, orderId)
  })
}

/**
 * «Deshacer» la confirmación de una captura (tablero 7), con motivo escrito: se confirmó por error.
 * El pago vuelve a esperar a una persona y queda en la historia. Si era lo único confirmado de un
 * pedido que todavía no sale, vuelve a «Pago por confirmar» y lo que salió del stock vuelve: el
 * stock baja al confirmar el pago. Lo que llegó por el link o se cobró en la puerta no se deshace,
 * ni el pago de un pedido entregado o anulado.
 */
export async function undoPayment(
  appDb: Db,
  person: Person,
  storeId: string,
  orderId: string,
  paymentId: string,
  input: z.infer<typeof undoInput>,
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
    if (payment.status !== "confirmado")
      throw new StoreError(
        409,
        "PAYMENT_REVIEWED",
        "Ese pago no está confirmado. Recarga para verlo.",
      )
    if (payment.kind !== "comprobante")
      throw new StoreError(
        409,
        "PAYMENT_UNDO",
        payment.kind === "link"
          ? "Un pago por el link lo confirmó el link: no se deshace."
          : "Lo cobrado en la puerta no se deshace.",
      )
    if (order.state === "entregado" || order.state === "anulado") throw stateError(order)
    const undone = `Se deshizo la confirmación: ${input.reason}`
    await tx
      .update(orderPayment)
      .set({
        status: "por_confirmar",
        reviewedBy: null,
        reviewedAt: null,
        note: (payment.note ? `${payment.note}. ${undone}` : undone).slice(0, 300),
      })
      .where(eq(orderPayment.id, paymentId))
    // Sin otro pago confirmado, lo que todavía no sale vuelve a esperar su pago.
    let back = 0
    let state: OrderState = order.state
    if (
      order.state === "por_salir" &&
      order.paymentCollection !== "al_recibir" &&
      (await balanceIn(tx, order)).confirmedCents === 0
    ) {
      if (!order.test)
        back = await cancelSale(tx, storeId, person.userId, stockReference(order.number))
      state = "por_confirmar"
      await setState(tx, order, state)
    }
    await logEvent(tx, storeId, orderId, person.userId, "pago_deshecho", {
      monto: payment.amountCents,
      medio: payment.methodName,
      motivo: input.reason,
      ...(state !== order.state ? { estado: state } : {}),
      ...(back > 0 ? { stockDevuelto: back } : {}),
    })
    return orderDetailIn(tx, storeId, orderId)
  })
}

/**
 * La agencia y el número de envío que quedan: la agencia solo en un envío por agencia (tablero 17);
 * lo que no se escribe sigue como estaba.
 */
function shippingOf(order: OrderRow, input: z.infer<typeof shippingInput>) {
  if (input.agency && order.deliveryType !== "ParcelService")
    throw new StoreError(400, "VALIDATION_ERROR", "La agencia es de un envío por agencia", {
      agency: "La agencia es de un envío por agencia",
    })
  return { agency: input.agency ?? order.agency, tracking: input.tracking ?? order.tracking }
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
    const shipping = shippingOf(order, input)
    await mustSale(tx, order, person.userId)
    await setState(tx, order, "en_camino", shipping)
    const { currency } = await storeRow(tx, storeId)
    await logEvent(tx, storeId, orderId, person.userId, "salio", {
      envio: shipping.tracking,
      ...(shipping.agency ? { agencia: shipping.agency } : {}),
    })
    await notifyCustomer(tx, order, person.userId, currency, "en_camino", shipping)
    return orderDetailIn(tx, storeId, orderId)
  })
}

/** Lo cobrado en la puerta, uno por medio: con qué y cuánto. */
type DoorPayment = { methodId: string | null; amountCents: number }

/** Lo que se cobró en la puerta: varios medios, o el monto y el medio de antes (uno solo). */
function doorPaymentsOf(input: z.infer<typeof deliverInput>): DoorPayment[] {
  if (input.payments.length > 0) return input.payments
  return input.collectedCents
    ? [{ methodId: input.methodId, amountCents: input.collectedCents }]
    : []
}

/**
 * «Entregado» (o «Cobrar y entregar» si falta cobrar). Sin pago confirmado no se entrega (tablero
 * 24): si falta cobrar, lo cobrado en la puerta se anota en este mismo paso, con su medio (efectivo
 * o el POS de la tienda, con la foto del voucher si la hay), y tiene que ser todo lo que falta; un
 * pago que espera a una persona (una captura de Yape a la tienda, un link que no coincide) se
 * confirma antes. Lo cobrado queda a nombre de quien llevaba el pedido (su efectivo lo entrega en
 * Caja), y quién lo anotó, con su nombre.
 *
 * Cualquier paso completa los anteriores (tableros 6 y 7): si nadie marcó «Salió», queda también
 * «Salió», con la misma hora. Un recojo en tienda no sale: pasa de «por salir» a entregado.
 */
export async function markDelivered(
  appDb: Db,
  person: Person,
  storeId: string,
  orderId: string,
  input: z.infer<typeof deliverInput>,
  voucher: { photo: Uint8Array; type: PhotoType } | null = null,
) {
  return inStore(appDb, person, storeId, "entregas", async (tx) => {
    const order = await lockOrder(tx, storeId, orderId)
    if (order.state !== "por_salir" && order.state !== "en_camino") throw stateError(order)
    const { dueCents, pendingCents } = await balanceIn(tx, order)
    const { currency } = await storeRow(tx, storeId)
    if (pendingCents > 0)
      throw new StoreError(
        409,
        "PAYMENT_PENDING",
        `Hay un pago de ${formatMoney(pendingCents, currency)} por confirmar. Confírmalo, o di que no coincide, antes de entregar: sin pago confirmado no se entrega.`,
      )
    const door = doorPaymentsOf(input)
    if (dueCents === 0 && door.length > 0)
      throw new StoreError(
        409,
        "NOTHING_DUE",
        `El pedido ${pad(order.number)} ya no debe nada. Recarga para verlo.`,
      )
    if (dueCents > 0) {
      const sum = door.reduce((total, one) => total + one.amountCents, 0)
      if (sum === 0)
        throw new StoreError(400, "VALIDATION_ERROR", "Escribe cuánto cobraste", {
          collectedCents: "Escribe cuánto cobraste al entregar",
        })
      if (sum !== dueCents)
        throw new StoreError(
          400,
          "VALIDATION_ERROR",
          sum < dueCents
            ? `Falta cobrar ${formatMoney(dueCents - sum, currency)}: sin todo el pago no se entrega. Anota lo que falta o pásalo a otro día.`
            : `Es más de lo que falta (${formatMoney(dueCents, currency)}): anota solo lo que debía, sin el vuelto.`,
          { collectedCents: `Falta cobrar ${formatMoney(dueCents, currency)}` },
        )
    }
    const methods: MethodCopy[] = []
    for (const one of door)
      methods.push(await methodFor(tx, storeId, order, "al_recibir", one.methodId))
    // La foto del voucher va con lo cobrado con tarjeta (el POS), o con lo único cobrado.
    const withPhoto = voucher
      ? Math.max(
          0,
          methods.findIndex((m) => m.methodType === "48"),
        )
      : -1
    const now = new Date()
    for (const [i, one] of door.entries())
      await tx.insert(orderPayment).values({
        storeId,
        orderId,
        kind: "al_recibir",
        status: "confirmado",
        amountCents: one.amountCents,
        ...methods[i]!,
        courierId: order.courierId,
        ...(i === withPhoto && voucher
          ? { photo: Buffer.from(voucher.photo), photoType: voucher.type }
          : {}),
        createdBy: person.userId,
        reviewedBy: person.userId,
        reviewedAt: now,
      })
    await mustSale(tx, order, person.userId)
    await setState(tx, order, "entregado")
    if (order.state === "por_salir" && order.deliveryType !== "OnSitePickup")
      await logEvent(tx, storeId, orderId, person.userId, "salio", { completado: true })
    await logEvent(tx, storeId, orderId, person.userId, "entregado", {
      ...(door.length > 0
        ? {
            cobrado: dueCents,
            medio: [...new Set(methods.map((m) => m.methodName))].join(" y "),
            moneda: currency,
          }
        : {}),
    })
    await notifyCustomer(tx, order, person.userId, currency, "entregado")
    return orderDetailIn(tx, storeId, orderId)
  })
}

/* ------------------------------------------------------------- corregir sin anular */

/** «Sandalia beige 38», «Medias × 2». */
function lineName(line: { productName: string; variantName: string; quantity: number }) {
  return `${line.productName}${line.variantName === "Única" ? "" : ` ${line.variantName}`}${line.quantity > 1 ? ` × ${line.quantity}` : ""}`
}

/** «mar 25 nov», contado en el calendario (la fecha ya es la de la tienda). */
export function dayText(date: string | null) {
  if (!date) return "sin día"
  return new Intl.DateTimeFormat("es-PE", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`))
}

export interface LineView {
  productId: string
  productName: string
  variantName: string
  quantity: number
  unitCents: number
  gift: boolean
}

export interface ChangeView {
  lines: LineView[]
  deliveryName: string
  zone: string | null
  deliveryCents: number
  address: string
  deliverOn: string | null
  subtotalCents: number
  totalCents: number
}

/**
 * Lo que cambió, como lo lee la persona en la historia: «Sandalia beige 37 → 38», «entrega: Surco →
 * San Isidro», «envío S/ 10,00 → S/ 12,00». Un producto que estaba una vez y sigue una vez se
 * compara consigo mismo; lo demás se dice como quitado o sumado.
 */
export function describeChange(before: ChangeView, after: ChangeView, currency: string): string[] {
  const changes: string[] = []
  const once = (lines: LineView[], productId: string) =>
    lines.filter((l) => l.productId === productId).length === 1
  const paired = new Set<string>()
  for (const old of before.lines) {
    if (!once(before.lines, old.productId) || !once(after.lines, old.productId)) continue
    const now = after.lines.find((l) => l.productId === old.productId)!
    paired.add(old.productId)
    if (old.variantName !== now.variantName)
      changes.push(`${old.productName} ${old.variantName} → ${now.variantName}`)
    if (old.quantity !== now.quantity)
      changes.push(`${old.productName}: ${old.quantity} → ${now.quantity} unidades`)
  }
  const key = (l: LineView) => `${l.productId}|${l.variantName}|${l.quantity}`
  const kept = new Set(after.lines.map(key))
  const had = new Set(before.lines.map(key))
  for (const old of before.lines)
    if (!paired.has(old.productId) && !kept.has(key(old))) changes.push(`quitó ${lineName(old)}`)
  for (const now of after.lines)
    if (!paired.has(now.productId) && !had.has(key(now))) changes.push(`sumó ${lineName(now)}`)
  const where = (name: string, zone: string | null) => (zone ? `${name} (${zone})` : name)
  if (before.deliveryName !== after.deliveryName || before.zone !== after.zone)
    changes.push(
      `entrega: ${where(before.deliveryName, before.zone)} → ${where(after.deliveryName, after.zone)}`,
    )
  if (before.deliveryCents !== after.deliveryCents)
    changes.push(
      `envío ${formatMoney(before.deliveryCents, currency)} → ${formatMoney(after.deliveryCents, currency)}`,
    )
  if (before.address !== after.address)
    changes.push(after.address ? `dirección: ${after.address}` : "sin dirección")
  if (before.deliverOn !== after.deliverOn)
    changes.push(`día: ${dayText(before.deliverOn)} → ${dayText(after.deliverOn)}`)
  // El precio acordado de lo que se queda también cuenta: otro descuento es un cambio.
  const samePrices =
    before.lines.length === after.lines.length &&
    before.lines.every(
      (l, i) => l.unitCents === after.lines[i]!.unitCents && l.gift === after.lines[i]!.gift,
    )
  if (changes.length === 0 && !samePrices)
    changes.push(
      `productos ${formatMoney(before.subtotalCents, currency)} → ${formatMoney(after.subtotalCents, currency)}`,
    )
  // El total se dice al final, si cambió.
  if (changes.length > 0 && before.totalCents !== after.totalCents)
    changes.push(
      `total ${formatMoney(before.totalCents, currency)} → ${formatMoney(after.totalCents, currency)}`,
    )
  return changes
}

function notShippedError(order: OrderRow): StoreError {
  if (order.state === "en_camino")
    return new StoreError(
      409,
      "ORDER_STATE",
      `El pedido ${pad(order.number)} ya va en camino. Si volvió sin entregar, usa «No se entregó».`,
    )
  return stateError(order)
}

/**
 * «Cambiar» dentro de la transacción de la tienda (ADR 0226): el mismo pedido, con su número, sus
 * pagos y su historia. Vuelve a calcular el precio con lo de hoy (nunca bajo el mínimo), cambia
 * sus líneas y su entrega, y el saldo sale de la base con el total nuevo: lo pagado no se pierde y
 * lo que falta o sobra queda en el saldo. Si el pedido ya tenía su stock fuera, se mueve solo la
 * diferencia, con la referencia del cambio; si la variante nueva no alcanza, se guarda igual,
 * vuelve lo que ya no va y queda «falta stock» hasta que entre (solo frena al salir).
 */
export async function changeOrderIn(
  tx: Db,
  storeId: string,
  actorUserId: string,
  orderId: string,
  input: ChangeInput,
  now = new Date(),
) {
  const order = await lockOrder(tx, storeId, orderId)
  if (!NOT_SHIPPED.includes(order.state)) throw notShippedError(order)
  const { currency } = await storeRow(tx, storeId)
  const today = await todayIn(tx, storeId, now)
  // Un día nuevo no puede ser uno que ya pasó; el que ya tenía se queda aunque haya pasado.
  if (input.deliverOn && input.deliverOn !== order.deliverOn && input.deliverOn < today)
    throw new StoreError(400, "VALIDATION_ERROR", "Elige hoy o un día que viene", {
      deliverOn: "Elige hoy o un día que viene",
    })
  const result = await priceOrder(
    tx,
    storeId,
    currency,
    {
      ...input,
      customerId: order.customerId,
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      channel: order.channel,
      notes: order.notes,
      paymentMethodId: order.paymentMethodId ?? "",
    },
    today,
    { collection: order.paymentCollection },
  )
  if (!result.ok)
    throw new StoreError(
      400,
      "VALIDATION_ERROR",
      Object.values(result.fields)[0] ?? "Revisa el pedido",
      result.fields,
    )
  const { quote: q, variants, delivery } = result.priced
  const before = await tx
    .select()
    .from(saleOrderLine)
    .where(eq(saleOrderLine.orderId, orderId))
    .orderBy(asc(saleOrderLine.position))
  const lines = input.lines.map((line, i) => {
    const v = variants.get(line.variantId)!
    const priced = q.lines[i]!
    return {
      storeId,
      orderId,
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
  })
  const zone = delivery.cost === "por_zona" ? input.zone : null
  const changes = describeChange(
    {
      lines: before,
      deliveryName: order.deliveryName,
      zone: order.deliveryZone,
      deliveryCents: order.deliveryCents,
      address: order.address,
      deliverOn: order.deliverOn,
      subtotalCents: order.subtotalCents,
      totalCents: order.totalCents,
    },
    {
      lines,
      deliveryName: delivery.name,
      zone,
      deliveryCents: q.deliveryCents,
      address: input.address,
      deliverOn: input.deliverOn,
      subtotalCents: q.subtotalCents,
      totalCents: q.totalCents,
    },
    currency,
  )
  // Un precio acordado que venció se vuelve a acordar con «Cambiar», aunque sea el mismo.
  if (
    changes.length === 0 &&
    q.negotiated &&
    order.priceExpiresAt &&
    order.priceExpiresAt.getTime() <= now.getTime()
  )
    changes.push("el precio acordado vale 24 horas más")
  if (changes.length === 0) throw new StoreError(409, "NO_CHANGE", "No cambiaste nada del pedido")
  // El link vigente era por el total de antes: ya no vale y se crea otro.
  const linkGone = order.linkUrl !== null && q.totalCents !== order.totalCents
  await tx
    .update(saleOrder)
    .set({
      address: input.address,
      deliveryMethodId: delivery.id,
      deliveryName: delivery.name,
      deliveryType: delivery.type,
      deliveryZone: zone,
      deliveryListCents: q.deliveryListCents,
      deliveryCents: q.deliveryCents,
      deliveryFreeByPolicy: q.deliveryFreeByPolicy,
      itemsAutoCents: q.itemsAutoCents,
      subtotalCents: q.subtotalCents,
      discountCents: q.discountCents,
      giftCents: q.giftCents,
      totalCents: q.totalCents,
      marginCents: q.marginCents,
      marginUsedCents: q.marginUsedCents,
      // Lo negociado al cambiar vale 24 horas desde ahora, como al anotarlo.
      priceExpiresAt: q.negotiated ? negotiatedUntil(now) : null,
      deliverOn: input.deliverOn,
      ...(linkGone ? { linkUrl: null, linkRef: null, linkExpiresAt: null } : {}),
      updatedAt: now,
    })
    .where(eq(saleOrder.id, orderId))
  await tx.delete(saleOrderLine).where(eq(saleOrderLine.orderId, orderId))
  await tx.insert(saleOrderLine).values(lines)

  // El stock: solo si el pedido ya lo tenía fuera (se pagó); si no, baja al pagar o al salir.
  let stockPending = false
  const reference = stockReference(order.number)
  if (!order.test && (await heldBy(tx, storeId, reference)).size > 0) {
    const wanted = input.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity }))
    try {
      await tx.transaction((sp) =>
        recordSale(sp as unknown as Db, storeId, actorUserId, reference, wanted),
      )
    } catch (error) {
      if (
        !(error instanceof StoreError) ||
        (error.code !== "NOT_ENOUGH_STOCK" && error.code !== "VARIANT_REMOVED")
      )
        throw error
      await recordSale(tx, storeId, actorUserId, reference, wanted, { returnsOnly: true })
      stockPending = true
    }
  }

  const balance = await balanceIn(tx, { id: orderId, totalCents: q.totalCents })
  await logEvent(tx, storeId, orderId, actorUserId, "cambiado", {
    cambios: changes,
    antes: order.totalCents,
    total: q.totalCents,
    ...(balance.dueCents > 0 && balance.confirmedCents + balance.pendingCents > 0
      ? { falta: balance.dueCents }
      : {}),
    ...(balance.overCents > 0
      ? {
          porRevisar: `Sobra ${formatMoney(balance.overCents, currency)} de lo pagado: revisa si hay que devolverlo`,
        }
      : {}),
    ...(stockPending ? { faltaStock: true } : {}),
    ...(linkGone ? { linkAnterior: true } : {}),
  })
  if (q.totalCents !== order.totalCents)
    await notifyCustomer(
      tx,
      { ...order, totalCents: q.totalCents },
      actorUserId,
      currency,
      "cambiado",
      { dueCents: balance.dueCents },
    )
  return { changes, stockPending, totalCents: q.totalCents as number | null, balance }
}

export async function changeOrder(
  appDb: Db,
  person: Person,
  storeId: string,
  orderId: string,
  input: ChangeInput,
) {
  uuidOr404(orderId)
  return inStore(appDb, person, storeId, "ventas.atender", async (tx) => {
    await changeOrderIn(tx, storeId, person.userId, orderId, input)
    return orderDetailIn(tx, storeId, orderId)
  })
}

type ChangeResult = Awaited<ReturnType<typeof changeOrderIn>>

/** Lo que corre la vista previa y se deshace: no guarda nada. */
class PreviewDone extends Error {
  constructor(readonly result: ChangeResult) {
    super("vista previa")
  }
}

/**
 * Cómo quedaría el pedido con el cambio, sin guardarlo: la misma operación, dentro de un paso que
 * se deshace. Así el total, el saldo y el stock salen de las mismas reglas que al guardar.
 */
export async function previewChange(
  appDb: Db,
  person: Person,
  storeId: string,
  orderId: string,
  input: ChangeInput,
): Promise<
  Omit<ChangeResult, "balance"> & {
    balance: ChangeResult["balance"] | null
    fields: Record<string, string>
  }
> {
  uuidOr404(orderId)
  return inStore(appDb, person, storeId, "ventas.atender", async (tx) => {
    try {
      await tx.transaction(async (sp) => {
        throw new PreviewDone(
          await changeOrderIn(sp as unknown as Db, storeId, person.userId, orderId, input),
        )
      })
    } catch (error) {
      if (error instanceof PreviewDone) return { ...error.result, fields: {} }
      const nothing = { changes: [], stockPending: false, totalCents: null, balance: null }
      if (error instanceof StoreError && error.code === "VALIDATION_ERROR")
        return { ...nothing, fields: error.fields ?? {} }
      if (error instanceof StoreError && error.code === "NO_CHANGE")
        return { ...nothing, fields: {} }
      throw error
    }
    throw new Error("La vista previa del cambio no terminó")
  })
}

/**
 * La franja y el repartidor con que vuelve a salir: lo elegido (una de las franjas de la tienda, o
 * la que ya tenía) o lo que ya tenía. Devuelve lo que se guarda y lo que cambió, para su historia.
 */
async function movedTo(
  tx: Db,
  order: OrderRow,
  actorUserId: string,
  input: { slot?: z.infer<typeof slotInput> | null; courier?: z.infer<typeof courierChoice> },
) {
  const set: Partial<OrderRow> = {}
  const detail: Record<string, string> = {}
  const before = slotOf(order)
  if (input.slot !== undefined && !sameSlot(input.slot, before)) {
    await checkSlotIn(tx, order.storeId, input.slot, before)
    set.slotStart = input.slot?.start ?? null
    set.slotEnd = input.slot?.end ?? null
    detail.franja = input.slot ? slotLabel(input.slot) : "sin franja"
  }
  if (input.courier !== undefined) {
    const courier = await courierFor(tx, order.storeId, actorUserId, input.courier)
    if ((courier?.id ?? null) !== order.courierId) {
      set.courierId = courier?.id ?? null
      detail.repartidor = courier?.name ?? "sin repartidor"
    }
  }
  return { set, detail }
}

/** Un día desde hoy (el de la tienda): no se entrega en el pasado. */
async function dayFromToday(tx: Db, storeId: string, day: string) {
  if (day < (await todayIn(tx, storeId)))
    throw new StoreError(400, "VALIDATION_ERROR", "Elige hoy o un día que viene", {
      deliverOn: "Elige hoy o un día que viene",
    })
}

/**
 * «No se entregó»: volvió sin entregar (no contestó, dirección errada, no lo quiso u otro motivo
 * escrito). Vuelve a «Por salir» el día que se elige, sin anular nada; el stock no se mueve.
 */
export async function markMissed(
  appDb: Db,
  person: Person,
  storeId: string,
  orderId: string,
  input: z.infer<typeof missedInput>,
) {
  return inStore(appDb, person, storeId, "entregas", async (tx) => {
    const order = await lockOrder(tx, storeId, orderId)
    if (order.state !== "en_camino" && order.state !== "por_salir") throw stateError(order)
    await dayFromToday(tx, storeId, input.deliverOn)
    const move = await movedTo(tx, order, person.userId, input)
    await setState(tx, order, "por_salir", { deliverOn: input.deliverOn, ...move.set })
    await logEvent(tx, storeId, orderId, person.userId, "no_entregado", {
      motivo: input.reason,
      dia: dayText(input.deliverOn),
      ...move.detail,
    })
    return orderDetailIn(tx, storeId, orderId)
  })
}

/** «Pasar a…»: otro día de entrega, sin anular nada. */
export async function reschedule(
  appDb: Db,
  person: Person,
  storeId: string,
  orderId: string,
  input: z.infer<typeof rescheduleInput>,
) {
  return inStore(appDb, person, storeId, "entregas", async (tx) => {
    const order = await lockOrder(tx, storeId, orderId)
    if (!NOT_SHIPPED.includes(order.state)) throw notShippedError(order)
    const move = await movedTo(tx, order, person.userId, input)
    if (order.deliverOn === input.deliverOn && Object.keys(move.detail).length === 0)
      throw new StoreError(409, "NO_CHANGE", `Ya sale el ${dayText(input.deliverOn)}`, {
        deliverOn: `Ya sale el ${dayText(input.deliverOn)}`,
      })
    if (order.deliverOn !== input.deliverOn) await dayFromToday(tx, storeId, input.deliverOn)
    await tx
      .update(saleOrder)
      .set({ deliverOn: input.deliverOn, ...move.set, updatedAt: new Date() })
      .where(eq(saleOrder.id, orderId))
    await logEvent(tx, storeId, orderId, person.userId, "reprogramado", {
      ...(order.deliverOn !== input.deliverOn
        ? { dia: `${dayText(order.deliverOn)} → ${dayText(input.deliverOn)}` }
        : {}),
      ...move.detail,
    })
    return orderDetailIn(tx, storeId, orderId)
  })
}

/**
 * «Cambiar repartidor» (Despachos): mientras no se entrega. Lo que cobre en la puerta queda a
 * nombre de quien lo lleva entonces.
 */
export async function assignCourier(
  appDb: Db,
  person: Person,
  storeId: string,
  orderId: string,
  input: z.infer<typeof courierInput>,
) {
  return inStore(appDb, person, storeId, "entregas", async (tx) => {
    const order = await lockOrder(tx, storeId, orderId)
    if (!OPEN.includes(order.state)) throw stateError(order)
    const move = await movedTo(tx, order, person.userId, { courier: input.courier })
    if (!move.detail.repartidor)
      throw new StoreError(409, "NO_CHANGE", "Ya lo lleva esa persona", {
        courier: "Ya lo lleva esa persona",
      })
    await tx
      .update(saleOrder)
      .set({ ...move.set, updatedAt: new Date() })
      .where(eq(saleOrder.id, orderId))
    await logEvent(tx, storeId, orderId, person.userId, "repartidor", move.detail)
    return orderDetailIn(tx, storeId, orderId)
  })
}

/**
 * La agencia y el número de envío de un pedido por agencia (tablero 17), al salir o después: el
 * número llega cuando la agencia lo da.
 */
export async function setShipping(
  appDb: Db,
  person: Person,
  storeId: string,
  orderId: string,
  input: z.infer<typeof shippingInput>,
) {
  return inStore(appDb, person, storeId, "entregas", async (tx) => {
    const order = await lockOrder(tx, storeId, orderId)
    if (order.state !== "por_salir" && order.state !== "en_camino") throw stateError(order)
    const shipping = shippingOf(order, input)
    if (shipping.agency === order.agency && shipping.tracking === order.tracking)
      throw new StoreError(409, "NO_CHANGE", "Ya está anotado así")
    await tx
      .update(saleOrder)
      .set({ ...shipping, updatedAt: new Date() })
      .where(eq(saleOrder.id, orderId))
    await logEvent(tx, storeId, orderId, person.userId, "envio", {
      ...(shipping.agency ? { agencia: shipping.agency } : {}),
      ...(shipping.tracking ? { envio: shipping.tracking } : {}),
    })
    return orderDetailIn(tx, storeId, orderId)
  })
}

/**
 * «Avisar» (decisión 4): la persona abrió el WhatsApp de su celular con el aviso escrito y lo envió
 * ella. Queda en la historia como «enviado por usted», nunca como entregado: gestorIA no lo vio
 * salir ni llegar.
 */
export async function noteSentByYou(
  appDb: Db,
  person: Person,
  storeId: string,
  orderId: string,
  input: z.infer<typeof sentByYouInput>,
) {
  return inStore(appDb, person, storeId, "entregas", async (tx) => {
    const order = await lockOrder(tx, storeId, orderId)
    if (order.state === "anulado") throw stateError(order)
    await logEvent(tx, storeId, orderId, person.userId, "aviso", {
      tipo: "despacho",
      texto: input.text,
      enviado: false,
      porUsted: true,
      motivo: SENT_BY_YOU,
    })
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
    throw new StoreError(
      403,
      "FORBIDDEN",
      "Un pedido que ya tiene un pago lo anula quien confirma pagos",
    )
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
        "El precio acordado venció (vale 24 horas). Si sigue en pie, usa «Cambiar» para volver a acordarlo.",
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
      ? // Con el pago en partes, «ya sale» no quiere decir «ya pagó todo»: se dice solo lo cierto.
        `Llegó por el link cuando el pedido ${order.state === "anulado" ? "ya estaba anulado" : "ya no estaba por pagar"}: revisa si hay que devolverlo`
      : !matches
        ? `El monto pagado por el link (${formatMoney(payment.amountCents, /^[A-Z]{3}$/.test(payment.currency) ? payment.currency : currency)}) no coincide con el total`
        : null
    const now = new Date()
    const db = tx as unknown as Db
    const method = await methodFor(db, storeId, order, "link")
    if (waiting && matches) {
      await tx.insert(orderPayment).values({
        storeId,
        orderId,
        kind: "link",
        status: "confirmado",
        amountCents: payment.amountCents,
        ...method,
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
      await notifyCustomer(db, order, null, currency, "pago_confirmado", {
        paidCents: payment.amountCents,
        dueCents: 0,
      })
      return done
    }
    // No coincide: lo mira una persona. El dinero ya llegó, así que nunca se descarta.
    await tx.insert(orderPayment).values({
      storeId,
      orderId,
      kind: "link",
      status: "por_confirmar",
      amountCents: payment.amountCents,
      ...method,
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

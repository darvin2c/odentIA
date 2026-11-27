import {
  conversation,
  type Db,
  orderPayment,
  product,
  productVariant,
  saleOrder,
  stockRequest,
} from "@gestoria/db"
import { and, asc, count, eq, inArray, isNull, lte, ne, sql } from "drizzle-orm"
import { similarIn } from "./clientes.js"
import type { Person } from "./cuenta.js"
import { startOfDay, storeClockIn } from "./hora.js"
import { missedSql, pad, paidWithoutStockIn, TO_DELIVER } from "./pedidos.js"
import { can, type StoreSeat } from "./permisos.js"
import { setupIn } from "./primeros-pasos.js"
import { collectedSinceIn, pendingNowIn } from "./sofi/reportes.js"
import { inStore } from "./tiendas.js"

/**
 * Inicio (lienzo «gestorIA como odentIA», tablero 5; ADR 0227): abro y sé qué me toca. Lo ve todo
 * el equipo que atiende, cada rol con lo suyo (`permisos.ts`):
 *
 * - Cuatro cifras en la hora de la tienda: «Cobrado hoy», «Por confirmar», «Falta cobrar» (sin lo
 *   que está por confirmar) y «Sale hoy» (con lo que no se entregó). Salen de la misma cuenta que
 *   Reportes (`collectedSinceIn`, `pendingNowIn`), del saldo único: aquí no se recalcula nada. Los
 *   totales de dinero son de quien ve Reportes (`reportes.ver`); Ventas ve cuántos, sin montos.
 * - «Te toca»: ahora, hoy y sin apuro, cada línea con lo que hace falta para su único botón, y
 *   solo para quien puede resolverla. Es lo que antes estaba en Reportes, de Argos: cálculos fijos.
 * - Los primeros pasos de una tienda nueva (`primeros-pasos.ts`), para quien la configura.
 *
 * Los pedidos de prueba no cuentan, como en Reportes y Argos.
 */

export type ToDoWhen = "ahora" | "hoy" | "sin_apuro"

export type ToDoItem =
  /** Un pago que espera a una persona: «Ver y confirmar» abre el pedido con su captura. */
  | {
      kind: "pago"
      when: "ahora"
      orderId: string
      number: string
      customer: string
      amountCents: number
      method: string
      /** Llegó por el link y no coincide con el pedido. */
      byLink: boolean
      at: Date
    }
  /** Volvió sin entregar y todavía no sale otra vez: «Pasar a…». */
  | {
      kind: "no_entregado"
      when: "ahora"
      orderId: string
      number: string
      customer: string
      reason: string
      missedAt: Date
      deliverOn: string | null
    }
  /** Dos fichas que quizá son la misma clienta: «Comparar». */
  | {
      kind: "misma"
      when: "hoy"
      reason: "telefono" | "nombre"
      a: { id: string; name: string }
      b: { id: string; name: string }
      /** Cuántas parejas más hay por mirar. */
      more: number
    }
  /** Pagado, pero no alcanza el stock de lo que lleva: «Ver pedido». */
  | { kind: "stock"; when: "hoy"; orderId: string; number: string; customer: string }
  /** Se acabó y alguien lo pidió: cuando entre, Sofi le avisa sola. «Registrar una entrada». */
  | {
      kind: "reponer"
      when: "sin_apuro"
      productId: string
      product: string
      variant: string
      people: number
    }

/**
 * Lo que espera de otras pantallas, que todavía no existen: no se dibuja hasta que lleguen.
 * - `chats`: las conversaciones que esperan a una persona («Abrir Bandeja», con la Bandeja).
 * Caja (el efectivo por recibir) y Despachos suman aquí su parte cuando lleguen.
 */
export interface WaitingElsewhere {
  chats: { conversationId: string; customer: string | null; reason: string | null; at: Date }[]
}

async function paymentsToConfirm(tx: Db, storeId: string): Promise<ToDoItem[]> {
  const rows = await tx
    .select({
      orderId: saleOrder.id,
      number: saleOrder.number,
      customer: saleOrder.customerName,
      amount: orderPayment.amountCents,
      kind: orderPayment.kind,
      method: orderPayment.methodName,
      at: orderPayment.createdAt,
    })
    .from(orderPayment)
    .innerJoin(saleOrder, eq(saleOrder.id, orderPayment.orderId))
    .where(
      and(
        eq(orderPayment.storeId, storeId),
        eq(orderPayment.status, "por_confirmar"),
        eq(saleOrder.test, false),
      ),
    )
    .orderBy(asc(orderPayment.createdAt))
  return rows.map((p) => ({
    kind: "pago",
    when: "ahora",
    orderId: p.orderId,
    number: pad(p.number),
    customer: p.customer,
    amountCents: p.amount,
    method: p.method,
    byLink: p.kind === "link",
    at: p.at,
  }))
}

async function missedOrders(tx: Db, storeId: string): Promise<ToDoItem[]> {
  const rows = await tx.execute<{
    id: string
    number: number
    customer_name: string
    deliver_on: string | null
    reason: string | null
    missed_at: string
  }>(sql`
    select o.id, o.number, o.customer_name, o.deliver_on::text as deliver_on,
      e.detail->>'motivo' as reason, e.created_at as missed_at
    from sale_order o
    join lateral (
      select detail, created_at from order_event
      where order_id = o.id and action = 'no_entregado'
      order by seq desc limit 1) e on true
    where o.store_id = ${storeId} and o.test = false and ${missedSql("o")}
    order by o.deliver_on nulls first, o.number`)
  return [...rows].map((o) => ({
    kind: "no_entregado",
    when: "ahora",
    orderId: o.id,
    number: pad(o.number),
    customer: o.customer_name,
    reason: o.reason ?? "",
    missedAt: new Date(o.missed_at),
    deliverOn: o.deliver_on,
  }))
}

async function toRestock(tx: Db, storeId: string): Promise<ToDoItem[]> {
  const rows = await tx
    .select({
      productId: product.id,
      productName: product.name,
      values: productVariant.optionValues,
      people: count(stockRequest.id),
    })
    .from(stockRequest)
    .innerJoin(productVariant, eq(productVariant.id, stockRequest.variantId))
    .innerJoin(product, eq(product.id, productVariant.productId))
    .innerJoin(conversation, eq(conversation.id, stockRequest.conversationId))
    .where(
      and(
        eq(stockRequest.storeId, storeId),
        isNull(stockRequest.notifiedAt),
        eq(productVariant.stock, 0),
        isNull(productVariant.removedAt),
        ne(conversation.channel, "prueba"),
      ),
    )
    .groupBy(productVariant.id, product.id, product.name, productVariant.optionValues)
    .orderBy(asc(product.name))
  return rows.map((r) => ({
    kind: "reponer",
    when: "sin_apuro",
    productId: r.productId,
    product: r.productName,
    variant: r.values.join(" · "),
    people: Number(r.people),
  }))
}

async function waitingChats(tx: Db, storeId: string): Promise<WaitingElsewhere["chats"]> {
  const rows = await tx
    .select({
      conversationId: conversation.id,
      customer: conversation.customerName,
      reason: conversation.waitingReason,
      at: conversation.updatedAt,
    })
    .from(conversation)
    .where(
      and(
        eq(conversation.storeId, storeId),
        eq(conversation.handler, "persona"),
        ne(conversation.channel, "prueba"),
      ),
    )
    .orderBy(asc(conversation.updatedAt))
  return rows
}

/** «Te toca»: lo que puede resolver quien lo ve, en el orden de ahora, hoy y sin apuro. */
export async function toDoIn(tx: Db, storeId: string, seat: StoreSeat): Promise<ToDoItem[]> {
  const items: ToDoItem[] = []
  if (can(seat, "pagos.confirmar")) items.push(...(await paymentsToConfirm(tx, storeId)))
  if (can(seat, "entregas")) items.push(...(await missedOrders(tx, storeId)))
  if (can(seat, "ventas.atender")) {
    const similar = await similarIn(tx, storeId)
    if (similar.first)
      items.push({ kind: "misma", when: "hoy", ...similar.first, more: similar.count - 1 })
    for (const o of await paidWithoutStockIn(tx, storeId))
      items.push({ kind: "stock", when: "hoy", ...o })
  }
  if (can(seat, "configuracion")) items.push(...(await toRestock(tx, storeId)))
  return items
}

/** Lo que sale hoy: lo de su día hasta hoy, sin lo que volvió sin entregar, que se cuenta aparte. */
async function leavesTodayIn(tx: Db, storeId: string, today: string) {
  const [row] = await tx
    .select({
      orders: sql<number>`count(*) filter (where not ${missedSql("sale_order")})`,
      missed: sql<number>`count(*) filter (where ${missedSql("sale_order")})`,
    })
    .from(saleOrder)
    .where(
      and(
        eq(saleOrder.storeId, storeId),
        eq(saleOrder.test, false),
        inArray(saleOrder.state, TO_DELIVER),
        lte(saleOrder.deliverOn, today),
      ),
    )
  return { orders: Number(row?.orders ?? 0), missed: Number(row?.missed ?? 0) }
}

/** Inicio de la tienda para quien lo abre. */
export async function storeHome(appDb: Db, person: Person, storeId: string, now = new Date()) {
  return inStore(appDb, person, storeId, "ventas.atender", async (tx, seat) => {
    const { timeZone, today } = await storeClockIn(tx, storeId, now)
    const totals = can(seat, "reportes.ver")
    const collected = totals
      ? await collectedSinceIn(tx, storeId, startOfDay(timeZone, today))
      : null
    const pending = await pendingNowIn(tx, storeId, now)
    const waiting: WaitingElsewhere = { chats: await waitingChats(tx, storeId) }
    return {
      /** El día de hoy en la tienda: con él se dice «hoy», «mañana» o «ayer». */
      today,
      figures: {
        /** Cobrado hoy: solo con los totales del día. */
        collected: collected ? { cents: collected.cents, payments: collected.payments } : null,
        /** Por confirmar: cuántos pagos; el monto, solo con los totales del día. */
        toConfirm: {
          payments: pending.toConfirm.payments,
          cents: totals ? pending.toConfirm.cents : null,
        },
        /** Falta cobrar, sin lo que está por confirmar: solo con los totales del día. */
        due: totals ? pending.due : null,
        leaves: await leavesTodayIn(tx, storeId, today),
      },
      toDo: await toDoIn(tx, storeId, seat),
      waiting,
      setup: can(seat, "configuracion") ? await setupIn(tx, storeId, now) : null,
    }
  })
}

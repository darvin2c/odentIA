import {
  conversation,
  conversationMessage,
  type Db,
  type FollowUp,
  orderEvent,
  orderPayment,
  product,
  productVariant,
  saleOrder,
  stockRequest,
  store,
  storeAgent,
} from "@gestoria/db"
import {
  and,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  sql,
} from "drizzle-orm"
import { agentStopIn } from "../acuerdo.js"
import { ARGOS_ACTOR, withAgent } from "../agente.js"
import type { Person } from "../cuenta.js"
import { storeClockIn } from "../hora.js"
import { pad, stockShortSql, variantPrices } from "../pedidos.js"
import { autoUnitCents } from "../precio.js"
import { inStore } from "../tiendas.js"
import { moneyText as formatMoney } from "./herramientas.js"

/**
 * Argos, el administrador de la tienda (paso B5, tablero 13): vigila los pedidos y las
 * conversaciones. Lo de rutina se lo encarga a Sofi y sale solo; lo delicado se lo trae al
 * equipo («Te toca»). Como en las clínicas, las cifras salen de cálculos fijos: el modelo no
 * escribe ninguna.
 *
 * Los seguimientos (decisión 5) son uno por cliente y por motivo, nunca masivos: recordar un
 * pago, agradecer y preguntar si llegó, avisar que volvió una talla e invitar a volver. Cada uno
 * se escribe una sola vez (índice único) y se apaga aparte. Hoy quedan escritos en la
 * conversación sin enviarse (B2 los enviará); pasadas 24 horas del último mensaje del cliente,
 * se marcan para salir con plantilla aprobada.
 */

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** Cuándo recuerda un pago: a las 3 horas de anotado el pedido, si el precio sigue vigente. */
export const PAYMENT_REMINDER_MS = 3 * HOUR
/** Cuándo agradece: al día siguiente de entregado (desde 20 horas), hasta una semana. */
export const THANKS_AFTER_MS = 20 * HOUR
const THANKS_UNTIL_MS = 7 * DAY
/** Cuándo invita a volver: 60 días después de su última compra entregada. */
export const RETURN_AFTER_MS = 60 * DAY
/** Pasadas 24 horas del último mensaje del cliente, solo sale una plantilla aprobada (Meta). */
export const SERVICE_WINDOW_MS = 24 * HOUR

const firstName = (name: string | null) => (name ? `, ${name.trim().split(/\s+/)[0]}` : "")

interface Due {
  conversationId: string
  kind: FollowUp
  ref: string
  text: string
  lastCustomerAt: Date | null
}

async function dueIn(tx: Db, storeId: string, now: Date) {
  const [agent] = await tx.select().from(storeAgent).where(eq(storeAgent.storeId, storeId))
  // Apagada, o detenida por la administración (no puede seguir, sin saldo o en su tope): nada.
  if (!agent?.enabled || (await agentStopIn(tx, storeId))) return []
  const [shop] = await tx
    .select({ name: store.name, currency: store.currency })
    .from(store)
    .where(eq(store.id, storeId))
  const money = (cents: number) => formatMoney(cents, shop!.currency)
  const due: Due[] = []
  // Solo conversaciones de verdad que atiende Sofi: si una persona la tomó, Sofi no escribe.
  const open = and(
    eq(conversation.storeId, storeId),
    ne(conversation.channel, "prueba"),
    eq(conversation.handler, "sofi"),
  )
  const orderConv = () =>
    tx
      .select({
        order: saleOrder,
        conv: {
          id: conversation.id,
          name: conversation.customerName,
          lastCustomerAt: conversation.lastCustomerAt,
        },
      })
      .from(saleOrder)
      .innerJoin(conversation, eq(conversation.id, saleOrder.conversationId))

  if (agent.followPayment) {
    const rows = await orderConv().where(
      and(
        open,
        eq(saleOrder.state, "por_pagar"),
        eq(saleOrder.test, false),
        lte(saleOrder.createdAt, new Date(now.getTime() - PAYMENT_REMINDER_MS)),
        sql`(${saleOrder.priceExpiresAt} is null or ${saleOrder.priceExpiresAt} > ${now.toISOString()})`,
      ),
    )
    for (const { order, conv } of rows)
      due.push({
        conversationId: conv.id,
        kind: "pago",
        ref: order.id,
        text: `Hola${firstName(order.customerName)}. Tu pedido ${pad(order.number)} por ${money(order.totalCents)} está listo para pagar.${order.priceExpiresAt ? " El precio que acordamos vale 24 horas desde que lo anotamos." : ""} ¿Te ayudo a terminar?`,
        lastCustomerAt: conv.lastCustomerAt,
      })
  }

  if (agent.followThanks) {
    const rows = await orderConv()
      .innerJoin(
        orderEvent,
        and(eq(orderEvent.orderId, saleOrder.id), eq(orderEvent.action, "entregado")),
      )
      .where(
        and(
          open,
          eq(saleOrder.state, "entregado"),
          eq(saleOrder.test, false),
          lte(orderEvent.createdAt, new Date(now.getTime() - THANKS_AFTER_MS)),
          gte(orderEvent.createdAt, new Date(now.getTime() - THANKS_UNTIL_MS)),
        ),
      )
    for (const { order, conv } of rows)
      due.push({
        conversationId: conv.id,
        kind: "gracias",
        ref: order.id,
        text: `Gracias por tu compra${firstName(order.customerName ?? conv.name)}. ¿Te llegó bien?`,
        lastCustomerAt: conv.lastCustomerAt,
      })
  }

  if (agent.followRestock) {
    const rows = await tx
      .select({
        request: stockRequest,
        conv: {
          id: conversation.id,
          name: conversation.customerName,
          lastCustomerAt: conversation.lastCustomerAt,
        },
        variant: productVariant,
        product: product,
      })
      .from(stockRequest)
      .innerJoin(conversation, eq(conversation.id, stockRequest.conversationId))
      .innerJoin(productVariant, eq(productVariant.id, stockRequest.variantId))
      .innerJoin(product, eq(product.id, productVariant.productId))
      .where(
        and(
          open,
          isNull(stockRequest.notifiedAt),
          gt(productVariant.stock, 0),
          isNull(productVariant.removedAt),
        ),
      )
    // El precio de hoy, con la misma regla que el resto (promoción incluida).
    const prices = rows.length
      ? await variantPrices(
          tx,
          storeId,
          // El día de la tienda, con su hora: la promoción vale de un día a otro de su calendario.
          (await storeClockIn(tx, storeId, now)).today,
          rows.map((r) => r.variant.id),
        )
      : []
    const priceOf = new Map(prices.map((v) => [v.id, autoUnitCents(v.pricing, 1)]))
    for (const row of rows) {
      const price = priceOf.get(row.variant.id)
      const variant = row.variant.optionValues.join(" · ")
      due.push({
        conversationId: row.conv.id,
        kind: "volvio",
        ref: row.request.id,
        text: `Hola${firstName(row.conv.name)}. ¡Volvió ${row.product.name}${variant ? ` en ${variant}` : ""}!${price ? ` Cuesta ${money(price)}.` : ""} ¿Te lo anoto?`,
        lastCustomerAt: row.conv.lastCustomerAt,
      })
    }
  }

  if (agent.followReturn) {
    // Su última compra entregada, sin otra después: una invitación por compra.
    const rows = await tx.execute<{
      conversation_id: string
      order_id: string
      customer_name: string
      last_customer_at: Date | null
    }>(sql`
      select distinct on (o.conversation_id) o.conversation_id, o.id as order_id,
        o.customer_name, c.last_customer_at
      from sale_order o
      join conversation c on c.id = o.conversation_id
      where o.store_id = ${storeId} and o.test = false and o.state <> 'anulado'
        and c.channel <> 'prueba' and c.handler = 'sofi'
      order by o.conversation_id, o.created_at desc`)
    const lastOrders = [...rows]
    const ids = lastOrders.map((r) => r.order_id)
    const delivered = ids.length
      ? await tx
          .select({ orderId: orderEvent.orderId, at: orderEvent.createdAt })
          .from(orderEvent)
          .where(and(inArray(orderEvent.orderId, ids), eq(orderEvent.action, "entregado")))
      : []
    const deliveredAt = new Map(delivered.map((d) => [d.orderId, d.at]))
    for (const row of lastOrders) {
      const at = deliveredAt.get(row.order_id)
      if (!at || now.getTime() - at.getTime() < RETURN_AFTER_MS) continue
      due.push({
        conversationId: row.conversation_id,
        kind: "volver",
        ref: row.order_id,
        text: `Hola${firstName(row.customer_name)}. Hace un tiempo que no te vemos por ${shop!.name}. ¿Te muestro lo nuevo?`,
        lastCustomerAt: row.last_customer_at ? new Date(row.last_customer_at) : null,
      })
    }
  }
  return due
}

export interface ArgosRun {
  stores: number
  written: number
}

/**
 * Una vuelta de Argos por todas las tiendas con Sofi encendida. El dueño de la base solo dice
 * qué tiendas mirar; lo de cada una se hace con las reglas de la tienda (`agente:argos`).
 */
export async function runArgos(ownerDb: Db, appDb: Db, now = new Date()): Promise<ArgosRun> {
  const stores = await ownerDb
    .select({ storeId: storeAgent.storeId })
    .from(storeAgent)
    .where(eq(storeAgent.enabled, true))
  let written = 0
  for (const { storeId } of stores) {
    written += await withAgent(appDb, ARGOS_ACTOR, storeId, async (tx) => {
      let n = 0
      for (const item of await dueIn(tx, storeId, now)) {
        const inserted = await tx
          .insert(conversationMessage)
          .values({
            storeId,
            conversationId: item.conversationId,
            author: "sofi",
            text: item.text,
            delivery: "sin_enviar",
            needsTemplate:
              !item.lastCustomerAt ||
              now.getTime() - new Date(item.lastCustomerAt).getTime() > SERVICE_WINDOW_MS,
            followUp: item.kind,
            followUpRef: item.ref,
            detail: { encargo: "argos" },
            actorUserId: ARGOS_ACTOR,
          })
          // Ya escrito (otra vuelta de Argos): el índice único lo deja una sola vez.
          .onConflictDoNothing()
          .returning({ id: conversationMessage.id })
        if (inserted.length === 0) continue
        n += 1
        if (item.kind === "volvio")
          await tx
            .update(stockRequest)
            .set({ notifiedAt: now })
            .where(eq(stockRequest.id, item.ref))
      }
      return n
    })
  }
  return { stores: stores.length, written }
}

/* ------------------------------------------------------------- lo que ve el equipo */

const FOLLOW_WORDS: Record<FollowUp, string> = {
  pago: "recordar el pago",
  gracias: "agradecer y preguntar si llegó",
  volvio: "avisar que volvió",
  volver: "invitar a volver",
}

/** «Te toca» y «Hecho» de Argos, y el resumen de la semana (tablero 13). */
export async function argosBoard(appDb: Db, person: Person, storeId: string, now = new Date()) {
  return inStore(appDb, person, storeId, "reportes.ver", async (tx) => {
    const [shop] = await tx
      .select({ currency: store.currency })
      .from(store)
      .where(eq(store.id, storeId))
    const money = (cents: number) => formatMoney(cents, shop!.currency)
    const toDo: {
      kind: string
      title: string
      detail: string
      orderId?: string
      conversationId?: string
      at?: Date
    }[] = []

    // Los pagos por captura (o por link que no coincidió) que esperan a una persona.
    const waiting = await tx
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
      .orderBy(orderPayment.createdAt)
    for (const p of waiting)
      toDo.push({
        kind: "pago",
        title: "Confirmar un pago",
        detail: `Pedido ${pad(p.number)} de ${p.customer}, ${money(p.amount)} ${p.kind === "link" ? "por el link (no coincide)" : `por ${p.method} (captura)`}`,
        orderId: p.orderId,
        at: p.at,
      })

    // Con su pago confirmado (todo o una parte) y sin poder salir: no alcanzaba el stock al pagar,
    // o al cambiarlo (lo que tiene fuera no es lo de sus líneas).
    const unpaidStock = await tx.execute<{ id: string; number: number; customer_name: string }>(sql`
      select o.id, o.number, o.customer_name from sale_order o
      where o.store_id = ${storeId} and o.state = 'por_salir' and o.test = false
        and o.payment_collection <> 'al_recibir'
        and ${stockShortSql("o")}`)
    for (const o of unpaidStock)
      toDo.push({
        kind: "stock_pedido",
        title: "Falta stock para un pedido con su pago confirmado",
        detail: `Pedido ${pad(o.number)} de ${o.customer_name}: registra la entrada para que salga`,
        orderId: o.id,
      })

    // Lo agotado que alguien pidió: cuando entre, Sofi les avisa sola.
    const asked = await tx
      .select({
        variantId: productVariant.id,
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
          ne(conversation.channel, "prueba"),
        ),
      )
      .groupBy(productVariant.id, product.id, product.name, productVariant.optionValues)
    for (const a of asked)
      toDo.push({
        kind: "reponer",
        title: `Reponer ${a.productName}${a.values.length ? ` ${a.values.join(" · ")}` : ""}`,
        detail: `Se acabó y ${a.people === 1 ? "1 persona la pidió" : `${a.people} personas la pidieron`}. Cuando registres la entrada, Sofi les avisa sola.`,
      })

    // Las conversaciones que esperan a una persona.
    const people = await tx
      .select({
        id: conversation.id,
        name: conversation.customerName,
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
      .orderBy(conversation.updatedAt)
    for (const c of people)
      toDo.push({
        kind: "conversacion",
        title: "Una conversación espera a una persona",
        detail: `${c.name ?? "Un cliente"}: ${c.reason ?? "Sofi la pasó"}`,
        conversationId: c.id,
        at: c.at,
      })

    // Lo que Argos le encargó a Sofi en la última semana.
    const since = new Date(now.getTime() - 7 * DAY)
    const followUps = await tx
      .select({
        kind: conversationMessage.followUp,
        text: conversationMessage.text,
        needsTemplate: conversationMessage.needsTemplate,
        at: conversationMessage.createdAt,
        customer: conversation.customerName,
      })
      .from(conversationMessage)
      .innerJoin(conversation, eq(conversation.id, conversationMessage.conversationId))
      .where(
        and(
          eq(conversationMessage.storeId, storeId),
          isNotNull(conversationMessage.followUp),
          gte(conversationMessage.createdAt, since),
        ),
      )
      .orderBy(desc(conversationMessage.createdAt))
    const byKind = Map.groupBy(followUps, (f) => f.kind as FollowUp)
    const done = [...byKind.entries()].map(([kind, list]) => ({
      kind,
      title: `Le pedí a Sofi ${list.length === 1 ? "1 mensaje" : `${list.length} mensajes`} para ${FOLLOW_WORDS[kind]}`,
      messages: list.map((m) => ({
        customer: m.customer,
        text: m.text,
        needsTemplate: m.needsTemplate,
        at: m.at,
      })),
    }))

    // La semana: lo cobrado frente a la anterior y lo que atendió Sofi.
    const weekAgo = new Date(now.getTime() - 7 * DAY)
    const twoWeeksAgo = new Date(now.getTime() - 14 * DAY)
    const collected = async (from: Date, to: Date) => {
      const [row] = await tx
        .select({ total: sql<number>`coalesce(sum(${orderPayment.amountCents}), 0)` })
        .from(orderPayment)
        .innerJoin(saleOrder, eq(saleOrder.id, orderPayment.orderId))
        .where(
          and(
            eq(orderPayment.storeId, storeId),
            eq(orderPayment.status, "confirmado"),
            eq(saleOrder.test, false),
            gte(orderPayment.reviewedAt, from),
            lte(orderPayment.reviewedAt, to),
          ),
        )
      return Number(row?.total ?? 0)
    }
    const thisWeek = await collected(weekAgo, now)
    const lastWeek = await collected(twoWeeksAgo, weekAgo)
    const [attended] = await tx
      .select({
        conversations: sql<number>`count(distinct ${conversationMessage.conversationId})`,
        passed: sql<number>`count(distinct ${conversationMessage.conversationId}) filter (where ${conversationMessage.detail} ? 'paso')`,
      })
      .from(conversationMessage)
      .innerJoin(conversation, eq(conversation.id, conversationMessage.conversationId))
      .where(
        and(
          eq(conversationMessage.storeId, storeId),
          eq(conversationMessage.author, "sofi"),
          isNull(conversationMessage.followUp),
          ne(conversation.channel, "prueba"),
          gte(conversationMessage.createdAt, weekAgo),
        ),
      )
    return {
      toDo,
      done,
      week: {
        collectedCents: thisWeek,
        previousCents: lastWeek,
        changePercent: lastWeek > 0 ? Math.round(((thisWeek - lastWeek) / lastWeek) * 100) : null,
        conversations: Number(attended?.conversations ?? 0),
        passedToPerson: Number(attended?.passed ?? 0),
      },
    }
  })
}

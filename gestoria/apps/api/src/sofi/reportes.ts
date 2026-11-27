import type { Db } from "@gestoria/db"
import { sql } from "drizzle-orm"
import { z } from "zod"
import { SOFI_ACTOR } from "../agente.js"
import { collectedBetween } from "../caja.js"
import type { Person } from "../cuenta.js"
import { addDays, startOfDay, storeClockIn, weekdayOf } from "../hora.js"
import { inStore } from "../tiendas.js"

/**
 * Reportes de la tienda (paso B5, tablero 13): cómo va, con cálculos fijos sobre los mismos
 * pedidos, pagos, kardex y conversaciones que usa todo lo demás. Solo Dueño y Administrador
 * (`reportes.ver`). Los pedidos de prueba no cuentan.
 *
 * Los periodos empiezan a las 00:00 de la tienda, con su hora (`hora.ts`): «hoy», desde el lunes
 * o desde el día 1. Lo que falta cobrar sale del saldo de cada pedido (`order_balance`, ADR 0222),
 * el mismo que ve el pedido.
 */

export const REPORT_PERIODS = ["hoy", "semana", "mes"] as const
export type ReportPeriod = (typeof REPORT_PERIODS)[number]
export const reportPeriod = z.enum(REPORT_PERIODS).default("mes")

const DAY = 86_400_000

/** Desde cuándo cuenta el periodo: hoy, desde el lunes o desde el día 1, a las 00:00 de la tienda. */
export function periodStart(period: ReportPeriod, today: string, timeZone: string): Date {
  if (period === "hoy") return startOfDay(timeZone, today)
  if (period === "mes") return startOfDay(timeZone, `${today.slice(0, 8)}01`)
  return startOfDay(timeZone, addDays(today, -weekdayOf(today)))
}

const n = (value: unknown) => Number(value ?? 0)

/**
 * Lo cobrado desde `since`: los pagos confirmados desde entonces, sin los pedidos de prueba. Es la
 * misma cuenta de Caja (`collectedBetween`) para «Vendido y cobrado» de Reportes y «Cobrado hoy»
 * de Inicio.
 */
export function collectedSinceIn(tx: Db, storeId: string, since: Date) {
  return collectedBetween(tx, storeId, since, null)
}

/**
 * Lo que falta cobrar y lo que espera a una persona ahora, del saldo de cada pedido
 * (`order_balance`): la misma cuenta en Reportes e Inicio. Un pedido por pagar con el precio
 * vencido ya no se cuenta: no se va a cobrar así. Los de prueba y los anulados, tampoco.
 */
export async function pendingNowIn(tx: Db, storeId: string, now = new Date()) {
  const [row] = await tx.execute<{
    to_confirm: string
    to_confirm_cents: string
    to_confirm_payments: string
    due: string
    due_cents: string
  }>(sql`
    select
      count(*) filter (where b.pending_cents > 0) as to_confirm,
      coalesce(sum(b.pending_cents), 0) as to_confirm_cents,
      coalesce(sum((select count(*) from order_payment p
        where p.order_id = b.order_id and p.status = 'por_confirmar')), 0) as to_confirm_payments,
      count(*) filter (where b.due_cents > 0) as due,
      coalesce(sum(b.due_cents), 0) as due_cents
    from order_balance b join sale_order o on o.id = b.order_id
    where o.store_id = ${storeId} and o.test = false and o.state <> 'anulado'
      and (o.state <> 'por_pagar' or o.price_expires_at is null
        or o.price_expires_at > ${now.toISOString()})`)
  return {
    /** Los pagos que esperan a una persona: no son «falta cobrar». */
    toConfirm: {
      orders: n(row?.to_confirm),
      cents: n(row?.to_confirm_cents),
      payments: n(row?.to_confirm_payments),
    },
    /** Falta cobrar = total − confirmado − por confirmar, pedido por pedido. */
    due: { orders: n(row?.due), cents: n(row?.due_cents) },
  }
}

export async function storeReport(
  appDb: Db,
  person: Person,
  storeId: string,
  period: ReportPeriod,
  now = new Date(),
) {
  return inStore(appDb, person, storeId, "reportes.ver", async (tx) => {
    const { timeZone, today } = await storeClockIn(tx, storeId, now)
    const from = periodStart(period, today, timeZone)
    // postgres.js no recibe fechas dentro de `sql`: van como texto ISO.
    const since = from.toISOString()
    const sold = await collectedSinceIn(tx, storeId, from)
    const pending = await pendingNowIn(tx, storeId, now)
    // Conversaciones del periodo y cuántas compraron; quienes volvieron a comprar (siempre).
    const [talks] = await tx.execute<{ total: string; bought: string }>(sql`
      select count(*) as total,
        count(*) filter (where exists (select 1 from sale_order o where o.conversation_id = c.id
          and o.state <> 'anulado')) as bought
      from conversation c
      where c.store_id = ${storeId} and c.channel <> 'prueba' and c.created_at >= ${since}`)
    const [again] = await tx.execute<{ customers: string }>(sql`
      select count(*) as customers from (
        select o.conversation_id from sale_order o
        where o.store_id = ${storeId} and o.test = false and o.state <> 'anulado'
          and o.conversation_id is not null
        group by o.conversation_id having count(*) >= 2) t`)
    // De dónde vienen las ventas (el anuncio de cada conversación llega con B2).
    const channels = await tx.execute<{ channel: string; orders: string; cents: string }>(sql`
      select o.channel, count(*) as orders, coalesce(sum(o.total_cents), 0) as cents
      from sale_order o
      where o.store_id = ${storeId} and o.test = false and o.state <> 'anulado'
        and o.created_at >= ${since}
      group by o.channel order by 3 desc`)
    // Lo más vendido (por el kardex) y lo que se acaba, con cuánto alcanza al ritmo del periodo.
    const products = await tx.execute<{
      product_id: string
      name: string
      sold: string
      stock: string
    }>(sql`
      select p.id as product_id, p.name,
        coalesce((select -sum(m.quantity) from stock_movement m
          join product_variant v2 on v2.id = m.variant_id
          where v2.product_id = p.id and m.kind = 'venta' and m.created_at >= ${since}), 0)
        - coalesce((select sum(m.quantity) from stock_movement m
          join product_variant v3 on v3.id = m.variant_id
          where v3.product_id = p.id and m.kind = 'anulacion' and m.created_at >= ${since}), 0) as sold,
        coalesce(sum(v.stock) filter (where v.removed_at is null), 0) as stock
      from product p left join product_variant v on v.product_id = p.id
      where p.store_id = ${storeId}
      group by p.id, p.name
      order by 3 desc, p.name
      limit 8`)
    const days = Math.max(1, Math.ceil((now.getTime() - from.getTime()) / DAY))
    // Sofi: conversaciones que atendió, las que pasó, lo que vendió, el margen y lo que costó.
    const [agent] = await tx.execute<{
      conversations: string
      passed: string
      cost: string
    }>(sql`
      select count(distinct m.conversation_id) as conversations,
        count(distinct m.conversation_id) filter (where m.detail ? 'paso') as passed,
        coalesce(sum((m.detail->>'costo')::bigint) filter (where jsonb_typeof(m.detail->'costo') = 'number'), 0) as cost
      from conversation_message m join conversation c on c.id = m.conversation_id
      where m.store_id = ${storeId} and m.author = 'sofi' and m.follow_up is null
        and c.channel <> 'prueba' and m.created_at >= ${since}`)
    const [bySofi] = await tx.execute<{
      orders: string
      cents: string
      margin: string
      used: string
    }>(sql`
      select count(*) as orders, coalesce(sum(o.total_cents), 0) as cents,
        coalesce(sum(o.margin_cents), 0) as margin, coalesce(sum(o.margin_used_cents), 0) as used
      from sale_order o
      where o.store_id = ${storeId} and o.test = false and o.state <> 'anulado'
        and o.created_by = ${SOFI_ACTOR} and o.created_at >= ${since}`)
    const soldOrders = sold.orders
    const conversations = n(agent?.conversations)
    return {
      period,
      from,
      sold: {
        cents: sold.cents,
        orders: soldOrders,
        ticketCents: soldOrders ? Math.round(sold.cents / soldOrders) : 0,
      },
      pending: {
        toConfirm: { orders: pending.toConfirm.orders, cents: pending.toConfirm.cents },
        due: pending.due,
      },
      conversations: { total: n(talks?.total), bought: n(talks?.bought) },
      returning: n(again?.customers),
      channels: [...channels].map((c) => ({
        channel: c.channel,
        orders: n(c.orders),
        cents: n(c.cents),
      })),
      products: [...products].map((p) => {
        const units = n(p.sold)
        const stock = n(p.stock)
        const perDay = units / days
        return {
          productId: p.product_id,
          name: p.name,
          sold: units,
          stock,
          /** Días que alcanza al ritmo del periodo; null si no se vendió. */
          daysLeft: perDay > 0 ? Math.floor(stock / perDay) : null,
        }
      }),
      agent: {
        conversations,
        passedToPerson: n(agent?.passed),
        orders: n(bySofi?.orders),
        cents: n(bySofi?.cents),
        marginCents: n(bySofi?.margin),
        marginUsedCents: n(bySofi?.used),
        costMicros: n(agent?.cost),
        costPerConversationMicros: conversations ? Math.round(n(agent?.cost) / conversations) : 0,
      },
    }
  })
}

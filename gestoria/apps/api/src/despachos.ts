import type { Db, DeliveryType, OrderState, PaymentCollection } from "@gestoria/db"
import { type SQL, sql } from "drizzle-orm"
import { z } from "zod"
import type { Person } from "./cuenta.js"
import { addDays, storeClockIn } from "./hora.js"
import { pad } from "./pedidos.js"
import { courierNamesIn, couriersIn, slotLabel, storeSlotsIn } from "./repartidores.js"
import { balancesIn, unpaidBalance } from "./saldo.js"
import { inStore } from "./tiendas.js"

/**
 * Despachos (entrega 3 del lienzo «gestorIA como odentIA», tablero 6): qué sale, cuándo y quién lo
 * lleva. Es una vista: lo que se hace con cada entrega son las operaciones del pedido
 * (`pedidos.ts`: «Salió», «Entregado», «No se entregó», «Pasar a…», «Cambiar repartidor»), las
 * mismas de Pedidos.
 *
 * - Los días son los de la tienda (`hora.ts`). Hoy trae también lo atrasado y lo que no tiene día:
 *   nada que todavía no salió se pierde de vista.
 * - «No se entregó» es lo que volvió sin entregar (su última novedad de entrega es esa), con su
 *   motivo; sale primero. Después, cada franja y «Sin franja».
 * - «Cobrar» es el saldo único del pedido (`order_balance`): lo mismo que dicen el pedido, Caja y
 *   Reportes. Los pedidos de prueba no salen: no cuentan en Caja ni en Reportes.
 */

export const dayQuery = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Elige un día")
  .optional()

/** Cuántos días muestra la franja de arriba: dos antes del elegido y cuatro después. */
const BEFORE = 2
const AFTER = 4

/**
 * Lo que todavía sale ese día: el suyo y, hoy, también lo atrasado y lo que no tiene día. «Sale
 * hoy» de Inicio cuenta con este mismo filtro lo que Despachos muestra hoy.
 */
export const dueOn = (day: SQL, today: string) => sql`(o.state in ('por_salir', 'en_camino') and (
  o.deliver_on = ${day}
  or (${day} = ${today}::date and (o.deliver_on < ${day} or o.deliver_on is null))))`

/** Pasó ese día, en la hora de la tienda (la novedad `action` de la historia del pedido). */
const happenedOn = (action: string, day: string, timeZone: string) => sql`exists (
  select 1 from order_event e where e.order_id = o.id and e.action = ${action}
    and (e.created_at at time zone ${timeZone})::date = ${day}::date)`

/**
 * Las entregas que salen en el tablero de un día: lo que todavía sale ese día, lo entregado ese día
 * y lo que ese día no se entregó (menos lo que después se anuló). Caja suma «Cobrar» con este mismo
 * filtro: las dos dicen lo mismo.
 */
export const onBoard = (storeId: string, day: string, today: string, timeZone: string) => sql`(
  o.store_id = ${storeId} and o.test = false and o.state <> 'anulado' and (
    ${dueOn(sql`${day}::date`, today)}
    or (o.state = 'entregado' and ${happenedOn("entregado", day, timeZone)})
    or ${happenedOn("no_entregado", day, timeZone)}))`

interface Row extends Record<string, unknown> {
  id: string
  number: number
  state: OrderState
  customer_name: string
  customer_phone: string | null
  address: string
  delivery_name: string
  delivery_type: DeliveryType
  delivery_zone: string | null
  deliver_on: string | null
  slot_start: number | null
  slot_end: number | null
  courier_id: string | null
  agency: string | null
  tracking: string | null
  total_cents: number
  payment_name: string
  payment_collection: PaymentCollection
  last_action: string | null
  missed_detail: Record<string, unknown> | null
  missed_at: string | null
  missed_day: string | null
}

export async function dispatchBoard(
  appDb: Db,
  person: Person,
  storeId: string,
  day?: string,
  now = new Date(),
) {
  return inStore(appDb, person, storeId, "entregas", async (tx) => {
    const { timeZone, today } = await storeClockIn(tx, storeId, now)
    const chosen = day ?? today
    const rows = (await tx.execute<Row>(sql`
      select o.id, o.number, o.state, o.customer_name, o.customer_phone, o.address,
        o.delivery_name, o.delivery_type, o.delivery_zone, o.deliver_on::text as deliver_on,
        o.slot_start, o.slot_end, o.courier_id, o.agency, o.tracking, o.total_cents,
        o.payment_name, o.payment_collection,
        last.action as last_action,
        missed.detail as missed_detail, missed.at as missed_at, missed.day as missed_day
      from sale_order o
      left join lateral (
        select e.action from order_event e
        where e.order_id = o.id and e.action in ('salio', 'no_entregado', 'entregado')
        order by e.seq desc limit 1) last on true
      left join lateral (
        select e.detail, to_json(e.created_at) #>> '{}' as at,
          (e.created_at at time zone ${timeZone})::date::text as day
        from order_event e
        where e.order_id = o.id and e.action = 'no_entregado'
        order by e.seq desc limit 1) missed on true
      where ${onBoard(storeId, chosen, today, timeZone)}
      order by o.slot_start nulls last, o.slot_end nulls last, o.number
      limit 300`)) as Row[]
    const balances = await balancesIn(
      tx,
      rows.map((row) => row.id),
    )
    const names = await courierNamesIn(tx, storeId)
    const from = addDays(chosen, -BEFORE)
    const days = (await tx.execute<{
      day: string
      pending: string
      delivered: string
      missed: string
    }>(sql`
      select d::date::text as day,
        (select count(*) from sale_order o
          where o.store_id = ${storeId} and o.test = false
            and ${dueOn(sql.raw("d::date"), today)}) as pending,
        (select count(distinct e.order_id) from order_event e join sale_order o on o.id = e.order_id
          where o.store_id = ${storeId} and o.test = false and o.state = 'entregado'
            and e.action = 'entregado' and (e.created_at at time zone ${timeZone})::date = d::date) as delivered,
        (select count(distinct e.order_id) from order_event e join sale_order o on o.id = e.order_id
          where o.store_id = ${storeId} and o.test = false and o.state <> 'anulado'
            and e.action = 'no_entregado' and (e.created_at at time zone ${timeZone})::date = d::date) as missed
      from generate_series(${from}::date, ${addDays(chosen, AFTER)}::date, interval '1 day') d
      order by d`)) as { day: string; pending: string; delivered: string; missed: string }[]
    return {
      /** Qué día es en la tienda y cuál se mira. */
      today,
      day: chosen,
      days: days.map((d) => ({
        day: d.day,
        pending: Number(d.pending),
        delivered: Number(d.delivered),
        missed: Number(d.missed),
      })),
      slots: (await storeSlotsIn(tx, storeId)).map((slot) => ({ ...slot, label: slotLabel(slot) })),
      couriers: await couriersIn(tx, storeId),
      deliveries: rows.map((row) => {
        const balance = balances.get(row.id) ?? unpaidBalance(row.total_cents)
        const slot =
          row.slot_start === null || row.slot_end === null
            ? null
            : { start: row.slot_start, end: row.slot_end }
        // Volvió sin entregar y no salió otra vez; o, mirando el día en que no se entregó, lo que pasó.
        const back = row.state === "por_salir" && row.last_action === "no_entregado"
        const missedThatDay = row.missed_day === chosen
        return {
          id: row.id,
          number: pad(row.number),
          state: row.state,
          customerName: row.customer_name,
          customerPhone: row.customer_phone,
          address: row.address,
          deliveryName: row.delivery_name,
          deliveryType: row.delivery_type,
          deliveryZone: row.delivery_zone,
          deliverOn: row.deliver_on,
          /** Salía otro día que ya pasó y todavía no se entrega. */
          late:
            row.deliver_on !== null &&
            row.deliver_on < today &&
            (row.state === "por_salir" || row.state === "en_camino"),
          slot: slot ? { ...slot, label: slotLabel(slot) } : null,
          courierId: row.courier_id,
          courierName: row.courier_id ? (names.get(row.courier_id) ?? null) : null,
          agency: row.agency,
          tracking: row.tracking,
          totalCents: row.total_cents,
          paymentName: row.payment_name,
          paymentCollection: row.payment_collection,
          /** El saldo único del pedido: «Cobrar» es lo que falta cobrar. */
          balance,
          /** «No se entregó»: su motivo y cuándo volvió, si sigue sin salir otra vez. */
          missed:
            (back || missedThatDay) && row.missed_detail
              ? {
                  reason: String(row.missed_detail.motivo ?? ""),
                  at: row.missed_at,
                  /** Ya volvió a salir o se entregó después. */
                  resolved: !back,
                }
              : null,
        }
      }),
    }
  })
}

/** Lo que el menú cuenta en Despachos: lo que volvió sin entregar y todavía no sale otra vez. */
export async function dispatchCount(appDb: Db, person: Person, storeId: string) {
  return inStore(appDb, person, storeId, "entregas", async (tx) => {
    const [row] = (await tx.execute<{ n: string }>(sql`
      select count(*) as n from sale_order o
      where o.store_id = ${storeId} and o.test = false and o.state = 'por_salir'
        and (select e.action from order_event e
          where e.order_id = o.id and e.action in ('salio', 'no_entregado', 'entregado')
          order by e.seq desc limit 1) = 'no_entregado'`)) as { n: string }[]
    return { missed: Number(row?.n ?? 0) }
  })
}

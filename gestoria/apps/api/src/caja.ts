import { accountCopy, cashHandover, cashHandoverPayment, type Db } from "@gestoria/db"
import { and, eq, sql } from "drizzle-orm"
import { z } from "zod"
import type { Person } from "./cuenta.js"
import { onBoard } from "./despachos.js"
import { formatMoney } from "./dinero.js"
import { addDays, startOfDay, storeClockIn } from "./hora.js"
import { pad } from "./pedidos.js"
import { courierNamesIn } from "./repartidores.js"
import { inStore, StoreError } from "./tiendas.js"

/**
 * Caja (entrega 3 del lienzo «gestorIA como odentIA», tableros 4, 6 y 23): la caja del día, sin
 * turnos ni cierres. Lo cobrado por medio, lo que falta cobrar en las entregas del día y el efectivo
 * que trae cada repartidor, que una persona de la tienda recibe con «Recibí». Solo Dueño y
 * Administrador (`caja`), como Reportes: son los totales de dinero de la tienda.
 *
 * Las cifras son las mismas de todo lo demás: lo cobrado es lo confirmado de cada pago (la misma
 * cuenta de Reportes, `collectedBetween`), lo que falta cobrar es el saldo único de cada pedido
 * (`order_balance`) y las entregas del día son las de Despachos. Los pedidos de prueba no cuentan.
 *
 * El efectivo cobrado en la puerta queda a nombre de quien llevaba el pedido (`courier_id` del
 * pago), no de quien tocó el botón; mientras nadie lo recibe, sigue por recibir, aunque sea de otro
 * día. Cada pago entra en un solo «Recibí» (la base lo cuida), con lo que cuadra o la diferencia
 * escrita.
 */

/** El efectivo: el tipo 10 de UN/CEFACT 4461, cobrado en la puerta. */
const CASH = sql`p.kind = 'al_recibir' and p.method_type = '10' and p.status = 'confirmado'`

/**
 * Lo cobrado entre dos momentos (sin `to`, hasta ahora): los pagos confirmados, por la hora en que
 * se confirmaron. Es la cifra de «Vendido y cobrado» de Reportes y de «Cobrado» de Caja.
 */
export async function collectedBetween(tx: Db, storeId: string, from: Date, to: Date | null) {
  // postgres.js no recibe fechas dentro de `sql`: van como texto ISO.
  const until = to ? sql`and p.reviewed_at < ${to.toISOString()}` : sql``
  const rows = await tx.execute<{
    method: string
    type: string
    cents: string
    orders: string
  }>(sql`
    select p.method_name as method, p.method_type as type,
      coalesce(sum(p.amount_cents), 0) as cents, count(distinct p.order_id) as orders
    from order_payment p join sale_order o on o.id = p.order_id
    where p.store_id = ${storeId} and p.status = 'confirmado' and o.test = false
      and p.reviewed_at >= ${from.toISOString()} ${until}
    group by p.method_name, p.method_type
    order by 3 desc, 1`)
  const byMethod = [...rows].map((row) => ({
    name: row.method,
    typeCode: row.type,
    cents: Number(row.cents),
    orders: Number(row.orders),
  }))
  const [all] = await tx.execute<{ orders: string }>(sql`
    select count(distinct p.order_id) as orders
    from order_payment p join sale_order o on o.id = p.order_id
    where p.store_id = ${storeId} and p.status = 'confirmado' and o.test = false
      and p.reviewed_at >= ${from.toISOString()} ${until}`)
  return {
    cents: byMethod.reduce((total, one) => total + one.cents, 0),
    orders: Number(all?.orders ?? 0),
    byMethod,
  }
}

export const cashDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Elige un día")
  .optional()

export async function cashBox(
  appDb: Db,
  person: Person,
  storeId: string,
  day?: string,
  now = new Date(),
) {
  return inStore(appDb, person, storeId, "caja", async (tx) => {
    const { timeZone, today } = await storeClockIn(tx, storeId, now)
    const chosen = day ?? today
    const from = startOfDay(timeZone, chosen)
    const to = startOfDay(timeZone, addDays(chosen, 1))
    const collected = await collectedBetween(tx, storeId, from, to)
    // Lo que falta cobrar en las entregas del día: las mismas filas de Despachos (`onBoard`), con
    // su saldo. Lo entregado ya no debe nada.
    const [due] = await tx.execute<{ orders: string; cents: string }>(sql`
      select count(*) filter (where b.due_cents > 0) as orders, coalesce(sum(b.due_cents), 0) as cents
      from sale_order o join order_balance b on b.order_id = o.id
      where ${onBoard(storeId, chosen, today, timeZone)} and o.state in ('por_salir', 'en_camino')`)
    // El efectivo que nadie recibió todavía, de cualquier día, por quien lo trae.
    const pending = await tx.execute<{
      id: string
      courier_id: string | null
      order_id: string
      number: number
      customer_name: string
      amount_cents: number
      at: string
    }>(sql`
      select p.id, p.courier_id, p.order_id, o.number, o.customer_name, p.amount_cents,
        to_json(p.reviewed_at) #>> '{}' as at
      from order_payment p join sale_order o on o.id = p.order_id
      where p.store_id = ${storeId} and o.test = false and ${CASH}
        and not exists (select 1 from cash_handover_payment h where h.payment_id = p.id)
      order by p.reviewed_at`)
    const names = await courierNamesIn(tx, storeId)
    const groups = Map.groupBy([...pending], (row) => row.courier_id ?? "")
    const received = await tx
      .select({
        id: cashHandover.id,
        courierId: cashHandover.courierId,
        expectedCents: cashHandover.expectedCents,
        receivedCents: cashHandover.receivedCents,
        note: cashHandover.note,
        receivedByName: accountCopy.name,
        receivedAt: cashHandover.receivedAt,
      })
      .from(cashHandover)
      .leftJoin(accountCopy, eq(accountCopy.userId, cashHandover.receivedBy))
      .where(
        and(
          eq(cashHandover.storeId, storeId),
          sql`${cashHandover.receivedAt} >= ${from.toISOString()} and ${cashHandover.receivedAt} < ${to.toISOString()}`,
        ),
      )
      .orderBy(cashHandover.receivedAt)
    return {
      today,
      day: chosen,
      /** Lo cobrado ese día, por medio (lo confirmado, como en Reportes). */
      collected,
      /** Lo que falta cobrar en las entregas de ese día (el saldo de cada pedido). */
      due: { orders: Number(due?.orders ?? 0), cents: Number(due?.cents ?? 0) },
      /** El efectivo por recibir, de quien lo trae; «En la tienda» es lo cobrado sin repartidor. */
      toReceive: [...groups.entries()].map(([courierId, rows]) => ({
        courierId: courierId || null,
        name: courierId ? (names.get(courierId) ?? "Repartidor") : null,
        cents: rows.reduce((total, row) => total + row.amount_cents, 0),
        payments: rows.map((row) => ({
          id: row.id,
          orderId: row.order_id,
          number: pad(row.number),
          customerName: row.customer_name,
          amountCents: row.amount_cents,
          at: row.at,
        })),
      })),
      /** Lo recibido ese día, con lo que cuadró o la diferencia anotada. */
      received: received.map((row) => ({
        ...row,
        courierName: row.courierId ? (names.get(row.courierId) ?? "Repartidor") : null,
        differenceCents: row.receivedCents - row.expectedCents,
      })),
    }
  })
}

const cents = z.number().int("Escribe un monto válido").min(0).max(100_000_000)

/**
 * «Recibí»: los pagos en efectivo que se ven en Caja (los que mostró la pantalla, para no recibir
 * lo que no se vio), lo que se recibió y, si no cuadra, por qué.
 */
export const receiveInput = z.object({
  courierId: z.uuid().nullable(),
  paymentIds: z.array(z.uuid()).min(1, "No hay efectivo por recibir").max(300),
  receivedCents: cents,
  note: z
    .string()
    .trim()
    .max(300, "Máximo 300 caracteres")
    .default("")
    .transform((value) => value || null),
})

export async function receiveCash(
  appDb: Db,
  person: Person,
  storeId: string,
  input: z.infer<typeof receiveInput>,
) {
  return inStore(appDb, person, storeId, "caja", async (tx) => {
    const ids = [...new Set(input.paymentIds)]
    // Se bloquean sus pedidos, no los pagos: la regla de la base solo deja tocar (y bloquear) un
    // pago que espera revisión, y estos ya están confirmados. Si dos personas reciben el mismo
    // efectivo a la vez, la clave de `cash_handover_payment` deja pasar a una (409 a la otra).
    const rows = await tx.execute<{
      id: string
      courier_id: string | null
      amount_cents: number
      taken: boolean
    }>(sql`
      select p.id, p.courier_id, p.amount_cents,
        exists (select 1 from cash_handover_payment h where h.payment_id = p.id) as taken
      from order_payment p join sale_order o on o.id = p.order_id
      where p.store_id = ${storeId} and o.test = false and ${CASH}
        and p.id in (${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
      for update of o`)
    const found = [...rows]
    if (
      found.length !== ids.length ||
      found.some((row) => row.taken || (row.courier_id ?? null) !== input.courierId)
    )
      throw new StoreError(409, "CASH_CHANGED", "Ese efectivo ya cambió. Recarga para verlo.")
    const expected = found.reduce((total, row) => total + row.amount_cents, 0)
    const { currency } = (
      await tx.execute<{ currency: string }>(sql`select currency from store where id = ${storeId}`)
    )[0] as { currency: string }
    if (input.receivedCents !== expected && !input.note)
      throw new StoreError(
        400,
        "VALIDATION_ERROR",
        `No cuadra: debía entregar ${formatMoney(expected, currency)}. Escribe qué pasó.`,
        { note: "Escribe por qué no cuadra" },
      )
    if (input.note && input.note.length < 3)
      throw new StoreError(400, "VALIDATION_ERROR", "Escribe por qué no cuadra", {
        note: "Escribe por qué no cuadra",
      })
    const [handover] = await tx
      .insert(cashHandover)
      .values({
        storeId,
        courierId: input.courierId,
        expectedCents: expected,
        receivedCents: input.receivedCents,
        note: input.receivedCents === expected ? null : input.note,
        receivedBy: person.userId,
      })
      .returning({ id: cashHandover.id })
    await tx
      .insert(cashHandoverPayment)
      .values(ids.map((paymentId) => ({ storeId, handoverId: handover!.id, paymentId })))
    return {
      handover: {
        id: handover!.id,
        expectedCents: expected,
        receivedCents: input.receivedCents,
        differenceCents: input.receivedCents - expected,
      },
    }
  })
}

import {
  accountCopy,
  type CustomerEventAction,
  customer,
  customerEvent,
  type Db,
  type OrderChannel,
  type OrderState,
  type PaymentCollection,
  saleOrder,
  saleOrderLine,
  store,
} from "@gestoria/db"
import { and, asc, count, desc, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm"
import { z } from "zod"
import type { Person } from "./cuenta.js"
import { balancesIn, unpaidBalance } from "./saldo.js"
import { inStore, StoreError } from "./tiendas.js"

/**
 * Las clientas de una tienda (entrega 4 de «gestorIA como odentIA», tablero 8; ADR 0223): la
 * ficha de cada una con sus compras, «¿Es la misma clienta?» con separar y «Repetir pedido».
 *
 * - La clienta es la persona: un pedido anotado o armado por Sofi se suma a su ficha
 *   (`customerForOrderIn`, que usa `createOrderIn`) y nunca se abre otra a sabiendas.
 * - Que dos fichas sean la misma lo dice una persona del equipo. El nombre o el teléfono iguales
 *   solo lo sugieren (`similarPairs`); la sugerencia no frena ninguna venta.
 * - Unir deja la ficha más nueva dentro de la más antigua, sin mover ni borrar nada; «Separar» la
 *   deja sola otra vez. Lo que decidió cada persona queda en la historia de la ficha.
 * - Al estrenar Clientes, los pedidos de antes no tienen ficha: no se unen solos por el teléfono.
 *
 * Lo ve y lo decide todo el equipo que atiende (`ventas.atender`): Dueño, Administrador y Ventas.
 * Lo que debe cada clienta es la suma del saldo único de sus pedidos (`order_balance`, entrega 1):
 * aquí no se recalcula.
 */

/** Hasta cuántas fichas lista la pantalla de una vez; con más, se busca. */
export const MAX_LISTED = 100
/** Hasta cuántas sugerencias de «¿Es la misma clienta?» se ofrecen de una vez. */
export const MAX_SIMILAR = 20

const orderNumber = (number: number) => String(number).padStart(4, "0")

function uuidOr404(id: string) {
  if (!z.uuid().safeParse(id).success)
    throw new StoreError(404, "NOT_FOUND", "Esa clienta ya no está")
}

const phone = z
  .string()
  .trim()
  .max(30, "Máximo 30 caracteres")
  .regex(/^[+\d\s()-]*$/, "Escribe solo el número")
  .transform((value) => value || null)

export const customerPatch = z.object({
  name: z.string().trim().min(1, "Escribe su nombre").max(120, "Máximo 120 caracteres").optional(),
  phone: phone.optional(),
  note: z.string().trim().max(1000, "Máximo 1000 caracteres").optional(),
})

export const pairInput = z.object({
  a: z.uuid("Elige las dos fichas"),
  b: z.uuid("Elige las dos fichas"),
})

/* ------------------------------------------------------------- sugerir, nunca unir solo */

/** La clave de un nombre para sugerir: sin mayúsculas, sin tildes y sin espacios de más. */
export function nameKey(name: string): string {
  return name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim()
}

/**
 * La clave de un teléfono para sugerir: sus últimos 8 dígitos, que son los mismos con o sin el
 * código del país («+51 987 654 321» y «987654321»). Con menos de 8, no sugiere nada.
 */
export function phoneKey(digits: string | null): string | null {
  return digits && digits.length >= 8 ? digits.slice(-8) : null
}

export interface MemberRow {
  id: string
  /** La ficha a la que pertenece: ella misma si está sola. */
  root: string
  name: string
  phoneDigits: string | null
  createdAt: Date
}

export interface SimilarPair {
  /** La ficha más antigua: si son la misma, la otra queda dentro de ella. */
  a: string
  b: string
  reason: "telefono" | "nombre"
}

const pairKey = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`)

/** Cuántas parejas arma, como mucho, un mismo nombre o teléfono (un nombre muy común). */
const PAIRS_PER_KEY = 10

/**
 * Las fichas que podrían ser la misma clienta: el mismo teléfono (primero) o el mismo nombre,
 * en fichas distintas, sin contar lo que una persona ya contestó (que son distintas, o que las
 * separó). Las más nuevas primero: la que acaba de llegar es la que conviene mirar. Con
 * `involving`, solo las de esa ficha (antes del tope).
 */
export function similarPairs(
  members: MemberRow[],
  decided: { a: string; b: string }[],
  limit = MAX_SIMILAR,
  involving?: string,
): SimilarPair[] {
  const rootOf = new Map(members.map((m) => [m.id, m.root]))
  const born = new Map(members.filter((m) => m.id === m.root).map((m) => [m.id, m.createdAt]))
  const answered = new Set<string>()
  for (const d of decided) {
    const ra = rootOf.get(d.a)
    const rb = rootOf.get(d.b)
    if (ra && rb && ra !== rb) answered.add(pairKey(ra, rb))
  }
  const groups = new Map<string, Set<string>>()
  const add = (key: string, root: string) => {
    const roots = groups.get(key) ?? new Set<string>()
    roots.add(root)
    groups.set(key, roots)
  }
  for (const m of members) {
    const phone = phoneKey(m.phoneDigits)
    if (phone) add(`telefono:${phone}`, m.root)
    const name = nameKey(m.name)
    if (name) add(`nombre:${name}`, m.root)
  }
  const pairs = new Map<string, SimilarPair>()
  // El teléfono primero: si coinciden las dos cosas, se dice por el teléfono.
  const keys = [...groups.keys()].sort((x, y) =>
    x.startsWith("telefono:") === y.startsWith("telefono:")
      ? 0
      : x.startsWith("telefono:")
        ? -1
        : 1,
  )
  const age = (id: string) => born.get(id)?.getTime() ?? 0
  for (const key of keys) {
    // La más nueva primero, frente a cada una de las anteriores: la que acaba de llegar no queda
    // fuera por un nombre muy común, y lo ya contestado no ocupa lugar.
    const roots = [...(groups.get(key) ?? [])].sort((x, y) => age(y) - age(x) || (x < y ? 1 : -1))
    let made = 0
    pairing: for (const [i, newer] of roots.entries())
      for (const older of roots.slice(i + 1)) {
        if (involving && newer !== involving && older !== involving) continue
        const id = pairKey(newer, older)
        if (answered.has(id) || pairs.has(id)) continue
        pairs.set(id, {
          a: older,
          b: newer,
          reason: key.startsWith("telefono:") ? "telefono" : "nombre",
        })
        if (++made >= PAIRS_PER_KEY) break pairing
      }
  }
  return [...pairs.values()].sort((x, y) => age(y.b) - age(x.b)).slice(0, limit)
}

async function membersOf(tx: Db, storeId: string): Promise<MemberRow[]> {
  const rows = await tx
    .select({
      id: customer.id,
      name: customer.name,
      phoneDigits: customer.phoneDigits,
      mergedInto: customer.mergedInto,
      createdAt: customer.createdAt,
    })
    .from(customer)
    .where(eq(customer.storeId, storeId))
  return rows.map(({ mergedInto, ...row }) => ({ ...row, root: mergedInto ?? row.id }))
}

/** Lo que una persona ya contestó: que son distintas, o que las separó. */
async function answeredPairs(tx: Db, storeId: string) {
  const rows = await tx
    .select({ a: customerEvent.customerId, b: customerEvent.otherId })
    .from(customerEvent)
    .where(
      and(
        eq(customerEvent.storeId, storeId),
        inArray(customerEvent.action, ["distintas", "separada"] satisfies CustomerEventAction[]),
      ),
    )
  return rows
}

/* ------------------------------------------------------------------------ las fichas */

type CustomerRow = typeof customer.$inferSelect

/** La ficha y aquella dentro de la que está (la que se ve), o 404. */
async function rootRow(tx: Db, storeId: string, id: string): Promise<CustomerRow> {
  const [row] = await tx
    .select()
    .from(customer)
    .where(and(eq(customer.id, id), eq(customer.storeId, storeId)))
  if (!row) throw new StoreError(404, "NOT_FOUND", "Esa clienta ya no está")
  if (!row.mergedInto) return row
  const [root] = await tx.select().from(customer).where(eq(customer.id, row.mergedInto))
  return root ?? row
}

/** Unir, separar o decir que son distintas: de a una por tienda, para que no se crucen. */
async function lockCustomers(tx: Db, storeId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`clientes:${storeId}`}))`)
}

export interface CustomerSummary {
  id: string
  name: string
  /** Sus teléfonos, el de la ficha primero y después los de las que están dentro. */
  phones: string[]
  /** Por dónde compró (sin «otro»). */
  channels: OrderChannel[]
  /** Las compras que cuentan: sin las anuladas ni las de prueba. */
  purchases: number
  lastPurchaseAt: Date | null
  /** La zona de su última compra, para reconocerla en la lista. */
  lastZone: string | null
  /** «0098 · Zapatilla urbana · blanca 38»: su última compra. */
  lastOrder: { number: string; createdAt: Date; text: string } | null
  lastAddress: string | null
  since: Date
  /**
   * Lo que debe: la suma de lo que falta cobrar de cada compra, tal como lo dice el saldo único
   * (`order_balance`). Aquí solo se suma, nunca se recalcula.
   */
  dueCents: number
  /** Todo lo que debe se cobra al entregar (contra entrega). */
  dueOnDelivery: boolean
}

// Las letras con tilde, también en mayúscula: `lower` de la base no siempre las baja.
const ACCENTS_FROM = "áàäâãéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ"
const ACCENTS_TO = "aaaaaeeeeiiiiooooouuuuncaaaaaeeeeiiiiooooouuuunc"

/**
 * Cada ficha con lo que la reconoce: la que se ve y las que están dentro de ella, juntas. Con
 * `roots`, solo esas; con `search`, las que coinciden por nombre o por teléfono.
 */
async function summariesOf(
  tx: Db,
  storeId: string,
  filter: { roots?: string[]; search?: string; limit?: number } = {},
): Promise<CustomerSummary[]> {
  if (filter.roots && filter.roots.length === 0) return []
  // Lo escrito se busca tal cual: «%» o «_» no son comodines.
  const text = filter.search ? nameKey(filter.search).replace(/[\\%_]/g, (c) => `\\${c}`) : ""
  // Un teléfono con su código de país encuentra el guardado sin él, y al revés (los últimos 8).
  const typed = filter.search ? filter.search.replace(/\D/g, "") : ""
  const digits = phoneKey(typed) ?? typed
  const rows = await tx.execute<{
    id: string
    name: string
    phones: string[] | null
    channels: OrderChannel[] | null
    purchases: number | string
    last_at: Date | string | null
    last_zone: string | null
    last_order: string | null
    last_address: string | null
    since: Date | string
    due_cents: number | string | null
    due_on_delivery: boolean | null
  }>(sql`
    with groups as (
      select coalesce(c.merged_into, c.id) as root, c.id, c.name, c.phone, c.phone_digits,
        c.created_at
      from customer c
      where c.store_id = ${storeId}
    ),
    found as (
      select g.root from groups g
      ${
        filter.roots
          ? sql`where g.root in (${sql.join(
              filter.roots.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})`
          : sql``
      }
      group by g.root
      ${
        text || digits.length >= 3
          ? sql`having bool_or(
              ${text ? sql`translate(lower(regexp_replace(btrim(g.name), '[[:space:]]+', ' ', 'g')), ${ACCENTS_FROM}, ${ACCENTS_TO}) like ${`%${text}%`}` : sql`false`}
              or ${digits.length >= 3 ? sql`coalesce(g.phone_digits, '') like ${`%${digits}%`}` : sql`false`})`
          : sql``
      }
    )
    select r.id, r.name,
      (select array_agg(g.phone order by (g.id = r.id) desc, g.created_at)
        from groups g where g.root = r.id and g.phone is not null) as phones,
      (select array_agg(distinct o.channel) from sale_order o join groups g on g.id = o.customer_id
        where g.root = r.id and o.test = false and o.state <> 'anulado'
          and o.channel <> 'otro') as channels,
      (select count(*) from sale_order o join groups g on g.id = o.customer_id
        where g.root = r.id and o.test = false and o.state <> 'anulado') as purchases,
      last.created_at as last_at, last.delivery_zone as last_zone, last.id as last_order,
      nullif(last.address, '') as last_address,
      (select min(g.created_at) from groups g where g.root = r.id) as since,
      -- Lo que debe sale del saldo único de cada pedido (anulado, 0); aquí solo se suma.
      (select coalesce(sum(b.due_cents), 0) from sale_order o
        join groups g on g.id = o.customer_id
        join order_balance b on b.order_id = o.id
        where g.root = r.id and o.test = false) as due_cents,
      (select bool_and(o.payment_collection = 'al_recibir') from sale_order o
        join groups g on g.id = o.customer_id
        join order_balance b on b.order_id = o.id
        where g.root = r.id and o.test = false and b.due_cents > 0) as due_on_delivery
    from found f
    join customer r on r.id = f.root
    left join lateral (
      select o.id, o.created_at, o.delivery_zone, o.address from sale_order o
      join groups g on g.id = o.customer_id
      where g.root = r.id and o.test = false and o.state <> 'anulado'
      order by o.created_at desc limit 1
    ) last on true
    order by last.created_at desc nulls last, r.created_at desc
    limit ${filter.limit ?? MAX_LISTED}`)
  const list = [...rows]
  const lastIds = list.map((row) => row.last_order).filter((id): id is string => Boolean(id))
  const lastOrders = lastIds.length
    ? await tx
        .select({
          id: saleOrder.id,
          number: saleOrder.number,
          createdAt: saleOrder.createdAt,
          productName: saleOrderLine.productName,
          variantName: saleOrderLine.variantName,
          quantity: saleOrderLine.quantity,
        })
        .from(saleOrder)
        .innerJoin(saleOrderLine, eq(saleOrderLine.orderId, saleOrder.id))
        .where(and(inArray(saleOrder.id, lastIds), eq(saleOrderLine.position, 0)))
    : []
  const lastBy = new Map(lastOrders.map((o) => [o.id, o]))
  return list.map((row) => {
    const last = row.last_order ? lastBy.get(row.last_order) : undefined
    return {
      id: row.id,
      name: row.name,
      phones: row.phones ?? [],
      channels: row.channels ?? [],
      purchases: Number(row.purchases),
      lastPurchaseAt: row.last_at ? new Date(row.last_at) : null,
      lastZone: row.last_zone,
      lastOrder: last
        ? {
            number: orderNumber(last.number),
            createdAt: last.createdAt,
            text: lineText(last),
          }
        : null,
      lastAddress: row.last_address,
      since: new Date(row.since),
      dueCents: Number(row.due_cents ?? 0),
      dueOnDelivery: Boolean(row.due_on_delivery),
    }
  })
}

function lineText(line: { productName: string; variantName: string; quantity: number }) {
  const variant = line.variantName === "Única" ? "" : ` · ${line.variantName}`
  return `${line.productName}${variant}${line.quantity > 1 ? ` × ${line.quantity}` : ""}`
}

/** Clientes: la lista, o lo que coincide con lo que se busca (nombre o teléfono). */
export async function listCustomers(appDb: Db, person: Person, storeId: string, search = "") {
  return inStore(appDb, person, storeId, "ventas.atender", async (tx) => {
    const query = search.trim().slice(0, 80)
    // Una de más, para saber si hay otras que no se ven.
    const found = await summariesOf(tx, storeId, {
      ...(query ? { search: query } : {}),
      limit: MAX_LISTED + 1,
    })
    // Sin buscar, también cuántas podrían ser la misma clienta (el aviso de la lista).
    const similar = query
      ? null
      : similarPairs(
          await membersOf(tx, storeId),
          await answeredPairs(tx, storeId),
          Number.POSITIVE_INFINITY,
        ).length
    return {
      customers: found.slice(0, MAX_LISTED),
      similar,
      limited: found.length > MAX_LISTED,
    }
  })
}

/**
 * «¿Es la misma clienta?»: las parejas por mirar, con lo que reconoce a cada una. Con
 * `involving`, solo las de esa ficha (desde su aviso).
 */
export async function similarCustomers(
  appDb: Db,
  person: Person,
  storeId: string,
  involving?: string,
) {
  if (involving) uuidOr404(involving)
  return inStore(appDb, person, storeId, "ventas.atender", async (tx) => {
    const members = await membersOf(tx, storeId)
    const root = involving ? members.find((m) => m.id === involving)?.root : undefined
    if (involving && !root) throw new StoreError(404, "NOT_FOUND", "Esa clienta ya no está")
    const pairs = similarPairs(members, await answeredPairs(tx, storeId), MAX_SIMILAR, root)
    const summaries = await summariesOf(tx, storeId, {
      roots: [...new Set(pairs.flatMap((p) => [p.a, p.b]))],
    })
    const byId = new Map(summaries.map((s) => [s.id, s]))
    return {
      pairs: pairs
        .filter((p) => byId.has(p.a) && byId.has(p.b))
        .map((p) => ({ reason: p.reason, a: byId.get(p.a)!, b: byId.get(p.b)! })),
    }
  })
}

/** Lo que dice la historia de la ficha. */
const EVENT_LIMIT = 30
/** Las compras que muestra la ficha (las más nuevas). */
const ORDER_LIMIT = 50

/**
 * La ficha de una clienta: sus datos, sus compras, sus direcciones, lo que el equipo sabe de ella,
 * su historia (con «Separar») y lo de su última compra para «Repetir pedido». Si la ficha pedida
 * está dentro de otra, devuelve esa otra: es la misma clienta.
 */
export async function customerDetail(
  appDb: Db,
  person: Person,
  storeId: string,
  customerId: string,
) {
  uuidOr404(customerId)
  return inStore(appDb, person, storeId, "ventas.atender", async (tx) => {
    const head = await rootRow(tx, storeId, customerId)
    const members = await tx
      .select()
      .from(customer)
      .where(
        and(
          eq(customer.storeId, storeId),
          or(eq(customer.id, head.id), eq(customer.mergedInto, head.id)),
        ),
      )
      .orderBy(asc(customer.createdAt))
    const ids = members.map((m) => m.id)
    const orders = await tx
      .select({
        id: saleOrder.id,
        customerId: saleOrder.customerId,
        number: saleOrder.number,
        state: saleOrder.state,
        channel: saleOrder.channel,
        paymentCollection: saleOrder.paymentCollection,
        totalCents: saleOrder.totalCents,
        address: saleOrder.address,
        deliveryName: saleOrder.deliveryName,
        deliveryZone: saleOrder.deliveryZone,
        deliveryMethodId: saleOrder.deliveryMethodId,
        paymentMethodId: saleOrder.paymentMethodId,
        createdAt: saleOrder.createdAt,
      })
      .from(saleOrder)
      .where(
        and(
          eq(saleOrder.storeId, storeId),
          inArray(saleOrder.customerId, ids),
          // Lo anulado no es una compra; lo de «Probar a Sofi», tampoco.
          ne(saleOrder.state, "anulado"),
          eq(saleOrder.test, false),
        ),
      )
      .orderBy(desc(saleOrder.createdAt))
      .limit(ORDER_LIMIT)
    // Cuántas son todas (la lista de abajo trae solo las más nuevas).
    const [counted] = await tx
      .select({ n: count() })
      .from(saleOrder)
      .where(
        and(
          eq(saleOrder.storeId, storeId),
          inArray(saleOrder.customerId, ids),
          ne(saleOrder.state, "anulado"),
          eq(saleOrder.test, false),
        ),
      )
    const lines = orders.length
      ? await tx
          .select({
            orderId: saleOrderLine.orderId,
            variantId: saleOrderLine.variantId,
            productName: saleOrderLine.productName,
            variantName: saleOrderLine.variantName,
            quantity: saleOrderLine.quantity,
            gift: saleOrderLine.gift,
          })
          .from(saleOrderLine)
          .where(
            inArray(
              saleOrderLine.orderId,
              orders.map((o) => o.id),
            ),
          )
          .orderBy(asc(saleOrderLine.position))
      : []
    const linesBy = Map.groupBy(lines, (line) => line.orderId)
    // El saldo de cada compra, el mismo que en Pedidos: con él se dice su estado.
    const balances = await balancesIn(
      tx,
      orders.map((o) => o.id),
    )
    // Por dónde compró cada ficha: de todas sus compras, no solo de las que se listan.
    const bought = await tx
      .selectDistinct({ customerId: saleOrder.customerId, channel: saleOrder.channel })
      .from(saleOrder)
      .where(
        and(
          eq(saleOrder.storeId, storeId),
          inArray(saleOrder.customerId, ids),
          ne(saleOrder.state, "anulado"),
          eq(saleOrder.test, false),
        ),
      )
    const eventFields = {
      id: customerEvent.id,
      action: customerEvent.action,
      customerId: customerEvent.customerId,
      otherId: customerEvent.otherId,
      createdAt: customerEvent.createdAt,
      actorName: accountCopy.name,
    }
    const recent = await tx
      .select(eventFields)
      .from(customerEvent)
      .leftJoin(accountCopy, eq(accountCopy.userId, customerEvent.actorUserId))
      .where(
        and(
          eq(customerEvent.storeId, storeId),
          or(inArray(customerEvent.customerId, ids), inArray(customerEvent.otherId, ids)),
        ),
      )
      .orderBy(desc(customerEvent.createdAt))
      .limit(EVENT_LIMIT)
    // La última vez que se unió cada ficha que sigue dentro, aunque sea vieja: ahí va «Separar».
    const inner = ids.filter((id) => id !== head.id)
    const joins = inner.length
      ? await tx
          .select(eventFields)
          .from(customerEvent)
          .leftJoin(accountCopy, eq(accountCopy.userId, customerEvent.actorUserId))
          .where(
            and(
              eq(customerEvent.storeId, storeId),
              eq(customerEvent.action, "unida"),
              inArray(customerEvent.otherId, inner),
            ),
          )
          .orderBy(desc(customerEvent.createdAt))
      : []
    const separable = new Map<string, string>()
    for (const e of joins) if (!separable.has(e.otherId)) separable.set(e.otherId, e.id)
    const separates = new Set(separable.values())
    const events = [
      ...recent,
      ...joins.filter((e) => separates.has(e.id) && !recent.some((r) => r.id === e.id)),
    ].sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())
    // Las fichas que nombra la historia (también las de otra clienta, si se dijo que son distintas).
    const named = [...new Set(events.flatMap((e) => [e.customerId, e.otherId]))]
    const fichas = new Map(
      (named.length
        ? await tx
            .select({ id: customer.id, name: customer.name, mergedInto: customer.mergedInto })
            .from(customer)
            .where(inArray(customer.id, named))
        : []
      ).map((row) => [row.id, row]),
    )
    const channelsOf = (id?: string) =>
      [...new Set(bought.filter((o) => !id || o.customerId === id).map((o) => o.channel))].filter(
        (c) => c !== "otro",
      )
    const noteBy = head.noteBy
      ? ((
          await tx
            .select({ name: accountCopy.name })
            .from(accountCopy)
            .where(eq(accountCopy.userId, head.noteBy))
        )[0]?.name ?? null)
      : null
    // Las direcciones a las que se le envió, la última primero y sin repetir.
    const seen = new Set<string>()
    const addresses: { address: string; deliveryName: string; zone: string | null }[] = []
    for (const o of orders) {
      const key = nameKey(`${o.deliveryName}|${o.deliveryZone ?? ""}|${o.address}`)
      if (seen.has(key) || (!o.address && !o.deliveryZone)) continue
      seen.add(key)
      addresses.push({ address: o.address, deliveryName: o.deliveryName, zone: o.deliveryZone })
      if (addresses.length === 5) break
    }
    const last = orders[0]
    // Las de esta ficha, sin el tope de la lista de toda la tienda.
    const similar = similarPairs(
      await membersOf(tx, storeId),
      await answeredPairs(tx, storeId),
      MAX_SIMILAR,
      head.id,
    ).map((p) => (p.a === head.id ? p.b : p.a))
    const similarNames = new Map(
      (similar.length
        ? await tx
            .select({ id: customer.id, name: customer.name, phone: customer.phone })
            .from(customer)
            .where(inArray(customer.id, similar))
        : []
      ).map((row) => [row.id, row]),
    )
    // Lo que debe, con la misma suma del saldo único que la lista (de todas sus compras).
    const [owed] = await summariesOf(tx, storeId, { roots: [head.id] })
    // El país de la tienda: con él, un teléfono anotado sin su código se lee como de ese país.
    const [shop] = await tx
      .select({ country: store.country })
      .from(store)
      .where(eq(store.id, storeId))
    return {
      id: head.id,
      name: head.name,
      phone: head.phone,
      country: shop?.country ?? null,
      phones: members.map((m) => m.phone).filter((p): p is string => Boolean(p)),
      channels: channelsOf(),
      since: members[0]?.createdAt ?? head.createdAt,
      note: head.note,
      noteByName: noteBy,
      noteAt: head.noteAt,
      purchases: counted?.n ?? orders.length,
      dueCents: owed?.dueCents ?? 0,
      dueOnDelivery: owed?.dueOnDelivery ?? false,
      orders: orders.map((o) => ({
        id: o.id,
        number: orderNumber(o.number),
        state: o.state as OrderState,
        paymentCollection: o.paymentCollection as PaymentCollection,
        channel: o.channel,
        totalCents: o.totalCents,
        balance: balances.get(o.id) ?? unpaidBalance(o.totalCents),
        createdAt: o.createdAt,
        text: (linesBy.get(o.id) ?? []).map(lineText).join(", "),
      })),
      addresses,
      /**
       * Las fichas que están dentro de esta: por dónde llegó cada una y su «Lo que sabemos», que
       * unir no mueve ni borra (se ve en la ficha y vuelve con ella al separar).
       */
      members: members
        .filter((m) => m.id !== head.id)
        .map((m) => ({
          id: m.id,
          name: m.name,
          phone: m.phone,
          channels: channelsOf(m.id),
          note: m.note,
        })),
      /**
       * Lo que decidió el equipo, lo último primero. `self`: la decisión habla de esta ficha frente
       * a otra (la unieron a otra, o la separaron de otra); si no, de `with` frente a esta.
       */
      history: events.map((e) => {
        const self = !ids.includes(e.customerId)
        const other = self ? e.customerId : e.otherId
        return {
          id: e.id,
          action: e.action,
          createdAt: e.createdAt,
          actorName: e.actorName,
          self,
          with: { id: other, name: fichas.get(other)?.name ?? "otra ficha" },
          /** «Separar»: la ficha que se separa (la que se unió y sigue dentro de esta). */
          separates: separates.has(e.id) ? e.otherId : null,
        }
      }),
      /** «Repetir pedido»: lo de su última compra, con los precios de hoy al anotarlo. */
      repeat: last
        ? {
            number: orderNumber(last.number),
            channel: last.channel,
            lines: (linesBy.get(last.id) ?? [])
              .filter((line) => !line.gift)
              .map(({ variantId, productName, variantName, quantity }) => ({
                variantId,
                productName,
                variantName,
                quantity,
              })),
            deliveryMethodId: last.deliveryMethodId,
            zone: last.deliveryZone,
            address: last.address,
            paymentMethodId: last.paymentMethodId,
          }
        : null,
      /** Las fichas que podrían ser ella (el mismo teléfono o el mismo nombre), por mirar. */
      similar: similar.map((id) => ({
        id,
        name: similarNames.get(id)?.name ?? "",
        phone: similarNames.get(id)?.phone ?? null,
      })),
    }
  })
}

/** «Editar»: su nombre, su teléfono y «Lo que sabemos». Se corrige la ficha que se ve. */
export async function updateCustomer(
  appDb: Db,
  person: Person,
  storeId: string,
  customerId: string,
  patch: z.infer<typeof customerPatch>,
) {
  uuidOr404(customerId)
  return inStore(appDb, person, storeId, "ventas.atender", async (tx) => {
    const head = await rootRow(tx, storeId, customerId)
    const now = new Date()
    const noteChanged = patch.note !== undefined && patch.note !== head.note
    await tx
      .update(customer)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
        ...(noteChanged
          ? patch.note
            ? { note: patch.note, noteBy: person.userId, noteAt: now }
            : { note: "", noteBy: null, noteAt: null }
          : {}),
        updatedAt: now,
      })
      .where(eq(customer.id, head.id))
    return { id: head.id }
  })
}

/**
 * «Sí, es la misma»: la ficha más nueva queda dentro de la más antigua, con lo que ya estaba
 * dentro de ella. Nada se mueve ni se borra: los pedidos siguen con su ficha y «Separar» lo
 * deshace. Devuelve la ficha que queda.
 */
export async function mergeCustomers(
  appDb: Db,
  person: Person,
  storeId: string,
  input: z.infer<typeof pairInput>,
) {
  return inStore(appDb, person, storeId, "ventas.atender", (tx) =>
    mergeCustomersIn(tx, storeId, person.userId, input),
  )
}

/** Unir dentro de la transacción de la tienda, a nombre de quien lo decidió. */
export async function mergeCustomersIn(
  tx: Db,
  storeId: string,
  actorUserId: string,
  input: z.infer<typeof pairInput>,
) {
  await lockCustomers(tx, storeId)
  const one = await rootRow(tx, storeId, input.a)
  const two = await rootRow(tx, storeId, input.b)
  if (one.id === two.id)
    throw new StoreError(409, "SAME_CUSTOMER", "Ya son la misma ficha. Recarga para verla.")
  const [keep, join] =
    one.createdAt.getTime() < two.createdAt.getTime() ||
    (one.createdAt.getTime() === two.createdAt.getTime() && one.id < two.id)
      ? [one, two]
      : [two, one]
  const now = new Date()
  // Primero lo que estaba dentro de la que se une: así nadie queda dentro de una que está dentro.
  await tx
    .update(customer)
    .set({ mergedInto: keep.id, updatedAt: now })
    .where(and(eq(customer.storeId, storeId), eq(customer.mergedInto, join.id)))
  await tx
    .update(customer)
    .set({ mergedInto: keep.id, updatedAt: now })
    .where(eq(customer.id, join.id))
  await tx.insert(customerEvent).values({
    storeId,
    customerId: keep.id,
    otherId: join.id,
    action: "unida",
    actorUserId,
  })
  return { id: keep.id }
}

/**
 * «Separar»: la ficha que estaba dentro de otra vuelve a estar sola, con sus pedidos y con las
 * fichas que una persona le había unido antes (lo que dijo sigue valiendo: son ella). Así deshace
 * lo que hizo «Sí, es la misma».
 */
export async function separateCustomer(
  appDb: Db,
  person: Person,
  storeId: string,
  customerId: string,
) {
  uuidOr404(customerId)
  return inStore(appDb, person, storeId, "ventas.atender", async (tx) => {
    await lockCustomers(tx, storeId)
    const [row] = await tx
      .select({ id: customer.id, mergedInto: customer.mergedInto })
      .from(customer)
      .where(and(eq(customer.id, customerId), eq(customer.storeId, storeId)))
    if (!row) throw new StoreError(404, "NOT_FOUND", "Esa clienta ya no está")
    if (!row.mergedInto)
      throw new StoreError(409, "NOT_MERGED", "Esa ficha ya está sola. Recarga para verla.")
    const root = row.mergedInto
    // Dentro de cada ficha, a cuál se unió la última vez: las que llegaron por esta, vuelven.
    const inside = await tx
      .select({ id: customer.id })
      .from(customer)
      .where(and(eq(customer.storeId, storeId), eq(customer.mergedInto, root)))
    const joins = inside.length
      ? await tx
          .select({ into: customerEvent.customerId, id: customerEvent.otherId })
          .from(customerEvent)
          .where(
            and(
              eq(customerEvent.storeId, storeId),
              eq(customerEvent.action, "unida"),
              inArray(
                customerEvent.otherId,
                inside.map((c) => c.id),
              ),
            ),
          )
          .orderBy(desc(customerEvent.createdAt))
      : []
    const joinedInto = new Map<string, string>()
    for (const j of joins) if (!joinedInto.has(j.id)) joinedInto.set(j.id, j.into)
    const comes = new Set([row.id])
    for (let grew = true; grew; ) {
      grew = false
      for (const [id, into] of joinedInto)
        if (!comes.has(id) && comes.has(into)) {
          comes.add(id)
          grew = true
        }
    }
    comes.delete(row.id)
    const now = new Date()
    await tx
      .update(customer)
      .set({ mergedInto: null, updatedAt: now })
      .where(eq(customer.id, row.id))
    if (comes.size > 0)
      await tx
        .update(customer)
        .set({ mergedInto: row.id, updatedAt: now })
        .where(and(eq(customer.storeId, storeId), inArray(customer.id, [...comes])))
    await tx.insert(customerEvent).values({
      storeId,
      customerId: root,
      otherId: row.id,
      action: "separada",
      actorUserId: person.userId,
    })
    return { id: row.id, from: root, moved: [...comes] }
  })
}

/** «No, son distintas»: queda dicho y no se vuelve a preguntar por esas dos. */
export async function markDistinct(
  appDb: Db,
  person: Person,
  storeId: string,
  input: z.infer<typeof pairInput>,
) {
  return inStore(appDb, person, storeId, "ventas.atender", async (tx) => {
    await lockCustomers(tx, storeId)
    const one = await rootRow(tx, storeId, input.a)
    const two = await rootRow(tx, storeId, input.b)
    if (one.id === two.id)
      throw new StoreError(
        409,
        "SAME_CUSTOMER",
        "Ya son la misma ficha: si no lo son, sepáralas desde su ficha.",
      )
    await tx.insert(customerEvent).values({
      storeId,
      customerId: one.id,
      otherId: two.id,
      action: "distintas",
      actorUserId: person.userId,
    })
  })
}

/* ------------------------------------------------------------ la ficha de cada pedido */

/**
 * La ficha de la clienta de un pedido nuevo, dentro de la transacción del pedido (la usa
 * `createOrderIn`, para el equipo y para Sofi). La elegida al anotarlo; en el chat, la de los
 * pedidos anteriores de esa conversación; si no hay, una nueva con el nombre y el teléfono del
 * pedido. Nunca la busca por el teléfono: que dos fichas sean la misma lo dice una persona. Un
 * pedido de «Probar a Sofi» no tiene ficha.
 */
export async function customerForOrderIn(
  tx: Db,
  storeId: string,
  actorUserId: string,
  input: { customerId: string | null; customerName: string; customerPhone: string | null },
  options: { conversationId?: string | null; test?: boolean } = {},
): Promise<{ id: string; name: string; phone: string | null } | null> {
  if (options.test) return null
  if (input.customerId) {
    const [row] = await tx
      .select({ id: customer.id })
      .from(customer)
      .where(and(eq(customer.id, input.customerId), eq(customer.storeId, storeId)))
    if (!row)
      throw new StoreError(400, "VALIDATION_ERROR", "Esa clienta ya no está", {
        customerId: "Esa clienta ya no está: búscala otra vez",
      })
    const head = await rootRow(tx, storeId, row.id)
    return { id: head.id, name: head.name, phone: input.customerPhone ?? head.phone }
  }
  if (options.conversationId) {
    // Sofi vuelve a anotar el pedido en la misma conversación: es la misma clienta.
    const head = await conversationCustomerIn(tx, storeId, options.conversationId)
    if (head) {
      return {
        id: head.id,
        name: input.customerName || head.name,
        phone: input.customerPhone ?? head.phone,
      }
    }
  }
  if (!input.customerName)
    throw new StoreError(400, "VALIDATION_ERROR", "Escribe el nombre de la clienta", {
      customerName: "Escribe el nombre de la clienta",
    })
  const [created] = await tx
    .insert(customer)
    .values({
      storeId,
      name: input.customerName,
      phone: input.customerPhone,
      createdBy: actorUserId,
    })
    .returning({ id: customer.id, name: customer.name, phone: customer.phone })
  return created!
}

/**
 * La ficha de la clienta de una conversación (la que se ve, si quedó dentro de otra): la del último
 * pedido de ese chat que tiene ficha. Nunca se busca por el teléfono ni por el nombre.
 */
async function conversationCustomerIn(
  tx: Db,
  storeId: string,
  conversationId: string,
): Promise<CustomerRow | null> {
  const [previous] = await tx
    .select({ customerId: saleOrder.customerId })
    .from(saleOrder)
    .where(
      and(
        eq(saleOrder.storeId, storeId),
        eq(saleOrder.conversationId, conversationId),
        isNotNull(saleOrder.customerId),
      ),
    )
    .orderBy(desc(saleOrder.createdAt))
    .limit(1)
  return previous?.customerId ? rootRow(tx, storeId, previous.customerId) : null
}

/**
 * Lo que compró la clienta de una conversación, para que Sofi elija qué ofrecer (ADR 0224 sobre
 * ADR 0223): los pedidos de su ficha y de las que una persona le unió, por cualquier chat o canal,
 * más los de esta conversación que no tienen ficha (los de prueba y los de antes de Clientes).
 * Sin ficha, es solo lo de esta conversación: nunca se une por el teléfono.
 */
export async function conversationCustomerOrdersIn(
  tx: Db,
  storeId: string,
  conversationId: string,
) {
  const head = await conversationCustomerIn(tx, storeId, conversationId)
  const members = head
    ? (
        await tx
          .select({ id: customer.id })
          .from(customer)
          .where(
            and(
              eq(customer.storeId, storeId),
              or(eq(customer.id, head.id), eq(customer.mergedInto, head.id)),
            ),
          )
      ).map((m) => m.id)
    : []
  return tx
    .select({
      id: saleOrder.id,
      state: saleOrder.state,
      createdAt: saleOrder.createdAt,
      marginUsedCents: saleOrder.marginUsedCents,
      test: saleOrder.test,
    })
    .from(saleOrder)
    .where(
      and(
        eq(saleOrder.storeId, storeId),
        members.length
          ? or(eq(saleOrder.conversationId, conversationId), inArray(saleOrder.customerId, members))
          : eq(saleOrder.conversationId, conversationId),
      ),
    )
    .orderBy(asc(saleOrder.createdAt))
}

/** La ficha que se ve de la de un pedido (si quedó dentro de otra, esa otra). */
export async function shownCustomerId(tx: Db, customerId: string | null): Promise<string | null> {
  if (!customerId) return null
  const [row] = await tx
    .select({ id: customer.id, mergedInto: customer.mergedInto })
    .from(customer)
    .where(eq(customer.id, customerId))
  return row ? (row.mergedInto ?? row.id) : null
}

import {
  type CustomerGroupFilters,
  customer,
  customerGroup,
  customerProfile,
  type Db,
  type PriceSensitivity,
  product,
  productVariant,
  saleOrder,
  saleOrderLine,
  store,
} from "@gestoria/db"
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm"
import { z } from "zod"
import {
  type Computed,
  computedOf,
  daysBetween,
  type Purchase,
  type PurchaseItem,
  SEGMENTS,
  type Segment,
} from "./clientas-perfil.js"
import type { Person } from "./cuenta.js"
import { formatMoney } from "./dinero.js"
import { DEFAULT_TIME_ZONE, dayIn, isTimeZone, startOfDay, storeClockIn } from "./hora.js"
import {
  type ConsentView,
  currentOf,
  type FactRow,
  familyConversationsIn,
  type MeasureCatalog,
  measureCatalogIn,
} from "./perfil.js"
import { BOUGHT_STATES } from "./sofi/sofi.js"
import { inStore, StoreError } from "./tiendas.js"

/**
 * Los grupos de clientas (lienzo «Clientas bien perfiladas y Argos que hace el marketing solo»):
 * lo que Argos calcula de cada ficha con las cuentas fijas de `clientas-perfil.ts`, guardado en
 * `customer_profile` para filtrar rápido la lista de Clientes, y los grupos que guarda la tienda.
 *
 * - Una compra es un pedido con ficha, que no es de prueba, en un estado que ya es compra
 *   (`BOUGHT_STATES`), con su día en la hora de la tienda. Un cambio no es otra compra: lo que
 *   lleva y lo que vuelve ajusta lo que gastó en la compra de la que sale (su total ya descuenta lo
 *   que vuelve; el dinero devuelto solo paga ese saldo, no se resta otra vez). Nada de esto toca el
 *   saldo único (`order_balance`): no se cobra ni se debe aquí.
 * - Se pidió rebaja si se cedió algo del margen (`margin_used_cents`); compró en liquidación si una
 *   línea salió con su promoción (el precio sin negociar bajo el de lista, con una promoción del
 *   producto vigente el día de la compra).
 * - `customer_profile` lo escribe solo el dueño de la base, en la vuelta de cada noche
 *   (`runNightlyProfiles`): cada tienda, una vez pasadas las 03:00 de su hora. La aplicación solo lo
 *   lee; lo que cambió desde la última vuelta (una ficha nueva, una compra, un dato corregido, unir
 *   o separar) se calcula en el momento con la misma cuenta.
 * - Un grupo guardado son filtros, nunca clientas: así se pone al día solo.
 */

/** Lo que dice el día de las 03:00 de la tienda: desde ahí se recalcula. */
export const NIGHT_HOUR = 3
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

const fold = (text: string) =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim()

const orderNumber = (number: number) => String(number).padStart(4, "0")

const inUuids = (column: ReturnType<typeof sql.raw>, ids: string[]) =>
  sql`${column} in (${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`

// Una función, no una constante: `sofi/sofi.ts` y este archivo se importan en círculo.
const boughtSql = () =>
  sql.join(
    BOUGHT_STATES.map((s) => sql`${s}`),
    sql`, `,
  )

/* ----------------------------------------------------------------- las compras */

/** Las compras de cada familia (la ficha que se ve y las que se le unieron), por su raíz. */
export async function purchasesIn(
  tx: Db,
  storeId: string,
  timeZone: string,
  catalog: MeasureCatalog,
  roots?: string[],
): Promise<Map<string, Purchase[]>> {
  const out = new Map<string, Purchase[]>()
  if (roots && roots.length === 0) return out
  const only = roots ? sql`and ${inUuids(sql.raw("coalesce(c.merged_into, c.id)"), roots)}` : sql``
  const orders = await tx.execute<{
    root: string
    id: string
    created_at: Date | string
    total_cents: number | string
    margin_used_cents: number | string
    delivery_zone: string | null
    exchanged: number | string | null
  }>(sql`
    select coalesce(c.merged_into, c.id) as root, o.id, o.created_at, o.total_cents,
      o.margin_used_cents, o.delivery_zone,
      (select coalesce(sum(x.total_cents), 0) from sale_order x
        where x.store_id = o.store_id and x.exchange_of_id = o.id and x.test = false
          and x.state <> 'anulado'
          and (x.state in (${boughtSql()}) or x.total_cents < 0)) as exchanged
    from sale_order o
    join customer c on c.id = o.customer_id
    where o.store_id = ${storeId} and o.test = false and o.exchange_of_id is null
      and o.state in (${boughtSql()}) ${only}`)
  const lines = await tx.execute<{
    order_id: string
    product_id: string
    option_values: string[]
    category: string | null
    options: { name: string }[]
    promo: boolean
  }>(sql`
    select l.order_id, l.product_id, v.option_values, p.category, p.options,
      (l.auto_unit_cents < l.list_unit_cents and exists (
        select 1 from product_promotion pp
        where pp.store_id = l.store_id and pp.product_id = l.product_id
          and (o.created_at at time zone ${timeZone})::date between pp.starts_on and pp.ends_on
      )) as promo
    from sale_order_line l
    join sale_order o on o.id = l.order_id
    join customer c on c.id = o.customer_id
    join product_variant v on v.id = l.variant_id
    join product p on p.id = l.product_id
    where o.store_id = ${storeId} and o.test = false and o.exchange_of_id is null
      and o.state in (${boughtSql()}) and l.gift = false ${only}
    order by l.order_id, l.position`)
  const itemsOf = new Map<string, { items: PurchaseItem[]; promo: boolean }>()
  for (const line of lines) {
    const measureAt = catalog.indexOf.get(line.product_id)
    const colorAt = (line.options ?? []).findIndex((option) => fold(option.name) === "color")
    const row = itemsOf.get(line.order_id) ?? { items: [], promo: false }
    row.items.push({
      category: line.category,
      color: colorAt >= 0 ? (line.option_values[colorAt] ?? null) : null,
      measure: measureAt === undefined ? null : (line.option_values[measureAt] ?? null),
    })
    row.promo ||= Boolean(line.promo)
    itemsOf.set(line.order_id, row)
  }
  for (const o of orders) {
    const items = itemsOf.get(o.id)
    const list = out.get(o.root) ?? []
    list.push({
      day: dayIn(timeZone, new Date(o.created_at)),
      spentCents: Number(o.total_cents) + Number(o.exchanged ?? 0),
      ceded: Number(o.margin_used_cents) > 0,
      promo: items?.promo ?? false,
      items: items?.items ?? [],
      zone: o.delivery_zone,
    })
    out.set(o.root, list)
  }
  return out
}

/** La medida y el distrito de hoy del perfil de cada familia (`currentOf` de `perfil.ts`). */
async function profileFactsIn(tx: Db, storeId: string, roots?: string[]) {
  const out = new Map<string, { measure: string | null; district: string | null }>()
  if (roots && roots.length === 0) return out
  const only = roots ? sql`and ${inUuids(sql.raw("coalesce(c.merged_into, c.id)"), roots)}` : sql``
  const rows = await tx.execute<{
    root: string
    id: string
    key: "medida" | "distrito"
    value: string
    source: FactRow["source"]
    created_at: Date | string
  }>(sql`
    select coalesce(c.merged_into, c.id) as root, f.id, f.key, f.value, f.source, f.created_at
    from customer_fact f join customer c on c.id = f.customer_id
    where f.store_id = ${storeId} and f.key in ('medida', 'distrito') ${only}
    order by f.created_at desc, f.id desc`)
  const byRoot = Map.groupBy([...rows], (row) => row.root)
  for (const [root, list] of byRoot) {
    const facts = list.map(
      (row) =>
        ({
          id: row.id,
          key: row.key,
          value: row.value,
          source: row.source,
          quote: null,
          orderId: null,
          orderNumber: null,
          alternatives: [],
          actorUserId: "",
          actorName: null,
          createdAt: new Date(row.created_at),
        }) satisfies FactRow,
    )
    out.set(root, {
      measure: currentOf(facts, "medida")?.value ?? null,
      district: currentOf(facts, "distrito")?.value.split(",")[0]?.trim() || null,
    })
  }
  return out
}

/** Todo lo calculado de una ficha: lo que muestra, lo que se guarda y lo que se filtra. */
export interface ProfileState {
  computed: Computed
  purchases: Purchase[]
  /** La del perfil o, si no hay, la que más compra. */
  measure: string | null
  /** El del perfil o, si no hay, la zona de su última entrega. */
  district: string | null
  lastBoughtOn: string | null
  measures: string[]
  categories: string[]
  districts: string[]
}

/** Sin repetir (sin mayúsculas ni tildes), en su orden y sin vacíos. */
function distinct(values: (string | null | undefined)[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const text = value?.trim()
    if (!text || seen.has(fold(text))) continue
    seen.add(fold(text))
    out.push(text)
  }
  return out
}

/**
 * Lo que Argos calcula de cada ficha que se ve (todas, o las de `roots`), con el día de hoy de la
 * tienda. Las fichas sin compras también: son «Sin compras».
 */
export async function profilesIn(
  tx: Db,
  storeId: string,
  clock: { timeZone: string; today: string },
  roots?: string[],
): Promise<Map<string, ProfileState>> {
  const out = new Map<string, ProfileState>()
  if (roots && roots.length === 0) return out
  const [shop] = await tx
    .select({ currency: store.currency })
    .from(store)
    .where(eq(store.id, storeId))
  const currency = shop?.currency ?? "PEN"
  const heads = await tx
    .select({ id: customer.id })
    .from(customer)
    .where(
      and(
        eq(customer.storeId, storeId),
        isNull(customer.mergedInto),
        roots ? inArray(customer.id, roots) : undefined,
      ),
    )
  const ids = heads.map((h) => h.id)
  if (ids.length === 0) return out
  const catalog = await measureCatalogIn(tx, storeId)
  const purchases = await purchasesIn(tx, storeId, clock.timeZone, catalog, roots)
  const facts = await profileFactsIn(tx, storeId, roots)
  for (const id of ids) {
    const bought = (purchases.get(id) ?? []).sort((a, b) => (a.day < b.day ? 1 : -1))
    const computed = computedOf(bought, clock.today, currency)
    const fact = facts.get(id)
    const measure = fact?.measure ?? computed.measures[0]?.[0] ?? null
    const lastZone = bought.find((p) => p.zone?.trim())?.zone?.trim() ?? null
    out.set(id, {
      computed,
      purchases: bought,
      measure,
      district: fact?.district ?? lastZone,
      lastBoughtOn: bought[0]?.day ?? null,
      measures: distinct([measure, ...computed.measures.map(([value]) => value)]),
      categories: distinct(computed.categories.map(([value]) => value)),
      districts: distinct([fact?.district, ...bought.map((p) => p.zone)]),
    })
  }
  return out
}

/* ------------------------------------------------------------- la vuelta de la noche */

/**
 * Recalcula entera una tienda, dentro de la transacción del dueño de la base: la vuelta de la
 * noche, la semilla y las pruebas. Devuelve cuántas fichas calculó.
 */
export async function recomputeStoreIn(tx: Db, storeId: string, now = new Date()) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`perfiles:${storeId}`}))`)
  const clock = await storeClockIn(tx, storeId, now)
  const states = await profilesIn(tx, storeId, clock)
  await tx.delete(customerProfile).where(eq(customerProfile.storeId, storeId))
  const rows = [...states.entries()].map(([customerId, s]) => ({
    storeId,
    customerId,
    segment: s.computed.segment,
    why: s.computed.why,
    ordersCount: s.computed.ordersCount,
    totalCents: s.computed.totalCents,
    lastBoughtOn: s.lastBoughtOn,
    rhythmDays: s.computed.rhythmDays,
    measures: s.measures,
    categories: s.categories,
    districts: s.districts,
    priceSensitivity: s.computed.priceSensitivity,
    computedFor: clock.today,
  }))
  for (let i = 0; i < rows.length; i += 500)
    await tx.insert(customerProfile).values(rows.slice(i, i + 500))
  return rows.length
}

/** Recalcula una tienda ahora, con el dueño de la base (la semilla y las pruebas). */
export async function recalculateStore(ownerDb: Db, storeId: string, now = new Date()) {
  return ownerDb.transaction((tx) => recomputeStoreIn(tx as unknown as Db, storeId, now))
}

/**
 * La vuelta de la noche (cada hora en `index.ts`, con su candado): cada tienda cuyo día ya pasó
 * las 03:00 en su hora y que todavía no se calculó hoy, se recalcula entera. Una que falla no
 * detiene a las demás: se intenta en la vuelta siguiente.
 */
export async function runNightlyProfiles(ownerDb: Db, now = new Date()) {
  const stores = await ownerDb.select({ id: store.id, timeZone: store.timeZone }).from(store)
  const run = { stores: 0, customers: 0, failed: 0 }
  for (const s of stores) {
    const timeZone = isTimeZone(s.timeZone) ? s.timeZone : DEFAULT_TIME_ZONE
    const today = dayIn(timeZone, now)
    if (now.getTime() < startOfDay(timeZone, today).getTime() + NIGHT_HOUR * HOUR_MS) continue
    const [done] = await ownerDb
      .select({ id: customerProfile.customerId })
      .from(customerProfile)
      .where(and(eq(customerProfile.storeId, s.id), eq(customerProfile.computedFor, today)))
      .limit(1)
    if (done) continue
    // Sin fichas no hay nada que calcular (ni que volver a mirar cada hora).
    const [any] = await ownerDb
      .select({ id: customer.id })
      .from(customer)
      .where(eq(customer.storeId, s.id))
      .limit(1)
    if (!any) continue
    try {
      run.customers += await recalculateStore(ownerDb, s.id, now)
      run.stores += 1
    } catch (error) {
      run.failed += 1
      console.error(`gestoria-api: el grupo de las clientas de la tienda ${s.id} falló`, error)
    }
  }
  return run
}

/* ------------------------------------------------------------------- la lista */

/** Lo que la lista sabe de cada ficha: lo guardado de la noche o lo calculado ahora. */
export interface ListProfile {
  segment: Segment
  why: string
  ordersCount: number
  totalCents: number
  lastBoughtOn: string | null
  measures: string[]
  categories: string[]
  districts: string[]
  priceSensitivity: PriceSensitivity | null
}

const fromState = (s: ProfileState): ListProfile => ({
  segment: s.computed.segment,
  why: s.computed.why,
  ordersCount: s.computed.ordersCount,
  totalCents: s.computed.totalCents,
  lastBoughtOn: s.lastBoughtOn,
  measures: s.measures,
  categories: s.categories,
  districts: s.districts,
  priceSensitivity: s.computed.priceSensitivity,
})

/**
 * Lo de cada ficha que se ve, para la lista: lo que guardó la vuelta de la noche y, en el momento,
 * lo de las fichas que no tienen fila o que cambiaron después (una ficha o un pedido de la
 * familia, un dato del perfil, unir o separar).
 */
export async function listProfilesIn(
  tx: Db,
  storeId: string,
  clock: { timeZone: string; today: string },
): Promise<Map<string, ListProfile>> {
  const rows = await tx.execute<{
    root: string
    stale: boolean
    segment: Segment | null
    why: string | null
    orders_count: number | null
    total_cents: number | string | null
    last_bought_on: string | null
    measures: string[] | null
    categories: string[] | null
    districts: string[] | null
    price_sensitivity: PriceSensitivity | null
  }>(sql`
    select r.id as root, p.segment, p.why, p.orders_count, p.total_cents,
      p.last_bought_on::text as last_bought_on, p.measures, p.categories, p.districts,
      p.price_sensitivity,
      (p.customer_id is null
        or exists (select 1 from customer c where c.store_id = r.store_id
          and coalesce(c.merged_into, c.id) = r.id and c.updated_at > p.computed_at)
        or exists (select 1 from sale_order o join customer c on c.id = o.customer_id
          where o.store_id = r.store_id and coalesce(c.merged_into, c.id) = r.id
            and o.updated_at > p.computed_at)
        or exists (select 1 from customer_fact f join customer c on c.id = f.customer_id
          where f.store_id = r.store_id and coalesce(c.merged_into, c.id) = r.id
            and f.created_at > p.computed_at)
        or exists (select 1 from customer_event e where e.store_id = r.store_id
          and (e.customer_id = r.id or e.other_id = r.id) and e.created_at > p.computed_at)
      ) as stale
    from customer r
    left join customer_profile p on p.store_id = r.store_id and p.customer_id = r.id
    where r.store_id = ${storeId} and r.merged_into is null`)
  const out = new Map<string, ListProfile>()
  const stale: string[] = []
  for (const row of rows) {
    if (row.stale || !row.segment) {
      stale.push(row.root)
      continue
    }
    out.set(row.root, {
      segment: row.segment,
      why: row.why ?? "",
      ordersCount: Number(row.orders_count ?? 0),
      totalCents: Number(row.total_cents ?? 0),
      lastBoughtOn: row.last_bought_on,
      measures: row.measures ?? [],
      categories: row.categories ?? [],
      districts: row.districts ?? [],
      priceSensitivity: row.price_sensitivity,
    })
  }
  if (stale.length)
    for (const [id, state] of await profilesIn(tx, storeId, clock, stale))
      out.set(id, fromState(state))
  return out
}

/**
 * El permiso para escribirle de cada ficha que se ve: el último de su ficha, de las que se le
 * unieron o de sus conversaciones (como `customerProfileIn` de `perfil.ts`, para toda la tienda).
 */
export async function consentsIn(tx: Db, storeId: string): Promise<Map<string, ConsentView>> {
  const rows = await tx.execute<{ root: string; state: ConsentView }>(sql`
    select distinct on (t.root) t.root, t.state from (
      select coalesce(c.merged_into, c.id) as root, k.state, k.created_at
      from customer_consent k join customer c on c.id = k.customer_id
      where k.store_id = ${storeId} and k.channel <> 'prueba'
      union all
      select coalesce(c.merged_into, c.id) as root, k.state, k.created_at
      from customer_consent k
      join sale_order o on o.store_id = k.store_id and o.conversation_id = k.conversation_id
      join customer c on c.id = o.customer_id
      where k.store_id = ${storeId} and k.channel <> 'prueba'
    ) t
    order by t.root, t.created_at desc`)
  return new Map([...rows].map((row) => [row.root, row.state]))
}

/* -------------------------------------------------------------- los filtros */

const optionalText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().max(max, `Máximo ${max} caracteres`).optional(),
  )

/** Los filtros de Clientes, los mismos que guarda un grupo. */
export const listFilters = z.object({
  grupo: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(SEGMENTS as [Segment, ...Segment[]], "Ese grupo no existe").optional(),
  ),
  medida: optionalText(120),
  categoria: optionalText(60),
  distrito: optionalText(120),
  promociones: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(["si", "no"], "Elige sí o no").optional(),
  ),
  orden: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(["reciente", "gasto"], "Ordena por lo reciente o por lo que gastó").optional(),
  ),
  q: optionalText(80),
})
export type ListFilters = z.infer<typeof listFilters>

/** Si una ficha pasa los filtros (sin la búsqueda, que hace la lista). */
export function matches(profile: ListProfile, consent: ConsentView, filters: ListFilters): boolean {
  const has = (list: string[], wanted?: string) =>
    !wanted || list.some((value) => fold(value) === fold(wanted))
  if (filters.grupo && profile.segment !== filters.grupo) return false
  if (!has(profile.measures, filters.medida)) return false
  if (!has(profile.categories, filters.categoria)) return false
  if (!has(profile.districts, filters.distrito)) return false
  if (filters.promociones === "si" && consent !== "si") return false
  if (filters.promociones === "no" && consent === "si") return false
  return true
}

export const hasFilters = (filters: ListFilters) =>
  Boolean(
    filters.grupo || filters.medida || filters.categoria || filters.distrito || filters.promociones,
  )

/** Lo que se puede filtrar en toda la tienda (sin los filtros): de lo más a lo menos usado. */
export function facetsOf(profiles: Map<string, ListProfile>) {
  const segments = Object.fromEntries(SEGMENTS.map((s) => [s, 0])) as Record<Segment, number>
  const counts = {
    measures: new Map<string, { value: string; n: number }>(),
    categories: new Map<string, { value: string; n: number }>(),
    districts: new Map<string, { value: string; n: number }>(),
  }
  for (const p of profiles.values()) {
    segments[p.segment] += 1
    for (const key of ["measures", "categories", "districts"] as const)
      for (const value of p[key]) {
        const row = counts[key].get(fold(value)) ?? { value, n: 0 }
        row.n += 1
        counts[key].set(fold(value), row)
      }
  }
  const sorted = (map: Map<string, { value: string; n: number }>) =>
    [...map.values()]
      .sort((a, b) => b.n - a.n || a.value.localeCompare(b.value, "es", { numeric: true }))
      .map((row) => row.value)
  return {
    segments,
    measures: sorted(counts.measures),
    categories: sorted(counts.categories),
    districts: sorted(counts.districts),
  }
}

/** Los días desde su última compra, con el día de hoy de la tienda. */
export const lastBoughtDaysOf = (profile: ListProfile | undefined, today: string) =>
  profile?.lastBoughtOn ? Math.max(0, daysBetween(profile.lastBoughtOn, today)) : null

/* ----------------------------------------------------- el precio de cada pedido */

/**
 * Si cada pedido salió con rebaja (se cedió algo del margen) o en liquidación (una línea con su
 * promoción, vigente el día del pedido): la misma regla de la sensibilidad al precio. Si tiene las
 * dos, rebaja.
 */
export async function priceNotesIn(
  tx: Db,
  storeId: string,
  timeZone: string,
  orderIds: string[],
): Promise<Map<string, PriceSensitivity | null>> {
  if (orderIds.length === 0) return new Map()
  const rows = await tx.execute<{ id: string; ceded: boolean; promo: boolean }>(sql`
    select o.id, o.margin_used_cents > 0 as ceded,
      exists (select 1 from sale_order_line l
        where l.order_id = o.id and l.gift = false and l.auto_unit_cents < l.list_unit_cents
          and exists (select 1 from product_promotion pp
            where pp.store_id = l.store_id and pp.product_id = l.product_id
              and (o.created_at at time zone ${timeZone})::date between pp.starts_on and pp.ends_on)
      ) as promo
    from sale_order o
    where o.store_id = ${storeId} and ${inUuids(sql.raw("o.id"), orderIds)}`)
  return new Map(
    [...rows].map((row) => [
      row.id,
      row.ceded ? ("rebaja" as const) : row.promo ? ("liquidacion" as const) : null,
    ]),
  )
}

/* --------------------------------------------------- lo que quiso y no compró */

export interface Wanted {
  kind: "agotado" | "cotizo" | "carrito"
  text: string
  /** Lo que quiso, sin el precio («Botín · 43»): con esto dice la ficha por qué preguntó. */
  item: string
  at: string
  orderNumber?: string
}

/** Cuántas cosas que quiso muestra la ficha. */
const MAX_WANTED = 10
/** El carrito sin pagar vale mientras es de menos de un día. */
const CART_MS = DAY_MS

const variantText = (productName: string, values: string[]) =>
  values.length ? `${productName} · ${values.join(" ")}` : productName

/**
 * Lo que quiso y no compró: lo que pidió agotado en sus conversaciones (y no compró después), lo
 * que Sofi le cotizó y no terminó en pedido, y su carrito sin pagar (un pedido por pagar de menos
 * de 24 horas, con su precio vigente). Lo más nuevo primero.
 */
export async function wantedIn(
  tx: Db,
  storeId: string,
  family: string[],
  now = new Date(),
): Promise<Wanted[]> {
  if (family.length === 0) return []
  const [shop] = await tx
    .select({ currency: store.currency })
    .from(store)
    .where(eq(store.id, storeId))
  const currency = shop?.currency ?? "PEN"
  const conversations = (await familyConversationsIn(tx, storeId, family)).map((c) => c.id)
  const out: Wanted[] = []
  const familyIds = inUuids(sql.raw("o.customer_id"), family)
  if (conversations.length) {
    const inConversations = inUuids(sql.raw("r.conversation_id"), conversations)
    const asked = await tx.execute<{
      product_name: string
      option_values: string[]
      created_at: Date | string
    }>(sql`
      select p.name as product_name, v.option_values, max(r.created_at) as created_at
      from stock_request r
      join product_variant v on v.id = r.variant_id
      join product p on p.id = v.product_id
      where r.store_id = ${storeId} and ${inConversations}
        and not exists (
          select 1 from sale_order o join sale_order_line l on l.order_id = o.id
          where o.store_id = r.store_id and ${familyIds} and o.test = false
            and o.state in (${boughtSql()}) and l.variant_id = r.variant_id
            and o.created_at >= r.created_at)
      group by p.name, v.option_values`)
    for (const row of asked)
      out.push({
        kind: "agotado",
        text: variantText(row.product_name, row.option_values),
        item: variantText(row.product_name, row.option_values),
        at: new Date(row.created_at).toISOString(),
      })
    const inMessages = inUuids(sql.raw("m.conversation_id"), conversations)
    const quoted = await tx.execute<{ quotes: string[]; created_at: Date | string }>(sql`
      select distinct on (m.conversation_id) m.detail -> 'quotes' as quotes, m.created_at
      from conversation_message m
      where m.store_id = ${storeId} and ${inMessages} and m.author = 'sofi'
        and jsonb_typeof(m.detail -> 'quotes') = 'array'
        and jsonb_array_length(m.detail -> 'quotes') > 0
        and not exists (select 1 from sale_order o where o.store_id = m.store_id
          and o.conversation_id = m.conversation_id and o.created_at >= m.created_at)
      order by m.conversation_id, m.created_at desc`)
    const parsed = [...quoted].flatMap((row) => {
      const key = row.quotes.at(-1)
      try {
        const value = JSON.parse(key ?? "") as [
          [string, number, number | null, boolean][],
          ...unknown[],
        ]
        const total = value.at(-1)
        if (!Array.isArray(value[0]) || typeof total !== "number") return []
        return [{ lines: value[0], total, at: new Date(row.created_at) }]
      } catch {
        return []
      }
    })
    const variantIds = [...new Set(parsed.flatMap((q) => q.lines.map((l) => String(l[0]))))].filter(
      (id) => z.uuid().safeParse(id).success,
    )
    const names = new Map(
      (variantIds.length
        ? await tx
            .select({
              id: productVariant.id,
              name: product.name,
              values: productVariant.optionValues,
            })
            .from(productVariant)
            .innerJoin(product, eq(product.id, productVariant.productId))
            .where(and(eq(productVariant.storeId, storeId), inArray(productVariant.id, variantIds)))
        : []
      ).map((row) => [row.id, variantText(row.name, row.values)]),
    )
    for (const q of parsed) {
      const items = q.lines
        .map(([id, quantity]) => {
          const name = names.get(String(id))
          return name ? `${name}${quantity > 1 ? ` × ${quantity}` : ""}` : null
        })
        .filter(Boolean)
      if (items.length === 0) continue
      out.push({
        kind: "cotizo",
        text: `${items.join(", ")} · ${formatMoney(q.total, currency)}`,
        item: items.join(", "),
        at: q.at.toISOString(),
      })
    }
  }
  const carts = await tx
    .select({
      id: saleOrder.id,
      number: saleOrder.number,
      createdAt: saleOrder.createdAt,
      totalCents: saleOrder.totalCents,
    })
    .from(saleOrder)
    .where(
      and(
        eq(saleOrder.storeId, storeId),
        inArray(saleOrder.customerId, family),
        eq(saleOrder.state, "por_pagar"),
        eq(saleOrder.test, false),
        isNull(saleOrder.exchangeOfId),
        sql`${saleOrder.createdAt} > ${new Date(now.getTime() - CART_MS).toISOString()}`,
        sql`(${saleOrder.priceExpiresAt} is null or ${saleOrder.priceExpiresAt} > ${now.toISOString()})`,
      ),
    )
  if (carts.length) {
    const lines = await tx
      .select({
        orderId: saleOrderLine.orderId,
        productName: saleOrderLine.productName,
        variantName: saleOrderLine.variantName,
        quantity: saleOrderLine.quantity,
      })
      .from(saleOrderLine)
      .where(
        inArray(
          saleOrderLine.orderId,
          carts.map((c) => c.id),
        ),
      )
      .orderBy(asc(saleOrderLine.position))
    const by = Map.groupBy(lines, (line) => line.orderId)
    for (const cart of carts) {
      const text = (by.get(cart.id) ?? [])
        .map(
          (l) =>
            `${l.productName}${l.variantName === "Única" ? "" : ` · ${l.variantName}`}${l.quantity > 1 ? ` × ${l.quantity}` : ""}`,
        )
        .join(", ")
      out.push({
        kind: "carrito",
        text: `${text} · ${formatMoney(cart.totalCents, currency)}`,
        item: text,
        at: cart.createdAt.toISOString(),
        orderNumber: orderNumber(cart.number),
      })
    }
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, MAX_WANTED)
}

/* --------------------------------------------------------- los grupos guardados */

/** Cuántos grupos guarda una tienda, como mucho. */
export const MAX_GROUPS = 50

export const groupInput = z.object({
  name: z
    .string("Escribe el nombre")
    .trim()
    .min(1, "Escribe el nombre")
    .max(60, "Máximo 60 caracteres"),
  filters: listFilters.default({}),
})

/** Lo que guarda un grupo: solo los filtros que tienen algo. */
function savedFilters(filters: ListFilters): CustomerGroupFilters {
  return Object.fromEntries(
    Object.entries(filters).filter(([, value]) => value !== undefined && value !== ""),
  ) as CustomerGroupFilters
}

const groupFields = {
  id: customerGroup.id,
  name: customerGroup.name,
  filters: customerGroup.filters,
  createdAt: customerGroup.createdAt,
}

/** «Tus grupos»: los que guardó la tienda, del más viejo al más nuevo. */
export async function listGroups(appDb: Db, person: Person, storeId: string) {
  return inStore(appDb, person, storeId, "ventas.atender", async (tx) => ({
    groups: await tx
      .select(groupFields)
      .from(customerGroup)
      .where(and(eq(customerGroup.storeId, storeId), isNull(customerGroup.removedAt)))
      .orderBy(asc(customerGroup.createdAt)),
  }))
}

/** «Guardar como grupo»: un nombre y los filtros de ahora. */
export async function createGroup(
  appDb: Db,
  person: Person,
  storeId: string,
  input: z.infer<typeof groupInput>,
) {
  return inStore(appDb, person, storeId, "ventas.atender", async (tx) => {
    const filters = savedFilters(input.filters)
    if (!hasFilters(input.filters) && !filters.q)
      throw new StoreError(400, "VALIDATION_ERROR", "Elige al menos un filtro para guardarlo", {
        filters: "Elige al menos un filtro para guardarlo",
      })
    const open = await tx
      .select({ id: customerGroup.id, name: customerGroup.name })
      .from(customerGroup)
      .where(and(eq(customerGroup.storeId, storeId), isNull(customerGroup.removedAt)))
    if (open.length >= MAX_GROUPS)
      throw new StoreError(409, "TOO_MANY_GROUPS", `Ya tienes ${MAX_GROUPS} grupos: quita uno`)
    if (open.some((g) => fold(g.name) === fold(input.name)))
      throw new StoreError(400, "VALIDATION_ERROR", "Ya tienes un grupo con ese nombre", {
        name: "Ya tienes un grupo con ese nombre",
      })
    const [group] = await tx
      .insert(customerGroup)
      .values({ storeId, name: input.name, filters, createdBy: person.userId })
      .returning(groupFields)
    return { group: group! }
  })
}

/** Quitar un grupo: queda marcado, las clientas no cambian. */
export async function removeGroup(appDb: Db, person: Person, storeId: string, groupId: string) {
  if (!z.uuid().safeParse(groupId).success)
    throw new StoreError(404, "NOT_FOUND", "Ese grupo ya no está")
  return inStore(appDb, person, storeId, "ventas.atender", async (tx) => {
    const [removed] = await tx
      .update(customerGroup)
      .set({ removedAt: new Date() })
      .where(
        and(
          eq(customerGroup.id, groupId),
          eq(customerGroup.storeId, storeId),
          isNull(customerGroup.removedAt),
        ),
      )
      .returning({ id: customerGroup.id })
    if (!removed) throw new StoreError(404, "NOT_FOUND", "Ese grupo ya no está")
  })
}

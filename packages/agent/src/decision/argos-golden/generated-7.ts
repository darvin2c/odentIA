/**
 * Las respuestas correctas de las preguntas generadas (`eval/argos-generadas.json`), parte 7:
 * inventario (g151–g155) y periodos (g156–g175). Lo que hay se mide a hoy con
 * `listProducts` de cada sede, como Inventario; lo usado, con los movimientos
 * del ledger. Un día, un rango o un mes nombrados se piden a Reportes con su
 * periodo (`YYYY-MM-DD..YYYY-MM-DD`, `YYYY-MM`); un día o un mes que este año
 * aún no llega es el del año anterior.
 */
import { collectedNetMany, listProducts, type FigureResult, type ProductListItem, purchaseOrderLabel } from "@odentia/services"
import { sql } from "drizzle-orm"
import { collectedByDay, dayStart, goldenWords } from "./finance.js"
import type { GoldenHelpers, GoldenSolvers } from "./helpers.js"
import { monthLabel } from "./trends.js"

/** «1 frasco», «2 frascos», «3 unidades»: la unidad de uso del producto (como `inventory.ts`). */
function unitsWord(count: number, unit: string): string {
  if (count === 1 || count === -1) return `${count} ${unit}`
  const plural = /[aeiouáéó]$/i.test(unit) ? `${unit}s` : `${unit}es`
  return `${count} ${plural}`
}

/** Lo que se busca por nombre o código de producto, sin tildes. */
const BRACKETS = "bracket"
const IMPRESSION = "impresi|alginat|silicona|elastomer|polivinil|polieter|yeso"
const ANESTHESIA = "anest|lidoca|articai|mepivaca|prilocai|bupivaca|benzocai"

export function generatedSolvers7(h: GoldenHelpers): GoldenSolvers {
  const w = goldenWords(h)
  const { tx, org, money, show, listOf, tz } = h
  const { locale, currency } = h.scope
  const nowIso = h.now.toISOString()
  const today = w.todayKey
  const year = h.scope.window.from.year
  const currentMonth = h.scope.window.from.month
  const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
  const weekday = (key: string) => new Date(`${key}T12:00:00Z`).getUTCDay()
  const monday = w.addDays(today, -((weekday(today) + 6) % 7))
  const yesterday = w.addDays(today, -1)
  const monthKey = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`
  /** «1 de setiembre de 2026». */
  const dateWords = (key: string, withYear = true) =>
    new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" }).format(new Date(`${key}T12:00:00Z`))
  /** «miércoles 14 de octubre», con el año si no es este. */
  const dayName = (key: string) => (Number(key.slice(0, 4)) === year ? w.dayWords(key) : `${w.dayWords(key)} de ${key.slice(0, 4)}`)
  /** «del lunes 19 al miércoles 21 de octubre». */
  const spanWords = (from: string, to: string): string =>
    from === to
      ? `el ${dayName(from)}`
      : `del ${from.slice(0, 7) === to.slice(0, 7) ? w.dayWords(from).replace(/ de [^ ]+$/, "") : w.dayWords(from)} al ${dayName(to)}`
  /** «ayer, martes 20 de octubre». */
  const whenWords = (key: string) => (key === today ? `hoy, ${w.dayWords(key)}` : key === yesterday ? `ayer, ${w.dayWords(key)}` : `el ${dayName(key)}`)
  /** El último `MM-DD` que ya llegó: el de este año o, si aún no, el del anterior. */
  const yearOfDay = (monthDay: string) => (`${year}-${monthDay}` <= today ? year : year - 1)
  /** El año del último `month` que ya empezó. */
  const yearOfMonth = (month: number) => (month <= currentMonth ? year : year - 1)
  const figureValue = (result: FigureResult) => result.total.value ?? 0
  const changeWords = (value: number, before: number): string =>
    value === before ? "lo mismo" : `${value > before ? `${money(value - before)} más` : `${money(before - value)} menos`}${before > 0 ? ` (${w.signed(value, before)})` : ""}`
  const countChange = (value: number, before: number): string =>
    value === before ? "los mismos" : `${Math.abs(value - before)} ${value > before ? "más" : "menos"}${before > 0 ? ` (${w.signed(value, before)})` : ""}`
  const range = (from: string, to: string) => `${from}..${to}`
  const centsIn = (list: Array<{ currency: string; cents: number }> | undefined) => list?.find((item) => item.currency === currency)?.cents ?? 0
  /** El primer instante de un día de la clínica como fecha; el de mañana o después se corta en ahora. */
  const startOf = async (key: string) => new Date(await dayStart(h, key))
  const endOf = async (key: string) => {
    const end = await startOf(key)
    return end.getTime() > h.now.getTime() ? h.now : end
  }

  const branches = () => tx.execute<{ id: string; name: string }>(sql`select id, name from branch where organization_id = ${org} and is_active order by name`)
  /** Productos cuyo nombre o código coincide (sin tildes ni mayúsculas). */
  const productsLike = (pattern: string) =>
    tx.execute<{ id: string; name: string; unit: string; isActive: boolean }>(sql`
      select id, name, unit, is_active as "isActive" from product
      where organization_id = ${org} and (translate(lower(name), 'áéíóúü', 'aeiouu') ~ ${pattern} or lower(sku) ~ ${pattern})
      order by name`)
  /** Cada producto de cada sede activa, como lo muestra Inventario hoy. */
  const bySede = async () => {
    const list = await branches()
    const found: Array<ProductListItem & { branch: string; branchId: string }> = []
    for (const branch of list) {
      const products = await listProducts(tx, org, { branchId: branch.id, now: h.now })
      for (const item of products.items) found.push({ ...item, branch: branch.name, branchId: branch.id })
    }
    return { branches: list, found }
  }
  /** Lo cargado a los pacientes (pagado o no) en un tramo, sin anulados. */
  const chargedIn = async (start: string, end: string) => {
    const [row] = await tx.execute<{ count: number; cents: string }>(sql`
      select count(*)::int as count, coalesce(sum(c.amount_cents), 0)::text as cents from patient_charge c
      where c.organization_id = ${org} and c.voided_at is null and c.currency = ${currency}
        and c.created_at >= ${start}::timestamptz and c.created_at < ${end}::timestamptz`)
    return { count: row?.count ?? 0, cents: Number(row?.cents ?? 0) }
  }
  /** Lo vendido (criterio 3): pagos vigentes del tramo aplicados a tratamientos y productos sin anular. */
  const soldIn = async (start: string, end: string) => {
    const [row] = await tx.execute<{ cents: string }>(sql`
      select coalesce(sum(a.amount_cents), 0)::text as cents from patient_payment_application a
      join patient_payment pay on pay.organization_id = a.organization_id and pay.id = a.payment_id and pay.voided_at is null
      join patient_charge c on c.organization_id = a.organization_id and c.id = a.charge_id and c.voided_at is null
      where a.organization_id = ${org} and a.voided_at is null and pay.currency = ${currency}
        and pay.paid_at >= ${start}::timestamptz and pay.paid_at < ${end}::timestamptz`)
    return Number(row?.cents ?? 0)
  }
  /** Lo cobrado de cada sede en un periodo de Reportes, con la cifra de toda la clínica. */
  const sedeWords = (result: FigureResult) => listOf(result.rows.map((row) => ({ name: row.label, value: show(result, row.value.value) })))
  /** Movimientos con su almacén de verdad: la entrada de un traslado es del almacén de destino. */
  const movements = sql`moves as (
    select m.id, m.product_id, m.kind, m.created_at, m.quantity_delta, m.encounter_id,
      case when m.kind = 'traslado' and m.quantity_delta > 0 then m.dest_warehouse_id else m.warehouse_id end as warehouse_id
    from stock_movement m where m.organization_id = ${org})`

  return {
    g151: async () => {
      const matches = await productsLike(BRACKETS)
      const { branches: sedes, found } = await bySede()
      const stocked = sedes.map((branch) => ({ name: branch.name, items: found.filter((item) => item.branchId === branch.id && item.onHand > 0) }))
      if (matches.length) {
        const ids = new Set(matches.map((row) => row.id))
        const unit = matches[0]?.unit ?? "unidad"
        const totals = sedes
          .map((branch) => ({ name: branch.name, onHand: found.filter((item) => item.branchId === branch.id && ids.has(item.id)).reduce((sum, item) => sum + item.onHand, 0) }))
          .sort((a, b) => b.onHand - a.onHand || a.name.localeCompare(b.name))
        const top = totals[0]
        return {
          respuesta: top && top.onHand > 0
            ? `Hoy donde más brackets hay es ${top.name}: ${unitsWord(top.onHand, unit)}. Por sede: ${listOf(totals.map((row) => ({ name: row.name, value: unitsWord(row.onHand, unit) })))}.`
            : `Hoy no hay brackets en ninguna sede: ${listOf(totals.map((row) => ({ name: row.name, value: unitsWord(row.onHand, unit) })))}.`,
          criterio: "Lo que hay hoy de los productos «bracket» en cada sede (lotes − faltante, como Inventario), en su unidad de uso.",
          datos: { productos: matches, porSede: totals },
        }
      }
      const services = await tx.execute<{ name: string; materials: number }>(sql`
        select s.name, count(sm.id)::int as materials from service_catalog s
        left join service_material sm on sm.organization_id = s.organization_id and sm.service_id = s.id
        where s.organization_id = ${org} and s.is_active
          and translate(lower(s.name), 'áéíóúü', 'aeiouu') ~ ${`${BRACKETS}|aparatologia fija|ortodoncia fija`}
        group by s.name order by s.name`)
      const withMaterials = services.filter((row) => row.materials > 0)
      return {
        respuesta: `No hay brackets en el inventario: ningún producto de ninguna sede se llama así, así que no puedo decir dónde hay más. Lo que sí hay hoy, por sede: ${listOf(stocked.map((row) => ({ name: row.name, value: row.items.length ? `${row.items.length} ${row.items.length === 1 ? "producto" : "productos"} con existencias` : "sin existencias" })))}.`,
        criterio: "Productos de Inventario (activos o no) cuyo nombre o código dice «bracket»: ninguno. Se ofrece lo que hay hoy en cada sede (lotes − faltante, como Inventario).",
        nota: `Por sede: ${stocked
          .filter((row) => row.items.length)
          .map((row) => `en ${row.name}, ${listOf(row.items.map((item) => ({ name: item.name, value: unitsWord(item.onHand, item.unit) })))}`)
          .join("; ")}.${services.length ? ` En los servicios sí está ${services.map((row) => `«${row.name}»`).join(", ")}, ${withMaterials.length ? "con materiales del inventario, pero ninguno es un bracket" : "sin materiales del inventario asignados"}.` : ""}`,
        datos: { productos: [], porSede: stocked.map((row) => ({ sede: row.name, productos: row.items.map((item) => ({ name: item.name, onHand: item.onHand, unit: item.unit })) })), servicios: services },
      }
    },

    g152: async () => {
      const matches = await productsLike(IMPRESSION)
      const sedes = await branches()
      const surco = sedes.find((row) => /surco/i.test(row.name))
      const miraflores = sedes.find((row) => /miraflores/i.test(row.name))
      const used = await tx.execute<{ branchId: string; productId: string; name: string; unit: string; usedInCare: boolean; units: number }>(sql`
        select w.branch_id as "branchId", pr.id as "productId", pr.name, pr.unit, pr.used_in_care as "usedInCare", sum(-m.quantity_delta)::int as units
        from stock_movement m
        join warehouse w on w.organization_id = m.organization_id and w.id = m.warehouse_id
        join product pr on pr.organization_id = m.organization_id and pr.id = m.product_id
        where m.organization_id = ${org} and m.kind = 'consumo' and m.created_at >= ${h.monthStart}::timestamptz and m.created_at < ${nowIso}::timestamptz
        group by 1, 2, 3, 4, 5 order by 6 desc, 3`)
      const [activity] = await tx.execute<{ moves: number; lots: number }>(sql`
        select (select count(*) from stock_movement m join warehouse w on w.organization_id = m.organization_id and w.id = m.warehouse_id
            where m.organization_id = ${org} and w.branch_id = ${surco?.id ?? null}::uuid)::int as moves,
          (select count(*) from product_lot l join warehouse w on w.organization_id = l.organization_id and w.id = l.warehouse_id
            where l.organization_id = ${org} and w.branch_id = ${surco?.id ?? null}::uuid and l.quantity_on_hand > 0)::int as lots`)
      const spent = await tx.execute<{ branchId: string; cents: string }>(sql`
        select e.branch_id as "branchId", coalesce(sum(e.amount_cents), 0)::text as cents from expense e
        where e.organization_id = ${org} and e.voided_at is null and e.currency = ${currency} and e.category = 'Materiales'
          and e.spent_at >= ${h.monthStart}::timestamptz and e.spent_at < ${nowIso}::timestamptz
        group by 1`)
      const usedAt = (branchId: string | undefined, ids?: Set<string>) =>
        used.filter((row) => row.branchId === branchId && (ids ? ids.has(row.productId) : row.usedInCare))
      const usedWords = (rows: Array<(typeof used)[number]>) => listOf(rows.map((row) => ({ name: row.name, value: unitsWord(row.units, row.unit) })))
      const spentAt = (branchId: string | undefined) => Number(spent.find((row) => row.branchId === branchId)?.cents ?? 0)
      const moneyNote = `Si «gastó» es dinero: gastos de Materiales registrados ${w.monthSoFar}, ${surco?.name ?? "Surco"} ${money(spentAt(surco?.id))} y ${miraflores?.name ?? "Miraflores"} ${money(spentAt(miraflores?.id))}.`
      if (!surco || !miraflores) {
        return {
          respuesta: `No tengo una sede ${!surco ? "Surco" : "Miraflores"}: las sedes activas son ${sedes.map((row) => row.name).join(", ")}.`,
          criterio: "Sedes activas de la clínica.",
          datos: { sedes },
        }
      }
      if (matches.length) {
        const ids = new Set(matches.map((row) => row.id))
        const a = usedAt(surco.id, ids).reduce((sum, row) => sum + row.units, 0)
        const b = usedAt(miraflores.id, ids).reduce((sum, row) => sum + row.units, 0)
        return {
          respuesta: `${capital(w.monthSoFar)}, de material de impresión ${surco.name} consumió ${usedWords(usedAt(surco.id, ids)) || "nada"} y ${miraflores.name} ${usedWords(usedAt(miraflores.id, ids)) || "nada"}: ${a > b ? `${surco.name} gastó más` : a < b ? `${miraflores.name} gastó más` : "lo mismo"}.`,
          criterio: "Movimientos de consumo de Inventario del mes en curso de los productos de material de impresión, por sede y en su unidad de uso.",
          nota: moneyNote,
          datos: { productos: matches, surco: usedAt(surco.id, ids), miraflores: usedAt(miraflores.id, ids), gastos: spent },
        }
      }
      const mira = usedAt(miraflores.id)
      const sur = usedAt(surco.id)
      const surcoWords = sur.length
        ? `${surco.name} consumió ${usedWords(sur)}`
        : `${surco.name} no ${activity?.moves || activity?.lots ? "consumió nada" : "tiene inventario: ni existencias ni movimientos registrados"}`
      return {
        respuesta: `No tengo material de impresión en el inventario: ningún producto se llama así (alginato, silicona ni otro), así que no puedo comparar lo que gastó cada sede. Lo que sí se usó ${w.monthSoFar}: ${surcoWords}; ${mira.length ? `${miraflores.name} consumió ${usedWords(mira)}` : `${miraflores.name} no consumió nada`}.`,
        criterio: "Productos de Inventario cuyo nombre o código es material de impresión: ninguno. Se ofrecen los movimientos de consumo de insumos del mes en curso de las dos sedes, en su unidad de uso.",
        nota: moneyNote,
        datos: { productos: [], surco: sur, miraflores: mira, surcoActividad: activity, gastos: spent },
      }
    },

    g153: async () => {
      // «Desde julio»: nada después de julio (lo último, en julio o antes); julio de este año si ya terminó.
      const julyYear = currentMonth > 7 ? year : year - 1
      const after = (await startOf(`${julyYear}-08-01`)).toISOString()
      const fromJuly = (await startOf(`${julyYear}-07-01`)).toISOString()
      const rows = await tx.execute<{ productId: string; branchId: string; lastOut: string | null; lastAny: string | null; firstIn: string | null; outsAfter: number; outsJuly: number; anyAfter: number; anyJuly: number }>(sql`
        with ${movements}
        select m.product_id as "productId", w.branch_id as "branchId",
          to_char(max(m.created_at at time zone ${tz}) filter (where m.kind in ('consumo', 'venta')), 'YYYY-MM-DD') as "lastOut",
          to_char(max(m.created_at at time zone ${tz}), 'YYYY-MM-DD') as "lastAny",
          to_char(min(m.created_at at time zone ${tz}) filter (where m.kind = 'ingreso' or (m.kind = 'traslado' and m.quantity_delta > 0)), 'YYYY-MM-DD') as "firstIn",
          count(*) filter (where m.kind in ('consumo', 'venta') and m.created_at >= ${after}::timestamptz)::int as "outsAfter",
          count(*) filter (where m.kind in ('consumo', 'venta') and m.created_at >= ${fromJuly}::timestamptz)::int as "outsJuly",
          count(*) filter (where m.created_at >= ${after}::timestamptz)::int as "anyAfter",
          count(*) filter (where m.created_at >= ${fromJuly}::timestamptz)::int as "anyJuly"
        from moves m join warehouse w on w.organization_id = ${org} and w.id = m.warehouse_id
        group by 1, 2`)
      const { found } = await bySede()
      const items = found
        .filter((item) => item.onHand > 0)
        .map((item) => {
          const row = rows.find((entry) => entry.productId === item.id && entry.branchId === item.branchId)
          return { name: item.name, branch: item.branch, unit: item.unit, onHand: item.onHand, lastOut: row?.lastOut ?? null, lastAny: row?.lastAny ?? null, firstIn: row?.firstIn ?? null, outsAfter: row?.outsAfter ?? 0, outsJuly: row?.outsJuly ?? 0, anyAfter: row?.anyAfter ?? 0, anyJuly: row?.anyJuly ?? 0 }
        })
      const byAge = (a: (typeof items)[number], b: (typeof items)[number]) => (a.lastOut ?? "").localeCompare(b.lastOut ?? "") || a.name.localeCompare(b.name) || a.branch.localeCompare(b.branch)
      const idle = items.filter((item) => item.outsAfter === 0).sort(byAge)
      const idleJuly = items.filter((item) => item.outsJuly === 0)
      const still = items.filter((item) => item.anyAfter === 0).sort((a, b) => (a.lastAny ?? "").localeCompare(b.lastAny ?? ""))
      const quietest = [...items].sort((a, b) => (a.lastAny ?? "").localeCompare(b.lastAny ?? ""))[0]
      const never = await tx.execute<{ name: string; isActive: boolean }>(sql`
        select pr.name, pr.is_active as "isActive" from product pr
        where pr.organization_id = ${org} and not exists (select 1 from stock_movement m where m.organization_id = pr.organization_id and m.product_id = pr.id)
        order by pr.name`)
      const words = (list: typeof items) =>
        listOf(
          list.map((item) => ({
            name: `${item.name} en ${item.branch}`,
            value: `${unitsWord(item.onHand, item.unit)}; ${item.lastOut ? `último uso o venta el ${dateWords(item.lastOut)}` : `nunca se usó ni vendió${item.firstIn ? `, llegó el ${dateWords(item.firstIn)}` : ""}`}`,
          })),
        )
      return {
        respuesta: idle.length
          ? `Hoy tienen existencias y no se usaron ni vendieron desde julio (nada después del 31 de julio de ${julyYear}) ${idle.length} ${idle.length === 1 ? "producto" : "productos"}: ${words(idle)}. Todo lo demás con existencias sí salió después de julio.`
          : `Todo lo que tiene existencias hoy se usó o vendió después de julio de ${julyYear}.`,
        criterio: "Productos con existencias hoy en cada sede (lotes − faltante, como Inventario) sin ningún movimiento de salida (uso en atenciones, uso sin atención o venta) desde el 1 de agosto; «moverse» es salir del inventario.",
        nota: `Contando cualquier movimiento (también compras recibidas, traslados y ajustes): ${still.length ? `sin ninguno después de julio, ${listOf(still.map((item) => ({ name: `${item.name} en ${item.branch}`, value: item.lastAny ? `último movimiento el ${dateWords(item.lastAny)}` : "nunca tuvo" })))}` : `todos tuvieron alguno después de julio; el más quieto es ${quietest ? `${quietest.name} en ${quietest.branch} (último movimiento el ${dateWords(quietest.lastAny ?? today)})` : "—"}`}.${idleJuly.length !== idle.length ? ` Mirando desde el 1 de julio: ${idleJuly.length} sin salidas.` : ""}${never.length ? ` Sin ningún movimiento ni existencias desde siempre: ${never.map((row) => `${row.name}${row.isActive ? "" : " (desactivado)"}`).join(", ")}.` : ""}`,
        datos: { sinSalidas: idle, sinMovimiento: still, todos: items, nuncaSeMovieron: never },
      }
    },

    g154: async () => {
      const products = await productsLike(ANESTHESIA)
      if (!products.length) {
        return {
          respuesta: "No tengo anestesia en el inventario: ningún producto se llama así, así que no hay compras de anestesia registradas.",
          criterio: "Productos de Inventario de anestesia (lidocaína, articaína, mepivacaína…): ninguno.",
          datos: { productos: [] },
        }
      }
      const lines = await tx.execute<{ orderNumber: number; status: string; supplier: string; branch: string; quantity: number; received: number; purchaseUnit: string | null; factor: number; unitCost: number; product: string; unit: string; day: string; orderedDay: string }>(sql`
        select o.order_number as "orderNumber", o.status, s.name as supplier, b.name as branch, pl.quantity, pl.received_quantity as received,
          pl.purchase_unit as "purchaseUnit", pl.unit_factor as factor, pl.unit_cost_cents as "unitCost", pr.name as product, pr.unit,
          to_char(coalesce(r.last_at, o.created_at) at time zone ${tz}, 'YYYY-MM-DD') as day,
          to_char(o.created_at at time zone ${tz}, 'YYYY-MM-DD') as "orderedDay"
        from purchase_order_line pl
        join purchase_order o on o.organization_id = pl.organization_id and o.id = pl.order_id
        join supplier s on s.organization_id = o.organization_id and s.id = o.supplier_id
        join warehouse w on w.organization_id = o.organization_id and w.id = o.warehouse_id
        join branch b on b.organization_id = w.organization_id and b.id = w.branch_id
        join product pr on pr.organization_id = pl.organization_id and pr.id = pl.product_id
        left join lateral (
          select max(m.created_at) as last_at from stock_movement m
          where m.organization_id = pl.organization_id and m.purchase_order_id = o.id and m.product_id = pl.product_id and m.kind = 'ingreso'
        ) r on true
        where pl.organization_id = ${org} and pl.product_id in (${sql.join(products.map((row) => sql`${row.id}::uuid`), sql`, `)})
        order by coalesce(r.last_at, o.created_at) desc, o.order_number desc`)
      const received = lines.filter((line) => line.received > 0)
      const lastDay = received[0]?.day
      const sameDay = received.filter((line) => line.day === lastDay)
      const earlierDay = received.find((line) => line.day !== lastDay)?.day
      const earlier = received.filter((line) => line.day === earlierDay)
      const open = lines.filter((line) => ["confirmada", "parcialmente_recibida"].includes(line.status) && line.received < line.quantity)
      const packs = (count: number, line: (typeof lines)[number]) =>
        line.purchaseUnit && line.factor > 1 ? `${unitsWord(count, line.purchaseUnit)} de ${unitsWord(line.factor, line.unit)}` : unitsWord(count * line.factor, line.unit)
      const lineWords = (list: Array<(typeof lines)[number]>) =>
        listOf(
          list.map((line) => ({
            name: `${purchaseOrderLabel(line.orderNumber)} de ${line.supplier}`,
            value: `${line.received < line.quantity ? `${line.received} de ${packs(line.quantity, line)} pedidas` : packs(line.received, line)}, ${money(line.received * line.unitCost)}, para ${line.branch}${line.orderedDay !== line.day ? `; pedida el ${dateWords(line.orderedDay)}` : ""}`,
          })),
        )
      const names = [...new Set(lines.map((line) => line.product))].join(", ") || products.map((row) => row.name).join(", ")
      return {
        respuesta: lastDay
          ? `La última compra de anestesia (${names}) llegó ${whenWords(lastDay)}: ${lineWords(sameDay)}.`
          : `No hay compras de anestesia recibidas: ${products.map((row) => row.name).join(", ")} no tiene ninguna compra que haya llegado.`,
        criterio: "La «Última compra» de Inventario de los productos de anestesia: la línea de compra recibida más reciente, por el día en que llegó (su ingreso al inventario).",
        nota: `${earlierDay ? `La anterior llegó el ${dayName(earlierDay)}: ${lineWords(earlier)}. ` : ""}${open.length ? `Por llegar: ${listOf(open.map((line) => ({ name: `${purchaseOrderLabel(line.orderNumber)} de ${line.supplier}`, value: `${packs(line.quantity - line.received, line)}, pedida el ${dateWords(line.orderedDay)}` })))}.` : "No hay pedidos de anestesia por llegar."}`,
        datos: { productos: products, ultimas: sameDay, anteriores: earlier, porLlegar: open },
      }
    },

    g155: async () => {
      const ran = await tx.execute<{ productId: string; branchId: string; branch: string; name: string; unit: string; day: string; lowest: number }>(sql`
        with ${movements},
        balance as (select m.*, sum(m.quantity_delta) over (partition by m.product_id, m.warehouse_id order by m.created_at, m.quantity_delta desc, m.id) as bal from moves m)
        select x.product_id as "productId", w.branch_id as "branchId", b.name as branch, pr.name, pr.unit,
          to_char(min(x.created_at at time zone ${tz}), 'YYYY-MM-DD') as day, min(x.bal)::int as lowest
        from balance x
        join warehouse w on w.organization_id = ${org} and w.id = x.warehouse_id
        join branch b on b.organization_id = w.organization_id and b.id = w.branch_id
        join product pr on pr.organization_id = ${org} and pr.id = x.product_id
        where x.created_at >= ${h.monthStart}::timestamptz and x.created_at < ${nowIso}::timestamptz and x.bal <= 0
        group by 1, 2, 3, 4, 5 order by 6, 4`)
      const { branches: sedes, found } = await bySede()
      const rows = ran.map((row) => {
        const item = found.find((entry) => entry.id === row.productId && entry.branchId === row.branchId)
        return { ...row, onHand: item?.onHand ?? 0, shortage: item?.shortage ?? 0 }
      })
      const out = found.filter((item) => item.isActive && item.onHand <= 0 && (item.shortage > 0 || item.minQuantity > 0) && !rows.some((row) => row.productId === item.id && row.branchId === item.branchId))
      const short = found.filter((item) => item.needs)
      const empty = sedes.filter((branch) => !found.some((item) => item.branchId === branch.id && item.onHand > 0))
      const words = listOf(
        rows.map((row) => ({
          name: `${row.name} en ${row.branch}`,
          value:
            row.onHand <= 0
              ? `desde el ${dayName(row.day)}; hoy en ${row.onHand}${row.shortage > 0 ? `: se usaron o vendieron ${unitsWord(row.shortage, row.unit)} sin haber` : ""}`
              : `el ${dayName(row.day)} se ${-row.lowest === 1 ? "usó" : "usaron"} ${unitsWord(-row.lowest, row.unit)} sin haber; ya se repuso y hoy hay ${unitsWord(row.onHand, row.unit)}`,
        })),
      )
      return {
        respuesta: rows.length
          ? `${capital(w.monthSoFar)} se ${rows.length === 1 ? "quedó" : "quedaron"} sin existencias ${rows.length} ${rows.length === 1 ? "producto" : "productos"}: ${words}.`
          : `${capital(w.monthSoFar)} ningún producto se quedó sin existencias en ninguna sede.`,
        criterio: "Productos que este mes llegaron a 0 o menos en una sede (el saldo de sus movimientos de Inventario tras cada uno, por almacén), con lo que hay hoy (lotes − faltante, como Inventario).",
        nota: `Hoy están por debajo de su mínimo o se usaron sin haber («Hacen falta» de Inventario): ${listOf(short.map((item) => ({ name: `${item.name} en ${item.branch}`, value: `hay ${unitsWord(item.onHand, item.unit)}, mínimo ${item.minQuantity}` }))) || "ninguno"}.${out.length ? ` En 0 o menos, pero sin movimientos este mes (nunca tuvo o se acabó antes): ${out.map((item) => `${item.name} en ${item.branch}`).join(", ")}.` : ""}${empty.length ? ` ${empty.map((branch) => branch.name).join(" y ")} no ${empty.length === 1 ? "tiene" : "tienen"} existencias de ningún producto.` : ""}`,
        datos: { seAcabaron: rows, hacenFalta: short.map((item) => ({ name: item.name, branch: item.branch, onHand: item.onHand, min: item.minQuantity, shortage: item.shortage })), sinExistencias: empty },
      }
    },

    g156: async () => {
      const day = `${yearOfDay("10-15")}-10-15`
      const result = await h.fig("cobrado", "total", range(day, day))
      const start = (await startOf(day)).toISOString()
      const end = (await endOf(w.addDays(day, 1))).toISOString()
      const [payments] = await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from patient_payment p
        where p.organization_id = ${org} and p.voided_at is null and p.currency = ${currency}
          and p.paid_at >= ${start}::timestamptz and p.paid_at < ${end}::timestamptz`)
      const charged = await chargedIn(start, end)
      return {
        respuesta: `El ${dayName(day)} se cobraron ${show(result)}, sin lo anulado ni lo devuelto.`,
        criterio: "«Lo cobrado» de Reportes de ese día (pagos menos anulaciones y devoluciones), en el día de la clínica.",
        nota: `Fueron ${payments?.count ?? 0} pagos vigentes. Lo cargado ese día a los pacientes (pagado o no): ${money(charged.cents)} en ${charged.count} conceptos.`,
        datos: { dia: day, cobrado: result.total, pagos: payments?.count ?? 0, cargado: charged },
      }
    },

    g157: async () => {
      const result = await h.fig("atendidas", "sede", range(yesterday, yesterday))
      const start = (await startOf(yesterday)).toISOString()
      const end = (await startOf(today)).toISOString()
      const [row] = await tx.execute<{ noShow: number; cancelled: number; unmarked: number; patients: number; all: number }>(sql`
        select count(*) filter (where a.status = 'no_asistio')::int as "noShow",
          count(*) filter (where a.status = 'cancelada')::int as cancelled,
          count(*) filter (where a.status in ('programada', 'confirmada'))::int as unmarked,
          count(distinct a.patient_id) filter (where a.status = 'atendida')::int as patients,
          count(*)::int as all
        from appointment a where a.organization_id = ${org} and a.starts_at >= ${start}::timestamptz and a.starts_at < ${end}::timestamptz`)
      const count = figureValue(result)
      const sedes = result.rows.length
      const unmarked = row?.unmarked ?? 0
      return {
        respuesta: `Ayer (${w.dayWords(yesterday)}) ${count === 0 ? "no se marcó ninguna cita como atendida" : `se ${count === 1 ? "atendió 1 cita" : `atendieron ${count} citas`}`} entre ${sedes === 3 ? "las tres" : `las ${sedes}`} sedes: ${sedeWords(result)}.${unmarked ? ` ${unmarked === 1 ? "1 cita de ayer quedó" : unmarked === row?.all ? `Las ${unmarked} citas de ayer quedaron` : `${unmarked} de las ${row?.all ?? 0} citas de ayer quedaron`} sin marcar si el paciente vino.` : ""}`,
        criterio: "«Citas atendidas» de Reportes de ayer (día de la clínica), por sede y en total.",
        nota: `De las citas de ayer, además: ${row?.noShow ?? 0} no vinieron y ${row?.cancelled ?? 0} se cancelaron. Pacientes distintos atendidos: ${row?.patients ?? 0}.`,
        datos: { dia: yesterday, total: result.total, porSede: result.rows, otras: row },
      }
    },

    g158: async () => {
      const thisStart = await startOf(monday)
      const lastMonday = w.addDays(monday, -7)
      const lastStart = await startOf(lastMonday)
      const lastEnd = new Date(lastStart.getTime() + (h.now.getTime() - thisStart.getTime()))
      const [current, before] = await collectedNetMany(tx, org, [
        { start: thisStart, end: h.now },
        { start: lastStart, end: lastEnd },
      ])
      const value = centsIn(current)
      const previous = centsIn(before)
      const wholeWeek = await h.fig("cobrado", "total", range(lastMonday, w.addDays(monday, -1)))
      const sameDays = await h.fig("cobrado", "total", range(lastMonday, w.addDays(today, -7)))
      return {
        respuesta: `Esta semana (${spanWords(monday, today)}, hasta ahora) llevas ${money(value)} cobrados; la semana pasada a la misma altura (${spanWords(lastMonday, w.addDays(today, -7))}, hasta la misma hora) llevabas ${money(previous)}: ${changeWords(value, previous)}.`,
        criterio: "«Lo cobrado» (pagos menos anulaciones y devoluciones) de esta semana, del lunes a ahora, contra la semana pasada del lunes a la misma hora del mismo día (la comparación de Reportes).",
        nota: `La semana pasada completa (${spanWords(lastMonday, w.addDays(monday, -1))}): ${show(wholeWeek)}. Sus mismos días enteros (${spanWords(lastMonday, w.addDays(today, -7))}): ${show(sameDays)}.`,
        datos: { semana: value, semanaPasadaMismaHora: previous, semanaPasadaCompleta: wholeWeek.total, mismosDiasEnteros: sameDays.total, desde: monday },
      }
    },

    g159: async () => {
      const y = yearOfDay("09-15")
      const result = await h.fig("cobrado", "total", range(`${y}-09-01`, `${y}-09-15`))
      const second = `${y}-09-30` <= today ? await h.fig("cobrado", "total", range(`${y}-09-16`, `${y}-09-30`)) : null
      const august = await h.fig("cobrado", "total", range(`${y}-08-01`, `${y}-08-15`))
      const charged = await chargedIn((await startOf(`${y}-09-01`)).toISOString(), (await endOf(`${y}-09-16`)).toISOString())
      return {
        respuesta: `Del 1 al 15 de setiembre de ${y} entraron ${show(result)} cobrados, sin lo anulado ni lo devuelto.`,
        criterio: "«Lo cobrado» de Reportes del 1 al 15 de setiembre (pagos menos anulaciones y devoluciones), en el día de la clínica.",
        nota: `${second ? `Del 16 al 30 de setiembre: ${show(second)}. ` : ""}Del 1 al 15 de agosto: ${show(august)}. Lo cargado a los pacientes del 1 al 15 de setiembre (pagado o no): ${money(charged.cents)}.`,
        datos: { cobrado: result.total, segundaQuincena: second?.total ?? null, agosto: august.total, cargado: charged },
      }
    },

    g160: async () => {
      const from = w.addDays(today, -89)
      const result = await h.fig("pacientes_nuevos", "total", range(from, today))
      const sought = await h.fig("nos_buscaron", "total", range(from, today))
      const start = (await startOf(from)).toISOString()
      const [row] = await tx.execute<{ registered: number }>(sql`
        select count(*)::int as registered from patient p
        join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id and pp.screen is null
        where p.organization_id = ${org} and p.created_at >= ${start}::timestamptz and p.created_at < ${nowIso}::timestamptz`)
      const value = figureValue(result)
      const before = result.previous?.value ?? 0
      return {
        respuesta: `En los últimos 90 días (del ${dateWords(from, from.slice(0, 4) !== today.slice(0, 4))} al ${dateWords(today)}) llegaron ${value} pacientes nuevos: personas cuya primera cita atendida cae en esos días. En los 90 días anteriores fueron ${before}: ${countChange(value, before)}.`,
        criterio: "«Pacientes nuevos» de Reportes de los 90 días que terminan hoy, contra los 90 días anteriores hasta la misma hora.",
        nota: `Si «nuevo» es la ficha de paciente registrada en esos 90 días, aunque aún no se atienda: ${row?.registered ?? 0}. Personas que nos buscaron por primera vez en esos días, por cualquier canal: ${sought.total.value ?? 0}.`,
        datos: { desde: from, total: result.total, anterior: result.previous, registrados: row?.registered ?? 0, nosBuscaron: sought.total },
      }
    },

    g161: async () => {
      const y = yearOfMonth(7)
      const march = await h.fig("cobrado", "total", monthKey(y, 3))
      const july = await h.fig("cobrado", "total", monthKey(y, 7))
      const bounds = async (month: number) => ({ start: (await startOf(`${monthKey(y, month)}-01`)).toISOString(), end: (await endOf(`${monthKey(month === 12 ? y + 1 : y, month === 12 ? 1 : month + 1)}-01`)).toISOString() })
      const m3 = await bounds(3)
      const m7 = await bounds(7)
      const sold = { march: await soldIn(m3.start, m3.end), july: await soldIn(m7.start, m7.end) }
      const charged = { march: await chargedIn(m3.start, m3.end), july: await chargedIn(m7.start, m7.end) }
      const a = figureValue(march)
      const b = figureValue(july)
      const top = a >= b ? { name: "marzo", value: a, other: "julio", otherValue: b } : { name: "julio", value: b, other: "marzo", otherValue: a }
      return {
        respuesta: `Por lo cobrado, vendió más ${top.name} de ${y}: ${money(top.value)} contra ${money(top.otherValue)} de ${top.other}, ${money(top.value - top.otherValue)} más${top.otherValue > 0 ? ` (${w.signed(top.value, top.otherValue)})` : ""}.`,
        criterio: "«Lo cobrado» de Reportes de marzo y de julio completos (pagos menos anulaciones y devoluciones); «vender» es lo cobrado en Reportes.",
        nota: `Si «vendió» es solo lo pagado aplicado a tratamientos y productos (sin adelantos ni saldo a favor): marzo ${money(sold.march)}, julio ${money(sold.july)}. Por lo cargado a los pacientes (pagado o no): marzo ${money(charged.march.cents)}, julio ${money(charged.july.cents)}.`,
        datos: { año: y, marzo: march.total, julio: july.total, vendido: sold, cargado: charged },
      }
    },

    g162: async () => {
      const result = await h.fig("cobrado", "total", "este_ano")
      const full = await h.fig("cobrado", "total", range(`${year - 1}-01-01`, `${year - 1}-12-31`))
      const value = figureValue(result)
      const before = result.previous?.value ?? 0
      return {
        respuesta: `En cobros vas ${value >= before ? "mejor" : "peor"} que el año pasado: en lo que va de ${year} (del 1 de enero al ${dateWords(today, false)}) cobraste ${money(value)}; en los mismos días de ${year - 1}, ${money(before)}: ${changeWords(value, before)}.`,
        criterio: "«Lo cobrado» de Reportes de este año hasta ahora contra el mismo tramo del año anterior (del 1 de enero a la misma fecha y hora).",
        nota: `Todo ${year - 1}, de enero a diciembre: ${show(full)}${value < figureValue(full) ? `; para igualarlo faltan ${money(figureValue(full) - value)}` : ""}.`,
        datos: { año: result.total, mismoTramoAnterior: result.previous, añoPasadoCompleto: full.total },
      }
    },

    g163: async () => {
      const result = await h.fig("cobrado", "mes")
      const year2 = await h.fig("cobrado", "total", "este_ano")
      const months = result.months.filter((month) => month.month.year === year)
      const closed = months.filter((month) => !month.partial)
      const average = closed.length ? closed.reduce((sum, month) => sum + (month.value.value ?? 0), 0) / closed.length : 0
      const best = [...closed].sort((a, b) => (b.value.value ?? 0) - (a.value.value ?? 0))[0]
      return {
        respuesta: `Lo cobrado mes a mes en ${year}: ${listOf(months.map((month) => ({ name: monthLabel(h, month.month, false), value: `${show(result, month.value.value)}${month.partial ? ", hasta hoy" : ""}` })))}. En total, ${show(year2)}.`,
        criterio: "«Lo cobrado» de Reportes por mes (pagos menos anulaciones y devoluciones) de enero al mes en curso, que va hasta hoy.",
        nota: `Promedio de los ${closed.length} meses cerrados: ${money(Math.round(average))}${best ? `; el mejor, ${monthLabel(h, best.month, false)} (${show(result, best.value.value)})` : ""}.`,
        datos: { meses: months, total: year2.total },
      }
    },

    g164: async () => {
      const result = await h.fig("atendidas", "mes")
      const year2 = await h.fig("atendidas", "total", "este_ano")
      const months = result.months.filter((month) => month.month.year === year)
      const closed = months.filter((month) => !month.partial)
      const sorted = [...closed].sort((a, b) => (b.value.value ?? 0) - (a.value.value ?? 0))
      const best = sorted[0]
      const worst = sorted.at(-1)
      const value = figureValue(year2)
      const before = year2.previous?.value ?? 0
      return {
        respuesta: `Citas atendidas mes a mes desde enero de ${year}: ${listOf(months.map((month) => ({ name: monthLabel(h, month.month, false), value: `${month.value.value ?? 0}${month.partial ? ", hasta hoy" : ""}` })))}.${best && worst ? ` El mes con más fue ${monthLabel(h, best.month, false)} (${best.value.value ?? 0}) y el de menos, ${monthLabel(h, worst.month, false)} (${worst.value.value ?? 0}).` : ""}`,
        criterio: "«Citas atendidas» de Reportes por mes, de enero al mes en curso (que va hasta hoy).",
        nota: `En total ${value} en lo que va de ${year}; en los mismos días de ${year - 1}, ${before}: ${countChange(value, before)}.`,
        datos: { meses: months, total: year2.total, anterior: year2.previous },
      }
    },

    g165: async () => {
      const from = w.addDays(monday, -7)
      const to = w.addDays(monday, -1)
      const result = await h.fig("cobrado", "sede", range(from, to))
      const surco = result.rows.find((row) => /surco/i.test(row.label))
      if (!surco) {
        return {
          respuesta: `No tengo una sede Surco: las sedes activas son ${result.rows.map((row) => row.label).join(", ")}. La semana pasada (${spanWords(from, to)}) se cobró: ${sedeWords(result)}.`,
          criterio: "«Lo cobrado» de Reportes por sede de la semana pasada, de lunes a domingo.",
          datos: { porSede: result.rows },
        }
      }
      const seven = await h.fig("cobrado", "sede", range(w.addDays(today, -7), yesterday))
      const sevenSurco = seven.rows.find((row) => row.key === surco.key)
      const [ever] = await tx.execute<{ payments: number; appointments: number }>(sql`
        select (select count(*) from patient_payment p where p.organization_id = ${org} and p.branch_id = ${surco.key}::uuid)::int as payments,
          (select count(*) from appointment a where a.organization_id = ${org} and a.branch_id = ${surco.key}::uuid)::int as appointments`)
      const idle = (surco.value.value ?? 0) === 0 && !ever?.payments
      return {
        respuesta: `La semana pasada (${spanWords(from, to)}) ${surco.label} cobró ${show(result, surco.value.value)}, sin lo anulado ni lo devuelto.${idle ? ` ${surco.label} no tiene ningún cobro registrado${ever?.appointments ? "" : " (tampoco citas)"}.` : ""}`,
        criterio: "«Lo cobrado» de Reportes por sede de la semana pasada, de lunes a domingo (día de la clínica).",
        nota: `Esa semana, toda la clínica cobró ${show(result)}: ${sedeWords(result)}. Si «la semana pasada» son los 7 días antes de hoy (${spanWords(w.addDays(today, -7), yesterday)}): ${surco.label} ${show(seven, sevenSurco?.value.value ?? 0)}.`,
        datos: { desde: from, hasta: to, surco: surco.value, porSede: result.rows, total: result.total, sieteDias: sevenSurco?.value ?? null },
      }
    },

    g166: async () => {
      const y = yearOfDay("10-10")
      const period = range(`${y}-10-01`, `${y}-10-10`)
      const result = await h.fig("canceladas", "total", period)
      const bySede = await h.fig("canceladas", "sede", period)
      const count = result.total.part ?? 0
      return {
        respuesta: `Del 1 al 10 de octubre de ${y} se ${count === 1 ? "canceló 1 cita" : `cancelaron ${count} citas`}: el ${show(result)} de las ${result.total.whole ?? 0} citas de esos días que ya pasaron.`,
        criterio: "«Canceladas» de Reportes del 1 al 10 de octubre: citas de esos días que hoy están canceladas ÷ citas que ya pasaron (atendidas, no vinieron, canceladas y sin marcar).",
        nota: `Por sede: ${listOf(bySede.rows.map((row) => ({ name: row.label, value: `${row.value.part ?? 0} de ${row.value.whole ?? 0}` })))}. Se cuentan por el día de la cita: una cita no guarda el día en que se canceló.`,
        datos: { total: result.total, porSede: bySede.rows },
      }
    },

    g167: async () => {
      const y = yearOfMonth(9)
      const august = { start: (await startOf(`${y}-08-01`)).toISOString(), end: (await endOf(`${y}-09-01`)).toISOString() }
      const september = { start: august.end, end: (await endOf(`${y}-10-01`)).toISOString() }
      const seen = async (span: { start: string; end: string }) => {
        const [row] = await tx.execute<{ patients: number }>(sql`
          select count(distinct a.patient_id)::int as patients from appointment a
          where a.organization_id = ${org} and a.status = 'atendida' and a.starts_at >= ${span.start}::timestamptz and a.starts_at < ${span.end}::timestamptz`)
        return row?.patients ?? 0
      }
      const a = await seen(august)
      const b = await seen(september)
      const visitsA = await h.fig("atendidas", "total", monthKey(y, 8))
      const visitsB = await h.fig("atendidas", "total", monthKey(y, 9))
      const freshA = await h.fig("pacientes_nuevos", "total", monthKey(y, 8))
      const freshB = await h.fig("pacientes_nuevos", "total", monthKey(y, 9))
      return {
        respuesta: `En setiembre de ${y} se atendieron ${b} pacientes distintos y en agosto ${a}: ${countChange(b, a)} en setiembre.`,
        criterio: "Pacientes distintos con al menos una cita atendida en cada mes completo.",
        nota: `Contando citas atendidas («Citas atendidas» de Reportes): agosto ${visitsA.total.value ?? 0}, setiembre ${visitsB.total.value ?? 0}. De ellos, pacientes nuevos (su primera cita atendida): agosto ${freshA.total.value ?? 0}, setiembre ${freshB.total.value ?? 0}.`,
        datos: { agosto: { pacientes: a, citas: visitsA.total, nuevos: freshA.total }, setiembre: { pacientes: b, citas: visitsB.total, nuevos: freshB.total } },
      }
    },

    g168: async () => {
      const result = await h.fig("cobrado")
      const last = await h.fig("cobrado", "total", "mes_pasado")
      const value = figureValue(result)
      const before = result.previous?.value ?? 0
      return {
        respuesta: `Este mes (${w.monthSoFar}) llevas ${money(value)} cobrados; a esta misma fecha y hora del mes pasado, en ${w.previousSameDays}, llevabas ${money(before)}: ${changeWords(value, before)}.`,
        criterio: "«Lo cobrado» de Reportes del mes en curso contra los mismos días del mes anterior hasta la misma hora (la comparación de Reportes).",
        nota: `${capital(w.previousMonth)} completo: ${show(last)}.`,
        datos: { mes: result.total, anterior: result.previous, mesPasado: last.total },
      }
    },

    g169: async () => {
      const first = currentMonth > 6 ? year : year - 1
      const second = first - 1
      const h1 = range(`${first}-01-01`, `${first}-06-30`)
      const h2 = range(`${second}-07-01`, `${second}-12-31`)
      const figures = async (period: string) => ({
        collected: await h.fig("cobrado", "total", period),
        attended: await h.fig("atendidas", "total", period),
        fresh: await h.fig("pacientes_nuevos", "total", period),
        leaves: await h.fig("lo_que_deja", "total", period),
      })
      const a = await figures(h1)
      const b = await figures(h2)
      const earlier = await h.fig("cobrado", "total", range(`${second}-01-01`, `${second}-06-30`))
      const ca = figureValue(a.collected)
      const cb = figureValue(b.collected)
      return {
        respuesta: `Por lo cobrado, el primer semestre de ${first} (enero a junio) fue ${ca >= cb ? "mejor" : "peor"} que el segundo de ${second} (julio a diciembre): ${money(ca)} contra ${money(cb)}, ${changeWords(ca, cb)}. Citas atendidas: ${figureValue(a.attended)} contra ${figureValue(b.attended)}; pacientes nuevos: ${figureValue(a.fresh)} contra ${figureValue(b.fresh)}.`,
        criterio: "Las cifras de Reportes de enero a junio de este año contra julio a diciembre del año pasado: lo cobrado, las citas atendidas y los pacientes nuevos.",
        nota: `Lo que dejó cada semestre (lo cobrado menos comisiones y gastos registrados): ${show(a.leaves)} contra ${show(b.leaves)}. Si los dos semestres son del año pasado: enero a junio de ${second} cobró ${show(earlier)} contra ${money(cb)} de julio a diciembre.`,
        datos: { primero: { periodo: h1, cobrado: a.collected.total, atendidas: a.attended.total, nuevos: a.fresh.total, deja: a.leaves.total }, segundo: { periodo: h2, cobrado: b.collected.total, atendidas: b.attended.total, nuevos: b.fresh.total, deja: b.leaves.total }, primeroAñoPasado: earlier.total },
      }
    },

    g170: async () => {
      // El último trimestre del calendario ya cerrado (en octubre, de julio a setiembre).
      const quarter = Math.floor((currentMonth - 1) / 3)
      const qYear = quarter === 0 ? year - 1 : year
      const firstMonth = quarter === 0 ? 10 : (quarter - 1) * 3 + 1
      const from = `${monthKey(qYear, firstMonth)}-01`
      const to = w.addDays(`${monthKey(firstMonth + 3 > 12 ? qYear + 1 : qYear, firstMonth + 3 > 12 ? 1 : firstMonth + 3)}-01`, -1)
      const result = await h.fig("aceptaron", "total", range(from, to))
      const last90 = await h.fig("aceptaron", "total", range(w.addDays(today, -89), today))
      const start = (await startOf(from)).toISOString()
      const end = (await endOf(w.addDays(to, 1))).toISOString()
      const [row] = await tx.execute<{ full: number; partial: number; decided: number }>(sql`
        select count(*) filter (where b.status = 'aceptado' and b.presented_at >= ${start}::timestamptz and b.presented_at < ${end}::timestamptz)::int as full,
          count(*) filter (where b.status = 'parcial' and b.presented_at >= ${start}::timestamptz and b.presented_at < ${end}::timestamptz)::int as partial,
          count(*) filter (where b.status in ('aceptado', 'parcial') and b.decided_at >= ${start}::timestamptz and b.decided_at < ${end}::timestamptz)::int as decided
        from treatment_budget b where b.organization_id = ${org}`)
      const accepted = result.total.part ?? 0
      const months = `${monthLabel(h, { year: qYear, month: firstMonth }, false)} a ${monthLabel(h, { year: Number(to.slice(0, 4)), month: Number(to.slice(5, 7)) })}`
      return {
        respuesta: `En el último trimestre (${months}) se ${accepted === 1 ? "aceptó 1 presupuesto" : `aceptaron ${accepted} presupuestos`}, en todo o en parte: el ${show(result)} de los ${result.total.whole ?? 0} entregados en esos meses.`,
        criterio: "«Aceptaron su presupuesto» de Reportes del último trimestre cerrado: presupuestos entregados en esos meses aceptados en todo o en parte, según su respuesta a hoy.",
        nota: `De ellos, ${row?.full ?? 0} aceptados enteros y ${row?.partial ?? 0} en parte. Si cuentas por el día en que se aceptaron (aunque se entregaran antes): ${row?.decided ?? 0}. En los últimos 90 días: ${last90.total.part ?? 0} de ${last90.total.whole ?? 0} (${show(last90)}).`,
        datos: { desde: from, hasta: to, total: result.total, enteros: row?.full ?? 0, parciales: row?.partial ?? 0, porDiaDeAceptacion: row?.decided ?? 0, noventaDias: last90.total },
      }
    },

    g171: async () => {
      // «El lunes»: el último lunes que ya pasó (hoy es lunes: el de la semana pasada).
      const back = (weekday(today) + 6) % 7 || 7
      const day = w.addDays(today, -back)
      const result = await h.fig("cobrado", "total", range(day, day))
      const before = await h.fig("cobrado", "total", range(w.addDays(day, -7), w.addDays(day, -7)))
      const [payments] = await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from patient_payment p
        where p.organization_id = ${org} and p.currency = ${currency}
          and p.paid_at >= ${(await startOf(day)).toISOString()}::timestamptz and p.paid_at < ${(await endOf(w.addDays(day, 1))).toISOString()}::timestamptz`)
      return {
        respuesta: `El ${dayName(day)} se cobraron ${show(result)}, sin lo anulado ni lo devuelto.${!payments?.count ? " Ese día no se registró ningún pago." : ""}`,
        criterio: "«Lo cobrado» de Reportes del último lunes (día de la clínica): pagos menos anulaciones y devoluciones.",
        nota: `El lunes anterior (${dateWords(w.addDays(day, -7), false)}): ${show(before)}.`,
        datos: { dia: day, cobrado: result.total, pagos: payments?.count ?? 0, lunesAnterior: before.total },
      }
    },

    g172: async () => {
      const y = yearOfMonth(6)
      const [person] = await tx.execute<{ id: string; name: string }>(sql`
        select u.id, u.name from "user" u
        where translate(lower(u.name), 'áéíóúü', 'aeiouu') like '%ana torres%'
          and exists (select 1 from appointment a where a.organization_id = ${org} and a.dentist_user_id = u.id)
        limit 1`)
      if (!person) {
        return {
          respuesta: "No tengo a una Dra. Ana Torres entre los profesionales con citas de la clínica.",
          criterio: "Profesionales con citas en la clínica cuyo nombre es Ana Torres: ninguno.",
          datos: {},
        }
      }
      const may = await h.fig("cobrado", "profesional", monthKey(y, 5))
      const june = await h.fig("cobrado", "profesional", monthKey(y, 6))
      const of = (result: FigureResult) => result.rows.find((row) => row.key === person.id)?.value.value ?? 0
      const work = async (month: number) => {
        const start = (await startOf(`${monthKey(y, month)}-01`)).toISOString()
        const end = (await endOf(`${monthKey(y, month + 1)}-01`)).toISOString()
        const [charged] = await tx.execute<{ cents: string }>(sql`
          select coalesce(sum(c.amount_cents), 0)::text as cents from patient_charge c
          join encounter_procedure ep on ep.organization_id = c.organization_id and ep.id = c.encounter_procedure_id and ep.voided_at is null
          join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id and e.status = 'finalizada' and e.voided_at is null
          where c.organization_id = ${org} and c.voided_at is null and c.currency = ${currency} and e.dentist_user_id = ${person.id}
            and c.created_at >= ${start}::timestamptz and c.created_at < ${end}::timestamptz`)
        const [done] = await tx.execute<{ times: number }>(sql`
          select coalesce(sum(ep.quantity), 0)::int as times from encounter_procedure ep
          join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id and e.status = 'finalizada' and e.voided_at is null
          where ep.organization_id = ${org} and ep.voided_at is null and e.dentist_user_id = ${person.id}
            and e.started_at >= ${start}::timestamptz and e.started_at < ${end}::timestamptz`)
        return { charged: Number(charged?.cents ?? 0), procedures: done?.times ?? 0 }
      }
      const workMay = await work(5)
      const workJune = await work(6)
      const a = of(may)
      const b = of(june)
      return {
        respuesta: `Por lo cobrado de lo que atendió (la base de sus comisiones), ${person.name.startsWith("Dra.") ? "la " : person.name.startsWith("Dr.") ? "el " : ""}${person.name} produjo ${money(a)} en mayo de ${y} y ${money(b)} en junio: ${changeWords(b, a)} en junio.`,
        criterio: "Lo cobrado por profesional de Reportes de mayo y de junio completos: lo pagado de lo que atendió, sin anulados ni lo devuelto.",
        nota: `Por lo cargado de sus atenciones firmadas (pagado o no): mayo ${money(workMay.charged)}, junio ${money(workJune.charged)}. Procedimientos realizados: mayo ${workMay.procedures}, junio ${workJune.procedures}.`,
        datos: { profesional: person, mayo: { cobrado: a, ...workMay }, junio: { cobrado: b, ...workJune } },
      }
    },

    g173: async () => {
      const result = await h.fig("gastos", "total", "este_ano")
      const full = await h.fig("gastos", "total", range(`${year - 1}-01-01`, `${year - 1}-12-31`))
      const commissions = await h.fig("comisiones", "total", "este_ano")
      const value = figureValue(result)
      const before = result.previous?.value ?? 0
      return {
        respuesta: `${value > before ? "Sí" : "No"}: en lo que va de ${year} (del 1 de enero al ${dateWords(today, false)}) los gastos registrados suman ${money(value)}; en los mismos días de ${year - 1}, ${money(before)}: ${changeWords(value, before)}.`,
        criterio: "«Lo gastado» de Reportes (gastos registrados en Finanzas sin anulados; el pago de comisiones va aparte) de este año hasta ahora contra el mismo tramo del año anterior.",
        nota: `Todo ${year - 1}, de enero a diciembre: ${show(full)}. Las comisiones generadas, que Reportes cuenta aparte: ${show(commissions)} este año contra ${show(commissions, commissions.previous?.value ?? 0)} en los mismos días de ${year - 1}.`,
        datos: { año: result.total, mismoTramoAnterior: result.previous, añoPasadoCompleto: full.total, comisiones: commissions.total, comisionesAnterior: commissions.previous },
      }
    },

    g174: async () => {
      const result = await h.fig("no_vinieron", "mes")
      const months = result.months.filter((month) => !month.partial).slice(-6)
      const running = result.months.find((month) => month.partial)
      const rateOf = (list: typeof months) => {
        const part = list.reduce((sum, month) => sum + (month.value.part ?? 0), 0)
        const whole = list.reduce((sum, month) => sum + (month.value.whole ?? 0), 0)
        return { part, whole, rate: whole > 0 ? (part / whole) * 100 : 0 }
      }
      const early = rateOf(months.slice(0, 3))
      const late = rateOf(months.slice(3))
      const points = late.rate - early.rate
      const trend = Math.abs(points) < 1 ? "se mantienen" : points > 0 ? "van subiendo" : "van bajando"
      const first = months[0]
      const last = months.at(-1)
      const words = (value: number) => `${value.toLocaleString(locale, { maximumFractionDigits: 1 })} %`
      const span = (list: typeof months) => `${monthLabel(h, list[0]?.month ?? { year, month: 1 }, false)} a ${monthLabel(h, list.at(-1)?.month ?? { year, month: 1 }, false)}`
      return {
        respuesta: `En los últimos 6 meses completos (${first ? monthLabel(h, first.month, false) : "—"} a ${last ? monthLabel(h, last.month) : "—"}) las inasistencias ${trend}: ${listOf(months.map((month) => ({ name: monthLabel(h, month.month, false), value: `${show(result, month.value.value)}, ${month.value.part ?? 0} de ${month.value.whole ?? 0}` })))}. De ${span(months.slice(0, 3))} no vino el ${words(early.rate)} de las citas; de ${span(months.slice(3))}, el ${words(late.rate)}.`,
        criterio: "«No vinieron» de Reportes por mes (citas a las que el paciente no vino ÷ citas que ya pasaron), los últimos 6 meses completos; la tendencia compara los 3 primeros con los 3 últimos (menos de 1 punto: se mantienen).",
        nota: `En cantidad de citas: ${early.part} de ${early.whole} contra ${late.part} de ${late.whole}.${running ? ` El mes en curso va ${show(result, running.value.value)} (${running.value.part ?? 0} de ${running.value.whole ?? 0}, hasta hoy).` : ""}`,
        datos: { meses: months, primeros3: early, ultimos3: late, mesEnCurso: running ?? null },
      }
    },

    g175: async () => {
      const y = yearOfMonth(10)
      const start = (await startOf(`${y}-10-01`)).toISOString()
      const end = (await endOf(`${y}-11-01`)).toISOString()
      const days = await collectedByDay(h, start, end)
      const sorted = [...days].filter((row) => row.cents > 0).sort((a, b) => b.cents - a.cents || a.day.localeCompare(b.day))
      const best = sorted[0]
      const running = y === year && currentMonth === 10
      const lastYear = running ? await collectedByDay(h, (await startOf(`${y - 1}-10-01`)).toISOString(), (await startOf(`${y - 1}-11-01`)).toISOString()) : []
      const lastBest = [...lastYear].sort((a, b) => b.cents - a.cents || a.day.localeCompare(b.day))[0]
      return {
        respuesta: best
          ? `El mejor día de cobros de octubre de ${y}${running ? ` (${w.monthSoFar.replace(/ de \d{4}$/, "")}, hasta hoy)` : ""} fue el ${dayName(best.day)}: ${money(best.cents)}, sin lo anulado ni lo devuelto.`
          : `En octubre de ${y} todavía no hay cobros.`,
        criterio: "«Lo cobrado» (pagos menos anulaciones y devoluciones) de cada día de la clínica de octubre, de mayor a menor; sumados dan la cifra del mes.",
        nota: `Le siguen ${listOf(sorted.slice(1, 3).map((row) => ({ name: w.dayWords(row.day), value: money(row.cents) })))}; hubo cobros en ${sorted.length} días.${lastBest ? ` En octubre de ${y - 1} el mejor fue el ${dayName(lastBest.day)}: ${money(lastBest.cents)}.` : ""}`,
        datos: { mejores: sorted.slice(0, 5), dias: sorted.length, octubreAnterior: lastBest ?? null },
      }
    },
  }
}

/**
 * Respuestas correctas del inventario (eval/argos-owner.json, i1–i6). Lo que
 * hay se mide a hoy con `listProducts` de cada sede (lotes − faltante, en la
 * unidad de uso, como Inventario); lo usado son los movimientos de consumo
 * del ledger (atenciones y usos sin atención), como r85. Los lotes no guardan
 * lo que costaron: el valor del inventario es trampa (r87).
 */
import { listProducts, type ProductListItem } from "@odentia/services"
import { sql } from "drizzle-orm"
import type { GoldenHelpers, GoldenSolvers } from "./helpers.js"

const DAY_MS = 86_400_000

/** «1 frasco», «2 frascos», «3 unidades»: la unidad de uso del producto. */
function unitsWord(count: number, unit: string): string {
  if (count === 1 || count === -1) return `${count} ${unit}`
  const plural = /[aeiouáéó]$/i.test(unit) ? `${unit}s` : `${unit}es`
  return `${count} ${plural}`
}

export function inventorySolvers(h: GoldenHelpers): GoldenSolvers {
  const { tx, org, money, listOf } = h
  const nowIso = h.now.toISOString()
  const yearAgo = new Date(h.now.getTime() - 365 * DAY_MS).toISOString()
  const previous = { start: h.scope.window.previous.start.toISOString(), end: h.scope.window.previous.end.toISOString() }
  const monthOf = (date: Date) => new Intl.DateTimeFormat(h.scope.locale, { month: "long", timeZone: h.tz }).format(date).toLowerCase()
  const dayOfMonth = (date: Date) => new Intl.DateTimeFormat("en-US", { day: "numeric", timeZone: h.tz }).format(date)
  const dateWords = (day: string) =>
    new Intl.DateTimeFormat(h.scope.locale, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`))
  const thisMonth = `en lo que va de ${monthOf(h.now)} (del 1 al ${dayOfMonth(h.now)})`
  const lastMonthDays = `los mismos días de ${monthOf(h.scope.window.previous.start)} (del 1 al ${dayOfMonth(new Date(h.scope.window.previous.end.getTime() - 1))})`
  const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
  const howMany = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

  /** Lo descontado por uso en [start, end): movimientos de consumo (en atenciones o sin atención), por producto. */
  const consumed = (start: string, end: string) =>
    tx.execute<{ id: string; name: string; unit: string; usedInCare: boolean; units: number; inCare: number; encounters: number }>(sql`
      select pr.id, pr.name, pr.unit, pr.used_in_care as "usedInCare", sum(-m.quantity_delta)::int as units,
        coalesce(sum(-m.quantity_delta) filter (where m.encounter_id is not null), 0)::int as "inCare",
        count(distinct m.encounter_id)::int as encounters
      from stock_movement m join product pr on pr.organization_id = m.organization_id and pr.id = m.product_id
      where m.organization_id = ${org} and m.kind = 'consumo' and m.created_at >= ${start}::timestamptz and m.created_at < ${end}::timestamptz
      group by 1, 2, 3, 4 order by 5 desc, 2`)
  /** Lo «usado» como lo cuenta Inventario: consumo, ventas menos lo devuelto y las correcciones de una atención. */
  const usedLikeInventory = (start: string, end: string) =>
    tx.execute<{ name: string; unit: string; units: number }>(sql`
      select pr.name, pr.unit, sum(-m.quantity_delta)::int as units
      from stock_movement m join product pr on pr.organization_id = m.organization_id and pr.id = m.product_id
      where m.organization_id = ${org} and m.created_at >= ${start}::timestamptz and m.created_at < ${end}::timestamptz
        and (m.kind in ('consumo', 'venta', 'devolucion') or (m.kind = 'ajuste' and m.encounter_id is not null))
      group by 1, 2 having sum(-m.quantity_delta) > 0 order by 3 desc, 1`)
  const usedWords = (rows: Array<{ name: string; unit: string; units: number }>) =>
    listOf(rows.map((row) => ({ name: row.name, value: unitsWord(row.units, row.unit) })))

  /** Cada producto de cada sede activa, como lo muestra Inventario hoy. */
  const bySede = async () => {
    const branches = await tx.execute<{ id: string; name: string }>(sql`select id, name from branch where organization_id = ${org} and is_active order by name`)
    const found: Array<ProductListItem & { branch: string }> = []
    for (const branch of branches) {
      const list = await listProducts(tx, org, { branchId: branch.id, now: h.now })
      for (const item of list.items) found.push({ ...item, branch: branch.name })
    }
    return { branches, found }
  }

  return {
    i1: async () => {
      // Insumo: un producto que «se usa en las atenciones»; lo que solo se vende y se usó aparte (un regalo) va en la nota.
      const all = await consumed(h.monthStart, nowIso)
      const year = (await consumed(yearAgo, nowIso)).filter((row) => row.usedInCare)
      const month = all.filter((row) => row.usedInCare)
      const others = all.filter((row) => !row.usedInCare)
      return {
        respuesta: month.length
          ? `${capital(thisMonth)}, ${month.length < 10 ? `solo ${howMany(month.length, "insumo tuvo", "insumos tuvieron")} uso, menos de 10` : "los 10 insumos más usados son"}: ${usedWords(month.slice(0, 10))}. Cada uno va en su unidad de uso.`
          : `${capital(thisMonth)} no se descontó ningún insumo por uso.`,
        criterio: "Lo descontado de Inventario por uso este mes (movimientos de consumo de las atenciones y usos sin atención) de los productos que se usan en las atenciones, por producto y en su unidad de uso.",
        nota: `En los últimos 12 meses: ${usedWords(year.slice(0, 10))}.${others.length ? ` Contando también productos que no son insumos (solo se venden) y se usaron sin atención: ${usedWords(others)}.` : ""}`,
        datos: { mes: month, otrosUsos: others, doceMeses: year },
      }
    },
    i2: async () => {
      const { found } = await bySede()
      const short = found.filter((item) => item.needs)
      const expired = found.filter((item) => item.expired)
      const shortWords = listOf(
        short.map((row) => ({
          name: `${row.name} en ${row.branch}`,
          value:
            row.shortage > 0
              ? `se usaron o vendieron ${unitsWord(row.shortage, row.unit)} sin haber; mínimo ${row.minQuantity}`
              : `hay ${unitsWord(row.onHand, row.unit)}, mínimo ${row.minQuantity}`,
        })),
      )
      return {
        respuesta: short.length
          ? `Hoy ${short.length === 1 ? "hace falta 1" : `hacen falta ${short.length}`}: ${shortWords}.`
          : "Hoy ningún producto está por debajo de su mínimo ni se usó sin haber.",
        criterio: "«Hacen falta» de Inventario en cada sede, a hoy: productos activos por debajo de su mínimo o usados sin haber (faltante).",
        nota: expired.length
          ? `Además, con lotes vencidos que conviene retirar (cuentan en lo que hay): ${listOf(expired.map((row) => ({ name: `${row.name} en ${row.branch}`, value: `${unitsWord(row.expired?.quantity ?? 0, row.unit)} vencidos de ${row.onHand}; mínimo ${row.minQuantity}` })))}.`
          : undefined,
        datos: { hacenFalta: short.map((row) => ({ name: row.name, branch: row.branch, onHand: row.onHand, shortage: row.shortage, min: row.minQuantity, state: row.state })), vencidos: expired.map((row) => ({ name: row.name, branch: row.branch, expired: row.expired, onHand: row.onHand })) },
      }
    },
    i3: async () => {
      const rows = await tx.execute<{ name: string; forSale: boolean; lastDay: string | null; days: number | null }>(sql`
        select pr.name, pr.for_sale as "forSale",
          to_char(max(coalesce(o.created_at, c.created_at) at time zone ${h.tz}), 'YYYY-MM-DD') as "lastDay",
          (${h.today} - max((coalesce(o.created_at, c.created_at) at time zone ${h.tz})::date))::int as days
        from product pr
        left join patient_charge c on c.organization_id = pr.organization_id and c.product_id = pr.id and c.voided_at is null
          and exists (select 1 from patient_payment_application a
            join patient_payment pay on pay.organization_id = a.organization_id and pay.id = a.payment_id and pay.voided_at is null
            where a.organization_id = c.organization_id and a.charge_id = c.id and a.voided_at is null)
        left join patient_charge o on o.organization_id = c.organization_id and o.id = c.original_charge_id
        where pr.organization_id = ${org} and pr.is_active
        group by pr.id, pr.name, pr.for_sale
        order by max(coalesce(o.created_at, c.created_at)) asc nulls first, pr.name`)
      const words = (list: Array<(typeof rows)[number]>) =>
        listOf(list.map((row) => ({ name: row.name, value: row.lastDay ? `última venta el ${dateWords(row.lastDay)}, hace ${howMany(row.days ?? 0, "día", "días")}` : "nunca se vendió" })))
      const forSale = rows.filter((row) => row.forSale)
      const notForSale = rows.filter((row) => !row.forSale)
      return {
        respuesta: forSale.length
          ? `De tus ${howMany(forSale.length, "producto activo a la venta", "productos activos a la venta")}, del que lleva más tiempo sin venderse al más reciente: ${words(forSale.slice(0, 5))}.`
          : "No tienes productos activos a la venta.",
        criterio: "Productos activos marcados «Se vende» con el día de su última venta pagada (o sin ninguna), del más antiguo al más reciente.",
        nota: notForSale.length
          ? `Contando todos los productos activos, también los que no se venden porque solo se usan en las atenciones, nunca se vendieron: ${notForSale.filter((row) => !row.lastDay).map((row) => row.name).join(", ")}.`
          : undefined,
        datos: { filas: rows },
      }
    },
    i4: async () => {
      const { found } = await bySede()
      const active = found.filter((item) => item.isActive)
      const totals = new Map<string, { name: string; unit: string; onHand: number; sedes: string[] }>()
      for (const item of active) {
        const entry = totals.get(item.id) ?? { name: item.name, unit: item.unit, onHand: 0, sedes: [] }
        entry.onHand += item.onHand
        if (item.onHand !== 0) entry.sedes.push(`${item.branch} ${item.onHand}`)
        totals.set(item.id, entry)
      }
      const lowest = [...totals.values()].sort((a, b) => a.onHand - b.onHand || a.name.localeCompare(b.name))
      const perSede = [...active].sort((a, b) => a.onHand - b.onHand || a.name.localeCompare(b.name) || a.branch.localeCompare(b.branch))
      const sedesWithNothing = [...new Set(active.map((item) => item.branch))].filter((branch) => active.filter((item) => item.branch === branch).every((item) => item.onHand <= 0))
      const lowWords = (list: typeof lowest) =>
        listOf(
          list.map((row) => ({
            name: row.name,
            value:
              row.onHand < 0
                ? `${row.onHand}: se usaron o vendieron ${unitsWord(-row.onHand, row.unit)} sin haber; ${row.sedes.join(", ")}`
                : `${unitsWord(row.onHand, row.unit)}${row.sedes.length ? `; ${row.sedes.join(", ")}` : ""}`,
          })),
        )
      const missingBySede = [...new Set(active.map((item) => item.branch))]
        .filter((branch) => !sedesWithNothing.includes(branch))
        .map((branch) => ({ branch, names: active.filter((item) => item.branch === branch && item.onHand <= 0).map((item) => item.name) }))
        .filter((row) => row.names.length > 0)
      return {
        respuesta: `Hoy, sumando las sedes, lo que menos tienes es: ${lowWords(lowest.slice(0, 5))}. Cada uno va en su unidad de uso.`,
        criterio: "Lo que hay hoy de cada producto activo (lotes − faltante, como Inventario), sumando las sedes; de menos a más.",
        nota: `Por sede, lo que no hay (0 o menos): ${missingBySede.map((row) => `en ${row.branch}, ${row.names.join(", ")}`).join("; ") || "nada"}.${sedesWithNothing.length ? ` En ${sedesWithNothing.join(" y ")} no hay existencias de ningún producto.` : ""} Si «menor stock» es lo que está bajo su mínimo, es la lista de «Hacen falta».`,
        datos: { totales: lowest, porSede: perSede.map((row) => ({ name: row.name, branch: row.branch, onHand: row.onHand, min: row.minQuantity, state: row.state })) },
      }
    },
    i5: async () => {
      const all = await consumed(h.monthStart, nowIso)
      const month = all.filter((row) => row.usedInCare)
      const others = all.filter((row) => !row.usedInCare)
      const before = await consumed(previous.start, previous.end)
      const used = await usedLikeInventory(h.monthStart, nowIso)
      const withBefore = month.slice(0, 5).map((row) => ({ name: row.name, value: `${unitsWord(row.units, row.unit)}; antes, ${before.find((item) => item.id === row.id)?.units ?? 0}` }))
      return {
        respuesta: month.length
          ? `${capital(thisMonth)}, los insumos que más consumieron son: ${listOf(withBefore)}. «Antes» es lo de ${lastMonthDays}.`
          : `${capital(thisMonth)} no se descontó ningún insumo por uso.`,
        criterio: "Movimientos de consumo de Inventario de este mes (atenciones y usos sin atención) de los productos que se usan en las atenciones, por producto y en su unidad de uso; con los mismos días del mes anterior.",
        nota: `${others.length ? `Contando también productos que no son insumos (solo se venden) y se usaron sin atención: ${usedWords(others)}. ` : ""}Contando todo lo que salió, también lo vendido, como «Usado» de Inventario: ${usedWords(used.slice(0, 6))}.`,
        datos: { mes: month, otrosUsos: others, anterior: before, usadoComoInventario: used },
      }
    },
    i6: async () => {
      const units = await tx.execute<{ branch: string; products: number; units: number }>(sql`
        select b.name as branch, count(distinct l.product_id)::int as products, sum(l.quantity_on_hand)::int as units from product_lot l
        join warehouse w on w.organization_id = l.organization_id and w.id = l.warehouse_id
        join branch b on b.organization_id = w.organization_id and b.id = w.branch_id
        where l.organization_id = ${org} and l.quantity_on_hand > 0 group by 1 order by 1`)
      // Lo pagado de las compras de Inventario: sus gastos vigentes de Materiales (ADR 0061).
      const [paid] = await tx.execute<{ count: number; cents: string; orders: number; advance: string }>(sql`
        select count(*)::int as count, coalesce(sum(e.amount_cents), 0)::text as cents, count(distinct e.purchase_order_id)::int as orders,
          coalesce(sum(e.amount_cents) filter (where po.status = 'confirmada'), 0)::text as advance
        from expense e join purchase_order po on po.organization_id = e.organization_id and po.id = e.purchase_order_id
        where e.organization_id = ${org} and e.voided_at is null`)
      // Lo recibido de las compras, al precio de su factura (no descuenta lo ya usado).
      const [received] = await tx.execute<{ cents: string; orders: number }>(sql`
        select coalesce(sum(l.received_quantity * l.unit_cost_cents), 0)::text as cents, count(distinct l.order_id) filter (where l.received_quantity > 0)::int as orders
        from purchase_order_line l join purchase_order po on po.organization_id = l.organization_id and po.id = l.order_id
        where l.organization_id = ${org} and po.status <> 'cancelada'`)
      return {
        respuesta: `No puedo decirte cuánto dinero tienes en inventario: los lotes no guardan lo que costaron. Lo que sí sé, hoy: ${listOf(units.map((row) => ({ name: row.branch, value: `${row.units} unidades de ${howMany(row.products, "producto", "productos")}` })))}. Y lo pagado en compras de Inventario (gastos de Materiales enlazados a una compra): ${money(Number(paid?.cents ?? 0))} en ${howMany(paid?.count ?? 0, "pago", "pagos")} de ${howMany(paid?.orders ?? 0, "compra", "compras")}; eso no es lo que vale lo que hay.`,
        criterio: "Trampa: sin costo por lote no hay valor del inventario. Se ofrecen las unidades en existencia por sede a hoy (lotes con cantidad, también los vencidos) y lo pagado en compras, dicho como tal.",
        nota: `De lo pagado, ${money(Number(paid?.advance ?? 0))} es adelanto de una compra que aún no llega. Lo recibido de compras a precio de factura suma ${money(Number(received?.cents ?? 0))} (${howMany(received?.orders ?? 0, "compra", "compras")}), sin descontar lo ya usado: tampoco es lo que vale lo que hay.`,
        datos: { unidades: units, pagadoCompras: paid, recibidoCompras: received },
      }
    },
  }
}

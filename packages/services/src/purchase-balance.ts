/**
 * Cuánto se debe de cada compra de Inventario (ADR 0061). Una sola regla para
 * Inventario, Finanzas y Reportes:
 *
 * - Lo recibido vale lo que llegó por su costo; lo pagado son sus gastos de
 *   Materiales vigentes más lo usado de lo que se tenía a favor con el proveedor.
 * - Por pagar = recibido − pagado, nunca menos de cero: un adelanto de lo que
 *   aún no llega no se debe, ya salió el dinero.
 * - Lo pagado de más de una compra cerrada (recibida entera, o cancelada con
 *   sus pagos dejados a favor) queda a favor con el proveedor, para la próxima.
 *
 * Solo lecturas y sin dependencias de otros servicios: lo usan `finance.ts` e
 * `inventory.ts` sin ciclos.
 */
import type { Db } from "@odentia/db"
import { sql, type SQL } from "drizzle-orm"
import { at, bySpan, safeCents } from "./report-spans.js"

/** Compras cerradas: lo pagado de más ya no espera mercadería, queda a favor. */
export const CLOSED_PURCHASE_STATUSES = ["recibida", "cancelada"] as const

export interface PurchaseBalance {
  orderId: string
  orderNumber: number
  supplierId: string
  supplierName: string
  status: string
  currency: string
  branchId: string
  branchName: string
  /** Lo pedido por su costo. */
  orderedCents: number
  receivedCents: number
  /** Lo pagado en gastos vigentes. */
  cashCents: number
  /** Lo pagado con lo que se tenía a favor con el proveedor. */
  creditCents: number
  paidCents: number
  /** Lo recibido que falta pagar. */
  dueCents: number
  /** Lo pagado por encima de lo recibido: adelanto si la compra sigue abierta, a favor si ya cerró. */
  aheadCents: number
  /** Cuándo llegó lo primero; nulo si aún no llega nada. */
  firstReceivedAt: Date | null
  createdAt: Date
}

type BalanceRow = {
  orderId: string
  orderNumber: number
  supplierId: string
  supplierName: string
  status: string
  currency: string
  branchId: string
  branchName: string
  ordered: string
  received: string
  cash: string
  credit: string
  firstReceivedAt: Date | string | null
  createdAt: Date | string
}

/** Lo que vale cada orden y lo que se le pagó, hoy. */
export async function purchaseBalances(
  tx: Db,
  orgId: string,
  filter: { orderIds?: string[]; supplierId?: string; currency?: string; openOnly?: boolean } = {},
): Promise<PurchaseBalance[]> {
  const where: SQL[] = [sql`o.organization_id = ${orgId}`]
  if (filter.orderIds) {
    if (filter.orderIds.length === 0) return []
    where.push(sql`o.id in (${sql.join(filter.orderIds.map((id) => sql`${id}::uuid`), sql`, `)})`)
  }
  if (filter.supplierId) where.push(sql`o.supplier_id = ${filter.supplierId}`)
  if (filter.currency) where.push(sql`o.currency = ${filter.currency}`)
  if (filter.openOnly) where.push(sql`o.status in ('confirmada','parcialmente_recibida','recibida')`)
  const rows = await tx.execute<BalanceRow>(sql`
    select o.id as "orderId", o.order_number as "orderNumber", o.supplier_id as "supplierId", s.name as "supplierName",
      o.status, o.currency, w.branch_id as "branchId", b.name as "branchName",
      coalesce(l.ordered, 0)::text as ordered, coalesce(l.received, 0)::text as received,
      coalesce(e.cash, 0)::text as cash, coalesce(u.credit, 0)::text as credit,
      r.first_at as "firstReceivedAt", o.created_at as "createdAt"
    from purchase_order o
    join supplier s on s.organization_id = o.organization_id and s.id = o.supplier_id
    join warehouse w on w.organization_id = o.organization_id and w.id = o.warehouse_id
    join branch b on b.organization_id = w.organization_id and b.id = w.branch_id
    left join lateral (
      select sum(pl.quantity::bigint * pl.unit_cost_cents) as ordered, sum(pl.received_quantity::bigint * pl.unit_cost_cents) as received
      from purchase_order_line pl where pl.organization_id = o.organization_id and pl.order_id = o.id
    ) l on true
    left join lateral (
      select sum(x.amount_cents) as cash from expense x
      where x.organization_id = o.organization_id and x.purchase_order_id = o.id and x.voided_at is null
    ) e on true
    left join lateral (
      select sum(c.amount_cents) as credit from supplier_credit_use c
      where c.organization_id = o.organization_id and c.order_id = o.id and c.voided_at is null
    ) u on true
    left join lateral (
      select min(m.created_at) as first_at from stock_movement m
      where m.organization_id = o.organization_id and m.purchase_order_id = o.id and m.kind = 'ingreso'
    ) r on true
    where ${sql.join(where, sql` and `)}
    order by o.order_number desc`)
  return rows.map((row) => {
    const receivedCents = safeCents(row.received)
    const cashCents = safeCents(row.cash)
    const creditCents = safeCents(row.credit)
    const paidCents = cashCents + creditCents
    const cancelled = row.status === "cancelada"
    return {
      orderId: row.orderId,
      orderNumber: Number(row.orderNumber),
      supplierId: row.supplierId,
      supplierName: row.supplierName,
      status: row.status,
      currency: row.currency,
      branchId: row.branchId,
      branchName: row.branchName,
      orderedCents: safeCents(row.ordered),
      receivedCents,
      cashCents,
      creditCents,
      paidCents,
      dueCents: cancelled ? 0 : Math.max(0, receivedCents - paidCents),
      aheadCents: Math.max(0, paidCents - receivedCents),
      firstReceivedAt: row.firstReceivedAt ? new Date(row.firstReceivedAt) : null,
      createdAt: new Date(row.createdAt),
    }
  })
}

/**
 * Lo que se tiene a favor con cada proveedor, por moneda: lo pagado de más de
 * sus compras cerradas menos lo que ya se usó para pagar otras.
 */
export async function supplierCredits(
  tx: Db,
  orgId: string,
  filter: { supplierId?: string } = {},
): Promise<Array<{ supplierId: string; supplierName: string; currency: string; cents: number }>> {
  const supplierFilter = filter.supplierId ? sql`and o.supplier_id = ${filter.supplierId}` : sql``
  const rows = await tx.execute<{ supplierId: string; supplierName: string; currency: string; cents: string }>(sql`
    with paid as (
      select o.supplier_id, o.currency,
        greatest(coalesce((select sum(x.amount_cents) from expense x where x.organization_id = o.organization_id and x.purchase_order_id = o.id and x.voided_at is null), 0)
          + coalesce((select sum(c.amount_cents) from supplier_credit_use c where c.organization_id = o.organization_id and c.order_id = o.id and c.voided_at is null), 0)
          - coalesce((select sum(pl.received_quantity::bigint * pl.unit_cost_cents) from purchase_order_line pl where pl.organization_id = o.organization_id and pl.order_id = o.id), 0), 0) as excess
      from purchase_order o
      where o.organization_id = ${orgId} and o.status in ('recibida','cancelada') ${supplierFilter}
    ), used as (
      select c.supplier_id, c.currency, sum(c.amount_cents) as used from supplier_credit_use c
      where c.organization_id = ${orgId} and c.voided_at is null ${filter.supplierId ? sql`and c.supplier_id = ${filter.supplierId}` : sql``}
      group by c.supplier_id, c.currency
    ), totals as (
      select supplier_id, currency, sum(excess) as cents from (
        select supplier_id, currency, excess from paid
        union all
        select supplier_id, currency, -used from used
      ) z group by supplier_id, currency
    )
    select t.supplier_id as "supplierId", s.name as "supplierName", t.currency, t.cents::text as cents
    from totals t join supplier s on s.organization_id = ${orgId} and s.id = t.supplier_id
    where t.cents <> 0`)
  return rows.map((row) => ({ supplierId: row.supplierId, supplierName: row.supplierName, currency: row.currency, cents: safeCents(row.cents) }))
}

/**
 * Compras recibidas sin pagar en cada momento, por moneda: lo que había
 * llegado por su costo menos lo pagado hasta ahí (gastos vigentes en ese
 * momento y lo usado a favor), por compra y nunca menos de cero. Base de «Lo
 * que debes» de Reportes.
 */
export async function unpaidPurchasesMany(
  tx: Db,
  orgId: string,
  moments: Date[],
  options: { branchId?: string } = {},
): Promise<Array<Array<{ currency: string; cents: number; orders: number; oldestReceivedAt: Date | null }>>> {
  if (moments.length === 0) return []
  const branch = options.branchId ? sql`and w.branch_id = ${options.branchId}` : sql``
  const rows = await tx.execute<{ idx: number; currency: string; cents: string; orders: number; oldest: Date | string | null }>(sql`
    with m(idx, at_moment) as (values ${sql.join(
      moments.map((moment, index) => sql`(${index}::int, ${at(moment)})`),
      sql`, `,
    )}), due as (
      select m.idx, o.id, o.currency,
        coalesce(rcv.cents, 0) - coalesce(pay.cents, 0) - coalesce(cr.cents, 0) as due, rcv.first_at
      from m
      join purchase_order o on o.organization_id = ${orgId} and o.status <> 'borrador' and o.created_at < m.at_moment
      join warehouse w on w.organization_id = o.organization_id and w.id = o.warehouse_id ${branch}
      left join lateral (
        select sum(sm.quantity_delta::bigint * pl.unit_cost_cents) as cents, min(sm.created_at) as first_at
        from stock_movement sm
        join purchase_order_line pl on pl.organization_id = sm.organization_id and pl.order_id = sm.purchase_order_id and pl.product_id = sm.product_id
        where sm.organization_id = o.organization_id and sm.purchase_order_id = o.id and sm.kind = 'ingreso' and sm.created_at < m.at_moment
      ) rcv on true
      left join lateral (
        select sum(x.amount_cents) as cents from expense x
        where x.organization_id = o.organization_id and x.purchase_order_id = o.id and x.spent_at < m.at_moment
          and (x.voided_at is null or x.voided_at >= m.at_moment)
      ) pay on true
      left join lateral (
        select sum(c.amount_cents) as cents from supplier_credit_use c
        where c.organization_id = o.organization_id and c.order_id = o.id and c.created_at < m.at_moment
          and (c.voided_at is null or c.voided_at >= m.at_moment)
      ) cr on true
    )
    select idx, currency, sum(due)::text as cents, count(*)::int as orders, min(first_at) as oldest
    from due where due > 0 group by idx, currency`)
  return bySpan(
    moments.map((moment) => ({ start: moment, end: moment })),
    [...rows],
    (): Array<{ currency: string; cents: number; orders: number; oldestReceivedAt: Date | null }> => [],
    (list, row) => [...list, { currency: row.currency, cents: safeCents(row.cents), orders: row.orders, oldestReceivedAt: row.oldest ? new Date(row.oldest) : null }],
  )
}

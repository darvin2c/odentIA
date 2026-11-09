/**
 * Semilla de la venta de mostrador (ADR 0170), común a los tres productos:
 * hoy, en la sede, alguien que no es paciente se lleva lo que se vende. Una
 * sin nombre, pagada en efectivo con vuelto; otra a nombre de quien la pidió,
 * con otro medio. Pasa por `sellAtCounter`, como en Finanzas. Solo para la
 * semilla manual; nunca en pruebas ni en CI.
 */
import type { Db } from "@odentia/db"
import { product } from "@odentia/db/schema/inventory"
import { and, eq, inArray } from "drizzle-orm"
import { sellAtCounter } from "./counter-sale.js"
import { getOrgLocale } from "./locale.js"
import { listPaymentMethods } from "./payment-methods.js"

export interface CounterSalesSeedInput {
  orgId: string
  ownerUserId: string
  branchId: string
  /** Lo que se vende, en orden: el primero sin nombre, el segundo (o el mismo) a nombre de alguien. */
  productIds: string[]
  /** Las claves de las dos ventas: fijas, para que la semilla diga siempre lo mismo. */
  requestIds: [string, string]
  /** El nombre escrito de la segunda venta. */
  buyerName?: string
}

/** Las dos ventas de mostrador de hoy; cuántas quedaron (ninguna si no hay qué vender ni efectivo). */
export async function seedCounterSales(tx: Db, input: CounterSalesSeedInput): Promise<number> {
  const { orgId, ownerUserId, branchId } = input
  if (!input.productIds.length) return 0
  const { currency } = await getOrgLocale(tx, orgId)
  const rows = await tx
    .select({ id: product.id, priceCents: product.salePriceCents, currency: product.saleCurrency })
    .from(product)
    .where(and(eq(product.organizationId, orgId), inArray(product.id, input.productIds), eq(product.forSale, true)))
  // Solo lo que tiene precio en la moneda de la clínica: lo de otra moneda pide el cambio del día.
  const priced = input.productIds.flatMap((id) => {
    const row = rows.find((item) => item.id === id)
    return row && row.priceCents !== null && row.priceCents > 0 && row.currency === currency
      ? [{ id, priceCents: row.priceCents }]
      : []
  })
  const methods = await listPaymentMethods(tx, orgId)
  const cash = methods.find((method) => method.typeCode === "10")
  const first = priced[0]
  if (!cash || !first) return 0
  const other = methods.find((method) => method.typeCode !== "10") ?? cash
  // Paga con el billete que sigue (10 de su moneda): se le da el vuelto.
  const bill = 1000
  await sellAtCounter(tx, orgId, ownerUserId, {
    branchId,
    requestId: input.requestIds[0],
    lines: [{ productId: first.id }],
    payments: [{ paymentMethodId: cash.id, amountCents: first.priceCents }],
    cashReceivedCents: Math.ceil((first.priceCents + 1) / bill) * bill,
  })
  const second = priced[1] ?? first
  await sellAtCounter(tx, orgId, ownerUserId, {
    branchId,
    requestId: input.requestIds[1],
    lines: [{ productId: second.id, quantity: 2 }],
    buyer: { name: input.buyerName ?? "Carlos Mendoza" },
    payments: [{ paymentMethodId: other.id, amountCents: second.priceCents * 2 }],
  })
  return 2
}

import { type Db, orderBalance } from "@gestoria/db"
import { inArray } from "drizzle-orm"

/**
 * El saldo de un pedido (ADR 0222): una sola cifra, la misma en el pedido, las listas, Reportes,
 * Argos y lo que dice Sofi. Lo calcula la base en un solo lugar (la vista `order_balance`); aquí
 * solo se lee.
 *
 * - Lo pagado es lo confirmado menos lo que la tienda devolvió (tablero 17).
 * - Falta cobrar = total − pagado − por confirmar (nunca menos de 0; 0 si se anuló).
 * - «Pagado»: no falta cobrar y todo lo que entró está confirmado.
 * - Lo pagado que pasa del total sobra: un pago doble, o lo que se devuelve de un cambio que cuesta
 *   menos o de una devolución (su total queda bajo cero).
 */
export interface Balance {
  /** Lo cobrado: los pagos confirmados. */
  confirmedCents: number
  /** Los pagos que esperan a una persona. */
  pendingCents: number
  /** Lo que falta cobrar. */
  dueCents: number
  /** Lo pagado (confirmado menos devuelto) que pasa del total: lo que falta devolver. */
  overCents: number
  paid: boolean
  /** Lo que la tienda ya devolvió. */
  refundedCents: number
}

/** El saldo de un pedido sin pagos (o que no se pudo leer): debe su total. */
export const unpaidBalance = (totalCents: number): Balance => ({
  confirmedCents: 0,
  pendingCents: 0,
  dueCents: Math.max(totalCents, 0),
  overCents: Math.max(-totalCents, 0),
  paid: totalCents <= 0,
  refundedCents: 0,
})

/** El saldo de varios pedidos de la tienda, por su id. */
export async function balancesIn(tx: Db, orderIds: string[]): Promise<Map<string, Balance>> {
  if (orderIds.length === 0) return new Map()
  const rows = await tx.select().from(orderBalance).where(inArray(orderBalance.orderId, orderIds))
  return new Map(
    rows.map((row) => [
      row.orderId,
      {
        confirmedCents: Number(row.confirmedCents),
        pendingCents: Number(row.pendingCents),
        dueCents: Number(row.dueCents),
        overCents: Number(row.overCents),
        paid: Boolean(row.paid),
        refundedCents: Number(row.refundedCents),
      },
    ]),
  )
}

/** El saldo de un pedido. */
export async function balanceIn(
  tx: Db,
  order: { id: string; totalCents: number },
): Promise<Balance> {
  return (await balancesIn(tx, [order.id])).get(order.id) ?? unpaidBalance(order.totalCents)
}

/**
 * Lo que pasaría del total si se confirma un pago por confirmar: lo cobrado más ese pago, menos el
 * total. Más de 0 es un pago doble.
 */
export function overIfConfirmed(
  balance: Balance,
  totalCents: number,
  payment: { amountCents: number; status: string },
): number {
  if (payment.status !== "por_confirmar") return 0
  return Math.max(
    0,
    balance.confirmedCents - balance.refundedCents + payment.amountCents - totalCents,
  )
}

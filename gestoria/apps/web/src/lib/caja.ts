/**
 * Lo que la pantalla sabe de Caja (entrega 3 del lienzo «gestorIA como odentIA», tableros 4, 6 y
 * 23): lo cobrado del día por medio, lo que falta cobrar en las entregas del día y el efectivo de
 * cada repartidor, como lo dice el servidor. Las cifras son las de Reportes y Despachos.
 */

export interface CashBox {
  today: string
  day: string
  collected: {
    cents: number
    orders: number
    byMethod: { name: string; typeCode: string; cents: number; orders: number }[]
  }
  due: { orders: number; cents: number }
  toReceive: {
    /** null: lo cobrado en la tienda, sin repartidor. */
    courierId: string | null
    name: string | null
    cents: number
    payments: {
      id: string
      orderId: string
      number: string
      customerName: string
      amountCents: number
      at: string
    }[]
  }[]
  received: {
    id: string
    courierId: string | null
    courierName: string | null
    expectedCents: number
    receivedCents: number
    differenceCents: number
    note: string | null
    receivedByName: string | null
    receivedAt: string
  }[]
}

export const CASH_KEY = (storeId: string) => ["caja", storeId]

/** «Kevin», o «En la tienda» si se cobró sin repartidor. */
export function fromWhom(name: string | null): string {
  return name ?? "En la tienda"
}

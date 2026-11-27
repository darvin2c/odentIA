import {
  type Db,
  product,
  productVariant,
  saleOrder,
  saleOrderLine,
  storeDeliveryMethod,
  storePaymentMethod,
} from "@gestoria/db"
import { and, eq, isNotNull } from "drizzle-orm"
import { createExchangeIn, exchangeInput, recordRefund } from "./cambios.js"
import type { Person } from "./cuenta.js"
import { addDays, storeClockIn } from "./hora.js"
import { markDelivered } from "./pedidos.js"
import { balanceIn } from "./saldo.js"

/**
 * Cambios y devoluciones después de entregar (entrega 8 de «gestorIA como odentIA», tablero 17),
 * armados con las mismas operaciones que usa el equipo. Corre después de las clientas
 * (`semilla-clientes.ts`), que dejan entregados los pedidos de los que salen:
 *
 * - Andrea Castillo recibió la sandalia beige 37 y le quedó chica: el cambio por la 38 sale mañana,
 *   con el envío por su cuenta y por cobrar al entregar. Su pedido entregado no cambia.
 * - Mariela Ríos devolvió la zapatilla blanca 38 porque llegó fallada: la tienda pagó el envío de
 *   vuelta, la zapatilla volvió al stock como «devolución» y Rosa anotó lo que le devolvió por Yape.
 *
 * Se agrega una vez: si la tienda ya tiene un cambio, no los toca.
 */

const rosa: Person = {
  userId: "semilla-rosa",
  email: "rosa@calzadosrosa.demo",
  name: "Rosa Quispe",
}
const lucia: Person = {
  userId: "semilla-lucia",
  email: "lucia@calzadosrosa.demo",
  name: "Lucía Torres",
}

export async function seedDemoExchanges(tx: Db, storeId: string): Promise<void> {
  const [already] = await tx
    .select({ id: saleOrder.id })
    .from(saleOrder)
    .where(and(eq(saleOrder.storeId, storeId), isNotNull(saleOrder.exchangeOfId)))
    .limit(1)
  if (already) return
  /** El pedido entregado de esa clienta que llevó esa variante. */
  const delivered = async (customerName: string, productName: string, values: string) => {
    const rows = await tx
      .select({ id: saleOrder.id, values: productVariant.optionValues })
      .from(saleOrder)
      .innerJoin(saleOrderLine, eq(saleOrderLine.orderId, saleOrder.id))
      .innerJoin(productVariant, eq(productVariant.id, saleOrderLine.variantId))
      .innerJoin(product, eq(product.id, productVariant.productId))
      .where(
        and(
          eq(saleOrder.storeId, storeId),
          eq(saleOrder.customerName, customerName),
          eq(saleOrder.state, "entregado"),
          eq(product.name, productName),
        ),
      )
    return rows.find((row) => row.values.join(" ") === values)?.id
  }
  const variant = async (name: string, values: string) =>
    (
      await tx
        .select({ id: productVariant.id, values: productVariant.optionValues })
        .from(productVariant)
        .innerJoin(product, eq(product.id, productVariant.productId))
        .where(and(eq(productVariant.storeId, storeId), eq(product.name, name)))
    ).find((row) => row.values.join(" ") === values)?.id
  const delivery = async (name: string) =>
    (
      await tx
        .select({ id: storeDeliveryMethod.id })
        .from(storeDeliveryMethod)
        .where(and(eq(storeDeliveryMethod.storeId, storeId), eq(storeDeliveryMethod.name, name)))
    )[0]?.id
  const [yape] = await tx
    .select({ id: storePaymentMethod.id })
    .from(storePaymentMethod)
    .where(and(eq(storePaymentMethod.storeId, storeId), eq(storePaymentMethod.name, "Yape")))
  const [andrea, b37, b38, mariela, blanca38, reparto, provincia] = [
    await delivered("Andrea Castillo", "Sandalia", "beige 37"),
    await variant("Sandalia", "beige 37"),
    await variant("Sandalia", "beige 38"),
    await delivered("Mariela Ríos", "Zapatilla urbana", "blanca 38"),
    await variant("Zapatilla urbana", "blanca 38"),
    await delivery("Reparto en Lima"),
    await delivery("Envío a provincia"),
  ]
  if (!andrea || !b37 || !b38 || !mariela || !blanca38 || !reparto || !provincia || !yape) return
  const { today } = await storeClockIn(tx, storeId)

  // Andrea: la 37 le quedó chica; Kevin recoge la 37 y lleva la 38 mañana.
  await createExchangeIn(
    tx,
    storeId,
    lucia.userId,
    andrea,
    exchangeInput.parse({
      returns: [{ variantId: b37, quantity: 1 }],
      reason: "Le quedó chica",
      takes: [{ variantId: b38, quantity: 1 }],
      deliveryMethodId: reparto,
      zone: "Surco y Miraflores",
      address: "Av. Javier Prado Oeste 640, San Isidro",
      deliverOn: addDays(today, 1),
    }),
  )

  // Mariela: la blanca 38 llegó fallada; la tienda paga el envío de vuelta y le devuelve lo pagado.
  const back = await createExchangeIn(
    tx,
    storeId,
    lucia.userId,
    mariela,
    exchangeInput.parse({
      returns: [{ variantId: blanca38, quantity: 1 }],
      reason: "Llegó fallado",
      takes: [],
      deliveryMethodId: provincia,
      deliveryListCents: 1500,
      storePaysDelivery: true,
      address: "Shalom Arequipa, agencia Av. Ejército",
      deliverOn: today,
    }),
  )
  await markDelivered(tx, lucia, storeId, back.id, {
    collectedCents: null,
    methodId: null,
    payments: [],
  })
  // Lo que sobra es lo que pagó por la zapatilla: se devuelve entero, por Yape.
  const [row] = await tx
    .select({ totalCents: saleOrder.totalCents })
    .from(saleOrder)
    .where(eq(saleOrder.id, back.id))
  const { overCents } = await balanceIn(tx, { id: back.id, totalCents: row!.totalCents })
  if (overCents > 0)
    await recordRefund(tx, rosa, storeId, back.id, { amountCents: overCents, methodId: yape.id })
}

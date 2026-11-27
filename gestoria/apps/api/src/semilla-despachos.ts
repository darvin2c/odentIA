import {
  type Db,
  product,
  productVariant,
  saleOrder,
  store,
  storeCourier,
  storeDeliveryMethod,
  storePaymentMethod,
} from "@gestoria/db"
import { and, eq } from "drizzle-orm"
import type { z } from "zod"
import type { Person } from "./cuenta.js"
import { storeClockIn } from "./hora.js"
import {
  addReceipt,
  assignCourier,
  createOrderIn,
  markDelivered,
  markShipped,
  orderInput,
  reschedule,
  reviewPayment,
} from "./pedidos.js"

/**
 * Despachos y Caja de Calzados Rosa (entrega 3 del lienzo «gestorIA como odentIA», tableros 6, 17
 * y 23): tres franjas, Kevin (de fuera) y Lucía (del equipo) repartiendo, lo de hoy en cada franja,
 * el pedido de Jorge que no se entregó primero, un envío por Shalom todavía sin número y el
 * efectivo que Kevin cobró en la puerta, por recibir en Caja. Todo con las mismas operaciones que
 * usa el equipo. Se agrega una vez: si la tienda ya tiene repartidores, no la toca.
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

const MORNING = { start: 9 * 60, end: 13 * 60 }
const AFTERNOON = { start: 14 * 60, end: 18 * 60 }
const EVENING = { start: 18 * 60, end: 21 * 60 }

export async function seedDemoDispatch(tx: Db, storeId: string): Promise<void> {
  const [already] = await tx
    .select({ id: storeCourier.id })
    .from(storeCourier)
    .where(eq(storeCourier.storeId, storeId))
    .limit(1)
  if (already) return
  await tx
    .update(store)
    .set({ deliverySlots: [MORNING, AFTERNOON, EVENING] })
    .where(eq(store.id, storeId))
  const { today } = await storeClockIn(tx, storeId)
  const byName = async (name: string) =>
    (
      await tx
        .select({ id: saleOrder.id, state: saleOrder.state })
        .from(saleOrder)
        .where(and(eq(saleOrder.storeId, storeId), eq(saleOrder.customerName, name)))
    )[0]
  const variant = async (name: string, values: string) =>
    (
      await tx
        .select({ id: productVariant.id, values: productVariant.optionValues })
        .from(productVariant)
        .innerJoin(product, eq(product.id, productVariant.productId))
        .where(and(eq(productVariant.storeId, storeId), eq(product.name, name)))
    ).find((row) => row.values.join(" ") === values)?.id
  const method = async (
    table: typeof storePaymentMethod | typeof storeDeliveryMethod,
    name: string,
  ) =>
    (
      await tx
        .select({ id: table.id })
        .from(table)
        .where(and(eq(table.storeId, storeId), eq(table.name, name)))
    )[0]?.id
  const kevin = { name: "Kevin" }
  const withLucia = { userId: lucia.userId }

  // Lo que ya sale hoy, cada uno en su franja y con quién lo lleva.
  const move = async (
    name: string,
    slot: typeof MORNING,
    courier: typeof kevin | typeof withLucia,
  ) => {
    const order = await byName(name)
    if (!order) return
    if (order.state === "en_camino") await assignCourier(tx, lucia, storeId, order.id, { courier })
    else if (order.state === "por_salir")
      await reschedule(tx, lucia, storeId, order.id, { deliverOn: today, slot, courier })
  }
  await move("Rocío Vega", MORNING, kevin)
  await move("Luis Paredes", MORNING, kevin)
  await move("Ana Torres", AFTERNOON, kevin)
  await move("Diana Flores", AFTERNOON, withLucia)
  await move("Gabriela Rojas", AFTERNOON, withLucia)
  // Jorge no contestó cuando llegó Kevin: hoy va primero, a las 9 con Kevin, y cobra en la puerta.
  await move("Jorge Paredes", MORNING, kevin)

  const reparto = await method(storeDeliveryMethod, "Reparto en Lima")
  const provincia = await method(storeDeliveryMethod, "Envío a provincia")
  const yape = await method(storePaymentMethod, "Yape")
  const efectivo = await method(storePaymentMethod, "Efectivo al recibir")
  const z40 = await variant("Zapatilla urbana", "blanca 40")
  const b40 = await variant("Botín de cuero marrón", "40")
  if (!reparto || !provincia || !yape || !efectivo || !z40 || !b40) return
  const create = (input: Partial<z.input<typeof orderInput>>) =>
    createOrderIn(
      tx,
      storeId,
      lucia.userId,
      orderInput.parse({ channel: "whatsapp", deliverOn: today, ...input }),
    )

  // Andrés pagó en efectivo a Kevin en la puerta: es el efectivo por recibir en Caja.
  const andres = await create({
    customerName: "Andrés Vega",
    customerPhone: "+51 976 543 210",
    address: "Calle Schell 310, Miraflores",
    lines: [{ variantId: z40, quantity: 1 }],
    deliveryMethodId: reparto,
    zone: "Surco y Miraflores",
    paymentMethodId: efectivo,
  })
  await reschedule(tx, lucia, storeId, andres.id, {
    deliverOn: today,
    slot: MORNING,
    courier: kevin,
  })
  await markShipped(tx, lucia, storeId, andres.id, { tracking: null, agency: null })
  await markDelivered(tx, rosa, storeId, andres.id, {
    collectedCents: andres.totalCents,
    methodId: efectivo,
    payments: [],
  })

  // Milagros, a Arequipa por Shalom: pagó por Yape, salió hoy y el número de envío llega después.
  const mariela = await create({
    customerName: "Milagros Huamán",
    customerPhone: "+51 958 112 334",
    address: "Shalom Arequipa, agencia Av. Ejército",
    lines: [{ variantId: b40, quantity: 1 }],
    deliveryMethodId: provincia,
    zone: null,
    deliveryListCents: 0,
    paymentMethodId: yape,
  })
  const receipt = await addReceipt(
    tx,
    lucia,
    storeId,
    mariela.id,
    { amountCents: mariela.totalCents, operation: "00771239" },
    null,
  )
  await reviewPayment(tx, rosa, storeId, mariela.id, receipt.payments.at(-1)?.id ?? "", {
    decision: "confirmar",
  })
  await reschedule(tx, lucia, storeId, mariela.id, {
    deliverOn: today,
    slot: EVENING,
    courier: withLucia,
  })
  await markShipped(tx, lucia, storeId, mariela.id, { tracking: null, agency: "Shalom" })
}

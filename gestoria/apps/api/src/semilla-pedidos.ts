import {
  type Db,
  product,
  productVariant,
  saleOrder,
  storeDeliveryMethod,
  storePaymentMethod,
} from "@gestoria/db"
import { and, eq } from "drizzle-orm"
import type { z } from "zod"
import type { Person } from "./cuenta.js"
import { addDays, storeClockIn } from "./hora.js"
import {
  addReceipt,
  cancelOrder,
  changeOrderIn,
  createOrderIn,
  markDelivered,
  markMissed,
  markShipped,
  orderInput,
  reviewPayment,
} from "./pedidos.js"

/**
 * Los pedidos de Calzados Rosa (paso B4, tableros 2 y 5): uno en cada estado, armados con las
 * mismas operaciones que usa el equipo. Solo para desarrollo y demostraciones, como el resto de
 * `semilla.ts`. Se agregan una vez: si la tienda ya tiene pedidos, no los toca.
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

export async function seedDemoOrders(tx: Db, storeId: string): Promise<void> {
  const [any] = await tx
    .select({ id: saleOrder.id })
    .from(saleOrder)
    .where(eq(saleOrder.storeId, storeId))
    .limit(1)
  if (any) return
  const variant = async (name: string, values: string[]) => {
    const [row] = await tx
      .select({ id: productVariant.id, values: productVariant.optionValues })
      .from(productVariant)
      .innerJoin(product, eq(product.id, productVariant.productId))
      .where(and(eq(productVariant.storeId, storeId), eq(product.name, name)))
      .then((rows) => rows.filter((row) => row.values.join(" ") === values.join(" ")))
    if (!row) throw new Error(`semilla: falta ${name} ${values.join(" ")}`)
    return row.id
  }
  const payment = async (name: string) => {
    const [row] = await tx
      .select({ id: storePaymentMethod.id })
      .from(storePaymentMethod)
      .where(and(eq(storePaymentMethod.storeId, storeId), eq(storePaymentMethod.name, name)))
    return row!.id
  }
  const delivery = async (name: string) => {
    const [row] = await tx
      .select({ id: storeDeliveryMethod.id })
      .from(storeDeliveryMethod)
      .where(and(eq(storeDeliveryMethod.storeId, storeId), eq(storeDeliveryMethod.name, name)))
    return row!.id
  }
  const reparto = await delivery("Reparto en Lima")
  const recojo = await delivery("Recojo en la tienda")
  const provincia = await delivery("Envío a provincia")
  const [yape, plin, transferencia, efectivo] = await Promise.all(
    ["Yape", "Plin", "Transferencia BCP", "Efectivo al recibir"].map(payment),
  )
  // El día de la tienda, con su hora (la de Lima).
  const { today } = await storeClockIn(tx, storeId)
  const tomorrow = addDays(today, 1)

  // Como lo arma «Anotar un pedido»: con los mismos valores por omisión.
  const create = async (input: Partial<z.input<typeof orderInput>>) =>
    (
      await createOrderIn(
        tx,
        storeId,
        lucia.userId,
        orderInput.parse({
          channel: "whatsapp",
          deliveryMethodId: reparto,
          zone: "Surco y Miraflores",
          paymentMethodId: yape,
          deliverOn: today,
          ...input,
        }),
      )
    ).id
  const receipt = (id: string, amountCents: number, operation: string) =>
    addReceipt(tx, lucia, storeId, id, { amountCents, operation }, null)
  const confirm = async (id: string, amountCents: number, operation: string) => {
    const detail = await receipt(id, amountCents, operation)
    await reviewPayment(tx, rosa, storeId, id, detail.payments.at(-1)!.id, {
      decision: "confirmar",
    })
  }

  // Entregado ayer, pagado con Yape.
  const pedro = await create({
    customerName: "Pedro Salas",
    customerPhone: "+51 912 345 678",
    address: "Calle Los Pinos 210, Miraflores",
    lines: [{ variantId: await variant("Botín de cuero marrón", ["39"]), quantity: 1 }],
  })
  await confirm(pedro, 22900, "00412233")
  await markShipped(tx, lucia, storeId, pedro, { tracking: null })
  await markDelivered(tx, lucia, storeId, pedro, { collectedCents: null, methodId: null })

  // Anulado: el cliente se arrepintió antes de pagar.
  const sofia = await create({
    customerName: "Sofía Ramos",
    channel: "instagram",
    lines: [{ variantId: await variant("Sandalia", ["negra", "36"]), quantity: 1 }],
    deliveryMethodId: recojo,
    zone: null,
  })
  await cancelOrder(tx, lucia, storeId, sofia, {
    reason: "Se arrepintió: ya compró en otra tienda",
  })

  // Pagado y por salir hoy, confirmado por Rosa.
  const rocio = await create({
    customerName: "Rocío Vega",
    customerPhone: "+51 934 567 890",
    address: "Jr. Las Begonias 455, Surco",
    lines: [{ variantId: await variant("Sandalia", ["beige", "38"]), quantity: 1 }],
    paymentMethodId: transferencia,
  })
  const sandaliaTotal = (
    await tx.select({ total: saleOrder.totalCents }).from(saleOrder).where(eq(saleOrder.id, rocio))
  )[0]!.total
  await confirm(rocio, sandaliaTotal, "BCP-778812")
  const luis = await create({
    customerName: "Luis Paredes",
    address: "Av. Benavides 1180, Surco",
    lines: [{ variantId: await variant("Zapatilla urbana", ["blanca", "41"]), quantity: 1 }],
  })
  await confirm(luis, 13900, "00981234")

  // En camino, se cobra al recibir.
  const ana = await create({
    customerName: "Ana Torres",
    channel: "messenger",
    address: "Av. Arequipa 2400, Lince",
    lines: [{ variantId: await variant("Zapatilla urbana", ["negra", "36"]), quantity: 1 }],
    paymentMethodId: efectivo,
  })
  await markShipped(tx, lucia, storeId, ana, { tracking: null })

  // Por pagar: un botín a provincia y dos sandalias para recoger.
  await create({
    customerName: "Jorge Quispe",
    channel: "instagram",
    address: "Calle Mercaderes 120, Arequipa",
    lines: [{ variantId: await variant("Botín de cuero marrón", ["41"]), quantity: 1 }],
    deliveryMethodId: provincia,
    zone: null,
    deliveryListCents: 1500,
    paymentMethodId: transferencia,
    deliverOn: tomorrow,
  })
  await create({
    customerName: "Marta Ríos",
    lines: [{ variantId: await variant("Sandalia", ["negra", "37"]), quantity: 2 }],
    deliveryMethodId: recojo,
    zone: null,
    paymentMethodId: plin,
    deliverOn: tomorrow,
  })

  // Pago por confirmar: Carla negoció envío gratis y S/ 9 menos, y mandó su captura.
  const carla = await create({
    customerName: "Carla Mendoza",
    customerPhone: "+51 987 654 321",
    address: "Av. Primavera 123, Surco",
    notes: "Llamar antes de llegar",
    lines: [
      {
        variantId: await variant("Zapatilla urbana", ["blanca", "38"]),
        quantity: 1,
        unitCents: 12000,
      },
    ],
    deliveryCents: 0,
    deliverOn: tomorrow,
  })
  await receipt(carla, 12000, "00123456")
}

/**
 * El pago en partes (lienzo «gestorIA como odentIA», tablero 7): Diana pide una zapatilla de
 * S/ 117 con envío, paga S/ 80 por Yape y Rosa lo confirma; el pedido queda listo para salir con
 * S/ 37 por cobrar al entregar. Se agrega una vez, aunque la tienda ya tenga sus pedidos.
 */
export async function seedDemoPartPayment(tx: Db, storeId: string): Promise<void> {
  const [already] = await tx
    .select({ id: saleOrder.id })
    .from(saleOrder)
    .where(and(eq(saleOrder.storeId, storeId), eq(saleOrder.customerName, "Diana Flores")))
    .limit(1)
  if (already) return
  const [variant] = await tx
    .select({ id: productVariant.id, values: productVariant.optionValues })
    .from(productVariant)
    .innerJoin(product, eq(product.id, productVariant.productId))
    .where(and(eq(productVariant.storeId, storeId), eq(product.name, "Zapatilla urbana")))
    .then((rows) => rows.filter((row) => row.values.join(" ") === "blanca 39"))
  const [yape] = await tx
    .select({ id: storePaymentMethod.id })
    .from(storePaymentMethod)
    .where(and(eq(storePaymentMethod.storeId, storeId), eq(storePaymentMethod.name, "Yape")))
  const [reparto] = await tx
    .select({ id: storeDeliveryMethod.id })
    .from(storeDeliveryMethod)
    .where(
      and(
        eq(storeDeliveryMethod.storeId, storeId),
        eq(storeDeliveryMethod.name, "Reparto en Lima"),
      ),
    )
  if (!variant || !yape || !reparto) return
  const { today } = await storeClockIn(tx, storeId)
  const created = await createOrderIn(
    tx,
    storeId,
    lucia.userId,
    orderInput.parse({
      customerName: "Diana Flores",
      customerPhone: "+51 945 112 233",
      channel: "whatsapp",
      address: "Av. Caminos del Inca 1450, Surco",
      notes: "El resto lo paga en efectivo al recibir",
      lines: [{ variantId: variant.id, quantity: 1, unitCents: 10700 }],
      deliveryMethodId: reparto.id,
      zone: "Surco y Miraflores",
      paymentMethodId: yape.id,
      deliverOn: today,
    }),
  )
  const detail = await addReceipt(
    tx,
    lucia,
    storeId,
    created.id,
    { amountCents: 8000, operation: "00556677" },
    null,
  )
  await reviewPayment(tx, rosa, storeId, created.id, detail.payments.at(-1)!.id, {
    decision: "confirmar",
  })
}

/**
 * Corregir sin anular (lienzo «gestorIA como odentIA», tableros 6 y 7): Gabriela pagó la sandalia
 * beige 37 por Plin y pide la 38 a su oficina del Callao; se cambia el mismo pedido y le falta
 * cobrar la diferencia del envío. Jorge no contestó cuando llegó Kevin: vuelve a salir mañana. Se
 * agrega una vez, aunque la tienda ya tenga sus pedidos. Son otras personas que las de la ficha de
 * Clientes (`semilla-clientes.ts`): cada pedido sin ficha elegida abre la suya.
 */
export async function seedDemoCorrections(tx: Db, storeId: string): Promise<void> {
  const [already] = await tx
    .select({ id: saleOrder.id })
    .from(saleOrder)
    .where(and(eq(saleOrder.storeId, storeId), eq(saleOrder.customerName, "Gabriela Rojas")))
    .limit(1)
  if (already) return
  const variant = async (name: string, values: string) =>
    (
      await tx
        .select({ id: productVariant.id, values: productVariant.optionValues })
        .from(productVariant)
        .innerJoin(product, eq(product.id, productVariant.productId))
        .where(and(eq(productVariant.storeId, storeId), eq(product.name, name)))
    ).find((row) => row.values.join(" ") === values)?.id
  const method = async (name: string) =>
    (
      await tx
        .select({ id: storePaymentMethod.id })
        .from(storePaymentMethod)
        .where(and(eq(storePaymentMethod.storeId, storeId), eq(storePaymentMethod.name, name)))
    )[0]?.id
  const [reparto] = await tx
    .select({ id: storeDeliveryMethod.id })
    .from(storeDeliveryMethod)
    .where(
      and(
        eq(storeDeliveryMethod.storeId, storeId),
        eq(storeDeliveryMethod.name, "Reparto en Lima"),
      ),
    )
  const [b37, b38, z39, plin, efectivo] = [
    await variant("Sandalia", "beige 37"),
    await variant("Sandalia", "beige 38"),
    await variant("Zapatilla urbana", "negra 39"),
    await method("Plin"),
    await method("Efectivo al recibir"),
  ]
  if (!b37 || !b38 || !z39 || !plin || !efectivo || !reparto) return
  const { today } = await storeClockIn(tx, storeId)
  const create = async (input: Partial<z.input<typeof orderInput>>) =>
    createOrderIn(
      tx,
      storeId,
      lucia.userId,
      orderInput.parse({
        channel: "whatsapp",
        deliveryMethodId: reparto.id,
        zone: "Surco y Miraflores",
        deliverOn: today,
        ...input,
      }),
    )

  const gabriela = await create({
    customerName: "Gabriela Rojas",
    customerPhone: "+51 956 778 899",
    address: "Av. Primavera 820, Surco",
    lines: [{ variantId: b37, quantity: 1 }],
    paymentMethodId: plin,
  })
  const detail = await addReceipt(
    tx,
    lucia,
    storeId,
    gabriela.id,
    { amountCents: gabriela.totalCents, operation: "PLIN-30451" },
    null,
  )
  await reviewPayment(tx, rosa, storeId, gabriela.id, detail.payments.at(-1)!.id, {
    decision: "confirmar",
  })
  await changeOrderIn(tx, storeId, lucia.userId, gabriela.id, {
    lines: [{ variantId: b38, quantity: 1, unitCents: null, gift: false }],
    deliveryMethodId: reparto.id,
    zone: "Callao",
    deliveryListCents: null,
    deliveryCents: null,
    address: "Av. Sáenz Peña 501, of. 802, Callao",
    deliverOn: today,
  })

  const jorge = await create({
    customerName: "Jorge Paredes",
    customerPhone: "+51 923 445 566",
    address: "Av. Sáenz Peña 820, Callao",
    zone: "Callao",
    lines: [{ variantId: z39, quantity: 1 }],
    paymentMethodId: efectivo,
  })
  await markShipped(tx, lucia, storeId, jorge.id, { tracking: null })
  await markMissed(tx, lucia, storeId, jorge.id, {
    reason: "No contestó",
    deliverOn: addDays(today, 1),
  })
}

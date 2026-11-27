import {
  customer,
  type Db,
  product,
  productVariant,
  storeDeliveryMethod,
  storePaymentMethod,
} from "@gestoria/db"
import { and, eq } from "drizzle-orm"
import type { z } from "zod"
import { mergeCustomersIn } from "./clientes.js"
import type { Person } from "./cuenta.js"
import {
  addReceipt,
  createOrderIn,
  markDelivered,
  markShipped,
  orderInput,
  reviewPayment,
} from "./pedidos.js"

/**
 * Las clientas de Calzados Rosa (entrega 4, tablero 8), armadas con las mismas operaciones que
 * usa el equipo. Los pedidos de `semilla-pedidos.ts` y de `semilla-sofi.ts` ya abren cada uno su
 * ficha; aquí se suma lo que muestra Clientes:
 *
 * - Mariela Ríos compró por Instagram (entregado) y tiene «Lo que sabemos»; otra ficha con el
 *   mismo nombre llegó por WhatsApp: «¿Es la misma clienta?» queda por contestar.
 * - Andrea Castillo llegó por Instagram y por WhatsApp, y Lucía dijo que es la misma: su ficha
 *   cuenta la historia con «Separar».
 *
 * Solo para desarrollo y demostraciones, como el resto de `semilla.ts`. Se agrega una vez: si ya
 * está la ficha de Mariela Ríos, no toca nada.
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

export async function seedDemoCustomers(tx: Db, storeId: string): Promise<void> {
  const [done] = await tx
    .select({ id: customer.id })
    .from(customer)
    .where(and(eq(customer.storeId, storeId), eq(customer.name, "Mariela Ríos")))
    .limit(1)
  if (done) return
  const variant = async (name: string, values: string[]) => {
    const rows = await tx
      .select({ id: productVariant.id, values: productVariant.optionValues })
      .from(productVariant)
      .innerJoin(product, eq(product.id, productVariant.productId))
      .where(and(eq(productVariant.storeId, storeId), eq(product.name, name)))
    const row = rows.find((r) => r.values.join(" ") === values.join(" "))
    if (!row) throw new Error(`semilla: falta ${name} ${values.join(" ")}`)
    return row.id
  }
  const idOf = async (
    table: typeof storePaymentMethod | typeof storeDeliveryMethod,
    name: string,
  ) => {
    const [row] = await tx
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.storeId, storeId), eq(table.name, name)))
    if (!row) throw new Error(`semilla: falta ${name}`)
    return row.id
  }
  const reparto = await idOf(storeDeliveryMethod, "Reparto en Lima")
  const provincia = await idOf(storeDeliveryMethod, "Envío a provincia")
  const yape = await idOf(storePaymentMethod, "Yape")

  const create = async (input: Partial<z.input<typeof orderInput>>) =>
    createOrderIn(
      tx,
      storeId,
      lucia.userId,
      orderInput.parse({
        channel: "whatsapp",
        deliveryMethodId: reparto,
        zone: "Surco y Miraflores",
        paymentMethodId: yape,
        ...input,
      }),
    )
  const deliver = async (orderId: string, amountCents: number, operation: string) => {
    const detail = await addReceipt(tx, lucia, storeId, orderId, { amountCents, operation }, null)
    await reviewPayment(tx, rosa, storeId, orderId, detail.payments.at(-1)!.id, {
      decision: "confirmar",
    })
    await markShipped(tx, lucia, storeId, orderId, { tracking: "SHALOM-448120", agency: null })
    await markDelivered(tx, lucia, storeId, orderId, {
      collectedCents: null,
      methodId: null,
      payments: [],
    })
  }

  // Mariela Ríos, por Instagram: la zapatilla blanca 38 a Arequipa por agencia, ya entregada.
  const blanca = await create({
    customerName: "Mariela Ríos",
    channel: "instagram",
    address: "Shalom Arequipa, agencia Av. Ejército",
    lines: [{ variantId: await variant("Zapatilla urbana", ["blanca", "38"]), quantity: 1 }],
    deliveryMethodId: provincia,
    zone: null,
    deliveryListCents: 0,
  })
  await deliver(blanca.id, blanca.totalCents, "00873311")
  const [ficha] = await tx
    .select({ id: customer.id })
    .from(customer)
    .where(and(eq(customer.storeId, storeId), eq(customer.name, "Mariela Ríos")))
  await tx
    .update(customer)
    .set({
      note: "Talla 38. Prefiere Shalom y paga el envío en destino.",
      noteBy: lucia.userId,
      noteAt: new Date(),
    })
    .where(eq(customer.id, ficha!.id))

  // Otra Mariela Ríos, por WhatsApp, pide la negra 38: ¿es la misma? Lo decide una persona.
  await create({
    customerName: "Mariela Ríos",
    customerPhone: "+51 987 654 322",
    address: "Shalom Arequipa, agencia Av. Ejército",
    lines: [{ variantId: await variant("Zapatilla urbana", ["negra", "38"]), quantity: 1 }],
    deliveryMethodId: provincia,
    zone: null,
    deliveryListCents: 0,
  })

  // Andrea Castillo: por Instagram y por WhatsApp. Lucía dijo que es la misma clienta.
  const instagram = await create({
    customerName: "Andrea Castillo",
    channel: "instagram",
    address: "Av. Javier Prado Oeste 640, San Isidro",
    lines: [{ variantId: await variant("Sandalia", ["beige", "37"]), quantity: 1 }],
  })
  await deliver(instagram.id, instagram.totalCents, "00873390")
  const whatsapp = await create({
    customerName: "Andrea Castillo",
    customerPhone: "+51 955 210 778",
    address: "Av. Javier Prado Oeste 640, San Isidro",
    lines: [{ variantId: await variant("Sandalia", ["negra", "38"]), quantity: 1 }],
  })
  await mergeCustomersIn(tx, storeId, lucia.userId, {
    a: instagram.customerId!,
    b: whatsapp.customerId!,
  })
}

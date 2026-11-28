import {
  conversation,
  conversationMessage,
  customer,
  customerConsent,
  type Db,
  orderPayment,
  product,
  productVariant,
  saleOrder,
  stockMovement,
  stockRequest,
  storeDeliveryMethod,
  storePaymentMethod,
} from "@gestoria/db"
import { and, eq, isNull, sql } from "drizzle-orm"
import type { z } from "zod"
import { SOFI_ACTOR } from "./agente.js"
import { recomputeStoreIn } from "./clientas-grupos.js"
import type { Person } from "./cuenta.js"
import {
  addReceipt,
  createOrderIn,
  markDelivered,
  markShipped,
  orderInput,
  reviewPayment,
  stockReference,
} from "./pedidos.js"

/**
 * Los grupos de las clientas de Calzados Rosa (lienzo «Clientas bien perfiladas y Argos que hace
 * el marketing solo»), como en el prototipo: que la lista muestre los siete grupos con clientas
 * creíbles. Los pedidos se arman con las operaciones de siempre (anotar, captura, confirmar, salir
 * y entregar) y después se mueven a su día con el dueño de la base, porque la historia necesita
 * compras de meses atrás y la base pone la hora de ahora:
 *
 * - Se mueven la fecha del pedido, su historia, su pago (pausando un momento la regla que solo deja
 *   dar los pasos de la revisión: lo único que cambia es la fecha) y su venta en el kardex, con una
 *   entrada de reposición justo antes para que el stock de hoy quede igual.
 * - Andrea Castillo (de `semilla-clientes.ts` y `semilla-perfil.ts`): compraba sandalias beige 37
 *   cada 40 días y ya van 62: en riesgo. Su chat con Sofi se mueve con su pedido; su pedido por
 *   pagar de hoy queda como carrito sin pagar.
 * - Rocío Vega (de `semilla-pedidos.ts`) suma dos compras de antes: frecuente.
 * - Natalia Gómez, VIP con 6 compras; Lorena Vargas, frecuente y «pide rebaja»; Fiorella Quispe,
 *   Daniela Cruz y Teresa Huerta, frecuentes; Cecilia Ramos, dormida, con una cotización de Sofi que
 *   no terminó en pedido; Sandra Llanos, perdida; Jimena Paredes, sin compras, con un pedido sin
 *   pagar de hace días y el botín 43 que pidió agotado. Las nuevas son las de los pedidos de hoy.
 *
 * Al final recalcula `customer_profile` de la tienda (lo que hace la vuelta de la noche). Solo para
 * desarrollo, como el resto de `semilla.ts`, con el dueño de la base. Se agrega una vez: si ya está
 * la ficha de Lorena Vargas, solo recalcula.
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

const DAY = sql.raw("interval '1 day'")

export async function seedDemoSegments(ownerDb: Db, storeId: string): Promise<void> {
  await ownerDb.transaction(async (raw) => {
    const tx = raw as unknown as Db
    const [done] = await tx
      .select({ id: customer.id })
      .from(customer)
      .where(and(eq(customer.storeId, storeId), eq(customer.name, "Lorena Vargas")))
      .limit(1)
    if (!done) await seedHistory(tx, storeId)
    await recomputeStoreIn(tx, storeId)
  })
}

async function seedHistory(tx: Db, storeId: string) {
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
  const yape = await idOf(storePaymentMethod, "Yape")
  const fichaOf = async (name: string) => {
    const [row] = await tx
      .select({ id: customer.id })
      .from(customer)
      .where(
        and(eq(customer.storeId, storeId), eq(customer.name, name), isNull(customer.mergedInto)),
      )
      .orderBy(customer.createdAt)
      .limit(1)
    if (!row) throw new Error(`semilla: falta la ficha de ${name}`)
    return row.id
  }
  let operation = 55_000_000

  /** Mueve un pedido, su historia, sus pagos y su venta en el kardex `days` días atrás. */
  const moveBack = async (orderId: string, days: number) => {
    const [order] = await tx
      .select({ number: saleOrder.number })
      .from(saleOrder)
      .where(eq(saleOrder.id, orderId))
    const back = sql`${days} * ${DAY}`
    const ref = stockReference(order!.number)
    await tx.execute(sql`update sale_order set created_at = created_at - ${back},
      updated_at = updated_at - ${back} where id = ${orderId}`)
    await tx.execute(
      sql`update order_event set created_at = created_at - ${back} where order_id = ${orderId}`,
    )
    await tx.execute(sql`update stock_movement set created_at = created_at - ${back}
      where store_id = ${storeId} and (reference = ${ref} or reference like ${`${ref} · %`})`)
    // La regla del pago solo deja dar los pasos de su revisión: aquí solo cambia la fecha.
    await tx.execute(sql`alter table order_payment disable trigger order_payment_step`)
    await tx.execute(sql`update order_payment set created_at = created_at - ${back},
      reviewed_at = reviewed_at - ${back} where order_id = ${orderId}`)
    await tx.execute(sql`alter table order_payment enable trigger order_payment_step`)
  }

  /** Una reposición de una unidad, justo antes de la venta: el stock de hoy queda igual. */
  const restock = async (variantId: string, days: number) => {
    await tx.insert(stockMovement).values({
      storeId,
      variantId,
      kind: "entrada",
      quantity: 1,
      reason: "Reposición",
      actorUserId: rosa.userId,
      createdAt: new Date(Date.now() - days * 86_400_000 - 3_600_000),
    })
  }

  /** Paga con la captura, se confirma, sale y se entrega. */
  const settle = async (orderId: string, totalCents: number | null) => {
    const [pending] = await tx
      .select({ id: orderPayment.id })
      .from(orderPayment)
      .where(and(eq(orderPayment.orderId, orderId), eq(orderPayment.status, "por_confirmar")))
    let paymentId = pending?.id
    if (!paymentId) {
      const detail = await addReceipt(
        tx,
        lucia,
        storeId,
        orderId,
        { amountCents: totalCents!, operation: String(++operation) },
        null,
      )
      paymentId = detail.payments.at(-1)!.id
    }
    await reviewPayment(tx, rosa, storeId, orderId, paymentId, { decision: "confirmar" })
    await markShipped(tx, lucia, storeId, orderId, { tracking: null, agency: null })
    await markDelivered(tx, lucia, storeId, orderId, {
      collectedCents: null,
      methodId: null,
      payments: [],
    })
  }

  /** Una compra de hace `days` días, entregada. */
  const bought = async (
    days: number,
    input: Partial<z.input<typeof orderInput>> & { variantId: string; unitCents?: number },
    options: { conversationId?: string } = {},
  ) => {
    await restock(input.variantId, days)
    const { variantId, unitCents, ...rest } = input
    const order = await createOrderIn(
      tx,
      storeId,
      options.conversationId ? SOFI_ACTOR : lucia.userId,
      orderInput.parse({
        channel: "whatsapp",
        deliveryMethodId: reparto,
        zone: "Surco y Miraflores",
        paymentMethodId: yape,
        ...rest,
        lines: [{ variantId, quantity: 1, unitCents: unitCents ?? null }],
      }),
      { conversationId: options.conversationId ?? null },
    )
    await settle(order.id, order.totalCents)
    await moveBack(order.id, days)
    return order
  }

  /** Una conversación por WhatsApp con sus mensajes, desde hace `days` días. */
  const talk = async (
    name: string,
    days: number,
    lines: ["cliente" | "sofi", string, object?][],
  ) => {
    const start = Date.now() - days * 86_400_000
    const [row] = await tx
      .insert(conversation)
      .values({
        storeId,
        channel: "whatsapp",
        customerName: name,
        createdBy: "canal",
        createdAt: new Date(start),
        updatedAt: new Date(start + lines.length * 60_000),
        lastCustomerAt: new Date(start),
      })
      .returning({ id: conversation.id })
    for (const [i, [author, text, detail]] of lines.entries())
      await tx.insert(conversationMessage).values({
        storeId,
        conversationId: row!.id,
        author,
        text,
        delivery: author === "cliente" ? null : "sin_enviar",
        detail: (detail ?? {}) as Record<string, unknown>,
        actorUserId: author === "sofi" ? SOFI_ACTOR : "canal",
        createdAt: new Date(start + i * 60_000),
      })
    return row!.id
  }

  const sandalia = (color: string, size: string) => variant("Sandalia", [color, size])
  const zapatilla = (color: string, size: string) => variant("Zapatilla urbana", [color, size])

  // Andrea Castillo: sandalias beige 37 cada 40 días y ya van 62 (en riesgo).
  const andrea = await fichaOf("Andrea Castillo")
  const andreaOrders = await tx
    .select({
      id: saleOrder.id,
      state: saleOrder.state,
      channel: saleOrder.channel,
      conversationId: saleOrder.conversationId,
      totalCents: saleOrder.totalCents,
    })
    .from(saleOrder)
    .innerJoin(customer, eq(customer.id, saleOrder.customerId))
    .where(
      and(
        eq(saleOrder.storeId, storeId),
        sql`coalesce(${customer.mergedInto}, ${customer.id}) = ${andrea}`,
      ),
    )
  const byInstagram = andreaOrders.find((o) => o.channel === "instagram" && o.state === "entregado")
  if (byInstagram) await moveBack(byInstagram.id, 142)
  await bought(102, {
    customerId: andrea,
    address: "Av. Javier Prado Oeste 640, San Isidro",
    variantId: await sandalia("beige", "37"),
  })
  const fromChat = andreaOrders.find((o) => o.conversationId && o.state === "por_confirmar")
  if (fromChat) {
    await settle(fromChat.id, fromChat.totalCents)
    await moveBack(fromChat.id, 62)
    // Su chat con Sofi fue ese día: la conversación, sus mensajes y su permiso van con él.
    const conv = fromChat.conversationId!
    const back = sql`62 * ${DAY}`
    await tx.execute(sql`update conversation set created_at = created_at - ${back},
      updated_at = updated_at - ${back}, last_customer_at = last_customer_at - ${back}
      where id = ${conv}`)
    await tx.execute(sql`update conversation_message set created_at = created_at - ${back}
      where conversation_id = ${conv}`)
    await tx
      .update(customerConsent)
      .set({ createdAt: sql`${customerConsent.createdAt} - ${back}` })
      .where(eq(customerConsent.conversationId, conv))
  }

  // Rocío Vega compra sandalias beige 38 cada tanto: dos compras de antes y la de hoy.
  const rocio = await fichaOf("Rocío Vega")
  for (const days of [140, 200])
    await bought(days, {
      customerId: rocio,
      address: "Jr. Las Begonias 455, Surco",
      variantId: await sandalia("beige", "38"),
    })

  // Natalia Gómez, VIP: 6 compras en los últimos seis meses.
  const natalia = await bought(170, {
    customerName: "Natalia Gómez",
    customerPhone: "+51 984 112 650",
    address: "Calle Monte Rosa 255, Surco",
    variantId: await zapatilla("blanca", "37"),
  })
  for (const [days, v] of [
    [120, await sandalia("beige", "37")],
    [75, await zapatilla("negra", "37")],
    [40, await zapatilla("blanca", "37")],
    [9, await sandalia("negra", "37")],
    [3, await variant("Mocasín azul", ["38"])],
  ] as const)
    await bought(days, {
      customerId: natalia.customerId,
      address: "Calle Monte Rosa 255, Surco",
      variantId: v,
    })

  // Lorena Vargas pide rebaja: dos de sus tres zapatillas con precio acordado.
  const lorena = await bought(115, {
    customerName: "Lorena Vargas",
    customerPhone: "+51 967 554 031",
    address: "Av. San Luis 2050, San Borja",
    variantId: await zapatilla("blanca", "39"),
  })
  await bought(75, {
    customerId: lorena.customerId,
    address: "Av. San Luis 2050, San Borja",
    variantId: await zapatilla("blanca", "39"),
    unitCents: 11_500,
  })
  await bought(4, {
    customerId: lorena.customerId,
    address: "Av. San Luis 2050, San Borja",
    variantId: await zapatilla("blanca", "39"),
    unitCents: 12_000,
  })

  // Fiorella Quispe, Daniela Cruz y Teresa Huerta: al día con su ritmo.
  const fiorella = await bought(60, {
    customerName: "Fiorella Quispe",
    customerPhone: "+51 977 019 332",
    address: "Av. Universitaria 6020, Los Olivos",
    zone: "Callao",
    variantId: await sandalia("negra", "36"),
  })
  await bought(25, {
    customerId: fiorella.customerId,
    address: "Av. Universitaria 6020, Los Olivos",
    zone: "Callao",
    variantId: await sandalia("negra", "36"),
  })
  const daniela = await bought(64, {
    customerName: "Daniela Cruz",
    customerPhone: "+51 952 008 413",
    address: "Jr. Bernardo Alcedo 380, Lince",
    variantId: await sandalia("beige", "36"),
  })
  await bought(28, {
    customerId: daniela.customerId,
    address: "Jr. Bernardo Alcedo 380, Lince",
    variantId: await sandalia("beige", "36"),
  })
  const teresa = await bought(70, {
    customerName: "Teresa Huerta",
    customerPhone: "+51 936 771 205",
    address: "Av. Grau 520, Barranco",
    variantId: await sandalia("negra", "37"),
  })
  for (const [days, v] of [
    [30, await sandalia("negra", "37")],
    [2, await zapatilla("negra", "39")],
  ] as const)
    await bought(days, {
      customerId: teresa.customerId,
      address: "Av. Grau 520, Barranco",
      variantId: v,
    })

  // Cecilia Ramos, dormida: compraba mocasines por el chat; hace dos días Sofi le cotizó otro y no
  // cerró (la cotización queda en la respuesta de Sofi, como la deja el chat).
  const cecilia = await talk("Cecilia Ramos", 180, [
    ["cliente", "Hola, ¿tienen el mocasín azul en 39?"],
    ["sofi", "¡Hola! Soy Sofi, de Calzados Rosa. Sí, el Mocasín azul en 39 está disponible."],
  ])
  const mocasin39 = await variant("Mocasín azul", ["39"])
  for (const days of [180, 120])
    await bought(
      days,
      {
        customerName: "Cecilia Ramos",
        customerPhone: "+51 945 330 187",
        address: "Calle Schell 343, Miraflores",
        variantId: mocasin39,
      },
      { conversationId: cecilia },
    )
  const mocasin40 = await variant("Mocasín azul", ["40"])
  const quoteKey = JSON.stringify([
    [[mocasin40, 1, null, false]],
    reparto,
    "Surco y Miraflores",
    null,
    null,
    15_900,
  ])
  const twoDaysAgo = Date.now() - 2 * 86_400_000
  await tx.insert(conversationMessage).values([
    {
      storeId,
      conversationId: cecilia,
      author: "cliente",
      text: "Hola de nuevo, ¿el mocasín azul en 40 cuánto me sale a Miraflores?",
      actorUserId: "canal",
      createdAt: new Date(twoDaysAgo),
    },
    {
      storeId,
      conversationId: cecilia,
      author: "sofi",
      text: "Te sale S/ 159 con el envío a Miraflores. ¿Te lo anoto?",
      delivery: "sin_enviar",
      detail: { quotes: [quoteKey] },
      actorUserId: SOFI_ACTOR,
      createdAt: new Date(twoDaysAgo + 60_000),
    },
    {
      storeId,
      conversationId: cecilia,
      author: "cliente",
      text: "Lo pienso y te aviso",
      actorUserId: "canal",
      createdAt: new Date(twoDaysAgo + 120_000),
    },
  ])
  await tx
    .update(conversation)
    .set({
      updatedAt: new Date(twoDaysAgo + 120_000),
      lastCustomerAt: new Date(twoDaysAgo + 120_000),
    })
    .where(eq(conversation.id, cecilia))

  // Sandra Llanos, perdida: su único botín fue hace más de un año.
  await bought(400, {
    customerName: "Sandra Llanos",
    address: "Av. Arenales 1800, Lince",
    variantId: await variant("Botín de cuero marrón", ["40"]),
  })

  // Jimena Paredes, sin compras: dejó un botín sin pagar hace tres días y pidió el 43, agotado.
  const jimena = await talk("Jimena Paredes", 3, [
    ["cliente", "Hola, ¿el botín de cuero marrón en 43?"],
    ["sofi", "¡Hola! El 43 está agotado; te aviso apenas vuelva. En 41 sí hay."],
    ["cliente", "Ya, anótame el 41 entonces"],
  ])
  const unpaid = await createOrderIn(
    tx,
    storeId,
    SOFI_ACTOR,
    orderInput.parse({
      customerName: "Jimena Paredes",
      customerPhone: "+51 913 448 120",
      channel: "whatsapp",
      address: "Av. La Marina 1200, San Miguel",
      deliveryMethodId: reparto,
      zone: "Surco y Miraflores",
      paymentMethodId: yape,
      lines: [{ variantId: await variant("Botín de cuero marrón", ["41"]), quantity: 1 }],
    }),
    { conversationId: jimena },
  )
  await moveBack(unpaid.id, 3)
  await tx.insert(stockRequest).values({
    storeId,
    variantId: await variant("Botín de cuero marrón", ["43"]),
    conversationId: jimena,
    createdAt: new Date(Date.now() - 3 * 86_400_000),
  })

  // Cada ficha nueva nace el día de su primera compra.
  await tx.execute(sql`update customer c set created_at = least(c.created_at,
      (select min(o.created_at) from sale_order o where o.customer_id = c.id))
    where c.store_id = ${storeId} and exists (select 1 from sale_order o where o.customer_id = c.id)`)
}

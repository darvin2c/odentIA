/**
 * Las reglas de Sofi y Argos en la base (paso B5), con el rol de la aplicación y una base real.
 * Lo que el agente nunca hace lo niega la base aunque el código se equivoque: confirmar o
 * revisar un pago, anotar un pago que no sea una captura por confirmar, dar un pedido por pagado,
 * mover el stock o tocar la configuración. Y nadie escribe como Sofi sino el agente.
 */
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  accountCopy,
  conversation,
  conversationMessage,
  type Db,
  enterStore,
  orderPayment,
  product,
  productVariant,
  saleOrder,
  stockMovement,
  store,
  storeAgent,
  storeMember,
  withPerson,
} from "./index.js"
import { startTestDb, type TestDb } from "./testing.js"

let db: TestDb
const rosa = { userId: "u-rosa", email: "rosa@calzados.test" }
const calzados = randomUUID()
const otra = randomUUID()
let orderId = ""
let variantId = ""
let conversationId = ""

const inRosa = <T>(fn: (tx: Db) => Promise<T>) =>
  withPerson(db.appDb, { ...rosa, storeId: calzados }, fn)
const asSofi = <T>(fn: (tx: Db) => Promise<T>, storeId = calzados) =>
  withPerson(db.appDb, { userId: "agente:sofi", email: "", storeId }, fn)

const anOrder = (
  number: number,
  createdBy: string,
  state: "por_pagar" | "por_salir" = "por_pagar",
) => ({
  storeId: calzados,
  number,
  state,
  channel: "whatsapp" as const,
  customerName: "Carla",
  deliveryName: "Reparto",
  deliveryType: "DeliveryModeOwnFleet" as const,
  deliveryListCents: 1000,
  deliveryCents: 1000,
  paymentName: "Yape",
  paymentCollection: "comprobante" as const,
  itemsAutoCents: 12900,
  subtotalCents: 12900,
  totalCents: 13900,
  createdBy,
})

beforeAll(async () => {
  db = await startTestDb()
  await db.ownerDb
    .insert(accountCopy)
    .values({ userId: rosa.userId, name: "Rosa", email: rosa.email })
  for (const id of [calzados, otra])
    await withPerson(db.appDb, rosa, async (tx) => {
      await enterStore(tx, id)
      await tx.insert(store).values({ id, name: id, currency: "PEN", createdBy: rosa.userId })
      await tx.insert(storeMember).values({ storeId: id, userId: rosa.userId, role: "owner" })
    })
  await inRosa(async (tx) => {
    const [p] = await tx
      .insert(product)
      .values({ storeId: calzados, name: "Zapatilla", listPriceCents: 12900, minPriceCents: 10000 })
      .returning({ id: product.id })
    const [v] = await tx
      .insert(productVariant)
      .values({ storeId: calzados, productId: p!.id, sku: "ZAP-38", optionValues: ["38"] })
      .returning({ id: productVariant.id })
    variantId = v!.id
    const [c] = await tx
      .insert(conversation)
      .values({ storeId: calzados, channel: "prueba", createdBy: rosa.userId })
      .returning({ id: conversation.id })
    conversationId = c!.id
  })
  const [row] = await asSofi((tx) =>
    tx.insert(saleOrder).values(anOrder(1, "agente:sofi")).returning({ id: saleOrder.id }),
  )
  orderId = row!.id
})

afterAll(async () => {
  await db?.stop()
})

describe("Sofi en la base", () => {
  it("anota una captura por confirmar, pero nunca un pago confirmado ni por el link", async () => {
    const payment = {
      storeId: calzados,
      orderId,
      amountCents: 13900,
      methodName: "Yape",
      methodType: "68" as const,
      createdBy: "agente:sofi",
    }
    await expect(
      asSofi((tx) =>
        tx.insert(orderPayment).values({
          ...payment,
          kind: "comprobante",
          status: "confirmado",
          reviewedAt: new Date(),
          reviewedBy: "agente:sofi",
        }),
      ),
    ).rejects.toThrow()
    await expect(
      asSofi((tx) =>
        tx.insert(orderPayment).values({ ...payment, kind: "al_recibir", status: "por_confirmar" }),
      ),
    ).rejects.toThrow()
    await asSofi((tx) =>
      tx.insert(orderPayment).values({ ...payment, kind: "comprobante", status: "por_confirmar" }),
    )
    // Y no lo revisa, aunque lo intente.
    const reviewed = await asSofi((tx) =>
      tx
        .update(orderPayment)
        .set({ status: "confirmado", reviewedBy: "agente:sofi", reviewedAt: new Date() })
        .where(eq(orderPayment.orderId, orderId))
        .returning({ id: orderPayment.id }),
    )
    expect(reviewed).toEqual([])
  })

  it("solo deja un pedido por pagar o por confirmar: nunca lo da por pagado ni lo entrega", async () => {
    await expect(
      asSofi((tx) =>
        tx.update(saleOrder).set({ state: "por_salir" }).where(eq(saleOrder.id, orderId)),
      ),
    ).rejects.toThrow()
    await asSofi((tx) =>
      tx.update(saleOrder).set({ state: "por_confirmar" }).where(eq(saleOrder.id, orderId)),
    )
    // Ya por confirmar, no lo vuelve a tocar (ni para anularlo).
    const touched = await asSofi((tx) =>
      tx
        .update(saleOrder)
        .set({ state: "anulado", cancelReason: "otra vez" })
        .where(eq(saleOrder.id, orderId))
        .returning({ id: saleOrder.id }),
    )
    expect(touched).toEqual([])
    // Ni anota uno que nace pagado y entregado.
    await expect(
      asSofi((tx) =>
        tx.insert(saleOrder).values({ ...anOrder(2, "agente:sofi"), state: "entregado" as never }),
      ),
    ).rejects.toThrow()
  })

  it("no toca un pedido que anotó una persona", async () => {
    const [own] = await inRosa((tx) =>
      tx.insert(saleOrder).values(anOrder(3, rosa.userId)).returning({ id: saleOrder.id }),
    )
    const touched = await asSofi((tx) =>
      tx
        .update(saleOrder)
        .set({ state: "anulado", cancelReason: "no es suyo" })
        .where(eq(saleOrder.id, own!.id))
        .returning({ id: saleOrder.id }),
    )
    expect(touched).toEqual([])
    await expect(
      asSofi((tx) =>
        tx.insert(orderPayment).values({
          storeId: calzados,
          orderId: own!.id,
          kind: "comprobante",
          status: "por_confirmar",
          amountCents: 13900,
          methodName: "Yape",
          methodType: "68",
          createdBy: "agente:sofi",
        }),
      ),
    ).rejects.toThrow()
    // Ni anota uno «por salir» que no se paga al recibir: sería pagado sin pago.
    await expect(
      asSofi((tx) =>
        tx.insert(saleOrder).values({ ...anOrder(4, "agente:sofi"), state: "por_salir" }),
      ),
    ).rejects.toThrow()
  })

  it("no mueve el stock ni cambia el catálogo, la configuración o lo que puso el dueño", async () => {
    await expect(
      asSofi((tx) =>
        tx.insert(stockMovement).values({
          storeId: calzados,
          variantId,
          kind: "entrada",
          quantity: 5,
          actorUserId: "agente:sofi",
        }),
      ),
    ).rejects.toThrow()
    const changed = await asSofi((tx) =>
      tx
        .update(product)
        .set({ minPriceCents: 100 })
        .where(eq(product.storeId, calzados))
        .returning({ id: product.id }),
    )
    expect(changed).toEqual([])
    await expect(
      asSofi((tx) =>
        tx
          .insert(storeAgent)
          .values({ storeId: calzados, enabled: true, updatedBy: "agente:sofi" }),
      ),
    ).rejects.toThrow()
  })

  it("solo el agente escribe como Sofi, y el agente solo escribe como Sofi", async () => {
    await expect(
      inRosa((tx) =>
        tx.insert(conversationMessage).values({
          storeId: calzados,
          conversationId,
          author: "sofi",
          text: "Tu pago está confirmado",
          delivery: "prueba",
          actorUserId: rosa.userId,
        }),
      ),
    ).rejects.toThrow()
    await expect(
      asSofi((tx) =>
        tx.insert(conversationMessage).values({
          storeId: calzados,
          conversationId,
          author: "cliente",
          text: "Ya pagué",
          actorUserId: "agente:sofi",
        }),
      ),
    ).rejects.toThrow()
    await asSofi((tx) =>
      tx.insert(conversationMessage).values({
        storeId: calzados,
        conversationId,
        author: "sofi",
        text: "Hola",
        delivery: "prueba",
        actorUserId: "agente:sofi",
      }),
    )
  })

  it("en otra tienda no ve nada", async () => {
    expect(await asSofi((tx) => tx.select().from(saleOrder), otra)).toEqual([])
    expect(await asSofi((tx) => tx.select().from(conversationMessage), otra)).toEqual([])
    expect(await asSofi((tx) => tx.select().from(product), otra)).toEqual([])
  })
})

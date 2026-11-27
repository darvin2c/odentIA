/**
 * Las reglas de los pedidos (paso B4), con el rol de la aplicación y una base real: cada tienda
 * ve solo sus pedidos; lo acordado (precios, totales, líneas) no se cambia; un pago solo se
 * revisa a nombre de quien pide; la historia y el link de pago son de su tienda.
 */
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  accountCopy,
  type Db,
  enterStore,
  orderEvent,
  orderPayment,
  saleOrder,
  saleOrderLine,
  store,
  storeMember,
  storePaymentLink,
  withPerson,
} from "./index.js"
import { startTestDb, type TestDb } from "./testing.js"

let db: TestDb
const rosa = { userId: "u-rosa", email: "rosa@calzados.test" }
const mario = { userId: "u-mario", email: "mario@otra.test" }
const calzados = randomUUID()
const otra = randomUUID()
let orderId = ""

const inRosa = <T>(fn: (tx: Db) => Promise<T>) =>
  withPerson(db.appDb, { ...rosa, storeId: calzados }, fn)
const inMario = <T>(fn: (tx: Db) => Promise<T>) =>
  withPerson(db.appDb, { ...mario, storeId: otra }, fn)

const anOrder = (storeId: string, number: number, createdBy: string) => ({
  storeId,
  number,
  state: "por_pagar" as const,
  channel: "otro" as const,
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
  await db.ownerDb.insert(accountCopy).values([
    { userId: rosa.userId, name: "Rosa", email: rosa.email },
    { userId: mario.userId, name: "Mario", email: mario.email },
  ])
  for (const [who, id] of [
    [rosa, calzados],
    [mario, otra],
  ] as const)
    await withPerson(db.appDb, who, async (tx) => {
      await enterStore(tx, id)
      await tx.insert(store).values({ id, name: id, currency: "PEN", createdBy: who.userId })
      await tx.insert(storeMember).values({ storeId: id, userId: who.userId, role: "owner" })
    })
  const [row] = await inRosa((tx) =>
    tx
      .insert(saleOrder)
      .values(anOrder(calzados, 1, rosa.userId))
      .returning({ id: saleOrder.id }),
  )
  orderId = row!.id
})

afterAll(async () => {
  await db?.stop()
})

describe("los pedidos de cada tienda", () => {
  it("otra tienda no ve ni toca los pedidos, sus pagos ni su historia", async () => {
    await inRosa(async (tx) => {
      await tx.insert(orderEvent).values({
        storeId: calzados,
        orderId,
        actorUserId: rosa.userId,
        action: "creado",
      })
      await tx.insert(orderPayment).values({
        storeId: calzados,
        orderId,
        kind: "comprobante",
        status: "por_confirmar",
        amountCents: 13900,
        createdBy: rosa.userId,
      })
    })
    expect(await inMario((tx) => tx.select().from(saleOrder))).toEqual([])
    expect(await inMario((tx) => tx.select().from(orderPayment))).toEqual([])
    expect(await inMario((tx) => tx.select().from(orderEvent))).toEqual([])
    const changed = await inMario((tx) =>
      tx
        .update(saleOrder)
        .set({ state: "anulado", cancelReason: "no" })
        .where(eq(saleOrder.id, orderId))
        .returning(),
    )
    expect(changed).toEqual([])
    // Ni anota un pedido a nombre de otra tienda.
    await expect(
      inMario((tx) => tx.insert(saleOrder).values(anOrder(calzados, 2, mario.userId))),
    ).rejects.toThrow()
  })

  it("lo acordado no se cambia: ni el total ni las líneas", async () => {
    await expect(
      inRosa((tx) =>
        tx.update(saleOrder).set({ totalCents: 100 }).where(eq(saleOrder.id, orderId)),
      ),
    ).rejects.toThrow()
    await expect(
      inRosa((tx) =>
        tx.update(saleOrderLine).set({ unitCents: 1 }).where(eq(saleOrderLine.orderId, orderId)),
      ),
    ).rejects.toThrow()
    await expect(
      inRosa((tx) => tx.delete(saleOrder).where(eq(saleOrder.id, orderId))),
    ).rejects.toThrow()
  })

  it("un pago se revisa a nombre de quien pide; la historia, también", async () => {
    await expect(
      inRosa((tx) =>
        tx
          .update(orderPayment)
          .set({ status: "confirmado", reviewedBy: mario.userId, reviewedAt: new Date() })
          .where(eq(orderPayment.orderId, orderId)),
      ),
    ).rejects.toThrow()
    await expect(
      inRosa((tx) =>
        tx.update(orderPayment).set({ amountCents: 1 }).where(eq(orderPayment.orderId, orderId)),
      ),
    ).rejects.toThrow()
    await expect(
      inRosa((tx) =>
        tx
          .insert(orderEvent)
          .values({ storeId: calzados, orderId, actorUserId: mario.userId, action: "salio" }),
      ),
    ).rejects.toThrow()
    // «No coincide» pide motivo, y anular también.
    await expect(
      inRosa((tx) =>
        tx
          .update(orderPayment)
          .set({ status: "no_coincide", reviewedBy: rosa.userId, reviewedAt: new Date() })
          .where(eq(orderPayment.orderId, orderId)),
      ),
    ).rejects.toThrow()
    await expect(
      inRosa((tx) =>
        tx.update(saleOrder).set({ state: "anulado" }).where(eq(saleOrder.id, orderId)),
      ),
    ).rejects.toThrow()
  })

  it("un pago por el link solo lo anota el sistema, y un pago revisado no se vuelve a revisar", async () => {
    await expect(
      inRosa((tx) =>
        tx.insert(orderPayment).values({
          storeId: calzados,
          orderId,
          kind: "link",
          status: "confirmado",
          amountCents: 13900,
          provider: "mercadopago",
          providerRef: "1",
          reviewedAt: new Date(),
          createdBy: rosa.userId,
        }),
      ),
    ).rejects.toThrow()
    const reviewed = await inRosa((tx) =>
      tx
        .update(orderPayment)
        .set({ status: "confirmado", reviewedBy: rosa.userId, reviewedAt: new Date() })
        .where(eq(orderPayment.orderId, orderId))
        .returning({ id: orderPayment.id }),
    )
    expect(reviewed).toHaveLength(1)
    const again = await inRosa((tx) =>
      tx
        .update(orderPayment)
        .set({ status: "no_coincide", note: "otra vez", reviewedBy: rosa.userId })
        .where(eq(orderPayment.orderId, orderId))
        .returning({ id: orderPayment.id }),
    )
    expect(again).toEqual([])
  })

  it("el link de pago es de su tienda y nadie más lo lee", async () => {
    await inRosa((tx) =>
      tx.insert(storePaymentLink).values({
        storeId: calzados,
        provider: "mercadopago",
        accessTokenEnc: "v1:x:y:z",
        hint: "abcd",
        connectedBy: rosa.userId,
      }),
    )
    expect(await inMario((tx) => tx.select().from(storePaymentLink))).toEqual([])
    await expect(
      inMario((tx) =>
        tx.insert(storePaymentLink).values({
          storeId: calzados,
          provider: "mercadopago",
          accessTokenEnc: "v1:x:y:z",
          hint: "abcd",
          connectedBy: mario.userId,
        }),
      ),
    ).rejects.toThrow()
  })

  it("la hora de la tienda la cambia solo su tienda, y nada más que la hora", async () => {
    const zone = (tx: Db, id: string) =>
      tx.select({ timeZone: store.timeZone }).from(store).where(eq(store.id, id))
    expect(await inRosa((tx) => zone(tx, calzados))).toEqual([{ timeZone: "America/Lima" }])
    await inRosa((tx) =>
      tx.update(store).set({ timeZone: "America/Bogota" }).where(eq(store.id, calzados)),
    )
    expect(await inRosa((tx) => zone(tx, calzados))).toEqual([{ timeZone: "America/Bogota" }])
    // Desde otra tienda no se toca.
    const other = await inMario((tx) =>
      tx
        .update(store)
        .set({ timeZone: "Europe/London" })
        .where(eq(store.id, calzados))
        .returning({ id: store.id }),
    )
    expect(other).toEqual([])
    // El nombre y la moneda no se cambian desde la aplicación.
    await expect(
      inRosa((tx) => tx.update(store).set({ currency: "USD" }).where(eq(store.id, calzados))),
    ).rejects.toThrow()
    // Lo que no tiene forma de zona horaria no entra.
    await expect(
      inRosa((tx) =>
        tx.update(store).set({ timeZone: "'; drop table store" }).where(eq(store.id, calzados)),
      ),
    ).rejects.toThrow()
  })
})

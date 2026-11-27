/**
 * Las reglas de los pedidos (paso B4), con el rol de la aplicación y una base real: cada tienda
 * ve solo sus pedidos; al cambiar uno (ADR 0224) el total sigue siendo su suma y las líneas se
 * reemplazan enteras; un pago solo se revisa a nombre de quien pide, y deshacer su confirmación
 * lo deja esperando a nadie; la historia y el link de pago son de su tienda.
 */
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  accountCopy,
  type Db,
  enterStore,
  orderBalance,
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
        methodName: "Yape",
        methodType: "68",
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

  it("al cambiar un pedido, el total sigue siendo su suma y las líneas se reemplazan enteras", async () => {
    await expect(
      inRosa((tx) =>
        tx.update(saleOrder).set({ totalCents: 100 }).where(eq(saleOrder.id, orderId)),
      ),
    ).rejects.toThrow()
    // Con todo lo que suma, sí (ADR 0224): el envío pasa de S/ 10 a S/ 12.
    const changed = await inRosa((tx) =>
      tx
        .update(saleOrder)
        .set({ deliveryListCents: 1200, deliveryCents: 1200, totalCents: 14100 })
        .where(eq(saleOrder.id, orderId))
        .returning({ total: saleOrder.totalCents }),
    )
    expect(changed).toEqual([{ total: 14100 }])
    await inRosa((tx) =>
      tx
        .update(saleOrder)
        .set({ deliveryListCents: 1000, deliveryCents: 1000, totalCents: 13900 })
        .where(eq(saleOrder.id, orderId)),
    )
    await expect(
      inRosa((tx) =>
        tx.update(saleOrderLine).set({ unitCents: 1 }).where(eq(saleOrderLine.orderId, orderId)),
      ),
    ).rejects.toThrow()
    // Otra tienda no quita sus líneas.
    expect(
      await inMario((tx) =>
        tx
          .delete(saleOrderLine)
          .where(eq(saleOrderLine.orderId, orderId))
          .returning({ id: saleOrderLine.id }),
      ),
    ).toEqual([])
    // Ni el medio de pago ni el cliente se cambian.
    await expect(
      inRosa((tx) =>
        tx.update(saleOrder).set({ paymentName: "Plin" }).where(eq(saleOrder.id, orderId)),
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
          methodName: "Link de pago",
          methodType: "68",
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
    // Confirmado, no pasa a «no coincide» ni se vuelve a confirmar a nombre de otro.
    await expect(
      inRosa((tx) =>
        tx
          .update(orderPayment)
          .set({ status: "no_coincide", note: "otra vez", reviewedBy: rosa.userId })
          .where(eq(orderPayment.orderId, orderId)),
      ),
    ).rejects.toThrow()
    await expect(
      inRosa((tx) =>
        tx
          .update(orderPayment)
          .set({ reviewedBy: rosa.userId, reviewedAt: new Date() })
          .where(eq(orderPayment.orderId, orderId)),
      ),
    ).rejects.toThrow()
    // Deshacer la confirmación de una captura: vuelve a esperar, a nombre de nadie.
    await expect(
      inRosa((tx) =>
        tx
          .update(orderPayment)
          .set({ status: "por_confirmar", reviewedAt: null })
          .where(eq(orderPayment.orderId, orderId)),
      ),
    ).rejects.toThrow()
    const undone = await inRosa((tx) =>
      tx
        .update(orderPayment)
        .set({ status: "por_confirmar", reviewedBy: null, reviewedAt: null })
        .where(eq(orderPayment.orderId, orderId))
        .returning({ id: orderPayment.id }),
    )
    expect(undone).toHaveLength(1)
    // Desde otra tienda, no.
    expect(
      await inMario((tx) =>
        tx
          .update(orderPayment)
          .set({ status: "confirmado", reviewedBy: mario.userId, reviewedAt: new Date() })
          .where(eq(orderPayment.orderId, orderId))
          .returning({ id: orderPayment.id }),
      ),
    ).toEqual([])
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

  it("el saldo sale de la base: falta cobrar = total − confirmado − por confirmar", async () => {
    // Diana: S/ 117, paga S/ 80 por Yape (confirmado) y manda otra captura de S/ 20.
    const [diana] = await inRosa((tx) =>
      tx
        .insert(saleOrder)
        .values({ ...anOrder(calzados, 2, rosa.userId), totalCents: 11700, subtotalCents: 10700 })
        .returning({ id: saleOrder.id }),
    )
    const pay = (amountCents: number) => ({
      storeId: calzados,
      orderId: diana!.id,
      kind: "comprobante" as const,
      status: "por_confirmar" as const,
      amountCents,
      methodName: "Yape",
      methodType: "68" as const,
      createdBy: rosa.userId,
    })
    const balance = () =>
      inRosa(async (tx) => {
        const [row] = await tx
          .select()
          .from(orderBalance)
          .where(eq(orderBalance.orderId, diana!.id))
        return row
      })
    expect(await balance()).toMatchObject({ dueCents: 11700, paid: false })
    const [first] = await inRosa((tx) =>
      tx.insert(orderPayment).values(pay(8000)).returning({ id: orderPayment.id }),
    )
    await inRosa((tx) =>
      tx
        .update(orderPayment)
        .set({ status: "confirmado", reviewedBy: rosa.userId, reviewedAt: new Date() })
        .where(eq(orderPayment.id, first!.id)),
    )
    await inRosa((tx) => tx.insert(orderPayment).values(pay(2000)))
    expect(await balance()).toMatchObject({
      confirmedCents: 8000,
      pendingCents: 2000,
      dueCents: 1700,
      overCents: 0,
      paid: false,
    })
    // Otra tienda no ve el saldo de esta: la vista corre con las reglas de quien la lee.
    expect(await inMario((tx) => tx.select().from(orderBalance))).toEqual([])
    // Un pago que no coincide no cuenta.
    await inRosa((tx) =>
      tx
        .update(orderPayment)
        .set({
          status: "no_coincide",
          note: "No llegó",
          reviewedBy: rosa.userId,
          reviewedAt: new Date(),
        })
        .where(eq(orderPayment.status, "por_confirmar")),
    )
    expect(await balance()).toMatchObject({ pendingCents: 0, dueCents: 3700, paid: false })
  })

  it("cada pago guarda su medio con un tipo de UN/CEFACT 4461", async () => {
    await expect(
      inRosa((tx) =>
        tx.insert(orderPayment).values({
          storeId: calzados,
          orderId,
          kind: "comprobante",
          status: "por_confirmar",
          amountCents: 100,
          methodName: "Yape",
          // Un tipo que no es de la lista no entra, aunque el código se equivoque.
          methodType: "99" as "68",
          createdBy: rosa.userId,
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

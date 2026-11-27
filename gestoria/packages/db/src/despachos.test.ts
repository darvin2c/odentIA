/**
 * Las reglas de Despachos y Caja en la base (`0025_reglas_despachos_y_caja.sql`), con el rol de la
 * aplicación y una base real: Sofi no asigna repartidor, franja ni agencia, ni al anotar el pedido
 * ni al cambiarlo; lo cobrado en la puerta va a nombre de quien llevaba el pedido; «Recibí» solo
 * se agrega, toma cada pago una vez y solo el efectivo del mismo repartidor; y cada tienda ve solo
 * lo suyo.
 */
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  accountCopy,
  cashHandover,
  cashHandoverPayment,
  type Db,
  enterStore,
  orderPayment,
  saleOrder,
  store,
  storeCourier,
  storeMember,
  withPerson,
} from "./index.js"
import { startTestDb, type TestDb } from "./testing.js"

let db: TestDb
const rosa = { userId: "u-rosa", email: "rosa@calzados.test" }
const calzados = randomUUID()
const otra = randomUUID()
const ids = { kevin: "", luis: "", order: "", sofiOrder: "", cash: "", pos: "", luisCash: "" }

const inRosa = <T>(fn: (tx: Db) => Promise<T>, storeId = calzados) =>
  withPerson(db.appDb, { ...rosa, storeId }, fn)
const asSofi = <T>(fn: (tx: Db) => Promise<T>) =>
  withPerson(db.appDb, { userId: "agente:sofi", email: "", storeId: calzados }, fn)

const anOrder = (
  number: number,
  createdBy: string,
  over: {
    state: "por_pagar" | "en_camino"
    paymentCollection?: "comprobante" | "al_recibir"
    courierId?: string
  },
) => ({
  storeId: calzados,
  number,
  channel: "whatsapp" as const,
  customerName: "Jorge",
  deliveryName: "Reparto",
  deliveryType: "DeliveryModeOwnFleet" as const,
  deliveryListCents: 1000,
  deliveryCents: 1000,
  paymentName: "Efectivo",
  paymentCollection: "al_recibir" as const,
  itemsAutoCents: 19400,
  subtotalCents: 19400,
  totalCents: 20400,
  createdBy,
  ...over,
})

const cashAtDoor = (
  orderId: string,
  courierId: string | null,
  over: Record<string, unknown> = {},
) => ({
  storeId: calzados,
  orderId,
  kind: "al_recibir" as const,
  status: "confirmado" as const,
  amountCents: 10200,
  methodName: "Efectivo",
  methodType: "10" as const,
  courierId,
  createdBy: rosa.userId,
  reviewedBy: rosa.userId,
  reviewedAt: new Date(),
  ...over,
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
    const couriers = await tx
      .insert(storeCourier)
      .values([
        { storeId: calzados, name: "Kevin", createdBy: rosa.userId },
        { storeId: calzados, name: "Luis", createdBy: rosa.userId },
      ])
      .returning({ id: storeCourier.id, name: storeCourier.name })
    ids.kevin = couriers.find((c) => c.name === "Kevin")!.id
    ids.luis = couriers.find((c) => c.name === "Luis")!.id
    const [order] = await tx
      .insert(saleOrder)
      .values(anOrder(1, rosa.userId, { state: "en_camino", courierId: ids.kevin }))
      .returning({ id: saleOrder.id })
    ids.order = order!.id
  })
  const [mine] = await asSofi((tx) =>
    tx
      .insert(saleOrder)
      .values(anOrder(2, "agente:sofi", { state: "por_pagar", paymentCollection: "comprobante" }))
      .returning({ id: saleOrder.id }),
  )
  ids.sofiOrder = mine!.id
})

afterAll(async () => {
  await db?.stop()
})

describe("el repartidor, la franja y la agencia", () => {
  it("Sofi no los pone al anotar un pedido ni al cambiar el suyo, pero lo sigue anulando", async () => {
    await expect(
      asSofi((tx) =>
        tx.insert(saleOrder).values(
          anOrder(3, "agente:sofi", {
            state: "por_pagar",
            paymentCollection: "comprobante",
            courierId: ids.kevin,
          }),
        ),
      ),
    ).rejects.toThrow()
    for (const set of [
      { courierId: ids.kevin },
      { agency: "Shalom" },
      { slotStart: 540, slotEnd: 780 },
    ])
      await expect(
        asSofi((tx) => tx.update(saleOrder).set(set).where(eq(saleOrder.id, ids.sofiOrder))),
      ).rejects.toThrow()
    const cancelled = await asSofi((tx) =>
      tx
        .update(saleOrder)
        .set({ state: "anulado", cancelReason: "No pagó" })
        .where(eq(saleOrder.id, ids.sofiOrder))
        .returning({ id: saleOrder.id }),
    )
    expect(cancelled).toHaveLength(1)
  })

  it("Sofi no abre repartidores; una persona del equipo es repartidor solo de su tienda", async () => {
    await expect(
      asSofi((tx) =>
        tx
          .insert(storeCourier)
          .values({ storeId: calzados, name: "Pepe", createdBy: "agente:sofi" }),
      ),
    ).rejects.toThrow()
    await db.ownerDb
      .insert(accountCopy)
      .values({ userId: "u-ajena", name: "Ajena", email: "ajena@otra.test" })
    await expect(
      inRosa((tx) =>
        tx
          .insert(storeCourier)
          .values({ storeId: calzados, name: "Ajena", userId: "u-ajena", createdBy: rosa.userId }),
      ),
    ).rejects.toThrow()
  })

  it("un repartidor no se borra ni cambia de cuenta", async () => {
    await expect(
      inRosa((tx) => tx.delete(storeCourier).where(eq(storeCourier.id, ids.luis))),
    ).rejects.toThrow()
    await expect(
      inRosa((tx) =>
        tx.update(storeCourier).set({ userId: rosa.userId }).where(eq(storeCourier.id, ids.luis)),
      ),
    ).rejects.toThrow()
  })

  it("cada tienda ve solo sus repartidores", async () => {
    const seen = await inRosa((tx) => tx.select().from(storeCourier), otra)
    expect(seen).toEqual([])
  })
})

describe("lo cobrado en la puerta y «Recibí»", () => {
  it("queda a nombre de quien llevaba el pedido, nunca de otro", async () => {
    await expect(
      inRosa((tx) => tx.insert(orderPayment).values(cashAtDoor(ids.order, ids.luis))),
    ).rejects.toThrow()
    const [cash] = await inRosa((tx) =>
      tx
        .insert(orderPayment)
        .values(cashAtDoor(ids.order, ids.kevin))
        .returning({ id: orderPayment.id }),
    )
    ids.cash = cash!.id
    const [pos] = await inRosa((tx) =>
      tx
        .insert(orderPayment)
        .values(cashAtDoor(ids.order, ids.kevin, { methodName: "POS", methodType: "48" }))
        .returning({ id: orderPayment.id }),
    )
    ids.pos = pos!.id
  })

  it("«Recibí» toma solo el efectivo del mismo repartidor, una vez, y no se corrige", async () => {
    const handover = async (courierId: string | null) =>
      (
        await inRosa((tx) =>
          tx
            .insert(cashHandover)
            .values({
              storeId: calzados,
              courierId,
              expectedCents: 10200,
              receivedCents: 10200,
              receivedBy: rosa.userId,
            })
            .returning({ id: cashHandover.id }),
        )
      )[0]!.id
    const fromLuis = await handover(ids.luis)
    const fromKevin = await handover(ids.kevin)
    const take = (handoverId: string, paymentId: string) =>
      inRosa((tx) =>
        tx.insert(cashHandoverPayment).values({ storeId: calzados, handoverId, paymentId }),
      )
    // El efectivo de Kevin no entra en lo que trajo Luis, ni lo del POS en ninguno.
    await expect(take(fromLuis, ids.cash)).rejects.toThrow()
    await expect(take(fromKevin, ids.pos)).rejects.toThrow()
    await take(fromKevin, ids.cash)
    await expect(take(fromKevin, ids.cash)).rejects.toThrow()
    await expect(
      inRosa((tx) =>
        tx.update(cashHandover).set({ receivedCents: 0 }).where(eq(cashHandover.id, fromKevin)),
      ),
    ).rejects.toThrow()
    await expect(
      inRosa((tx) =>
        tx.delete(cashHandoverPayment).where(eq(cashHandoverPayment.paymentId, ids.cash)),
      ),
    ).rejects.toThrow()
  })

  it("si no cuadra, la diferencia va con su motivo; Sofi nunca recibe efectivo", async () => {
    const short = {
      storeId: calzados,
      courierId: ids.kevin,
      expectedCents: 10200,
      receivedCents: 9200,
      receivedBy: rosa.userId,
    }
    await expect(inRosa((tx) => tx.insert(cashHandover).values(short))).rejects.toThrow()
    await inRosa((tx) => tx.insert(cashHandover).values({ ...short, note: "Faltó el vuelto" }))
    await expect(
      asSofi((tx) =>
        tx.insert(cashHandover).values({ ...short, note: "No cuadró", receivedBy: "agente:sofi" }),
      ),
    ).rejects.toThrow()
  })
})

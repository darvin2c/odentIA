/**
 * Las reglas de las clientas (entrega 4, tablero 8; ADR 0221), con el rol de la aplicación y una
 * base real: cada tienda ve solo sus fichas; una ficha queda dentro de otra solo si esa otra está
 * sola; la historia solo se agrega, a nombre de quien pide; Sofi abre fichas pero no decide quién
 * es quién; y un pedido no cambia de ficha. También, que ninguna tabla quede abierta.
 */
import { randomUUID } from "node:crypto"
import { eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  accountCopy,
  customer,
  customerEvent,
  type Db,
  enterStore,
  saleOrder,
  store,
  storeMember,
  withPerson,
} from "./index.js"
import { startTestDb, type TestDb } from "./testing.js"

let db: TestDb
const rosa = { userId: "u-rosa", email: "rosa@calzados.test" }
const mario = { userId: "u-mario", email: "mario@otra.test" }
const calzados = randomUUID()
const otra = randomUUID()

const inRosa = <T>(fn: (tx: Db) => Promise<T>) =>
  withPerson(db.appDb, { ...rosa, storeId: calzados }, fn)
const inMario = <T>(fn: (tx: Db) => Promise<T>) =>
  withPerson(db.appDb, { ...mario, storeId: otra }, fn)
const asSofi = <T>(fn: (tx: Db) => Promise<T>) =>
  withPerson(db.appDb, { userId: "agente:sofi", email: "", storeId: calzados }, fn)

async function newCustomer(name: string, phone: string | null = null) {
  const [row] = await inRosa((tx) =>
    tx
      .insert(customer)
      .values({ storeId: calzados, name, phone, createdBy: rosa.userId })
      .returning(),
  )
  return row!
}

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
})

afterAll(async () => {
  await db?.stop()
})

describe("las fichas de cada tienda", () => {
  it("toda tabla nace cerrada: ninguna queda sin reglas de tienda", async () => {
    const open = await db.ownerDb.execute<{ relname: string }>(sql`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
        and c.relname <> '__drizzle_migrations'`)
    expect([...open].map((r) => r.relname)).toEqual([])
  })

  it("el teléfono guarda sus dígitos solo; otra tienda no ve ni toca la ficha", async () => {
    const mariela = await newCustomer("Mariela Ríos", "+51 987 654 321")
    expect(mariela.phoneDigits).toBe("51987654321")
    expect(await inMario((tx) => tx.select().from(customer))).toEqual([])
    const changed = await inMario((tx) =>
      tx.update(customer).set({ name: "Otra" }).where(eq(customer.id, mariela.id)).returning(),
    )
    expect(changed).toEqual([])
    // Nadie abre una ficha a nombre de otro, ni en otra tienda.
    await expect(
      inRosa((tx) =>
        tx.insert(customer).values({ storeId: calzados, name: "X", createdBy: mario.userId }),
      ),
    ).rejects.toThrow()
    await expect(
      inRosa((tx) =>
        tx.insert(customer).values({ storeId: otra, name: "X", createdBy: rosa.userId }),
      ),
    ).rejects.toThrow()
  })

  it("una ficha queda dentro de otra solo si esa otra está sola", async () => {
    const a = await newCustomer("Ana")
    const b = await newCustomer("Ana B")
    const c = await newCustomer("Ana C")
    await inRosa((tx) => tx.update(customer).set({ mergedInto: a.id }).where(eq(customer.id, b.id)))
    // Dentro de «b», que ya está dentro de «a»: no.
    await expect(
      inRosa((tx) => tx.update(customer).set({ mergedInto: b.id }).where(eq(customer.id, c.id))),
    ).rejects.toThrow()
    // «a» tiene a «b» dentro: no queda dentro de «c» mientras no se mueva «b».
    await expect(
      inRosa((tx) => tx.update(customer).set({ mergedInto: c.id }).where(eq(customer.id, a.id))),
    ).rejects.toThrow()
    // Moviendo antes lo de dentro, sí (así une la aplicación).
    await inRosa(async (tx) => {
      await tx.update(customer).set({ mergedInto: c.id }).where(eq(customer.mergedInto, a.id))
      await tx.update(customer).set({ mergedInto: c.id }).where(eq(customer.id, a.id))
    })
    // Ni dentro de sí misma, ni de una ficha de otra tienda.
    await expect(
      inRosa((tx) => tx.update(customer).set({ mergedInto: c.id }).where(eq(customer.id, c.id))),
    ).rejects.toThrow()
    const ajena = await inMario(async (tx) =>
      tx
        .insert(customer)
        .values({ storeId: otra, name: "Ajena", createdBy: mario.userId })
        .returning(),
    )
    await expect(
      db.ownerDb.update(customer).set({ mergedInto: ajena[0]!.id }).where(eq(customer.id, c.id)),
    ).rejects.toThrow()
  })

  it("la historia solo se agrega, a nombre de quien pide y con la hora de la base", async () => {
    const a = await newCustomer("Valeria")
    const b = await newCustomer("Valeria S.")
    await inRosa((tx) =>
      tx.insert(customerEvent).values({
        storeId: calzados,
        customerId: a.id,
        otherId: b.id,
        action: "distintas",
        actorUserId: rosa.userId,
      }),
    )
    await expect(
      inRosa((tx) =>
        tx.insert(customerEvent).values({
          storeId: calzados,
          customerId: a.id,
          otherId: b.id,
          action: "unida",
          actorUserId: mario.userId,
        }),
      ),
    ).rejects.toThrow()
    await expect(
      inRosa((tx) =>
        tx.insert(customerEvent).values({
          storeId: calzados,
          customerId: a.id,
          otherId: b.id,
          action: "unida",
          actorUserId: rosa.userId,
          createdAt: new Date(Date.now() - 86_400_000),
        }),
      ),
    ).rejects.toThrow()
    await expect(
      inRosa((tx) => tx.delete(customerEvent).where(eq(customerEvent.customerId, a.id))),
    ).rejects.toThrow()
  })

  it("Sofi abre la ficha de una clienta nueva, pero no la cambia ni decide quién es quién", async () => {
    const [nueva] = await asSofi((tx) =>
      tx
        .insert(customer)
        .values({ storeId: calzados, name: "Jorge Salinas", createdBy: "agente:sofi" })
        .returning(),
    )
    expect(nueva?.createdBy).toBe("agente:sofi")
    await expect(
      asSofi((tx) =>
        tx.insert(customer).values({
          storeId: calzados,
          name: "Con nota",
          note: "Lo que sabemos",
          noteBy: "agente:sofi",
          noteAt: new Date(),
          createdBy: "agente:sofi",
        }),
      ),
    ).rejects.toThrow()
    const other = await newCustomer("Jorge S.")
    const changed = await asSofi((tx) =>
      tx
        .update(customer)
        .set({ mergedInto: nueva!.id })
        .where(eq(customer.id, other.id))
        .returning(),
    )
    expect(changed).toEqual([])
    await expect(
      asSofi((tx) =>
        tx.insert(customerEvent).values({
          storeId: calzados,
          customerId: nueva!.id,
          otherId: other.id,
          action: "unida",
          actorUserId: "agente:sofi",
        }),
      ),
    ).rejects.toThrow()
  })

  it("un pedido no cambia de ficha ni toma la de otra tienda", async () => {
    const carla = await newCustomer("Carla")
    const otraCarla = await newCustomer("Carla M.")
    const order = {
      storeId: calzados,
      number: 1,
      state: "por_pagar" as const,
      channel: "otro" as const,
      customerId: carla.id,
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
      createdBy: rosa.userId,
    }
    const [row] = await inRosa((tx) =>
      tx.insert(saleOrder).values(order).returning({ id: saleOrder.id }),
    )
    await expect(
      inRosa((tx) =>
        tx.update(saleOrder).set({ customerId: otraCarla.id }).where(eq(saleOrder.id, row!.id)),
      ),
    ).rejects.toThrow()
    const ajena = await inMario((tx) =>
      tx
        .insert(customer)
        .values({ storeId: otra, name: "Ajena", createdBy: mario.userId })
        .returning(),
    )
    await expect(
      inRosa((tx) =>
        tx.insert(saleOrder).values({ ...order, number: 2, customerId: ajena[0]!.id }),
      ),
    ).rejects.toThrow()
  })
})

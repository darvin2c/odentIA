/**
 * Las reglas del catálogo (paso B3), con el rol de la aplicación y una base real: cada tienda
 * ve y cambia solo lo suyo, y el stock de una variante solo cambia con un movimiento del
 * kardex, que la base pone al día con su saldo.
 */
import { randomUUID } from "node:crypto"
import { eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  accountCopy,
  type Db,
  enterStore,
  product,
  productVariant,
  stockMovement,
  store,
  storeMember,
  storePaymentMethod,
  withPerson,
} from "./index.js"
import { startTestDb, type TestDb } from "./testing.js"

let db: TestDb
const rosa = { userId: "u-rosa", email: "rosa@calzados.test" }
const mario = { userId: "u-mario", email: "mario@otra.test" }
const calzados = randomUUID()
const otra = randomUUID()
let variant = ""

const inRosa = <T>(fn: (tx: Db) => Promise<T>) =>
  withPerson(db.appDb, { ...rosa, storeId: calzados }, fn)

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
  await inRosa(async (tx) => {
    const [created] = await tx
      .insert(product)
      .values({ storeId: calzados, name: "Zapatilla", listPriceCents: 12900 })
      .returning({ id: product.id })
    const [row] = await tx
      .insert(productVariant)
      .values({
        storeId: calzados,
        productId: created!.id,
        optionValues: ["38"],
        sku: "ZAP-38",
      })
      .returning({ id: productVariant.id })
    variant = row!.id
  })
})

afterAll(async () => {
  await db?.stop()
})

const move = (values: Partial<typeof stockMovement.$inferInsert>) =>
  inRosa((tx) =>
    tx
      .insert(stockMovement)
      .values({
        storeId: calzados,
        variantId: variant,
        kind: "entrada",
        quantity: 1,
        actorUserId: rosa.userId,
        ...values,
      })
      .returning({ balance: stockMovement.balance }),
  )

const stockNow = async () =>
  (
    await inRosa((tx) =>
      tx
        .select({ stock: productVariant.stock })
        .from(productVariant)
        .where(eq(productVariant.id, variant)),
    )
  )[0]?.stock

describe("el kardex", () => {
  it("cada movimiento pone al día el stock y anota el saldo", async () => {
    expect(await move({ kind: "entrada", quantity: 4, unitCostCents: 6800 })).toEqual([
      { balance: 4 },
    ])
    expect(await move({ kind: "venta", quantity: -1, reference: "0142" })).toEqual([
      { balance: 3 },
    ])
    expect(await move({ kind: "ajuste", quantity: -1, reason: "par dañado" })).toEqual([
      { balance: 2 },
    ])
    expect(await stockNow()).toBe(2)
  })

  it("no deja el saldo bajo cero ni un ajuste sin motivo", async () => {
    await expect(move({ kind: "ajuste", quantity: -5, reason: "conteo" })).rejects.toThrow()
    await expect(move({ kind: "ajuste", quantity: 1 })).rejects.toThrow()
    await expect(move({ kind: "ajuste", quantity: 1, reason: "  " })).rejects.toThrow()
    expect(await stockNow()).toBe(2)
  })

  it("el stock no se escribe a mano, ni al crear la variante", async () => {
    await expect(
      inRosa((tx) =>
        tx.update(productVariant).set({ stock: 50 }).where(eq(productVariant.id, variant)),
      ),
    ).rejects.toThrow()
    await expect(
      inRosa(async (tx) => {
        const [p] = await tx.select({ id: product.id }).from(product)
        await tx
          .insert(productVariant)
          .values({ storeId: calzados, productId: p!.id, optionValues: ["39"], sku: "Z-39", stock: 9 })
      }),
    ).rejects.toThrow()
  })

  it("el kardex no se cambia, no se borra, no se firma por otro ni se fecha antes", async () => {
    await expect(
      inRosa((tx) => tx.update(stockMovement).set({ quantity: 10 }).where(sql`true`)),
    ).rejects.toThrow()
    await expect(inRosa((tx) => tx.delete(stockMovement).where(sql`true`))).rejects.toThrow()
    await expect(move({ actorUserId: mario.userId })).rejects.toThrow()
    await expect(move({ createdAt: new Date("2020-01-01") })).rejects.toThrow()
  })

  it("una venta descuenta una sola vez por pedido", async () => {
    await expect(move({ kind: "venta", quantity: -1, reference: "0142" })).rejects.toThrow()
  })
})

describe("cada tienda, lo suyo", () => {
  it("otra tienda no ve ni mueve el catálogo ajeno", async () => {
    const seen = await withPerson(db.appDb, { ...mario, storeId: otra }, async (tx) => ({
      products: await tx.select().from(product),
      variants: await tx.select().from(productVariant),
      moves: await tx.select().from(stockMovement),
    }))
    expect(seen).toEqual({ products: [], variants: [], moves: [] })
    await expect(
      withPerson(db.appDb, { ...mario, storeId: otra }, (tx) =>
        tx.insert(stockMovement).values({
          storeId: otra,
          variantId: variant,
          kind: "entrada",
          quantity: 5,
          actorUserId: mario.userId,
        }),
      ),
    ).rejects.toThrow()
    await expect(
      withPerson(db.appDb, { ...mario, storeId: otra }, (tx) =>
        tx.insert(storePaymentMethod).values({
          storeId: calzados,
          name: "Yape",
          typeCode: "68",
          collection: "comprobante",
        }),
      ),
    ).rejects.toThrow()
    expect(await stockNow()).toBe(2)
  })

  it("el efectivo solo se cobra al recibir", async () => {
    await expect(
      inRosa((tx) =>
        tx.insert(storePaymentMethod).values({
          storeId: calzados,
          name: "Efectivo",
          typeCode: "10",
          collection: "comprobante",
        }),
      ),
    ).rejects.toThrow()
  })
})

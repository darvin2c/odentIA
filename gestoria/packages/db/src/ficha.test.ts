/**
 * Las reglas de la ficha del producto en la base, con el rol de la aplicación y una base real: cada
 * tienda ve y cambia solo lo suyo; Sofi solo anota lo que no supo (sin responderlo ni guardarlo en
 * la ficha) y no toca colores, plantillas ni el historial; el historial va a nombre de quien pide.
 */
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  accountCopy,
  conversation,
  type Db,
  enterStore,
  product,
  productColor,
  productEvent,
  productQuestion,
  productVariant,
  store,
  storeMember,
  storeTemplateField,
  withPerson,
} from "./index.js"
import { startTestDb, type TestDb } from "./testing.js"

let db: TestDb
const rosa = { userId: "u-rosa", email: "rosa@calzados.test" }
const mario = { userId: "u-mario", email: "mario@otra.test" }
const calzados = randomUUID()
const otra = randomUUID()
let productId = ""
let conversationId = ""

const inRosa = <T>(fn: (tx: Db) => Promise<T>) =>
  withPerson(db.appDb, { ...rosa, storeId: calzados }, fn)
const inMario = <T>(fn: (tx: Db) => Promise<T>) =>
  withPerson(db.appDb, { ...mario, storeId: otra }, fn)
const asSofi = <T>(fn: (tx: Db) => Promise<T>) =>
  withPerson(db.appDb, { userId: "agente:sofi", email: "", storeId: calzados }, fn)

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
    const [p] = await tx
      .insert(product)
      .values({
        storeId: calzados,
        name: "Zapatilla",
        listPriceCents: 12900,
        options: [{ name: "Color", values: ["blanca"] }],
        colorOption: 0,
      })
      .returning({ id: product.id })
    productId = p!.id
    const [c] = await tx
      .insert(conversation)
      .values({ storeId: calzados, channel: "prueba", createdBy: rosa.userId })
      .returning({ id: conversation.id })
    conversationId = c!.id
  })
})

afterAll(async () => {
  await db?.stop()
})

describe("la ficha del producto en la base", () => {
  it("los datos nuevos del producto se guardan con su forma, y lo que no la tiene no entra", async () => {
    await inRosa((tx) =>
      tx
        .update(product)
        .set({
          rubro: "calzado",
          rubroData: { horma: "Normal", nso: { noAplica: true } },
          code: "ZAP-LONA",
          status: "encargo",
          statusDays: 5,
          packageWeightG: 900,
          packageLengthMm: 320,
          packageWidthMm: 200,
          packageHeightMm: 120,
          keywords: ["zapa", "tenis"],
          webSlug: "zapatilla-de-lona",
        })
        .where(eq(product.id, productId)),
    )
    // Por encargo sin días, un rubro que no existe, medidas a medias o un link con espacios: no.
    for (const bad of [
      { status: "encargo" as const, statusDays: null },
      { status: null, statusDays: 3 },
      { rubro: "zapatos" as never },
      { packageLengthMm: 100, packageWidthMm: null },
      { webSlug: "con espacios" },
      { code: "con espacio" },
    ])
      await expect(
        inRosa((tx) => tx.update(product).set(bad).where(eq(product.id, productId))),
      ).rejects.toThrow()
  })

  it("el código de barras tiene la forma de un GTIN y no se repite en la tienda", async () => {
    const variant = (sku: string, barcode: string) =>
      inRosa((tx) =>
        tx
          .insert(productVariant)
          .values({ storeId: calzados, productId, optionValues: [sku], sku, barcode })
          .returning({ id: productVariant.id }),
      )
    await variant("BL-1", "7751234567892")
    await expect(variant("BL-2", "7751234567892")).rejects.toThrow()
    await expect(variant("BL-3", "77512345")).resolves.toBeDefined()
    await expect(variant("BL-4", "12345")).rejects.toThrow()
  })

  it("un color guarda su hex como #rrggbb y el segundo solo si hay primero", async () => {
    await inRosa((tx) =>
      tx.insert(productColor).values({ storeId: calzados, productId, value: "blanca", hex: "#f2f0ea" }),
    )
    for (const bad of [
      { value: "negra", hex: "#FFF" },
      { value: "roja", hex: null, hex2: "#ffffff" },
      { value: "Blanca", hex: "#ffffff" },
    ])
      await expect(
        inRosa((tx) => tx.insert(productColor).values({ storeId: calzados, productId, ...bad })),
      ).rejects.toThrow()
  })

  it("cada tienda ve solo lo suyo", async () => {
    await inRosa(async (tx) => {
      await tx.insert(storeTemplateField).values({
        storeId: calzados,
        rubro: "calzado",
        key: "horma",
        position: 0,
        needed: true,
        updatedBy: rosa.userId,
      })
      await tx
        .insert(productEvent)
        .values({ storeId: calzados, productId, actorUserId: rosa.userId, action: "cambiado" })
    })
    await inMario(async (tx) => {
      expect(await tx.select().from(productColor)).toEqual([])
      expect(await tx.select().from(storeTemplateField)).toEqual([])
      expect(await tx.select().from(productEvent)).toEqual([])
      expect(await tx.select().from(productQuestion)).toEqual([])
    })
    // Ni escribe en la otra tienda.
    await expect(
      inMario((tx) =>
        tx.insert(productColor).values({ storeId: calzados, productId, value: "verde" }),
      ),
    ).rejects.toThrow()
  })

  it("el historial va a nombre de quien pide y no se cambia", async () => {
    await expect(
      inRosa((tx) =>
        tx
          .insert(productEvent)
          .values({ storeId: calzados, productId, actorUserId: "u-otra", action: "cambiado" }),
      ),
    ).rejects.toThrow()
    await expect(
      inRosa((tx) => tx.update(productEvent).set({ reason: "x" }).where(eq(productEvent.productId, productId))),
    ).rejects.toThrow()
  })

  it("una pregunta va a nombre de quien la anota; guardada, lleva su respuesta", async () => {
    await expect(
      inRosa((tx) =>
        tx.insert(productQuestion).values({
          storeId: calzados,
          productId,
          question: "¿Es impermeable?",
          askedBy: "u-otra",
        }),
      ),
    ).rejects.toThrow()
    await expect(
      inRosa((tx) =>
        tx.insert(productQuestion).values({
          storeId: calzados,
          productId,
          question: "¿Es impermeable?",
          askedBy: rosa.userId,
          savedAt: new Date(),
          savedBy: rosa.userId,
        }),
      ),
    ).rejects.toThrow()
  })
})

describe("Sofi y la ficha", () => {
  it("anota lo que no supo, con su conversación y sin respuesta", async () => {
    const [row] = await asSofi((tx) =>
      tx
        .insert(productQuestion)
        .values({
          storeId: calzados,
          productId,
          conversationId,
          question: "¿Destiñe al lavarla?",
          askedBy: "agente:sofi",
        })
        .returning({ id: productQuestion.id }),
    )
    expect(row?.id).toBeTruthy()
    // No responde por la tienda ni la guarda en la ficha, ni al anotarla ni después.
    const answered = {
      storeId: calzados,
      productId,
      conversationId,
      question: "¿Encoge?",
      askedBy: "agente:sofi",
      answer: "No encoge",
      answeredBy: "agente:sofi",
      answeredAt: new Date(),
    }
    await expect(asSofi((tx) => tx.insert(productQuestion).values(answered))).rejects.toThrow()
    await expect(
      asSofi((tx) =>
        tx.insert(productQuestion).values({
          storeId: calzados,
          productId,
          question: "¿Sin conversación?",
          askedBy: "agente:sofi",
        }),
      ),
    ).rejects.toThrow()
    const changed = await asSofi((tx) =>
      tx
        .update(productQuestion)
        .set({ answer: "Sí", answeredBy: "agente:sofi", answeredAt: new Date() })
        .where(eq(productQuestion.id, row!.id))
        .returning({ id: productQuestion.id }),
    )
    expect(changed).toEqual([])
    // Una persona sí la responde.
    const done = await inRosa((tx) =>
      tx
        .update(productQuestion)
        .set({ answer: "No destiñe", answeredBy: rosa.userId, answeredAt: new Date() })
        .where(eq(productQuestion.id, row!.id))
        .returning({ id: productQuestion.id }),
    )
    expect(done).toHaveLength(1)
  })

  it("no toca los colores, la plantilla ni el historial", async () => {
    await expect(
      asSofi((tx) =>
        tx.insert(productColor).values({ storeId: calzados, productId, value: "negra" }),
      ),
    ).rejects.toThrow()
    const recolored = await asSofi((tx) =>
      tx
        .update(productColor)
        .set({ hex: "#000000" })
        .where(eq(productColor.productId, productId))
        .returning({ id: productColor.id }),
    )
    expect(recolored).toEqual([])
    await expect(
      asSofi((tx) =>
        tx.insert(storeTemplateField).values({
          storeId: calzados,
          rubro: "calzado",
          key: "material",
          position: 1,
          needed: false,
          updatedBy: "agente:sofi",
        }),
      ),
    ).rejects.toThrow()
    await expect(
      asSofi((tx) =>
        tx
          .insert(productEvent)
          .values({ storeId: calzados, productId, actorUserId: "agente:sofi", action: "cambiado" }),
      ),
    ).rejects.toThrow()
    // Ni los datos nuevos del producto.
    const touched = await asSofi((tx) =>
      tx
        .update(product)
        .set({ status: "liquidacion", statusDays: null })
        .where(eq(product.id, productId))
        .returning({ id: product.id }),
    )
    expect(touched).toEqual([])
  })
})

/**
 * Las reglas de las fotos, los videos y «Cargar muchos» en la base (ADR 0236), con el rol de la
 * aplicación y una base real: la foto nueva no lleva su contenido en la base; cada tienda ve y
 * cambia solo lo suyo; otra persona del equipo cambia una foto que no subió; una carga cerrada
 * ya no cambia; Sofi no sube videos ni ve las cargas; y al borrar, la base anota qué borrar del
 * almacenamiento, también en cascada y sin anotar la carpeta que otra fila sigue usando.
 */
import { randomUUID } from "node:crypto"
import { eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  accountCopy,
  bulkLoad,
  bulkLoadItem,
  bulkLoadPhoto,
  type Db,
  enterStore,
  mediaTrash,
  product,
  productPhoto,
  productVideo,
  store,
  storeMember,
  withPerson,
} from "./index.js"
import { startTestDb, type TestDb } from "./testing.js"

let db: TestDb
const rosa = { userId: "u-rosa", email: "rosa@calzados.test" }
const lucia = { userId: "u-lucia", email: "lucia@calzados.test" }
const mario = { userId: "u-mario", email: "mario@otra.test" }
const calzados = randomUUID()
const otra = randomUUID()
let productId = ""
const proposal = randomUUID()

const inStoreAs = <T>(
  who: { userId: string; email: string },
  storeId: string,
  fn: (tx: Db) => Promise<T>,
) => withPerson(db.appDb, { ...who, storeId }, fn)
const inRosa = <T>(fn: (tx: Db) => Promise<T>) => inStoreAs(rosa, calzados, fn)
const asSofi = <T>(fn: (tx: Db) => Promise<T>) =>
  withPerson(db.appDb, { userId: "agente:sofi", email: "", storeId: calzados }, fn)
const folder = (name: string) => `tiendas/${calzados}/productos/${productId}/fotos/${name}`
const trash = async () =>
  (await db.ownerDb.select().from(mediaTrash)).map((t) => t.objectKey).sort()

beforeAll(async () => {
  db = await startTestDb()
  await db.ownerDb.insert(accountCopy).values([
    { userId: rosa.userId, name: "Rosa", email: rosa.email },
    { userId: lucia.userId, name: "Lucía", email: lucia.email },
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
  await db.ownerDb
    .insert(storeMember)
    .values({ storeId: calzados, userId: lucia.userId, role: "admin" })
  await inRosa(async (tx) => {
    const [p] = await tx
      .insert(product)
      .values({ storeId: calzados, name: "Zapatilla", listPriceCents: 12900 })
      .returning({ id: product.id })
    productId = p!.id
  })
})

afterAll(async () => {
  await db?.stop()
})

describe("las fotos y los videos en la base", () => {
  let photoId = ""
  it("la foto nueva va al almacenamiento: la aplicación no guarda su contenido en la base", async () => {
    await expect(
      inRosa((tx) =>
        tx.insert(productPhoto).values({
          storeId: calzados,
          productId,
          contentType: "image/png",
          content: Buffer.from([1]),
          createdBy: rosa.userId,
        }),
      ),
    ).rejects.toThrow()
    const [row] = await inRosa((tx) =>
      tx
        .insert(productPhoto)
        .values({
          storeId: calzados,
          productId,
          contentType: "image/jpeg",
          objectKey: folder("f1"),
          sizeBytes: 1000,
          width: 10,
          height: 10,
          createdBy: rosa.userId,
        })
        .returning({ id: productPhoto.id }),
    )
    photoId = row!.id
    // Una clave con caracteres raros no entra: es una carpeta, no una dirección.
    await expect(
      db.ownerDb
        .update(productPhoto)
        .set({ objectKey: "../otra/tienda" })
        .where(eq(productPhoto.id, photoId)),
    ).rejects.toThrow()
  })

  it("otra persona del equipo la cambia; otra tienda no la ve", async () => {
    const changed = await inStoreAs(lucia, calzados, (tx) =>
      tx
        .update(productPhoto)
        .set({ position: 3, cutout: "propuesta", cutoutId: proposal })
        .where(eq(productPhoto.id, photoId))
        .returning(),
    )
    expect(changed).toHaveLength(1)
    const seen = await inStoreAs(mario, otra, (tx) => tx.select().from(productPhoto))
    expect(seen).toEqual([])
  })

  it("«Dejar la original» anota la propuesta para borrarla; quitar la foto, su carpeta", async () => {
    await inRosa((tx) =>
      tx
        .update(productPhoto)
        .set({ cutout: null, cutoutId: null })
        .where(eq(productPhoto.id, photoId)),
    )
    expect(await trash()).toEqual([`${folder("f1")}/sin-fondo/${proposal}`])
    await inRosa((tx) => tx.delete(productPhoto).where(eq(productPhoto.id, photoId)))
    expect(await trash()).toEqual([folder("f1"), `${folder("f1")}/sin-fondo/${proposal}`].sort())
    // La aplicación no ve lo que queda por borrar.
    await expect(inRosa((tx) => tx.select().from(mediaTrash))).rejects.toThrow()
    await db.ownerDb.delete(mediaTrash)
  })

  it("Sofi no sube ni cambia videos; un video por producto y color", async () => {
    const video = {
      storeId: calzados,
      productId,
      objectKey: `tiendas/${calzados}/productos/${productId}/videos/v1`,
      sizeBytes: 1000,
      durationMs: 12_000,
      width: 480,
      height: 480,
    }
    await expect(
      asSofi((tx) => tx.insert(productVideo).values({ ...video, createdBy: "agente:sofi" })),
    ).rejects.toThrow()
    await inRosa((tx) => tx.insert(productVideo).values({ ...video, createdBy: rosa.userId }))
    await expect(
      inRosa((tx) =>
        tx
          .insert(productVideo)
          .values({ ...video, objectKey: `${video.objectKey}x`, createdBy: rosa.userId }),
      ),
    ).rejects.toThrow()
    // Más de 30 segundos o de 16 MB no entra.
    await expect(
      inRosa((tx) =>
        tx.insert(productVideo).values({
          ...video,
          objectKey: "tiendas/x/v2",
          durationMs: 31_000,
          createdBy: rosa.userId,
        }),
      ),
    ).rejects.toThrow()
    expect(await asSofi((tx) => tx.select().from(productVideo))).toHaveLength(1)
    // Borrar el producto anota la carpeta del video (en cascada).
    const [extra] = await inRosa((tx) =>
      tx
        .insert(product)
        .values({ storeId: calzados, name: "Sandalia", listPriceCents: 8900 })
        .returning({ id: product.id }),
    )
    const key = `tiendas/${calzados}/productos/${extra!.id}/videos/v9`
    await inRosa((tx) =>
      tx
        .insert(productVideo)
        .values({ ...video, productId: extra!.id, objectKey: key, createdBy: rosa.userId }),
    )
    await inRosa((tx) => tx.delete(product).where(eq(product.id, extra!.id)))
    expect(await trash()).toEqual([key])
    await db.ownerDb.delete(mediaTrash)
  })
})

describe("cargar muchos en la base", () => {
  it("una carga cerrada ya no cambia y Sofi no la ve", async () => {
    const [load] = await inRosa((tx) =>
      tx
        .insert(bulkLoad)
        .values({ storeId: calzados, createdBy: rosa.userId })
        .returning({ id: bulkLoad.id }),
    )
    const [item] = await inRosa((tx) =>
      tx
        .insert(bulkLoadItem)
        .values({ storeId: calzados, loadId: load!.id, name: "Mocasín" })
        .returning({ id: bulkLoadItem.id }),
    )
    const key = `tiendas/${calzados}/cargas/${load!.id}/fotos/c1`
    await inRosa((tx) =>
      tx.insert(bulkLoadPhoto).values({
        storeId: calzados,
        loadId: load!.id,
        itemId: item!.id,
        contentType: "image/jpeg",
        objectKey: key,
        sizeBytes: 10,
        width: 10,
        height: 10,
        createdBy: rosa.userId,
      }),
    )
    expect(await asSofi((tx) => tx.select().from(bulkLoad))).toEqual([])
    expect(await inStoreAs(mario, otra, (tx) => tx.select().from(bulkLoadPhoto))).toEqual([])
    // La foto pasa al producto con su carpeta: al quitarla de la carga no se anota.
    await inRosa((tx) =>
      tx.insert(productPhoto).values({
        storeId: calzados,
        productId,
        contentType: "image/jpeg",
        objectKey: key,
        createdBy: rosa.userId,
      }),
    )
    await inRosa((tx) => tx.delete(bulkLoadPhoto).where(eq(bulkLoadPhoto.loadId, load!.id)))
    expect(await trash()).toEqual([])
    // La hora la pone la base: con la del servidor no se cierra.
    await expect(
      inRosa((tx) =>
        tx
          .update(bulkLoad)
          .set({
            state: "creada",
            createdProducts: 1,
            finishedBy: rosa.userId,
            finishedAt: new Date(0),
          })
          .where(eq(bulkLoad.id, load!.id)),
      ),
    ).rejects.toThrow()
    await inRosa((tx) =>
      tx
        .update(bulkLoad)
        .set({
          state: "creada",
          createdProducts: 1,
          finishedBy: rosa.userId,
          finishedAt: sql`now()`,
        })
        .where(eq(bulkLoad.id, load!.id)),
    )
    // Cerrada: sus productos ya no cambian.
    await expect(
      inRosa((tx) =>
        tx.update(bulkLoadItem).set({ name: "Otro" }).where(eq(bulkLoadItem.id, item!.id)),
      ),
    ).rejects.toThrow()
    const [after] = await db.ownerDb
      .select()
      .from(bulkLoadItem)
      .where(eq(bulkLoadItem.id, item!.id))
    expect(after!.name).toBe("Mocasín")
  })
})

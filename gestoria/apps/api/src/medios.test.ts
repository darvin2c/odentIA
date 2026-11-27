/**
 * Las fotos, los videos y «Cargar muchos» (ADR 0236), contra una base real, un token firmado
 * como el de la cuenta y un almacenamiento en memoria (el de S3 se prueba en `archivos.test.ts`):
 * dónde queda cada archivo, quién sube y quién ve, lo que ve la vitrina pública, lo que manda
 * Sofi, la foto sin fondo, lo que se borra, las fotos de antes que se mudan y la carga entera
 * hasta «Crear».
 */

import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import {
  bulkLoadPhoto,
  mediaTrash,
  product,
  productColor,
  productPhoto,
  store,
  storeLink,
  storeMember,
} from "@gestoria/db"
import { startTestDb, type TestDb } from "@gestoria/db/testing"
import { eq } from "drizzle-orm"
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose"
import sharp from "sharp"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { SOFI_ACTOR, withAgent } from "./agente.js"
import { createApp } from "./app.js"
import { memoryStorage } from "./archivos.js"
import { emptyMediaTrash, moveStoredPhotos, sofiMediaIn } from "./medios.js"

const ACCOUNT = "https://api.gestoria.test"
const WEB = "https://app.gestoria.test"

let db: TestDb
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"]
let jwk: JWK
let app: ReturnType<typeof createApp>
let off: ReturnType<typeof createApp>
const storage = memoryStorage()

const people = {
  rosa: { id: "u-rosa", email: "rosa@calzados.test", name: "Rosa Quispe" },
  mario: { id: "u-mario", email: "mario@calzados.test", name: "Mario Huamán" },
  lucia: { id: "u-lucia", email: "lucia@calzados.test", name: "Lucía Torres" },
  ajena: { id: "u-ajena", email: "ajena@otra.test", name: "Ajena" },
}
type Who = keyof typeof people
const storeId = randomUUID()
const base = `/api/tiendas/${storeId}`

async function tokenFor(who: Who) {
  const p = people[who]
  const iat = Math.floor(Date.now() / 1000)
  return new SignJWT({ email: p.email, emailVerified: true, name: p.name, image: null })
    .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
    .setSubject(p.id)
    .setIssuer(ACCOUNT)
    .setAudience("gestoria")
    .setIssuedAt(iat)
    .setExpirationTime(iat + 900)
    .sign(privateKey)
}

async function call(
  who: Who | null,
  method: string,
  path: string,
  body?: unknown,
  raw?: { type?: string; data: Uint8Array | FormData },
  on = app,
) {
  const headers: Record<string, string> = { origin: WEB }
  if (who) headers.authorization = `Bearer ${await tokenFor(who)}`
  if (raw?.type) headers["content-type"] = raw.type
  else if (!raw) headers["content-type"] = "application/json"
  const response = await on.request(`https://servidor.gestoria.test${path}`, {
    method,
    headers,
    ...(raw ? { body: raw.data } : body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  // biome-ignore lint/suspicious/noExplicitAny: las pruebas leen respuestas JSON de forma libre
  let json: Record<string, any> = {}
  try {
    json = text ? JSON.parse(text) : {}
  } catch {}
  return { status: response.status, json, response }
}

const jpeg = async (r: number, g: number, b: number, size = 1200) =>
  sharp({ create: { width: size, height: size, channels: 3, background: { r, g, b } } })
    .jpeg()
    .withMetadata({ exif: { IFD0: { Make: "Celular de Rosa" } } })
    .toBuffer()
const transparent = () =>
  sharp({
    create: { width: 600, height: 600, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer()
const photo = (data: Buffer) => ({ type: "image/jpeg", data: new Uint8Array(data) })
const read = (path: string) => readFileSync(new URL(path, import.meta.url))

let zapatilla = ""
let negra = ""

beforeAll(async () => {
  db = await startTestDb()
  const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" })
  privateKey = pair.privateKey
  jwk = { ...(await exportJWK(pair.publicKey)), alg: "EdDSA", kid: "k1" }
  const deps = {
    appDb: db.appDb,
    ownerDb: db.ownerDb,
    account: { url: ACCOUNT, eventsSecret: "", keys: createLocalJWKSet({ keys: [jwk] }) },
    webURL: WEB,
  }
  app = createApp({ ...deps, storage })
  off = createApp(deps)
  for (const who of Object.keys(people) as Who[]) await call(who, "GET", "/api/yo")
  await db.ownerDb
    .insert(store)
    .values({ id: storeId, name: "Calzados Rosa", currency: "PEN", createdBy: "u-rosa" })
  await db.ownerDb.insert(storeMember).values([
    { storeId, userId: "u-rosa", role: "owner" },
    { storeId, userId: "u-mario", role: "admin", addedBy: "u-rosa" },
    { storeId, userId: "u-lucia", role: "sales", addedBy: "u-rosa" },
  ])
  await db.ownerDb.insert(storeLink).values({ name: "calzadosrosa", storeId, createdBy: "u-rosa" })
  const created = await call("rosa", "POST", `${base}/productos`, {
    name: "Zapatilla urbana",
    listPriceCents: 12900,
    options: [
      { name: "Color", values: ["blanca", "negra"] },
      { name: "Talla", values: ["38", "39"] },
    ],
  })
  zapatilla = created.json.product.id
  await db.ownerDb
    .update(product)
    .set({ colorOption: 0, webSlug: "zapatilla-urbana" })
    .where(eq(product.id, zapatilla))
  const [row] = await db.ownerDb
    .insert(productColor)
    .values([
      { storeId, productId: zapatilla, value: "blanca" },
      { storeId, productId: zapatilla, value: "negra" },
    ])
    .returning({ id: productColor.id })
    .then((rows) => rows.slice(1))
  negra = row!.id
})

afterAll(async () => {
  await db?.stop()
})

describe("las fotos en el almacenamiento", () => {
  let first = ""
  let second = ""
  it("se guardan fuera de la base, con la original y sus copias sin los datos de la cámara", async () => {
    const up = await call(
      "mario",
      "POST",
      `${base}/productos/${zapatilla}/fotos`,
      undefined,
      photo(await jpeg(240, 240, 240)),
    )
    expect(up.status).toBe(201)
    first = up.json.photo.id
    const [row] = await db.ownerDb.select().from(productPhoto).where(eq(productPhoto.id, first))
    expect(row).toMatchObject({
      content: null,
      width: 1200,
      height: 1200,
      contentType: "image/jpeg",
    })
    expect(row!.objectKey).toBe(`tiendas/${storeId}/productos/${zapatilla}/fotos/${first}`)
    for (const copy of ["original", "miniatura", "vitrina", "whatsapp"])
      expect(storage.files.has(`${row!.objectKey}/${copy}`)).toBe(true)
    const whatsapp = storage.files.get(`${row!.objectKey}/whatsapp`)!
    expect(whatsapp.type).toBe("image/jpeg")
    const meta = await sharp(whatsapp.bytes).metadata()
    expect(meta.width).toBe(1200)
    expect(meta.exif).toBeUndefined()
    expect(
      (await sharp(storage.files.get(`${row!.objectKey}/miniatura`)!.bytes).metadata()).width,
    ).toBe(400)
    // Ya del color negro, al subirla.
    const two = await call(
      "rosa",
      "POST",
      `${base}/productos/${zapatilla}/fotos?color=${negra}`,
      undefined,
      photo(await jpeg(30, 30, 30)),
    )
    expect(two.status).toBe(201)
    second = two.json.photo.id
  })

  it("Ventas las ve con enlaces que vencen; no las sube; otra tienda no las ve", async () => {
    const seen = await call("lucia", "GET", `${base}/productos/${zapatilla}/medios`)
    expect(seen.status).toBe(200)
    expect(seen.json.photos.map((p: { id: string }) => p.id)).toEqual([first, second])
    expect(seen.json.photos[1]).toMatchObject({ colorId: negra, cutout: null, colorMain: false })
    expect(seen.json.photos[0].urls.vitrina).toMatch(/\/vitrina\?vence=600$/)
    expect(Date.parse(seen.json.expiresAt)).toBeGreaterThan(Date.now())
    const denied = await call(
      "lucia",
      "POST",
      `${base}/productos/${zapatilla}/fotos`,
      undefined,
      photo(await jpeg(1, 2, 3)),
    )
    expect(denied.status).toBe(403)
    expect((await call("ajena", "GET", `${base}/productos/${zapatilla}/medios`)).status).toBe(404)
  })

  it("se mira el contenido: un archivo que dice ser foto y no lo es no se guarda", async () => {
    const before = storage.files.size
    const fake = await call("rosa", "POST", `${base}/productos/${zapatilla}/fotos`, undefined, {
      type: "image/jpeg",
      data: new Uint8Array(Buffer.from("\xff\xd8\xff<svg onload=alert(1)>", "latin1")),
    })
    expect(fake.status).toBe(400)
    expect(storage.files.size).toBe(before)
  })

  it("sin almacenamiento no se suben y lo dice", async () => {
    const up = await call(
      "rosa",
      "POST",
      `${base}/productos/${zapatilla}/fotos`,
      undefined,
      photo(await jpeg(9, 9, 9)),
      off,
    )
    expect(up.status).toBe(503)
    expect(up.json.error.code).toBe("MEDIA_OFF")
  })

  it("quitar el fondo es una propuesta: la original se guarda siempre", async () => {
    // Una foto sin fondo es transparente: la que no lo es no sirve de propuesta.
    const opaque = await call(
      "rosa",
      "POST",
      `${base}/fotos/${first}/sin-fondo`,
      undefined,
      photo(await jpeg(5, 5, 5)),
    )
    expect(opaque.status).toBe(400)
    const proposed = await call("rosa", "POST", `${base}/fotos/${first}/sin-fondo`, undefined, {
      type: "image/png",
      data: new Uint8Array(await transparent()),
    })
    expect(proposed.status).toBe(201)
    let seen = (await call("lucia", "GET", `${base}/productos/${zapatilla}/medios`)).json.photos[0]
    expect(seen.cutout).toBe("propuesta")
    expect(seen.urls.vitrina).not.toMatch(/sin-fondo/)
    expect(seen.urls.sinFondo.vitrina).toMatch(/sin-fondo\/vitrina/)
    // «Usar esta»: se ve la sin fondo; la original sigue.
    expect(
      (await call("mario", "PATCH", `${base}/fotos/${first}/sin-fondo`, { usar: true })).status,
    ).toBe(200)
    seen = (await call("lucia", "GET", `${base}/productos/${zapatilla}/medios`)).json.photos[0]
    expect(seen.cutout).toBe("usada")
    expect(seen.urls.vitrina).toMatch(/sin-fondo\/vitrina/)
    expect(seen.urls.original).toMatch(new RegExp(`${first}/original`))
    // El WhatsApp de la sin fondo va sobre blanco, en JPEG.
    const key = `tiendas/${storeId}/productos/${zapatilla}/fotos/${first}/sin-fondo/whatsapp`
    const flat = await sharp(storage.files.get(key)!.bytes).metadata()
    expect(flat.format).toBe("jpeg")
    // «Dejar la original»: la propuesta se borra después (la base la anota).
    expect(
      (await call("rosa", "PATCH", `${base}/fotos/${first}/sin-fondo`, { usar: false })).status,
    ).toBe(200)
    const trash = await db.ownerDb.select().from(mediaTrash)
    expect(trash.map((t) => t.objectKey)).toContain(
      `tiendas/${storeId}/productos/${zapatilla}/fotos/${first}/sin-fondo`,
    )
    await emptyMediaTrash(db.ownerDb, storage)
    expect(storage.files.has(key)).toBe(false)
    expect(
      storage.files.has(`tiendas/${storeId}/productos/${zapatilla}/fotos/${first}/original`),
    ).toBe(true)
    expect(await db.ownerDb.select().from(mediaTrash)).toEqual([])
    expect(
      (await call("lucia", "PATCH", `${base}/fotos/${first}/sin-fondo`, { usar: true })).status,
    ).toBe(403)
  })

  it("una persona del equipo cambia el color de la foto que subió otra", async () => {
    const moved = await call("rosa", "PATCH", `${base}/fotos/${first}`, {
      colorId: negra,
      colorMain: true,
    })
    expect(moved.status).toBe(200)
    expect((await call("mario", "PATCH", `${base}/fotos/${first}`, { position: 1 })).status).toBe(
      200,
    )
  })

  it("Sofi manda la foto elegida del color pedido, en la copia de WhatsApp", async () => {
    const media = await withAgent(db.appDb, SOFI_ACTOR, storeId, (tx) =>
      sofiMediaIn(tx, storage, storeId, zapatilla, "Negra"),
    )
    expect(media.photo).toMatchObject({ kind: "foto", id: first, mimeType: "image/jpeg" })
    expect(media.photo!.url).toMatch(/\/whatsapp\?vence=3600$/)
    // Sofi no borra fotos: para ella no hay ninguna que borrar.
    const gone = await withAgent(db.appDb, SOFI_ACTOR, storeId, (tx) =>
      tx.delete(productPhoto).where(eq(productPhoto.id, first)).returning(),
    )
    expect(gone).toEqual([])
    expect(await db.ownerDb.select().from(productPhoto).where(eq(productPhoto.id, first))).toHaveLength(1)
  })

  it("al quitarla, la base anota su carpeta y el servidor la borra", async () => {
    expect((await call("rosa", "DELETE", `${base}/fotos/${second}`)).status).toBe(204)
    const folder = `tiendas/${storeId}/productos/${zapatilla}/fotos/${second}`
    expect((await db.ownerDb.select().from(mediaTrash)).map((t) => t.objectKey)).toEqual([folder])
    expect(await emptyMediaTrash(db.ownerDb, storage)).toEqual({ removed: 1, more: false })
    expect([...storage.files.keys()].some((k) => k.startsWith(folder))).toBe(false)
  })

  it("las fotos de antes, que están en la base, se mudan solas y se siguen viendo", async () => {
    const png = await sharp({
      create: { width: 64, height: 64, channels: 3, background: "#ff0000" },
    })
      .png()
      .toBuffer()
    const [old] = await db.ownerDb
      .insert(productPhoto)
      .values({
        storeId,
        productId: zapatilla,
        position: 5,
        contentType: "image/png",
        content: png,
        createdBy: "u-rosa",
      })
      .returning({ id: productPhoto.id })
    // Antes de mudarse: sin enlaces, se ve por la ruta de siempre.
    const listed = (await call("lucia", "GET", `${base}/productos/${zapatilla}/medios`)).json.photos
    expect(listed.find((p: { id: string }) => p.id === old!.id).urls).toBeNull()
    expect(
      (await call("lucia", "GET", `${base}/fotos/${old!.id}`)).response.headers.get("content-type"),
    ).toBe("image/png")
    expect(await moveStoredPhotos(db.ownerDb, storage)).toMatchObject({ moved: 1, failed: 0 })
    const [row] = await db.ownerDb.select().from(productPhoto).where(eq(productPhoto.id, old!.id))
    expect(row).toMatchObject({ content: null, width: 64, height: 64 })
    expect(storage.files.has(`${row!.objectKey}/original`)).toBe(true)
    // Ya no hay nada que mudar.
    expect(await moveStoredPhotos(db.ownerDb, storage)).toMatchObject({ moved: 0 })
  })
})

describe("el video corto", () => {
  const form = (video: Buffer, extra: Record<string, string> = {}) => {
    const body = new FormData()
    body.set("video", new File([new Uint8Array(video)], "puesta.mp4", { type: "video/mp4" }))
    for (const [k, v] of Object.entries(extra)) body.set(k, v)
    return body
  }
  let videoId = ""

  it("se sube listo para WhatsApp, con su póster; uno por producto y por color", async () => {
    const body = form(read("../semilla/video-calzado.mp4"), {
      colorId: negra,
      label: "Puesta, caminando",
    })
    body.set("poster", new File([new Uint8Array(await jpeg(20, 20, 20, 480))], "poster.jpg"))
    const up = await call("rosa", "POST", `${base}/productos/${zapatilla}/videos`, undefined, {
      data: body,
    })
    expect(up.status).toBe(201)
    videoId = up.json.video.id
    expect(up.json.video.durationMs).toBeGreaterThan(5000)
    const again = form(read("../semilla/video-calzado.mp4"), { colorId: negra })
    again.set("poster", new File([new Uint8Array(await jpeg(20, 20, 20, 480))], "poster.jpg"))
    const taken = await call("rosa", "POST", `${base}/productos/${zapatilla}/videos`, undefined, {
      data: again,
    })
    expect(taken.status).toBe(409)
    const seen = await call("lucia", "GET", `${base}/productos/${zapatilla}/medios`)
    expect(seen.json.videos).toEqual([
      expect.objectContaining({
        id: videoId,
        colorId: negra,
        label: "Puesta, caminando",
        width: 480,
      }),
    ])
    expect(seen.json.videos[0].urls.video).toMatch(/\/video\?vence=600$/)
  })

  it("rechaza el que WhatsApp no muestra en Android y el que no trae póster", async () => {
    const high = form(read("./__fixtures__/video-high.mp4"))
    high.set("poster", new File([new Uint8Array(await jpeg(20, 20, 20, 480))], "poster.jpg"))
    const bad = await call("rosa", "POST", `${base}/productos/${zapatilla}/videos`, undefined, {
      data: high,
    })
    expect(bad.status).toBe(400)
    expect(bad.json.error.code).toBe("VIDEO_TYPE")
    const noPoster = await call(
      "rosa",
      "POST",
      `${base}/productos/${zapatilla}/videos`,
      undefined,
      {
        data: form(read("../semilla/video-calzado.mp4")),
      },
    )
    expect(noPoster.status).toBe(400)
  })

  it("Sofi manda el video del color, y la vitrina lo muestra", async () => {
    const media = await withAgent(db.appDb, SOFI_ACTOR, storeId, (tx) =>
      sofiMediaIn(tx, storage, storeId, zapatilla, "negra"),
    )
    expect(media.video).toMatchObject({
      kind: "video",
      id: videoId,
      mimeType: "video/mp4",
      label: "Puesta, caminando",
    })
    const shown = await call(null, "GET", `/vitrina/calzadosrosa/zapatilla-urbana/medios`)
    expect(shown.status).toBe(200)
    expect(shown.response.headers.get("access-control-allow-origin")).toBe("*")
    expect(shown.json.videos).toHaveLength(1)
    expect(shown.json.videos[0]).toMatchObject({ color: "negra", label: "Puesta, caminando" })
    // La vitrina nunca da la original.
    expect(JSON.stringify(shown.json)).not.toMatch(/original/)
    expect(shown.json.photos[0].vitrina).toMatch(/vence=3600/)
  })

  it("la vitrina no muestra lo que no está en la web ni lo de un link que no es", async () => {
    await db.ownerDb.update(product).set({ webVisible: false }).where(eq(product.id, zapatilla))
    expect((await call(null, "GET", `/vitrina/calzadosrosa/zapatilla-urbana/medios`)).status).toBe(
      404,
    )
    await db.ownerDb.update(product).set({ webVisible: true }).where(eq(product.id, zapatilla))
    expect((await call(null, "GET", `/vitrina/otra-tienda/zapatilla-urbana/medios`)).status).toBe(
      404,
    )
    expect((await call(null, "GET", `/vitrina/calzadosrosa/..%2F..%2Fetc/medios`)).status).toBe(404)
  })

  it("si el color se va, el video pasa a ser el del producto", async () => {
    const changed = await call("rosa", "PATCH", `${base}/productos/${zapatilla}`, {
      options: [
        { name: "Color", values: ["blanca"] },
        { name: "Talla", values: ["38", "39"] },
      ],
    })
    expect(changed.status).toBe(200)
    const seen = await call("lucia", "GET", `${base}/productos/${zapatilla}/medios`)
    expect(seen.json.videos[0]).toMatchObject({ id: videoId, colorId: null })
  })

  it("al quitarlo, la base anota su carpeta", async () => {
    expect((await call("lucia", "DELETE", `${base}/videos/${videoId}`)).status).toBe(403)
    expect((await call("rosa", "DELETE", `${base}/videos/${videoId}`)).status).toBe(204)
    expect((await db.ownerDb.select().from(mediaTrash)).map((t) => t.objectKey)).toEqual([
      `tiendas/${storeId}/productos/${zapatilla}/videos/${videoId}`,
    ])
    await emptyMediaTrash(db.ownerDb, storage)
  })
})

describe("cargar muchos", () => {
  let loadId = ""
  const loadBase = () => `${base}/cargas/${loadId}`

  it("cada foto es un producto por revisar; se juntan, se mueven y quedan sueltas", async () => {
    const opened = await call("rosa", "POST", `${base}/cargas`)
    expect(opened.status).toBe(201)
    loadId = opened.json.load.id
    expect((await call("lucia", "POST", `${base}/cargas`)).status).toBe(403)
    const a = await call(
      "rosa",
      "POST",
      `${loadBase()}/fotos?archivo=IMG_1.jpg`,
      undefined,
      photo(await jpeg(250, 200, 220, 600)),
    )
    const b = await call(
      "rosa",
      "POST",
      `${loadBase()}/fotos?archivo=IMG_2.jpg`,
      undefined,
      photo(await jpeg(250, 250, 250, 600)),
    )
    const c = await call(
      "mario",
      "POST",
      `${loadBase()}/fotos?archivo=caja.jpg&producto=suelta`,
      undefined,
      photo(await jpeg(200, 180, 150, 600)),
    )
    expect([a.status, b.status, c.status]).toEqual([201, 201, 201])
    expect(c.json.photo.itemId).toBeNull()
    let detail = (await call("rosa", "GET", loadBase())).json
    expect(detail.items).toHaveLength(2)
    expect(detail.loosePhotos).toHaveLength(1)
    // «Juntar»: las dos fotos son de la misma zapatilla.
    const joined = await call(
      "rosa",
      "POST",
      `${loadBase()}/productos/${a.json.photo.itemId}/juntar`,
      {
        from: [b.json.photo.itemId],
      },
    )
    expect(joined.status).toBe(200)
    detail = (await call("rosa", "GET", loadBase())).json
    expect(detail.items).toHaveLength(1)
    expect(detail.items[0].photos.map((p: { fileName: string }) => p.fileName)).toEqual([
      "IMG_1.jpg",
      "IMG_2.jpg",
    ])
    expect(detail.items[0].photos[0].urls.miniatura).toMatch(/miniatura/)
    // «Mover a…» un producto nuevo y de vuelta: el que quedó vacío se quita solo.
    const moved = await call("rosa", "PATCH", `${loadBase()}/fotos/${b.json.photo.id}`, {
      newItem: true,
    })
    expect(moved.status).toBe(200)
    await call("rosa", "PATCH", `${loadBase()}/fotos/${b.json.photo.id}`, {
      itemId: a.json.photo.itemId,
    })
    detail = (await call("rosa", "GET", loadBase())).json
    expect(detail.items).toHaveLength(1)
    expect(detail.counts).toEqual({ items: 1, ready: 0, doubts: 0, withoutPrice: 1 })
  })

  it("la hoja con las tallas en columnas suma productos y les pone sus fotos por nombre", async () => {
    const csv =
      "Producto;Categoría;Color;Precio;Foto;36;37;38\n" +
      "Sandalia trenzada;Sandalias;camel;89;caja.jpg;2;;1\n"
    const sheet = await call("rosa", "POST", `${loadBase()}/hoja`, undefined, {
      type: "text/csv",
      data: new TextEncoder().encode(csv),
    })
    expect(sheet.status).toBe(200)
    expect(sheet.json).toEqual({ added: 1, errors: [] })
    const detail = (await call("rosa", "GET", loadBase())).json
    const sandalia = detail.items.find((i: { name: string }) => i.name === "Sandalia trenzada")
    expect(sandalia).toMatchObject({
      state: "listo",
      colors: ["camel"],
      sizes: ["36", "38"],
      listPriceCents: 8900,
    })
    expect(sandalia.variants.map((v: { stock: number }) => v.stock)).toEqual([2, 1])
    expect(sandalia.photos.map((p: { fileName: string }) => p.fileName)).toEqual(["caja.jpg"])
    expect(detail.loosePhotos).toEqual([])
    // Con un error, la hoja no agrega nada.
    const bad = await call("rosa", "POST", `${loadBase()}/hoja`, undefined, {
      type: "text/csv",
      data: new TextEncoder().encode("Producto;Precio;Stock\nZapatilla urbana;1;1\n"),
    })
    expect(bad.status).toBe(422)
    expect(bad.json.errors[0].message).toMatch(/ya está en tu catálogo/)
  })

  it("«Crear» no crea nada si falta algo, y dice qué falta en cada producto", async () => {
    const created = await call("rosa", "POST", `${loadBase()}/crear`)
    expect(created.status).toBe(422)
    expect(created.json.created).toBe(0)
    expect(created.json.errors).toEqual([expect.objectContaining({ message: "Ponle nombre" })])
    const names = (
      await db.ownerDb
        .select({ name: product.name })
        .from(product)
        .where(eq(product.storeId, storeId))
    ).map((p) => p.name)
    expect(names).not.toContain("Sandalia trenzada")
  })

  it("«Poner a los 20» y «Crear»: pasa todo al catálogo con su stock y sus fotos, sin copiarlas", async () => {
    let detail = (await call("rosa", "GET", loadBase())).json
    const plataforma = detail.items.find((i: { name: string }) => i.name === "")
    await call("rosa", "PATCH", `${loadBase()}/productos/${plataforma.id}`, {
      name: "Zapatilla plataforma",
      colors: ["rosada"],
    })
    const bulk = await call("rosa", "PATCH", `${loadBase()}/productos`, {
      ids: [plataforma.id],
      set: { listPriceCents: 12900, sizes: ["35", "36"], stock: 2, state: "listo" },
    })
    expect(bulk.json).toEqual({ updated: 1 })
    detail = (await call("rosa", "GET", loadBase())).json
    expect(detail.counts).toEqual({ items: 2, ready: 2, doubts: 0, withoutPrice: 0 })
    const keys = detail.items.flatMap((i: { photos: { id: string }[] }) =>
      i.photos.map((p) => p.id),
    )
    const folders = (
      await db.ownerDb.select().from(bulkLoadPhoto).where(eq(bulkLoadPhoto.loadId, loadId))
    ).map((p) => p.objectKey)
    expect(keys).toHaveLength(3)

    const created = await call("mario", "POST", `${loadBase()}/crear`)
    expect(created.status).toBe(200)
    expect(created.json.created).toBe(2)
    const [made] = await db.ownerDb
      .select()
      .from(product)
      .where(eq(product.name, "Zapatilla plataforma"))
    const detailMade = (await call("lucia", "GET", `${base}/productos/${made!.id}`)).json.product
    expect(
      detailMade.variants.map((v: { optionValues: string[]; stock: number }) => [
        ...v.optionValues,
        v.stock,
      ]),
    ).toEqual([
      ["rosada", "35", 2],
      ["rosada", "36", 2],
    ])
    const photos = await db.ownerDb
      .select()
      .from(productPhoto)
      .where(eq(productPhoto.productId, made!.id))
    expect(photos).toHaveLength(2)
    // La misma carpeta: nada se copió ni se anotó para borrar.
    expect(folders).toEqual(expect.arrayContaining(photos.map((p) => p.objectKey)))
    expect(
      await db.ownerDb.select().from(bulkLoadPhoto).where(eq(bulkLoadPhoto.loadId, loadId)),
    ).toEqual([])
    expect(await db.ownerDb.select().from(mediaTrash)).toEqual([])
    // Ya creada, no cambia.
    expect((await call("rosa", "POST", `${loadBase()}/crear`)).status).toBe(409)
    expect(
      (await call("rosa", "POST", `${loadBase()}/fotos`, undefined, photo(await jpeg(1, 1, 1, 64))))
        .status,
    ).toBe(409)
  })

  it("«Descartar» cierra la carga y sus fotos se borran", async () => {
    const opened = await call("rosa", "POST", `${base}/cargas`)
    const other = opened.json.load.id
    const up = await call(
      "rosa",
      "POST",
      `${base}/cargas/${other}/fotos`,
      undefined,
      photo(await jpeg(3, 3, 3, 64)),
    )
    expect(up.status).toBe(201)
    expect((await call("rosa", "DELETE", `${base}/cargas/${other}`)).status).toBe(204)
    expect((await db.ownerDb.select().from(mediaTrash)).map((t) => t.objectKey)).toEqual([
      `tiendas/${storeId}/cargas/${other}/fotos/${up.json.photo.id}`,
    ])
    await emptyMediaTrash(db.ownerDb, storage)
    const list = (await call("rosa", "GET", `${base}/cargas`)).json.loads
    expect(list.map((l: { state: string }) => l.state).sort()).toEqual(["creada", "descartada"])
    // Sofi no ve las cargas.
    const seen = await withAgent(db.appDb, SOFI_ACTOR, storeId, (tx) =>
      tx.select().from(bulkLoadPhoto),
    )
    expect(seen).toEqual([])
  })
})

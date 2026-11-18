/**
 * La configuración de la tienda (paso B3 del lienzo B), contra una base real y un token firmado
 * como el de la cuenta: medios de pago, formas de entrega, el catálogo con variantes, el stock
 * con su kardex, el aviso del costo, la hoja y lo que puede cada rol.
 */
import { randomUUID } from "node:crypto"
import { enterStore, productVariant, store, storeMember, withPerson } from "@gestoria/db"
import { startTestDb, type TestDb } from "@gestoria/db/testing"
import { eq } from "drizzle-orm"
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createApp } from "./app.js"
import { cancelSale, recordSale } from "./stock.js"

const ACCOUNT = "https://api.gestoria.test"
const WEB = "https://app.gestoria.test"

let db: TestDb
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"]
let jwk: JWK
let app: ReturnType<typeof createApp>

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
  who: Who,
  method: string,
  path: string,
  body?: unknown,
  raw?: { type: string; data: string | Buffer },
) {
  const response = await app.request(`https://servidor.gestoria.test${path}`, {
    method,
    headers: {
      origin: WEB,
      authorization: `Bearer ${await tokenFor(who)}`,
      "content-type": raw?.type ?? "application/json",
    },
    ...(raw ? { body: raw.data } : body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const type = response.headers.get("content-type") ?? ""
  if (!type.includes("json")) return { status: response.status, json: {} as Record<string, any>, response }
  const text = await response.text()
  // biome-ignore lint/suspicious/noExplicitAny: las pruebas leen respuestas JSON de forma libre
  return { status: response.status, json: text ? (JSON.parse(text) as Record<string, any>) : {}, response }
}

beforeAll(async () => {
  db = await startTestDb()
  const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" })
  privateKey = pair.privateKey
  jwk = { ...(await exportJWK(pair.publicKey)), alg: "EdDSA", kid: "k1" }
  app = createApp({
    appDb: db.appDb,
    ownerDb: db.ownerDb,
    account: { url: ACCOUNT, eventsSecret: "", keys: createLocalJWKSet({ keys: [jwk] }) },
    webURL: WEB,
  })
  // Cada persona entra una vez (queda su copia) y se arma el equipo de Calzados Rosa.
  for (const who of Object.keys(people) as Who[]) await call(who, "GET", "/api/yo")
  await db.ownerDb
    .insert(store)
    .values({ id: storeId, name: "Calzados Rosa", currency: "PEN", createdBy: "u-rosa" })
  await db.ownerDb.insert(storeMember).values([
    { storeId, userId: "u-rosa", role: "owner" },
    { storeId, userId: "u-mario", role: "admin", addedBy: "u-rosa" },
    { storeId, userId: "u-lucia", role: "sales", addedBy: "u-rosa" },
  ])
})

afterAll(async () => {
  await db?.stop()
})

describe("medios de pago (tablero 6)", () => {
  it("el Dueño y el Administrador los arman; Ventas los ve sin cambiarlos", async () => {
    const yape = await call("rosa", "POST", `${base}/medios-de-pago`, {
      name: "Yape",
      typeCode: "68",
      collection: "comprobante",
      details: "987 654 321 · Rosa Díaz",
    })
    expect(yape.status).toBe(201)
    const link = await call("mario", "POST", `${base}/medios-de-pago`, {
      name: "Tarjeta con enlace",
      typeCode: "48",
      collection: "link",
      isActive: false,
    })
    expect(link.status).toBe(201)
    await call("rosa", "POST", `${base}/medios-de-pago`, {
      name: "Efectivo al recibir",
      typeCode: "10",
      collection: "al_recibir",
    })
    // Ventas ve la lista, en el orden en que cobra Sofi: link, captura, al recibir.
    const seen = await call("lucia", "GET", `${base}/pagos-y-entregas`)
    expect(seen.json.payments.map((m: { name: string }) => m.name)).toEqual([
      "Tarjeta con enlace",
      "Yape",
      "Efectivo al recibir",
    ])
    expect(
      (await call("lucia", "POST", `${base}/medios-de-pago`, { name: "X", typeCode: "68", collection: "comprobante" }))
        .status,
    ).toBe(403)
    expect(
      (await call("lucia", "PATCH", `${base}/medios-de-pago/${yape.json.method.id}`, { isActive: false })).status,
    ).toBe(403)
    expect((await call("lucia", "DELETE", `${base}/medios-de-pago/${yape.json.method.id}`)).status).toBe(403)
  })

  it("el efectivo se cobra al recibir; apagar un medio guarda solo eso", async () => {
    const cash = await call("rosa", "POST", `${base}/medios-de-pago`, {
      name: "Efectivo",
      typeCode: "10",
      collection: "comprobante",
    })
    expect(cash.status).toBe(400)
    expect(cash.json.error.fields).toHaveProperty("collection")
    const list = await call("rosa", "GET", `${base}/pagos-y-entregas`)
    const yape = list.json.payments.find((m: { name: string }) => m.name === "Yape")
    const off = await call("rosa", "PATCH", `${base}/medios-de-pago/${yape.id}`, { isActive: false })
    expect(off.json.method).toMatchObject({ name: "Yape", isActive: false, details: "987 654 321 · Rosa Díaz" })
  })
})

describe("formas de entrega (tablero 6 y decisión 1)", () => {
  it("cada una con su costo, cuándo llega, pago al recibir y lo que Sofi puede negociar", async () => {
    const reparto = await call("rosa", "POST", `${base}/formas-de-entrega`, {
      name: "Reparto en Lima",
      type: "DeliveryModeOwnFleet",
      cost: "por_zona",
      zones: [
        { name: "Surco y Miraflores", priceCents: 1000 },
        { name: "Callao", priceCents: 1500 },
      ],
      eta: "Al día siguiente",
      acceptsPayOnDelivery: true,
      maxDiscountCents: 1000,
      freeFromCents: 25000,
    })
    expect(reparto.status).toBe(201)
    expect(reparto.json.method).toMatchObject({ cost: "por_zona", maxDiscountCents: 1000, freeFromCents: 25000 })
    // Gratis no se negocia; precio fijo pide el precio; un tipo fuera de la lista, no.
    for (const bad of [
      { cost: "gratis", maxDiscountCents: 500 },
      { cost: "fijo" },
      { cost: "por_zona", zones: [] },
      { cost: "gratis", type: "Drone" },
    ])
      expect(
        (await call("rosa", "POST", `${base}/formas-de-entrega`, { name: "X", type: "OnSitePickup", ...bad })).status,
        JSON.stringify(bad),
      ).toBe(400)
    const recojo = await call("rosa", "POST", `${base}/formas-de-entrega`, {
      name: "Recojo en la tienda",
      type: "OnSitePickup",
      cost: "gratis",
      details: "Jr. Gamarra 650",
      priceCents: 999,
    })
    // Lo que no aplica al costo elegido no se guarda.
    expect(recojo.json.method).toMatchObject({ priceCents: null, zones: [] })
    expect(
      (await call("lucia", "POST", `${base}/formas-de-entrega`, { name: "X", type: "OnSitePickup", cost: "gratis" }))
        .status,
    ).toBe(403)
  })
})

let zapatilla = ""
const variantOf = (product: { variants: { id: string; optionValues: string[] }[] }, ...values: string[]) =>
  product.variants.find((v) => v.optionValues.join("/") === values.join("/"))!.id

describe("el catálogo con variantes (tablero 7)", () => {
  it("un producto arma todas las combinaciones de sus opciones, cada una con su código y stock 0", async () => {
    const created = await call("mario", "POST", `${base}/productos`, {
      name: "Zapatilla urbana",
      category: "Zapatillas",
      description: "Cuero sintético, planta de goma.",
      listPriceCents: 12900,
      options: [
        { name: "Color", values: ["blanca", "negra"] },
        { name: "Talla", values: ["38", "39"] },
      ],
    })
    expect(created.status).toBe(201)
    zapatilla = created.json.product.id
    const detail = await call("lucia", "GET", `${base}/productos/${zapatilla}`)
    expect(detail.json.product.variants).toHaveLength(4)
    expect(detail.json.product.variants[0]).toMatchObject({ sku: "ZAPATILLAU-BLANCA-38", stock: 0, priceCents: null })
    // El mismo nombre, dos veces no; Ventas no crea.
    expect(
      (await call("rosa", "POST", `${base}/productos`, { name: "zapatilla URBANA", listPriceCents: 100 })).status,
    ).toBe(409)
    expect((await call("lucia", "POST", `${base}/productos`, { name: "Otro", listPriceCents: 100 })).status).toBe(403)
    // Más de tres opciones o una combinación de más, no.
    expect(
      (
        await call("rosa", "POST", `${base}/productos`, {
          name: "Raro",
          listPriceCents: 100,
          options: ["a", "b", "c", "d"].map((name) => ({ name, values: ["1"] })),
        })
      ).status,
    ).toBe(400)
  })

  it("la variante puede tener su propio precio y entonces Sofi dice «desde»", async () => {
    const detail = (await call("rosa", "GET", `${base}/productos/${zapatilla}`)).json.product
    const negra38 = variantOf(detail, "negra", "38")
    const changed = await call("rosa", "PATCH", `${base}/variantes/${negra38}`, { priceCents: 8900 })
    expect(changed.json.product).toMatchObject({ fromCents: 8900, toCents: 12900 })
    expect((await call("lucia", "PATCH", `${base}/variantes/${negra38}`, { priceCents: 100 })).status).toBe(403)
    // Un código ya usado, no.
    const blanca38 = variantOf(detail, "blanca", "38")
    expect((await call("rosa", "PATCH", `${base}/variantes/${negra38}`, { sku: "zapatillau-blanca-38" })).status).toBe(
      409,
    )
    expect(blanca38).toBeTruthy()
  })
})

describe("el stock y su kardex (decisión 3)", () => {
  it("cada entrada y cada ajuste quedan con quién, cuándo, la cantidad y el saldo", async () => {
    const detail = (await call("rosa", "GET", `${base}/productos/${zapatilla}`)).json.product
    const blanca38 = variantOf(detail, "blanca", "38")
    const entrada = await call("mario", "POST", `${base}/variantes/${blanca38}/movimientos`, {
      kind: "entrada",
      quantity: 4,
      unitCostCents: 6800,
    })
    expect(entrada.status).toBe(201)
    expect(entrada.json.movement).toMatchObject({ balance: 4, quantity: 4 })
    // Un ajuste pide motivo escrito y se hace con lo que se contó.
    const noReason = await call("rosa", "POST", `${base}/variantes/${blanca38}/movimientos`, {
      kind: "ajuste",
      counted: 3,
      reason: "",
    })
    expect(noReason.status).toBe(400)
    expect(noReason.json.error.fields).toHaveProperty("reason")
    const ajuste = await call("rosa", "POST", `${base}/variantes/${blanca38}/movimientos`, {
      kind: "ajuste",
      counted: 3,
      reason: "par dañado",
    })
    expect(ajuste.json.movement).toMatchObject({ kind: "ajuste", quantity: -1, balance: 3 })
    expect(
      (await call("rosa", "POST", `${base}/variantes/${blanca38}/movimientos`, { kind: "ajuste", counted: 3, reason: "conteo" }))
        .status,
    ).toBe(409)
    // Ventas ve el kardex, pero no mueve el stock a mano.
    const seen = await call("lucia", "GET", `${base}/variantes/${blanca38}/kardex`)
    expect(seen.json.stock).toBe(3)
    expect(seen.json.movements).toEqual([
      expect.objectContaining({ kind: "ajuste", quantity: -1, balance: 3, reason: "par dañado", actorName: "Rosa Quispe" }),
      expect.objectContaining({ kind: "entrada", quantity: 4, balance: 4, unitCostCents: 6800, actorName: "Mario Huamán" }),
    ])
    expect(
      (await call("lucia", "POST", `${base}/variantes/${blanca38}/movimientos`, { kind: "entrada", quantity: 9 }))
        .status,
    ).toBe(403)
  })

  it("una venta descuenta una vez por pedido y al anularla vuelve una vez; si no alcanza, no descuenta nada", async () => {
    const detail = (await call("rosa", "GET", `${base}/productos/${zapatilla}`)).json.product
    const blanca38 = variantOf(detail, "blanca", "38")
    const blanca39 = variantOf(detail, "blanca", "39")
    const person = { userId: "u-lucia", email: "lucia@calzados.test", storeId }
    const inStoreTx = <T>(fn: Parameters<typeof withPerson<T>>[2]) =>
      withPerson(db.appDb, person, async (tx) => {
        await enterStore(tx, storeId)
        return fn(tx)
      })
    const stock = async (id: string) =>
      (await db.ownerDb.select({ s: productVariant.stock }).from(productVariant).where(eq(productVariant.id, id)))[0]!.s
    await inStoreTx((tx) => recordSale(tx, storeId, "u-lucia", "0142", [{ variantId: blanca38, quantity: 1 }]))
    await inStoreTx((tx) => recordSale(tx, storeId, "u-lucia", "0142", [{ variantId: blanca38, quantity: 1 }]))
    expect(await stock(blanca38)).toBe(2)
    // La 39 no tiene stock: el pedido entero no descuenta.
    await expect(
      inStoreTx((tx) =>
        recordSale(tx, storeId, "u-lucia", "0143", [
          { variantId: blanca38, quantity: 1 },
          { variantId: blanca39, quantity: 1 },
        ]),
      ),
    ).rejects.toMatchObject({ code: "NOT_ENOUGH_STOCK" })
    expect(await stock(blanca38)).toBe(2)
    expect(await inStoreTx((tx) => cancelSale(tx, storeId, "u-lucia", "0142"))).toBe(1)
    expect(await inStoreTx((tx) => cancelSale(tx, storeId, "u-lucia", "0142"))).toBe(0)
    expect(await stock(blanca38)).toBe(3)
    const kinds = (await call("rosa", "GET", `${base}/variantes/${blanca38}/kardex`)).json.movements.map(
      (m: { kind: string; reference: string | null }) => `${m.kind}:${m.reference ?? ""}`,
    )
    expect(kinds.slice(0, 2)).toEqual(["anulacion:0142", "venta:0142"])
  })

  it("una variante con stock no se quita, ni cambiando las opciones; sin stock, sí", async () => {
    const detail = (await call("rosa", "GET", `${base}/productos/${zapatilla}`)).json.product
    const blanca38 = variantOf(detail, "blanca", "38")
    expect((await call("rosa", "DELETE", `${base}/variantes/${blanca38}`)).status).toBe(409)
    const dropBlanca = await call("rosa", "PATCH", `${base}/productos/${zapatilla}`, {
      options: [
        { name: "Color", values: ["negra"] },
        { name: "Talla", values: ["38", "39"] },
      ],
    })
    expect(dropBlanca.status).toBe(409)
    expect(dropBlanca.json.error.message).toContain("blanca 38 (3)")
    // Sumar una talla crea sus combinaciones; quitar la 39 (sin stock) las quita.
    const changed = await call("rosa", "PATCH", `${base}/productos/${zapatilla}`, {
      options: [
        { name: "Color", values: ["blanca", "negra"] },
        { name: "Talla", values: ["38", "40"] },
      ],
    })
    expect(changed.status).toBe(200)
    expect(changed.json.product.variants.map((v: { optionValues: string[] }) => v.optionValues.join(" ")).sort()).toEqual(
      ["blanca 38", "blanca 40", "negra 38", "negra 40"],
    )
    const negra40 = variantOf(changed.json.product, "negra", "40")
    const removed = await call("rosa", "DELETE", `${base}/variantes/${negra40}`)
    expect(removed.json.product.variants).toHaveLength(3)
  })
})

describe("el precio mínimo y el aviso del costo (tablero 14)", () => {
  it("avisa si queda cerca o bajo el último costo del kardex, y deja guardar igual", async () => {
    const near = await call("rosa", "PATCH", `${base}/productos/${zapatilla}`, { minPriceCents: 7000 })
    expect(near.status).toBe(200)
    expect(near.json.product).toMatchObject({
      minPriceCents: 7000,
      lastCostCents: 6800,
      costWarning: { kind: "cerca", marginCents: 200 },
    })
    const loss = await call("rosa", "PATCH", `${base}/productos/${zapatilla}`, { minPriceCents: 6000 })
    expect(loss.json.product.costWarning).toEqual({ kind: "perdida", costCents: 6800, lossCents: 800 })
    const fine = await call("rosa", "PATCH", `${base}/productos/${zapatilla}`, { minPriceCents: 10000 })
    expect(fine.json.product.costWarning).toBeNull()
    expect((await call("rosa", "PATCH", `${base}/productos/${zapatilla}`, { minPriceCents: 13000 })).status).toBe(400)
    // Ventas no cambia precios ni el mínimo.
    expect((await call("lucia", "PATCH", `${base}/productos/${zapatilla}`, { minPriceCents: 5000 })).status).toBe(403)
  })

  it("precio por cantidad y promociones que no se pisan; lo parecido y lo que combina", async () => {
    const sandalia = await call("rosa", "POST", `${base}/productos`, { name: "Sandalia", listPriceCents: 8900 })
    const saved = await call("rosa", "PATCH", `${base}/productos/${zapatilla}`, {
      quantityPrices: [{ minQuantity: 2, unitPriceCents: 11000 }],
      promotions: [{ name: "Cyber", percentOff: 15, startsOn: "2026-11-20", endsOn: "2026-11-23" }],
      links: [{ productId: sandalia.json.product.id, kind: "combina" }],
    })
    expect(saved.json.product).toMatchObject({
      quantityPrices: [{ minQuantity: 2, unitPriceCents: 11000 }],
      promotions: [{ name: "Cyber", percentOff: 15, startsOn: "2026-11-20", endsOn: "2026-11-23" }],
      links: [{ name: "Sandalia", kind: "combina" }],
    })
    // Desde la sandalia también se ve.
    const fromSandalia = await call("lucia", "GET", `${base}/productos/${sandalia.json.product.id}`)
    expect(fromSandalia.json.product.links).toEqual([expect.objectContaining({ productId: zapatilla, kind: "combina" })])
    const overlap = await call("rosa", "PATCH", `${base}/productos/${zapatilla}`, {
      promotions: [
        { name: "Cyber", percentOff: 15, startsOn: "2026-11-20", endsOn: "2026-11-23" },
        { name: "Fin de mes", percentOff: 10, startsOn: "2026-11-23", endsOn: "2026-11-30" },
      ],
    })
    expect(overlap.status).toBe(400)
    expect(
      (await call("rosa", "PATCH", `${base}/productos/${zapatilla}`, { quantityPrices: [{ minQuantity: 2, unitPriceCents: 13000 }] }))
        .status,
    ).toBe(400)
  })

  it("un producto que ya movió stock no se borra; uno recién creado, sí", async () => {
    expect((await call("rosa", "DELETE", `${base}/productos/${zapatilla}`)).status).toBe(409)
    const nuevo = await call("rosa", "POST", `${base}/productos`, { name: "Por error", listPriceCents: 100 })
    expect((await call("lucia", "DELETE", `${base}/productos/${nuevo.json.product.id}`)).status).toBe(403)
    expect((await call("rosa", "DELETE", `${base}/productos/${nuevo.json.product.id}`)).status).toBe(204)
  })
})

describe("las fotos", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  )
  it("se suben por su contenido (no por lo que dice el nombre) y solo el equipo las ve", async () => {
    const up = await call("rosa", "POST", `${base}/productos/${zapatilla}/fotos`, undefined, {
      type: "image/png",
      data: png,
    })
    expect(up.status).toBe(201)
    const fake = await call("rosa", "POST", `${base}/productos/${zapatilla}/fotos`, undefined, {
      type: "image/png",
      data: Buffer.from("<svg onload=alert(1)>"),
    })
    expect(fake.status).toBe(400)
    expect(
      (await call("lucia", "POST", `${base}/productos/${zapatilla}/fotos`, undefined, { type: "image/png", data: png }))
        .status,
    ).toBe(403)
    const seen = await call("lucia", "GET", `${base}/fotos/${up.json.photo.id}`)
    expect(seen.status).toBe(200)
    expect(seen.response.headers.get("content-type")).toBe("image/png")
    expect(seen.response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(Buffer.from(await seen.response.arrayBuffer())).toEqual(png)
    expect((await call("ajena", "GET", `${base}/fotos/${up.json.photo.id}`)).status).toBe(404)
    // Una variante la usa; al borrarla, vuelve a la del producto.
    const detail = (await call("rosa", "GET", `${base}/productos/${zapatilla}`)).json.product
    const blanca38 = variantOf(detail, "blanca", "38")
    await call("rosa", "PATCH", `${base}/variantes/${blanca38}`, { photoId: up.json.photo.id })
    expect((await call("rosa", "DELETE", `${base}/fotos/${up.json.photo.id}`)).status).toBe(204)
    const after = (await call("rosa", "GET", `${base}/productos/${zapatilla}`)).json.product
    expect(after.photos).toEqual([])
    expect(after.variants.find((v: { id: string }) => v.id === blanca38).photoId).toBeNull()
  })
})

describe("subir una hoja (decisión 10)", () => {
  const csv = (rows: string[]) =>
    ["Producto;Categoría;Opción 1;Valor 1;Opción 2;Valor 2;Código;Precio;Stock;Costo", ...rows].join("\n")
  const sheet = (who: Who, text: string, confirm: boolean) =>
    call(who, "POST", `${base}/catalogo/hoja${confirm ? "?confirmar=1" : ""}`, undefined, {
      type: "text/csv",
      data: text,
    })

  it("muestra qué se va a crear y cada error con su fila, sin guardar nada", async () => {
    const preview = await sheet(
      "rosa",
      csv([
        "Botín;Botines;Talla;39;;;;219;2;150",
        "Botín;Botines;Talla;40;;;;219;;150",
        "Botín;Botines;Talla;39;;;;219;1;",
        "Sandalia;;;;;;;89;5;",
        "Mocasín;;Color;azul;Talla;38;;149,50;0;",
      ]),
      true,
    )
    expect(preview.json.saved).toBe(false)
    expect(preview.json.errors).toEqual([
      { row: 3, message: expect.stringContaining("stock") },
      { row: 4, message: expect.stringContaining("ya está en otra fila") },
      { row: 5, message: expect.stringContaining("ya está en tu catálogo") },
    ])
    expect((await call("rosa", "GET", `${base}/catalogo`)).json.products.map((p: { name: string }) => p.name)).not.toContain(
      "Botín",
    )
  })

  it("sin errores, crea los productos con sus variantes y el stock entra al kardex", async () => {
    const text = csv([
      "Botín de cuero;Botines;Talla;39;;;BOT-39;219;2;150",
      "Botín de cuero;Botines;Talla;40;;;;219;1;150",
      "Mocasín azul;;Color;azul;Talla;38;;149.50;0;",
      "Mocasín azul;;Color;azul;Talla;39;;159;3;",
    ])
    const preview = await sheet("rosa", text, false)
    expect(preview.json).toMatchObject({
      saved: false,
      errors: [],
      products: [
        { name: "Botín de cuero", variants: 2, stock: 3 },
        { name: "Mocasín azul", variants: 2, stock: 3, fromCents: 14950, toCents: 15900 },
      ],
    })
    expect((await sheet("lucia", text, true)).status).toBe(403)
    const saved = await sheet("mario", text, true)
    expect(saved.json.saved).toBe(true)
    const list = (await call("rosa", "GET", `${base}/catalogo`)).json.products
    const botin = list.find((p: { name: string }) => p.name === "Botín de cuero")
    expect(botin).toMatchObject({ variantCount: 2, stock: 3, category: "Botines" })
    const detail = (await call("rosa", "GET", `${base}/productos/${botin.id}`)).json.product
    expect(detail.variants.map((v: { sku: string }) => v.sku)).toContain("BOT-39")
    expect(detail.lastCostCents).toBe(15000)
    const kardexOf = await call("rosa", "GET", `${base}/variantes/${detail.variants[0].id}/kardex`)
    expect(kardexOf.json.movements).toEqual([
      expect.objectContaining({ kind: "entrada", quantity: 2, reason: "Hoja subida", actorName: "Mario Huamán" }),
    ])
    // La misma hoja otra vez no duplica: los productos ya están.
    expect((await sheet("mario", text, true)).json.saved).toBe(false)
  })

  it("la hoja de ejemplo trae las columnas que se leen", async () => {
    const example = await call("rosa", "GET", `${base}/catalogo/hoja-de-ejemplo`)
    const text = await example.response.text()
    expect(text.split("\r\n")[0]).toContain("Producto;Categoría;Opción 1;Valor 1")
  })
})

describe("cada tienda, lo suyo", () => {
  it("quien no es del equipo no ve ni toca el catálogo ni la configuración", async () => {
    for (const path of ["/catalogo", "/pagos-y-entregas", `/productos/${zapatilla}`])
      expect((await call("ajena", "GET", `${base}${path}`)).status).toBe(404)
    expect((await call("ajena", "POST", `${base}/productos`, { name: "X", listPriceCents: 1 })).status).toBe(404)
  })
})

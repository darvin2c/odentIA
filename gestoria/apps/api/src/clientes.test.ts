/**
 * Las clientas (entrega 4, tablero 8), contra una base real y un token firmado como el de la
 * cuenta: cada pedido se suma a la ficha de su clienta; el mismo teléfono no une, solo sugiere;
 * una persona une, separa o dice que son distintas; «Repetir pedido»; lo que puede cada rol y el
 * aislamiento entre tiendas. Y Sofi: el pedido de un chat usa la ficha de ese chat, y el de
 * «Probar a Sofi» no abre ninguna.
 */
import { randomUUID } from "node:crypto"
import { conversation, customer, store, storeMember } from "@gestoria/db"
import { startTestDb, type TestDb } from "@gestoria/db/testing"
import { eq } from "drizzle-orm"
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { SOFI_ACTOR, withAgent } from "./agente.js"
import { createApp } from "./app.js"
import { createOrderIn, orderInput } from "./pedidos.js"

const ACCOUNT = "https://api.gestoria.test"
const WEB = "https://app.gestoria.test"
const SERVER = "https://servidor.gestoria.test"

let db: TestDb
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"]
let app: ReturnType<typeof createApp>

const people = {
  rosa: { id: "u-rosa", email: "rosa@calzados.test", name: "Rosa Quispe" },
  lucia: { id: "u-lucia", email: "lucia@calzados.test", name: "Lucía Torres" },
  ajena: { id: "u-ajena", email: "ajena@otra.test", name: "Ajena" },
}
type Who = keyof typeof people
const storeId = randomUUID()
const otherStore = randomUUID()
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

// biome-ignore lint/suspicious/noExplicitAny: las pruebas leen respuestas JSON de forma libre
type Json = Record<string, any>

async function call(who: Who, method: string, path: string, body?: unknown) {
  const response = await app.request(`${SERVER}${path}`, {
    method,
    headers: {
      origin: WEB,
      authorization: `Bearer ${await tokenFor(who)}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  const json = (response.headers.get("content-type") ?? "").includes("json") && text
  return { status: response.status, json: (json ? JSON.parse(text) : {}) as Json }
}

const ids = { yape: "", reparto: "", t38: "", t39: "" }

const order = (over: Json = {}) => ({
  customerName: "Mariela Ríos",
  customerPhone: "+51 987 654 321",
  channel: "whatsapp",
  address: "Shalom Arequipa, agencia Av. Ejército",
  lines: [{ variantId: ids.t38, quantity: 1 }],
  deliveryMethodId: ids.reparto,
  paymentMethodId: ids.yape,
  ...over,
})

async function anotar(who: Who, over: Json = {}) {
  const created = await call(who, "POST", `${base}/pedidos`, order(over))
  expect(created.status).toBe(201)
  return created.json.order as Json
}

const ficha = async (id: string) =>
  (await call("lucia", "GET", `${base}/clientes/${id}`)).json.customer as Json

beforeAll(async () => {
  db = await startTestDb()
  const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" })
  privateKey = pair.privateKey
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), alg: "EdDSA", kid: "k1" }
  app = createApp({
    appDb: db.appDb,
    ownerDb: db.ownerDb,
    account: { url: ACCOUNT, eventsSecret: "", keys: createLocalJWKSet({ keys: [jwk] }) },
    webURL: WEB,
  })
  for (const who of Object.keys(people) as Who[]) await call(who, "GET", "/api/yo")
  await db.ownerDb.insert(store).values([
    { id: storeId, name: "Calzados Rosa", currency: "PEN", createdBy: "u-rosa" },
    { id: otherStore, name: "Otra tienda", currency: "PEN", createdBy: "u-ajena" },
  ])
  await db.ownerDb.insert(storeMember).values([
    { storeId, userId: "u-rosa", role: "owner" },
    { storeId, userId: "u-lucia", role: "sales", addedBy: "u-rosa" },
    { storeId: otherStore, userId: "u-ajena", role: "owner" },
  ])
  ids.yape = (
    await call("rosa", "POST", `${base}/medios-de-pago`, {
      name: "Yape",
      typeCode: "68",
      collection: "comprobante",
    })
  ).json.method.id
  ids.reparto = (
    await call("rosa", "POST", `${base}/formas-de-entrega`, {
      name: "Agencia Shalom",
      type: "ParcelService",
      cost: "fijo",
      priceCents: 1000,
    })
  ).json.method.id
  const zapatilla = await call("rosa", "POST", `${base}/productos`, {
    name: "Zapatilla urbana",
    listPriceCents: 12900,
    options: [{ name: "Talla", values: ["38", "39"] }],
  })
  const variants = (await call("rosa", "GET", `${base}/productos/${zapatilla.json.product.id}`))
    .json.product.variants as Json[]
  ids.t38 = variants.find((v) => v.optionValues[0] === "38")!.id
  ids.t39 = variants.find((v) => v.optionValues[0] === "39")!.id
  for (const variantId of [ids.t38, ids.t39])
    await call("rosa", "POST", `${base}/variantes/${variantId}/movimientos`, {
      kind: "entrada",
      quantity: 20,
    })
}, 120_000)

afterAll(async () => {
  await db?.stop()
})

let mariela = ""
let otraMariela = ""

describe("cada pedido, con la ficha de su clienta", () => {
  it("anotar un pedido abre su ficha, con su nombre, su teléfono y la compra", async () => {
    const created = await anotar("lucia")
    expect(created.customerId).toBeTruthy()
    mariela = created.customerId
    const list = await call("lucia", "GET", `${base}/clientes`)
    expect(list.status).toBe(200)
    expect(list.json.customers).toMatchObject([
      { id: mariela, name: "Mariela Ríos", phones: ["+51 987 654 321"], purchases: 1 },
    ])
    expect(list.json.customers[0].channels).toEqual(["whatsapp"])
  })

  it("con la ficha elegida, el pedido copia su nombre y no abre otra", async () => {
    const again = await anotar("lucia", {
      customerId: mariela,
      customerName: "",
      customerPhone: "",
      channel: "instagram",
      lines: [{ variantId: ids.t39, quantity: 1 }],
    })
    expect(again).toMatchObject({
      customerId: mariela,
      customerName: "Mariela Ríos",
      customerPhone: "+51 987 654 321",
    })
    const list = await call("lucia", "GET", `${base}/clientes`)
    expect(list.json.customers).toHaveLength(1)
    const detail = await ficha(mariela)
    expect(detail.purchases).toBe(2)
    expect(detail.channels.sort()).toEqual(["instagram", "whatsapp"])
    expect(detail.orders.map((o: Json) => o.number)).toEqual(["0002", "0001"])
  })

  it("sin ficha ni nombre se pide el nombre; una ficha que no existe no se usa", async () => {
    const missing = await call("lucia", "POST", `${base}/pedidos`, order({ customerName: "" }))
    expect(missing.status).toBe(400)
    expect(missing.json.error.fields).toHaveProperty("customerName")
    const unknown = await call(
      "lucia",
      "POST",
      `${base}/pedidos`,
      order({ customerId: randomUUID() }),
    )
    expect(unknown.status).toBe(400)
    expect(unknown.json.error.fields).toHaveProperty("customerId")
  })

  it("el mismo teléfono no une: abre otra ficha y la sugiere para que lo decida una persona", async () => {
    const created = await anotar("lucia", {
      customerName: "Mari R.",
      customerPhone: "987654321",
      channel: "messenger",
    })
    otraMariela = created.customerId
    expect(otraMariela).not.toBe(mariela)
    const similar = await call("lucia", "GET", `${base}/clientes/parecidas`)
    expect(similar.json.pairs).toMatchObject([
      { reason: "telefono", a: { id: mariela }, b: { id: otraMariela, name: "Mari R." } },
    ])
    expect((await call("lucia", "GET", `${base}/clientes`)).json.similar).toBe(1)
    expect((await ficha(mariela)).similar).toMatchObject([{ id: otraMariela }])
  })

  it("busca por el nombre sin tildes o por el teléfono", async () => {
    const byName = await call("lucia", "GET", `${base}/clientes?buscar=rios`)
    expect(byName.json.customers.map((c: Json) => c.id)).toEqual([mariela])
    const byPhone = await call("lucia", "GET", `${base}/clientes?buscar=654%20321`)
    expect(byPhone.json.customers.map((c: Json) => c.id).sort()).toEqual(
      [mariela, otraMariela].sort(),
    )
  })
})

describe("¿Es la misma clienta?", () => {
  it("«Sí, es la misma»: la más nueva queda dentro de la más antigua y la ficha junta todo", async () => {
    const merged = await call("lucia", "POST", `${base}/clientes/unir`, {
      a: otraMariela,
      b: mariela,
    })
    expect(merged.status).toBe(200)
    expect(merged.json.id).toBe(mariela)
    const detail = await ficha(otraMariela)
    // Pedir la ficha de dentro devuelve la que se ve.
    expect(detail.id).toBe(mariela)
    expect(detail.purchases).toBe(3)
    expect(detail.phones).toEqual(["+51 987 654 321", "987654321"])
    expect(detail.members).toMatchObject([{ id: otraMariela, channels: ["messenger"] }])
    expect(detail.history).toMatchObject([
      {
        action: "unida",
        actorName: "Lucía Torres",
        self: false,
        with: { id: otraMariela },
        separates: otraMariela,
      },
    ])
    expect(detail.similar).toEqual([])
    expect((await call("lucia", "GET", `${base}/clientes`)).json.customers).toHaveLength(1)
    // El pedido de la ficha de dentro lleva a la que se ve.
    const list = await call("lucia", "GET", `${base}/pedidos`)
    const third = list.json.orders.find((o: Json) => o.number === "0003")
    const opened = await call("lucia", "GET", `${base}/pedidos/${third.id}`)
    expect(opened.json.order.customerId).toBe(mariela)
    // Ya son la misma: no se une otra vez.
    const twice = await call("lucia", "POST", `${base}/clientes/unir`, {
      a: mariela,
      b: otraMariela,
    })
    expect(twice.status).toBe(409)
  })

  it("«Separar» la deja sola con sus pedidos y no se vuelve a sugerir", async () => {
    const separated = await call("lucia", "POST", `${base}/clientes/${otraMariela}/separar`)
    expect(separated.status).toBe(200)
    expect((await ficha(mariela)).purchases).toBe(2)
    const alone = await ficha(otraMariela)
    expect(alone).toMatchObject({ id: otraMariela, purchases: 1, members: [] })
    expect(alone.history[0]).toMatchObject({
      action: "separada",
      self: true,
      with: { id: mariela },
    })
    expect((await call("lucia", "GET", `${base}/clientes/parecidas`)).json.pairs).toEqual([])
    const again = await call("lucia", "POST", `${base}/clientes/${otraMariela}/separar`)
    expect(again.status).toBe(409)
  })

  it("«No, son distintas»: queda dicho y no se vuelve a preguntar", async () => {
    const homonima = (await anotar("lucia", { customerPhone: "" })).customerId
    expect((await call("lucia", "GET", `${base}/clientes/parecidas`)).json.pairs).toMatchObject([
      { reason: "nombre", a: { id: mariela }, b: { id: homonima } },
    ])
    const distinct = await call("lucia", "POST", `${base}/clientes/distintas`, {
      a: mariela,
      b: homonima,
    })
    expect(distinct.status).toBe(204)
    expect((await call("lucia", "GET", `${base}/clientes/parecidas`)).json.pairs).toEqual([])
    expect((await ficha(homonima)).history[0]).toMatchObject({
      action: "distintas",
      with: { id: mariela },
    })
  })
})

describe("la ficha", () => {
  it("«Repetir pedido» trae lo de su última compra, para anotarlo con el precio de hoy", async () => {
    const detail = await ficha(mariela)
    expect(detail.repeat).toMatchObject({
      number: "0002",
      channel: "instagram",
      lines: [{ variantId: ids.t39, quantity: 1, productName: "Zapatilla urbana" }],
      deliveryMethodId: ids.reparto,
      paymentMethodId: ids.yape,
      address: "Shalom Arequipa, agencia Av. Ejército",
    })
    expect(detail.addresses).toMatchObject([{ address: "Shalom Arequipa, agencia Av. Ejército" }])
  })

  it("«Lo que sabemos» guarda quién lo escribió; corregir el nombre no cambia los pedidos", async () => {
    const saved = await call("lucia", "PATCH", `${base}/clientes/${mariela}`, {
      note: "Talla 38. Prefiere Shalom y paga el envío en destino.",
      name: "Mariela Ríos Vargas",
    })
    expect(saved.status).toBe(200)
    const detail = await ficha(mariela)
    expect(detail).toMatchObject({
      name: "Mariela Ríos Vargas",
      note: "Talla 38. Prefiere Shalom y paga el envío en destino.",
      noteByName: "Lucía Torres",
    })
    const first = detail.orders.find((o: Json) => o.number === "0001")
    const opened = await call("lucia", "GET", `${base}/pedidos/${first.id}`)
    expect(opened.json.order.customerName).toBe("Mariela Ríos")
  })

  it("un pedido anulado no cuenta como compra", async () => {
    const extra = await anotar("lucia", { customerId: mariela })
    expect((await ficha(mariela)).purchases).toBe(3)
    await call("rosa", "POST", `${base}/pedidos/${extra.id}/anular`, { reason: "Se arrepintió" })
    expect((await ficha(mariela)).purchases).toBe(2)
  })
})

describe("quién ve las fichas", () => {
  it("Ventas ve y decide; quien no es del equipo no ve ni toca nada", async () => {
    expect((await call("lucia", "GET", `${base}/clientes`)).status).toBe(200)
    expect((await call("ajena", "GET", `${base}/clientes`)).status).toBe(404)
    expect((await call("ajena", "GET", `${base}/clientes/${mariela}`)).status).toBe(404)
    expect(
      (await call("ajena", "PATCH", `${base}/clientes/${mariela}`, { name: "Otra" })).status,
    ).toBe(404)
    // Desde su tienda, la ficha de otra no existe.
    const fromOther = await call("ajena", "GET", `/api/tiendas/${otherStore}/clientes/${mariela}`)
    expect(fromOther.status).toBe(404)
    expect(
      (
        await call("ajena", "POST", `/api/tiendas/${otherStore}/clientes/unir`, {
          a: mariela,
          b: otraMariela,
        })
      ).status,
    ).toBe(404)
  })
})

describe("Sofi", () => {
  const input = () =>
    orderInput.parse({
      customerName: "Valeria Soto",
      channel: "whatsapp",
      lines: [{ variantId: ids.t38, quantity: 1 }],
      deliveryMethodId: ids.reparto,
      paymentMethodId: ids.yape,
    })

  it("en un chat, el pedido que vuelve a anotar es de la misma ficha", async () => {
    const [chat] = await db.ownerDb
      .insert(conversation)
      .values({ storeId, channel: "whatsapp", customerName: "Valeria", createdBy: "canal" })
      .returning({ id: conversation.id })
    const first = await withAgent(db.appDb, SOFI_ACTOR, storeId, (tx) =>
      createOrderIn(tx, storeId, SOFI_ACTOR, input(), { conversationId: chat!.id }),
    )
    const second = await withAgent(db.appDb, SOFI_ACTOR, storeId, (tx) =>
      createOrderIn(tx, storeId, SOFI_ACTOR, input(), { conversationId: chat!.id }),
    )
    const [a, b] = await Promise.all(
      [first.id, second.id].map(
        async (id) => (await call("lucia", "GET", `${base}/pedidos/${id}`)).json.order.customerId,
      ),
    )
    expect(a).toBeTruthy()
    expect(b).toBe(a)
    const [row] = await db.ownerDb.select().from(customer).where(eq(customer.id, a))
    expect(row?.createdBy).toBe(SOFI_ACTOR)
  })

  it("un pedido de «Probar a Sofi» no abre ficha", async () => {
    const before = (await db.ownerDb.select().from(customer)).length
    const created = await withAgent(db.appDb, SOFI_ACTOR, storeId, (tx) =>
      createOrderIn(tx, storeId, SOFI_ACTOR, input(), { test: true }),
    )
    expect(
      (await call("lucia", "GET", `${base}/pedidos/${created.id}`)).json.order.customerId,
    ).toBe(null)
    expect((await db.ownerDb.select().from(customer)).length).toBe(before)
  })
})

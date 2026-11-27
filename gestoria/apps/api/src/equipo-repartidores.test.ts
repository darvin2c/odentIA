/**
 * Equipo y repartidores (lienzo «gestorIA · Configuración, de nuevo», tablero 9; ADR 0235), contra
 * una base real y un token firmado como el de la cuenta: la invitación con nombre y celular que se
 * envía por WhatsApp (queda «enviada», nunca entregada), y los repartidores con su pago por entrega,
 * que solo ven y cambian el Dueño y el Administrador. «Sacar» deja sin repartidor lo que no salió.
 */
import { randomUUID } from "node:crypto"
import { store, storeMember } from "@gestoria/db"
import { startTestDb, type TestDb } from "@gestoria/db/testing"
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createApp } from "./app.js"
import { dayIn } from "./hora.js"

const ACCOUNT = "https://api.gestoria.test"
const WEB = "https://app.gestoria.test"
const SERVER = "https://servidor.gestoria.test"

let db: TestDb
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"]
let app: ReturnType<typeof createApp>

const people = {
  rosa: { id: "u-rosa", email: "rosa@calzados.test", name: "Rosa Quispe" },
  lucia: { id: "u-lucia", email: "lucia@calzados.test", name: "Lucía Torres" },
  mario: { id: "u-mario", email: "mario@calzados.test", name: "Mario Huamán" },
}
type Who = keyof typeof people
const storeId = randomUUID()
const base = `/api/tiendas/${storeId}`
const today = dayIn("America/Lima")

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
  return { status: response.status, json: (text ? JSON.parse(text) : {}) as Json }
}

const ids = { efectivo: "", reparto: "", t38: "" }

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
  await db.ownerDb
    .insert(store)
    .values({ id: storeId, name: "Calzados Rosa", currency: "PEN", createdBy: "u-rosa" })
  await db.ownerDb.insert(storeMember).values([
    { storeId, userId: "u-rosa", role: "owner" },
    { storeId, userId: "u-mario", role: "admin", addedBy: "u-rosa" },
    { storeId, userId: "u-lucia", role: "sales", addedBy: "u-rosa" },
  ])
  ids.efectivo = (
    await call("rosa", "POST", `${base}/medios-de-pago`, {
      name: "Efectivo",
      typeCode: "10",
      collection: "al_recibir",
    })
  ).json.method.id
  ids.reparto = (
    await call("rosa", "POST", `${base}/formas-de-entrega`, {
      name: "Reparto en Lima",
      type: "DeliveryModeOwnFleet",
      cost: "fijo",
      priceCents: 1000,
      acceptsPayOnDelivery: true,
    })
  ).json.method.id
  const zapatilla = await call("rosa", "POST", `${base}/productos`, {
    name: "Zapatilla urbana",
    listPriceCents: 19400,
    options: [{ name: "Talla", values: ["38"] }],
  })
  ids.t38 = (
    await call("rosa", "GET", `${base}/productos/${zapatilla.json.product.id}`)
  ).json.product.variants[0].id
  await call("rosa", "POST", `${base}/variantes/${ids.t38}/movimientos`, {
    kind: "entrada",
    quantity: 30,
  })
}, 120_000)

afterAll(async () => {
  await db?.stop()
})

const newOrder = async (name: string) =>
  (
    await call("lucia", "POST", `${base}/pedidos`, {
      customerName: name,
      customerPhone: "+51 987 654 321",
      channel: "whatsapp",
      address: "Av. Sáenz Peña 820, Callao",
      lines: [{ variantId: ids.t38, quantity: 1 }],
      deliveryMethodId: ids.reparto,
      paymentMethodId: ids.efectivo,
      deliverOn: today,
    })
  ).json.order

describe("la invitación por WhatsApp", () => {
  it("lleva nombre y celular, y «Enviar por WhatsApp» deja solo que se envió", async () => {
    const bad = await call("rosa", "POST", `${base}/invitaciones`, {
      email: "carla@gmail.test",
      role: "sales",
      name: "Carla Vega",
      phone: "912345678",
    })
    expect(bad.status).toBe(400)
    const made = await call("rosa", "POST", `${base}/invitaciones`, {
      email: "carla@gmail.test",
      role: "sales",
      name: "  Carla   Vega ",
      phone: "+51912345678",
    })
    expect(made.status).toBe(201)
    expect(made.json.invitation).toMatchObject({ name: "Carla Vega", phone: "+51912345678" })
    const id = made.json.invitation.id
    let team = (await call("mario", "GET", `${base}/equipo`)).json
    expect(team.invitations[0]).toMatchObject({ id, name: "Carla Vega", sharedAt: null })

    // Ventas no manda invitaciones; el Administrador sí.
    expect((await call("lucia", "POST", `${base}/invitaciones/${id}/enviada`)).status).toBe(403)
    expect((await call("mario", "POST", `${base}/invitaciones/${id}/enviada`)).status).toBe(200)
    team = (await call("rosa", "GET", `${base}/equipo`)).json
    expect(team.invitations[0].sharedAt).not.toBeNull()

    // Una anulada ya no se envía.
    await call("rosa", "DELETE", `${base}/invitaciones/${id}`)
    expect((await call("rosa", "POST", `${base}/invitaciones/${id}/enviada`)).status).toBe(404)
  })

  it("el Administrador no envía la invitación de un Dueño", async () => {
    const made = await call("rosa", "POST", `${base}/invitaciones`, {
      email: "socia@gmail.test",
      role: "owner",
    })
    const id = made.json.invitation.id
    expect((await call("mario", "POST", `${base}/invitaciones/${id}/enviada`)).status).toBe(403)
  })
})

describe("los repartidores y su pago por entrega", () => {
  let kevin = ""

  it("solo el Dueño y el Administrador los ven, con lo que se les paga", async () => {
    expect((await call("lucia", "GET", `${base}/repartidores`)).status).toBe(403)
    const added = await call("mario", "POST", `${base}/repartidores`, {
      name: " Kevin   Ramos ",
      phone: "+51955101202",
      payCents: 800,
      failedTripPaid: false,
    })
    expect(added.status).toBe(201)
    expect(added.json.courier).toMatchObject({
      name: "Kevin Ramos",
      team: false,
      payCents: 800,
      failedTripPaid: false,
    })
    kevin = added.json.courier.id
    const list = (await call("rosa", "GET", `${base}/repartidores`)).json
    expect(list.couriers.map((c: Json) => c.name)).toEqual(["Kevin Ramos"])
    // Ventas lo elige en Despachos, sin ver lo que se le paga.
    const config = (await call("lucia", "GET", `${base}/despachos?dia=${today}`)).json
    const seen = config.couriers.find((c: Json) => c.id === kevin)
    expect(seen).toBeDefined()
    expect(seen.payCents).toBeUndefined()
  })

  it("un nombre repetido se dice, y un monto negativo no vale", async () => {
    const twice = await call("rosa", "POST", `${base}/repartidores`, {
      name: "kevin ramos",
      phone: null,
      payCents: null,
      failedTripPaid: true,
    })
    expect(twice.status).toBe(409)
    const negative = await call("rosa", "PATCH", `${base}/repartidores/${kevin}`, { payCents: -1 })
    expect(negative.status).toBe(400)
    const changed = await call("rosa", "PATCH", `${base}/repartidores/${kevin}`, { payCents: 900 })
    expect(changed.json.courier).toMatchObject({ payCents: 900, phone: "+51955101202" })
  })

  it("«Sacar» deja sin repartidor lo que no salió, y vuelve el mismo si se suma otra vez", async () => {
    const order = await newOrder("Jorge Paredes")
    const assigned = await call("lucia", "POST", `${base}/pedidos/${order.id}/repartidor`, {
      courier: { courierId: kevin },
    })
    expect(assigned.json.order.courierName).toBe("Kevin Ramos")
    expect((await call("lucia", "DELETE", `${base}/repartidores/${kevin}`)).status).toBe(403)
    const removed = await call("rosa", "DELETE", `${base}/repartidores/${kevin}`)
    expect(removed.json).toEqual({ unassigned: 1 })
    const after = (await call("lucia", "GET", `${base}/pedidos/${order.id}`)).json.order
    expect(after.courierName).toBeNull()
    expect((await call("rosa", "GET", `${base}/repartidores`)).json.couriers).toEqual([])

    const back = await call("rosa", "POST", `${base}/repartidores`, {
      name: "Kevin Ramos",
      phone: null,
      payCents: 800,
      failedTripPaid: true,
    })
    expect(back.json.courier.id).toBe(kevin)
  })

  it("alguien del equipo que reparte solo cambia su pago, y no se saca de aquí", async () => {
    const order = await newOrder("Diana Flores")
    await call("lucia", "POST", `${base}/pedidos/${order.id}/repartidor`, {
      courier: { userId: "u-lucia" },
    })
    const lucia = (await call("rosa", "GET", `${base}/repartidores`)).json.couriers.find(
      (c: Json) => c.team,
    )
    expect(lucia).toMatchObject({ name: "Lucía Torres", userId: "u-lucia", payCents: null })
    expect(
      (await call("rosa", "PATCH", `${base}/repartidores/${lucia.id}`, { name: "Lu" })).status,
    ).toBe(400)
    expect(
      (await call("rosa", "PATCH", `${base}/repartidores/${lucia.id}`, { payCents: 500 })).json
        .courier.payCents,
    ).toBe(500)
    expect((await call("rosa", "DELETE", `${base}/repartidores/${lucia.id}`)).status).toBe(409)
  })
})

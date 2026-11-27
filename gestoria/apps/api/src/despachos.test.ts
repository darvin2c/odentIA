/**
 * Despachos y Caja (entrega 3 del lienzo «gestorIA como odentIA», tableros 6, 17, 23 y 24), contra
 * una base real y un token firmado como el de la cuenta: las entregas de cada día con su franja y
 * su repartidor, «No se entregó» primero, la agencia, que sin pago confirmado no se entrega, el
 * efectivo a nombre de quien lo llevó y «Recibí», con las mismas cifras en Despachos, Caja y
 * Reportes.
 */
import { randomUUID } from "node:crypto"
import { store, storeMember } from "@gestoria/db"
import { startTestDb, type TestDb } from "@gestoria/db/testing"
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createApp } from "./app.js"
import { addDays, dayIn } from "./hora.js"

const ACCOUNT = "https://api.gestoria.test"
const WEB = "https://app.gestoria.test"
const SERVER = "https://servidor.gestoria.test"

let db: TestDb
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"]
let app: ReturnType<typeof createApp>

const people = {
  rosa: { id: "u-rosa", email: "rosa@calzados.test", name: "Rosa Quispe" },
  lucia: { id: "u-lucia", email: "lucia@calzados.test", name: "Lucía Torres" },
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

const ids = { yape: "", efectivo: "", pos: "", reparto: "", agencia: "", t38: "" }

const order = (over: Json = {}) => ({
  customerName: "Jorge Paredes",
  customerPhone: "+51 987 654 321",
  channel: "whatsapp",
  address: "Av. Sáenz Peña 820, Callao",
  lines: [{ variantId: ids.t38, quantity: 1 }],
  deliveryMethodId: ids.reparto,
  paymentMethodId: ids.efectivo,
  deliverOn: today,
  ...over,
})

const MORNING = { start: 540, end: 780 }
const EVENING = { start: 1080, end: 1260 }

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
    { storeId, userId: "u-lucia", role: "sales", addedBy: "u-rosa" },
  ])
  const pay = async (body: Json) =>
    (await call("rosa", "POST", `${base}/medios-de-pago`, body)).json.method.id as string
  ids.yape = await pay({ name: "Yape", typeCode: "68", collection: "comprobante" })
  ids.efectivo = await pay({ name: "Efectivo", typeCode: "10", collection: "al_recibir" })
  ids.pos = await pay({ name: "Tarjeta con POS", typeCode: "48", collection: "al_recibir" })
  const deliver = async (body: Json) =>
    (await call("rosa", "POST", `${base}/formas-de-entrega`, body)).json.method.id as string
  ids.reparto = await deliver({
    name: "Reparto en Lima",
    type: "DeliveryModeOwnFleet",
    cost: "fijo",
    priceCents: 1000,
    acceptsPayOnDelivery: true,
  })
  ids.agencia = await deliver({ name: "Envío a provincia", type: "ParcelService", cost: "gratis" })
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

const board = async (day = today, who: Who = "lucia") =>
  (await call(who, "GET", `${base}/despachos?dia=${day}`)).json

describe("las franjas (Configuración › Formas de entrega y zonas)", () => {
  it("son opcionales, las cambia quien cambia la configuración y salen en orden", async () => {
    expect((await call("lucia", "PATCH", `${base}/franjas`, { slots: [MORNING] })).status).toBe(403)
    const saved = await call("rosa", "PATCH", `${base}/franjas`, { slots: [EVENING, MORNING] })
    expect(saved.json.slots).toEqual([MORNING, EVENING])
    const config = await call("lucia", "GET", `${base}/pagos-y-entregas`)
    expect(config.json.slots.map((s: Json) => s.label)).toEqual(["9–13 h", "18–21 h"])
  })
})

describe("Despachos", () => {
  let jorge = ""
  let kevin = ""

  it("un pedido sin franja ni repartidor sale igual, en «Sin franja»", async () => {
    jorge = (await call("lucia", "POST", `${base}/pedidos`, order())).json.order.id
    const view = await board()
    const row = (view.deliveries as Json[]).find((d) => d.id === jorge)
    expect(row).toMatchObject({ slot: null, courierName: null, missed: null })
    expect(row?.balance.dueCents).toBe(20400)
    expect(view.days).toHaveLength(7)
  })

  it("«Pasar a…» con franja y un repartidor externo escrito ahí mismo", async () => {
    const wrongSlot = await call("lucia", "POST", `${base}/pedidos/${jorge}/pasar-a`, {
      deliverOn: today,
      slot: { start: 600, end: 700 },
    })
    expect(wrongSlot.status).toBe(400)
    expect(wrongSlot.json.error.fields).toHaveProperty("slot")
    const moved = await call("lucia", "POST", `${base}/pedidos/${jorge}/pasar-a`, {
      deliverOn: today,
      slot: MORNING,
      courier: { name: "Kevin" },
    })
    expect(moved.status).toBe(200)
    expect(moved.json.order).toMatchObject({ courierName: "Kevin", slot: { label: "9–13 h" } })
    const again = await call("lucia", "POST", `${base}/pedidos/${jorge}/pasar-a`, {
      deliverOn: today,
      slot: MORNING,
      courier: { name: " kevin " },
    })
    // El mismo nombre es el mismo repartidor: nada cambió.
    expect(again.status).toBe(409)
    kevin = (await board()).couriers.find((c: Json) => c.name === "Kevin").id
    expect(kevin).toBeTruthy()
  })

  it("«No se entregó» va primero, con su motivo y lo que hay que cobrar", async () => {
    await call("lucia", "POST", `${base}/pedidos/${jorge}/salio`, {})
    const missed = await call("lucia", "POST", `${base}/pedidos/${jorge}/no-se-entrego`, {
      reason: "No contestó",
      deliverOn: today,
      slot: EVENING,
    })
    expect(missed.json.order).toMatchObject({ state: "por_salir", courierName: "Kevin" })
    const row = ((await board()).deliveries as Json[]).find((d) => d.id === jorge)
    expect(row?.missed).toMatchObject({ reason: "No contestó", resolved: false })
    expect(row?.slot.label).toBe("18–21 h")
    expect((await call("lucia", "GET", `${base}/despachos/resumen`)).json.missed).toBe(1)
    const tomorrow = await board(addDays(today, 1))
    expect((tomorrow.deliveries as Json[]).some((d) => d.id === jorge)).toBe(false)
  })

  it("por agencia: con cuál va al salir y su número después; la agencia es solo de ese envío", async () => {
    const mariela = (
      await call(
        "lucia",
        "POST",
        `${base}/pedidos`,
        order({
          customerName: "Mariela Ríos",
          deliveryMethodId: ids.agencia,
          paymentMethodId: ids.yape,
        }),
      )
    ).json.order
    const receipt = new FormData()
    receipt.set("amountCents", String(mariela.totalCents))
    const captured = await app.request(`${SERVER}${base}/pedidos/${mariela.id}/comprobante`, {
      method: "POST",
      headers: { origin: WEB, authorization: `Bearer ${await tokenFor("lucia")}` },
      body: receipt,
    })
    const payment = ((await captured.json()) as Json).order.payments[0].id
    await call("rosa", "POST", `${base}/pedidos/${mariela.id}/pagos/${payment}/revision`, {
      decision: "confirmar",
    })
    const out = await call("lucia", "POST", `${base}/pedidos/${mariela.id}/salio`, {
      agency: "Shalom",
    })
    expect(out.json.order).toMatchObject({ state: "en_camino", agency: "Shalom", tracking: null })
    const later = await call("lucia", "POST", `${base}/pedidos/${mariela.id}/envio`, {
      tracking: "77812",
    })
    expect(later.json.order).toMatchObject({ agency: "Shalom", tracking: "77812" })
    const notice = (out.json.order.events as Json[]).filter((e) => e.action === "aviso").at(-1)
    expect(String(notice?.detail.texto)).toContain("va en camino por Shalom")
    const notParcel = await call("lucia", "POST", `${base}/pedidos/${jorge}/envio`, {
      agency: "Olva",
    })
    expect(notParcel.status).toBe(400)
  })

  it("«Avisar» queda como enviado por usted, nunca como entregado", async () => {
    const sent = await call("lucia", "POST", `${base}/pedidos/${jorge}/avisado`, {
      text: "Hola Jorge, tu pedido sale hoy entre 18 y 21 h.",
    })
    const event = (sent.json.order.events as Json[]).at(-1)
    expect(event).toMatchObject({ action: "aviso" })
    expect(event?.detail).toMatchObject({ porUsted: true, enviado: false })
  })

  it("sin pago confirmado no se entrega: una captura por confirmar frena «Entregado»", async () => {
    const ana = (
      await call("lucia", "POST", `${base}/pedidos`, order({ customerName: "Ana Torres" }))
    ).json.order
    const receipt = new FormData()
    receipt.set("amountCents", String(ana.totalCents))
    receipt.set("methodId", ids.yape)
    await app.request(`${SERVER}${base}/pedidos/${ana.id}/comprobante`, {
      method: "POST",
      headers: { origin: WEB, authorization: `Bearer ${await tokenFor("lucia")}` },
      body: receipt,
    })
    const blocked = await call("lucia", "POST", `${base}/pedidos/${ana.id}/entregado`, {})
    expect(blocked.status).toBe(409)
    expect(blocked.json.error.code).toBe("PAYMENT_PENDING")
  })

  it("se cobra en partes con cada medio; lo cobrado queda a nombre de quien lo llevó", async () => {
    const done = await call("rosa", "POST", `${base}/pedidos/${jorge}/entregado`, {
      payments: [
        { methodId: ids.efectivo, amountCents: 15000 },
        { methodId: ids.pos, amountCents: 5400 },
      ],
    })
    expect(done.status).toBe(200)
    expect(done.json.order).toMatchObject({ state: "entregado", paid: true })
    expect((done.json.order.payments as Json[]).map((p) => [p.methodName, p.amountCents])).toEqual([
      ["Efectivo", 15000],
      ["Tarjeta con POS", 5400],
    ])
  })
})

describe("Caja", () => {
  it("la ven el Dueño y el Administrador", async () => {
    expect((await call("lucia", "GET", `${base}/caja`)).status).toBe(403)
  })

  it("el efectivo de Kevin, aunque lo anotó Rosa; lo cobrado es lo mismo que dice Reportes", async () => {
    const cash = (await call("rosa", "GET", `${base}/caja`)).json
    const kevin = (cash.toReceive as Json[]).find((g) => g.name === "Kevin")
    expect(kevin?.cents).toBe(15000)
    const report = (await call("rosa", "GET", `${base}/reportes?periodo=hoy`)).json
    expect(cash.collected.cents).toBe(report.sold.cents)
    // Lo que falta cobrar en las entregas de hoy es la suma de «Cobrar» de Despachos.
    const due = ((await board(today, "rosa")).deliveries as Json[])
      .filter((d) => d.state === "por_salir" || d.state === "en_camino")
      .reduce((total, d) => total + d.balance.dueCents, 0)
    expect(cash.due.cents).toBe(due)
  })

  it("«Recibí» con lo que cuadra o la diferencia escrita, una sola vez", async () => {
    const cash = (await call("rosa", "GET", `${base}/caja`)).json
    const kevin = (cash.toReceive as Json[]).find((g) => g.name === "Kevin")!
    const body = {
      courierId: kevin.courierId,
      paymentIds: kevin.payments.map((p: Json) => p.id),
      receivedCents: 14000,
    }
    const noNote = await call("rosa", "POST", `${base}/caja/recibi`, body)
    expect(noNote.status).toBe(400)
    expect(noNote.json.error.fields).toHaveProperty("note")
    const ok = await call("rosa", "POST", `${base}/caja/recibi`, {
      ...body,
      note: "Faltaron S/ 10 del vuelto",
    })
    expect(ok.status).toBe(201)
    expect(ok.json.handover).toMatchObject({ expectedCents: 15000, differenceCents: -1000 })
    const twice = await call("rosa", "POST", `${base}/caja/recibi`, {
      ...body,
      receivedCents: 15000,
    })
    expect(twice.status).toBe(409)
    const after = (await call("rosa", "GET", `${base}/caja`)).json
    expect((after.toReceive as Json[]).some((g) => g.name === "Kevin")).toBe(false)
    expect(after.received[0]).toMatchObject({ courierName: "Kevin", receivedByName: "Rosa Quispe" })
  })
})

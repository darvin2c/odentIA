/**
 * Inicio (lienzo «gestorIA como odentIA», tablero 5) contra una base real: las cuatro cifras del
 * día salen de la misma cuenta que Reportes, del saldo único; «Te toca» trae a cada rol lo que
 * puede resolver, y Ventas ve cuántos pagos esperan, sin los montos. Los primeros pasos (tablero
 * 16) se marcan solos con lo guardado y, cuando no falta ninguno, la lista no vuelve.
 */
import { randomUUID } from "node:crypto"
import { saleOrder, store, storeMember } from "@gestoria/db"
import { startTestDb, type TestDb } from "@gestoria/db/testing"
import { eq, sql } from "drizzle-orm"
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

async function call(who: Who, method: string, path: string, body?: unknown, form?: FormData) {
  const response = await app.request(`${SERVER}${path}`, {
    method,
    headers: {
      origin: WEB,
      authorization: `Bearer ${await tokenFor(who)}`,
      ...(form || body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(form ? { body: form } : body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  const json = (response.headers.get("content-type") ?? "").includes("json") && text
  return { status: response.status, json: (json ? JSON.parse(text) : {}) as Json }
}

const ids = { yape: "", efectivo: "", reparto: "", t38: "" }

const order = (over: Json = {}) => ({
  customerName: "Carla Mendoza",
  customerPhone: "+51 987 654 321",
  channel: "whatsapp",
  address: "Av. Primavera 123, Surco",
  lines: [{ variantId: ids.t38, quantity: 1 }],
  deliveryMethodId: ids.reparto,
  paymentMethodId: ids.yape,
  deliverOn: today,
  ...over,
})

async function sendReceipt(orderId: string, cents: number) {
  const form = new FormData()
  form.set("amountCents", String(cents))
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
  form.set("captura", new File([png], "captura.png", { type: "image/png" }))
  const sent = await call(
    "lucia",
    "POST",
    `${base}/pedidos/${orderId}/comprobante`,
    undefined,
    form,
  )
  return (sent.json.order.payments as Json[]).find((p) => p.status === "por_confirmar")
}

const home = async (who: Who) => (await call(who, "GET", `${base}/inicio`)).json

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
}, 120_000)

afterAll(async () => {
  await db?.stop()
})

describe("los primeros pasos se marcan con lo guardado (tablero 16)", () => {
  const states = (json: Json) =>
    Object.fromEntries((json.setup.steps as Json[]).map((s) => [s.step, s.state]))

  it("una tienda que empieza: falta todo menos el equipo, y cada apartado marca el suyo", async () => {
    expect(states(await home("rosa"))).toEqual({
      datos: "falta",
      catalogo: "falta",
      pagos: "falta",
      entregas: "falta",
      chats: "pronto",
      sofi: "falta",
      equipo: "hecho",
    })
    expect(
      (
        await call("rosa", "PATCH", `${base}/datos`, {
          name: "Calzados Rosa",
          country: "PE",
          timeZone: "America/Lima",
        })
      ).status,
    ).toBe(200)
    const pay = async (body: Json) =>
      (await call("rosa", "POST", `${base}/medios-de-pago`, body)).json.method.id as string
    ids.yape = await pay({ name: "Yape", typeCode: "68", collection: "comprobante" })
    ids.efectivo = await pay({ name: "Efectivo", typeCode: "10", collection: "al_recibir" })
    ids.reparto = (
      await call("rosa", "POST", `${base}/formas-de-entrega`, {
        name: "Reparto en Lima",
        type: "DeliveryModeOwnFleet",
        cost: "fijo",
        priceCents: 1000,
        acceptsPayOnDelivery: true,
      })
    ).json.method.id
    // Un producto sin stock todavía no hace el catálogo.
    const zapatilla = await call("rosa", "POST", `${base}/productos`, {
      name: "Zapatilla urbana",
      listPriceCents: 12900,
      options: [{ name: "Talla", values: ["38"] }],
    })
    ids.t38 = (
      await call("rosa", "GET", `${base}/productos/${zapatilla.json.product.id}`)
    ).json.product.variants[0].id
    const half = await home("rosa")
    expect(states(half)).toMatchObject({
      datos: "hecho",
      catalogo: "falta",
      pagos: "hecho",
      entregas: "hecho",
    })
    expect(half.setup.facts).toMatchObject({
      country: "PE",
      payments: ["Yape", "Efectivo"],
      deliveries: ["Reparto en Lima"],
    })
    await call("rosa", "POST", `${base}/variantes/${ids.t38}/movimientos`, {
      kind: "entrada",
      quantity: 10,
    })
    expect(states(await home("rosa"))).toMatchObject({ catalogo: "hecho", sofi: "falta" })
  })

  it("con lo último saltado, la lista queda lista y no vuelve aunque se apague un medio", async () => {
    expect(
      (await call("rosa", "POST", `${base}/primeros-pasos/saltar`, { step: "sofi" })).status,
    ).toBe(200)
    expect((await home("rosa")).setup).toBeNull()
    const [saved] = await db.ownerDb.execute<{
      finished_at: string | null
      updated_by: string | null
    }>(sql`select finished_at, updated_by from store_setup where store_id = ${storeId}`)
    expect(saved?.finished_at).not.toBeNull()
    expect(saved?.updated_by).toBeNull()
    await call("rosa", "PATCH", `${base}/medios-de-pago/${ids.yape}`, { isActive: false })
    expect((await home("rosa")).setup).toBeNull()
    await call("rosa", "PATCH", `${base}/medios-de-pago/${ids.yape}`, { isActive: true })
  })
})

describe("las cifras del día y «Te toca» (tablero 5)", () => {
  let paid = ""
  let waiting = ""

  it("un pago por confirmar: el Dueño lo ve con su monto y fuera de «Falta cobrar»; Ventas, sin montos", async () => {
    paid = (await call("lucia", "POST", `${base}/pedidos`, order())).json.order.id
    await sendReceipt(paid, 13900)
    waiting = (
      await call(
        "lucia",
        "POST",
        `${base}/pedidos`,
        order({ customerName: "Pedro Salas", customerPhone: "+51 912 345 678" }),
      )
    ).json.order.id
    const rosa = await home("rosa")
    expect(rosa.figures).toEqual({
      collected: { cents: 0, payments: 0 },
      toConfirm: { payments: 1, cents: 13900 },
      due: { orders: 1, cents: 13900 },
      leaves: { orders: 0, missed: 0 },
    })
    expect(rosa.toDo).toEqual([
      expect.objectContaining({
        kind: "pago",
        when: "ahora",
        orderId: paid,
        customer: "Carla Mendoza",
        amountCents: 13900,
        method: "Yape",
        byLink: false,
      }),
    ])
    // Reportes cuenta igual: es la misma cuenta.
    const report = (await call("rosa", "GET", `${base}/reportes?periodo=hoy`)).json
    expect(report.pending).toEqual({
      toConfirm: { orders: 1, cents: 13900 },
      due: { orders: 1, cents: 13900 },
    })
    const lucia = await home("lucia")
    expect(lucia.figures).toEqual({
      collected: null,
      toConfirm: { payments: 1, cents: null },
      due: null,
      leaves: { orders: 0, missed: 0 },
    })
    // Ventas confirma pagos: la línea es suya también, y no ve los primeros pasos.
    expect(lucia.toDo.map((i: Json) => i.kind)).toEqual(["pago"])
    expect(lucia.setup).toBeNull()
  })

  it("al confirmarlo, entra en «Cobrado hoy», sale de «Te toca» y cuenta en «Sale hoy»", async () => {
    const payment = (await call("rosa", "GET", `${base}/pedidos/${paid}`)).json.order.payments.find(
      (p: Json) => p.status === "por_confirmar",
    )
    await call("lucia", "POST", `${base}/pedidos/${paid}/pagos/${payment.id}/revision`, {
      decision: "confirmar",
    })
    const rosa = await home("rosa")
    expect(rosa.figures).toEqual({
      collected: { cents: 13900, payments: 1 },
      toConfirm: { payments: 0, cents: 0 },
      due: { orders: 1, cents: 13900 },
      leaves: { orders: 1, missed: 0 },
    })
    expect(rosa.toDo).toEqual([])
    const report = (await call("rosa", "GET", `${base}/reportes?periodo=hoy`)).json
    expect(report.sold).toMatchObject({ cents: 13900, orders: 1 })
  })

  it("lo que no se entregó: «Pasar a…» para quien entrega, y «Sale hoy» lo cuenta aparte", async () => {
    await call("lucia", "POST", `${base}/pedidos/${paid}/salio`, {})
    await call("lucia", "POST", `${base}/pedidos/${paid}/no-se-entrego`, {
      reason: "No contestó",
      deliverOn: today,
    })
    const rosa = await home("rosa")
    expect(rosa.figures.leaves).toEqual({ orders: 0, missed: 1 })
    expect(rosa.toDo).toEqual([
      expect.objectContaining({
        kind: "no_entregado",
        orderId: paid,
        reason: "No contestó",
        deliverOn: today,
      }),
    ])
    expect((await home("lucia")).toDo.map((i: Json) => i.kind)).toEqual(["no_entregado"])
    // Al volver a salir, deja de ser «lo que no se entregó».
    await call("lucia", "POST", `${base}/pedidos/${paid}/salio`, {})
    const after = await home("rosa")
    expect(after.toDo).toEqual([])
    expect(after.figures.leaves).toEqual({ orders: 1, missed: 0 })
  })

  it("«Sale hoy» cuenta lo mismo que Despachos hoy: también lo que no tiene día", async () => {
    const free = (
      await call(
        "lucia",
        "POST",
        `${base}/pedidos`,
        order({
          customerName: "Sara Díaz",
          customerPhone: "+51 944 333 222",
          paymentMethodId: ids.efectivo,
          deliverOn: null,
        }),
      )
    ).json.order.id as string
    const rosa = await home("rosa")
    expect(rosa.figures.leaves).toEqual({ orders: 2, missed: 0 })
    const board = (await call("rosa", "GET", `${base}/despachos`)).json
    const leaving = (board.deliveries as Json[]).filter(
      (d) => d.state === "por_salir" || d.state === "en_camino",
    )
    expect(leaving.map((d) => d.id).sort()).toEqual([paid, free].sort())
    await call("lucia", "POST", `${base}/pedidos/${free}/anular`, { reason: "Fin de la prueba" })
  })

  it("el efectivo cobrado en la puerta: «Ir a Caja» para quien ve Caja, hasta que se recibe", async () => {
    const cash = (
      await call(
        "lucia",
        "POST",
        `${base}/pedidos`,
        order({
          customerName: "Elena Ruiz",
          customerPhone: "+51 955 111 222",
          paymentMethodId: ids.efectivo,
        }),
      )
    ).json.order.id as string
    await call("lucia", "POST", `${base}/pedidos/${cash}/salio`, {})
    const done = await call("lucia", "POST", `${base}/pedidos/${cash}/entregado`, {
      payments: [{ methodId: ids.efectivo, amountCents: 13900 }],
    })
    expect(done.status).toBe(200)
    expect((await home("rosa")).toDo).toEqual([
      {
        kind: "efectivo",
        when: "hoy",
        courierId: null,
        courier: null,
        cents: 13900,
        payments: 1,
      },
    ])
    // Ventas entrega y cobra, pero no ve Caja: la línea no es suya.
    expect((await home("lucia")).toDo).toEqual([])
    const box = (await call("rosa", "GET", `${base}/caja`)).json
    const [group] = box.toReceive as { payments: Json[] }[]
    const received = await call("rosa", "POST", `${base}/caja/recibi`, {
      courierId: null,
      paymentIds: (group?.payments ?? []).map((p) => p.id),
      receivedCents: 13900,
    })
    expect(received.status).toBe(201)
    expect((await home("rosa")).toDo).toEqual([])
  })

  it("los pedidos de prueba no cuentan en ninguna cifra ni línea", async () => {
    await db.ownerDb.update(saleOrder).set({ test: true }).where(eq(saleOrder.id, waiting))
    const rosa = await home("rosa")
    expect(rosa.figures.due).toEqual({ orders: 0, cents: 0 })
    await db.ownerDb.update(saleOrder).set({ test: false }).where(eq(saleOrder.id, waiting))
  })
})

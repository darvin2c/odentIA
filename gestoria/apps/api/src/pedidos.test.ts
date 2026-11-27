/**
 * Los pedidos (paso B4 del lienzo B), contra una base real y un token firmado como el de la
 * cuenta: armar con el precio y sus límites, cobrar por captura, por link y al recibir, el
 * stock con su kardex, anular, lo que puede cada rol y el aislamiento entre tiendas.
 *
 * El link de pago corre con el adaptador real de Mercado Pago contra un Mercado Pago de
 * mentira (un `fetch` controlado): prueba nuestro código, no que Mercado Pago responda así.
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto"
import { store, storeMember, storePaymentLink } from "@gestoria/db"
import { startTestDb, type TestDb } from "@gestoria/db/testing"
import { eq } from "drizzle-orm"
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createApp } from "./app.js"
import { dayIn } from "./hora.js"
import { mercadoPago } from "./link-de-pago.js"

const ACCOUNT = "https://api.gestoria.test"
const WEB = "https://app.gestoria.test"
const SERVER = "https://servidor.gestoria.test"
const MP_TOKEN = "APP_USR-1234567890-abcdef-tienda-rosa"
const MP_SECRET = "clave-secreta-del-webhook"

let db: TestDb
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"]
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

/** El Mercado Pago de mentira: lo que crea y los pagos que «existen». */
const mp = {
  payments: new Map<string, Record<string, unknown>>(),
  preferences: [] as Record<string, unknown>[],
}
const fakeMercadoPago: typeof fetch = async (input, init) => {
  const url = new URL(String(input))
  const auth = new Headers(init?.headers).get("authorization")
  if (auth !== `Bearer ${MP_TOKEN}`) return Response.json({ message: "invalid" }, { status: 401 })
  if (url.pathname === "/users/me") return Response.json({ id: 1 })
  if (url.pathname === "/checkout/preferences") {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    mp.preferences.push(body)
    return Response.json({
      id: `pref-${body.external_reference}`,
      init_point: `https://www.mercadopago.test/checkout?pref=${body.external_reference}`,
    })
  }
  const payment = /^\/v1\/payments\/(\d+)$/.exec(url.pathname)
  if (payment) {
    const found = mp.payments.get(payment[1]!)
    return found ? Response.json(found) : Response.json({}, { status: 404 })
  }
  return Response.json({}, { status: 404 })
}

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
  return { status: response.status, json: (json ? JSON.parse(text) : {}) as Json, response }
}

/** Un aviso de Mercado Pago, firmado como lo firma él (o con otra clave). */
async function mpNotice(paymentId: string, secret: string | null = MP_SECRET) {
  const ts = String(Math.floor(Date.now() / 1000))
  const requestId = randomUUID()
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (secret) {
    const v1 = createHmac("sha256", secret)
      .update(`id:${paymentId};request-id:${requestId};ts:${ts};`)
      .digest("hex")
    headers["x-signature"] = `ts=${ts},v1=${v1}`
    headers["x-request-id"] = requestId
  }
  const response = await app.request(
    `${SERVER}/avisos/link-de-pago/${storeId}?data.id=${paymentId}&type=payment`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "payment.updated", type: "payment", data: { id: paymentId } }),
    },
  )
  return { status: response.status, json: (await response.json()) as Json }
}

const ids = {
  yape: "",
  efectivo: "",
  link: "",
  reparto: "",
  agencia: "",
  t38: "",
  t39: "",
  medias: "",
}

/** Un pedido de una zapatilla talla 38 por Yape, con reparto. */
const order = (over: Json = {}) => ({
  customerName: "Carla Mendoza",
  customerPhone: "+51 987 654 321",
  channel: "whatsapp",
  address: "Av. Primavera 123, Surco",
  lines: [{ variantId: ids.t38, quantity: 1 }],
  deliveryMethodId: ids.reparto,
  paymentMethodId: ids.yape,
  ...over,
})

async function stockOf(variantId: string) {
  return (await call("rosa", "GET", `${base}/variantes/${variantId}/kardex`)).json as Json
}

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
    link: {
      adapters: { mercadopago: mercadoPago(fakeMercadoPago) },
      secretsKey: randomBytes(32),
      apiURL: SERVER,
    },
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
  const pay = async (body: Json) =>
    (await call("rosa", "POST", `${base}/medios-de-pago`, body)).json.method.id as string
  ids.yape = await pay({ name: "Yape", typeCode: "68", collection: "comprobante" })
  ids.efectivo = await pay({ name: "Efectivo", typeCode: "10", collection: "al_recibir" })
  ids.link = await pay({ name: "Tarjeta con link", typeCode: "48", collection: "link" })
  const deliver = async (body: Json) =>
    (await call("rosa", "POST", `${base}/formas-de-entrega`, body)).json.method.id as string
  ids.reparto = await deliver({
    name: "Reparto en Lima",
    type: "DeliveryModeOwnFleet",
    cost: "fijo",
    priceCents: 1000,
    acceptsPayOnDelivery: true,
    maxDiscountCents: 1000,
    freeFromCents: 25000,
  })
  ids.agencia = await deliver({ name: "Agencia", type: "ParcelService", cost: "se_acuerda" })
  const zapatilla = await call("rosa", "POST", `${base}/productos`, {
    name: "Zapatilla urbana",
    listPriceCents: 12900,
    minPriceCents: 10000,
    options: [{ name: "Talla", values: ["38", "39"] }],
  })
  const variants = (await call("rosa", "GET", `${base}/productos/${zapatilla.json.product.id}`))
    .json.product.variants as Json[]
  ids.t38 = variants.find((v) => v.optionValues[0] === "38")!.id
  ids.t39 = variants.find((v) => v.optionValues[0] === "39")!.id
  const medias = await call("rosa", "POST", `${base}/productos`, {
    name: "Medias",
    listPriceCents: 1500,
  })
  ids.medias = (
    await call("rosa", "GET", `${base}/productos/${medias.json.product.id}`)
  ).json.product.variants[0].id
  for (const [variantId, quantity] of [
    [ids.t38, 10],
    [ids.t39, 1],
    [ids.medias, 10],
  ] as const)
    await call("rosa", "POST", `${base}/variantes/${variantId}/movimientos`, {
      kind: "entrada",
      quantity,
    })
}, 120_000)

afterAll(async () => {
  await db?.stop()
})

describe("armar un pedido (tablero 14)", () => {
  it("Ventas lo anota; queda por pagar, con su número, y el stock no baja todavía", async () => {
    const created = await call("lucia", "POST", `${base}/pedidos`, order())
    expect(created.status).toBe(201)
    expect(created.json.order).toMatchObject({
      number: "0001",
      state: "por_pagar",
      totalCents: 13900,
      deliveryCents: 1000,
      priceExpiresAt: null,
      paymentName: "Yape",
    })
    expect((await stockOf(ids.t38)).stock).toBe(10)
    // El aviso al cliente queda escrito, sin enviarse.
    const notice = (created.json.order.events as Json[]).find((e) => e.action === "aviso")
    expect(notice?.detail).toMatchObject({ tipo: "resumen", enviado: false })
  })

  it("nunca bajo el mínimo; lo cedido queda escrito y el precio vence en 24 horas", async () => {
    const below = await call(
      "lucia",
      "POST",
      `${base}/pedidos`,
      order({ lines: [{ variantId: ids.t38, quantity: 1, unitCents: 9900 }] }),
    )
    expect(below.status).toBe(400)
    expect(below.json.error.fields).toHaveProperty(["lines.0.unitCents"])
    // Envío gratis y S/ 9 menos: paga S/ 120 con envío incluido.
    const deal = await call(
      "lucia",
      "POST",
      `${base}/pedidos`,
      order({ lines: [{ variantId: ids.t38, quantity: 1, unitCents: 12000 }], deliveryCents: 0 }),
    )
    expect(deal.status).toBe(201)
    expect(deal.json.order).toMatchObject({
      totalCents: 12000,
      discountCents: 900,
      marginCents: 2900,
      marginUsedCents: 1900,
    })
    const expires = new Date(deal.json.order.priceExpiresAt).getTime() - Date.now()
    expect(expires).toBeGreaterThan(23 * 3_600_000)
    // Las medias no tienen mínimo: no se rebajan ni se regala el envío por ellas.
    const medias = await call(
      "lucia",
      "POST",
      `${base}/pedidos`,
      order({ lines: [{ variantId: ids.medias, quantity: 1 }], deliveryCents: 0 }),
    )
    expect(medias.status).toBe(400)
    expect(medias.json.error.fields).toHaveProperty("deliveryCents")
  })

  it("el calculador da el mismo precio sin guardar, y dice lo que falta", async () => {
    const quote = await call(
      "lucia",
      "POST",
      `${base}/pedidos/calcular`,
      order({ lines: [{ variantId: ids.t38, quantity: 2 }] }),
    )
    expect(quote.json.quote).toMatchObject({ subtotalCents: 25800, deliveryCents: 0 })
    expect(quote.json.quote.deliveryFreeByPolicy).toBe(true)
    const missing = await call(
      "lucia",
      "POST",
      `${base}/pedidos/calcular`,
      order({ deliveryMethodId: ids.agencia, lines: [{ variantId: ids.t39, quantity: 2 }] }),
    )
    expect(missing.json.quote).toBeNull()
    expect(missing.json.fields).toMatchObject({
      deliveryListCents: "Escribe cuánto cuesta el envío",
      "lines.0.quantity": expect.stringContaining("Quedan 1"),
    })
  })

  it("al recibir, solo con una forma de entrega que lo acepta; empieza por salir", async () => {
    const agencia = await call(
      "lucia",
      "POST",
      `${base}/pedidos`,
      order({
        paymentMethodId: ids.efectivo,
        deliveryMethodId: ids.agencia,
        deliveryListCents: 1500,
      }),
    )
    expect(agencia.status).toBe(400)
    expect(agencia.json.error.fields).toHaveProperty("paymentMethodId")
    const ok = await call(
      "lucia",
      "POST",
      `${base}/pedidos`,
      order({ paymentMethodId: ids.efectivo }),
    )
    expect(ok.json.order.state).toBe("por_salir")
  })
})

describe("cobrar con captura (lo único que espera a una persona)", () => {
  let id = ""
  it("la captura deja el pedido por confirmar; «No coincide» pide motivo y lo devuelve", async () => {
    id = (await call("lucia", "POST", `${base}/pedidos`, order())).json.order.id
    const form = new FormData()
    form.set("amountCents", "13900")
    form.set("operation", "12345678")
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    form.set("captura", new File([png], "captura.png", { type: "image/png" }))
    const sent = await call("lucia", "POST", `${base}/pedidos/${id}/comprobante`, undefined, form)
    expect(sent.status).toBe(200)
    expect(sent.json.order.state).toBe("por_confirmar")
    const payment = sent.json.order.payments[0]
    expect(payment).toMatchObject({ kind: "comprobante", status: "por_confirmar", hasPhoto: true })
    const photo = await call("lucia", "GET", `${base}/pedidos/${id}/pagos/${payment.id}/captura`)
    expect(photo.response.headers.get("content-type")).toBe("image/png")
    const noReason = await call(
      "lucia",
      "POST",
      `${base}/pedidos/${id}/pagos/${payment.id}/revision`,
      { decision: "no_coincide", reason: "" },
    )
    expect(noReason.status).toBe(400)
    const no = await call("lucia", "POST", `${base}/pedidos/${id}/pagos/${payment.id}/revision`, {
      decision: "no_coincide",
      reason: "No aparece en la cuenta",
    })
    expect(no.json.order.state).toBe("por_pagar")
    expect(no.json.order.payments[0]).toMatchObject({
      status: "no_coincide",
      note: "No aparece en la cuenta",
    })
  })

  it("«Confirmar pago» lo deja pagado y baja el stock con su kardex, una vez", async () => {
    const form = new FormData()
    form.set("amountCents", "13900")
    const sent = await call("lucia", "POST", `${base}/pedidos/${id}/comprobante`, undefined, form)
    const payment = (sent.json.order.payments as Json[]).find((p) => p.status === "por_confirmar")!
    const ok = await call("lucia", "POST", `${base}/pedidos/${id}/pagos/${payment.id}/revision`, {
      decision: "confirmar",
    })
    expect(ok.json.order).toMatchObject({ state: "por_salir", paid: true, stockPending: false })
    const again = await call(
      "lucia",
      "POST",
      `${base}/pedidos/${id}/pagos/${payment.id}/revision`,
      {
        decision: "confirmar",
      },
    )
    expect(again.status).toBe(409)
    const kardex = await stockOf(ids.t38)
    expect(kardex.stock).toBe(9)
    expect(kardex.movements[0]).toMatchObject({
      kind: "venta",
      quantity: -1,
      reference: `Pedido ${ok.json.order.number}`,
    })
  })

  it("«Salió» con número de envío y «Entregado»; uno entregado ya no se anula", async () => {
    const out = await call("lucia", "POST", `${base}/pedidos/${id}/salio`, { tracking: "OLV-123" })
    expect(out.json.order).toMatchObject({ state: "en_camino", tracking: "OLV-123" })
    expect((await stockOf(ids.t38)).stock).toBe(9)
    const done = await call("lucia", "POST", `${base}/pedidos/${id}/entregado`, {})
    expect(done.json.order.state).toBe("entregado")
    const cancel = await call("rosa", "POST", `${base}/pedidos/${id}/anular`, {
      reason: "Se equivocó",
    })
    expect(cancel.status).toBe(409)
  })
})

describe("al recibir (decisión 4)", () => {
  it("baja al salir; quien entrega marca lo que cobró", async () => {
    const id = (
      await call("lucia", "POST", `${base}/pedidos`, order({ paymentMethodId: ids.efectivo }))
    ).json.order.id
    const before = (await stockOf(ids.t38)).stock
    await call("lucia", "POST", `${base}/pedidos/${id}/salio`, {})
    expect((await stockOf(ids.t38)).stock).toBe(before - 1)
    const missing = await call("lucia", "POST", `${base}/pedidos/${id}/entregado`, {})
    expect(missing.status).toBe(400)
    expect(missing.json.error.fields).toHaveProperty("collectedCents")
    const done = await call("lucia", "POST", `${base}/pedidos/${id}/entregado`, {
      collectedCents: 13900,
    })
    expect(done.json.order.state).toBe("entregado")
    expect(done.json.order.payments[0]).toMatchObject({
      kind: "al_recibir",
      status: "confirmado",
      amountCents: 13900,
      createdByName: "Lucía Torres",
      note: null,
    })
  })

  it("si cobró otro monto, se anota tal cual y queda escrito para revisarlo", async () => {
    const id = (
      await call("lucia", "POST", `${base}/pedidos`, order({ paymentMethodId: ids.efectivo }))
    ).json.order.id
    const done = await call("lucia", "POST", `${base}/pedidos/${id}/entregado`, {
      collectedCents: 10000,
    })
    expect(done.json.order.state).toBe("entregado")
    expect(done.json.order.payments[0].amountCents).toBe(10000)
    expect(done.json.order.payments[0].note).toMatch(/^Cobró S\/\s100 de S\/\s139$/)
  })
})

describe("anular, con motivo escrito", () => {
  it("lo que salió vuelve con su movimiento; un pagado lo anula quien confirma pagos", async () => {
    const id = (
      await call("lucia", "POST", `${base}/pedidos`, order({ paymentMethodId: ids.efectivo }))
    ).json.order.id
    await call("lucia", "POST", `${base}/pedidos/${id}/salio`, {})
    const before = (await stockOf(ids.t38)).stock
    const noReason = await call("lucia", "POST", `${base}/pedidos/${id}/anular`, { reason: " " })
    expect(noReason.status).toBe(400)
    const cancel = await call("lucia", "POST", `${base}/pedidos/${id}/anular`, {
      reason: "El cliente no estaba",
    })
    expect(cancel.json.order).toMatchObject({
      state: "anulado",
      cancelReason: "El cliente no estaba",
    })
    const kardex = await stockOf(ids.t38)
    expect(kardex.stock).toBe(before + 1)
    expect(kardex.movements[0]).toMatchObject({ kind: "anulacion", quantity: 1 })
    const twice = await call("lucia", "POST", `${base}/pedidos/${id}/anular`, {
      reason: "otra vez",
    })
    expect(twice.status).toBe(409)
  })
})

describe("el link de pago (Mercado Pago, con un proveedor controlado)", () => {
  let id = ""
  it("sin conectar no hay link; solo quien configura lo conecta y el token no vuelve", async () => {
    id = (await call("lucia", "POST", `${base}/pedidos`, order({ paymentMethodId: ids.link }))).json
      .order.id
    const none = await call("lucia", "POST", `${base}/pedidos/${id}/link`)
    expect(none.status).toBe(409)
    expect(none.json.error.code).toBe("LINK_NOT_CONNECTED")
    const body = { provider: "mercadopago", accessToken: MP_TOKEN, webhookSecret: MP_SECRET }
    expect((await call("lucia", "PATCH", `${base}/link-de-pago`, body)).status).toBe(403)
    const bad = await call("rosa", "PATCH", `${base}/link-de-pago`, {
      ...body,
      accessToken: "APP_USR-otro-token-que-no-sirve-0000",
    })
    expect(bad.status).toBe(400)
    expect(bad.json.error.fields).toHaveProperty("accessToken")
    const ok = await call("rosa", "PATCH", `${base}/link-de-pago`, body)
    expect(ok.status).toBe(200)
    expect(JSON.stringify(ok.json)).not.toContain(MP_TOKEN)
    expect(ok.json.connection).toMatchObject({
      provider: "mercadopago",
      hint: "rosa",
      signed: true,
    })
    const seen = await call("lucia", "GET", `${base}/link-de-pago`)
    expect(JSON.stringify(seen.json)).not.toContain(MP_TOKEN)
    // En la base va cifrado.
    const [row] = await db.ownerDb
      .select()
      .from(storePaymentLink)
      .where(eq(storePaymentLink.storeId, storeId))
    expect(row!.accessTokenEnc).not.toContain(MP_TOKEN)
  })

  it("el link lleva el total y el pedido; pedirlo otra vez da el mismo", async () => {
    const link = await call("lucia", "POST", `${base}/pedidos/${id}/link`)
    expect(link.json.url).toBe(`https://www.mercadopago.test/checkout?pref=${id}`)
    expect(mp.preferences.at(-1)).toMatchObject({
      external_reference: id,
      notification_url: `${SERVER}/avisos/link-de-pago/${storeId}`,
      items: [{ unit_price: 139, currency_id: "PEN", quantity: 1 }],
    })
    const again = await call("lucia", "POST", `${base}/pedidos/${id}/link`)
    expect(again.json.url).toBe(link.json.url)
    expect(mp.preferences).toHaveLength(1)
  })

  it("un aviso sin firma o con otra clave no cambia nada", async () => {
    mp.payments.set("9001", {
      id: 9001,
      status: "approved",
      external_reference: id,
      transaction_amount: 139,
      currency_id: "PEN",
    })
    expect((await mpNotice("9001", null)).status).toBe(401)
    expect((await mpNotice("9001", "otra-clave")).status).toBe(401)
    expect((await call("lucia", "GET", `${base}/pedidos/${id}`)).json.order.state).toBe("por_pagar")
  })

  it("pagado por el link pasa a pagado solo, baja el stock y repetir el aviso no duplica", async () => {
    const before = (await stockOf(ids.t38)).stock
    expect((await mpNotice("9001")).json.message).toBe("Recibido")
    const detail = (await call("lucia", "GET", `${base}/pedidos/${id}`)).json.order
    expect(detail).toMatchObject({ state: "por_salir", paid: true })
    expect(detail.payments[0]).toMatchObject({ kind: "link", status: "confirmado", byLink: true })
    expect((await stockOf(ids.t38)).stock).toBe(before - 1)
    expect((await mpNotice("9001")).json.message).toBe("Recibido")
    expect((await stockOf(ids.t38)).stock).toBe(before - 1)
  })

  it("si el monto no coincide, no se da por pagado: lo mira una persona", async () => {
    const other = (
      await call("lucia", "POST", `${base}/pedidos`, order({ paymentMethodId: ids.link }))
    ).json.order.id
    mp.payments.set("9002", {
      id: 9002,
      status: "approved",
      external_reference: other,
      transaction_amount: 100,
      currency_id: "PEN",
    })
    expect((await mpNotice("9002")).status).toBe(200)
    const detail = (await call("lucia", "GET", `${base}/pedidos/${other}`)).json.order
    // El dinero llegó: cuenta como recibido, pero espera a una persona; no está «Pagado».
    expect(detail).toMatchObject({ state: "por_confirmar", moneyIn: true, paid: false })
    expect(detail.balance).toMatchObject({ confirmedCents: 0, pendingCents: 10000, dueCents: 3900 })
    expect(detail.payments[0].note).toContain("no coincide")
    mp.payments.set("9003", { id: 9003, status: "rejected", external_reference: other })
    // Un pago rechazado o que la cuenta no conoce no hace nada, y responde igual que los demás.
    expect((await mpNotice("9003")).json.message).toBe("Recibido")
    expect((await mpNotice("9999")).json.message).toBe("Recibido")
    const after = (await call("lucia", "GET", `${base}/pedidos/${other}`)).json.order
    expect(after.payments).toHaveLength(1)
  })

  it("una captura confirmada después de pagar por el link queda como pago doble", async () => {
    const id = (await call("lucia", "POST", `${base}/pedidos`, order())).json.order.id
    const form = new FormData()
    form.set("amountCents", "13900")
    const sent = await call("lucia", "POST", `${base}/pedidos/${id}/comprobante`, undefined, form)
    const receipt = sent.json.order.payments[0].id
    mp.payments.set("9004", {
      id: 9004,
      status: "approved",
      external_reference: id,
      transaction_amount: 139,
      currency_id: "PEN",
    })
    await mpNotice("9004")
    const paid = (await call("lucia", "GET", `${base}/pedidos/${id}`)).json.order
    expect(paid.state).toBe("por_salir")
    const double = await call("lucia", "POST", `${base}/pedidos/${id}/pagos/${receipt}/revision`, {
      decision: "confirmar",
    })
    const confirmed = (double.json.order.payments as Json[]).find((p) => p.id === receipt)
    expect(confirmed).toMatchObject({ status: "confirmado" })
    expect(confirmed?.note).toContain("Pago doble")
  })

  it("al desconectar la cuenta, los links de los pedidos por pagar dejan de valer", async () => {
    const id = (
      await call("lucia", "POST", `${base}/pedidos`, order({ paymentMethodId: ids.link }))
    ).json.order.id
    await call("lucia", "POST", `${base}/pedidos/${id}/link`)
    expect((await call("lucia", "GET", `${base}/pedidos/${id}`)).json.order.linkUrl).toBeTruthy()
    expect((await call("lucia", "DELETE", `${base}/link-de-pago`)).status).toBe(403)
    expect((await call("rosa", "DELETE", `${base}/link-de-pago`)).status).toBe(204)
    const detail = (await call("lucia", "GET", `${base}/pedidos/${id}`)).json.order
    expect(detail).toMatchObject({ linkUrl: null, linkConnected: false })
    // Un aviso para una tienda sin cuenta conectada responde igual y no hace nada.
    expect((await mpNotice("9001")).json.message).toBe("Recibido")
    // Se vuelve a conectar sin repetir la clave: se queda la que había, si la hubiera.
    const again = await call("rosa", "PATCH", `${base}/link-de-pago`, {
      provider: "mercadopago",
      accessToken: MP_TOKEN,
    })
    expect(again.json.connection).toMatchObject({ signed: false })
  })
})

describe("si al pagar no alcanza el stock", () => {
  it("el pago se confirma igual y no sale hasta que entre stock", async () => {
    // Dos pedidos por la única talla 39; el primero se paga y sale.
    const first = (
      await call(
        "lucia",
        "POST",
        `${base}/pedidos`,
        order({ lines: [{ variantId: ids.t39, quantity: 1 }], paymentMethodId: ids.efectivo }),
      )
    ).json.order.id
    const second = (
      await call(
        "lucia",
        "POST",
        `${base}/pedidos`,
        order({ lines: [{ variantId: ids.t39, quantity: 1 }] }),
      )
    ).json.order.id
    await call("lucia", "POST", `${base}/pedidos/${first}/salio`, {})
    const form = new FormData()
    form.set("amountCents", "13900")
    const sent = await call(
      "lucia",
      "POST",
      `${base}/pedidos/${second}/comprobante`,
      undefined,
      form,
    )
    const paymentId = sent.json.order.payments[0].id
    const ok = await call(
      "lucia",
      "POST",
      `${base}/pedidos/${second}/pagos/${paymentId}/revision`,
      {
        decision: "confirmar",
      },
    )
    expect(ok.json.order).toMatchObject({ state: "por_salir", stockPending: true })
    const out = await call("lucia", "POST", `${base}/pedidos/${second}/salio`, {})
    expect(out.status).toBe(409)
    expect(out.json.error.code).toBe("NOT_ENOUGH_STOCK")
    await call("rosa", "POST", `${base}/variantes/${ids.t39}/movimientos`, {
      kind: "entrada",
      quantity: 1,
    })
    const now = await call("lucia", "POST", `${base}/pedidos/${second}/salio`, {})
    expect(now.json.order.state).toBe("en_camino")
  })
})

describe("el pago en partes (Diana, tablero 7)", () => {
  let id = ""
  const capture = async (amountCents: number, extra: Record<string, string> = {}) => {
    const form = new FormData()
    form.set("amountCents", String(amountCents))
    for (const [key, value] of Object.entries(extra)) form.set(key, value)
    return call("lucia", "POST", `${base}/pedidos/${id}/comprobante`, undefined, form)
  }
  const dueInReports = async () =>
    (await call("rosa", "GET", `${base}/reportes?periodo=hoy`)).json.pending.due.cents as number

  it("un adelanto de S/ 80 de S/ 117 deja listo para salir, sin «Pagado» ni «Pago doble»", async () => {
    // Zapatilla a S/ 107 (negociada) + envío S/ 10 = S/ 117.
    id = (
      await call(
        "lucia",
        "POST",
        `${base}/pedidos`,
        order({
          customerName: "Diana Flores",
          lines: [{ variantId: ids.t38, quantity: 1, unitCents: 10700 }],
        }),
      )
    ).json.order.id
    const stock = (await stockOf(ids.t38)).stock
    const sent = await capture(8000, { methodId: ids.yape })
    expect(sent.json.order.state).toBe("por_confirmar")
    expect(sent.json.order.balance).toMatchObject({
      confirmedCents: 0,
      pendingCents: 8000,
      dueCents: 3700,
    })
    const payment = sent.json.order.payments[0]
    expect(payment).toMatchObject({ methodName: "Yape", methodType: "68", overIfConfirmedCents: 0 })
    const ok = await call("lucia", "POST", `${base}/pedidos/${id}/pagos/${payment.id}/revision`, {
      decision: "confirmar",
    })
    expect(ok.json.order).toMatchObject({ state: "por_salir", paid: false, stockPending: false })
    expect(ok.json.order.balance).toMatchObject({ confirmedCents: 8000, dueCents: 3700 })
    expect(ok.json.order.payments[0].note).toBeNull()
    // El primer pago confirmado baja el stock, como un pago completo.
    expect((await stockOf(ids.t38)).stock).toBe(stock - 1)
    // El aviso dice cuánto falta.
    const notice = (ok.json.order.events as Json[]).filter((e) => e.action === "aviso").at(-1)
    expect(String(notice?.detail.texto)).toMatch(/Falta pagar S\/\s37/)
    // La lista dice la misma cifra.
    const list = await call("lucia", "GET", `${base}/pedidos?filtro=para_entregar`)
    const row = (list.json.orders as Json[]).find((o) => o.id === id)
    expect(row?.balance).toMatchObject({ dueCents: 3700 })
    expect(row?.paid).toBe(false)
  })

  it("al entregar se cobra lo que falta, con su medio, y queda «Pagado»", async () => {
    const before = await dueInReports()
    const missing = await call("lucia", "POST", `${base}/pedidos/${id}/entregado`, {})
    expect(missing.status).toBe(400)
    expect(missing.json.error.fields).toHaveProperty("collectedCents")
    // Un medio que no se cobra al recibir no vale en la puerta.
    const wrong = await call("lucia", "POST", `${base}/pedidos/${id}/entregado`, {
      collectedCents: 3700,
      methodId: ids.yape,
    })
    expect(wrong.status).toBe(400)
    expect(wrong.json.error.fields).toHaveProperty("methodId")
    const done = await call("lucia", "POST", `${base}/pedidos/${id}/entregado`, {
      collectedCents: 3700,
      methodId: ids.efectivo,
    })
    expect(done.json.order).toMatchObject({ state: "entregado", paid: true })
    expect(done.json.order.balance).toMatchObject({ confirmedCents: 11700, dueCents: 0 })
    expect(done.json.order.payments.map((p: Json) => [p.methodName, p.amountCents])).toEqual([
      ["Yape", 8000],
      ["Efectivo", 3700],
    ])
    expect(done.json.order.payments[1]).toMatchObject({ kind: "al_recibir", note: null })
    // Reportes deja de contarlo en «Falta cobrar».
    expect(before - (await dueInReports())).toBe(3700)
  })

  it("ya pagado no acepta otra captura; con una por confirmar, tampoco por lo mismo", async () => {
    const again = await capture(1000)
    expect(again.status).toBe(409)
    expect(again.json.error.code).toBe("NOTHING_DUE")
    // Otro pedido: la captura del total espera; otra más no cabe hasta revisarla.
    id = (await call("lucia", "POST", `${base}/pedidos`, order())).json.order.id
    expect((await capture(13900)).status).toBe(200)
    const second = await capture(13900)
    expect(second.status).toBe(409)
    expect(second.json.error.message).toContain("por confirmar")
  })
})

describe("la hora de la tienda", () => {
  it("la cambia quien configura; con ella se cuenta «hoy»", async () => {
    const me = await call("rosa", "GET", "/api/yo")
    expect((me.json.stores as Json[]).find((s) => s.id === storeId)?.timeZone).toBe("America/Lima")
    expect((await call("lucia", "PATCH", `${base}/hora`, { timeZone: "Asia/Tokyo" })).status).toBe(
      403,
    )
    const bad = await call("rosa", "PATCH", `${base}/hora`, { timeZone: "America/Narnia" })
    expect(bad.status).toBe(400)
    expect(bad.json.error.fields).toHaveProperty("timeZone")
    const ok = await call("rosa", "PATCH", `${base}/hora`, { timeZone: "Asia/Tokyo" })
    expect(ok.json.store.timeZone).toBe("Asia/Tokyo")
    const list = await call("lucia", "GET", `${base}/pedidos?filtro=hoy`)
    expect(list.json.today).toBe(dayIn("Asia/Tokyo"))
    await call("rosa", "PATCH", `${base}/hora`, { timeZone: "America/Lima" })
    expect((await call("lucia", "GET", `${base}/pedidos?filtro=hoy`)).json.today).toBe(
      dayIn("America/Lima"),
    )
  })
})

describe("la lista y quién puede", () => {
  it("filtra por estado y cuenta «Para entregar hoy» con el día de la tienda", async () => {
    // El de Lima, no el del servidor: desde las 19:00 de Lima, en UTC ya es mañana.
    const today = dayIn("America/Lima")
    await call(
      "lucia",
      "POST",
      `${base}/pedidos`,
      order({ paymentMethodId: ids.efectivo, deliverOn: today }),
    )
    // Lo que diga el navegador no cuenta.
    const list = await call("lucia", "GET", `${base}/pedidos?filtro=hoy&hoy=1999-01-01`)
    expect(list.json.today).toBe(today)
    expect(list.json.orders.length).toBeGreaterThan(0)
    expect(list.json.counts.hoy).toBe(list.json.orders.length)
    expect(list.json.orders.every((o: Json) => ["por_salir", "en_camino"].includes(o.state))).toBe(
      true,
    )
    // «Pago por confirmar»: todo pedido con un pago que espera a una persona.
    const confirm = await call("lucia", "GET", `${base}/pedidos?filtro=por_confirmar`)
    expect(confirm.json.orders.length).toBeGreaterThan(0)
    expect(confirm.json.orders.every((o: Json) => o.balance.pendingCents > 0)).toBe(true)
    expect(confirm.json.counts.por_confirmar).toBe(confirm.json.orders.length)
    expect((await call("lucia", "GET", `${base}/pedidos?filtro=nada`)).status).toBe(400)
  })

  it("otra cuenta no ve ni toca los pedidos de la tienda", async () => {
    const list = await call("lucia", "GET", `${base}/pedidos`)
    const anyId = list.json.orders[0].id
    expect((await call("ajena", "GET", `${base}/pedidos`)).status).toBe(404)
    expect((await call("ajena", "GET", `${base}/pedidos/${anyId}`)).status).toBe(404)
    expect((await call("ajena", "POST", `${base}/pedidos`, order())).status).toBe(404)
    // Un aviso a una tienda que no existe no hace nada y responde igual que los demás.
    const response = await app.request(
      `${SERVER}/avisos/link-de-pago/${randomUUID()}?data.id=1&type=payment`,
      {
        method: "POST",
        body: "{}",
      },
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ message: "Recibido" })
  })
})

/**
 * Los pedidos (paso B4 del lienzo B), contra una base real y un token firmado como el de la
 * cuenta: armar con el precio y sus límites, cobrar por captura, por link y al recibir, el
 * stock con su kardex, anular, lo que puede cada rol y el aislamiento entre tiendas.
 *
 * El link de pago corre con el adaptador real de Mercado Pago contra un Mercado Pago de
 * mentira (un `fetch` controlado): prueba nuestro código, no que Mercado Pago responda así.
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto"
import { store, storeMember, storePaymentLink, storePaymentLinkAttempt } from "@gestoria/db"
import { startTestDb, type TestDb } from "@gestoria/db/testing"
import { eq } from "drizzle-orm"
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createApp } from "./app.js"
import { dayIn } from "./hora.js"
import { mercadoPago } from "./link-de-pago.js"
import { checkKeyLinks, renewPaymentLinks } from "./pasarela.js"
import type { LinkDeps } from "./pedidos.js"
import { openSecret, sealSecret } from "./secretos.js"

const ACCOUNT = "https://api.gestoria.test"
const WEB = "https://app.gestoria.test"
const SERVER = "https://servidor.gestoria.test"
const MP_TOKEN = "APP_USR-1234567890-abcdef-tienda-rosa"
const MP_TEST_TOKEN = "TEST-1234567890-abcdef-tienda-rosa"
const MP_TOKEN_RENEWED = "APP_USR-1234567890-renovado-tienda-rosa"
const KEY = randomBytes(32)
/** La aplicación de gestorIA en el Mercado Pago de mentira. */
const MP_APP = {
  clientId: "1234567",
  clientSecret: "secreto-de-la-app",
  redirectURL: `${WEB}/mercadopago/vuelta`,
}
const MP_SECRET = "clave-secreta-del-webhook"
/** Las claves de la tienda: el Access Token de prueba (de su cuenta de prueba) y el de producción. */
const KEYS_TEST = "APP_USR-5555555555-112233-clavedeprueba0rosa-4512"
const KEYS_REAL = "APP_USR-6666666666-445566-clavedeproduccion-0077"

let db: TestDb
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"]
let app: ReturnType<typeof createApp>
let linkDeps: LinkDeps
let accountKeys: ReturnType<typeof createLocalJWKSet>

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
  /** La tienda desvinculó la aplicación: Mercado Pago ya no reconoce sus tokens. */
  revoked: false,
  /** Los tokens que la tienda borró o cambió en su panel. */
  revokedTokens: new Set<string>(),
  /** Cuántas veces se le preguntó de qué cuenta es un token. */
  usersMe: 0,
  /** Pagos de otra cuenta: Mercado Pago responde 401 aunque el token de la tienda sirva. */
  foreignPayments: new Set<string>(),
}
const fakeMercadoPago: typeof fetch = async (input, init) => {
  const url = new URL(String(input))
  if (url.pathname === "/oauth/token") {
    const body = JSON.parse(String(init?.body)) as Record<string, string>
    if (body.client_id !== MP_APP.clientId || body.client_secret !== MP_APP.clientSecret)
      return Response.json({ message: "invalid_client" }, { status: 401 })
    if (body.grant_type === "refresh_token")
      return Response.json({
        access_token: MP_TOKEN_RENEWED,
        refresh_token: "TG-renovado",
        expires_in: 15_552_000,
        user_id: 77,
      })
    if (
      body.code !== "codigo-bueno" ||
      body.redirect_uri !== MP_APP.redirectURL ||
      !body.code_verifier
    )
      return Response.json({ message: "invalid_grant" }, { status: 400 })
    return Response.json({
      access_token: body.test_token === "true" ? MP_TEST_TOKEN : MP_TOKEN,
      refresh_token: "TG-primero",
      expires_in: 15_552_000,
      user_id: 77,
    })
  }
  const auth = new Headers(init?.headers).get("authorization")
  if (url.pathname === "/users/me") mp.usersMe++
  const known = [MP_TOKEN, MP_TEST_TOKEN, MP_TOKEN_RENEWED, KEYS_TEST, KEYS_REAL]
    .filter((token) => !mp.revokedTokens.has(token))
    .map((token) => `Bearer ${token}`)
  if (mp.revoked || !auth || !known.includes(auth))
    return Response.json({ message: "invalid" }, { status: 401 })
  if (url.pathname === "/users/me")
    return Response.json(
      // Mercado Pago marca la cuenta de prueba (`test_user`).
      auth === `Bearer ${KEYS_TEST}`
        ? { id: 4512, email: "test_user_4512@testuser.com", tags: ["normal", "test_user"] }
        : { id: 77, email: "rosa.quispe@correo.test", tags: ["normal"] },
    )
  if (url.pathname === "/checkout/preferences") {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    mp.preferences.push(body)
    return Response.json({
      id: `pref-${body.external_reference}`,
      init_point: `https://www.mercadopago.test/checkout?pref=${body.external_reference}`,
      sandbox_init_point: `https://sandbox.mercadopago.test/checkout?pref=${body.external_reference}`,
    })
  }
  const payment = /^\/v1\/payments\/(\d+)$/.exec(url.pathname)
  if (payment && mp.foreignPayments.has(payment[1]!))
    return Response.json({ message: "unauthorized" }, { status: 401 })
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
  linkDeps = {
    adapters: { mercadopago: mercadoPago(fakeMercadoPago) },
    secretsKey: KEY,
    apiURL: SERVER,
    app: MP_APP,
  }
  const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" })
  privateKey = pair.privateKey
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), alg: "EdDSA", kid: "k1" }
  accountKeys = createLocalJWKSet({ keys: [jwk] })
  app = createApp({
    appDb: db.appDb,
    ownerDb: db.ownerDb,
    account: { url: ACCOUNT, eventsSecret: "", keys: accountKeys },
    webURL: WEB,
    link: linkDeps,
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

  it("sin todo el pago no se entrega (tablero 24): ni menos ni más de lo que falta", async () => {
    const id = (
      await call("lucia", "POST", `${base}/pedidos`, order({ paymentMethodId: ids.efectivo }))
    ).json.order.id
    const short = await call("lucia", "POST", `${base}/pedidos/${id}/entregado`, {
      collectedCents: 10000,
    })
    expect(short.status).toBe(400)
    expect(short.json.error.message).toMatch(/^Falta cobrar S\/\s39/)
    const over = await call("lucia", "POST", `${base}/pedidos/${id}/entregado`, {
      collectedCents: 20000,
    })
    expect(over.status).toBe(400)
    const detail = await call("lucia", "GET", `${base}/pedidos/${id}`)
    expect(detail.json.order).toMatchObject({ state: "por_salir", payments: [] })
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

describe("el link de pago (Mercado Pago entrando a la cuenta, con un proveedor controlado)", () => {
  let id = ""
  /** Conectar de punta a punta: empezar, «dar permiso» en Mercado Pago y volver con el código. */
  async function connect(mode: "prueba" | "real", who: Who = "rosa", code = "codigo-bueno") {
    const started = await call(who, "POST", `${base}/link-de-pago/conectar`, { mode })
    const state = new URL(started.json.url).searchParams.get("state") ?? ""
    return {
      started,
      state,
      back: await call(who, "POST", "/api/link-de-pago/vuelta", { state, code }),
    }
  }

  it("sin conectar no hay link; solo quien configura conecta y va a Mercado Pago con PKCE", async () => {
    id = (await call("lucia", "POST", `${base}/pedidos`, order({ paymentMethodId: ids.link }))).json
      .order.id
    const none = await call("lucia", "POST", `${base}/pedidos/${id}/link`)
    expect(none.status).toBe(409)
    expect(none.json.error.code).toBe("LINK_NOT_CONNECTED")
    expect((await call("lucia", "POST", `${base}/link-de-pago/conectar`, {})).status).toBe(403)
    const started = await call("rosa", "POST", `${base}/link-de-pago/conectar`, {})
    const url = new URL(started.json.url)
    expect(url.origin + url.pathname).toBe("https://auth.mercadopago.com/authorization")
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: MP_APP.clientId,
      response_type: "code",
      platform_id: "mp",
      redirect_uri: MP_APP.redirectURL,
      code_challenge_method: "S256",
    })
    expect(url.searchParams.get("state")).toMatch(new RegExp(`^${storeId}\\.`))
    // El secreto de la aplicación nunca sale.
    expect(started.json.url).not.toContain(MP_APP.clientSecret)
  })

  it("el regreso vale una vez, para quien empezó, y antes de 10 minutos", async () => {
    const started = await call("rosa", "POST", `${base}/link-de-pago/conectar`, {})
    const state = new URL(started.json.url).searchParams.get("state") ?? ""
    // Otra persona del equipo (con permiso) no puede usar el de Rosa; Ventas, ni intentarlo.
    expect(
      (await call("lucia", "POST", "/api/link-de-pago/vuelta", { state, code: "codigo-bueno" }))
        .status,
    ).toBe(403)
    expect(
      (await call("mario", "POST", "/api/link-de-pago/vuelta", { state, code: "codigo-bueno" }))
        .json.error.code,
    ).toBe("LINK_STATE")
    // Vencido: no sirve.
    await db.ownerDb
      .update(storePaymentLinkAttempt)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(storePaymentLinkAttempt.storeId, storeId))
    const late = await call("rosa", "POST", "/api/link-de-pago/vuelta", {
      state,
      code: "codigo-bueno",
    })
    expect(late.json.error.code).toBe("LINK_STATE")
    // Un código que Mercado Pago no acepta: se dice, y el intento ya no vale.
    const bad = await connect("prueba", "rosa", "codigo-vencido")
    expect(bad.back.json.error.code).toBe("LINK_PROVIDER")
    const again = await call("rosa", "POST", "/api/link-de-pago/vuelta", {
      state: bad.state,
      code: "codigo-bueno",
    })
    expect(again.json.error.code).toBe("LINK_STATE")
    expect((await call("rosa", "GET", `${base}/link-de-pago`)).json.connection).toBeNull()
  })

  it("conectada en modo prueba: el token no vuelve, ningún pedido se cobra por link y el pedido lo dice", async () => {
    const { back } = await connect("prueba")
    expect(back.json).toEqual({ storeId, mode: "prueba" })
    const seen = await call("lucia", "GET", `${base}/link-de-pago`)
    expect(seen.json.connection).toMatchObject({
      provider: "mercadopago",
      state: "conectada",
      mode: "prueba",
      via: "cuenta",
      account: "rosa.quispe@…",
    })
    expect(JSON.stringify(seen.json)).not.toContain(MP_TEST_TOKEN)
    expect(JSON.stringify(seen.json)).not.toContain("TG-")
    const [row] = await db.ownerDb
      .select()
      .from(storePaymentLink)
      .where(eq(storePaymentLink.storeId, storeId))
    expect(row!.accessTokenEnc).not.toContain(MP_TEST_TOKEN)
    expect(row!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 179 * 86_400_000)
    const blocked = await call("lucia", "POST", `${base}/pedidos/${id}/link`)
    expect(blocked.json.error.code).toBe("LINK_TEST_MODE")
    const detail = (await call("lucia", "GET", `${base}/pedidos/${id}`)).json.order
    expect(detail).toMatchObject({ linkConnected: false, linkTestMode: true })
  })

  it("el link de prueba de S/ 1 se paga con la tarjeta de prueba y queda pagado solo", async () => {
    expect((await call("lucia", "POST", `${base}/link-de-pago/prueba`)).status).toBe(403)
    // Dos toques a la vez: un solo link en Mercado Pago, y los dos reciben el mismo.
    const before = mp.preferences.length
    const [made, twice] = await Promise.all([
      call("rosa", "POST", `${base}/link-de-pago/prueba`),
      call("rosa", "POST", `${base}/link-de-pago/prueba`),
    ])
    expect(made.json.trial.url).toMatch(/^https:\/\/sandbox\.mercadopago\.test\//)
    expect(twice.json.trial.id).toBe(made.json.trial.id)
    // Volver a tocar mientras espera el pago: el mismo link, no otro.
    const again = await call("rosa", "POST", `${base}/link-de-pago/prueba`)
    expect(again.json.trial.id).toBe(made.json.trial.id)
    expect(mp.preferences.length).toBe(before + 1)
    expect(mp.preferences.at(-1)).toMatchObject({
      external_reference: `prueba:${made.json.trial.id}`,
      items: [{ unit_price: 1, currency_id: "PEN" }],
    })
    // Pagado por otro monto, no; por S/ 1, sí. El pedido de verdad no se toca.
    mp.payments.set("8001", {
      id: 8001,
      status: "approved",
      external_reference: `prueba:${made.json.trial.id}`,
      transaction_amount: 2,
      currency_id: "PEN",
    })
    await mpNotice("8001", null)
    expect((await call("rosa", "GET", `${base}/link-de-pago`)).json.trial.paidAt).toBeNull()
    mp.payments.set("8002", {
      id: 8002,
      status: "approved",
      external_reference: `prueba:${made.json.trial.id}`,
      transaction_amount: 1,
      currency_id: "PEN",
    })
    await mpNotice("8002", null)
    const status = (await call("rosa", "GET", `${base}/link-de-pago`)).json
    expect(status.trial).toMatchObject({ amountCents: 100, paidCents: 100 })
    expect(status.trial.paidAt).toBeTruthy()
    // Ya pagado: otra prueba es otro link.
    const next = await call("rosa", "POST", `${base}/link-de-pago/prueba`)
    expect(next.json.trial.id).not.toBe(made.json.trial.id)
    expect(mp.preferences.length).toBe(before + 2)
    // Un pago de prueba con la referencia de un pedido nunca lo paga.
    mp.payments.set("8003", {
      id: 8003,
      status: "approved",
      external_reference: id,
      transaction_amount: 139,
      currency_id: "PEN",
    })
    await mpNotice("8003", null)
    expect((await call("lucia", "GET", `${base}/pedidos/${id}`)).json.order.state).toBe("por_pagar")
  })

  it("«Cobrar de verdad» vuelve a pedir permiso; Sofi tiene su medio y el link lleva el total", async () => {
    const { back } = await connect("real")
    expect(back.json.mode).toBe("real")
    // Cobrando de verdad, el link de prueba ya no se ofrece.
    expect((await call("rosa", "POST", `${base}/link-de-pago/prueba`)).json.error.code).toBe(
      "LINK_REAL_MODE",
    )
    const link = await call("lucia", "POST", `${base}/pedidos/${id}/link`)
    expect(link.json.url).toBe(`https://www.mercadopago.test/checkout?pref=${id}`)
    expect(mp.preferences.at(-1)).toMatchObject({
      external_reference: id,
      notification_url: `${SERVER}/avisos/link-de-pago/${storeId}`,
      items: [{ unit_price: 139, currency_id: "PEN", quantity: 1 }],
    })
    const count = mp.preferences.length
    const again = await call("lucia", "POST", `${base}/pedidos/${id}/link`)
    expect(again.json.url).toBe(link.json.url)
    expect(mp.preferences).toHaveLength(count)
  })

  it("si la cuenta tiene la clave de los avisos (la conectada antes), un aviso sin firma no cambia nada", async () => {
    await db.ownerDb
      .update(storePaymentLink)
      .set({ webhookSecretEnc: sealSecret(KEY, storeId, MP_SECRET) })
      .where(eq(storePaymentLink.storeId, storeId))
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

  it("el token se renueva antes de vencer, con el refresh_token", async () => {
    await db.ownerDb
      .update(storePaymentLink)
      .set({ expiresAt: new Date(Date.now() + 10 * 86_400_000) })
      .where(eq(storePaymentLink.storeId, storeId))
    expect(await renewPaymentLinks(db.ownerDb, linkDeps)).toEqual({ renewed: 1, failed: 0 })
    const [row] = await db.ownerDb
      .select()
      .from(storePaymentLink)
      .where(eq(storePaymentLink.storeId, storeId))
    expect(openSecret(KEY, storeId, row!.accessTokenEnc)).toBe(MP_TOKEN_RENEWED)
    expect(openSecret(KEY, storeId, row!.refreshTokenEnc!)).toBe("TG-renovado")
    expect(row!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 179 * 86_400_000)
    // Con el token renovado se sigue cobrando.
    const other = (
      await call("lucia", "POST", `${base}/pedidos`, order({ paymentMethodId: ids.link }))
    ).json.order.id
    expect((await call("lucia", "POST", `${base}/pedidos/${other}/link`)).status).toBe(200)
  })

  it("el aviso mp-connect se comprueba antes de creerlo; desvinculada, no se cobra por link", async () => {
    const notice = (userId: number | string) =>
      app.request(`${SERVER}/avisos/mercadopago`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "mp-connect",
          action: "application.deauthorized",
          user_id: userId,
        }),
      })
    // Mercado Pago todavía reconoce el token: el aviso no cambia nada.
    expect((await notice(77)).status).toBe(200)
    expect((await call("rosa", "GET", `${base}/link-de-pago`)).json.connection.state).toBe(
      "conectada",
    )
    mp.revoked = true
    expect((await notice(77)).status).toBe(200)
    const status = (await call("rosa", "GET", `${base}/link-de-pago`)).json
    expect(status.connection.state).toBe("sin_permiso")
    const other = (
      await call("lucia", "POST", `${base}/pedidos`, order({ paymentMethodId: ids.link }))
    ).json.order.id
    expect((await call("lucia", "POST", `${base}/pedidos/${other}/link`)).json.error.code).toBe(
      "LINK_NOT_CONNECTED",
    )
    mp.revoked = false
  })

  it("al desconectar, dice cuántos links enviados dejan de confirmarse solos y los olvida", async () => {
    await connect("real")
    const id = (
      await call("lucia", "POST", `${base}/pedidos`, order({ paymentMethodId: ids.link }))
    ).json.order.id
    await call("lucia", "POST", `${base}/pedidos/${id}/link`)
    expect((await call("lucia", "GET", `${base}/pedidos/${id}`)).json.order.linkUrl).toBeTruthy()
    expect((await call("rosa", "GET", `${base}/link-de-pago`)).json.openLinks).toBeGreaterThan(0)
    expect((await call("lucia", "DELETE", `${base}/link-de-pago`)).status).toBe(403)
    expect((await call("rosa", "DELETE", `${base}/link-de-pago`)).status).toBe(204)
    const detail = (await call("lucia", "GET", `${base}/pedidos/${id}`)).json.order
    expect(detail).toMatchObject({ linkUrl: null, linkConnected: false, linkTestMode: false })
    // Un aviso para una tienda sin cuenta conectada responde igual y no hace nada.
    expect((await mpNotice("9001")).json.message).toBe("Recibido")
  })
})

describe("el link de pago con las claves de la tienda (su Access Token, con un proveedor controlado)", () => {
  const status = async () => (await call("rosa", "GET", `${base}/link-de-pago`)).json
  const keys = (who: Who, mode: "prueba" | "real", accessToken: string, tryOnly = false) =>
    call(who, "POST", `${base}/link-de-pago/claves${tryOnly ? "/probar" : ""}`, {
      mode,
      accessToken,
    })

  it("solo quien configura prueba y conecta; Ventas no, ni para preguntar por un token", async () => {
    const calls = mp.usersMe
    expect((await keys("lucia", "prueba", KEYS_TEST, true)).status).toBe(403)
    expect((await keys("lucia", "prueba", KEYS_TEST)).status).toBe(403)
    expect((await keys("ajena", "prueba", KEYS_TEST, true)).status).toBe(404)
    expect(mp.usersMe).toBe(calls)
    expect((await status()).connection).toBeNull()
  })

  it("lo que no es el Access Token se dice en su campo, sin preguntar a Mercado Pago", async () => {
    const calls = mp.usersMe
    const publicKey = await keys(
      "rosa",
      "prueba",
      "APP_USR-9f8e7d6c-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
      true,
    )
    expect(publicKey.status).toBe(400)
    expect(publicKey.json.error.fields.accessToken).toContain("Public Key")
    const secret = await keys("rosa", "prueba", "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dF", true)
    expect(secret.json.error.fields.accessToken).toContain("Client Secret")
    const empty = await keys("rosa", "prueba", "   ", true)
    expect(empty.json.error.fields.accessToken).toContain("Access Token de prueba")
    const oldTest = await keys("rosa", "real", "TEST-1234567890-112233-abcdefabcdef-123456", true)
    expect(oldTest.json.error.fields.accessToken).toContain("de prueba")
    expect(mp.usersMe).toBe(calls)
    // Bien escrito, pero Mercado Pago no lo reconoce.
    const unknown = await keys("rosa", "prueba", "APP_USR-0000000000-000000-noexiste-000000", true)
    expect(unknown.status).toBe(400)
    expect(unknown.json.error.fields.accessToken).toContain("no reconoce")
  })

  it("«Probar» dice de qué cuenta es sin guardar; conectar empieza en prueba y el token no vuelve", async () => {
    const tried = await keys("rosa", "prueba", ` ${KEYS_TEST}\n`, true)
    expect(tried.status).toBe(200)
    expect(tried.json).toEqual({ account: "test_user_4512@…" })
    expect((await status()).connection).toBeNull()
    const saved = await keys("rosa", "prueba", KEYS_TEST)
    expect(saved.json).toEqual({ storeId, mode: "prueba", account: "test_user_4512@…" })
    const seen = await call("lucia", "GET", `${base}/link-de-pago`)
    expect(seen.json.connection).toMatchObject({
      via: "claves",
      state: "conectada",
      mode: "prueba",
      expiresAt: null,
    })
    expect(JSON.stringify(seen.json)).not.toContain(KEYS_TEST)
    const [row] = await db.ownerDb
      .select()
      .from(storePaymentLink)
      .where(eq(storePaymentLink.storeId, storeId))
    expect(row!.accessTokenEnc).not.toContain(KEYS_TEST)
    expect(openSecret(KEY, storeId, row!.accessTokenEnc)).toBe(KEYS_TEST)
    expect(row).toMatchObject({
      refreshTokenEnc: null,
      connectedWith: "claves",
      hint: KEYS_TEST.slice(-4),
    })
    // En prueba: el link de S/ 1 sí, los pedidos no.
    const trial = await call("rosa", "POST", `${base}/link-de-pago/prueba`)
    expect(trial.json.trial.url).toMatch(/^https:\/\/sandbox\.mercadopago\.test\//)
    const id = (
      await call("lucia", "POST", `${base}/pedidos`, order({ paymentMethodId: ids.link }))
    ).json.order.id
    expect((await call("lucia", "POST", `${base}/pedidos/${id}/link`)).json.error.code).toBe(
      "LINK_TEST_MODE",
    )
  })

  it("«Cobrar de verdad» pide el de producción: el de una cuenta de prueba no pasa", async () => {
    const test = await keys("rosa", "real", KEYS_TEST)
    expect(test.status).toBe(400)
    expect(test.json.error.fields.accessToken).toContain("prueba")
    expect((await status()).connection.mode).toBe("prueba")
    const real = await keys("rosa", "real", KEYS_REAL)
    expect(real.json).toEqual({ storeId, mode: "real", account: "rosa.quispe@…" })
    expect((await status()).connection).toMatchObject({ via: "claves", mode: "real" })
    const id = (
      await call("lucia", "POST", `${base}/pedidos`, order({ paymentMethodId: ids.link }))
    ).json.order.id
    const link = await call("lucia", "POST", `${base}/pedidos/${id}/link`)
    expect(link.json.url).toBe(`https://www.mercadopago.test/checkout?pref=${id}`)
    // El aviso va en cada link: la tienda no configura nada en su panel.
    expect(mp.preferences.at(-1)).toMatchObject({
      notification_url: `${SERVER}/avisos/link-de-pago/${storeId}`,
    })
    // Pagado por el link: se lee con el token de la tienda y queda pagado solo.
    mp.payments.set("9501", {
      id: 9501,
      status: "approved",
      external_reference: id,
      transaction_amount: 139,
      currency_id: "PEN",
    })
    await mpNotice("9501", null)
    expect((await call("lucia", "GET", `${base}/pedidos/${id}`)).json.order.state).toBe("por_salir")
  })

  it("no se renueva; si Mercado Pago deja de reconocerlo, al revisarlo queda «sin permiso»", async () => {
    expect(await renewPaymentLinks(db.ownerDb, linkDeps)).toEqual({ renewed: 0, failed: 0 })
    // Recién conectada no se vuelve a preguntar; pasado un día, sí.
    expect(await checkKeyLinks(db.ownerDb, linkDeps)).toEqual({ checked: 0, revoked: 0 })
    await db.ownerDb
      .update(storePaymentLink)
      .set({ checkedAt: new Date(Date.now() - 25 * 3_600_000) })
      .where(eq(storePaymentLink.storeId, storeId))
    expect(await checkKeyLinks(db.ownerDb, linkDeps)).toEqual({ checked: 1, revoked: 0 })
    await db.ownerDb
      .update(storePaymentLink)
      .set({ checkedAt: new Date(Date.now() - 25 * 3_600_000) })
      .where(eq(storePaymentLink.storeId, storeId))
    mp.revokedTokens.add(KEYS_REAL)
    expect(await checkKeyLinks(db.ownerDb, linkDeps)).toEqual({ checked: 1, revoked: 1 })
    expect((await status()).connection.state).toBe("sin_permiso")
    mp.revokedTokens.delete(KEYS_REAL)
  })

  it("si Mercado Pago no lo reconoce al usarlo, queda «sin permiso» y se vuelve a conectar", async () => {
    expect((await keys("rosa", "real", KEYS_REAL)).status).toBe(200)
    expect((await status()).connection.state).toBe("conectada")
    // Un aviso con el pago de otra cuenta da 401 al leerlo, pero el token sirve: no se desconecta.
    mp.foreignPayments.add("9901")
    expect((await mpNotice("9901", null)).json.message).toBe("Recibido")
    expect((await status()).connection.state).toBe("conectada")
    mp.revokedTokens.add(KEYS_REAL)
    const id = (
      await call("lucia", "POST", `${base}/pedidos`, order({ paymentMethodId: ids.link }))
    ).json.order.id
    const link = await call("lucia", "POST", `${base}/pedidos/${id}/link`)
    expect(link.json.error.code).toBe("LINK_REVOKED")
    expect((await status()).connection.state).toBe("sin_permiso")
    mp.revokedTokens.delete(KEYS_REAL)
    expect((await keys("rosa", "real", KEYS_REAL)).status).toBe(200)
    expect((await status()).connection.state).toBe("conectada")
    expect((await call("rosa", "DELETE", `${base}/link-de-pago`)).status).toBe(204)
  })

  it("sin la aplicación de gestorIA no se entra a la cuenta, pero sí se conecta con las claves", async () => {
    const bare = createApp({
      appDb: db.appDb,
      ownerDb: db.ownerDb,
      account: { url: ACCOUNT, eventsSecret: "", keys: accountKeys },
      webURL: WEB,
      link: { ...linkDeps, app: null },
    })
    const ask = async (method: string, path: string, body?: unknown) => {
      const response = await bare.request(`${SERVER}${path}`, {
        method,
        headers: {
          origin: WEB,
          authorization: `Bearer ${await tokenFor("rosa")}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      return { status: response.status, json: (await response.json().catch(() => ({}))) as Json }
    }
    expect((await ask("GET", `${base}/link-de-pago`)).json).toMatchObject({
      available: true,
      accountDoor: false,
      connection: null,
    })
    const started = await ask("POST", `${base}/link-de-pago/conectar`, { mode: "prueba" })
    expect(started.json.error.code).toBe("LINK_ACCOUNT_UNAVAILABLE")
    const saved = await ask("POST", `${base}/link-de-pago/claves`, {
      mode: "prueba",
      accessToken: KEYS_TEST,
    })
    expect(saved.json.mode).toBe("prueba")
    expect((await ask("DELETE", `${base}/link-de-pago`)).status).toBe(204)
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

  it("la captura del resto que no coincide: sigue por salir, le falta lo mismo y se le pide otra", async () => {
    const rest = await capture(3700, { methodId: ids.yape })
    expect(rest.json.order).toMatchObject({ state: "por_salir", paid: false })
    expect(rest.json.order.balance).toMatchObject({ pendingCents: 3700, dueCents: 0 })
    // Aparece en «Pago por confirmar» aunque el pedido ya salga.
    const waiting = await call("lucia", "GET", `${base}/pedidos?filtro=por_confirmar`)
    expect((waiting.json.orders as Json[]).some((o) => o.id === id)).toBe(true)
    const payment = (rest.json.order.payments as Json[]).find((p) => p.status === "por_confirmar")
    const rejected = await call(
      "lucia",
      "POST",
      `${base}/pedidos/${id}/pagos/${payment?.id}/revision`,
      { decision: "no_coincide", reason: "No llegó a la cuenta" },
    )
    expect(rejected.json.order).toMatchObject({ state: "por_salir", paid: false })
    expect(rejected.json.order.balance).toMatchObject({ pendingCents: 0, dueCents: 3700 })
    const notice = (rejected.json.order.events as Json[]).filter((e) => e.action === "aviso").at(-1)
    expect(String(notice?.detail.texto)).toContain("No pudimos confirmar el pago")
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
    // Cada pago con su medio; el que no coincidió queda en la lista, sin contar.
    expect(
      done.json.order.payments.map((p: Json) => [p.methodName, p.amountCents, p.status]),
    ).toEqual([
      ["Yape", 8000, "confirmado"],
      ["Yape", 3700, "no_coincide"],
      ["Efectivo", 3700, "confirmado"],
    ])
    expect(done.json.order.payments[2]).toMatchObject({ kind: "al_recibir", note: null })
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

describe("corregir sin anular (Andrea y Jorge, tableros 6 y 7)", () => {
  const v = { t37: "", t38: "", zonas: "" }
  let today = ""
  /** El día siguiente al de la tienda («2026-11-26»). */
  const tomorrow = () => {
    const d = new Date(`${today}T12:00:00Z`)
    d.setUTCDate(d.getUTCDate() + 1)
    return d.toISOString().slice(0, 10)
  }
  const andrea = (over: Json = {}) =>
    order({
      customerName: "Andrea Castillo",
      lines: [{ variantId: v.t37, quantity: 1 }],
      deliveryMethodId: v.zonas,
      zone: "Surco y Miraflores",
      ...over,
    })
  /** Anota y paga con una captura confirmada: el stock ya salió. */
  const paidOrder = async (over: Json = {}) => {
    const created = await call("lucia", "POST", `${base}/pedidos`, andrea(over))
    const id = created.json.order.id as string
    const form = new FormData()
    form.set("amountCents", String(created.json.order.totalCents))
    const sent = await call("lucia", "POST", `${base}/pedidos/${id}/comprobante`, undefined, form)
    await call(
      "lucia",
      "POST",
      `${base}/pedidos/${id}/pagos/${sent.json.order.payments[0].id}/revision`,
      {
        decision: "confirmar",
      },
    )
    return id
  }
  const change = (id: string, body: Json, path = "cambiar") =>
    call("lucia", "POST", `${base}/pedidos/${id}/${path}`, {
      lines: [{ variantId: v.t37, quantity: 1 }],
      deliveryMethodId: v.zonas,
      zone: "Surco y Miraflores",
      address: "Av. Primavera 123, Surco",
      deliverOn: null,
      ...body,
    })
  const stock = async (variantId: string) => (await stockOf(variantId)).stock as number
  /** Las pruebas de antes se llevan la 37: cada una que la necesita entra la suya. */
  const restock = (quantity: number) =>
    call("rosa", "POST", `${base}/variantes/${v.t37}/movimientos`, { kind: "entrada", quantity })

  beforeAll(async () => {
    today = (await call("lucia", "GET", `${base}/pedidos?filtro=hoy`)).json.today
    const sandalia = await call("rosa", "POST", `${base}/productos`, {
      name: "Sandalia beige",
      listPriceCents: 12900,
      options: [{ name: "Talla", values: ["37", "38"] }],
    })
    const variants = (await call("rosa", "GET", `${base}/productos/${sandalia.json.product.id}`))
      .json.product.variants as Json[]
    v.t37 = variants.find((x) => x.optionValues[0] === "37")!.id
    v.t38 = variants.find((x) => x.optionValues[0] === "38")!.id
    for (const [variantId, quantity] of [
      [v.t37, 3],
      [v.t38, 2],
    ] as const)
      await call("rosa", "POST", `${base}/variantes/${variantId}/movimientos`, {
        kind: "entrada",
        quantity,
      })
    v.zonas = (
      await call("rosa", "POST", `${base}/formas-de-entrega`, {
        name: "Reparto por zona",
        type: "DeliveryModeOwnFleet",
        cost: "por_zona",
        zones: [
          { name: "Surco y Miraflores", priceCents: 1000 },
          { name: "San Isidro y Lince", priceCents: 1200 },
          { name: "Centro", priceCents: 500 },
        ],
        acceptsPayOnDelivery: true,
      })
    ).json.method.id
  })

  let id = ""
  let number = ""
  it("«Cambiar» la talla y la zona de un pedido pagado: mismo número, el pago se queda y falta S/ 2", async () => {
    id = await paidOrder()
    expect([await stock(v.t37), await stock(v.t38)]).toEqual([2, 2])
    const to38 = {
      lines: [{ variantId: v.t38, quantity: 1 }],
      zone: "San Isidro y Lince",
      address: "Av. Rivera Navarrete 501, of. 802",
    }
    // La vista previa usa la misma operación y no guarda nada.
    const preview = await change(id, to38, "cambiar/calcular")
    expect(preview.json).toMatchObject({
      totalCents: 14100,
      balance: { confirmedCents: 13900, dueCents: 200, paid: false },
      stockPending: false,
    })
    expect(preview.json.changes).toContain("Sandalia beige 37 → 38")
    expect([await stock(v.t37), await stock(v.t38)]).toEqual([2, 2])
    const saved = await change(id, to38)
    expect(saved.status).toBe(200)
    number = saved.json.order.number
    expect(saved.json.order).toMatchObject({
      id,
      state: "por_salir",
      totalCents: 14100,
      deliveryZone: "San Isidro y Lince",
      address: "Av. Rivera Navarrete 501, of. 802",
      balance: { confirmedCents: 13900, dueCents: 200, overCents: 0 },
      stockPending: false,
    })
    expect(saved.json.order.payments).toHaveLength(1)
    expect(saved.json.order.payments[0].status).toBe("confirmado")
    expect(saved.json.order.lines).toHaveLength(1)
    expect(saved.json.order.lines[0].variantName).toBe("38")
    const changed = (saved.json.order.events as Json[]).find((e) => e.action === "cambiado")!
    expect(changed.detail.cambios).toEqual(
      expect.arrayContaining([
        "Sandalia beige 37 → 38",
        "entrega: Reparto por zona (Surco y Miraflores) → Reparto por zona (San Isidro y Lince)",
      ]),
    )
    expect(changed.detail.falta).toBe(200)
    expect([await stock(v.t37), await stock(v.t38)]).toEqual([3, 1])
  })

  it("cambiar dos veces: cada cambio con su referencia y el stock igual a lo que salió", async () => {
    const back = await change(id, { lines: [{ variantId: v.t37, quantity: 1 }] })
    expect(back.status).toBe(200)
    expect([await stock(v.t37), await stock(v.t38)]).toEqual([2, 2])
    const mine = (movements: Json[]) =>
      movements
        .filter((m) => String(m.reference).startsWith(`Pedido ${number}`))
        .map((m) => `${m.kind} ${m.quantity} ${m.reference}`)
        .reverse()
    expect(mine((await stockOf(v.t37)).movements)).toEqual([
      `venta -1 Pedido ${number}`,
      `anulacion 1 Pedido ${number} · cambio 1`,
      `venta -1 Pedido ${number} · cambio 2`,
    ])
    expect(mine((await stockOf(v.t38)).movements)).toEqual([
      `venta -1 Pedido ${number} · cambio 1`,
      `anulacion 1 Pedido ${number} · cambio 2`,
    ])
    // Anular después de cambiar devuelve lo que tiene fuera, una vez.
    const other = await paidOrder()
    await change(other, { lines: [{ variantId: v.t38, quantity: 1 }] })
    const before = [await stock(v.t37), await stock(v.t38)]
    await call("rosa", "POST", `${base}/pedidos/${other}/anular`, { reason: "Ya no lo quiere" })
    expect([await stock(v.t37), await stock(v.t38)]).toEqual([before[0], before[1]! + 1])
  })

  it("sin cambios no guarda, un precio bajo el mínimo no pasa y uno anulado no se cambia", async () => {
    // Lo mismo que ya tiene (la 37, a Surco) no es un cambio.
    const same = await change(id, {})
    expect(same.status).toBe(409)
    expect(same.json.error.code).toBe("NO_CHANGE")
    const cheap = await change(id, { lines: [{ variantId: v.t37, quantity: 1, unitCents: 100 }] })
    expect(cheap.status).toBe(400)
    const unpaid = (await call("lucia", "POST", `${base}/pedidos`, andrea())).json.order.id
    await call("lucia", "POST", `${base}/pedidos/${unpaid}/anular`, { reason: "Prueba de estados" })
    expect((await change(unpaid, { zone: "Centro" })).status).toBe(409)
  })

  it("si la talla nueva no tiene stock, se guarda igual y queda «falta stock»: solo frena al salir", async () => {
    const paid = await paidOrder()
    await call("rosa", "POST", `${base}/variantes/${v.t38}/movimientos`, {
      kind: "ajuste",
      counted: 0,
      reason: "Se dañaron en la vitrina",
    })
    const before37 = await stock(v.t37)
    const saved = await change(paid, { lines: [{ variantId: v.t38, quantity: 1 }] })
    expect(saved.status).toBe(200)
    expect(saved.json.order).toMatchObject({ state: "por_salir", stockPending: true })
    expect(await stock(v.t37)).toBe(before37 + 1)
    const out = await call("lucia", "POST", `${base}/pedidos/${paid}/salio`, {})
    expect(out.status).toBe(409)
    expect(out.json.error.code).toBe("NOT_ENOUGH_STOCK")
    await call("rosa", "POST", `${base}/variantes/${v.t38}/movimientos`, {
      kind: "entrada",
      quantity: 1,
    })
    expect(
      (await call("lucia", "POST", `${base}/pedidos/${paid}/salio`, {})).json.order.state,
    ).toBe("en_camino")
    expect(await stock(v.t38)).toBe(0)
  })

  it("si el total baja, lo que sobra de lo pagado queda en el saldo para revisarlo", async () => {
    const paid = await paidOrder()
    const saved = await change(paid, { zone: "Centro" })
    expect(saved.json.order).toMatchObject({
      totalCents: 13400,
      balance: { confirmedCents: 13900, dueCents: 0, overCents: 500 },
    })
    const changed = (saved.json.order.events as Json[]).find((e) => e.action === "cambiado")!
    expect(changed.detail.porRevisar).toMatch(/^Sobra S\/\s5 de lo pagado/)
  })

  it("antes de pagar, cambiar no mueve el stock", async () => {
    const created = (await call("lucia", "POST", `${base}/pedidos`, andrea())).json.order.id
    const before = [await stock(v.t37), await stock(v.t38)]
    const saved = await change(created, { lines: [{ variantId: v.t37, quantity: 2 }] })
    expect(saved.json.order).toMatchObject({ state: "por_pagar", totalCents: 26800 })
    expect([await stock(v.t37), await stock(v.t38)]).toEqual(before)
  })

  it("«No se entregó» vuelve a «Por salir» el día elegido, sin mover el stock", async () => {
    const jorge = (
      await call(
        "lucia",
        "POST",
        `${base}/pedidos`,
        andrea({ customerName: "Jorge Paredes", paymentMethodId: ids.efectivo, deliverOn: today }),
      )
    ).json.order.id
    await call("lucia", "POST", `${base}/pedidos/${jorge}/salio`, {})
    const before = await stock(v.t37)
    const past = await call("lucia", "POST", `${base}/pedidos/${jorge}/no-se-entrego`, {
      reason: "No contestó",
      deliverOn: "2020-01-01",
    })
    expect(past.status).toBe(400)
    expect(past.json.error.fields).toHaveProperty("deliverOn")
    const missed = await call("lucia", "POST", `${base}/pedidos/${jorge}/no-se-entrego`, {
      reason: "No contestó",
      deliverOn: tomorrow(),
    })
    expect(missed.json.order).toMatchObject({ state: "por_salir", deliverOn: tomorrow() })
    expect((missed.json.order.events as Json[]).at(-1)).toMatchObject({
      action: "no_entregado",
      detail: { motivo: "No contestó" },
    })
    expect(await stock(v.t37)).toBe(before)
    // Vuelve a salir sin descontar otra vez, y se cobra en la puerta.
    await call("lucia", "POST", `${base}/pedidos/${jorge}/salio`, {})
    expect(await stock(v.t37)).toBe(before)
    const done = await call("lucia", "POST", `${base}/pedidos/${jorge}/entregado`, {
      collectedCents: 13900,
    })
    expect(done.json.order.state).toBe("entregado")
  })

  it("«Pasar a…» cambia el día sin anular nada; uno en camino, no", async () => {
    await restock(2)
    const created = (await call("lucia", "POST", `${base}/pedidos`, andrea({ deliverOn: today })))
      .json.order.id
    const moved = await call("lucia", "POST", `${base}/pedidos/${created}/pasar-a`, {
      deliverOn: tomorrow(),
    })
    expect(moved.json.order).toMatchObject({ state: "por_pagar", deliverOn: tomorrow() })
    expect((moved.json.order.events as Json[]).at(-1)?.action).toBe("reprogramado")
    const again = await call("lucia", "POST", `${base}/pedidos/${created}/pasar-a`, {
      deliverOn: tomorrow(),
    })
    expect(again.status).toBe(409)
    const onTheWay = (
      await call("lucia", "POST", `${base}/pedidos`, andrea({ paymentMethodId: ids.efectivo }))
    ).json.order.id
    await call("lucia", "POST", `${base}/pedidos/${onTheWay}/salio`, {})
    const late = await call("lucia", "POST", `${base}/pedidos/${onTheWay}/pasar-a`, {
      deliverOn: tomorrow(),
    })
    expect(late.status).toBe(409)
    expect(late.json.error.message).toContain("No se entregó")
  })

  it("«Cambiar» no pasa un pedido a un día que ya pasó", async () => {
    await restock(1)
    const created = (await call("lucia", "POST", `${base}/pedidos`, andrea())).json.order.id
    const d = new Date(`${today}T12:00:00Z`)
    d.setUTCDate(d.getUTCDate() - 1)
    const late = await change(created, { deliverOn: d.toISOString().slice(0, 10) })
    expect(late.status).toBe(400)
    expect(late.json.error.fields).toMatchObject({ deliverOn: "Elige hoy o un día que viene" })
  })

  it("«Entregado» sin «Salió» deja las dos, con la misma hora", async () => {
    await restock(1)
    const created = (
      await call("lucia", "POST", `${base}/pedidos`, andrea({ paymentMethodId: ids.efectivo }))
    ).json.order.id
    const done = await call("lucia", "POST", `${base}/pedidos/${created}/entregado`, {
      collectedCents: 13900,
    })
    const steps = (done.json.order.events as Json[]).filter((e) =>
      ["salio", "entregado"].includes(e.action),
    )
    expect(steps.map((e) => e.action)).toEqual(["salio", "entregado"])
    expect(steps[0].createdAt).toBe(steps[1].createdAt)
  })
})

describe("deshacer la confirmación de un pago (tablero 7)", () => {
  it("con motivo, vuelve a «por confirmar»; si era lo único, el pedido espera y el stock vuelve", async () => {
    const id = (await call("lucia", "POST", `${base}/pedidos`, order())).json.order.id
    const form = new FormData()
    form.set("amountCents", "13900")
    const sent = await call("lucia", "POST", `${base}/pedidos/${id}/comprobante`, undefined, form)
    const paymentId = sent.json.order.payments[0].id
    await call("lucia", "POST", `${base}/pedidos/${id}/pagos/${paymentId}/revision`, {
      decision: "confirmar",
    })
    const sold = (await stockOf(ids.t38)).stock
    const noReason = await call(
      "rosa",
      "POST",
      `${base}/pedidos/${id}/pagos/${paymentId}/deshacer`,
      {
        reason: "",
      },
    )
    expect(noReason.status).toBe(400)
    const undone = await call("rosa", "POST", `${base}/pedidos/${id}/pagos/${paymentId}/deshacer`, {
      reason: "Lo confirmé en el pedido equivocado",
    })
    expect(undone.json.order).toMatchObject({
      state: "por_confirmar",
      balance: { confirmedCents: 0, pendingCents: 13900, dueCents: 0, paid: false },
    })
    expect(undone.json.order.payments[0]).toMatchObject({
      status: "por_confirmar",
      reviewedAt: null,
      note: "Se deshizo la confirmación: Lo confirmé en el pedido equivocado",
    })
    expect((undone.json.order.events as Json[]).at(-1)).toMatchObject({
      action: "pago_deshecho",
      detail: { motivo: "Lo confirmé en el pedido equivocado", stockDevuelto: 1 },
    })
    expect((await stockOf(ids.t38)).stock).toBe(sold + 1)
    // Se vuelve a confirmar y el stock baja otra vez, con la referencia del paso.
    const again = await call("lucia", "POST", `${base}/pedidos/${id}/pagos/${paymentId}/revision`, {
      decision: "confirmar",
    })
    expect(again.json.order).toMatchObject({ state: "por_salir", paid: true })
    expect((await stockOf(ids.t38)).stock).toBe(sold)
    const twice = await call("rosa", "POST", `${base}/pedidos/${id}/pagos/${paymentId}/deshacer`, {
      reason: "Otra vez",
    })
    expect(twice.status).toBe(200)
    expect(
      (
        await call("rosa", "POST", `${base}/pedidos/${id}/pagos/${paymentId}/deshacer`, {
          reason: "Una tercera",
        })
      ).status,
    ).toBe(409)
  })

  it("lo cobrado en la puerta no se deshace, ni el pago de un pedido entregado", async () => {
    const id = (
      await call("lucia", "POST", `${base}/pedidos`, order({ paymentMethodId: ids.efectivo }))
    ).json.order.id
    const done = await call("lucia", "POST", `${base}/pedidos/${id}/entregado`, {
      collectedCents: 13900,
    })
    const paymentId = done.json.order.payments[0].id
    const undo = await call("rosa", "POST", `${base}/pedidos/${id}/pagos/${paymentId}/deshacer`, {
      reason: "Me equivoqué",
    })
    expect(undo.status).toBe(409)
  })
})

describe("cambiar o devolver después de entregar (Andrea, tablero 17)", () => {
  const v = { s38: "", s39: "" }
  /** Un pedido entregado de una sandalia 38, cobrado en la puerta: S/ 129 + envío S/ 10. */
  const delivered = async () => {
    const created = await call(
      "lucia",
      "POST",
      `${base}/pedidos`,
      order({
        customerName: "Andrea Castillo",
        lines: [{ variantId: v.s38, quantity: 1 }],
        paymentMethodId: ids.efectivo,
      }),
    )
    const id = created.json.order.id as string
    const done = await call("lucia", "POST", `${base}/pedidos/${id}/entregado`, {
      collectedCents: created.json.order.totalCents,
    })
    expect(done.json.order.state).toBe("entregado")
    return { id, number: done.json.order.number as string }
  }
  const exchange = (id: string, body: Json = {}, path = "cambio") =>
    call("lucia", "POST", `${base}/pedidos/${id}/${path}`, {
      returns: [{ variantId: v.s38, quantity: 1 }],
      reason: "Le quedó chica",
      takes: [{ variantId: v.s39, quantity: 1 }],
      deliveryMethodId: ids.reparto,
      address: "Av. Rivera Navarrete 501, of. 802",
      ...body,
    })
  const stock = async (variantId: string) => (await stockOf(variantId)).stock as number

  beforeAll(async () => {
    const sandalia = await call("rosa", "POST", `${base}/productos`, {
      name: "Sandalia de verano",
      listPriceCents: 12900,
      options: [{ name: "Talla", values: ["38", "39"] }],
    })
    const variants = (await call("rosa", "GET", `${base}/productos/${sandalia.json.product.id}`))
      .json.product.variants as Json[]
    v.s38 = variants.find((x) => x.optionValues[0] === "38")!.id
    v.s39 = variants.find((x) => x.optionValues[0] === "39")!.id
    for (const variantId of [v.s38, v.s39])
      await call("rosa", "POST", `${base}/variantes/${variantId}/movimientos`, {
        kind: "entrada",
        quantity: 10,
      })
  })

  it("el cambio es un pedido nuevo enlazado; el entregado no cambia su total ni su pago", async () => {
    const original = await delivered()
    const preview = await exchange(original.id, {}, "cambio/calcular")
    expect(preview.status).toBe(200)
    expect(preview.json.summary).toMatchObject({
      backCents: 12900,
      takesCents: 12900,
      deliveryCents: 1000,
      totalCents: 1000,
      dueCents: 1000,
      refundCents: 0,
      paymentName: "Efectivo",
      payOnDelivery: true,
    })
    const [s38, s39] = [await stock(v.s38), await stock(v.s39)]
    const created = await exchange(original.id, { whatsapp: true })
    expect(created.status).toBe(201)
    expect(created.json.notice).toContain("anotamos tu cambio")
    const change = created.json.order
    expect(change).toMatchObject({
      state: "por_salir",
      totalCents: 1000,
      returnCreditCents: 12900,
      exchangeOf: { id: original.id, number: original.number },
      customerName: "Andrea Castillo",
      balance: { dueCents: 1000 },
    })
    expect(change.number).not.toBe(original.number)
    expect(change.lines).toHaveLength(1)
    expect(change.lines[0]).toMatchObject({ variantName: "39", unitCents: 12900 })
    expect(change.returns).toEqual([
      expect.objectContaining({
        variantName: "38",
        quantity: 1,
        unitCents: 12900,
        returnedAt: null,
      }),
    ])
    const notice = (change.events as Json[]).find((e) => e.action === "aviso")!
    expect(notice.detail).toMatchObject({ tipo: "cambio", enviado: false, abierto: true })
    // El entregado: el mismo total y el mismo pago, con el cambio en su historia.
    const after = (await call("lucia", "GET", `${base}/pedidos/${original.id}`)).json.order
    expect(after).toMatchObject({ state: "entregado", totalCents: 13900, returnable: [] })
    expect(after.payments).toHaveLength(1)
    expect(after.exchanges).toEqual([{ id: change.id, number: change.number, state: "por_salir" }])
    expect((after.events as Json[]).at(-1)).toMatchObject({
      action: "cambio",
      detail: { pedido: change.number, motivo: "Le quedó chica" },
    })
    // Nada se mueve hasta que el cambio sale y vuelve.
    expect([await stock(v.s38), await stock(v.s39)]).toEqual([s38, s39])
    await call("lucia", "POST", `${base}/pedidos/${change.id}/salio`, {})
    expect([await stock(v.s38), await stock(v.s39)]).toEqual([s38, s39 - 1])
    const report = async () => (await call("rosa", "GET", `${base}/reportes?periodo=mes`)).json
    const sold = (await report()).sold
    const done = await call("lucia", "POST", `${base}/pedidos/${change.id}/entregado`, {
      collectedCents: 1000,
    })
    expect(done.status).toBe(200)
    // Lo cobrado del cambio suma a lo vendido, pero el cambio no es otro pedido.
    const soldAfter = (await report()).sold
    expect(soldAfter.cents - sold.cents).toBe(1000)
    expect(soldAfter.orders).toBe(sold.orders)
    expect(done.json.order.returns[0].returnedAt).not.toBeNull()
    expect((done.json.order.events as Json[]).find((e) => e.action === "entregado")).toMatchObject({
      detail: { volvio: ["Sandalia de verano 38"] },
    })
    // La 38 vuelve como «devolución», con su motivo y la referencia del cambio.
    const kardex = await stockOf(v.s38)
    expect(kardex.stock).toBe(s38 + 1)
    expect(kardex.movements[0]).toMatchObject({
      kind: "devolucion",
      quantity: 1,
      reason: "Le quedó chica",
      reference: `Pedido ${change.number}`,
    })
  })

  it("lo que ya vuelve en un cambio no vuelve dos veces; anulado el cambio, sí", async () => {
    const original = await delivered()
    const first = await exchange(original.id)
    expect(first.status).toBe(201)
    const twice = await exchange(original.id)
    expect(twice.status).toBe(400)
    expect(twice.json.error.fields["returns.0.quantity"]).toBe("Ya vuelve en otro cambio")
    const cancelled = await call("lucia", "POST", `${base}/pedidos/${first.json.order.id}/anular`, {
      reason: "Al final se la queda",
    })
    expect(cancelled.json.order.state).toBe("anulado")
    const back = (await call("lucia", "GET", `${base}/pedidos/${original.id}`)).json.order
    expect(back.returnable).toEqual([{ variantId: v.s38, quantity: 1 }])
    expect((await exchange(original.id)).status).toBe(201)
  })

  it("una devolución, con el envío de la tienda: el total queda bajo cero y sobra lo pagado", async () => {
    const original = await delivered()
    const created = await exchange(original.id, {
      takes: [],
      reason: "Llegó fallado",
      storePaysDelivery: true,
    })
    expect(created.status).toBe(201)
    expect(created.json.notice).toContain("anotamos tu devolución")
    expect(created.json.order).toMatchObject({
      state: "por_salir",
      lines: [],
      deliveryCents: 0,
      deliveryListCents: 1000,
      totalCents: -12900,
      balance: { dueCents: 0, overCents: 12900 },
    })
    // «Anotar la devolución»: no más de lo que sobra, con su medio y quién lo devolvió.
    const id = created.json.order.id as string
    const before = (await call("rosa", "GET", `${base}/reportes?periodo=mes`)).json
    const tooMuch = await call("lucia", "POST", `${base}/pedidos/${id}/devolucion`, {
      amountCents: 20000,
    })
    expect(tooMuch.status).toBe(400)
    expect(tooMuch.json.error.fields).toHaveProperty("amountCents")
    const refunded = await call("lucia", "POST", `${base}/pedidos/${id}/devolucion`, {
      amountCents: 12900,
      methodId: ids.yape,
    })
    expect(refunded.status).toBe(200)
    expect(refunded.json.order).toMatchObject({
      balance: { dueCents: 0, overCents: 0, refundedCents: 12900, paid: true },
      refunds: [expect.objectContaining({ amountCents: 12900, methodName: "Yape" })],
    })
    expect(refunded.json.order.refunds[0].createdByName).toBe("Lucía Torres")
    expect((refunded.json.order.events as Json[]).at(-1)).toMatchObject({
      action: "dinero_devuelto",
      detail: { monto: 12900, medio: "Yape" },
    })
    const again = await call("lucia", "POST", `${base}/pedidos/${id}/devolucion`, {
      amountCents: 100,
    })
    expect(again.status).toBe(409)
    // Lo devuelto ya salió de la caja: el cambio no se anula, y Reportes deja de contarlo.
    const cancel = await call("rosa", "POST", `${base}/pedidos/${id}/anular`, {
      reason: "Me equivoqué",
    })
    expect(cancel.status).toBe(409)
    const after = (await call("rosa", "GET", `${base}/reportes?periodo=mes`)).json
    expect(after.sold.refundedCents - before.sold.refundedCents).toBe(12900)
    expect(before.sold.cents - after.sold.cents).toBe(12900)
  })

  it("un cambio no se «Cambia», y un pedido sin entregar no tiene cambio", async () => {
    const original = await delivered()
    const created = await exchange(original.id)
    const change = await call("lucia", "POST", `${base}/pedidos/${created.json.order.id}/cambiar`, {
      lines: [{ variantId: v.s39, quantity: 2 }],
      deliveryMethodId: ids.reparto,
      address: "",
      deliverOn: null,
    })
    expect(change.status).toBe(409)
    expect(change.json.error.code).toBe("EXCHANGE")
    const open = await call(
      "lucia",
      "POST",
      `${base}/pedidos`,
      order({ lines: [{ variantId: v.s38, quantity: 1 }] }),
    )
    expect((await exchange(open.json.order.id)).status).toBe(409)
  })

  it("solo vuelve lo que se entregó, y otra cuenta no crea cambios en la tienda", async () => {
    const original = await delivered()
    const wrong = await exchange(original.id, { returns: [{ variantId: v.s39, quantity: 1 }] })
    expect(wrong.status).toBe(400)
    expect(wrong.json.error.fields).toHaveProperty(["returns.0.variantId"])
    const more = await exchange(original.id, { returns: [{ variantId: v.s38, quantity: 2 }] })
    expect(more.json.error.fields["returns.0.quantity"]).toBe("Vuelve 1 como máximo")
    const other = await call("ajena", "POST", `${base}/pedidos/${original.id}/cambio`, {
      returns: [{ variantId: v.s38, quantity: 1 }],
      reason: "Le quedó chica",
      deliveryMethodId: ids.reparto,
    })
    expect([403, 404]).toContain(other.status)
  })
})

describe("el envío por distrito (lienzo «gestorIA · Configuración, de nuevo», tablero 7)", () => {
  it("la plantilla de Lima la usa quien configura; el distrito dice la zona y su precio", async () => {
    const denied = await call("lucia", "POST", `${base}/entregas/plantilla-lima`, {
      shipFrom: "150115",
    })
    expect(denied.status).toBe(403)
    const used = await call("rosa", "POST", `${base}/entregas/plantilla-lima`, {
      shipFrom: "150115",
    })
    expect(used.status).toBe(200)
    expect(used.json.method.id).toBe(ids.reparto)
    const setup = await call("lucia", "GET", `${base}/entregas`)
    expect(setup.json.shipFrom).toBe("150115")
    const zones = setup.json.deliveries.find((d: Json) => d.id === ids.reparto).zones as Json[]
    expect(zones.map((z) => z.name)).toEqual([
      "Centro y Lima Moderna",
      "Lima Este",
      "Lima Norte",
      "Lima Sur",
      "Callao",
      "Lejanos y playas",
    ])
    expect(zones.flatMap((z) => z.districts as string[])).toHaveLength(50)

    // Lince (zona 1) a S/ 10; Lurín (lejanos) a S/ 18.
    const lince = await call("lucia", "POST", `${base}/pedidos/calcular`, {
      ...order(),
      district: "150116",
    })
    expect(lince.json.quote).toMatchObject({ deliveryListCents: 1000, deliveryCents: 1000 })
    const lurin = await call("lucia", "POST", `${base}/pedidos/calcular`, {
      ...order(),
      district: "150119",
    })
    expect(lurin.json.quote).toMatchObject({ deliveryListCents: 1800, deliveryCents: 1800 })
    // En «Lejanos y playas» no se paga al recibir.
    const door = await call("lucia", "POST", `${base}/pedidos/calcular`, {
      ...order(),
      district: "150119",
      paymentMethodId: ids.efectivo,
    })
    expect(door.json.quote).toBeNull()
    expect(door.json.fields.paymentMethodId).toBe("En «Lejanos y playas» no se paga al recibir")
  })

  it("un distrito está en una sola zona de la tienda", async () => {
    const other = await call("rosa", "POST", `${base}/formas-de-entrega`, {
      name: "Moto express",
      type: "DeliveryModeOwnFleet",
      cost: "por_zona",
      zones: [{ name: "Lince", priceCents: 1500, districts: ["150116"] }],
    })
    expect(other.status).toBe(409)
    expect(JSON.stringify(other.json)).toContain("Lince ya está en «Reparto en Lima»")
    // Dos zonas de la misma forma tampoco lo comparten.
    const twice = await call("rosa", "POST", `${base}/formas-de-entrega`, {
      name: "Moto express",
      type: "DeliveryModeOwnFleet",
      cost: "por_zona",
      zones: [
        { name: "A", priceCents: 1500, districts: ["070101"] },
        { name: "B", priceCents: 1500, districts: ["070101"] },
      ],
    })
    expect(twice.status).toBe(400)
  })

  it("dos pestañas: guardar una zona toca solo esa, y lo visto viejo no pisa lo nuevo", async () => {
    const path = `${base}/formas-de-entrega/${ids.reparto}`
    const read = async () =>
      (await call("rosa", "GET", `${base}/entregas`)).json.deliveries.find(
        (d: Json) => d.id === ids.reparto,
      ) as Json
    // Las dos pestañas abren lo mismo.
    const seen = await read()
    const zoneOf = (method: Json, code: string) =>
      (method.zones as Json[]).find((z) => (z.districts as string[]).includes(code))?.name ?? null
    expect(zoneOf(seen, "150140")).toBe("Centro y Lima Moderna")
    // La B saca Surco.
    const b = await call("rosa", "PATCH", `${path}/zonas`, {
      op: "distrito",
      district: "150140",
      from: "Centro y Lima Moderna",
      to: null,
    })
    expect(b.status).toBe(200)
    // La A, sin recargar, saca Cieneguilla: Surco sigue fuera.
    const a = await call("rosa", "PATCH", `${path}/zonas`, {
      op: "distrito",
      district: "150109",
      from: zoneOf(seen, "150109"),
      to: null,
    })
    expect(a.status).toBe(200)
    const after = await read()
    expect(zoneOf(after, "150140")).toBeNull()
    expect(zoneOf(after, "150109")).toBeNull()
    // La A vuelve a poner Surco en la zona 1 como si siguiera ahí: se rechaza, no se adivina.
    const stale = await call("rosa", "PATCH", `${path}/zonas`, {
      op: "distrito",
      district: "150140",
      from: "Centro y Lima Moderna",
      to: "Lima Sur",
    })
    expect(stale.status).toBe(409)
    expect(stale.json.error.code).toBe("STALE")
    expect(stale.json.error.message).toContain("Recarga")
    // Editar una zona con lo visto viejo (la B cambió su precio): 409, y nada cambia.
    const centro = (seen.zones as Json[])[0]!
    const priced = await call("rosa", "PATCH", `${path}/zonas`, {
      op: "zona",
      before: "Lima Este",
      seen: (after.zones as Json[])[1],
      zone: { ...(after.zones as Json[])[1], priceCents: 1300 },
    })
    expect(priced.status).toBe(200)
    const old = await call("rosa", "PATCH", `${path}/zonas`, {
      op: "zona",
      before: "Centro y Lima Moderna",
      seen: centro,
      zone: { ...centro, priceCents: 900 },
    })
    expect(old.status).toBe(409)
    // Guardar la forma entera sobre una versión vieja (o sin versión) tampoco pisa.
    const whole = { ...seen, version: seen.updatedAt }
    for (const body of [whole, { ...seen }]) {
      const res = await call("rosa", "PATCH", path, body)
      expect(res.status).toBe(409)
    }
    const now = await read()
    expect(zoneOf(now, "150140")).toBeNull()
    expect((now.zones as Json[])[1]!.priceCents).toBe(1300)
    // Con la versión de ahora, sí; encender o apagar no la pide.
    expect((await call("rosa", "PATCH", path, { ...now, version: now.updatedAt })).status).toBe(200)
    expect((await call("rosa", "PATCH", path, { isActive: true })).status).toBe(200)
    // Ventas no cambia zonas.
    const denied = await call("lucia", "PATCH", `${path}/zonas`, {
      op: "distrito",
      district: "150140",
      from: null,
      to: "Centro y Lima Moderna",
    })
    expect(denied.status).toBe(403)
    // Se deja como estaba.
    for (const [district, to] of [
      ["150140", "Centro y Lima Moderna"],
      ["150109", zoneOf(seen, "150109")],
    ] as const)
      expect(
        (await call("rosa", "PATCH", `${path}/zonas`, { op: "distrito", district, from: null, to }))
          .status,
      ).toBe(200)
  })

  it("quién paga el viaje fallido lo cambia quien configura", async () => {
    const denied = await call("lucia", "PATCH", `${base}/entregas/reglas`, {
      failedTrip: "clienta",
    })
    expect(denied.status).toBe(403)
    const done = await call("rosa", "PATCH", `${base}/entregas/reglas`, { failedTrip: "clienta" })
    expect(done.status).toBe(200)
    expect((await call("lucia", "GET", `${base}/entregas`)).json.failedTrip).toBe("clienta")
  })
})

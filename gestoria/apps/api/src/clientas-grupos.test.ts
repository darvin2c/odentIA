/**
 * Los grupos de clientas contra una base real: el grupo calculado con pedidos de verdad (las
 * fechas de compra se mueven con el dueño de la base, como si fueran de días pasados), la vuelta
 * de la noche con la hora de la tienda, lo calculado en el momento para lo que cambió, los filtros
 * de la lista, lo que quiso y no compró, los grupos guardados y las reglas de la base (otra tienda
 * no ve nada, la aplicación no escribe `customer_profile`, los agentes no guardan grupos).
 */
import { randomUUID } from "node:crypto"
import {
  conversation,
  conversationMessage,
  customerFact,
  customerGroup,
  customerProfile,
  type Db,
  orderPayment,
  productPromotion,
  saleOrder,
  stockRequest,
  store,
  storeDeliveryMethod,
  storeMember,
  storeSupportAccess,
  withPerson,
} from "@gestoria/db"
import { startTestDb, type TestDb } from "@gestoria/db/testing"
import { eq, sql } from "drizzle-orm"
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ARGOS_ACTOR, SOFI_ACTOR, withAgent } from "./agente.js"
import { createApp } from "./app.js"
import { recalculateStore, runNightlyProfiles } from "./clientas-grupos.js"
import { addDays, dayIn, startOfDay } from "./hora.js"
import { addReceiptIn, createOrderIn, orderInput } from "./pedidos.js"

const ACCOUNT = "https://api.gestoria.test"
const WEB = "https://app.gestoria.test"
const SERVER = "https://servidor.gestoria.test"
const HOUR = 3_600_000
const DAY = 86_400_000
const LIMA = "America/Lima"

let db: TestDb
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"]
let app: ReturnType<typeof createApp>

const people = {
  rosa: { id: "u-rosa", email: "rosa@calzados.test", name: "Rosa Quispe" },
  lucia: { id: "u-lucia", email: "lucia@calzados.test", name: "Lucía Torres" },
  ajena: { id: "u-ajena", email: "ajena@otra.test", name: "Ajena" },
  soporte: {
    id: "u-soporte",
    email: "soporte@gestoria.test",
    name: "Ana de Soporte",
    staffVerified: true,
  },
}
type Who = keyof typeof people
const storeId = randomUUID()
const otherStore = randomUUID()
const base = `/api/tiendas/${storeId}`

// biome-ignore lint/suspicious/noExplicitAny: las pruebas leen respuestas JSON de forma libre
type Json = Record<string, any>

async function tokenFor(who: Who) {
  const p = people[who] as { id: string; email: string; name: string; staffVerified?: boolean }
  const iat = Math.floor(Date.now() / 1000)
  return new SignJWT({
    email: p.email,
    emailVerified: true,
    name: p.name,
    image: null,
    ...(p.staffVerified ? { staffVerified: true } : {}),
  })
    .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
    .setSubject(p.id)
    .setIssuer(ACCOUNT)
    .setAudience("gestoria")
    .setIssuedAt(iat)
    .setExpirationTime(iat + 900)
    .sign(privateKey)
}

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

const ids = { yape: "", reparto: "", beige37: "", negra38: "", botin40: "", botin43: "" }
const fichas = { andrea: "", lorena: "", paola: "", jimena: "", nueva: "" }
const chats = { andrea: "", jimena: "" }
let operation = 1000

/* ---------------------------------------------------------------- ayudas */

async function chat(name: string) {
  const [row] = await db.ownerDb
    .insert(conversation)
    .values({ storeId, channel: "whatsapp", customerName: name, createdBy: "canal" })
    .returning({ id: conversation.id })
  return row!.id
}

/**
 * Una compra: la arma Sofi en el chat (o Lucía, con un precio acordado), se anota su captura y Rosa
 * la confirma (una compra es un pedido pagado). Con `confirm: false` la captura queda por
 * confirmar. `daysAgo` la mueve a ese día con el dueño de la base, como si fuera de entonces.
 */
async function sale(input: {
  name?: string
  customerId?: string
  conversationId?: string
  variantId: string
  /** Más de un producto: cada variante, una vez. */
  more?: string[]
  unitCents?: number
  daysAgo?: number
  paid?: boolean
  confirm?: boolean
  paymentMethodId?: string
  zone?: string
}) {
  const by = input.conversationId && !input.unitCents ? SOFI_ACTOR : "u-lucia"
  const run = async (tx: Db) => {
    const order = await createOrderIn(
      tx,
      storeId,
      by,
      orderInput.parse({
        customerId: input.customerId ?? null,
        customerName: input.name ?? "",
        channel: "whatsapp",
        address: "Av. Primavera 123",
        lines: [
          { variantId: input.variantId, quantity: 1, unitCents: input.unitCents ?? null },
          ...(input.more ?? []).map((variantId) => ({ variantId, quantity: 1, unitCents: null })),
        ],
        deliveryMethodId: ids.reparto,
        zone: input.zone ?? "Surco",
        paymentMethodId: input.paymentMethodId ?? ids.yape,
      }),
      { conversationId: input.conversationId ?? null },
    )
    if (input.paid !== false)
      await addReceiptIn(tx, storeId, by, order.id, {
        amountCents: order.totalCents,
        operation: String(++operation),
      })
    return order
  }
  const order =
    by === SOFI_ACTOR
      ? await withAgent(db.appDb, SOFI_ACTOR, storeId, run)
      : await withPerson(db.appDb, { userId: "u-lucia", email: people.lucia.email, storeId }, run)
  if (input.paid !== false && input.confirm !== false) await confirm(order.id)
  if (input.daysAgo)
    await db.ownerDb
      .update(saleOrder)
      .set({ createdAt: new Date(Date.now() - input.daysAgo * DAY) })
      .where(eq(saleOrder.id, order.id))
  return order
}

/** Rosa confirma la captura por confirmar del pedido. */
async function confirm(orderId: string) {
  const [payment] = await db.ownerDb
    .select({ id: orderPayment.id })
    .from(orderPayment)
    .where(eq(orderPayment.orderId, orderId))
  const done = await call(
    "rosa",
    "POST",
    `${base}/pedidos/${orderId}/pagos/${payment!.id}/revision`,
    { decision: "confirmar" },
  )
  expect(done.status).toBe(200)
}

const list = async (query = "", who: Who = "lucia") => call(who, "GET", `${base}/clientes${query}`)
const row = (customers: Json[], id: string) => customers.find((c) => c.id === id)

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
    { id: storeId, name: "Calzados Rosa", currency: "PEN", country: "PE", createdBy: "u-rosa" },
    { id: otherStore, name: "Otra tienda", currency: "PEN", createdBy: "u-ajena" },
  ])
  await db.ownerDb.insert(storeMember).values([
    { storeId, userId: "u-rosa", role: "owner" },
    { storeId, userId: "u-lucia", role: "sales", addedBy: "u-rosa" },
    { storeId: otherStore, userId: "u-ajena", role: "owner" },
  ])
  const at = new Date()
  await db.ownerDb.insert(storeSupportAccess).values({
    storeId,
    staffUserId: "u-soporte",
    staffName: "Ana de Soporte",
    minutes: 30,
    reason: "Revisar las fichas",
    state: "aceptado",
    requestExpiresAt: new Date(at.getTime() + HOUR),
    answeredAt: at,
    answeredBy: "u-rosa",
    expiresAt: new Date(at.getTime() + HOUR),
  })
  ids.yape = (
    await call("rosa", "POST", `${base}/medios-de-pago`, {
      name: "Yape",
      typeCode: "68",
      collection: "comprobante",
    })
  ).json.method.id
  ids.reparto = (
    await call("rosa", "POST", `${base}/formas-de-entrega`, {
      name: "Reparto en Lima",
      type: "DeliveryModeOwnFleet",
      cost: "por_zona",
      zones: [
        { name: "Surco", priceCents: 1000, payOnDelivery: true },
        { name: "San Isidro", priceCents: 1000 },
      ],
    })
  ).json.method.id
  const sandalia = await call("rosa", "POST", `${base}/productos`, {
    name: "Sandalia",
    category: "Sandalias",
    listPriceCents: 10000,
    minPriceCents: 8000,
    options: [
      { name: "Color", values: ["beige", "negra"] },
      { name: "Talla", values: ["37", "38"] },
    ],
  })
  const botin = await call("rosa", "POST", `${base}/productos`, {
    name: "Botín",
    category: "Botines",
    listPriceCents: 20000,
    options: [{ name: "Talla", values: ["40", "43"] }],
  })
  const variants = [
    ...(await call("rosa", "GET", `${base}/productos/${sandalia.json.product.id}`)).json.product
      .variants,
    ...(await call("rosa", "GET", `${base}/productos/${botin.json.product.id}`)).json.product
      .variants,
  ] as Json[]
  const of = (values: string) =>
    variants.find((v) => (v.optionValues as string[]).join(" ") === values)!.id as string
  ids.beige37 = of("beige 37")
  ids.negra38 = of("negra 38")
  ids.botin40 = of("40")
  ids.botin43 = of("43")
  for (const variantId of [ids.beige37, ids.negra38, ids.botin40])
    await call("rosa", "POST", `${base}/variantes/${variantId}/movimientos`, {
      kind: "entrada",
      quantity: 30,
    })
  // El botín está en liquidación esta semana (la promoción de la tienda, vigente hoy).
  const today = dayIn(LIMA)
  await db.ownerDb.insert(productPromotion).values({
    storeId,
    productId: botin.json.product.id,
    name: "Liquidación de botines",
    percentOff: 30,
    startsOn: addDays(today, -1),
    endsOn: addDays(today, 1),
  })

  // Andrea: compraba cada 40 días y ya van 62 (en riesgo), siempre sandalias beige 37.
  chats.andrea = await chat("Andrea Castillo")
  const first = await sale({
    name: "Andrea Castillo",
    conversationId: chats.andrea,
    variantId: ids.beige37,
    daysAgo: 142,
    zone: "San Isidro",
  })
  fichas.andrea = first.customerId!
  for (const daysAgo of [102, 62])
    await sale({
      conversationId: chats.andrea,
      variantId: ids.beige37,
      daysAgo,
      zone: "San Isidro",
    })
  // Lorena pide rebaja: dos de tres compras con precio acordado.
  const lorena = await sale({ name: "Lorena Vargas", variantId: ids.negra38, unitCents: 9000 })
  fichas.lorena = lorena.customerId!
  await sale({ customerId: fichas.lorena, variantId: ids.negra38, unitCents: 8500, daysAgo: 30 })
  await sale({ customerId: fichas.lorena, variantId: ids.negra38, daysAgo: 60 })
  // Paola compra en liquidación: los dos botines con la promoción de esta semana.
  const paola = await sale({ name: "Paola Chávez", variantId: ids.botin40 })
  fichas.paola = paola.customerId!
  await sale({ customerId: fichas.paola, variantId: ids.botin40 })
  // Jimena todavía no compra: dejó un pedido sin pagar hace dos días y pidió el botín 43 agotado.
  chats.jimena = await chat("Jimena Paredes")
  const jimena = await sale({
    name: "Jimena Paredes",
    conversationId: chats.jimena,
    variantId: ids.beige37,
    paid: false,
    daysAgo: 2,
  })
  fichas.jimena = jimena.customerId!
  await db.ownerDb
    .insert(stockRequest)
    .values({ storeId, variantId: ids.botin43, conversationId: chats.jimena })
  // El distrito sale solo de su perfil (la zona de reparto no es un distrito): la tienda lo anotó.
  await db.ownerDb.insert(customerFact).values({
    storeId,
    customerId: fichas.andrea!,
    key: "distrito",
    value: "San Isidro",
    source: "tienda",
    actorUserId: "persona-de-prueba",
  })
}, 240_000)

afterAll(async () => {
  await db?.stop()
})

describe("el grupo calculado", () => {
  it("la vuelta de la tienda guarda el grupo y lo de cada ficha", async () => {
    expect(await recalculateStore(db.ownerDb, storeId)).toBe(4)
    const rows = await db.ownerDb
      .select()
      .from(customerProfile)
      .where(eq(customerProfile.storeId, storeId))
    const andrea = rows.find((r) => r.customerId === fichas.andrea)!
    expect(andrea).toMatchObject({
      segment: "riesgo",
      why: "Compraba cada 40 días y ya van 62.",
      ordersCount: 3,
      rhythmDays: 40,
      lastBoughtOn: addDays(dayIn(LIMA), -62),
      measures: ["37"],
      categories: ["Sandalias"],
      districts: ["San Isidro"],
      priceSensitivity: null,
      computedFor: dayIn(LIMA),
    })
    expect(rows.find((r) => r.customerId === fichas.lorena)).toMatchObject({
      segment: "frecuente",
      priceSensitivity: "rebaja",
    })
    expect(rows.find((r) => r.customerId === fichas.paola)).toMatchObject({
      segment: "frecuente",
      priceSensitivity: "liquidacion",
    })
    expect(rows.find((r) => r.customerId === fichas.jimena)).toMatchObject({
      segment: "sin_compras",
      ordersCount: 0,
      lastBoughtOn: null,
    })
  })

  it("la lista lo muestra con lo que ya devolvía", async () => {
    const { status, json } = await list()
    expect(status).toBe(200)
    const andrea = row(json.customers, fichas.andrea)!
    expect(andrea).toMatchObject({
      name: "Andrea Castillo",
      segment: "riesgo",
      segmentWhy: "Compraba cada 40 días y ya van 62.",
      ordersCount: 3,
      lastBoughtDays: 62,
      measure: "37",
      district: "San Isidro",
      consent: "sin_preguntar",
      dueCents: 0,
    })
    expect(andrea.totalCents).toBe(3 * (10_000 + 1000))
    expect(json.measureLabel).toBe("Talla")
    expect(json.facets.segments).toEqual({
      vip: 0,
      frecuente: 2,
      nueva: 0,
      riesgo: 1,
      dormida: 0,
      perdida: 0,
      sin_compras: 1,
    })
    expect(json.facets.categories).toEqual(["Sandalias", "Botines"])
  })

  it("la ficha calcula lo mismo, en vivo, con lo que quiso y no compró", async () => {
    // Sofi le cotizó a Jimena y no terminó en pedido.
    const key = JSON.stringify([
      [[ids.botin40, 1, null, false]],
      ids.reparto,
      "Surco",
      null,
      null,
      15_000,
    ])
    await db.ownerDb.insert(conversationMessage).values({
      storeId,
      conversationId: chats.jimena,
      author: "sofi",
      text: "Te queda en S/ 150 con envío.",
      delivery: "sin_enviar",
      detail: { quotes: [key] },
      actorUserId: SOFI_ACTOR,
    })
    const andrea = (await call("lucia", "GET", `${base}/clientes/${fichas.andrea}`)).json.customer
    expect(andrea.computed).toMatchObject({
      segment: "riesgo",
      ordersCount: 3,
      rhythmDays: 40,
      lastBoughtDays: 62,
      categories: [["Sandalias", 3]],
      colors: [["beige", 3]],
      measures: [["37", 3]],
      wanted: [],
    })
    expect(andrea.whoLine).toBe("compra sandalias beige en talla 37 · San Isidro")
    const jimena = (await call("lucia", "GET", `${base}/clientes/${fichas.jimena}`)).json.customer
    expect(jimena.computed.segment).toBe("sin_compras")
    const kinds = (jimena.computed.wanted as Json[]).map((w) => [w.kind, w.text])
    expect(kinds).toContainEqual(["agotado", "Botín · 43"])
    expect(kinds.find(([kind]) => kind === "cotizo")?.[1]).toMatch(/^Botín · 40 · S\/\s150$/)
    // Su pedido sin pagar es de hace dos días: ya no es un carrito.
    expect(kinds.some(([kind]) => kind === "carrito")).toBe(false)
    // Lo último que quiso fue lo que le cotizó Sofi.
    expect(jimena.whoLine).toBe("preguntó por botín · 40")
    // Cada compra dice si salió con rebaja o en liquidación.
    const lorena = (await call("lucia", "GET", `${base}/clientes/${fichas.lorena}`)).json.customer
    expect((lorena.orders as Json[]).map((o) => o.priceNote).sort()).toEqual(
      ["rebaja", "rebaja", null].sort(),
    )
    const paola = (await call("lucia", "GET", `${base}/clientes/${fichas.paola}`)).json.customer
    expect((paola.orders as Json[]).map((o) => o.priceNote)).toEqual(["liquidacion", "liquidacion"])
  })

  it("lo que cambió después de la vuelta se calcula en el momento", async () => {
    // Una clienta nueva hoy, sin fila todavía, y Andrea que vuelve a comprar.
    const nueva = await sale({ name: "Natalia Gómez", variantId: ids.beige37 })
    fichas.nueva = nueva.customerId!
    await sale({ conversationId: chats.andrea, variantId: ids.beige37, zone: "San Isidro" })
    // Y un carrito de Andrea, de hoy y con su precio vigente.
    const cart = await sale({ customerId: fichas.andrea, variantId: ids.negra38, paid: false })
    const { json } = await list()
    expect(row(json.customers, fichas.nueva)).toMatchObject({
      segment: "nueva",
      segmentWhy: "Su primera compra fue hoy.",
      ordersCount: 1,
      lastBoughtDays: 0,
    })
    expect(row(json.customers, fichas.andrea)).toMatchObject({
      segment: "frecuente",
      ordersCount: 4,
      lastBoughtDays: 0,
    })
    // Lo guardado sigue siendo lo de la vuelta: la aplicación no lo escribe.
    const [kept] = await db.ownerDb
      .select({ segment: customerProfile.segment })
      .from(customerProfile)
      .where(eq(customerProfile.customerId, fichas.andrea))
    expect(kept?.segment).toBe("riesgo")
    const andrea = (await call("lucia", "GET", `${base}/clientes/${fichas.andrea}`)).json.customer
    expect(andrea.computed.wanted).toEqual([
      expect.objectContaining({ kind: "carrito", orderNumber: cart.number }),
    ])
  })
})

describe("la vuelta de la noche", () => {
  it("recalcula cada tienda pasadas las 03:00 de su hora, una vez por día", async () => {
    const tomorrow = addDays(dayIn(LIMA), 1)
    const night = startOfDay(LIMA, tomorrow).getTime()
    // A las 02:30 de Lima todavía no.
    await runNightlyProfiles(db.ownerDb, new Date(night + 2.5 * HOUR))
    const before = await db.ownerDb
      .select({ computedFor: customerProfile.computedFor })
      .from(customerProfile)
      .where(eq(customerProfile.storeId, storeId))
    expect(before.every((r) => r.computedFor !== tomorrow)).toBe(true)
    // A las 03:10, sí: todas sus fichas, con el día de la tienda.
    const run = await runNightlyProfiles(db.ownerDb, new Date(night + 3 * HOUR + 10 * 60_000))
    expect(run.failed).toBe(0)
    const after = await db.ownerDb
      .select()
      .from(customerProfile)
      .where(eq(customerProfile.storeId, storeId))
    expect(after).toHaveLength(5)
    expect(after.every((r) => r.computedFor === tomorrow)).toBe(true)
    expect(after.find((r) => r.customerId === fichas.andrea)?.segment).toBe("frecuente")
    // La segunda vuelta del mismo día no la vuelve a calcular.
    const again = await runNightlyProfiles(db.ownerDb, new Date(night + 5 * HOUR))
    expect(again.stores).toBe(0)
  })

  it("en otra zona horaria cuenta su propia hora", async () => {
    const TOKYO = "Asia/Tokyo"
    await db.ownerDb.update(store).set({ timeZone: TOKYO }).where(eq(store.id, storeId))
    // Un día de Tokio que todavía no se calculó: a sus 02:30 no, a sus 03:10 sí, con su día.
    const day = addDays(dayIn(TOKYO), 3)
    const night = startOfDay(TOKYO, day).getTime()
    await runNightlyProfiles(db.ownerDb, new Date(night + 2.5 * HOUR))
    const computedFor = async () =>
      (
        await db.ownerDb
          .select({ computedFor: customerProfile.computedFor })
          .from(customerProfile)
          .where(eq(customerProfile.storeId, storeId))
      ).map((r) => r.computedFor)
    expect(await computedFor()).not.toContain(day)
    // A esa hora en Lima todavía es el día anterior: cuenta el de la tienda.
    expect(dayIn(LIMA, new Date(night + 3.2 * HOUR))).toBe(addDays(day, -1))
    await runNightlyProfiles(db.ownerDb, new Date(night + 3.2 * HOUR))
    expect(new Set(await computedFor())).toEqual(new Set([day]))
    await db.ownerDb.update(store).set({ timeZone: LIMA }).where(eq(store.id, storeId))
    // Lo deja como hoy para lo que sigue.
    await recalculateStore(db.ownerDb, storeId)
  })
})

describe("los filtros de la lista", () => {
  const idsOf = (json: Json) => (json.customers as Json[]).map((c) => c.id).sort()

  it("por grupo, medida, lo que compra, distrito y promociones", async () => {
    expect(idsOf((await list("?grupo=sin_compras")).json)).toEqual([fichas.jimena])
    expect(idsOf((await list("?grupo=frecuente")).json)).toEqual(
      [fichas.andrea, fichas.lorena, fichas.paola].sort(),
    )
    expect(idsOf((await list("?medida=40")).json)).toEqual([fichas.paola])
    expect(idsOf((await list("?categoria=sandalias")).json)).toEqual(
      [fichas.andrea, fichas.lorena, fichas.nueva].sort(),
    )
    expect(idsOf((await list("?distrito=San%20Isidro")).json)).toEqual([fichas.andrea])
    // Nadie aceptó todavía: con «sí», ninguna; con «no», todas.
    expect(idsOf((await list("?promociones=si")).json)).toEqual([])
    expect((await list("?promociones=no")).json.customers).toHaveLength(5)
    // Los filtros se suman, y la búsqueda también.
    expect(idsOf((await list("?grupo=frecuente&categoria=Botines")).json)).toEqual([fichas.paola])
    expect(idsOf((await list("?grupo=frecuente&q=lorena")).json)).toEqual([fichas.lorena])
    // «buscar» sigue valiendo.
    expect(idsOf((await list("?buscar=paola")).json)).toEqual([fichas.paola])
    // Los facets son de toda la tienda, sin los filtros.
    expect((await list("?grupo=riesgo")).json.facets.segments.frecuente).toBe(3)
  })

  it("por lo que gastó y por cuándo compró, en la dirección de la flecha", async () => {
    const totalsOf = async (query: string) =>
      ((await list(query)).json.customers as Json[]).map((c) => c.totalCents as number)
    // «-gasto», de más a menos; «gasto», de menos a más.
    const down = await totalsOf("?orden=-gasto")
    expect(down).toEqual([...down].sort((a, b) => b - a))
    expect((await list("?orden=-gasto")).json.customers[0].id).toBe(fichas.andrea)
    const up = await totalsOf("?orden=gasto")
    expect(up).toEqual([...down].sort((a, b) => a - b))
    // «reciente», la que compró hace menos primero; «-reciente», al revés. Sin compras, al final.
    const daysOf = async (query: string) =>
      ((await list(query)).json.customers as Json[]).map((c) => c.lastBoughtDays as number | null)
    const recent = await daysOf("?orden=reciente")
    expect(recent.at(-1)).toBeNull()
    const bought = recent.filter((d): d is number => d !== null)
    expect(bought).toEqual([...bought].sort((a, b) => a - b))
    const old = await daysOf("?orden=-reciente")
    expect(old.at(-1)).toBeNull()
    expect(old.filter((d) => d !== null)).toEqual([...bought].sort((a, b) => b - a))
    expect((await list("?orden=nombre")).status).toBe(400)
  })

  it("un grupo que no existe es un error, no una lista vacía", async () => {
    expect((await list("?grupo=oro")).status).toBe(400)
  })
})

describe("los grupos guardados", () => {
  it("se guardan con sus filtros, se listan y se quitan", async () => {
    const saved = await call("lucia", "POST", `${base}/clientes/grupos`, {
      name: "Sandalias en riesgo",
      filters: { grupo: "riesgo", categoria: "Sandalias", medida: "" },
    })
    expect(saved.status).toBe(201)
    expect(saved.json.group).toMatchObject({
      name: "Sandalias en riesgo",
      filters: { grupo: "riesgo", categoria: "Sandalias" },
    })
    expect((await call("rosa", "GET", `${base}/clientes/grupos`)).json.groups).toEqual([
      expect.objectContaining({ id: saved.json.group.id }),
    ])
    // El mismo nombre, sin filtros o con uno que no existe: no.
    for (const body of [
      { name: "sandalias EN riesgo", filters: { grupo: "vip" } },
      { name: "Vacío", filters: {} },
      { name: "Oro", filters: { grupo: "oro" } },
      { name: "", filters: { grupo: "vip" } },
    ])
      expect((await call("lucia", "POST", `${base}/clientes/grupos`, body)).status).toBe(400)
    // Soporte solo mira: no guarda ni ve los grupos (son de quien atiende). Otra tienda, tampoco.
    expect((await call("soporte", "GET", `${base}/clientes/grupos`)).status).toBe(403)
    expect(
      (
        await call("soporte", "POST", `${base}/clientes/grupos`, {
          name: "De soporte",
          filters: { grupo: "vip" },
        })
      ).status,
    ).toBe(403)
    expect((await call("ajena", "GET", `${base}/clientes/grupos`)).status).toBe(404)
    expect(
      (await call("ajena", "DELETE", `${base}/clientes/grupos/${saved.json.group.id}`)).status,
    ).toBe(404)
    expect(
      (await call("lucia", "DELETE", `${base}/clientes/grupos/${saved.json.group.id}`)).status,
    ).toBe(204)
    expect((await call("rosa", "GET", `${base}/clientes/grupos`)).json.groups).toEqual([])
    expect(
      (await call("lucia", "DELETE", `${base}/clientes/grupos/${saved.json.group.id}`)).status,
    ).toBe(404)
    // Quitar solo lo marca.
    const [kept] = await db.ownerDb
      .select({ removedAt: customerGroup.removedAt })
      .from(customerGroup)
      .where(eq(customerGroup.id, saved.json.group.id))
    expect(kept?.removedAt).toBeInstanceOf(Date)
  })
})

describe("las reglas de la base", () => {
  const asLucia = (fn: (tx: Db) => Promise<unknown>) =>
    withPerson(db.appDb, { userId: "u-lucia", email: people.lucia.email, storeId }, fn)
  const asAjena = (fn: (tx: Db) => Promise<unknown>) =>
    withPerson(db.appDb, { userId: "u-ajena", email: people.ajena.email, storeId: otherStore }, fn)

  it("la aplicación lee lo calculado de su tienda y no lo escribe", async () => {
    const mine = (await asLucia((tx) =>
      tx.select().from(customerProfile).where(eq(customerProfile.storeId, storeId)),
    )) as unknown[]
    expect(mine.length).toBe(5)
    const theirs = (await asAjena((tx) =>
      tx.select().from(customerProfile).where(eq(customerProfile.storeId, storeId)),
    )) as unknown[]
    expect(theirs).toEqual([])
    await expect(
      asLucia((tx) =>
        tx.insert(customerProfile).values({
          storeId,
          customerId: fichas.jimena,
          segment: "vip",
          why: "Lo puse yo.",
          ordersCount: 9,
          totalCents: 1,
          computedFor: dayIn(LIMA),
        }),
      ),
    ).rejects.toThrow()
    await expect(
      asLucia((tx) =>
        tx
          .update(customerProfile)
          .set({ segment: "vip" })
          .where(eq(customerProfile.customerId, fichas.jimena)),
      ),
    ).rejects.toThrow()
    await expect(
      asLucia((tx) =>
        tx.delete(customerProfile).where(eq(customerProfile.customerId, fichas.jimena)),
      ),
    ).rejects.toThrow()
    await expect(
      withAgent(db.appDb, ARGOS_ACTOR, storeId, (tx) =>
        tx
          .update(customerProfile)
          .set({ segment: "vip" })
          .where(eq(customerProfile.customerId, fichas.jimena)),
      ),
    ).rejects.toThrow()
  })

  it("los grupos son de cada tienda, a nombre de quien los guarda, y los agentes no los tocan", async () => {
    await expect(
      withAgent(db.appDb, ARGOS_ACTOR, storeId, (tx) =>
        tx
          .insert(customerGroup)
          .values({ storeId, name: "De Argos", filters: { grupo: "vip" }, createdBy: ARGOS_ACTOR }),
      ),
    ).rejects.toThrow()
    await expect(
      asLucia((tx) =>
        tx
          .insert(customerGroup)
          .values({ storeId, name: "A nombre de Rosa", filters: {}, createdBy: "u-rosa" }),
      ),
    ).rejects.toThrow()
    await expect(
      asAjena((tx) =>
        tx
          .insert(customerGroup)
          .values({ storeId, name: "Ajeno", filters: {}, createdBy: "u-ajena" }),
      ),
    ).rejects.toThrow()
    // Lo que guarda no se cambia: solo se marca como quitado.
    const [mine] = (await asLucia((tx) =>
      tx
        .insert(customerGroup)
        .values({ storeId, name: "VIP", filters: { grupo: "vip" }, createdBy: "u-lucia" })
        .returning({ id: customerGroup.id }),
    )) as { id: string }[]
    await expect(
      asLucia((tx) =>
        tx.update(customerGroup).set({ name: "Otro" }).where(eq(customerGroup.id, mine!.id)),
      ),
    ).rejects.toThrow()
    const ajenos = (await asAjena((tx) =>
      tx.select().from(customerGroup).where(sql`true`),
    )) as unknown[]
    expect(ajenos).toEqual([])
  })
})

describe("lo que la lista cuenta", () => {
  const deliver = async (orderId: string, body: Json = {}) => {
    const done = await call("lucia", "POST", `${base}/pedidos/${orderId}/entregado`, body)
    expect(done.json.order?.state).toBe("entregado")
  }
  /** Un cambio del pedido entregado, con el envío a cuenta de la tienda. */
  const exchange = async (orderId: string, body: Json) => {
    const created = await call("lucia", "POST", `${base}/pedidos/${orderId}/cambio`, {
      reason: "Le quedó chica",
      deliveryMethodId: ids.reparto,
      zone: "Surco",
      storePaysDelivery: true,
      address: "Av. Primavera 123",
      ...body,
    })
    expect(created.status).toBe(201)
    return created.json.order as Json
  }
  const totalOf = async (orderId: string) =>
    (
      await db.ownerDb
        .select({ total: saleOrder.totalCents })
        .from(saleOrder)
        .where(eq(saleOrder.id, orderId))
    )[0]!.total

  it("una fila de un día anterior se calcula en el momento", async () => {
    // Lo guardado es de ayer y nada cambió después: igual vale la cuenta de hoy.
    await db.ownerDb
      .update(customerProfile)
      .set({
        segment: "vip",
        why: "De ayer.",
        computedFor: addDays(dayIn(LIMA), -1),
        computedAt: new Date(Date.now() + HOUR),
      })
      .where(eq(customerProfile.customerId, fichas.lorena))
    expect(row((await list()).json.customers, fichas.lorena)).toMatchObject({
      segment: "frecuente",
      segmentWhy: expect.not.stringContaining("De ayer"),
    })
    await recalculateStore(db.ownerDb, storeId)
  })

  it("una compra es un pedido pagado: una captura por confirmar o un contra entrega sin cobrar todavía no", async () => {
    const ruth = await sale({ name: "Ruth Salas", variantId: ids.beige37, confirm: false })
    expect(row((await list()).json.customers, ruth.customerId!)).toMatchObject({
      segment: "sin_compras",
      ordersCount: 0,
    })
    await confirm(ruth.id)
    expect(row((await list()).json.customers, ruth.customerId!)).toMatchObject({
      segment: "nueva",
      ordersCount: 1,
    })
    // Contra entrega: sale sin pago y es compra cuando se entrega.
    await db.ownerDb
      .update(storeDeliveryMethod)
      .set({ acceptsPayOnDelivery: true })
      .where(eq(storeDeliveryMethod.id, ids.reparto))
    const efectivo = (
      await call("rosa", "POST", `${base}/medios-de-pago`, {
        name: "Efectivo",
        typeCode: "10",
        collection: "al_recibir",
      })
    ).json.method.id as string
    const sofia = await sale({
      name: "Sofía León",
      variantId: ids.beige37,
      paid: false,
      paymentMethodId: efectivo,
    })
    expect(sofia.state).toBe("por_salir")
    expect(row((await list()).json.customers, sofia.customerId!)).toMatchObject({
      segment: "sin_compras",
      ordersCount: 0,
    })
    await deliver(sofia.id, { collectedCents: sofia.totalCents })
    expect(row((await list()).json.customers, sofia.customerId!)).toMatchObject({
      segment: "nueva",
      ordersCount: 1,
    })
  })

  it("lo que gastó suma toda la cadena de cambios y lo que compra es lo que se quedó", async () => {
    // Valeria llevó una sandalia beige 37 y un botín 40; cambió la sandalia por la negra 38 y
    // después devolvió la negra. Se quedó solo con el botín.
    const bought = await sale({ name: "Valeria Ríos", variantId: ids.beige37, more: [ids.botin40] })
    const valeria = bought.customerId!
    await deliver(bought.id)
    const first = await exchange(bought.id, {
      returns: [{ variantId: ids.beige37, quantity: 1 }],
      takes: [{ variantId: ids.negra38, quantity: 1 }],
    })
    await deliver(first.id)
    const second = await exchange(first.id, {
      returns: [{ variantId: ids.negra38, quantity: 1 }],
      takes: [],
    })
    const totals = [
      await totalOf(bought.id),
      await totalOf(first.id),
      await totalOf(second.id as string),
    ]
    expect(totals[2]).toBeLessThan(0)
    expect(row((await list()).json.customers, valeria)).toMatchObject({
      ordersCount: 1,
      totalCents: totals[0]! + totals[1]! + totals[2]!,
      measure: "40",
    })
    const ficha = (await call("lucia", "GET", `${base}/clientes/${valeria}`)).json.customer
    expect(ficha.computed).toMatchObject({
      categories: [["Botines", 1]],
      measures: [["40", 1]],
      colors: [],
    })
  })

  it("un pedido devuelto entero no es compra", async () => {
    const bought = await sale({ name: "Ximena Rojas", variantId: ids.beige37 })
    await deliver(bought.id)
    await exchange(bought.id, { returns: [{ variantId: ids.beige37, quantity: 1 }], takes: [] })
    expect(row((await list()).json.customers, bought.customerId!)).toMatchObject({
      segment: "sin_compras",
      ordersCount: 0,
      totalCents: 0,
      lastBoughtDays: null,
    })
  })

  it("el filtro de talla ofrece solo la talla de hoy de cada una, la misma que filtra", async () => {
    await call("rosa", "POST", `${base}/variantes/${ids.botin43}/movimientos`, {
      kind: "entrada",
      quantity: 5,
    })
    // Wendy compra en 37 (dos veces) y una vez llevó un botín 43: su talla de hoy es 37.
    const first = await sale({ name: "Wendy Paz", variantId: ids.beige37, daysAgo: 5 })
    await sale({ customerId: first.customerId!, variantId: ids.beige37, daysAgo: 3 })
    await sale({ customerId: first.customerId!, variantId: ids.botin43, daysAgo: 1 })
    const { json } = await list()
    expect(row(json.customers, first.customerId!)?.measure).toBe("37")
    expect(json.facets.measures).not.toContain("43")
    expect(json.facets.measures).toContain("37")
    expect((await list("?medida=43")).json.customers).toEqual([])
    // «reciente» con días distintos: la que compró hace menos primero.
    const recent = ((await list("?orden=reciente")).json.customers as Json[])
      .map((c) => c.lastBoughtDays as number | null)
      .filter((d): d is number => d !== null)
    expect(recent).toEqual([...recent].sort((a, b) => a - b))
  })
})

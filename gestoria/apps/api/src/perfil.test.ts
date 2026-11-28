/**
 * El perfil de la clienta (ADR 0240) contra una base real y un modelo controlado (nunca la red):
 * las reglas de la base (Sofi no anota datos, Argos no pisa lo de la tienda, una persona solo
 * anota «tienda», el permiso solo con un mensaje de ella y su cita), Argos que perfila (lo que no
 * está tal cual en lo que dijo se descarta, la talla tiene que existir, un empate queda «Por
 * confirmar», no lee dos veces lo mismo ni a media conversación), «Corregir» (quién puede) y la
 * familia de fichas unidas.
 *
 * Esto prueba nuestro código, no cómo lee el modelo real.
 */
import { randomUUID } from "node:crypto"
import {
  argosReading,
  conversation,
  conversationMessage,
  customer,
  customerConsent,
  customerFact,
  type Db,
  store,
  storeMember,
  storeSupportAccess,
  withPerson,
} from "@gestoria/db"
import { startTestDb, type TestDb } from "@gestoria/db/testing"
import { and, eq } from "drizzle-orm"
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ARGOS_ACTOR, SOFI_ACTOR, withAgent } from "./agente.js"
import { createApp } from "./app.js"
import { addReceiptIn, createOrderIn, orderInput } from "./pedidos.js"
import { type MeasureCatalog, measureLabelOf } from "./perfil.js"
import type { ChatModel, ChatRequest } from "./sofi/modelo.js"
import {
  checkClaims,
  mostUsed,
  profileStore,
  type Reading,
  readingOf,
  readingsIn,
} from "./sofi/perfilar.js"

const ACCOUNT = "https://api.gestoria.test"
const WEB = "https://app.gestoria.test"
const SERVER = "https://servidor.gestoria.test"
const HOUR = 3_600_000

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

const ids = { yape: "", reparto: "", t37: "", t38: "", t39: "", botin40: "" }

/* ------------------------------------------------------- el modelo controlado */

/**
 * Responde según lo que lee: si el mensaje de ella trae una de las marcas, lo de esa marca; si
 * no, nada. Si la respuesta es un `Error`, falla como un proveedor caído; si es un texto, lo
 * devuelve tal cual (lo que no es JSON).
 */
const answers = new Map<string, unknown[] | Error | string>()
const requests: ChatRequest[] = []
const model: ChatModel = {
  name: "gpt-6-luna",
  async complete(request) {
    requests.push(structuredClone({ ...request, signal: undefined }))
    const user = request.messages.find((m) => m.role === "user")?.content ?? ""
    for (const [mark, reply] of answers)
      if (typeof user === "string" && user.includes(mark)) {
        if (reply instanceof Error) throw reply
        return {
          content: typeof reply === "string" ? reply : JSON.stringify(reply),
          toolCalls: [],
          usage: { input: 800, cached: 0, output: 40 },
        }
      }
    return { content: "[]", toolCalls: [], usage: { input: 500, cached: 0, output: 2 } }
  },
}

/* ---------------------------------------------------------------- ayudas */

async function chat(channel: "whatsapp" | "instagram" | "messenger" | "prueba", name: string) {
  const [row] = await db.ownerDb
    .insert(conversation)
    .values({ storeId, channel, customerName: name, createdBy: "canal" })
    .returning({ id: conversation.id })
  return row!.id
}

/** Lo que escribe ella, hace `minutesAgo` minutos (como lo anotaría el canal). */
async function says(conversationId: string, text: string, minutesAgo = 120) {
  const [row] = await db.ownerDb
    .insert(conversationMessage)
    .values({
      storeId,
      conversationId,
      author: "cliente",
      text,
      actorUserId: "canal",
      createdAt: new Date(Date.now() - minutesAgo * 60_000),
    })
    .returning({ id: conversationMessage.id, seq: conversationMessage.seq })
  return row!
}

/** Un pedido de Sofi en esa conversación, pagado con captura (ya es compra). */
async function buys(
  conversationId: string,
  variantId: string,
  over: Partial<Record<string, unknown>> = {},
  paid = true,
) {
  return withAgent(db.appDb, SOFI_ACTOR, storeId, async (tx) => {
    const order = await createOrderIn(
      tx,
      storeId,
      SOFI_ACTOR,
      orderInput.parse({
        customerName: "Clienta",
        channel: "whatsapp",
        address: "Av. Primavera 123, Surco",
        lines: [{ variantId, quantity: 1 }],
        deliveryMethodId: ids.reparto,
        paymentMethodId: ids.yape,
        ...over,
      }),
      { conversationId },
    )
    if (paid)
      await addReceiptIn(tx, storeId, SOFI_ACTOR, order.id, {
        amountCents: order.totalCents,
        operation: String(Math.floor(Math.random() * 1e8)),
      })
    return order
  })
}

const ficha = async (id: string) =>
  (await call("lucia", "GET", `${base}/clientes/${id}`)).json.customer as Json

const factsOf = (customerId: string) =>
  db.ownerDb.select().from(customerFact).where(eq(customerFact.customerId, customerId))

const asArgos = (fn: (tx: Db) => Promise<unknown>) => withAgent(db.appDb, ARGOS_ACTOR, storeId, fn)
const asSofi = (fn: (tx: Db) => Promise<unknown>) => withAgent(db.appDb, SOFI_ACTOR, storeId, fn)
const asLucia = (fn: (tx: Db) => Promise<unknown>) =>
  withPerson(db.appDb, { userId: "u-lucia", email: "lucia@calzados.test", storeId }, fn)

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
  // Soporte entra a mirar con el sí de Rosa.
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
      name: "Agencia Shalom",
      type: "ParcelService",
      cost: "fijo",
      priceCents: 1000,
    })
  ).json.method.id
  const zapatilla = await call("rosa", "POST", `${base}/productos`, {
    name: "Zapatilla urbana",
    listPriceCents: 12900,
    options: [
      { name: "Color", values: ["blanca"] },
      { name: "Talla", values: ["37", "38", "39"] },
    ],
  })
  const botin = await call("rosa", "POST", `${base}/productos`, {
    name: "Botín",
    listPriceCents: 21900,
    options: [{ name: "Talla", values: ["40"] }],
  })
  const variants = [
    ...(await call("rosa", "GET", `${base}/productos/${zapatilla.json.product.id}`)).json.product
      .variants,
    ...(await call("rosa", "GET", `${base}/productos/${botin.json.product.id}`)).json.product
      .variants,
  ] as Json[]
  const of = (size: string) => variants.find((v) => v.optionValues.at(-1) === size)!.id as string
  ids.t37 = of("37")
  ids.t38 = of("38")
  ids.t39 = of("39")
  ids.botin40 = of("40")
  for (const variantId of [ids.t37, ids.t38, ids.t39, ids.botin40])
    await call("rosa", "POST", `${base}/variantes/${variantId}/movimientos`, {
      kind: "entrada",
      quantity: 20,
    })
}, 120_000)

afterAll(async () => {
  await db?.stop()
})

describe("la medida de la tienda", () => {
  it("es la opción más usada del catálogo; sin catálogo, «Talla»", () => {
    expect(measureLabelOf([])).toBe("Talla")
    expect(
      measureLabelOf([
        { options: [{ name: "Color" }, { name: "Talla" }] },
        { options: [{ name: "Talla" }] },
      ]),
    ).toBe("Talla")
    expect(measureLabelOf([{ options: [{ name: "Tono" }] }])).toBe("Tono")
  })

  it("un empate usa lo más reciente y deja lo otro por confirmar", () => {
    const tally = (count: number, lastAt: number) => ({ count, lastAt, orderId: "x" })
    expect(
      mostUsed(
        new Map([
          ["38", tally(2, 1)],
          ["39", tally(2, 5)],
          ["37", tally(1, 9)],
        ]),
      ),
    ).toEqual({ value: "39", tie: ["38"] })
  })
})

describe("las reglas de la base", () => {
  let customerId = ""
  let conversationId = ""
  let saidId = ""
  let sofiSaidId = ""

  beforeAll(async () => {
    conversationId = await chat("whatsapp", "Rocío")
    saidId = (await says(conversationId, "Sí, mándame las novedades por aquí")).id
    const order = await buys(conversationId, ids.t38, { customerName: "Rocío Paz" })
    customerId = order.customerId!
    const [sofi] = await db.ownerDb
      .insert(conversationMessage)
      .values({
        storeId,
        conversationId,
        author: "sofi",
        text: "¿Te aviso cuando llegue algo nuevo?",
        delivery: "sin_enviar",
        actorUserId: SOFI_ACTOR,
      })
      .returning({ id: conversationMessage.id })
    sofiSaidId = sofi!.id
  })

  const fact = (
    over: Partial<typeof customerFact.$inferInsert> & { actorUserId: string },
  ): typeof customerFact.$inferInsert => ({
    storeId,
    customerId,
    key: "distrito",
    value: "Surco",
    source: "respuesta",
    ...over,
  })

  it("Sofi no anota datos; Argos no anota como la tienda; una persona solo como la tienda", async () => {
    await expect(
      asSofi((tx) => tx.insert(customerFact).values(fact({ actorUserId: SOFI_ACTOR }))),
    ).rejects.toThrow()
    await expect(
      asArgos((tx) =>
        tx.insert(customerFact).values(fact({ source: "tienda", actorUserId: ARGOS_ACTOR })),
      ),
    ).rejects.toThrow()
    await expect(
      asLucia((tx) => tx.insert(customerFact).values(fact({ actorUserId: "u-lucia" }))),
    ).rejects.toThrow()
    // A nombre de otra persona, tampoco.
    await expect(
      asLucia((tx) =>
        tx.insert(customerFact).values(fact({ source: "tienda", actorUserId: "u-rosa" })),
      ),
    ).rejects.toThrow()
    await asArgos((tx) => tx.insert(customerFact).values(fact({ actorUserId: ARGOS_ACTOR })))
    await asLucia((tx) =>
      tx
        .insert(customerFact)
        .values(fact({ source: "tienda", value: "Miraflores", actorUserId: "u-lucia" })),
    )
    // Lo que corrigió la tienda, Argos ya no lo escribe; lo demás de ella, sí.
    await expect(
      asArgos((tx) => tx.insert(customerFact).values(fact({ actorUserId: ARGOS_ACTOR }))),
    ).rejects.toThrow()
    await asArgos((tx) =>
      tx
        .insert(customerFact)
        .values(fact({ key: "gustos", value: "Zapatillas blancas", actorUserId: ARGOS_ACTOR })),
    )
    // Y nada se cambia ni se borra: el historial son sus filas.
    await expect(
      asLucia((tx) =>
        tx
          .update(customerFact)
          .set({ value: "Lince" })
          .where(eq(customerFact.customerId, customerId)),
      ),
    ).rejects.toThrow()
  })

  it("el permiso lo anota solo Sofi, con un mensaje de ella y sus palabras tal cual", async () => {
    const consent = (over: Partial<typeof customerConsent.$inferInsert> = {}) => ({
      storeId,
      customerId,
      conversationId,
      channel: "whatsapp" as const,
      state: "si" as const,
      messageId: saidId,
      quote: "mándame las novedades",
      actorUserId: SOFI_ACTOR,
      ...over,
    })
    await expect(
      asArgos((tx) => tx.insert(customerConsent).values(consent({ actorUserId: ARGOS_ACTOR }))),
    ).rejects.toThrow()
    await expect(
      asLucia((tx) => tx.insert(customerConsent).values(consent({ actorUserId: "u-lucia" }))),
    ).rejects.toThrow()
    // Un mensaje de Sofi no es de ella; unas palabras que no dijo, tampoco.
    await expect(
      asSofi((tx) =>
        tx
          .insert(customerConsent)
          .values(consent({ messageId: sofiSaidId, quote: "¿Te aviso cuando llegue algo nuevo?" })),
      ),
    ).rejects.toThrow()
    await expect(
      asSofi((tx) => tx.insert(customerConsent).values(consent({ quote: "sí, acepto todo" }))),
    ).rejects.toThrow()
    // Por otro canal que el de la conversación, tampoco.
    await expect(
      asSofi((tx) => tx.insert(customerConsent).values(consent({ channel: "instagram" }))),
    ).rejects.toThrow()
    await asSofi((tx) => tx.insert(customerConsent).values(consent()))

    const seen = await ficha(customerId)
    expect(seen.profile.consent).toMatchObject({
      state: "si",
      quote: "mándame las novedades",
      channel: "whatsapp",
    })
    expect(seen.profile.channels).toEqual(["whatsapp"])
    // La conversación muestra lo anotado junto al mensaje de ella.
    const view = await call("lucia", "GET", `${base}/conversaciones/${conversationId}`)
    expect(view.status).toBe(200)
    expect(view.json.conversation.consentNotes).toMatchObject([{ state: "si", messageId: saidId }])
  })
})

describe("Argos perfila", () => {
  let andrea = ""
  let andreaChat = ""
  let lastSeq = 0

  beforeAll(async () => {
    andreaChat = await chat("whatsapp", "Andrea")
    await says(andreaChat, "Hola, ¿hay en 38? [andrea]", 180)
    await says(andreaChat, "en insta me encuentras como @andre.castillo", 170)
    lastSeq = (await says(andreaChat, "es para mi cumple, el 15 de dic", 160)).seq
    // Compró la 37 en ese chat, con entrega en Lince.
    const order = await buys(andreaChat, ids.t37, {
      customerName: "Andrea Castillo",
      address: "Jr. Pumacahua 1450, Lince",
    })
    andrea = order.customerId!
    answers.set("[andrea]", [
      { clave: "medida", valor: "38", cita: "¿hay en 38?" },
      { clave: "instagram", valor: "@andre.castillo", cita: "me encuentras como @andre.castillo" },
      { clave: "cumpleanos", valor: "--12-15", cita: "es para mi cumple, el 15 de dic" },
      { clave: "distrito", valor: "Lince", cita: "Lince" },
      // Inventado: no lo dijo.
      { clave: "gustos", valor: "Botines", cita: "me encantan los botines" },
      // Una talla que la tienda no tiene, y una fecha que no existe.
      { clave: "medida", valor: "44", cita: "es para mi cumple" },
      { clave: "cumpleanos", valor: "--02-30", cita: "el 15 de dic" },
      // El canal sale de las cuentas, no del modelo.
      { clave: "canal", valor: "instagram", cita: "en insta" },
    ])
  })

  it("anota lo que dijo con su cita, descarta lo que no pasa y lee lo de ella como mensaje del usuario", async () => {
    requests.length = 0
    const run = await profileStore(db.appDb, storeId, new Date(), model)
    expect(run.failed).toBe(0)
    expect(run.discarded).toBe(4)
    expect(run.costMicros).toBeGreaterThan(0)
    const asked = requests.find((r) =>
      r.messages.some((m) => m.role === "user" && String(m.content).includes("[andrea]")),
    )!
    expect(asked).toBeTruthy()
    const system = asked.messages.filter((m) => m.role === "system").map((m) => m.content)
    expect(system.join("\n")).not.toContain("@andre.castillo")
    expect(system.join("\n")).toContain("37, 38, 39, 40")
    const user = asked.messages.find((m) => m.role === "user")!.content as string
    expect(user).toContain("Jr. Pumacahua 1450, Lince")

    const { profile } = await ficha(andrea)
    expect(profile.measureLabel).toBe("Talla")
    expect(profile.facts.medida).toMatchObject({
      label: "Talla",
      value: "38",
      source: "chat",
      quote: "¿hay en 38?",
      byName: null,
      alternatives: [],
    })
    // Antes, de sus compras: el historial lo cuenta.
    expect(profile.facts.medida.history.map((h: Json) => [h.value, h.source])).toEqual([
      ["38", "chat"],
      ["37", "pedido"],
    ])
    expect(profile.facts.medida.history[1].orderNumber).toMatch(/^\d{4}$/)
    expect(profile.facts.instagram).toMatchObject({ value: "@andre.castillo", source: "chat" })
    expect(profile.facts.cumpleanos).toMatchObject({
      label: "Cumpleaños",
      value: "15 de diciembre",
      raw: "--12-15",
      quote: "es para mi cumple, el 15 de dic",
    })
    expect(profile.facts.distrito).toMatchObject({
      value: "Lince",
      source: "pedido",
      quote: "Lince",
    })
    expect(profile.facts.distrito.orderNumber).toMatch(/^\d{4}$/)
    expect(profile.facts.canal).toMatchObject({
      label: "Canal preferido",
      value: "WhatsApp",
      raw: "whatsapp",
      source: "respuesta",
    })
    expect(profile.facts.gustos).toBeUndefined()
    expect(profile.canCorrect).toBe(true)
    expect(await asArgos((tx) => readingOf(tx, storeId, andreaChat))).toBe(lastSeq)
  })

  it("no vuelve a leer lo leído ni anota otra fila igual", async () => {
    const before = (await factsOf(andrea)).length
    requests.length = 0
    await profileStore(db.appDb, storeId, new Date(), model)
    expect(
      requests.some((r) => r.messages.some((m) => String(m.content).includes("[andrea]"))),
    ).toBe(false)
    expect((await factsOf(andrea)).length).toBe(before)
  })

  it("no lee a media conversación, ni «Probar a Sofi», ni un chat sin clienta", async () => {
    const live = await chat("whatsapp", "Pía")
    await says(live, "recién escribo [pia]", 5)
    await buys(live, ids.t39, { customerName: "Pía" })
    const test = await chat("prueba", "Prueba")
    await says(test, "soy de prueba [prueba]")
    const nobody = await chat("instagram", "Sin pedido")
    await says(nobody, "solo miro [nadie]")
    requests.length = 0
    await profileStore(db.appDb, storeId, new Date(), model)
    const read = requests.map((r) => r.messages.map((m) => String(m.content)).join("\n")).join("\n")
    for (const mark of ["[pia]", "[prueba]", "[nadie]"]) expect(read).not.toContain(mark)
    // Pasada la media hora, sí.
    requests.length = 0
    await profileStore(db.appDb, storeId, new Date(Date.now() + 40 * 60_000), model)
    expect(requests.map((r) => String(r.messages.at(-1)?.content)).join("\n")).toContain("[pia]")
  })

  it("si el modelo falla, la conversación queda por leer", async () => {
    const down = await chat("messenger", "Lu")
    await says(down, "hola [caido]")
    await buys(down, ids.t38, { customerName: "Lu Ramos", channel: "messenger" })
    answers.set("[caido]", new Error("El proveedor respondió 503"))
    const run = await profileStore(db.appDb, storeId, new Date(), model)
    expect(run.failed).toBe(1)
    // El cursor no avanza; la hora del intento, sí.
    expect(await asArgos((tx) => readingOf(tx, storeId, down))).toBe(0)
    // Vuelve el modelo: la lee en la siguiente vuelta.
    answers.set("[caido]", [])
    await profileStore(db.appDb, storeId, new Date(), model)
    expect(await asArgos((tx) => readingOf(tx, storeId, down))).toBeGreaterThan(0)
  })

  it("una que falla rota: la que nunca se intentó leer va antes, aunque sea más nueva", async () => {
    const stuck = await chat("whatsapp", "Ivón")
    await says(stuck, "hola [atascada]", 300)
    await buys(stuck, ids.t38, { customerName: "Ivón Salas" })
    answers.set("[atascada]", new Error("Se acabó el tiempo"))
    await profileStore(db.appDb, storeId, new Date(), model)
    const [tried] = await db.ownerDb
      .select()
      .from(argosReading)
      .where(eq(argosReading.conversationId, stuck))
    expect(tried).toMatchObject({ seq: 0 })
    const fresh = await chat("whatsapp", "Olga")
    await says(fresh, "hola [nueva]", 120)
    await buys(fresh, ids.t39, { customerName: "Olga Ríos" })
    const order = ((await asArgos((tx) => readingsIn(tx, storeId, new Date()))) as Reading[]).map(
      (r) => r.conversationId,
    )
    expect(order).toContain(stuck)
    expect(order.indexOf(fresh)).toBeLessThan(order.indexOf(stuck))
    answers.delete("[atascada]")
    await profileStore(db.appDb, storeId, new Date(), model)
  })

  it("si lo que responde no es JSON, la da por leída: no se paga dos veces", async () => {
    const odd = await chat("whatsapp", "Flor")
    const said = await says(odd, "hola [raro]")
    await buys(odd, ids.t38, { customerName: "Flor Díaz" })
    answers.set("[raro]", "Claro, aquí tienes lo que encontré: talla 38")
    const run = await profileStore(db.appDb, storeId, new Date(), model)
    expect(run.failed).toBe(0)
    expect(await asArgos((tx) => readingOf(tx, storeId, odd))).toBe(said.seq)
    requests.length = 0
    await profileStore(db.appDb, storeId, new Date(), model)
    expect(requests.some((r) => r.messages.some((m) => String(m.content).includes("[raro]")))).toBe(
      false,
    )
  })

  it("lee los mensajes nuevos desde el más antiguo, de a 40, sin saltarse ninguno", async () => {
    const long = await chat("whatsapp", "Gina")
    const sent: { seq: number }[] = []
    for (let i = 1; i <= 45; i++)
      sent.push(await says(long, `mensaje [lote-${String(i).padStart(2, "0")}]`, 200 - i))
    await buys(long, ids.t38, { customerName: "Gina Paredes" })
    const seen = () =>
      requests
        .filter((r) => r.messages.some((m) => String(m.content).includes("[lote-")))
        .map((r) => String(r.messages.at(-1)?.content))
        .join("\n")
    requests.length = 0
    await profileStore(db.appDb, storeId, new Date(), model)
    expect(seen()).toContain("[lote-01]")
    expect(seen()).toContain("[lote-40]")
    expect(seen()).not.toContain("[lote-41]")
    expect(await asArgos((tx) => readingOf(tx, storeId, long))).toBe(sent[39]!.seq)
    requests.length = 0
    await profileStore(db.appDb, storeId, new Date(), model)
    expect(seen()).toContain("[lote-41]")
    expect(seen()).toContain("[lote-45]")
    expect(seen()).not.toContain("[lote-40]")
    expect(await asArgos((tx) => readingOf(tx, storeId, long))).toBe(sent[44]!.seq)
  })

  it("dos tallas compradas por igual: usa la más reciente y deja la otra por confirmar", async () => {
    const carla = await chat("whatsapp", "Carla")
    await says(carla, "hola")
    const first = await buys(carla, ids.t38, { customerName: "Carla Mendoza" })
    await buys(carla, ids.t39, { customerName: "Carla Mendoza" })
    // Un pedido sin pagar no es una compra: no cuenta.
    await buys(carla, ids.t37, { customerName: "Carla Mendoza" }, false)
    await profileStore(db.appDb, storeId, new Date(), null)
    const { profile } = await ficha(first.customerId!)
    expect(profile.facts.medida).toMatchObject({
      value: "39",
      source: "pedido",
      alternatives: [{ value: "38", raw: "38" }],
    })
  })

  it("lo que corrigió la tienda no se pisa, aunque ella diga otra cosa después", async () => {
    const fixed = await call("lucia", "POST", `${base}/clientes/${andrea}/datos`, {
      key: "distrito",
      value: "San Isidro, su oficina",
    })
    expect(fixed.status).toBe(200)
    await says(andreaChat, "ahora recíbelo en Surco porfa [andrea2]", 60)
    answers.set("[andrea2]", [{ clave: "distrito", valor: "Surco", cita: "recíbelo en Surco" }])
    const run = await profileStore(db.appDb, storeId, new Date(), model)
    expect(run.refused).toBe(0)
    const { profile } = await ficha(andrea)
    expect(profile.facts.distrito).toMatchObject({
      value: "San Isidro, su oficina",
      source: "tienda",
      byName: "Lucía Torres",
    })
    expect(profile.facts.distrito.history.map((h: Json) => h.value)).toEqual([
      "San Isidro, su oficina",
      "Lince",
    ])
  })
})

describe("«Corregir»", () => {
  let id = ""

  beforeAll(async () => {
    const conv = await chat("instagram", "Sara")
    await says(conv, "hola")
    id = (await buys(conv, ids.t38, { customerName: "Sara Gómez", channel: "instagram" }))
      .customerId!
  })

  const fix = (who: Who, key: string, value: string, store = storeId) =>
    call(who, "POST", `/api/tiendas/${store}/clientes/${id}/datos`, { key, value })

  it("lo hace quien atiende; soporte no, y otra tienda no la encuentra", async () => {
    expect((await fix("soporte", "distrito", "Lince")).status).toBe(403)
    expect((await fix("ajena", "distrito", "Lince")).status).toBe(404)
    expect((await fix("ajena", "distrito", "Lince", otherStore)).status).toBe(404)
    const ok = await fix("lucia", "distrito", "Lince")
    expect(ok.status).toBe(200)
    expect(ok.json.profile.facts.distrito).toMatchObject({ value: "Lince", source: "tienda" })
    // Lo mismo otra vez no suma otra fila.
    await fix("lucia", "distrito", "Lince")
    expect((await factsOf(id)).filter((f) => f.key === "distrito")).toHaveLength(1)
  })

  it("comprueba cada dato y lo guarda como se lee", async () => {
    const bad = await fix("lucia", "cumpleanos", "--02-30")
    expect(bad.status).toBe(400)
    expect(bad.json.error.fields.value).toBe("Elige un día y un mes que existan")
    expect(
      (await fix("lucia", "cumpleanos", "--02-29")).json.profile.facts.cumpleanos,
    ).toMatchObject({ value: "29 de febrero", raw: "--02-29" })
    expect((await fix("lucia", "canal", "telegram")).status).toBe(400)
    expect((await fix("lucia", "canal", "instagram")).json.profile.facts.canal.value).toBe(
      "Instagram",
    )
    expect((await fix("lucia", "instagram", "sara.gomez_")).json.profile.facts.instagram.raw).toBe(
      "@sara.gomez_",
    )
    expect((await fix("lucia", "instagram", "sara gómez")).status).toBe(400)
    expect((await fix("lucia", "gustos", " ")).status).toBe(400)
    expect((await fix("lucia", "medida", "x".repeat(121))).status).toBe(400)
    expect((await fix("lucia", "telefono", "1")).status).toBe(400)
  })
})

describe("la familia unida", () => {
  it("la ficha que queda muestra los datos y el permiso de las dos, y se corrige en ella", async () => {
    const one = await chat("whatsapp", "Mía")
    await says(one, "hola")
    const older = (await buys(one, ids.t38, { customerName: "Mía Torres" })).customerId!
    const two = await chat("instagram", "Mía")
    const said = await says(two, "sí quiero promos")
    const newer = (await buys(two, ids.t38, { customerName: "Mía Torres", channel: "instagram" }))
      .customerId!
    await asArgos((tx) =>
      tx.insert(customerFact).values({
        storeId,
        customerId: newer,
        key: "gustos",
        value: "Sandalias",
        source: "respuesta",
        actorUserId: ARGOS_ACTOR,
      }),
    )
    await asSofi((tx) =>
      tx.insert(customerConsent).values({
        storeId,
        customerId: newer,
        conversationId: two,
        channel: "instagram",
        state: "si",
        messageId: said.id,
        quote: "sí quiero promos",
        actorUserId: SOFI_ACTOR,
      }),
    )
    const merged = await call("lucia", "POST", `${base}/clientes/unir`, { a: older, b: newer })
    expect(merged.status).toBe(200)
    // Desde cualquiera de las dos se ve la misma ficha, con todo.
    const seen = await ficha(newer)
    expect(seen.id).toBe(older)
    expect(seen.profile.facts.gustos).toMatchObject({ value: "Sandalias" })
    expect(seen.profile.consent).toMatchObject({ state: "si", channel: "instagram" })
    expect(seen.profile.channels).toEqual(["whatsapp", "instagram"])
    // Corregir desde la que se unió anota en la que se ve, y Argos ya no la pisa en ninguna.
    const fixed = await call("lucia", "POST", `${base}/clientes/${newer}/datos`, {
      key: "gustos",
      value: "Sandalias de colores",
    })
    expect(fixed.json.profile.facts.gustos).toMatchObject({ source: "tienda" })
    const [row] = await db.ownerDb
      .select()
      .from(customerFact)
      .where(and(eq(customerFact.source, "tienda"), eq(customerFact.value, "Sandalias de colores")))
    expect(row?.customerId).toBe(older)
    await profileStore(db.appDb, storeId, new Date(), null)
    expect((await ficha(older)).profile.facts.gustos.value).toBe("Sandalias de colores")
  })
})

describe("cada valor sale de su cita", () => {
  const catalog: MeasureCatalog = {
    label: "Talla",
    values: new Map([["38", "38"]]),
    indexOf: new Map(),
  }
  const reading = (text: string): Reading => ({
    conversationId: "c",
    rootId: "r",
    ownId: "o",
    mixed: false,
    messages: [{ id: "m", seq: 1, text }],
    cursor: 0,
    lastSeq: 1,
    address: null,
  })
  const kept = (text: string, clave: string, valor: string, cita = text) =>
    checkClaims([{ clave, valor, cita }], reading(text), catalog).checked.map((c) => c.fact.value)

  it("el distrito está en la cita, sin tildes ni mayúsculas", () => {
    expect(kept("me lo mandas a breña porfa", "distrito", "Breña")).toEqual(["Breña"])
    expect(kept("me lo mandas a BRENA porfa", "distrito", "Breña")).toEqual(["Breña"])
    // La cita está en su mensaje, pero el distrito no está en ella.
    expect(kept("me lo mandas a mi casa porfa", "distrito", "Surco")).toEqual([])
  })

  it("el cumpleaños: la cita trae el día y el mes", () => {
    expect(kept("cumplo el 12 de marzo", "cumpleanos", "--03-12")).toEqual(["--03-12"])
    expect(kept("cumplo el 12/03", "cumpleanos", "--03-12")).toEqual(["--03-12"])
    expect(kept("cumplo el 12 de mar", "cumpleanos", "--03-12")).toEqual(["--03-12"])
    expect(kept("cumplo el 5 de setiembre", "cumpleanos", "--09-05")).toEqual(["--09-05"])
    // Sin fecha en la cita, o con otro día u otro mes, no.
    expect(kept("es para mi cumple", "cumpleanos", "--03-12")).toEqual([])
    expect(kept("cumplo el 13 de marzo", "cumpleanos", "--03-12")).toEqual([])
    expect(kept("cumplo el 12 de abril", "cumpleanos", "--03-12")).toEqual([])
    expect(kept("nos vemos el 12, martes", "cumpleanos", "--03-12")).toEqual([])
  })

  it("los gustos: al menos una palabra con contenido del valor está en la cita", () => {
    expect(kept("me encantan los botines negros", "gustos", "Botines")).toEqual(["Botines"])
    expect(kept("busco algo cómodo", "gustos", "Zapatillas cómodas")).toEqual([])
    // Palabras cortas no cuentan.
    expect(kept("me gusta lo de la tienda", "gustos", "lo de la")).toEqual([])
  })
})

describe("cada ficha se lleva lo suyo", () => {
  it("Argos anota en la ficha propia del pedido del chat: «Separar» se lo lleva", async () => {
    const one = await chat("whatsapp", "Nora")
    await says(one, "hola")
    const older = (await buys(one, ids.t38, { customerName: "Nora Vega" })).customerId!
    const two = await chat("instagram", "Nora")
    await says(two, "vivo en Barranco [nora]")
    const newer = (await buys(two, ids.t38, { customerName: "Nora Vega", channel: "instagram" }))
      .customerId!
    expect(
      (await call("lucia", "POST", `${base}/clientes/unir`, { a: older, b: newer })).status,
    ).toBe(200)
    answers.set("[nora]", [{ clave: "distrito", valor: "Barranco", cita: "vivo en Barranco" }])
    await profileStore(db.appDb, storeId, new Date(), model)
    expect((await ficha(older)).profile.facts.distrito).toMatchObject({ value: "Barranco" })
    const [row] = (await factsOf(newer)).filter((f) => f.key === "distrito")
    expect(row).toMatchObject({ value: "Barranco", source: "chat" })
    expect((await call("lucia", "POST", `${base}/clientes/${newer}/separar`)).status).toBe(200)
    expect((await ficha(newer)).profile.facts.distrito).toMatchObject({ value: "Barranco" })
    expect((await ficha(older)).profile.facts.distrito).toBeUndefined()
  })

  it("la base le niega a Argos lo que la tienda corrigió en otra ficha de la familia", async () => {
    const [older] = await db.ownerDb
      .insert(customer)
      .values({ storeId, name: "Elsa Rojas", createdBy: "u-lucia" })
      .returning({ id: customer.id })
    const [newer] = await db.ownerDb
      .insert(customer)
      .values({ storeId, name: "Elsa Rojas", createdBy: "u-lucia", mergedInto: older!.id })
      .returning({ id: customer.id })
    await asLucia((tx) =>
      tx.insert(customerFact).values({
        storeId,
        customerId: older!.id,
        key: "distrito",
        value: "Lince",
        source: "tienda",
        actorUserId: "u-lucia",
      }),
    )
    const byArgos = (customerId: string, key: "distrito" | "gustos") =>
      asArgos((tx) =>
        tx.insert(customerFact).values({
          storeId,
          customerId,
          key,
          value: "Surco",
          source: "respuesta",
          actorUserId: ARGOS_ACTOR,
        }),
      )
    await expect(byArgos(newer!.id, "distrito")).rejects.toThrow()
    // Otra clave de la misma familia, sí.
    await byArgos(newer!.id, "gustos")
  })
})

describe("quien escribe puede no ser la clienta", () => {
  it("un chat con pedidos de dos familias: Argos no anota lo del chat y el permiso sin ficha no cuenta", async () => {
    const elsewhere = await chat("whatsapp", "Ruth")
    await says(elsewhere, "hola")
    const ruth = (await buys(elsewhere, ids.t38, { customerName: "Ruth Silva" })).customerId!
    const shared = await chat("whatsapp", "Zoe")
    const said = await says(shared, "sí avísame, vivo en Breña [mezcla]")
    const zoe = (await buys(shared, ids.t38, { customerName: "Zoe Lara" })).customerId!
    await buys(shared, ids.t39, { customerId: ruth, customerName: "Ruth Silva" })
    answers.set("[mezcla]", [{ clave: "distrito", valor: "Breña", cita: "vivo en Breña" }])
    requests.length = 0
    await profileStore(db.appDb, storeId, new Date(), model)
    const read = requests.map((r) => r.messages.map((m) => String(m.content)).join("\n")).join("\n")
    expect(read).not.toContain("[mezcla]")
    for (const id of [zoe, ruth])
      expect((await factsOf(id)).filter((f) => f.source === "chat")).toEqual([])
    expect(await asArgos((tx) => readingOf(tx, storeId, shared))).toBe(said.seq)

    // Sofi lo anotó sin ficha: no cuenta para ninguna de las dos.
    await asSofi((tx) =>
      tx.insert(customerConsent).values({
        storeId,
        customerId: null,
        conversationId: shared,
        channel: "whatsapp",
        state: "si",
        messageId: said.id,
        quote: "sí avísame",
        actorUserId: SOFI_ACTOR,
      }),
    )
    for (const id of [zoe, ruth])
      expect((await ficha(id)).profile.consent.state).toBe("sin_preguntar")

    // En un chat con solo pedidos de ella, sí cuenta aunque se anotó sin ficha.
    const own = await chat("whatsapp", "Ruth")
    const yes = await says(own, "dale, avísame")
    await buys(own, ids.t38, { customerId: ruth, customerName: "Ruth Silva" })
    await asSofi((tx) =>
      tx.insert(customerConsent).values({
        storeId,
        customerId: null,
        conversationId: own,
        channel: "whatsapp",
        state: "si",
        messageId: yes.id,
        quote: "avísame",
        actorUserId: SOFI_ACTOR,
      }),
    )
    expect((await ficha(ruth)).profile.consent.state).toBe("si")
    expect((await ficha(zoe)).profile.consent.state).toBe("sin_preguntar")
  })
})

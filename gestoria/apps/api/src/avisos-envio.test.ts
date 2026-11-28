/**
 * Los avisos al celular (tablero 15) contra una base real y un token firmado como el de la
 * cuenta: activar un celular y elegir qué llega, a cada rol lo suyo, el siguiente del mismo tipo
 * reemplaza al anterior, lo de la misma persona no se le avisa, lo de prueba no avisa y quien
 * deja la tienda deja de recibirlos. El servicio de push es de mentira: prueba nuestro código, no
 * que el aviso llegue a un celular.
 */
import { randomUUID } from "node:crypto"
import {
  conversation,
  orderEvent,
  productQuestion,
  pushChoice,
  pushDevice,
  saleOrder,
  store,
  storeMember,
} from "@gestoria/db"
import { startTestDb, type TestDb } from "@gestoria/db/testing"
import { and, eq } from "drizzle-orm"
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { SOFI_ACTOR } from "./agente.js"
import { createApp } from "./app.js"
import { collectPushes, type PushDelivery, runPushRound } from "./avisos.js"

const ACCOUNT = "https://api.gestoria.test"
const WEB = "https://app.gestoria.test"
const SERVER = "https://servidor.gestoria.test"

let db: TestDb
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"]
let app: ReturnType<typeof createApp>

const people = {
  rosa: { id: "u-rosa", email: "rosa@calzados.test", name: "Rosa Quispe" },
  lucia: { id: "u-lucia", email: "lucia@calzados.test", name: "Lucía Torres" },
  kevin: { id: "u-kevin", email: "kevin@calzados.test", name: "Kevin Paz" },
}
type Who = keyof typeof people
const storeId = randomUUID()
const base = `/api/tiendas/${storeId}`
const keys = { p256dh: `B${"r".repeat(86)}`, auth: "s".repeat(22) }
const endpointOf = (who: Who) => `https://fcm.googleapis.com/fcm/send/${who}`

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

let orderNumber = 0
/** Un pedido con lo mínimo, y un paso suyo. */
async function orderWith(
  action: "comprobante" | "pago_link" | "no_entregado" | "creado",
  actorUserId: string | null,
  detail: Record<string, unknown> = {},
  test = false,
) {
  orderNumber += 1
  const [order] = await db.ownerDb
    .insert(saleOrder)
    .values({
      storeId,
      number: orderNumber,
      state: "por_pagar",
      channel: "whatsapp",
      customerName: "Carla Mendoza",
      deliveryName: "Reparto",
      deliveryType: "DeliveryModeOwnFleet",
      deliveryListCents: 0,
      deliveryCents: 0,
      paymentName: "Yape",
      paymentCollection: "comprobante",
      itemsAutoCents: 8500,
      subtotalCents: 8500,
      totalCents: 8500,
      test,
      createdBy: actorUserId ?? people.rosa.id,
    })
    .returning({ id: saleOrder.id })
  await db.ownerDb
    .insert(orderEvent)
    .values({ storeId, orderId: order!.id, actorUserId, action, detail })
  return order!.id
}

const titlesFor = (deliveries: PushDelivery[], who: Who) =>
  deliveries
    .filter((delivery) => delivery.endpoint === endpointOf(who))
    // El monto lleva un espacio que no se corta (como lo escribe `Intl`).
    .map((delivery) => delivery.message.title.replace(/\s/g, " "))
    .sort()

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
    vapidPublicKey: "BPublicaDePrueba",
  })
  for (const who of Object.keys(people) as Who[]) await call(who, "GET", "/api/yo")
  await db.ownerDb
    .insert(store)
    .values({ id: storeId, name: "Calzados Rosa", currency: "PEN", createdBy: people.rosa.id })
  await db.ownerDb.insert(storeMember).values([
    { storeId, userId: people.rosa.id, role: "owner" },
    { storeId, userId: people.lucia.id, role: "sales", addedBy: people.rosa.id },
    { storeId, userId: people.kevin.id, role: "sales", addedBy: people.rosa.id },
  ])
})

afterAll(async () => {
  await db?.stop()
})

describe("activar un celular y elegir qué llega", () => {
  it("cada persona activa su celular una vez y lo apaga en ese celular", async () => {
    expect((await call("rosa", "GET", "/api/avisos/clave")).json).toEqual({
      publicKey: "BPublicaDePrueba",
    })
    for (const who of ["rosa", "lucia", "kevin"] as const)
      expect(
        (await call(who, "POST", "/api/avisos/celular", { endpoint: endpointOf(who), keys }))
          .status,
      ).toBe(200)
    expect(
      (await call("lucia", "POST", "/api/avisos/celular/estado", { endpoint: endpointOf("lucia") }))
        .json,
    ).toEqual({ active: true })
    // Otra dirección que no es un servicio de push, no.
    expect(
      (
        await call("lucia", "POST", "/api/avisos/celular", {
          endpoint: "https://servidor-interno.local/x",
          keys,
        })
      ).status,
    ).toBe(400)
  })

  it("el celular de otra persona no se toma con la dirección sola", async () => {
    const taken = await call("lucia", "POST", "/api/avisos/celular", {
      endpoint: endpointOf("rosa"),
      keys: { ...keys, auth: "t".repeat(22) },
    })
    expect(taken.status).toBe(409)
    expect(
      (await call("lucia", "POST", "/api/avisos/celular/estado", { endpoint: endpointOf("rosa") }))
        .json,
    ).toEqual({ active: false })
  })

  it("Ventas elige entre lo que resuelve; lo de dinero no es suyo", async () => {
    const mine = await call("lucia", "GET", `${base}/avisos`)
    expect(mine.status).toBe(200)
    expect(mine.json.kinds.map((kind: Json) => [kind.kind, kind.on])).toEqual([
      ["pagos", true],
      ["chats", true],
      ["no_entregado", true],
      ["sofi_pedido", false],
      ["preguntas", true],
    ])
    expect(mine.json.devices).toBe(1)
    expect(
      (await call("lucia", "PATCH", `${base}/avisos`, { kinds: ["pagos", "dinero"] })).status,
    ).toBe(403)
    const saved = await call("lucia", "PATCH", `${base}/avisos`, {
      kinds: ["pagos", "no_entregado", "sofi_pedido"],
    })
    expect(saved.json.kinds.filter((kind: Json) => kind.on).map((kind: Json) => kind.kind)).toEqual(
      ["pagos", "no_entregado", "sofi_pedido"],
    )
    const owner = await call("rosa", "GET", `${base}/avisos`)
    expect(owner.json.kinds.map((kind: Json) => kind.kind)).toContain("dinero")
  })
})

describe("el envío", () => {
  it("la primera vez solo dice «Listo»: lo que ya estaba no se avisa", async () => {
    await orderWith("comprobante", SOFI_ACTOR, { monto: 8500, medio: "Yape" })
    const first = await collectPushes(db.ownerDb)
    expect(first.map((delivery) => delivery.message.title)).toEqual(["Listo", "Listo", "Listo"])
    expect(await collectPushes(db.ownerDb)).toEqual([])
  })

  it("a cada rol lo suyo, lo más nuevo de cada tipo y nada de lo que hizo uno mismo", async () => {
    await orderWith("comprobante", SOFI_ACTOR, { monto: 8500, medio: "Yape" })
    await orderWith("comprobante", SOFI_ACTOR, { monto: 14900, medio: "Plin" })
    await orderWith("pago_link", null, { monto: 13900 })
    await orderWith("no_entregado", people.kevin.id, { motivo: "No contestó", dia: "jue, 27 nov" })
    await orderWith("creado", SOFI_ACTOR)
    await orderWith("creado", people.lucia.id)
    // Lo de «Probar a Sofi» no avisa.
    await orderWith("comprobante", SOFI_ACTOR, { monto: 100, medio: "Yape" }, true)
    const deliveries = await collectPushes(db.ownerDb)

    // Rosa (Dueño): todo, también lo de dinero; un solo «por confirmar», el último.
    expect(titlesFor(deliveries, "rosa")).toEqual(
      [
        "Carla Mendoza envió su Plin de S/ 149",
        "Entró un pago por link",
        "No se entregó el 0005 de Carla Mendoza",
        "Sofi armó un pedido",
      ].sort(),
    )
    // Lucía (Ventas) eligió los pedidos de Sofi; lo de dinero no le llega.
    expect(titlesFor(deliveries, "lucia")).toEqual(
      [
        "Carla Mendoza envió su Plin de S/ 149",
        "No se entregó el 0005 de Carla Mendoza",
        "Sofi armó un pedido",
      ].sort(),
    )
    // Kevin (Ventas, sin elegir): sin los pedidos de Sofi y sin su propio «No se entregó».
    expect(titlesFor(deliveries, "kevin")).toEqual(["Carla Mendoza envió su Plin de S/ 149"])
    for (const delivery of deliveries) {
      expect(delivery.message.href).toMatch(new RegExp(`^/tiendas/${storeId}/pedidos\\?pedido=`))
      expect(delivery.message.tag.endsWith(`:${storeId}`)).toBe(true)
    }
    // Ya anotado: no se repite.
    expect(await collectPushes(db.ownerDb)).toEqual([])
  })

  it("un chat que Sofi pasa a una persona avisa una vez; los de prueba no", async () => {
    await db.ownerDb.insert(conversation).values([
      {
        storeId,
        channel: "whatsapp",
        customerName: "Carla Mendoza",
        handler: "persona",
        waitingReason: "El cliente lo pidió",
        createdBy: SOFI_ACTOR,
      },
      {
        storeId,
        channel: "prueba",
        handler: "persona",
        waitingReason: "Un reclamo",
        createdBy: people.rosa.id,
      },
    ])
    const deliveries = await collectPushes(db.ownerDb)
    for (const who of ["rosa", "kevin"] as const)
      expect(titlesFor(deliveries, who)).toEqual(["Carla Mendoza pide hablar con una persona"])
    // Lucía los apagó al elegir: lo que elige manda.
    expect(titlesFor(deliveries, "lucia")).toEqual([])
    expect(await collectPushes(db.ownerDb)).toEqual([])
  })

  it("lo que Sofi no supo avisa una vez a quien atiende; lo de la prueba no", async () => {
    const created = await call("rosa", "POST", `${base}/productos`, {
      name: "Zapatilla de lona",
      listPriceCents: 11900,
    })
    const productId = created.json.product.id as string
    const chats = await db.ownerDb
      .insert(conversation)
      .values([
        { storeId, channel: "whatsapp", customerName: "Valeria", createdBy: SOFI_ACTOR },
        { storeId, channel: "prueba", createdBy: people.rosa.id },
      ])
      .returning({ id: conversation.id })
    await db.ownerDb.insert(productQuestion).values(
      chats.map((chat, i) => ({
        storeId,
        productId,
        conversationId: chat.id,
        question: i === 0 ? "¿Destiñe al lavarla?" : "¿Es de la prueba?",
        askedBy: SOFI_ACTOR,
      })),
    )
    const deliveries = await collectPushes(db.ownerDb)
    for (const who of ["rosa", "kevin"] as const)
      expect(titlesFor(deliveries, who)).toEqual(["Sofi no supo: «¿Destiñe al lavarla?»"])
    // Lucía eligió sin este tipo: lo que elige manda.
    expect(titlesFor(deliveries, "lucia")).toEqual([])
    expect(deliveries.find((d) => d.message.title.startsWith("Sofi no supo"))?.message.href).toBe(
      `/tiendas/${storeId}`,
    )
    expect(await collectPushes(db.ownerDb)).toEqual([])
  })

  it("el celular que ya no existe se olvida, y quien deja la tienda deja de recibirlos", async () => {
    await orderWith("comprobante", SOFI_ACTOR, { monto: 5000, medio: "Yape" })
    const sent: string[] = []
    const result = await runPushRound(db.ownerDb, {
      async send(delivery) {
        sent.push(delivery.endpoint)
        return { gone: delivery.endpoint === endpointOf("kevin") }
      },
    })
    expect(result).toMatchObject({ sent: 2, gone: 1, uncertain: 0 })
    const kevin = await db.ownerDb
      .select()
      .from(pushDevice)
      .where(eq(pushDevice.userId, people.kevin.id))
    expect(kevin).toEqual([])

    await db.ownerDb
      .delete(storeMember)
      .where(and(eq(storeMember.storeId, storeId), eq(storeMember.userId, people.lucia.id)))
    const left = await db.ownerDb
      .select()
      .from(pushChoice)
      .where(eq(pushChoice.userId, people.lucia.id))
    expect(left).toEqual([])
    await orderWith("comprobante", SOFI_ACTOR, { monto: 7000, medio: "Yape" })
    const deliveries = await collectPushes(db.ownerDb)
    expect(titlesFor(deliveries, "lucia")).toEqual([])
    expect(titlesFor(deliveries, "rosa")).toEqual(["Carla Mendoza envió su Yape de S/ 70"])
  })

  it("«Apagar en este celular» deja de enviarle", async () => {
    expect(
      (await call("rosa", "DELETE", "/api/avisos/celular", { endpoint: endpointOf("rosa") })).json,
    ).toEqual({ active: false })
    await orderWith("comprobante", SOFI_ACTOR, { monto: 7000, medio: "Yape" })
    expect(await collectPushes(db.ownerDb)).toEqual([])
  })

  it("al volver a activarlos no llega lo que pasó mientras estuvieron apagados", async () => {
    await orderWith("no_entregado", people.kevin.id, { motivo: "No contestó", dia: "vie, 28 nov" })
    expect(
      (await call("rosa", "POST", "/api/avisos/celular", { endpoint: endpointOf("rosa"), keys }))
        .status,
    ).toBe(200)
    const again = await collectPushes(db.ownerDb)
    expect(again.map((delivery) => delivery.message.title)).toEqual(["Listo"])
    await orderWith("comprobante", SOFI_ACTOR, { monto: 3000, medio: "Yape" })
    expect(titlesFor(await collectPushes(db.ownerDb), "rosa")).toEqual([
      "Carla Mendoza envió su Yape de S/ 30",
    ])
  })
})

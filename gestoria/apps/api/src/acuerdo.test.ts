/**
 * El acuerdo con la administración (paso B7) contra una base real y una administración de mentira
 * que habla el acuerdo de verdad (`@odentia/contract`: su esquema y su firma). Prueba que nada se
 * cuenta dos veces aunque se pierda una respuesta, que nada se pierde si la administración no
 * responde, que la app sigue sin ella y que Sofi y Argos se detienen solo cuando la administración
 * lo dice.
 */
import { randomUUID } from "node:crypto"
import {
  contractOutbox,
  contractState,
  conversation,
  conversationMessage,
  stockRequest,
  storeAgent,
  storeMember,
  withPerson,
} from "@gestoria/db"
import { startTestDb, type TestDb } from "@gestoria/db/testing"
import {
  type AccountState,
  type AppEvent,
  appEvent,
  CONTRACT_PATHS,
  stateQuestion,
} from "@odentia/contract"
import { verifySignedMessage } from "@odentia/contract/signing"
import { and, eq } from "drizzle-orm"
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  askSupport,
  CONVERSATION_WINDOW_MS,
  type ContractConfig,
  countConversation,
  deliverOutbox,
  purgeOutbox,
  refreshStates,
  reviewStoreTeams,
  saveState,
} from "./acuerdo.js"
import { SOFI_ACTOR, withAgent } from "./agente.js"
import { createApp } from "./app.js"
import { defaultLinkAdapters } from "./link-de-pago.js"
import { runArgos } from "./sofi/argos.js"
import type { ChatModel } from "./sofi/modelo.js"
import { answer, type SofiDeps } from "./sofi/sofi.js"

const ACCOUNT = "https://api.gestoria.test"
const WEB = "https://app.gestoria.test"
const SERVER = "https://servidor.gestoria.test"
const SECRET = `whsec_${Buffer.alloc(32, 7).toString("base64")}`

// biome-ignore lint/suspicious/noExplicitAny: las pruebas leen respuestas JSON de forma libre
type Json = Record<string, any>

/**
 * La administración de mentira: comprueba la firma y el esquema como la de verdad, reconoce un
 * repetido por su clave y cuenta cada aviso una sola vez. Puede caerse o perder una respuesta
 * después de haber guardado el aviso (el caso que obliga a reintentar con la misma clave).
 */
const admin = {
  up: true,
  /** La próxima respuesta a un aviso se pierde después de guardarlo. */
  loseNextReply: false,
  received: new Map<string, AppEvent>(),
  deliveries: 0,
  states: new Map<string, Partial<AccountState>>(),
  /** Las cuentas cuyos avisos rechaza (422), sin estar caída. */
  reject: new Set<string>(),
}

const adminFetch: typeof fetch = async (input, init) => {
  if (!admin.up) throw new TypeError("fetch failed")
  const url = new URL(String(input))
  const body = String(init?.body ?? "")
  const id = verifySignedMessage({ secret: SECRET, headers: new Headers(init?.headers), body })
  if (!id || url.origin !== ACCOUNT) return Response.json({}, { status: 401 })
  if (url.pathname === CONTRACT_PATHS.events) {
    admin.deliveries++
    const event = appEvent.parse(JSON.parse(body))
    if (admin.reject.has(event.data.account)) return Response.json({}, { status: 422 })
    const repeated = admin.received.has(id)
    if (!repeated) admin.received.set(id, event)
    if (admin.loseNextReply) {
      admin.loseNextReply = false
      throw new TypeError("fetch failed")
    }
    return Response.json({ received: true, repeated })
  }
  const { account } = stateQuestion.parse(JSON.parse(body))
  const known = admin.states.get(account)
  const empty: AccountState = {
    account,
    found: false,
    at: new Date().toISOString(),
    access: null,
    agents: null,
    budget: null,
    plan: null,
    charges: [],
    payments: [],
    notices: [],
    paymentMethods: [],
    support: [],
  }
  return Response.json({ ...empty, ...(known ? { found: true, ...known } : {}) })
}

const contract: ContractConfig = { url: ACCOUNT, secret: SECRET, fetch: adminFetch }

let db: TestDb
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"]
let app: ReturnType<typeof createApp>
let storeId = ""

const people = {
  rosa: { id: "u-rosa", email: "rosa@calzados.test", name: "Rosa Quispe" },
  mario: { id: "u-mario", email: "mario@calzados.test", name: "Mario Rojas" },
  lucia: { id: "u-lucia", email: "lucia@calzados.test", name: "Lucía Torres" },
}
type Who = keyof typeof people

async function call(who: Who, method: string, path: string, body?: unknown) {
  const p = people[who]
  const iat = Math.floor(Date.now() / 1000)
  const token = await new SignJWT({
    email: p.email,
    emailVerified: true,
    name: p.name,
    image: null,
  })
    .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
    .setSubject(p.id)
    .setIssuer(ACCOUNT)
    .setAudience("gestoria")
    .setIssuedAt(iat)
    .setExpirationTime(iat + 900)
    .sign(privateKey)
  const response = await app.request(`${SERVER}${path}`, {
    method,
    headers: {
      origin: WEB,
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { status: response.status, json: (text ? JSON.parse(text) : {}) as Json }
}

/** El modelo controlado: siempre saluda, sin importes (nunca la red). */
let modelCalls = 0
const model: ChatModel = {
  name: "gpt-6-luna",
  async complete() {
    modelCalls++
    return {
      content: "¡Hola! Soy Sofi, ¿qué estás buscando?",
      toolCalls: [],
      usage: { input: 100, cached: 0, output: 10 },
    }
  },
}

function sofiDeps(now?: Date): SofiDeps {
  return {
    appDb: db.appDb,
    lockDb: db.ownerDb,
    model,
    link: { adapters: defaultLinkAdapters(), secretsKey: null, apiURL: SERVER },
    ...(now ? { now: () => now } : {}),
  }
}

/** Una conversación de WhatsApp con un mensaje del cliente (el canal llega en B2). */
async function whatsappConversation(): Promise<string> {
  const [conv] = await db.ownerDb
    .insert(conversation)
    .values({ storeId, channel: "whatsapp", createdBy: "u-rosa", customerName: "Carla" })
    .returning({ id: conversation.id })
  await customerWrites(conv!.id)
  return conv!.id
}

async function customerWrites(conversationId: string) {
  await db.ownerDb.insert(conversationMessage).values({
    storeId,
    conversationId,
    author: "cliente",
    text: "Hola, ¿tienen zapatillas?",
    actorUserId: "u-rosa",
  })
}

const outbox = (type?: string) =>
  db.ownerDb
    .select()
    .from(contractOutbox)
    .where(
      type
        ? and(eq(contractOutbox.storeId, storeId), eq(contractOutbox.type, type as "uso.contado"))
        : eq(contractOutbox.storeId, storeId),
    )
    .orderBy(contractOutbox.createdAt)

const counted = (type: AppEvent["type"]) =>
  [...admin.received.values()].filter((event) => event.type === type)

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
    model,
    contract,
  })
  for (const who of Object.keys(people) as Who[]) await call(who, "GET", "/api/yo")
}, 180_000)

afterAll(async () => {
  await db?.stop()
})

describe("gestorIA avisa a la administración", () => {
  it("al crear la tienda le abre su cuenta, con su país y su Dueño, en la misma transacción", async () => {
    const created = await call("rosa", "POST", "/api/tiendas", {
      name: "Calzados Rosa",
      currency: "PEN",
      country: "pe",
    })
    expect(created.status).toBe(201)
    storeId = created.json.store.id
    const [opened] = await outbox("cuenta.abierta")
    expect(opened?.payload).toMatchObject({
      type: "cuenta.abierta",
      data: { account: storeId, name: "Calzados Rosa", country: "PE", ownerUserId: "u-rosa" },
    })
    expect(opened?.sentAt).toBeNull()
    // Un país que no es ISO 3166-1 no entra.
    const wrong = await call("rosa", "POST", "/api/tiendas", {
      name: "Otra",
      currency: "PEN",
      country: "Perú",
    })
    expect(wrong.status).toBe(400)
  })

  it("si se pierde la respuesta, reintenta con la misma clave y la administración no lo cuenta dos veces", async () => {
    admin.loseNextReply = true
    const first = await deliverOutbox(db.ownerDb, contract)
    expect(first).toEqual({ sent: 0, failed: 1 })
    const [pending] = await outbox("cuenta.abierta")
    expect(pending?.sentAt).toBeNull()
    expect(pending?.attempts).toBe(1)
    expect(pending?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now())
    // A la hora del reintento sale con la misma clave: la administración ya lo tenía. Detrás, el
    // equipo de la tienda para la cuenta.
    const later = new Date(Date.now() + 60_000)
    expect(await deliverOutbox(db.ownerDb, contract, later)).toEqual({ sent: 2, failed: 0 })
    expect(admin.deliveries).toBe(3)
    expect(counted("cuenta.abierta")).toHaveLength(1)
    const [team] = await outbox("equipo.cambiado")
    expect([...admin.received.keys()]).toEqual([pending!.id, team!.id])
    // Lo enviado no vuelve a salir.
    expect(await deliverOutbox(db.ownerDb, contract, later)).toEqual({ sent: 0, failed: 0 })
  })

  it("solo avisa otra vez si cambió el Dueño", async () => {
    await db.ownerDb.insert(storeMember).values([
      { storeId, userId: "u-mario", role: "admin", addedBy: "u-rosa" },
      { storeId, userId: "u-lucia", role: "sales", addedBy: "u-rosa" },
    ])
    // Mario pasa a Dueño: Rosa sigue siendo la Dueña más antigua, nada que avisar.
    expect(
      (await call("rosa", "PATCH", `/api/tiendas/${storeId}/equipo/u-mario`, { role: "owner" }))
        .status,
    ).toBe(204)
    expect(await outbox("cuenta.abierta")).toHaveLength(1)
    // Rosa deja la tienda: ahora el Dueño es Mario.
    expect((await call("mario", "DELETE", `/api/tiendas/${storeId}/equipo/u-rosa`)).status).toBe(
      204,
    )
    const opened = await outbox("cuenta.abierta")
    expect(opened).toHaveLength(2)
    expect(opened[1]?.payload).toMatchObject({ data: { ownerUserId: "u-mario" } })
    // Rosa vuelve como Dueña para las pruebas siguientes.
    await db.ownerDb.insert(storeMember).values({ storeId, userId: "u-rosa", role: "owner" })
  })

  it("Sofi cuenta una conversación de verdad una vez por ventana, y sube a «pedido»; la de prueba nunca", async () => {
    await db.ownerDb.insert(storeAgent).values({ storeId, enabled: true, updatedBy: "u-rosa" })
    const convId = await whatsappConversation()
    const now = new Date()
    expect((await answer(sofiDeps(now), storeId, convId)).status).toBe("respondio")
    // El cliente escribe otra vez en la misma ventana: no se cuenta de nuevo.
    await customerWrites(convId)
    expect((await answer(sofiDeps(new Date(now.getTime() + 60_000)), storeId, convId)).status).toBe(
      "respondio",
    )
    let usage = await outbox("uso.contado")
    expect(usage).toHaveLength(1)
    expect(usage[0]?.payload).toMatchObject({
      data: {
        outcome: "atendida",
        conversation: `${convId}:${now.getTime()}`,
        channel: "whatsapp",
      },
    })
    // Tomó un pedido en la misma ventana: sube, con la misma clave de conversación.
    const pedido = async (at: Date) =>
      withAgent(db.appDb, SOFI_ACTOR, storeId, (tx) =>
        countConversation(tx, storeId, { id: convId, channel: "whatsapp" }, "pedido", at),
      )
    await pedido(new Date(now.getTime() + 120_000))
    await pedido(new Date(now.getTime() + 180_000))
    usage = await outbox("uso.contado")
    expect(usage).toHaveLength(2)
    expect(usage[1]?.payload).toMatchObject({
      data: { outcome: "pedido", conversation: `${convId}:${now.getTime()}` },
    })
    // Pasadas 24 horas, es otra conversación que se cobra.
    const tomorrow = new Date(now.getTime() + CONVERSATION_WINDOW_MS + 1000)
    await customerWrites(convId)
    expect((await answer(sofiDeps(tomorrow), storeId, convId)).status).toBe("respondio")
    usage = await outbox("uso.contado")
    expect(usage).toHaveLength(3)
    expect(usage[2]?.payload).toMatchObject({
      data: { outcome: "atendida", conversation: `${convId}:${tomorrow.getTime()}` },
    })
    // La conversación de «Probar a Sofi» no se cobra.
    const test = await call("rosa", "POST", `/api/tiendas/${storeId}/sofi/pruebas`)
    await call("rosa", "POST", `/api/tiendas/${storeId}/conversaciones/${test.json.id}/cliente`, {
      text: "Hola",
    })
    expect(await outbox("uso.contado")).toHaveLength(3)
    // Una persona no puede anotar uso a nombre de Sofi; Sofi no puede anotar otra cosa.
    await expect(
      withPerson(db.appDb, { userId: "u-rosa", email: people.rosa.email, storeId }, (tx) =>
        countConversation(tx, storeId, { id: convId, channel: "whatsapp" }, "pedido", tomorrow),
      ),
    ).rejects.toThrow()
  })

  it("si la administración no responde, nada se pierde: sale después con su misma clave", async () => {
    admin.up = false
    const before = admin.received.size
    const later = new Date(Date.now() + 2 * 3_600_000)
    const down = await deliverOutbox(db.ownerDb, contract, later)
    // Se detiene al primer aviso sin respuesta, sin esperar uno por uno.
    expect(down).toEqual({ sent: 0, failed: 1 })
    admin.up = true
    const pendingIds = (await outbox()).filter((row) => !row.sentAt).map((row) => row.id)
    const evenLater = new Date(later.getTime() + 2 * 3_600_000)
    let total = 0
    for (let round = 0; round < 3; round++)
      total += (await deliverOutbox(db.ownerDb, contract, evenLater)).sent
    expect(total).toBe(pendingIds.length)
    expect(admin.received.size).toBe(before + pendingIds.length)
    for (const id of pendingIds) expect(admin.received.has(id)).toBe(true)
    expect(counted("uso.contado")).toHaveLength(3)
  })

  it("sin secreto no envía ni pregunta, guarda lo que pasa y no acepta preguntas de ayuda", async () => {
    const off: ContractConfig = { url: ACCOUNT, secret: "", fetch: adminFetch }
    const rosa = { userId: "u-rosa", email: people.rosa.email, name: people.rosa.name }
    await expect(
      askSupport(db.appDb, off, rosa, storeId, { kind: "pregunta", question: "Hola" }),
    ).rejects.toMatchObject({ status: 409 })
    const deliveries = admin.deliveries
    const ask = await call("rosa", "POST", `/api/tiendas/${storeId}/plan/ayuda`, {
      kind: "cobro",
      question: "¿Cuándo me cobran?",
    })
    expect(ask.status).toBe(204)
    expect(await deliverOutbox(db.ownerDb, off)).toEqual({ sent: 0, failed: 0 })
    expect(await refreshStates(db.ownerDb, off)).toBe(0)
    expect(admin.deliveries).toBe(deliveries)
    const [support] = await outbox("soporte.pedido")
    expect(support?.payload).toMatchObject({
      data: { userId: "u-rosa", kind: "cobro", question: "¿Cuándo me cobran?" },
    })
  })
})

describe("gestorIA pregunta y nunca se detiene por la administración", () => {
  it("si nunca supo nada, Sofi atiende; si la administración no la conoce, le avisa otra vez", async () => {
    await deliverOutbox(db.ownerDb, contract, new Date(Date.now() + 10 * 3_600_000))
    const opened = (await outbox("cuenta.abierta")).length
    expect(await refreshStates(db.ownerDb, contract)).toBe(1)
    const [row] = await db.ownerDb.select().from(contractState)
    expect(row?.state).toMatchObject({ found: false })
    // Se le avisó hace poco: no se repite en cada vuelta.
    expect(await outbox("cuenta.abierta")).toHaveLength(opened)
    // Pasado un día sin que la conozca, se le avisa otra vez.
    await db.ownerDb
      .update(contractOutbox)
      .set({ createdAt: new Date(Date.now() - 2 * 86_400_000) })
      .where(and(eq(contractOutbox.storeId, storeId), eq(contractOutbox.type, "cuenta.abierta")))
    await db.ownerDb.delete(contractState).where(eq(contractState.storeId, storeId))
    expect(await refreshStates(db.ownerDb, contract)).toBe(1)
    expect(await outbox("cuenta.abierta")).toHaveLength(opened + 1)
    const convId = await whatsappConversation()
    expect((await answer(sofiDeps(), storeId, convId)).status).toBe("respondio")
  })

  it("Sofi se detiene en lo de verdad cuando la administración lo dice; la prueba sigue", async () => {
    admin.states.set(storeId, {
      access: {
        allowed: true,
        status: "activa",
        reason: null,
        readOnlyAt: null,
        trialEndsAt: null,
      },
      agents: { trialExhausted: false, capReached: true },
    })
    // Se pregunta otra vez pasados 10 minutos.
    expect(await refreshStates(db.ownerDb, contract, new Date(Date.now() + 11 * 60_000))).toBe(1)
    const convId = await whatsappConversation()
    const calls = modelCalls
    expect(await answer(sofiDeps(), storeId, convId)).toEqual({
      status: "detenida",
      reason: "tope",
    })
    expect(modelCalls).toBe(calls)
    const settings = await call("rosa", "GET", `/api/tiendas/${storeId}/sofi`)
    expect(settings.json.agentStop).toBe("tope")
    const test = await call("rosa", "POST", `/api/tiendas/${storeId}/sofi/pruebas`)
    const sent = await call(
      "rosa",
      "POST",
      `/api/tiendas/${storeId}/conversaciones/${test.json.id}/cliente`,
      { text: "Hola" },
    )
    expect(sent.json.result.status).toBe("respondio")
  })

  it("si la administración cae, sigue con lo último que supo y la pantalla lo dice", async () => {
    admin.up = false
    expect(await refreshStates(db.ownerDb, contract, new Date(Date.now() + 22 * 60_000))).toBe(0)
    const [row] = await db.ownerDb.select().from(contractState)
    expect(row?.lastError).toBe("La administración no respondió")
    expect(row?.state).toMatchObject({ found: true, agents: { capReached: true } })
    const convId = await whatsappConversation()
    expect((await answer(sofiDeps(), storeId, convId)).status).toBe("detenida")
    const view = await call("rosa", "GET", `/api/tiendas/${storeId}/plan`)
    expect(view.status).toBe(200)
    expect(view.json).toMatchObject({
      connected: true,
      stale: true,
      agentStop: "tope",
      state: { found: true },
    })
    // La pregunta ya salió pero la administración aún no la devolvió entre sus casos: se ve «Enviada».
    expect(view.json.pendingSupport).toMatchObject([{ question: "¿Cuándo me cobran?", sent: true }])
    admin.up = true
  })

  it("«Plan y pagos» es solo del Dueño", async () => {
    expect((await call("mario", "GET", `/api/tiendas/${storeId}/plan`)).status).toBe(200)
    await db.ownerDb
      .update(storeMember)
      .set({ role: "admin" })
      .where(and(eq(storeMember.storeId, storeId), eq(storeMember.userId, "u-mario")))
    expect((await call("mario", "GET", `/api/tiendas/${storeId}/plan`)).status).toBe(403)
    expect((await call("lucia", "GET", `/api/tiendas/${storeId}/plan`)).status).toBe(403)
    expect(
      (
        await call("lucia", "POST", `/api/tiendas/${storeId}/plan/ayuda`, {
          kind: "pregunta",
          question: "Hola",
        })
      ).status,
    ).toBe(403)
    const stranger = randomUUID()
    expect((await call("rosa", "GET", `/api/tiendas/${stranger}/plan`)).status).toBe(404)
  })
})

describe("Argos se detiene con Sofi", () => {
  it("no escribe si la administración dice que no puede seguir, sin saldo de prueba o en su tope; sí si nunca respondió", async () => {
    // Otra tienda, con Sofi encendida y un cliente que espera que vuelva una talla que ya entró.
    const created = await call("rosa", "POST", "/api/tiendas", {
      name: "Tienda de Argos",
      currency: "PEN",
    })
    const shopId = created.json.store.id as string
    const base = `/api/tiendas/${shopId}`
    await db.ownerDb
      .insert(storeAgent)
      .values({ storeId: shopId, enabled: true, updatedBy: "u-rosa" })
    const made = await call("rosa", "POST", `${base}/productos`, {
      name: "Sandalia",
      listPriceCents: 5000,
    })
    const variantId = (await call("rosa", "GET", `${base}/productos/${made.json.product.id}`)).json
      .product.variants[0].id as string
    expect(
      (
        await call("rosa", "POST", `${base}/variantes/${variantId}/movimientos`, {
          kind: "entrada",
          quantity: 3,
        })
      ).status,
    ).toBe(201)
    const [conv] = await db.ownerDb
      .insert(conversation)
      .values({ storeId: shopId, channel: "whatsapp", createdBy: "u-rosa", customerName: "Ana" })
      .returning({ id: conversation.id })
    await db.ownerDb
      .insert(stockRequest)
      .values({ storeId: shopId, variantId, conversationId: conv!.id })
    const followUps = async () =>
      (
        await db.ownerDb
          .select({ id: conversationMessage.id })
          .from(conversationMessage)
          .where(
            and(
              eq(conversationMessage.conversationId, conv!.id),
              eq(conversationMessage.followUp, "volvio"),
            ),
          )
      ).length
    const known = (change: Partial<AccountState>): AccountState => ({
      account: shopId,
      found: true,
      at: new Date().toISOString(),
      access: {
        allowed: true,
        status: "activa",
        reason: null,
        readOnlyAt: null,
        trialEndsAt: null,
      },
      agents: { trialExhausted: false, capReached: false },
      budget: null,
      plan: null,
      charges: [],
      payments: [],
      notices: [],
      paymentMethods: [],
      support: [],
      ...change,
    })
    const stops: Partial<AccountState>[] = [
      {
        access: {
          allowed: false,
          status: "restringida",
          reason: "Pago vencido",
          readOnlyAt: null,
          trialEndsAt: null,
        },
      },
      { agents: { trialExhausted: true, capReached: false } },
      { agents: { trialExhausted: false, capReached: true } },
    ]
    for (const stop of stops) {
      await saveState(db.ownerDb, shopId, known(stop), new Date())
      await runArgos(db.ownerDb, db.appDb)
      expect(await followUps()).toBe(0)
    }
    // La administración nunca respondió de esta tienda: Argos sigue.
    await db.ownerDb.delete(contractState).where(eq(contractState.storeId, shopId))
    await runArgos(db.ownerDb, db.appDb)
    expect(await followUps()).toBe(1)
  })
})

describe("el orden de cada tienda", () => {
  it("lo demás de una tienda espera a que salga el aviso de que se abrió, también entre vueltas", async () => {
    const created = await call("rosa", "POST", "/api/tiendas", {
      name: "Tienda nueva",
      currency: "PEN",
    })
    const shopId = created.json.store.id as string
    expect(
      (
        await call("rosa", "POST", `/api/tiendas/${shopId}/plan/ayuda`, {
          kind: "pregunta",
          question: "¿Cómo empiezo?",
        })
      ).status,
    ).toBe(204)
    const ofShop = () => [...admin.received.values()].filter((e) => e.data.account === shopId)
    admin.reject.add(shopId)
    const t0 = new Date(Date.now() + 30 * 3_600_000)
    // Primera vuelta: el aviso de que se abrió falla y su pregunta no sale detrás.
    await deliverOutbox(db.ownerDb, contract, t0)
    // Segunda vuelta, antes del reintento del aviso: la pregunta sigue esperando.
    await deliverOutbox(db.ownerDb, contract, new Date(t0.getTime() + 5_000))
    expect(ofShop()).toEqual([])
    // No se intentó: no gastó reintentos en una cuenta que la administración aún no conoce.
    const [question] = await db.ownerDb
      .select()
      .from(contractOutbox)
      .where(and(eq(contractOutbox.storeId, shopId), eq(contractOutbox.type, "soporte.pedido")))
    expect(question?.attempts).toBe(0)
    // La administración la acepta: sale primero el aviso y después la pregunta.
    admin.reject.delete(shopId)
    await deliverOutbox(db.ownerDb, contract, new Date(t0.getTime() + 3_600_000))
    expect(ofShop().map((e) => e.type)).toEqual([
      "cuenta.abierta",
      "equipo.cambiado",
      "soporte.pedido",
    ])
  })
})

describe("gestorIA avisa a la cuenta quién está en cada tienda (ADR 0217)", () => {
  const teamsOf = async (shopId: string) =>
    (
      await db.ownerDb
        .select()
        .from(contractOutbox)
        .where(and(eq(contractOutbox.storeId, shopId), eq(contractOutbox.type, "equipo.cambiado")))
        .orderBy(contractOutbox.createdAt)
    ).map((row) => {
      const event = appEvent.parse(row.payload)
      if (event.type !== "equipo.cambiado") throw new Error(event.type)
      return event.data
    })

  it("avisa el equipo entero al crear la tienda y en cada cambio, y nada si no cambió", async () => {
    const created = await call("rosa", "POST", "/api/tiendas", {
      name: "Equipo Rosa",
      currency: "PEN",
    })
    const shopId = created.json.store.id as string
    expect(await teamsOf(shopId)).toEqual([
      { account: shopId, name: "Equipo Rosa", members: [{ userId: "u-rosa", role: "owner" }] },
    ])
    // Lucía ya estaba (de antes del aviso) y Rosa la hace Administradora: sale el equipo entero.
    await db.ownerDb
      .insert(storeMember)
      .values({ storeId: shopId, userId: "u-lucia", role: "sales" })
    const toAdmin = () =>
      call("rosa", "PATCH", `/api/tiendas/${shopId}/equipo/u-lucia`, { role: "admin" })
    expect((await toAdmin()).status).toBe(204)
    // El mismo rol otra vez no cambia nada: no se avisa.
    expect((await toAdmin()).status).toBe(204)
    expect((await call("rosa", "DELETE", `/api/tiendas/${shopId}/equipo/u-lucia`)).status).toBe(204)
    expect((await teamsOf(shopId)).map((team) => team.members)).toEqual([
      [{ userId: "u-rosa", role: "owner" }],
      [
        { userId: "u-lucia", role: "admin" },
        { userId: "u-rosa", role: "owner" },
      ],
      [{ userId: "u-rosa", role: "owner" }],
    ])
  })

  it("la revisión avisa lo que no coincide (la carga inicial) y nada más; la limpieza deja el último", async () => {
    const created = await call("rosa", "POST", "/api/tiendas", {
      name: "De antes",
      currency: "PEN",
    })
    const shopId = created.json.store.id as string
    // Como una tienda de antes de este aviso: su equipo nunca se avisó.
    await db.ownerDb
      .delete(contractOutbox)
      .where(and(eq(contractOutbox.storeId, shopId), eq(contractOutbox.type, "equipo.cambiado")))
    await db.ownerDb
      .insert(storeMember)
      .values({ storeId: shopId, userId: "u-mario", role: "sales" })
    expect(await reviewStoreTeams(db.ownerDb)).toBeGreaterThanOrEqual(1)
    expect((await teamsOf(shopId)).map((team) => team.members)).toEqual([
      [
        { userId: "u-mario", role: "sales" },
        { userId: "u-rosa", role: "owner" },
      ],
    ])
    // Otra vuelta: nada que avisar de ninguna tienda.
    expect(await reviewStoreTeams(db.ownerDb)).toBe(0)
    // Salió hace más de una semana: la limpieza lo deja, porque es el último de su equipo.
    await db.ownerDb
      .update(contractOutbox)
      .set({ sentAt: new Date(Date.now() - 8 * 86_400_000) })
      .where(eq(contractOutbox.storeId, shopId))
    await purgeOutbox(db.ownerDb)
    expect(await teamsOf(shopId)).toHaveLength(1)
    expect(await reviewStoreTeams(db.ownerDb)).toBe(0)
  })
})

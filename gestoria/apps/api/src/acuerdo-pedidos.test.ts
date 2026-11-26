/**
 * Lo que pide la administración (ADR 0214) contra una base real: llega firmado, se aplica una sola
 * vez por su clave, abre la tienda de un cliente, quita a una persona sin dejar la tienda sin
 * Dueño y deja entrar a soporte solo si la tienda lo acepta, a mirar y hasta que vence. Y lo que
 * sube el Dueño en «Plan y pagos», la bandeja que se limpia y Sofi en pausa.
 */
import { randomUUID } from "node:crypto"
import {
  contractOutbox,
  conversation,
  conversationMessage,
  store,
  storeAgent,
  storeEvent,
  storeMember,
  storeSupportAccess,
} from "@gestoria/db"
import { startTestDb, type TestDb } from "@gestoria/db/testing"
import {
  type AccountState,
  type AdminRequest,
  APP_CONTRACT_PATHS,
  CONTRACT_PATHS,
} from "@odentia/contract"
import { signMessage } from "@odentia/contract/signing"
import { and, eq } from "drizzle-orm"
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  type ContractConfig,
  deliverOutbox,
  OUTBOX_KEEP_MS,
  purgeOutbox,
  saveState,
} from "./acuerdo.js"
import { createApp } from "./app.js"
import { defaultLinkAdapters } from "./link-de-pago.js"
import { answer } from "./sofi/sofi.js"

const ACCOUNT = "https://api.gestoria.test"
const WEB = "https://app.gestoria.test"
const SERVER = "https://servidor.gestoria.test"
const SECRET = `whsec_${Buffer.alloc(32, 5).toString("base64")}`

// biome-ignore lint/suspicious/noExplicitAny: las pruebas leen respuestas JSON de forma libre
type Json = Record<string, any>

/** Lo que responde la administración a un aviso: se le puede decir que rechace un comprobante. */
const admin = { receiptAnswer: 200 as number, receiptMessage: "Ese cargo ya está pagado" }
const adminFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input))
  const type = (JSON.parse(String(init?.body ?? "{}")) as { type?: string }).type
  if (
    url.pathname === CONTRACT_PATHS.events &&
    type === "pago.comprobante" &&
    admin.receiptAnswer !== 200
  )
    return Response.json(
      { error: { code: "CONFLICT", message: admin.receiptMessage } },
      {
        status: admin.receiptAnswer,
      },
    )
  return Response.json({ received: true, repeated: false })
}
const contract: ContractConfig = { url: ACCOUNT, secret: SECRET, fetch: adminFetch }

let db: TestDb
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"]
let app: ReturnType<typeof createApp>
let storeId = ""

const people: Record<
  "rosa" | "mario" | "soporte" | "soporteConCodigo",
  { id: string; email: string; name: string; staffVerified?: boolean }
> = {
  rosa: { id: "p-rosa", email: "rosa@zapatos.test", name: "Rosa" },
  mario: { id: "p-mario", email: "mario@zapatos.test", name: "Mario" },
  // La misma persona de soporte: entrando directo con su contraseña, o desde la administración
  // con su código (la cuenta lo dice en el token, ADR 0219).
  soporte: { id: "p-soporte", email: "soporte@gestoria.test", name: "Ana de Soporte" },
  soporteConCodigo: {
    id: "p-soporte",
    email: "soporte@gestoria.test",
    name: "Ana de Soporte",
    staffVerified: true,
  },
}
type Who = keyof typeof people

async function token(who: Who) {
  const p = people[who]
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

async function call(who: Who, method: string, path: string, body?: unknown | FormData) {
  const form = body instanceof FormData
  const response = await app.request(`${SERVER}${path}`, {
    method,
    headers: {
      origin: WEB,
      authorization: `Bearer ${await token(who)}`,
      ...(body === undefined || form ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: form ? body : JSON.stringify(body) }),
  })
  const text = await response.text()
  return { status: response.status, json: (text ? JSON.parse(text) : {}) as Json }
}

/** Un pedido de la administración, firmado (o no) con su clave. */
async function ask(request: AdminRequest, id = randomUUID(), secret = SECRET) {
  const body = JSON.stringify(request)
  const response = await app.request(`${SERVER}${APP_CONTRACT_PATHS.requests}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...signMessage({ secret, id, body }) },
    body,
  })
  return { status: response.status, json: (await response.json()) as Json }
}

const now = () => new Date().toISOString()
const events = async (shopId: string) =>
  db.ownerDb.select().from(storeEvent).where(eq(storeEvent.storeId, shopId))

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
    link: { adapters: defaultLinkAdapters(), secretsKey: null, apiURL: SERVER },
    contract,
  })
}, 180_000)

afterAll(async () => {
  await db?.stop()
})

describe("los pedidos de la administración", () => {
  it("abre la tienda de un cliente a nombre de su dueño, aunque nunca haya entrado", async () => {
    storeId = randomUUID()
    const request: AdminRequest = {
      type: "cuenta.abrir",
      timestamp: now(),
      data: {
        account: storeId,
        name: "Zapatos Rosa",
        currency: "PEN",
        country: "PE",
        owner: { userId: people.rosa.id, name: people.rosa.name, email: people.rosa.email },
      },
    }
    const key = randomUUID()
    const first = await ask(request, key)
    expect(first).toEqual({
      status: 200,
      json: { status: "hecho", message: "Tienda abierta: su dueño ya puede entrar." },
    })
    // Repetido con la misma clave: la misma respuesta y nada nuevo.
    expect((await ask(request, key)).json).toEqual(first.json)
    expect(await db.ownerDb.select().from(store).where(eq(store.id, storeId))).toHaveLength(1)
    // Rosa entra con su cuenta y la tienda ya es suya; la administración sabe que se abrió.
    const me = await call("rosa", "GET", "/api/yo")
    expect(me.json.stores).toMatchObject([{ id: storeId, role: "owner", supportUntil: null }])
    const opened = await db.ownerDb
      .select()
      .from(contractOutbox)
      .where(and(eq(contractOutbox.storeId, storeId), eq(contractOutbox.type, "cuenta.abierta")))
    expect(opened).toHaveLength(1)
    expect((await events(storeId)).map((e) => [e.action, e.actorUserId])).toEqual([
      ["tienda.creada", null],
    ])
  })

  it("sin firma, con otra o con algo que no es del acuerdo, no hace nada", async () => {
    const request: AdminRequest = {
      type: "equipo.quitar",
      timestamp: now(),
      data: { account: storeId, userId: people.rosa.id, reason: "Prueba" },
    }
    const other = `whsec_${Buffer.alloc(32, 1).toString("base64")}`
    expect((await ask(request, randomUUID(), other)).status).toBe(401)
    const body = JSON.stringify({ type: "cuenta.cerrar", data: {} })
    const bad = await app.request(`${SERVER}${APP_CONTRACT_PATHS.requests}`, {
      method: "POST",
      headers: signMessage({ secret: SECRET, id: randomUUID(), body }),
      body,
    })
    expect(bad.status).toBe(400)
    expect(
      await db.ownerDb.select().from(storeMember).where(eq(storeMember.storeId, storeId)),
    ).toHaveLength(1)
  })

  it("quita a una persona con el motivo, y nunca al único Dueño", async () => {
    await call("mario", "GET", "/api/yo")
    await db.ownerDb.insert(storeMember).values({ storeId, userId: people.mario.id, role: "sales" })
    const lastOwner = await ask({
      type: "equipo.quitar",
      timestamp: now(),
      data: { account: storeId, userId: people.rosa.id, reason: "Lo pidió por correo" },
    })
    expect(lastOwner.json).toEqual({
      status: "fallo",
      message: "Es el único Dueño de la tienda: antes, la tienda tiene que tener otro Dueño.",
    })
    const removed = await ask({
      type: "equipo.quitar",
      timestamp: now(),
      data: { account: storeId, userId: people.mario.id, reason: "Ya no trabaja aquí" },
    })
    expect(removed.json.status).toBe("hecho")
    expect((await call("mario", "GET", `/api/tiendas/${storeId}`)).status).toBe(404)
    const [event] = (await events(storeId)).filter((e) => e.action === "equipo.quitado")
    expect(event).toMatchObject({
      actorUserId: null,
      subject: people.mario.id,
      detail: { por: "administracion", motivo: "Ya no trabaja aquí" },
    })
    // Quitar a alguien que ya no está: hecho, sin cambiar nada.
    const again = await ask({
      type: "equipo.quitar",
      timestamp: now(),
      data: { account: storeId, userId: people.mario.id, reason: "Ya no trabaja aquí" },
    })
    expect(again.json).toEqual({
      status: "hecho",
      message: "Esa persona ya no estaba en la tienda.",
    })
  })
})

describe("la entrada de soporte", () => {
  const staff = {
    userId: people.soporte.id,
    name: people.soporte.name,
    email: people.soporte.email,
  }
  let accessId = ""
  const askToEnter = () =>
    ask({
      type: "soporte.entrar",
      timestamp: now(),
      data: { account: storeId, staff, minutes: 30, reason: "Ver por qué no carga su catálogo" },
    })
  const mine = (who: Who = "soporteConCodigo") =>
    call(who, "GET", `/api/tiendas/${storeId}/soporte/mio`)

  it("se pide una vez, y soporte no entra hasta que la tienda lo acepta", async () => {
    expect((await askToEnter()).json.status).toBe("hecho")
    // Un pedido por vez: otro sin respuesta falla con su motivo (la tienda solo vería el primero).
    const twice = await askToEnter()
    expect(twice.json).toMatchObject({ status: "fallo" })
    expect(twice.json.message).toMatch(/^Ya lo pediste y la tienda todavía no responde/)
    expect((await call("soporteConCodigo", "GET", "/api/yo")).json.stores).toEqual([])
    // A quien pidió, el servidor le dice que la tienda todavía no responde; a cualquier otra
    // persona, la tienda no existe.
    const waiting = await call("soporteConCodigo", "GET", `/api/tiendas/${storeId}/catalogo`)
    expect([waiting.status, waiting.json.error.code]).toEqual([403, "SUPPORT_PENDING"])
    expect((await mine()).json).toMatchObject({ state: "pendiente" })
    expect((await call("mario", "GET", `/api/tiendas/${storeId}/catalogo`)).status).toBe(404)
    expect((await mine("mario")).status).toBe(404)
    const team = await call("rosa", "GET", `/api/tiendas/${storeId}/equipo`)
    expect(team.json.support).toMatchObject([
      { staffName: "Ana de Soporte", minutes: 30, status: "por_aceptar" },
    ])
    accessId = team.json.support[0].id
  })

  it("solo el Dueño o un Administrador lo acepta; aceptado, soporte solo mira, y queda anotado", async () => {
    await db.ownerDb.insert(storeMember).values({ storeId, userId: people.mario.id, role: "sales" })
    expect(
      (await call("mario", "POST", `/api/tiendas/${storeId}/soporte/${accessId}/aceptar`)).status,
    ).toBe(403)
    expect(
      (await call("rosa", "POST", `/api/tiendas/${storeId}/soporte/${accessId}/aceptar`)).status,
    ).toBe(204)
    expect(
      (await call("rosa", "POST", `/api/tiendas/${storeId}/soporte/${accessId}/aceptar`)).status,
    ).toBe(409)
    const me = await call("soporteConCodigo", "GET", "/api/yo")
    expect(me.json.stores).toMatchObject([
      { id: storeId, role: "support", permissions: ["tienda.ver", "equipo.ver", "catalogo.ver"] },
    ])
    expect(me.json.stores[0].supportUntil).toBeTruthy()
    expect(me.json.person).toEqual({
      userId: people.soporte.id,
      email: people.soporte.email,
      name: people.soporte.name,
    })
    expect((await call("soporteConCodigo", "GET", `/api/tiendas/${storeId}/catalogo`)).status).toBe(
      200,
    )
    // Soporte ve el equipo, pero no la lista de soporte (ya tiene su franja).
    const seen = await call("soporteConCodigo", "GET", `/api/tiendas/${storeId}/equipo`)
    expect([seen.status, seen.json.support]).toEqual([200, []])
    // Nada que cambie ni lo que también escribe (pedidos, conversaciones, el plan).
    expect(
      (
        await call("soporteConCodigo", "POST", `/api/tiendas/${storeId}/productos`, {
          name: "X",
          listPriceCents: 100,
        })
      ).status,
    ).toBe(403)
    expect((await call("soporteConCodigo", "GET", `/api/tiendas/${storeId}/pedidos`)).status).toBe(
      403,
    )
    expect((await call("soporteConCodigo", "GET", `/api/tiendas/${storeId}/plan`)).status).toBe(403)
    expect(
      (await call("soporteConCodigo", "POST", `/api/tiendas/${storeId}/soporte/${accessId}/quitar`))
        .status,
    ).toBe(403)
    // La primera entrada queda anotada una vez.
    const actions = (await events(storeId)).map((e) => e.action)
    expect(actions.filter((a) => a.startsWith("soporte."))).toEqual([
      "soporte.pedido",
      "soporte.aceptado",
      "soporte.entro",
    ])
    // Ventas ve solo quién mira y hasta cuándo, sin el «Para qué».
    const sales = await call("mario", "GET", `/api/tiendas/${storeId}/equipo`)
    expect(sales.json.support).toHaveLength(1)
    expect(sales.json.support[0]).toMatchObject({ staffName: "Ana de Soporte", status: "vigente" })
    expect(sales.json.support[0].reason).toBeUndefined()
    // El Dueño ve quién lo aceptó y desde cuándo mira.
    const owner = await call("rosa", "GET", `/api/tiendas/${storeId}/equipo`)
    expect(owner.json.support[0]).toMatchObject({ answeredByName: "Rosa", ending: null })
    expect(owner.json.support[0].usedAt).toBeTruthy()
  })

  it("sin el código del personal en esta sesión no mira, aunque la tienda lo aceptó", async () => {
    // Entró directo con su contraseña: la tienda no sale en su lista ni se abre.
    expect((await call("soporte", "GET", "/api/yo")).json.stores).toEqual([])
    const direct = await call("soporte", "GET", `/api/tiendas/${storeId}/catalogo`)
    expect([direct.status, direct.json.error.code]).toEqual([403, "SUPPORT_NEEDS_ADMIN"])
    expect(direct.json.error.message).toBe(
      "Para mirar esta tienda, ábrela desde la administración.",
    )
    expect((await mine("soporte")).json).toMatchObject({ state: "falta_codigo" })
    expect((await mine()).json).toMatchObject({ state: "puede_mirar" })
  })

  it("la tienda lo saca cuando quiere, y soporte sabe quién y cuándo", async () => {
    expect(
      (await call("rosa", "POST", `/api/tiendas/${storeId}/soporte/${accessId}/quitar`)).status,
    ).toBe(204)
    const after = await call("soporteConCodigo", "GET", `/api/tiendas/${storeId}/catalogo`)
    expect([after.status, after.json.error.code]).toEqual([403, "SUPPORT_ENDED"])
    expect((await call("soporteConCodigo", "GET", "/api/yo")).json.stores).toEqual([])
    expect((await mine()).json).toMatchObject({
      state: "terminado",
      reason: "quitado",
      byName: "Rosa",
    })
    // Sin el código en esta sesión, sin nombres del equipo de la tienda.
    expect((await mine("soporte")).json).toMatchObject({ reason: "quitado", byName: null })
    const team = await call("rosa", "GET", `/api/tiendas/${storeId}/equipo`)
    expect(team.json.support[0]).toMatchObject({
      status: "terminado",
      ending: { reason: "quitado", by: people.rosa.id, byName: "Rosa" },
    })
  })

  it("«Salir» termina solo su mirada, y queda anotado", async () => {
    expect((await askToEnter()).json.status).toBe("hecho")
    const team = await call("rosa", "GET", `/api/tiendas/${storeId}/equipo`)
    const second = team.json.support.find((row: Json) => row.status === "por_aceptar").id
    await call("rosa", "POST", `/api/tiendas/${storeId}/soporte/${second}/aceptar`)
    // Nadie más puede terminar la mirada de soporte con esto.
    expect((await call("mario", "POST", `/api/tiendas/${storeId}/soporte/salir`)).status).toBe(409)
    expect(
      (await call("soporteConCodigo", "POST", `/api/tiendas/${storeId}/soporte/salir`)).status,
    ).toBe(204)
    expect(
      (await call("soporteConCodigo", "POST", `/api/tiendas/${storeId}/soporte/salir`)).status,
    ).toBe(409)
    expect((await mine()).json).toMatchObject({ state: "terminado", reason: "salio" })
    const actions = (await events(storeId)).map((e) => e.action)
    expect(actions.filter((a) => a === "soporte.salio")).toHaveLength(1)
    const latest = (await call("rosa", "GET", `/api/tiendas/${storeId}/equipo`)).json.support[0]
    // No entró a mirar nada antes de salir: «no entró», con su motivo.
    expect(latest).toMatchObject({ ending: { reason: "salio" } })
  })

  it("se terminó el tiempo o la tienda dijo que no: lo dice con su motivo", async () => {
    expect((await askToEnter()).json.status).toBe("hecho")
    let team = await call("rosa", "GET", `/api/tiendas/${storeId}/equipo`)
    const third = team.json.support.find((row: Json) => row.status === "por_aceptar").id
    await call("rosa", "POST", `/api/tiendas/${storeId}/soporte/${third}/aceptar`)
    // Vence con la pestaña abierta.
    await db.ownerDb
      .update(storeSupportAccess)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(storeSupportAccess.id, third))
    expect((await mine()).json).toMatchObject({ state: "terminado", reason: "tiempo" })
    expect((await askToEnter()).json.status).toBe("hecho")
    team = await call("rosa", "GET", `/api/tiendas/${storeId}/equipo`)
    const fourth = team.json.support.find((row: Json) => row.status === "por_aceptar").id
    await call("rosa", "POST", `/api/tiendas/${storeId}/soporte/${fourth}/rechazar`)
    expect((await mine()).json).toMatchObject({
      state: "terminado",
      reason: "rechazado",
      // A soporte no se le dice quién de la tienda dijo que no.
      byName: null,
    })
  })
})

describe("el comprobante del plan", () => {
  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(40, 2),
  ])
  const state: AccountState = {
    account: "",
    found: true,
    at: now(),
    access: { allowed: true, status: "activa", reason: null, readOnlyAt: null, trialEndsAt: null },
    agents: { trialExhausted: false, capReached: false },
    budget: null,
    plan: null,
    charges: [
      {
        id: "cargo-1",
        periodStart: now(),
        periodEnd: now(),
        amountCents: 1900,
        paidCents: 0,
        currency: "USD",
        status: "pendiente",
        dueAt: null,
        lines: [],
      },
    ],
    payments: [],
    notices: [],
    paymentMethods: [{ code: "yape", name: "Yape", instructions: null }],
    support: [],
  }
  const form = (file: Uint8Array | null, fields: Record<string, string> = {}) => {
    const body = new FormData()
    body.set("chargeId", fields.chargeId ?? "cargo-1")
    body.set("amountCents", fields.amountCents ?? "1900")
    body.set("methodCode", fields.methodCode ?? "yape")
    // El nombre dice PNG; lo que manda es el contenido.
    if (file) body.set("archivo", new Blob([file]), "comprobante.png")
    return body
  }

  it("se mira por su contenido y contra lo último que dijo la administración, y sale por el acuerdo", async () => {
    await saveState(db.ownerDb, storeId, { ...state, account: storeId }, new Date())
    const path = `/api/tiendas/${storeId}/plan/comprobante`
    expect(
      (await call("rosa", "POST", path, form(Buffer.from("<html></html>")))).json.error.code,
    ).toBe("FILE_TYPE")
    expect((await call("rosa", "POST", path, form(null))).status).toBe(400)
    expect(
      (await call("rosa", "POST", path, form(PNG, { amountCents: "5000" }))).json.error.code,
    ).toBe("AMOUNT")
    expect((await call("rosa", "POST", path, form(PNG, { chargeId: "otro" }))).status).toBe(409)
    expect((await call("rosa", "POST", path, form(PNG, { methodCode: "otro" }))).status).toBe(400)
    expect((await call("mario", "POST", path, form(PNG))).status).toBe(403)
    expect((await call("rosa", "POST", path, form(PNG))).status).toBe(204)
    // Otro del mismo cargo mientras el primero no sale: no.
    expect((await call("rosa", "POST", path, form(PNG))).status).toBe(409)
    const [sent] = await db.ownerDb
      .select()
      .from(contractOutbox)
      .where(and(eq(contractOutbox.storeId, storeId), eq(contractOutbox.type, "pago.comprobante")))
    expect(sent?.payload).toMatchObject({
      type: "pago.comprobante",
      data: {
        account: storeId,
        userId: people.rosa.id,
        chargeId: "cargo-1",
        amountCents: 1900,
        methodCode: "yape",
        file: { contentType: "image/png", base64: PNG.toString("base64") },
      },
    })
    const view = await call("rosa", "GET", `/api/tiendas/${storeId}/plan`)
    expect(view.json.pendingReceipts).toMatchObject([{ chargeId: "cargo-1", status: "por_enviar" }])
  })

  it("si la administración lo rechaza por lo que dice, no se reintenta y el Dueño ve por qué", async () => {
    admin.receiptAnswer = 409
    await deliverOutbox(db.ownerDb, contract, new Date(Date.now() + 1000))
    const [row] = await db.ownerDb
      .select()
      .from(contractOutbox)
      .where(and(eq(contractOutbox.storeId, storeId), eq(contractOutbox.type, "pago.comprobante")))
    expect(row?.rejectedAt).not.toBeNull()
    expect(row?.sentAt).toBeNull()
    // El archivo no se queda en la bandeja.
    expect((row?.payload.data as Record<string, unknown>).file).toBeUndefined()
    const view = await call("rosa", "GET", `/api/tiendas/${storeId}/plan`)
    expect(view.json.pendingReceipts).toMatchObject([
      { status: "rechazado", reason: "Ese cargo ya está pagado" },
    ])
    admin.receiptAnswer = 200
    // Rechazado, no vuelve a salir.
    const before = row!.attempts
    await deliverOutbox(db.ownerDb, contract, new Date(Date.now() + 7_200_000))
    const [after] = await db.ownerDb
      .select()
      .from(contractOutbox)
      .where(eq(contractOutbox.id, row!.id))
    expect(after?.attempts).toBe(before)
  })
})

describe("la bandeja se limpia", () => {
  it("borra lo enviado hace más de una semana, menos el último aviso de que se abrió cada tienda", async () => {
    await deliverOutbox(db.ownerDb, contract, new Date(Date.now() + 1000))
    const old = new Date(Date.now() - OUTBOX_KEEP_MS - 60_000)
    await db.ownerDb.insert(contractOutbox).values([
      {
        storeId,
        type: "cuenta.abierta",
        payload: { type: "cuenta.abierta", data: {} },
        createdAt: new Date(old.getTime() - 1000),
        sentAt: old,
      },
      {
        storeId,
        type: "soporte.pedido",
        payload: { type: "soporte.pedido", data: {} },
        createdAt: old,
        sentAt: old,
      },
    ])
    // El aviso de apertura enviado al crear la tienda también se hace viejo.
    await db.ownerDb
      .update(contractOutbox)
      .set({ sentAt: old, createdAt: old })
      .where(and(eq(contractOutbox.storeId, storeId), eq(contractOutbox.type, "cuenta.abierta")))
    const removed = await purgeOutbox(db.ownerDb)
    expect(removed).toBeGreaterThanOrEqual(2)
    const left = await db.ownerDb
      .select()
      .from(contractOutbox)
      .where(eq(contractOutbox.storeId, storeId))
    expect(left.filter((row) => row.type === "cuenta.abierta")).toHaveLength(1)
    expect(left.filter((row) => row.type === "soporte.pedido")).toEqual([])
    // Lo rechazado de hace menos de una semana queda, para que el Dueño vea por qué.
    expect(left.filter((row) => row.type === "pago.comprobante")).toHaveLength(1)
  })
})

describe("Sofi no atiende", () => {
  it("apagada o en pausa por la administración, la conversación espera a una persona con el motivo", async () => {
    const deps = {
      appDb: db.appDb,
      lockDb: db.ownerDb,
      model: null,
      link: { adapters: defaultLinkAdapters(), secretsKey: null, apiURL: SERVER },
    }
    const talk = async () => {
      const [conv] = await db.ownerDb
        .insert(conversation)
        .values({ storeId, channel: "whatsapp", createdBy: people.rosa.id, customerName: "Carla" })
        .returning({ id: conversation.id })
      await db.ownerDb.insert(conversationMessage).values({
        storeId,
        conversationId: conv!.id,
        author: "cliente",
        text: "Hola",
        actorUserId: people.rosa.id,
      })
      return conv!.id
    }
    const off = await talk()
    expect((await answer(deps, storeId, off)).status).toBe("apagada")
    await db.ownerDb
      .insert(storeAgent)
      .values({ storeId, enabled: true, updatedBy: people.rosa.id })
    await saveState(db.ownerDb, storeId, pausedState(storeId), new Date())
    const paused = await talk()
    expect((await answer(deps, storeId, paused)).status).toBe("detenida")
    const rows = await db.ownerDb
      .select()
      .from(conversation)
      .where(eq(conversation.storeId, storeId))
    const byId = new Map(rows.map((row) => [row.id, row]))
    expect(byId.get(off)).toMatchObject({ handler: "persona", waitingReason: "Sofi está apagada" })
    expect(byId.get(paused)).toMatchObject({
      handler: "persona",
      waitingReason: "Sofi en pausa: llegó al tope de gasto del mes",
    })
  })
})

function pausedState(account: string): AccountState {
  return {
    account,
    found: true,
    at: now(),
    access: { allowed: true, status: "activa", reason: null, readOnlyAt: null, trialEndsAt: null },
    agents: { trialExhausted: false, capReached: true },
    budget: null,
    plan: null,
    charges: [],
    payments: [],
    notices: [],
    paymentMethods: [],
    support: [],
  }
}

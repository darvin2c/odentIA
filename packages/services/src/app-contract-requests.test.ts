import { adminRequest } from "@odentia/contract"
import { verifySignedMessage } from "@odentia/contract/signing"
import { appContractRequest, saasAccount } from "@odentia/db/schema/admin-accounts"
import { user } from "@odentia/db/schema/auth"
import { saasPayment } from "@odentia/db/schema/saas-billing"
import { and, eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import type { AdminActor } from "./admin-core.js"
import { answerAppState, receiveAppEvent } from "./app-contract.js"
import {
  type AppContractSender,
  APP_REQUEST_MAX_ATTEMPTS,
  appContractSendersFromEnv,
  deliverAppContractRequests,
  listAppContractRequests,
  openAppAccountForClient,
  requestAppPersonRemoval,
  requestAppSupportAccess,
} from "./app-contract-requests.js"
import { ServiceError } from "./errors.js"
import { createSaasCharge, createSaasPlan, upsertSaasPaymentMethod } from "./saas-billing.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

/**
 * Lo que la administración le pide a una app (ADR 0214): sale firmado, en orden por cuenta y con
 * la misma clave al reintentar; la respuesta de la app es final. Y el comprobante que sube la app
 * queda por confirmar como el de una clínica.
 */

setupTestDb()

const NOW = new Date("2026-11-23T15:00:00Z")
const SECRET = `whsec_${Buffer.alloc(32, 7).toString("base64")}`
const SENDER: AppContractSender = {
  app: "gestoria",
  url: "https://servidor.gestoria.test",
  secret: SECRET,
}
const ACTOR: AdminActor = { userId: "pedidos-admin", role: "admin" }
/** La hora del envío: la base anota cuándo toca cada intento con su propio reloj. */
const soon = (ms: number) => new Date(Date.now() + ms)
const GESTORIA = "gestoria" as const

/** Una app de mentira: comprueba la firma y responde lo que se le diga, anotando cada llamada. */
function fakeApp(answers: (Response | Error)[]) {
  const calls: { id: string; type: string; url: string; valid: boolean }[] = []
  const fetch = (async (url: URL | string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    const body = String(init?.body ?? "")
    const id = verifySignedMessage({ secret: SECRET, headers, body })
    calls.push({
      id: headers.get("webhook-id") ?? "",
      type: adminRequest.parse(JSON.parse(body)).type,
      url: String(url),
      valid: id !== null,
    })
    const next = answers.shift() ?? Response.json({ status: "hecho", message: null })
    if (next instanceof Error) throw next
    return next
  }) as typeof globalThis.fetch
  return { calls, fetch }
}

async function account(ref: string): Promise<string> {
  await receiveAppEvent(
    ownerDb,
    GESTORIA,
    `abre-${ref}`,
    {
      type: "cuenta.abierta",
      timestamp: NOW.toISOString(),
      data: { account: ref, name: `Tienda ${ref}`, country: "PE", ownerUserId: "pedidos-duena" },
    },
    NOW,
  )
  const [row] = await ownerDb
    .select({ id: saasAccount.id })
    .from(saasAccount)
    .where(and(eq(saasAccount.app, GESTORIA), eq(saasAccount.externalRef, ref)))
  return row!.id
}

beforeAll(async () => {
  await ownerDb.insert(user).values([
    { id: ACTOR.userId, name: "Rosa de Soporte", email: "rosa@admin.test" },
    { id: "pedidos-duena", name: "Duena", email: "duena@tienda.test" },
    { id: "pedidos-vendedor", name: "Vendedor", email: "Vendedor@Tienda.test" },
  ])
  await createSaasPlan(ownerDb, ACTOR.userId, {
    app: GESTORIA,
    code: "gestoria-pedidos",
    name: "Tienda",
    currency: "USD",
    priceCents: 1500,
    creditCents: 0,
    conversationMicros: 300_000,
    trialCreditCents: 0,
    trialMaxCreditCents: 0,
    trialDays: 7,
    trialMaxDays: 7,
    isDefault: true,
  })
  await upsertSaasPaymentMethod(ownerDb, ACTOR.userId, {
    code: "yape-pedidos",
    name: "Yape",
    instructions: "Al 999",
  })
})

describe("la configuración", () => {
  it("sin dirección no pide nada; sin https o sin secreto lo dice", () => {
    expect(appContractSendersFromEnv({}).senders).toEqual([])
    expect(
      appContractSendersFromEnv({
        GESTORIA_CONTRACT_URL: "http://gestoria.test",
        GESTORIA_CONTRACT_SECRET: SECRET,
      }).problems,
    ).toHaveLength(1)
    expect(
      appContractSendersFromEnv({
        GESTORIA_CONTRACT_URL: "https://gestoria.test",
        GESTORIA_CONTRACT_SECRET: "x",
      }).problems,
    ).toHaveLength(1)
    expect(
      appContractSendersFromEnv({
        GESTORIA_CONTRACT_URL: "https://gestoria.test",
        GESTORIA_CONTRACT_SECRET: SECRET,
      }).senders,
    ).toEqual([{ app: GESTORIA, url: "https://gestoria.test", secret: SECRET }])
  })

  it("sin la conexión encendida, el pedido se rechaza y no queda nada", async () => {
    const id = await account("sin-conexion")
    await expect(
      ownerDb.transaction((tx) =>
        requestAppSupportAccess(
          tx,
          [],
          ACTOR,
          id,
          { minutes: 30, reason: "Mirar el catálogo" },
          NOW,
        ),
      ),
    ).rejects.toMatchObject({ code: "NOT_CONNECTED", status: 409 })
    expect(await listAppContractRequests(ownerDb, id)).toEqual([])
  })
})

describe("el envío", () => {
  it("sale firmado con su clave, se reintenta con la misma y la respuesta de la app es final", async () => {
    const id = await account("reintento")
    const requestId = await ownerDb.transaction((tx) =>
      requestAppSupportAccess(
        tx,
        [SENDER],
        ACTOR,
        id,
        { minutes: 30, reason: "Mirar el catálogo" },
        NOW,
      ),
    )
    const app = fakeApp([
      new Response("caída", { status: 503 }),
      Response.json({ status: "hecho", message: "Pedido a la tienda" }),
    ])
    expect(
      await deliverAppContractRequests(ownerDb, [SENDER], { fetch: app.fetch, now: soon(1000) }),
    ).toEqual({
      delivered: 0,
      failed: 1,
    })
    // Antes de su hora no sale otra vez.
    await deliverAppContractRequests(ownerDb, [SENDER], { fetch: app.fetch, now: soon(1000) })
    expect(app.calls).toHaveLength(1)
    expect(
      await deliverAppContractRequests(ownerDb, [SENDER], { fetch: app.fetch, now: soon(61_000) }),
    ).toEqual({
      delivered: 1,
      failed: 0,
    })
    expect(app.calls.map((call) => [call.id, call.valid])).toEqual([
      [requestId, true],
      [requestId, true],
    ])
    expect(app.calls[0]!.url).toBe("https://servidor.gestoria.test/acuerdo/pedidos")
    const [row] = await listAppContractRequests(ownerDb, id)
    expect(row).toMatchObject({
      type: "soporte.entrar",
      status: "hecho",
      message: "Pedido a la tienda",
      requestedBy: "Rosa de Soporte",
    })
    // Lo respondido no vuelve a salir.
    await deliverAppContractRequests(ownerDb, [SENDER], { fetch: app.fetch, now: soon(3_600_000) })
    expect(app.calls).toHaveLength(2)
  })

  it("lo que la app no puede hacer queda como falló con su motivo, y un pedido que no es del acuerdo también", async () => {
    const id = await account("falla")
    await ownerDb.transaction((tx) =>
      requestAppPersonRemoval(
        tx,
        [SENDER],
        ACTOR,
        id,
        { email: "duena@tienda.test", reason: "Lo pidió" },
        NOW,
      ),
    )
    await ownerDb.transaction((tx) =>
      requestAppSupportAccess(tx, [SENDER], ACTOR, id, { minutes: 15, reason: "Mirar" }, NOW),
    )
    const app = fakeApp([
      Response.json({ status: "fallo", message: "Es el único Dueño de la tienda" }),
      new Response("{}", { status: 400 }),
    ])
    // Uno por vuelta en la misma cuenta: el segundo sale cuando el primero ya tiene respuesta.
    await deliverAppContractRequests(ownerDb, [SENDER], { fetch: app.fetch, now: soon(1000) })
    await deliverAppContractRequests(ownerDb, [SENDER], { fetch: app.fetch, now: soon(1000) })
    const rows = await listAppContractRequests(ownerDb, id)
    expect(rows.map((row) => [row.type, row.status, row.message])).toEqual([
      ["soporte.entrar", "fallo", "La app no lo aceptó: no es un pedido del acuerdo."],
      ["equipo.quitar", "fallo", "Es el único Dueño de la tienda"],
    ])
  })

  it("los de una cuenta salen en orden: lo siguiente espera a que el anterior llegue", async () => {
    const id = await account("orden")
    await ownerDb.transaction((tx) =>
      requestAppPersonRemoval(
        tx,
        [SENDER],
        ACTOR,
        id,
        { email: "VENDEDOR@tienda.test", reason: "Ya no trabaja" },
        NOW,
      ),
    )
    await ownerDb.transaction((tx) =>
      requestAppSupportAccess(tx, [SENDER], ACTOR, id, { minutes: 60, reason: "Mirar" }, NOW),
    )
    const app = fakeApp([new TypeError("fetch failed")])
    await deliverAppContractRequests(ownerDb, [SENDER], { fetch: app.fetch, now: soon(1000) })
    expect(app.calls.map((call) => call.type)).toEqual(["equipo.quitar"])
    // Ni cuando ya le toca al segundo: espera al primero.
    await deliverAppContractRequests(ownerDb, [SENDER], { fetch: app.fetch, now: soon(61_000) })
    expect(app.calls.map((call) => call.type)).toEqual(["equipo.quitar", "equipo.quitar"])
    await deliverAppContractRequests(ownerDb, [SENDER], { fetch: app.fetch, now: soon(61_000) })
    expect(app.calls.map((call) => call.type)).toEqual([
      "equipo.quitar",
      "equipo.quitar",
      "soporte.entrar",
    ])
  })

  it("quitar a alguien pide su correo de la cuenta única: uno que no existe se dice", async () => {
    const id = await account("sin-persona")
    await expect(
      ownerDb.transaction((tx) =>
        requestAppPersonRemoval(
          tx,
          [SENDER],
          ACTOR,
          id,
          { email: "nadie@tienda.test", reason: "Lo pidió" },
          NOW,
        ),
      ),
    ).rejects.toMatchObject({
      status: 400,
      fields: { email: "Nadie tiene cuenta con ese correo." },
    })
  })

  it("una clínica no recibe pedidos: solo una cuenta de otra app", async () => {
    await expect(
      ownerDb.transaction((tx) =>
        requestAppSupportAccess(
          tx,
          [SENDER],
          ACTOR,
          "no-existe",
          { minutes: 30, reason: "Mirar" },
          NOW,
        ),
      ),
    ).rejects.toBeInstanceOf(ServiceError)
  })
})

describe("un pedido que nunca llega", () => {
  it("tras el último intento falla con su motivo y deja salir lo que sigue de la cuenta", async () => {
    const id = await account("nunca")
    const first = await ownerDb.transaction((tx) =>
      requestAppSupportAccess(tx, [SENDER], ACTOR, id, { minutes: 15, reason: "Mirar" }, NOW),
    )
    await ownerDb
      .update(appContractRequest)
      .set({ attempts: APP_REQUEST_MAX_ATTEMPTS - 1 })
      .where(eq(appContractRequest.id, first))
    await ownerDb.transaction((tx) =>
      requestAppSupportAccess(tx, [SENDER], ACTOR, id, { minutes: 30, reason: "Mirar otra vez" }, NOW),
    )
    const app = fakeApp([new Response("caída", { status: 500 })])
    await deliverAppContractRequests(ownerDb, [SENDER], { fetch: app.fetch, now: soon(1000) })
    await deliverAppContractRequests(ownerDb, [SENDER], { fetch: app.fetch, now: soon(1000) })
    const rows = await listAppContractRequests(ownerDb, id)
    expect(rows.map((row) => row.status)).toEqual(["hecho", "fallo"])
    expect(rows[1]?.message).toContain("La app no respondió")
  })
})

describe("abrir la cuenta de un cliente", () => {
  it("abre la cuenta con su plan y le pide a la app la tienda con el mismo id; su aviso la pone al día", async () => {
    const opened = await ownerDb.transaction((tx) =>
      openAppAccountForClient(
        tx,
        [SENDER],
        ACTOR,
        {
          app: GESTORIA,
          name: "Zapatos Lima",
          ownerEmail: "DUENA@tienda.test",
          currency: "PEN",
          country: "PE",
          planCode: "gestoria-pedidos",
        },
        NOW,
      ),
    )
    const [row] = await ownerDb
      .select()
      .from(appContractRequest)
      .where(eq(appContractRequest.id, opened.requestId))
    const request = adminRequest.parse(row!.payload)
    expect(request).toMatchObject({
      type: "cuenta.abrir",
      data: {
        name: "Zapatos Lima",
        currency: "PEN",
        country: "PE",
        owner: { userId: "pedidos-duena", email: "duena@tienda.test" },
      },
    })
    const ref = request.data.account
    const before = await answerAppState(ownerDb, GESTORIA, ref, NOW)
    expect(before).toMatchObject({
      found: true,
      plan: { code: "gestoria-pedidos" },
      access: { status: "prueba" },
    })
    // La app la abre y avisa: es la misma cuenta, no otra.
    await receiveAppEvent(
      ownerDb,
      GESTORIA,
      "abre-zapatos",
      {
        type: "cuenta.abierta",
        timestamp: new Date(NOW.getTime() + 1000).toISOString(),
        data: { account: ref, name: "Zapatos Lima", country: "PE", ownerUserId: "pedidos-duena" },
      },
      NOW,
    )
    const accounts = await ownerDb
      .select({ id: saasAccount.id })
      .from(saasAccount)
      .where(and(eq(saasAccount.app, GESTORIA), eq(saasAccount.externalRef, ref)))
    expect(accounts.map((one) => one.id)).toEqual([opened.accountId])
  })

  it("un plan de clínica no entra, y no queda la cuenta a medias", async () => {
    await expect(
      ownerDb.transaction((tx) =>
        openAppAccountForClient(
          tx,
          [SENDER],
          ACTOR,
          {
            app: GESTORIA,
            name: "Otra",
            ownerEmail: "duena@tienda.test",
            currency: "USD",
            country: null,
            planCode: "no-existe",
          },
          NOW,
        ),
      ),
    ).rejects.toMatchObject({ status: 400 })
    const named = await ownerDb.select().from(saasAccount).where(eq(saasAccount.name, "Otra"))
    expect(named).toEqual([])
  })
})

describe("el comprobante que sube la app", () => {
  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 1),
  ])
  const stored: string[] = []
  const storage = {
    putAttachment: async (input: {
      orgId: string
      ext: string
      contentType: string
      bytes: Uint8Array
    }) => {
      stored.push(input.contentType)
      return {
        objectKey: `${input.orgId}/comprobante.${input.ext}`,
        filename: `comprobante.${input.ext}`,
        mimeType: input.contentType,
        size: input.bytes.byteLength,
        url: "",
      }
    },
  }
  const receipt = (ref: string, chargeId: string, base64: string, amountCents = 500) => ({
    type: "pago.comprobante" as const,
    timestamp: NOW.toISOString(),
    data: {
      account: ref,
      userId: "pedidos-duena",
      chargeId,
      amountCents,
      methodCode: "yape-pedidos",
      file: { contentType: "image/png" as const, base64 },
    },
  })

  it("queda por confirmar como el de una clínica, una sola vez por su clave", async () => {
    const id = await account("paga")
    const charge = await createSaasCharge(ownerDb, id, ACTOR.userId, {
      planCode: "gestoria-pedidos",
      periodStart: new Date("2026-10-01T00:00:00Z"),
      periodEnd: new Date("2026-11-01T00:00:00Z"),
    })
    const event = receipt("paga", charge.id, PNG.toString("base64"))
    expect(await receiveAppEvent(ownerDb, GESTORIA, "pago-1", event, NOW, { storage })).toEqual({
      repeated: false,
    })
    expect(await receiveAppEvent(ownerDb, GESTORIA, "pago-1", event, NOW, { storage })).toEqual({
      repeated: true,
    })
    const payments = await ownerDb
      .select()
      .from(saasPayment)
      .where(eq(saasPayment.organizationId, id))
    expect(payments).toHaveLength(1)
    expect(payments[0]).toMatchObject({
      status: "pendiente",
      amountCents: 500,
      methodCode: "yape-pedidos",
      receiptMime: "image/png",
      createdBy: "pedidos-duena",
    })
    // La app ve cómo pagar y el pago por confirmar.
    const state = await answerAppState(ownerDb, GESTORIA, "paga", NOW)
    expect(state.paymentMethods).toContainEqual({
      code: "yape-pedidos",
      name: "Yape",
      instructions: "Al 999",
    })
    expect(state.payments).toMatchObject([{ status: "pendiente", amountCents: 500 }])
    // Otro del mismo cargo mientras ese espera: se rechaza por lo que dice (la app no reintenta).
    await expect(
      receiveAppEvent(ownerDb, GESTORIA, "pago-2", event, NOW, { storage }),
    ).rejects.toMatchObject({ status: 409 })
  })

  it("el archivo se mira por su contenido: lo que no es lo que dice no entra", async () => {
    const id = await account("mentira")
    const charge = await createSaasCharge(ownerDb, id, ACTOR.userId, {
      planCode: "gestoria-pedidos",
      periodStart: new Date("2026-10-01T00:00:00Z"),
      periodEnd: new Date("2026-11-01T00:00:00Z"),
    })
    const html = Buffer.from("<html><script>alert(1)</script></html>").toString("base64")
    await expect(
      receiveAppEvent(ownerDb, GESTORIA, "pago-html", receipt("mentira", charge.id, html), NOW, {
        storage,
      }),
    ).rejects.toMatchObject({ status: 400 })
    // Un cargo que no es de la cuenta es un rechazo de lo que dice (409), no una cuenta que falta.
    await expect(
      receiveAppEvent(
        ownerDb,
        GESTORIA,
        "pago-otro",
        receipt("mentira", "00000000-0000-4000-8000-000000000000", PNG.toString("base64")),
        NOW,
        { storage },
      ),
    ).rejects.toMatchObject({ status: 409 })
    const payments = await ownerDb
      .select()
      .from(saasPayment)
      .where(eq(saasPayment.organizationId, id))
    expect(payments).toEqual([])
  })
})

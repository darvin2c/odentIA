process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { createKairosWriter } from "@odentia/agent"
import { createOwnerDb, type Db } from "@odentia/db"
import {
  kairosAiUsage,
  kairosItem,
  kairosWeekly,
  saasClient,
  saasClientContact,
  saasClientFile,
  saasOpportunity,
  saasOutreach,
} from "@odentia/db/schema/admin-arm"
import { adminStaff } from "@odentia/db/schema/admin-core"
import { organization, user } from "@odentia/db/schema/auth"
import { saasFollowUp } from "@odentia/db/schema/saas-billing"
import type { MailMessage } from "@odentia/mail"
import {
  KAIROS_TEMPLATE_NOTE,
  type KairosDraftWriter,
  type KairosWeeklyWriter,
  ServiceError,
} from "@odentia/services"
import { eq } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { type Context, Hono, type Next } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { errorBody } from "../lib/error.js"
import { createAdminKairosRoute } from "./admin-kairos.js"

/**
 * Kairós en la administración contra Postgres real: lo que espera un sí se
 * aprueba con la operación de la pantalla; un correo aprobado sale una sola
 * vez después del commit (enviado o incierto, nunca se reintenta); un
 * WhatsApp devuelve su enlace; Soporte no ve ni aprueba lo de Administración
 * y no corre la pasada.
 */

const IMAGE = "dentalagent-postgres:18.6"
const HOUR = 3_600_000
const ADMIN = "kr-admin"
const SUPPORT = "kr-soporte"
const ORPHAN_ORG = "kr-org-sin-cliente"

let container: StartedTestContainer
let ownerDb: Db
let app: Hono

/** El cuerpo de una respuesta de prueba: su forma la comprueba cada `expect`. */
// biome-ignore lint/suspicious/noExplicitAny: el cuerpo de una respuesta de prueba se lee suelto
async function read(response: Response): Promise<any> {
  return response.json()
}
const sent: MailMessage[] = []
let mailFails = false
const ids: Record<string, string> = {}
/** El id guardado en la preparación: falla claro si no está. */
function idOf(key: string): string {
  const id = ids[key]
  if (!id) throw new Error(`falta ${key}`)
  return id
}

/** El escritor de Kairós: plantillas sin modelo. */
const writer: KairosDraftWriter & KairosWeeklyWriter = {
  async draftMessage(input) {
    return { subject: `Para ${input.client.name}`, body: `Hola ${input.contact?.name ?? ""}` }
  },
  async presentationScript(input) {
    return { script: `Guion para ${input.client.name}` }
  },
  async draftReply(input) {
    return { body: `Gracias, ${input.from.name ?? input.from.address}` }
  },
  async weeklySummary(input) {
    return { text: `Semana con ${input.figures.length} cifras` }
  },
}

function call(path: string, who: string | null, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (who) {
    headers.set("x-test-user", who)
    headers.set("x-test-role", who === ADMIN ? "admin" : "support")
  }
  if (init.body) headers.set("content-type", "application/json")
  return app.request(`/api/admin/kairos${path}`, { ...init, headers })
}

const post = (path: string, who: string, body: unknown) =>
  call(path, who, { method: "POST", body: JSON.stringify(body) })

/** Un cliente con su persona principal y su venta abierta. */
async function client(key: string, contact: { email?: string; phone?: string }) {
  const [row] = await ownerDb
    .insert(saasClient)
    .values({ name: `Clínica ${key} (ficticia)`, product: "dental", origin: "web" })
    .returning({ id: saasClient.id })
  if (!row) throw new Error("sin cliente")
  await ownerDb.insert(saasOpportunity).values({ clientId: row.id })
  const [person] = await ownerDb
    .insert(saasClientContact)
    .values({
      clientId: row.id,
      name: `Persona ${key}`,
      email: contact.email ?? null,
      phone: contact.phone ?? null,
      isPrimary: true,
    })
    .returning({ id: saasClientContact.id })
  if (!person) throw new Error("sin persona")
  ids[`${key}Client`] = row.id
  ids[`${key}Contact`] = person.id
  return { clientId: row.id, contactId: person.id }
}

/** Un mensaje en espera, ya redactado, congelado sin actividad (como lo deja la pasada). */
async function message(
  key: string,
  target: { clientId: string; contactId: string },
  payload: Record<string, unknown>,
  options: { adminOnly?: boolean; draft?: boolean } = {},
) {
  const draft =
    options.draft === false ? null : { subject: payload.subject ?? null, body: payload.body }
  const [row] = await ownerDb
    .insert(kairosItem)
    .values({
      clientId: target.clientId,
      kind: "mensaje",
      title: `Mensaje ${key}`,
      reason: "Su solicitud espera respuesta",
      payload: { goal: "primera_respuesta", contactId: target.contactId, ...payload, draft },
      expectedState: { lastActivityAt: null },
      idempotencyKey: `prueba:${key}`,
      expiresAt: new Date(Date.now() + 48 * HOUR),
      adminOnly: options.adminOnly ?? false,
    })
    .returning({ id: kairosItem.id })
  if (!row) throw new Error("sin ítem")
  ids[key] = row.id
  return row.id
}

beforeAll(async () => {
  container = await new GenericContainer(IMAGE)
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_DB: "dentalagent",
      POSTGRES_USER: "dentalagent",
      POSTGRES_PASSWORD: "dentalagent",
      POSTGRES_APP_PASSWORD: "dentalagent_app",
    })
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .withCommand([
      "postgres",
      "-c",
      "shared_preload_libraries=pg_cron",
      "-c",
      "cron.database_name=dentalagent",
    ])
    .start()
  const url = `${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`
  ownerDb = createOwnerDb(`postgres://dentalagent:dentalagent@${url}`)
  await migrate(ownerDb, { migrationsFolder: "../../packages/db/drizzle" })

  // El guard real lo prueba admin-core; aquí el actor llega ya resuelto, como lo deja el guard.
  app = new Hono()
  app.use("*", async (c: Context, next: Next) => {
    const userId = c.req.header("x-test-user")
    if (userId) c.set("adminActor", { userId, role: c.req.header("x-test-role") })
    await next()
  })
  app.onError((err, c) => {
    if (err instanceof ServiceError)
      return c.json(errorBody(c, err.code, err.message, err.fields), err.status)
    console.error(err)
    return c.json(errorBody(c, "INTERNAL", "Error interno"), 500)
  })
  app.route(
    "/api/admin/kairos",
    createAdminKairosRoute({
      ownerDb,
      kairos: writer,
      mailer: {
        async send(message) {
          sent.push(message)
          if (mailFails) throw new Error("se cortó la conexión")
        },
      },
    }),
  )

  await ownerDb.insert(user).values([
    { id: ADMIN, name: "Ada Administración", email: "ada@kairos-ruta.test" },
    { id: SUPPORT, name: "Sofía Soporte", email: "sofia@kairos-ruta.test" },
  ])
  await ownerDb.insert(adminStaff).values([
    { userId: ADMIN, role: "admin" },
    { userId: SUPPORT, role: "support" },
  ])
  const mail = await client("correo", { email: "rosa@kairos-ruta.test" })
  await message("correo", mail, {
    channel: "correo",
    to: "rosa@kairos-ruta.test",
    subject: "Su solicitud en odentIA",
    body: "Hola Rosa, gracias por escribirnos.",
  })
  const failing = await client("falla", { email: "luis@kairos-ruta.test" })
  await message("falla", failing, {
    channel: "correo",
    to: "luis@kairos-ruta.test",
    subject: "Retomemos",
    body: "Hola Luis.",
  })
  const chat = await client("whatsapp", { phone: "+51987654321" })
  await message("whatsapp", chat, {
    channel: "whatsapp",
    to: "+51987654321",
    subject: null,
    body: "Hola, ¿le acomoda una llamada?",
  })
  const secret = await client("admin", { email: "eva@kairos-ruta.test" })
  await message(
    "admin",
    secret,
    {
      channel: "correo",
      to: "eva@kairos-ruta.test",
      subject: "Su propuesta",
      body: "Vence pronto.",
    },
    { adminOnly: true },
  )
  const rest = await client("descartar", { email: "ivo@kairos-ruta.test" })
  await message("descartar", rest, {
    channel: "correo",
    to: "ivo@kairos-ruta.test",
    subject: "Hola",
    body: "Hola Ivo.",
  })
  // Lo que todavía espera al modelo: la pasada a pedido lo redacta.
  const pending = await client("borrador", { phone: "+51911222333" })
  await message("borrador", pending, { channel: "whatsapp", to: "+51911222333" }, { draft: false })
  // Una cuenta sin cliente: la pasada crea su cliente.
  await ownerDb.insert(organization).values({
    id: ORPHAN_ORG,
    name: "Clínica Huérfana",
    slug: "kr-huerfana",
    createdAt: new Date(),
  })
})

afterAll(async () => {
  await container?.stop()
})

describe("lo que espera un sí", () => {
  it("Soporte no ve lo que es solo de Administración; el número del menú cuenta lo que cada uno ve", async () => {
    const asAdmin = await read(await call("/items", ADMIN))
    const asSupport = await read(await call("/items?status=espera", SUPPORT))
    const adminIds = asAdmin.data.items.map((item: { id: string }) => item.id)
    const supportIds = asSupport.data.items.map((item: { id: string }) => item.id)
    expect(adminIds).toContain(ids.admin)
    expect(supportIds).not.toContain(ids.admin)
    expect(supportIds).toContain(ids.correo)
    const adminCount = await read(await call("/count", ADMIN))
    const supportCount = await read(await call("/count", SUPPORT))
    expect(adminCount.data.waiting).toBe(asAdmin.data.total)
    expect(supportCount.data.waiting).toBe(asAdmin.data.total - 1)
  })

  it("rechaza un filtro o una decisión que no es válida, con su campo", async () => {
    const bad = await call("/items?status=otro", ADMIN)
    expect(bad.status).toBe(400)
    expect(await read(bad)).toMatchObject({
      error: { code: "VALIDATION", fields: { status: expect.any(String) } },
    })
    const wrong = await post(`/items/${ids.correo}/decide`, ADMIN, { action: "enviar" })
    expect(wrong.status).toBe(400)
    expect(await read(wrong)).toMatchObject({ error: { fields: { action: expect.any(String) } } })
    const extra = await post(`/items/${ids.correo}/decide`, ADMIN, {
      action: "aprobar",
      edited: { planId: "x" },
    })
    expect(extra.status).toBe(400)
    expect(await read(extra)).toMatchObject({
      error: { fields: { "edited.planId": expect.any(String) } },
    })
  })

  it("aprobar un correo lo envía una vez después del commit, con lo cambiado, y queda hecho", async () => {
    const res = await post(`/items/${ids.correo}/decide`, SUPPORT, {
      action: "aprobar",
      edited: { body: "Hola Rosa, gracias por escribirnos. ¿Hablamos mañana?" },
    })
    expect(res.status).toBe(200)
    const body = await read(res)
    expect(body.data).toMatchObject({
      kind: "mensaje",
      status: "ejecutada",
      emailSent: true,
      outreach: { channel: "correo", to: "rosa@kairos-ruta.test", status: "enviado" },
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      to: "rosa@kairos-ruta.test",
      subject: "Su solicitud en odentIA",
      brand: "odentia",
      // Aprueba Soporte: sale desde soporte@ y la respuesta llega ahí.
      from: { name: "Soporte · odentIA", address: "soporte@odentia32.com" },
      replyTo: "soporte@odentia32.com",
    })
    expect(sent[0]?.text).toContain("¿Hablamos mañana?")
    const [outreach] = await ownerDb
      .select()
      .from(saasOutreach)
      .where(eq(saasOutreach.kairosItemId, idOf("correo")))
    expect(outreach).toMatchObject({ status: "enviado", createdBy: SUPPORT })
    const activities = await ownerDb
      .select()
      .from(saasFollowUp)
      .where(eq(saasFollowUp.clientId, idOf("correoClient")))
    expect(activities).toMatchObject([{ kind: "correo", direction: "salio" }])
  })

  it("si el correo falla queda incierto y no se reintenta: decidir otra vez no lo vuelve a enviar", async () => {
    mailFails = true
    const before = sent.length
    const res = await post(`/items/${ids.falla}/decide`, ADMIN, { action: "aprobar" })
    mailFails = false
    expect(res.status).toBe(200)
    expect((await read(res)).data).toMatchObject({
      status: "incierta",
      emailSent: false,
      outreach: { status: "incierto" },
    })
    expect(sent.length).toBe(before + 1)
    const again = await post(`/items/${ids.falla}/decide`, ADMIN, { action: "aprobar" })
    expect(again.status).toBe(409)
    expect(await read(again)).toMatchObject({ error: { code: "KAIROS_ITEM_DECIDED" } })
    expect(sent.length).toBe(before + 1)
    const [outreach] = await ownerDb
      .select()
      .from(saasOutreach)
      .where(eq(saasOutreach.kairosItemId, idOf("falla")))
    expect(outreach?.status).toBe("incierto")
  })

  it("aprobar un WhatsApp devuelve su enlace y queda por confirmar, sin correo", async () => {
    const before = sent.length
    const res = await post(`/items/${ids.whatsapp}/decide`, SUPPORT, { action: "aprobar" })
    expect(res.status).toBe(200)
    const body = await read(res)
    expect(body.data).toMatchObject({
      status: "incierta",
      emailSent: null,
      outreach: { channel: "whatsapp", status: "pendiente" },
    })
    expect(body.data.outreach.whatsappUrl).toMatch(/^https:\/\/wa\.me\/51987654321\?text=/)
    expect(sent.length).toBe(before)
  })

  it("Soporte no decide lo de Administración (no lo ve); Administración sí", async () => {
    const hidden = await post(`/items/${ids.admin}/decide`, SUPPORT, { action: "descartar" })
    expect(hidden.status).toBe(404)
    const res = await post(`/items/${ids.admin}/decide`, ADMIN, { action: "descartar" })
    expect(res.status).toBe(200)
    expect((await read(res)).data).toMatchObject({ status: "descartada", outreach: null })
  })

  it("una posible carga de datos: Soporte no la decide (no la ve); el sí de Administración la marca con la operación de Documentos", async () => {
    const { clientId } = await client("carga", { email: "carga@kairos-ruta.test" })
    const [file] = await ownerDb
      .insert(saasClientFile)
      .values({
        clientId,
        kind: "correo",
        filename: "pacientes.xlsx",
        objectKey: `clients/${clientId}/kr-pacientes.xlsx`,
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: 10,
        receivedAt: new Date(Date.now() - 3 * 24 * HOUR),
      })
      .returning({ id: saasClientFile.id })
    const [item] = await ownerDb
      .insert(kairosItem)
      .values({
        clientId,
        kind: "posible_carga",
        title: "¿Es la carga de datos? pacientes.xlsx",
        reason: "Llegó por correo",
        payload: { fileId: file?.id },
        expectedState: { file: { kind: "correo", deleted: false } },
        idempotencyKey: "prueba:posible-carga",
        expiresAt: new Date(Date.now() + 48 * HOUR),
        adminOnly: true,
      })
      .returning({ id: kairosItem.id })
    const hidden = await post(`/items/${item?.id}/decide`, SUPPORT, { action: "aprobar" })
    expect(hidden.status).toBe(404)
    const res = await post(`/items/${item?.id}/decide`, ADMIN, { action: "aprobar" })
    expect(res.status).toBe(200)
    expect((await read(res)).data).toMatchObject({
      status: "ejecutada",
      result: { fileId: file?.id, dueNow: false },
    })
    const [marked] = await ownerDb
      .select({ kind: saasClientFile.kind })
      .from(saasClientFile)
      .where(eq(saasClientFile.id, file?.id as string))
    expect(marked?.kind).toBe("archivo_clinica")
  })

  it("descartar no envía nada y pasa a lo ya decidido", async () => {
    const before = sent.length
    const res = await post(`/items/${ids.descartar}/decide`, SUPPORT, { action: "descartar" })
    expect((await read(res)).data.status).toBe("descartada")
    expect(sent.length).toBe(before)
    const done = await read(await call("/items?status=hecho", SUPPORT))
    expect(done.data.items.map((item: { id: string }) => item.id)).toContain(ids.descartar)
  })
})

describe("Hoy, lo que hizo y la pasada", () => {
  it("Hoy dice lo listo y las tareas, mías o todas", async () => {
    const res = await call("/today?who=todas", SUPPORT)
    expect(res.status).toBe(200)
    const body = await read(res)
    expect(body.data).toMatchObject({
      today: expect.any(String),
      kairosReady: { items: expect.any(Array), total: expect.any(Number) },
      tasks: expect.any(Array),
    })
    expect(body.data.expiring).toEqual([])
    const bad = await call("/today?who=nadie", SUPPORT)
    expect(bad.status).toBe(400)
  })

  it("Soporte no corre la pasada", async () => {
    const res = await post("/run", SUPPORT, {})
    expect(res.status).toBe(403)
  })

  it("Administración la corre a pedido: crea el cliente de la cuenta, redacta lo pendiente y escribe la semana, sin enviar nada", async () => {
    const before = sent.length
    const res = await post("/run", ADMIN, { weekly: true })
    expect(res.status).toBe(200)
    const body = await read(res)
    expect(body.data).toMatchObject({
      clientsCreated: 1,
      drafted: expect.any(Number),
      draftsFailed: 0,
      weekly: { weekStart: expect.any(String), written: true },
    })
    expect(body.data.drafted).toBeGreaterThanOrEqual(1)
    const [created] = await ownerDb
      .select()
      .from(saasClient)
      .where(eq(saasClient.organizationId, ORPHAN_ORG))
    expect(created?.name).toBe("Clínica Huérfana")
    const [drafted] = await ownerDb
      .select()
      .from(kairosItem)
      .where(eq(kairosItem.id, idOf("borrador")))
    expect(drafted?.payload).toMatchObject({ draft: { body: "Hola Persona borrador" } })
    expect(sent.length).toBe(before)
  })

  it("sin la clave del modelo la pasada no falla: redacta con plantillas y lo dice, sin gasto", async () => {
    // La misma ruta con el escritor de producción, sin LLM_OPENAI_API_KEY ni LLM_MODEL=fake.
    const bare = new Hono()
    bare.use("*", async (c: Context, next: Next) => {
      c.set("adminActor", { userId: ADMIN, role: "admin" })
      await next()
    })
    bare.onError((err, c) => {
      if (err instanceof ServiceError)
        return c.json(errorBody(c, err.code, err.message, err.fields), err.status)
      return c.json(errorBody(c, "INTERNAL", "Error interno"), 500)
    })
    bare.route(
      "/api/admin/kairos",
      createAdminKairosRoute({
        ownerDb,
        kairos: createKairosWriter({ platform: {}, onUse: () => {} }),
        mailer: { async send() {} },
      }),
    )
    const target = await client("sinmodelo", { email: "olga@kairos-ruta.test" })
    await message(
      "sinmodelo",
      target,
      { channel: "correo", to: "olga@kairos-ruta.test" },
      { draft: false },
    )
    // La semana se vuelve a escribir: también sin modelo.
    await ownerDb.delete(kairosWeekly)
    const usage = (await ownerDb.select().from(kairosAiUsage)).length

    const res = await bare.request("/api/admin/kairos/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ weekly: true }),
    })
    expect(res.status).toBe(200)
    const body = await read(res)
    expect(body.data).toMatchObject({
      drafter: "plantilla",
      draftsFailed: 0,
      weekly: { written: true },
    })
    expect(body.data.drafted).toBeGreaterThanOrEqual(1)
    const [drafted] = await ownerDb
      .select()
      .from(kairosItem)
      .where(eq(kairosItem.id, idOf("sinmodelo")))
    expect(drafted?.payload).toMatchObject({
      draft: { drafter: "plantilla", subject: expect.any(String) },
      draftNote: KAIROS_TEMPLATE_NOTE,
    })
    expect(String((drafted?.payload.draft as { body?: string } | undefined)?.body)).toContain(
      "Persona",
    )
    const listed = await read(
      await bare.request(`/api/admin/kairos/items?clientId=${idOf("sinmodeloClient")}`),
    )
    expect(listed.data.items).toEqual([
      expect.objectContaining({
        id: idOf("sinmodelo"),
        ready: true,
        drafter: "plantilla",
        draftNote: KAIROS_TEMPLATE_NOTE,
      }),
    ])
    // Sin modelo no hay gasto que anotar.
    expect((await ownerDb.select().from(kairosAiUsage)).length).toBe(usage)
  })

  it("lo que hizo Kairós sale en frases", async () => {
    const res = await call("/done?limit=20", ADMIN)
    expect(res.status).toBe(200)
    const body = await read(res)
    expect(body.data.items.length).toBeGreaterThan(0)
    expect(body.data.items[0]).toMatchObject({ words: expect.any(String) })
    const bad = await call("/done?before=ayer", ADMIN)
    expect(bad.status).toBe(400)
  })
})

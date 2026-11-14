process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import type { KairosWriter } from "@odentia/agent"
import { createOwnerDb, type Db } from "@odentia/db"
import {
  saasClient,
  saasClientContact,
  saasClientFile,
  saasOutreach,
  saasProposal,
  saasTask,
} from "@odentia/db/schema/admin-arm"
import { adminStaff } from "@odentia/db/schema/admin-core"
import { organization, user } from "@odentia/db/schema/auth"
import { saasSubscription, saasWaitlistRequest } from "@odentia/db/schema/saas-billing"
import type { MailMessage } from "@odentia/mail"
import {
  type AdminActor,
  createSaasPlan,
  ingestInboundEmail,
  limaDate,
  ServiceError,
  type Storage,
  startSaasTrial,
} from "@odentia/services"
import { eq } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { Hono } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { errorBody } from "../lib/error.js"
import { createAdminClientsRoute } from "./admin-clients.js"

/**
 * El ARM contra Postgres real: la ruta montada como en app.ts (el guard de
 * admin lo reemplaza un middleware que pone el actor). Soporte recibe 403 en
 * lo que es solo de Administración, un parecido responde 409 con la lista, el
 * correo incierto no se reintenta, WhatsApp queda pendiente hasta «Salió», el
 * PDF sale como PDF, los archivos se revisan por su contenido y Kairós solo
 * propone.
 */

const IMAGE = "dentalagent-postgres:18.6"
const BASE = "/api/admin/clients"
const DAY = 86_400_000
const ADMIN = "arm-admin"
const SUPPORT = "arm-soporte"

let container: StartedTestContainer
let ownerDb: Db
let app: Hono<{ Variables: { adminActor: AdminActor } }>
let planId: string

const sent: MailMessage[] = []
let mailAttempts = 0
let failMail = false
const objects = new Map<string, Uint8Array>()
const annotateCalls: Array<Parameters<KairosWriter["parseAnnotation"]>[0]> = []

const storage = {
  putAttachmentAt: async (key: string, bytes: Uint8Array) => {
    objects.set(key, bytes)
  },
  deleteAttachment: async (key: string) => {
    objects.delete(key)
  },
  attachmentUrl: async (key: string) => `https://archivos.test/${key}?firma=1`,
  getAttachment: async (key: string) => {
    const bytes = objects.get(key)
    if (!bytes) throw new Error("no existe")
    return bytes
  },
} as unknown as Storage

const day = (offset: number) => limaDate(new Date(Date.now() + offset * DAY))

/** Kairós de prueba: nombra a una persona del cliente, otra que no es suya y una demo que no existe. */
const kairos = {
  parseAnnotation: async (input: Parameters<KairosWriter["parseAnnotation"]>[0]) => {
    annotateCalls.push(input)
    return {
      activity: {
        kind: "llamada",
        direction: "salio",
        outcome: "Quiere ver una demo",
        body: input.text,
        contactId: input.contacts[0]?.id ?? null,
      },
      task: {
        kind: "presentacion",
        title: "Presentación con la dueña",
        dueOn: day(2),
        dueAt: null,
        contactId: "6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f",
        demoId: "7a1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f",
      },
      newContacts: [{ name: "Ana Torres", title: "Administradora", roles: ["paga"] }],
      data: { city: "Arequipa" },
    }
  },
} as unknown as KairosWriter

function call(method: string, path: string, who: string, body?: unknown) {
  const headers = new Headers({ "x-test-user": who })
  let payload: RequestInit["body"]
  if (body instanceof FormData) payload = body
  else if (body !== undefined) {
    headers.set("content-type", "application/json")
    payload = JSON.stringify(body)
  }
  // La lista y el alta van a `/api/admin/clients`, sin barra final (como las pide la pantalla).
  return app.request(`${BASE}${path.replace(/^\/(?=$|\?)/, "")}`, {
    method,
    headers,
    body: payload,
  })
}

/** El estado, y si no es el esperado, el cuerpo en el mensaje del fallo. */
async function expectStatus(response: Response, status: number) {
  if (response.status !== status)
    expect(`${response.status} ${await response.clone().text()}`).toBe(String(status))
}

// biome-ignore lint/suspicious/noExplicitAny: los cuerpos de la prueba se leen sin tipo
async function json<T = any>(response: Response): Promise<T> {
  return (await response.json()) as T
}

async function staff(id: string, role: "admin" | "support") {
  await ownerDb.insert(user).values({
    id,
    name: id === ADMIN ? "Ada Admin" : "Sara Soporte",
    email: `${id}@sallca.test`,
    emailVerified: true,
  })
  await ownerDb.insert(adminStaff).values({ userId: id, role })
}

/** La persona principal de un cliente: a ella va lo que se escribe. */
async function primaryContact(clientId: string): Promise<string> {
  const [row] = await ownerDb
    .select({ id: saasClientContact.id })
    .from(saasClientContact)
    .where(eq(saasClientContact.clientId, clientId))
  if (!row) throw new Error("sin persona")
  return row.id
}

/** Un cliente nuevo por la ruta, con su persona principal. */
async function newClient(name: string, email: string) {
  const response = await call("POST", "/", ADMIN, {
    name,
    product: "dental",
    contact: { name: "Luis Mamani", phone: "+51 987 654 321", email },
    origin: "referido",
  })
  await expectStatus(response, 201)
  return (await json<{ data: { id: string } }>(response)).data.id
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
  await staff(ADMIN, "admin")
  await staff(SUPPORT, "support")
  const plan = await createSaasPlan(ownerDb, ADMIN, {
    code: "arm-ruta",
    name: "Plan odentIA (ficticio)",
    currency: "USD",
    priceCents: 2900,
    creditCents: 2900,
    conversationMicros: 500_000,
    consultationMicros: 400_000,
    recoveryMicros: 4_000_000,
    trialCreditCents: 1_000,
    trialMaxCreditCents: 5_000,
    trialDays: 30,
    trialMaxDays: 60,
    maxDiscountBps: 3000,
    sellerDiscountBps: 1000,
  })
  planId = plan.id

  app = new Hono<{ Variables: { adminActor: AdminActor } }>()
  // En app.ts lo pone `requireAdminContext` (sesión, factor y rol del personal).
  app.use("*", async (c, next) => {
    const id = c.req.header("x-test-user") ?? ""
    c.set("adminActor", { userId: id, role: id === ADMIN ? "admin" : "support" })
    await next()
  })
  app.route(
    BASE,
    createAdminClientsRoute({
      ownerDb,
      storage,
      kairos,
      startTrial: startSaasTrial,
      panelUrlOf: () => "https://app.odentia.localhost",
      invitationReplyToOf: (product) =>
        `hola@${product === "dental" ? "odentia32.com" : "otra.test"}`,
      mailer: {
        send: async (message) => {
          mailAttempts += 1
          if (failMail) throw new Error("se cortó la conexión con el servidor de correo")
          sent.push(message)
        },
      },
    }),
  )
  app.onError((err, c) => {
    if (err instanceof ServiceError)
      return c.json(errorBody(c, err.code, err.message, err.fields), err.status)
    console.error(err)
    return c.json(errorBody(c, "INTERNAL", "Error interno"), 500)
  })
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

describe("roles", () => {
  it("soporte recibe 403 en todo lo que es solo de Administración", async () => {
    const clientId = await newClient("Clínica Roles (ficticia)", "roles@andes.test")
    const someId = "5e1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f"
    const forbidden: Array<[string, string, unknown?]> = [
      ["POST", `/${clientId}/proposals`, { planId, discountBps: 0, validUntil: day(10) }],
      ["GET", `/${clientId}/proposals`],
      ["GET", `/proposals/${someId}/pdf`],
      ["POST", `/proposals/${someId}/decide`, { accepted: true }],
      ["POST", `/${clientId}/decide`, { decision: "perdido", reason: "precio" }],
      ["POST", `/${clientId}/opportunity`, {}],
      ["POST", `/${clientId}/invite`, { email: "x@andes.test" }],
      ["POST", `/${clientId}/assisted`, { slug: "roles", email: "x@andes.test" }],
      ["POST", `/${clientId}/merge`, { dropId: someId }],
      ["POST", `/${clientId}/archive`],
      ["DELETE", `/files/${someId}`],
      ["POST", `/contacts/${someId}/link`, { userId: ADMIN }],
    ]
    for (const [method, path, body] of forbidden) {
      const response = await call(method, path, SUPPORT, body)
      expect(response.status, `${method} ${path}`).toBe(403)
      expect((await json(response)).error.code).toBe("FORBIDDEN")
    }
    // Lo que Soporte sí hace: ver, anotar y poner tareas.
    expect((await call("GET", `/${clientId}`, SUPPORT)).status).toBe(200)
    expect((await call("GET", "/", SUPPORT)).status).toBe(200)
    expect(
      (
        await call("POST", `/${clientId}/activities`, SUPPORT, {
          kind: "nota",
          body: "Pidió que la llamen el lunes",
        })
      ).status,
    ).toBe(201)
    expect(
      (
        await call("POST", `/${clientId}/tasks`, SUPPORT, {
          kind: "llamar",
          title: "Llamar el lunes",
          dueOn: day(3),
        })
      ).status,
    ).toBe(201)
  })
})

describe("clientes", () => {
  it("un parecido responde 409 con la lista de duplicados y «Es otra» la crea igual", async () => {
    const firstId = await newClient("Clínica Sonrisas del Sur (ficticia)", "sonrisas@andes.test")
    const body = {
      name: "Sonrisas del Sur (ficticia)",
      product: "dental",
      contact: { name: "Rosa Díaz", email: "sonrisas@andes.test" },
      origin: "web",
    }
    const response = await call("POST", "/", SUPPORT, body)
    await expectStatus(response, 409)
    const error = (await json(response)).error
    expect(error.code).toBe("CLIENT_MAYBE_DUPLICATE")
    expect(error.duplicates).toEqual(
      expect.arrayContaining([expect.objectContaining({ clientId: firstId, why: "correo" })]),
    )
    const again = await call("POST", "/", SUPPORT, { ...body, confirmNew: true })
    await expectStatus(again, 201)
  })

  it("un cuerpo que no cumple responde 400 con su campo y en español", async () => {
    const response = await call("POST", "/", ADMIN, {
      name: "",
      product: "dental",
      contact: { name: "Luis" },
      origin: "web",
      extra: 1,
    })
    await expectStatus(response, 400)
    const error = (await json(response)).error
    expect(error.code).toBe("VALIDATION")
    expect(error.fields).toBeTruthy()
    const task = await call(
      "POST",
      `/${await newClient("Clínica Campos (ficticia)", "campos@andes.test")}/tasks`,
      ADMIN,
      { kind: "llamar", title: "x", dueOn: "mañana" },
    )
    await expectStatus(task, 400)
    expect((await json(task)).error.fields.dueOn).toBe("Elige el día")
  })

  it("la lista, la ficha, el historial, el alta, las tareas y el embudo responden", async () => {
    const clientId = await newClient("Clínica Lectura (ficticia)", "lectura@andes.test")
    const list = await json(await call("GET", "/?view=todos&q=Lectura", ADMIN))
    expect(list.data.items.map((item: { id: string }) => item.id)).toContain(clientId)
    expect((await json(await call("GET", `/${clientId}`, ADMIN))).data.name).toBe(
      "Clínica Lectura (ficticia)",
    )
    expect((await call("GET", `/${clientId}/timeline?filter=todo&limit=20`, SUPPORT)).status).toBe(
      200,
    )
    expect((await call("GET", `/${clientId}/contacts`, SUPPORT)).status).toBe(200)
    expect((await call("GET", `/${clientId}/onboarding`, SUPPORT)).status).toBe(200)
    expect((await call("GET", "/tasks?who=todas", SUPPORT)).status).toBe(200)
    expect((await call("GET", "/pipeline?product=dental", SUPPORT)).status).toBe(200)
    expect((await call("GET", "/tasks?who=nadie", SUPPORT)).status).toBe(400)
  })

  it("los enlaces de antes encuentran su cliente por la solicitud o por la cuenta, sin crear ninguno", async () => {
    const clientId = await newClient("Huancayo Puentes Sonrientes", "enlaces@andes.test")
    const orgId = "org-enlaces-ficticia"
    const demoOrgId = "org-enlaces-demo"
    await ownerDb.insert(organization).values([
      {
        id: orgId,
        name: "Clínica Enlaces (ficticia)",
        slug: "enlaces-ficticia",
        createdAt: new Date(),
      },
      {
        id: demoOrgId,
        name: "Demo Enlaces (ficticia)",
        slug: "enlaces-demo",
        createdAt: new Date(),
      },
    ])
    await ownerDb
      .update(saasClient)
      .set({ organizationId: orgId })
      .where(eq(saasClient.id, clientId))
    const [request] = await ownerDb
      .insert(saasWaitlistRequest)
      .values({
        firstName: "Luis",
        lastName: "Mamani",
        email: "enlaces@andes.test",
        phone: "+51987654321",
        clinicName: "Clínica Enlaces (ficticia)",
        countryCode: "PE",
        city: "Cusco",
        professionals: "4-9",
        currentTool: "otro_software",
        clientId,
      })
      .returning({ id: saasWaitlistRequest.id })
    // Una solicitud vieja sin cliente, pero con su cuenta: también llega.
    const [orphan] = await ownerDb
      .insert(saasWaitlistRequest)
      .values({
        firstName: "Rosa",
        lastName: "Díaz",
        email: "huerfana@andes.test",
        phone: "+51987654322",
        clinicName: "Clínica Enlaces (ficticia)",
        countryCode: "PE",
        city: "Cusco",
        professionals: "1",
        currentTool: "nada",
        status: "entro",
        planId,
        enteredAt: new Date(),
        organizationId: orgId,
      })
      .returning({ id: saasWaitlistRequest.id })

    const byRequest = await call("GET", `/lookup?request=${request?.id}`, SUPPORT)
    await expectStatus(byRequest, 200)
    expect((await json(byRequest)).data).toEqual({ clientId })
    expect((await json(await call("GET", `/lookup?request=${orphan?.id}`, ADMIN))).data).toEqual({
      clientId,
    })
    expect((await json(await call("GET", `/lookup?organization=${orgId}`, SUPPORT))).data).toEqual({
      clientId,
    })

    // Una cuenta sin cliente (una demo) no crea uno: 404.
    const before = (await ownerDb.select({ id: saasClient.id }).from(saasClient)).length
    const demo = await call("GET", `/lookup?organization=${demoOrgId}`, ADMIN)
    await expectStatus(demo, 404)
    expect((await ownerDb.select({ id: saasClient.id }).from(saasClient)).length).toBe(before)
    await expectStatus(
      await call("GET", "/lookup?request=5e1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f", ADMIN),
      404,
    )
    // Una de las dos, nunca ninguna ni las dos.
    await expectStatus(await call("GET", "/lookup", ADMIN), 400)
    await expectStatus(
      await call("GET", `/lookup?request=${request?.id}&organization=${orgId}`, ADMIN),
      400,
    )
  })
})

describe("anotar con Kairós", () => {
  it("la vista previa solo propone y no liga lo que no es del cliente; guardar lo deja todo junto", async () => {
    const clientId = await newClient("Clínica Andina (ficticia)", "andina@andes.test")
    const [contact] = await ownerDb
      .select()
      .from(saasClientContact)
      .where(eq(saasClientContact.clientId, clientId))
    const before = await ownerDb.select().from(saasTask).where(eq(saasTask.clientId, clientId))
    const preview = await call("POST", `/${clientId}/annotate/preview`, SUPPORT, {
      text: "Hablé con Luis, quiere ver una demo el jueves; Ana Torres paga",
    })
    await expectStatus(preview, 200)
    const proposal = (await json(preview)).data
    // Al modelo viajan el nombre, el producto, la etapa y los nombres: ni correos ni teléfonos.
    const sentToModel = annotateCalls.at(-1)
    expect(sentToModel?.client).toMatchObject({
      name: "Clínica Andina (ficticia)",
      product: "dental",
    })
    expect(sentToModel?.contacts).toEqual([{ id: contact?.id, name: "Luis Mamani" }])
    expect(proposal.annotation.activity.contactId).toBe(contact?.id)
    expect(proposal.annotation.task.contactId).toBeNull()
    expect(proposal.annotation.task.demoId).toBeNull()
    // Nada se guardó todavía.
    expect(
      await ownerDb.select().from(saasTask).where(eq(saasTask.clientId, clientId)),
    ).toHaveLength(before.length)

    const saved = await call("POST", `/${clientId}/annotate`, SUPPORT, {
      activity: proposal.annotation.activity,
      task: proposal.annotation.task,
      newContacts: proposal.annotation.newContacts,
      data: proposal.annotation.data,
    })
    await expectStatus(saved, 201)
    const result = (await json(saved)).data
    expect(result.activity.kind).toBe("llamada")
    expect(result.task.kind).toBe("presentacion")
    expect(result.contacts[0].name).toBe("Ana Torres")
    const [client] = await ownerDb.select().from(saasClient).where(eq(saasClient.id, clientId))
    expect(client?.city).toBe("Arequipa")
    const timeline = (await json(await call("GET", `/${clientId}/timeline`, SUPPORT))).data
    expect(timeline.items.length).toBeGreaterThan(0)
  })

  it("sin Kairós con modelo, ordena el doble determinista y no gasta", async () => {
    const clientId = await newClient("Policlínico Ucayali (ficticio)", "ucayali@andes.test")
    const bare = new Hono<{ Variables: { adminActor: AdminActor } }>()
    bare.use("*", async (c, next) => {
      c.set("adminActor", { userId: SUPPORT, role: "support" })
      await next()
    })
    bare.route(
      BASE,
      createAdminClientsRoute({
        ownerDb,
        storage,
        panelUrlOf: () => "https://app.odentia.localhost",
        mailer: { send: async () => {} },
      }),
    )
    const response = await bare.request(`${BASE}/${clientId}/annotate/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Llamé a Luis, quedamos en volver a llamar el lunes" }),
    })
    await expectStatus(response, 200)
    const { annotation, drafter } = (await json(response)).data
    expect(annotation.activity.body).toBeTruthy()
    expect(annotation.activity.kind).toBeTruthy()
    // La pantalla dice que lo ordenó una plantilla, no el modelo.
    expect(drafter).toBe("plantilla")
  })

  it("si una pieza no se puede guardar, no queda nada a medias", async () => {
    const clientId = await newClient("Clínica Todo o Nada (ficticia)", "todo@andes.test")
    const response = await call("POST", `/${clientId}/annotate`, SUPPORT, {
      activity: { kind: "nota", direction: null, body: "Nota" },
      task: {
        kind: "llamar",
        title: "Llamar",
        dueOn: day(1),
        contactId: "6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f",
      },
      newContacts: [{ name: "Pedro Ríos", title: null, roles: [] }],
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
    const contacts = await ownerDb
      .select()
      .from(saasClientContact)
      .where(eq(saasClientContact.clientId, clientId))
    expect(contacts.map((row) => row.name)).not.toContain("Pedro Ríos")
  })
})

describe("envíos", () => {
  it("el correo que se corta queda incierto, responde 502 SEND_UNKNOWN y no se reintenta", async () => {
    const clientId = await newClient("Clínica Huancavelica (ficticia)", "correo@andes.test")
    failMail = true
    const attemptsBefore = mailAttempts
    const response = await call("POST", `/${clientId}/outreach`, SUPPORT, {
      channel: "correo",
      contactId: await primaryContact(clientId),
      subject: "Su demo",
      body: "Hola Luis,\n\nLe escribo por la demo.",
    })
    failMail = false
    await expectStatus(response, 502)
    const error = (await json(response)).error
    expect(error.code).toBe("SEND_UNKNOWN")
    expect(mailAttempts - attemptsBefore).toBe(1)
    const [row] = await ownerDb
      .select()
      .from(saasOutreach)
      .where(eq(saasOutreach.id, error.outreachId))
    expect(row?.status).toBe("incierto")
    // Lo resuelve una persona.
    const resolved = await call("POST", `/outreach/${error.outreachId}/resolve`, SUPPORT, {
      outcome: "no_salio",
    })
    await expectStatus(resolved, 200)
    expect((await json(resolved)).data.outreach.status).toBe("no_salio")
    expect(mailAttempts - attemptsBefore).toBe(1)
  })

  it("el correo que escribe Soporte sale desde soporte@ con la marca del producto, le responden ahí y queda enviado", async () => {
    const clientId = await newClient("Consultorio Pardo (ficticio)", "bien@andes.test")
    const response = await call("POST", `/${clientId}/outreach`, SUPPORT, {
      channel: "correo",
      contactId: await primaryContact(clientId),
      subject: "Su demo",
      body: "Hola Luis,\n\nLe escribo por la demo.",
    })
    await expectStatus(response, 201)
    const data = (await json(response)).data
    expect(data.outreach.status).toBe("enviado")
    const mail = sent.at(-1)
    expect(mail).toMatchObject({
      to: "bien@andes.test",
      subject: "Su demo",
      from: { name: "Soporte · odentIA", address: "soporte@odentia32.com" },
      replyTo: "soporte@odentia32.com",
      brand: "odentia",
    })
    expect(mail?.messageId).toMatch(/^<[0-9a-f-]{36}@odentia32\.com>$/)
    expect(data.outreach.from).toBe("soporte@odentia32.com")
  })

  it("WhatsApp devuelve el enlace con el texto y queda pendiente hasta «Salió»", async () => {
    const clientId = await newClient("Centro Dental Marañón (ficticio)", "wa@andes.test")
    const attemptsBefore = mailAttempts
    const response = await call("POST", `/${clientId}/outreach`, SUPPORT, {
      channel: "whatsapp",
      contactId: await primaryContact(clientId),
      body: "Hola Luis, ¿le queda bien el jueves?",
    })
    await expectStatus(response, 201)
    const data = (await json(response)).data
    expect(data.url).toBe(
      `https://wa.me/51987654321?text=${encodeURIComponent("Hola Luis, ¿le queda bien el jueves?")}`,
    )
    expect(data.outreach.status).toBe("pendiente")
    expect(mailAttempts).toBe(attemptsBefore)
    const resolved = await call("POST", `/outreach/${data.outreach.id}/resolve`, SUPPORT, {
      outcome: "salio",
    })
    expect((await json(resolved)).data.outreach.status).toBe("enviado")
    // Ya tiene su resultado: no se resuelve dos veces.
    expect(
      (
        await call("POST", `/outreach/${data.outreach.id}/resolve`, SUPPORT, {
          outcome: "no_salio",
        })
      ).status,
    ).toBe(409)
  })
})

describe("responder un correo", () => {
  async function arrived(mailbox: "soporte" | "hola", messageId: string, clientId?: string) {
    const result = await ownerDb.transaction((tx) =>
      ingestInboundEmail(tx as Db, {
        mailbox,
        product: "dental",
        messageId,
        from: clientId ? "responde@andes.test" : "nueva@gmail.test",
        fromName: "Elena Quispe",
        to: `${mailbox}@odentia32.com`,
        subject: "Consulta",
        text: "Hola,\n¿cómo empiezo?",
        receivedAt: new Date(),
        senderVerified: true,
      }),
    )
    return result.id
  }

  it("Soporte responde lo de soporte@ desde soporte@; lo demás le responde 403", async () => {
    const support = await arrived("soporte", "<r-soporte@gmail.test>")
    const response = await call("POST", `/inbound/${support}/reply`, SUPPORT, {
      body: "Ya lo revisamos.",
    })
    await expectStatus(response, 201)
    expect((await json(response)).data.outreach).toMatchObject({
      status: "enviado",
      clientId: null,
      from: "soporte@odentia32.com",
      inReplyToEmailId: support,
    })
    expect(sent.at(-1)).toMatchObject({
      to: "nueva@gmail.test",
      subject: "Re: Consulta",
      from: { name: "Soporte · odentIA", address: "soporte@odentia32.com" },
      replyTo: "soporte@odentia32.com",
      headers: { "In-Reply-To": "<r-soporte@gmail.test>", References: "<r-soporte@gmail.test>" },
    })
    expect(sent.at(-1)?.text).toContain("> ¿cómo empiezo?")
    const commercial = await arrived("hola", "<r-hola@gmail.test>")
    await expectStatus(
      await call("POST", `/inbound/${commercial}/reply`, SUPPORT, { body: "Hola" }),
      403,
    )
    // Tampoco lo lee: para Soporte no existe.
    await expectStatus(await call("GET", `/inbound/${commercial}`, SUPPORT), 404)
    const read = await call("GET", `/inbound/${support}`, SUPPORT)
    await expectStatus(read, 200)
    expect((await json(read)).data).toMatchObject({
      id: support,
      mailbox: "soporte",
      text: "Hola,\n¿cómo empiezo?",
      canReply: true,
      replies: [expect.objectContaining({ status: "enviado", from: "soporte@odentia32.com" })],
    })
  })

  it("Administración responde lo comercial con su dirección; sin cliente no adjunta propuesta", async () => {
    const commercial = await arrived("hola", "<r-hola-2@gmail.test>")
    const someId = "5e1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f"
    await expectStatus(
      await call("POST", `/inbound/${commercial}/reply`, ADMIN, {
        body: "Hola",
        proposalId: someId,
      }),
      400,
    )
    await expectStatus(
      await call("POST", `/inbound/${commercial}/reply`, ADMIN, { body: " " }),
      400,
    )
    const response = await call("POST", `/inbound/${commercial}/reply`, ADMIN, {
      body: "Hola, Elena: le cuento cómo empezar.",
    })
    await expectStatus(response, 201)
    expect(sent.at(-1)).toMatchObject({
      from: { name: "Ada Admin · odentIA", address: "ada.admin@odentia32.com" },
      replyTo: "ada.admin@odentia32.com",
    })
    await expectStatus(
      await call("POST", `/inbound/5e1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f/reply`, ADMIN, {
        body: "Hola",
      }),
      404,
    )
  })

  it("si se corta, queda incierto y no se reintenta, como «Escribir»", async () => {
    const email = await arrived("soporte", "<r-corte@gmail.test>")
    failMail = true
    const attempts = mailAttempts
    const response = await call("POST", `/inbound/${email}/reply`, ADMIN, { body: "Hola" })
    failMail = false
    await expectStatus(response, 502)
    expect((await json(response)).error.code).toBe("SEND_UNKNOWN")
    expect(mailAttempts - attempts).toBe(1)
  })
})

describe("propuesta, invitar y dar de alta", () => {
  it("la propuesta sale en PDF, se envía por WhatsApp, se acepta y el alta asistida aplica sus condiciones", async () => {
    const clientId = await newClient("Clínica Propuesta (ficticia)", "propuesta@andes.test")
    const created = await call("POST", `/${clientId}/proposals`, ADMIN, {
      planId,
      discountBps: 500,
      discountMonths: 6,
      billingCycle: "mensual",
      validUntil: day(15),
    })
    await expectStatus(created, 201)
    const proposalId = (await json(created)).data.id as string

    const pdf = await call("GET", `/proposals/${proposalId}/pdf`, ADMIN)
    await expectStatus(pdf, 200)
    expect(pdf.headers.get("content-type")).toBe("application/pdf")
    const bytes = new Uint8Array(await pdf.arrayBuffer())
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-")

    const outreach = (
      await json(
        await call("POST", `/${clientId}/outreach`, ADMIN, {
          channel: "whatsapp",
          contactId: await primaryContact(clientId),
          body: "Le dejo la propuesta.",
          proposalId,
        }),
      )
    ).data
    await call("POST", `/outreach/${outreach.outreach.id}/resolve`, ADMIN, { outcome: "salio" })
    const decided = await call("POST", `/proposals/${proposalId}/decide`, ADMIN, {
      accepted: true,
      note: "Aceptó por teléfono",
    })
    await expectStatus(decided, 200)

    const before = sent.length
    const assisted = await call("POST", `/${clientId}/assisted`, ADMIN, {
      slug: "clinica-propuesta-arm",
      email: "duena@propuesta.test",
    })
    await expectStatus(assisted, 201)
    const result = (await json(assisted)).data
    expect(result.clientId).toBe(clientId)
    expect(result.proposal).toMatchObject({ id: proposalId, applied: true })
    const [client] = await ownerDb.select().from(saasClient).where(eq(saasClient.id, clientId))
    expect(client?.organizationId).toBe(result.organizationId)
    const [subscription] = await ownerDb
      .select()
      .from(saasSubscription)
      .where(eq(saasSubscription.organizationId, result.organizationId))
    expect(subscription?.planId).toBe(planId)
    expect(sent.length).toBe(before + 1)
    expect(sent.at(-1)?.to).toBe("duena@propuesta.test")
    const [proposal] = await ownerDb
      .select()
      .from(saasProposal)
      .where(eq(saasProposal.id, proposalId))
    expect(proposal?.status).toBe("aceptada")
  })

  it("«Dar de alta yo» no aplica la propuesta aceptada de una venta anterior", async () => {
    const clientId = await newClient("Clínica Venta Vieja (ficticia)", "vieja@andes.test")
    const created = await call("POST", `/${clientId}/proposals`, ADMIN, {
      planId,
      discountBps: 1000,
      discountMonths: 12,
      billingCycle: "mensual",
      validUntil: day(15),
    })
    const proposalId = (await json(created)).data.id as string
    const outreach = (
      await json(
        await call("POST", `/${clientId}/outreach`, ADMIN, {
          channel: "whatsapp",
          contactId: await primaryContact(clientId),
          body: "Le dejo la propuesta.",
          proposalId,
        }),
      )
    ).data
    await call("POST", `/outreach/${outreach.outreach.id}/resolve`, ADMIN, { outcome: "salio" })
    await expectStatus(
      await call("POST", `/proposals/${proposalId}/decide`, ADMIN, { accepted: true }),
      200,
    )
    await expectStatus(
      await call("POST", `/${clientId}/decide`, ADMIN, { decision: "perdido", reason: "precio" }),
      200,
    )
    // La venta nueva se abre después: lo de la anterior ya no cuenta.
    await new Promise((resolve) => setTimeout(resolve, 20))
    await expectStatus(await call("POST", `/${clientId}/reopen`, ADMIN), 200)
    const assisted = await call("POST", `/${clientId}/assisted`, ADMIN, {
      slug: "clinica-venta-vieja-arm",
      email: "duena@vieja.test",
      planCode: "arm-ruta",
    })
    await expectStatus(assisted, 201)
    const result = (await json(assisted)).data
    expect(result.proposal).toBeNull()
    const [subscription] = await ownerDb
      .select()
      .from(saasSubscription)
      .where(eq(saasSubscription.organizationId, result.organizationId))
    expect(subscription?.discountBps ?? 0).toBe(0)
  })

  it("invitar devuelve el enlace y envía el correo con la respuesta a hola@ de su marca", async () => {
    const clientId = await newClient("Clínica Invitada (ficticia)", "invitada@andes.test")
    const response = await call("POST", `/${clientId}/invite`, ADMIN, {
      email: "invitada@andes.test",
      planId,
      city: "Cusco",
      professionals: "4-9",
      currentTool: "otro_software",
    })
    await expectStatus(response, 200)
    const data = (await json(response)).data
    expect(data.url).toMatch(/^https:\/\/app\.odentia\.localhost\/register\?invitacion=/)
    expect(data.emailSent).toBe(true)
    expect(sent.at(-1)).toMatchObject({
      to: "invitada@andes.test",
      replyTo: "hola@odentia32.com",
    })
  })
})

describe("documentos", () => {
  const pdfBytes = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n")
  const form = (bytes: Uint8Array, type: string, kind = "otro") => {
    const data = new FormData()
    data.set("file", new File([bytes], "carta firmada.pdf", { type }))
    data.set("kind", kind)
    return data
  }

  it("sube con el tipo revisado, descarga por enlace firmado y solo Administración borra", async () => {
    const clientId = await newClient("Clínica Documentos (ficticia)", "docs@andes.test")
    const uploaded = await call(
      "POST",
      `/${clientId}/files`,
      ADMIN,
      form(pdfBytes, "application/pdf", "carta"),
    )
    await expectStatus(uploaded, 201)
    const file = (await json(uploaded)).data
    const [row] = await ownerDb.select().from(saasClientFile).where(eq(saasClientFile.id, file.id))
    expect(row?.objectKey.startsWith(`clients/${clientId}/`)).toBe(true)
    expect(objects.has(row?.objectKey ?? "")).toBe(true)

    const download = await call("GET", `/files/${file.id}`, ADMIN)
    await expectStatus(download, 302)
    expect(download.headers.get("location")).toContain(row?.objectKey)
    // Soporte no ve lo que es solo de Administración.
    expect((await call("GET", `/files/${file.id}`, SUPPORT)).status).toBe(404)
    expect((await json(await call("GET", `/${clientId}/files`, SUPPORT))).data.items).toHaveLength(
      0,
    )

    expect((await call("DELETE", `/files/${file.id}`, ADMIN)).status).toBe(200)
    expect(objects.has(row?.objectKey ?? "")).toBe(false)
  })

  it("acepta lo mismo que llega por correo y lo adjunta a una respuesta, que sale con él", async () => {
    const clientId = await newClient("Clínica Adjuntos (ficticia)", "adjuntos@andes.test")
    const csv = new FormData()
    csv.set("file", new File(["nombre;cita\nRosa;lunes\n"], "agenda.csv", { type: "text/csv" }))
    const uploaded = await call("POST", `/${clientId}/files`, ADMIN, csv)
    await expectStatus(uploaded, 201)
    const file = (await json(uploaded)).data
    expect(file).toMatchObject({ filename: "agenda.csv", contentType: "text/csv" })
    // Un ZIP cualquiera con nombre de Excel no pasa.
    const zip = new FormData()
    zip.set(
      "file",
      new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])], "lista.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    )
    await expectStatus(await call("POST", `/${clientId}/files`, ADMIN, zip), 400)

    const inbound = await ownerDb.transaction((tx) =>
      ingestInboundEmail(tx as Db, {
        mailbox: "hola",
        product: "dental",
        messageId: "<adjuntos@andes.test>",
        from: "adjuntos@andes.test",
        fromName: "Luis Mamani",
        to: "hola@odentia32.com",
        subject: "¿Me mandan la agenda?",
        text: "Hola",
        receivedAt: new Date(),
        senderVerified: true,
      }),
    )
    expect(inbound.clientId).toBe(clientId)
    const reply = await call("POST", `/inbound/${inbound.id}/reply`, ADMIN, {
      body: "Va **adjunta**.",
      fileIds: [file.id],
    })
    await expectStatus(reply, 201)
    expect(sent.at(-1)?.attachments).toEqual([
      { filename: "agenda.csv", content: expect.any(Uint8Array), contentType: "text/csv" },
    ])
    expect(sent.at(-1)?.html).toContain("<strong>adjunta</strong>")
    await expectStatus(
      await call("POST", `/inbound/${inbound.id}/reply`, ADMIN, {
        body: "Otra",
        fileIds: Array.from({ length: 6 }, () => file.id),
      }),
      400,
    )
  })

  it("un archivo que no es lo que dice, uno muy grande o uno sin cliente no queda guardado", async () => {
    const clientId = await newClient("Clínica Archivos Malos (ficticia)", "malos@andes.test")
    const count = objects.size
    const fake = await call(
      "POST",
      `/${clientId}/files`,
      ADMIN,
      form(new TextEncoder().encode("<html>hola</html>"), "application/pdf"),
    )
    await expectStatus(fake, 400)
    expect((await json(fake)).error.fields.file).toBeTruthy()
    const big = new Uint8Array(10 * 1024 * 1024 + 10)
    big.set(pdfBytes)
    const tooBig = await call("POST", `/${clientId}/files`, ADMIN, form(big, "application/pdf"))
    expect([400, 413]).toContain(tooBig.status)
    // El registro falla (el cliente no existe): el objeto subido se borra.
    const orphan = await call(
      "POST",
      "/8b1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f/files",
      ADMIN,
      form(pdfBytes, "application/pdf"),
    )
    await expectStatus(orphan, 404)
    expect(objects.size).toBe(count)
  })
})

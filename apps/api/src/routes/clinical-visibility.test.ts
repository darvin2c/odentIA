process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { createAppDb, createOwnerDb, type Db, withOrgContext } from "@odentia/db"
import { patient, patientContact } from "@odentia/db/schema/clinical"
import { auditEvent } from "@odentia/db/schema/org"
import { createPatient, healthDocumentPatientOfMessage, listContactTasks, secretsKeyFromEnv } from "@odentia/services"
import { and, eq, sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { type Context, Hono, type Next } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { CrmDeps } from "./helpers.js"
import { createContactsRoute } from "./contacts.js"
import { createPatientsRoute } from "./patients.js"
import { createTasksRoute } from "./tasks.js"

/**
 * Lo clínico solo llega a quien lee la historia (`permissions.ts`: «lo clínico
 * nunca se entrega a recepción/caja»): las tareas clínicas, lo clínico de la
 * ficha y la copia de la historia enviada por la Bandeja. QA 2026-11-04, S3,
 * S4 y S8.
 */

const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("ab".repeat(32))

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db
let patientId = ""
let referralTaskId = ""
let clinicalTopicTaskId = ""
let receptionTaskId = ""

const storageStub = {
  putAvatar: async () => {
    throw new Error("no usado")
  },
  deleteByUrl: async () => {},
  putAttachment: async () => {
    throw new Error("no usado")
  },
  attachmentUrl: async (key: string) => `https://signed.example.com/${key}`,
  deleteAttachment: async () => {},
  putPatientDocument: async () => {
    throw new Error("no usado")
  },
  putPatientAvatar: async () => {
    throw new Error("no usado")
  },
}

function buildApp(role: string, userId = "u-1"): Hono {
  const deps: CrmDeps = { db: appDb, secretsKey: KEY, storage: storageStub, validateExternal: false, webhookBaseUrl: "https://api.example.com" }
  const app = new Hono()
  app.use("*", async (c: Context, next: Next) => {
    c.set("orgId", "org_a")
    c.set("userId", userId)
    c.set("memberRole", role)
    await next()
  })
  app.route("/tasks", createTasksRoute(deps))
  app.route("/patients", createPatientsRoute(deps))
  app.route("/contacts", createContactsRoute(deps))
  return app
}

const get = (role: string, path: string) => buildApp(role).request(path)
const patch = (role: string, path: string, body: unknown) =>
  buildApp(role).request(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

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
    .withCommand(["postgres", "-c", "shared_preload_libraries=pg_cron", "-c", "cron.database_name=dentalagent"])
    .start()
  const host = `${container.getHost()}:${container.getMappedPort(5432)}`
  ownerDb = createOwnerDb(`postgres://dentalagent:dentalagent@${host}/dentalagent`)
  await migrate(ownerDb, { migrationsFolder: "../../packages/db/drizzle" })
  appDb = createAppDb(`postgres://dentalagent_app:dentalagent_app@${host}/dentalagent`)
  await ownerDb.execute(sql`insert into "organization" ("id", "name", "slug", "created_at") values ('org_a', 'Clínica', 'norte', now())`)
  await ownerDb.execute(
    sql`insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale")
        values ('org_a', 'Clínica', 'PE', 'PEN', 'America/Lima', 'es-PE')`,
  )
  await ownerDb.execute(sql`insert into "user" ("id", "name", "email") values ('u-1', 'Ana', 'ana@test.dev'), ('u-2', 'Luis', 'luis@test.dev')`)
  const created = await withOrgContext(appDb, "org_a", (tx) => createPatient(tx, "org_a", "u-1", { displayName: "Sofía Salas" }))
  patientId = created.id
  await ownerDb.update(patient).set({ bloodGroup: "O+", asaClass: "II" }).where(eq(patient.id, patientId))
  const tasks = await ownerDb.execute<{ id: string }>(
    sql`insert into "task" ("organization_id", "patient_id", "assignee_user_id", "title", "status", "created_by", "area", "idempotency_key")
        values ('org_a', ${patientId}, 'u-2', 'Derivación: endodoncia de la 36', 'open', 'user', null, ${`clinical-order:${crypto.randomUUID()}`}),
               ('org_a', ${patientId}, null, 'Te lo pasó Sofi: dolor al morder', 'open', 'agent', 'clinico', null),
               ('org_a', ${patientId}, null, 'Llamar para confirmar la cita', 'open', 'user', 'recepcion', null)
        returning "id"`,
  )
  referralTaskId = tasks[0]!.id
  clinicalTopicTaskId = tasks[1]!.id
  receptionTaskId = tasks[2]!.id
}, 120_000)

afterAll(async () => {
  await container?.stop()
})

describe("tareas clínicas (S4)", () => {
  it("la derivación solo la ve quien atiende; el tema clínico del agente, también quien lee la conversación", async () => {
    const idsOf = async (role: string) => {
      const response = await get(role, `/tasks?patientId=${patientId}`)
      expect(response.status).toBe(200)
      return ((await response.json()) as { data: Array<{ id: string }> }).data.map((task) => task.id)
    }
    const cashier = await idsOf("cashier")
    expect(cashier).toContain(receptionTaskId)
    expect(cashier).not.toContain(referralTaskId)
    expect(cashier).not.toContain(clinicalTopicTaskId)
    const reception = await idsOf("reception")
    expect(reception).toEqual(expect.arrayContaining([receptionTaskId, clinicalTopicTaskId]))
    expect(reception).not.toContain(referralTaskId)
    const clinician = await get("clinician", `/tasks?patientId=${patientId}`)
    const seen = ((await clinician.json()) as { data: Array<{ id: string }> }).data.map((task) => task.id)
    expect(seen).toEqual(expect.arrayContaining([referralTaskId, clinicalTopicTaskId]))
  })

  it("por su id, una tarea clínica no se abre ni se cierra sin leer la historia", async () => {
    expect((await get("cashier", `/tasks/${referralTaskId}`)).status).toBe(404)
    expect((await get("reception", `/tasks/${referralTaskId}`)).status).toBe(404)
    expect((await patch("cashier", `/tasks/${clinicalTopicTaskId}`, { status: "done" })).status).toBe(404)
    expect((await get("clinician", `/tasks/${referralTaskId}`)).status).toBe(200)
    expect((await get("reception", `/tasks/${receptionTaskId}`)).status).toBe(200)
  })

  it("por su id, «Miembro» no abre una tarea que no es suya ni de su área", async () => {
    expect((await get("member", `/tasks/${receptionTaskId}`)).status).toBe(404)
  })
})

describe("el contexto de la Bandeja (S4)", () => {
  it("las tareas clínicas de la persona solo llegan a quien lee la historia", async () => {
    const [own] = await ownerDb
      .select({ id: patientContact.contactId })
      .from(patientContact)
      .where(and(eq(patientContact.patientId, patientId), eq(patientContact.relationship, "self")))
    await ownerDb.execute(
      sql`insert into "task" ("organization_id", "contact_id", "title", "status", "created_by", "area")
          values ('org_a', ${own!.id}, 'Te lo pasó Sofi: sangrado de encías', 'open', 'agent', 'clinico'),
                 ('org_a', ${own!.id}, 'Tema pendiente: cambiar la cita', 'open', 'user', 'recepcion')`,
    )
    const titles = async (clinical: boolean) =>
      (await withOrgContext(appDb, "org_a", (tx) => listContactTasks(tx, "org_a", own!.id, { clinical, conversations: false }))).map((task) => task.title)
    expect(await titles(false)).toEqual(["Tema pendiente: cambiar la cita"])
    expect(await titles(true)).toEqual(expect.arrayContaining(["Te lo pasó Sofi: sangrado de encías", "Tema pendiente: cambiar la cita"]))
  })
})

describe("lo clínico de la ficha (S8)", () => {
  it("recepción y caja no reciben el grupo sanguíneo ni la clase ASA; el clínico sí", async () => {
    type Detail = { data: { patient: { bloodGroup: string | null; asaClass: string | null } } }
    for (const role of ["reception", "cashier"]) {
      const body = (await (await get(role, `/patients/${patientId}`)).json()) as Detail
      expect(body.data.patient).toMatchObject({ bloodGroup: null, asaClass: null })
    }
    const clinician = (await (await get("clinician", `/patients/${patientId}`)).json()) as Detail
    expect(clinician.data.patient).toMatchObject({ bloodGroup: "O+", asaClass: "II" })
  })
})

describe("la copia de la historia enviada por la Bandeja (S3)", () => {
  it("es papel de salud: el adjunto la reconoce como de la persona", async () => {
    const messageId = crypto.randomUUID()
    await ownerDb.insert(auditEvent).values({
      organizationId: "org_a",
      actorUserId: "u-1",
      action: "patient_record.sent",
      entity: "message",
      entityId: messageId,
      metadata: { patientId },
    })
    expect(await withOrgContext(appDb, "org_a", (tx) => healthDocumentPatientOfMessage(tx, "org_a", messageId))).toBe(patientId)
  })
})

describe("lo que encontró la revisión del punto 5", () => {
  it("la ficha de contacto de recepción no trae la derivación entre sus tareas abiertas", async () => {
    const [own] = await ownerDb
      .select({ id: patientContact.contactId })
      .from(patientContact)
      .where(and(eq(patientContact.patientId, patientId), eq(patientContact.relationship, "self")))
    await ownerDb.execute(
      sql`insert into "task" ("organization_id", "contact_id", "assignee_user_id", "title", "status", "created_by", "idempotency_key")
          values ('org_a', ${own!.id}, 'u-2', 'Derivación: periodoncia', 'open', 'user', ${`clinical-order:${crypto.randomUUID()}`})`,
    )
    type Contact = { data: { openTasks: Array<{ title: string }> } }
    const reception = (await (await get("reception", `/contacts/${own!.id}`)).json()) as Contact
    expect(reception.data.openTasks.map((task) => task.title)).not.toContain("Derivación: periodoncia")
  })

  it("guardar la ficha no le devuelve lo clínico a recepción", async () => {
    const response = await patch("reception", `/patients/${patientId}`, { notes: "Prefiere la tarde" })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Record<string, unknown> }
    const row = (body.data["patient"] ?? body.data) as Record<string, unknown>
    expect(row).toMatchObject({ bloodGroup: null, asaClass: null, healthReviewStatus: null })
  })

  it("caja sigue viendo la tarea de la persona que solo lleva su contacto", async () => {
    const [own] = await ownerDb
      .select({ id: patientContact.contactId })
      .from(patientContact)
      .where(and(eq(patientContact.patientId, patientId), eq(patientContact.relationship, "self")))
    const [task] = await ownerDb.execute<{ id: string }>(
      sql`insert into "task" ("organization_id", "contact_id", "title", "status", "created_by", "area")
          values ('org_a', ${own!.id}, 'Cobrar el saldo del control', 'open', 'user', 'caja') returning "id"`,
    )
    const ids = ((await (await get("cashier", `/tasks?patientId=${patientId}`)).json()) as { data: Array<{ id: string }> }).data.map((t) => t.id)
    expect(ids).toContain(task!.id)
  })
})

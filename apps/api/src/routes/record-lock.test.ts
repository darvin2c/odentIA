process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { createAppDb, createOwnerDb, type Db, withOrgContext } from "@odentia/db"
import { patientContact } from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import { createPatient, secretsKeyFromEnv } from "@odentia/services"
import { and, eq, sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { type Context, Hono, type Next } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { lockedRecordGuard } from "../lib/record-lock.js"
import { createAgentAdminRoute } from "./agent-admin.js"
import { createAppointmentsRoute } from "./appointments.js"
import { createClinicalFormsRoute } from "./clinical-forms.js"
import { createContactsRoute } from "./contacts.js"
import { createCrmWorkspaceRoute } from "./crm-workspace.js"
import { createFinanceRoute } from "./finance.js"
import { createFinancialDocumentsRoute } from "./financial-documents.js"
import type { CrmDeps } from "./helpers.js"
import { createPatientRegistrationRoute } from "./patient-registration.js"
import { createPatientsRoute } from "./patients.js"
import { createPeopleRoute } from "./people.js"

/**
 * La historia bloqueada (ADR 0080) en toda la API, no solo en `/patients/:id`,
 * `/people/:id` y `/contacts/:id`: lo que la nombra en la consulta, en el
 * cuerpo o por el id de un papel o de una cita. Para quien no es
 * Administración no existe (404); a Administración se le dice 423, y abierta
 * para leer solo deja leer.
 */

const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("ab".repeat(32))

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db
let openPatientId = ""
let lockedPatientId = ""
let lockedPersonId = ""
let openPersonId = ""
let lockedOrderId = ""
let openOrderId = ""
let lockedAppointmentId = ""
let branchId = ""
let lockedTicketId = ""
let openIdentityId = ""

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

/** La app como la arma `app.ts`: la guarda común antes de las rutas, y en su orden de montaje. */
function buildApp(role: string): Hono {
  const deps: CrmDeps = {
    db: appDb,
    secretsKey: KEY,
    storage: storageStub,
    validateExternal: false,
    webhookBaseUrl: "https://api.example.com",
  }
  const app = new Hono()
  app.use("*", async (c: Context, next: Next) => {
    c.set("orgId", "org_a")
    c.set("userId", "u-1")
    c.set("memberRole", role)
    await next()
  })
  app.use("*", lockedRecordGuard(appDb))
  // Como en `app.ts`: el registro va en «/» y antes que la ficha y la persona.
  app.route("/", createPatientRegistrationRoute({ ...deps, cookieDomain: "example.com", webURL: "https://example.com" }))
  app.route("/contacts", createContactsRoute(deps))
  app.route("/crm", createCrmWorkspaceRoute(deps))
  app.route("/patients", createFinancialDocumentsRoute(deps))
  app.route("/patients", createPatientsRoute(deps))
  app.route("/people", createPeopleRoute(deps))
  app.route("/appointments", createAppointmentsRoute(deps))
  app.route("/agent/admin", createAgentAdminRoute({ ...deps, llm: { fake: true } }))
  app.route("/finance", createFinanceRoute(deps))
  app.route("/clinical-forms", createClinicalFormsRoute(deps))
  return app
}

const json = { "content-type": "application/json" }
const get = (role: string, path: string) => buildApp(role).request(path)
const send = (role: string, method: string, path: string, body: unknown) =>
  buildApp(role).request(path, { method, headers: json, body: JSON.stringify(body) })

async function personOf(patientId: string): Promise<string> {
  const [own] = await ownerDb
    .select({ id: patientContact.contactId })
    .from(patientContact)
    .where(and(eq(patientContact.patientId, patientId), eq(patientContact.relationship, "self")))
  if (!own) throw new Error("La paciente de prueba no tiene su ficha propia")
  return own.id
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
    .withCommand(["postgres", "-c", "shared_preload_libraries=pg_cron", "-c", "cron.database_name=dentalagent"])
    .start()
  const host = `${container.getHost()}:${container.getMappedPort(5432)}`
  ownerDb = createOwnerDb(`postgres://dentalagent:dentalagent@${host}/dentalagent`)
  await migrate(ownerDb, { migrationsFolder: "../../packages/db/drizzle" })
  appDb = createAppDb(`postgres://dentalagent_app:dentalagent_app@${host}/dentalagent`)
  await ownerDb.execute(
    sql`insert into "organization" ("id", "name", "slug", "created_at") values ('org_a', 'Clínica', 'norte', now())`,
  )
  await ownerDb.execute(
    sql`insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale")
        values ('org_a', 'Clínica', 'PE', 'PEN', 'America/Lima', 'es-PE')`,
  )
  await ownerDb.execute(sql`insert into "user" ("id", "name", "email") values ('u-1', 'Ana', 'ana@test.dev')`)
  const [open, locked] = await withOrgContext(appDb, "org_a", async (tx) => [
    await createPatient(tx, "org_a", "u-1", { displayName: "Sofía Abierta" }),
    await createPatient(tx, "org_a", "u-1", { displayName: "Lucía Cerrada" }),
  ])
  openPatientId = open!.id
  lockedPatientId = locked!.id
  openPersonId = await personOf(openPatientId)
  lockedPersonId = await personOf(lockedPatientId)

  // Lo que ya tenía antes de bloquearse: una orden y una cita pasada.
  const orders = await ownerDb.execute<{ id: string }>(
    sql`insert into "clinical_order" ("organization_id", "kind", "patient_id", "recipient", "title")
        values ('org_a', 'laboratorio', ${lockedPatientId}, 'Laboratorio', 'Hemograma'),
               ('org_a', 'laboratorio', ${openPatientId}, 'Laboratorio', 'Glucosa')
        returning "id"`,
  )
  lockedOrderId = orders[0]!.id
  openOrderId = orders[1]!.id
  const [branch] = await ownerDb.execute<{ id: string }>(
    sql`insert into "branch" ("organization_id", "name") values ('org_a', 'Sede') returning "id"`,
  )
  branchId = branch!.id
  const frozen = JSON.stringify({ patient: { displayName: "Lucía Cerrada", docNumber: "70000001" }, lines: [], methods: [] })
  const [ticket] = await ownerDb.execute<{ id: string }>(
    sql`insert into "payment_ticket" ("organization_id", "patient_id", "branch_id", "ticket_number", "currency", "total_cents", "snapshot")
        values ('org_a', ${lockedPatientId}, ${branchId}, 1, 'PEN', 5000, ${frozen}::jsonb)
        returning "id"`,
  )
  lockedTicketId = ticket!.id
  const [identity] = await ownerDb.execute<{ id: string }>(
    sql`insert into "contact_identity" ("organization_id", "contact_id", "channel", "external_user_id")
        values ('org_a', ${openPersonId}, 'whatsapp', '447700900123') returning "id"`,
  )
  openIdentityId = identity!.id
  const [room] = await ownerDb.execute<{ id: string }>(
    sql`insert into "schedule_room" ("organization_id", "branch_id", "name") values ('org_a', ${branch!.id}, 'Unidad 1') returning "id"`,
  )
  const [appointment] = await ownerDb.execute<{ id: string }>(
    sql`insert into "appointment" ("organization_id", "branch_id", "patient_id", "professional_user_id", "room_id", "starts_at", "ends_at", "duration_min", "status")
        values ('org_a', ${branch!.id}, ${lockedPatientId}, 'u-1', ${room!.id}, now() - interval '3 days', now() - interval '3 days' + interval '30 minutes', 30, 'atendida')
        returning "id"`,
  )
  lockedAppointmentId = appointment!.id

  // Bloquear una historia la desactiva (ver el CHECK de contact en packages/db).
  await ownerDb
    .update(contact)
    .set({ isActive: false, recordLockedAt: new Date(), recordLockedBy: "u-1" })
    .where(eq(contact.id, lockedPersonId))
}, 120_000)

afterAll(async () => {
  await container?.stop()
})

describe("órdenes, consentimientos y formularios de una historia bloqueada (S1)", () => {
  it("no se emite una orden: 404 a quien no es Administración y 423 a Administración", async () => {
    const order = { patientId: lockedPatientId, kind: "laboratorio", recipient: "Laboratorio", title: "Perfil lipídico" }
    expect((await send("clinician", "POST", "/clinical-forms/orders", order)).status).toBe(404)
    expect((await send("admin", "POST", "/clinical-forms/orders", order)).status).toBe(423)
  })

  it("no se crean consentimientos ni formularios para ella", async () => {
    // A Administración se le dice 423 antes de buscar la plantilla: el 404 de
    // quien no es Administración no se confunde con «plantilla inexistente».
    const consent = { patientId: lockedPatientId, templateId: crypto.randomUUID() }
    expect((await send("admin", "POST", "/clinical-forms/consents", consent)).status).toBe(423)
    const form = { patientId: lockedPatientId, templateId: crypto.randomUUID() }
    expect((await send("admin", "POST", "/clinical-forms/form-responses", form)).status).toBe(423)
  })

  it("sus órdenes, consentimientos y formularios no se listan por su paciente", async () => {
    for (const path of ["orders", "consents", "form-responses"]) {
      expect((await get("clinician", `/clinical-forms/${path}?patientId=${lockedPatientId}`)).status).toBe(404)
      expect((await get("admin", `/clinical-forms/${path}?patientId=${lockedPatientId}`)).status).toBe(423)
    }
  })

  it("la lista de trabajo de órdenes no trae las de una historia bloqueada", async () => {
    const response = await get("clinician", "/clinical-forms/orders")
    expect(response.status).toBe(200)
    const ids = ((await response.json()) as { data: Array<{ id: string }> }).data.map((order) => order.id)
    expect(ids).toContain(openOrderId)
    expect(ids).not.toContain(lockedOrderId)
  })

  it("una orden suya abierta por su id no se imprime ni cambia de estado", async () => {
    expect((await get("clinician", `/clinical-forms/orders/${lockedOrderId}/print`)).status).toBe(404)
    expect(
      (await send("clinician", "POST", `/clinical-forms/orders/${lockedOrderId}/status`, { toStatus: "cancelado", reason: "Equivocada" }))
        .status,
    ).toBe(404)
    expect((await get("admin", `/clinical-forms/orders/${lockedOrderId}/print`)).status).toBe(423)
  })

  it("abierta para leer, Administración lee pero no escribe", async () => {
    await ownerDb.execute(
      sql`insert into "patient_record_opening" ("organization_id", "patient_id", "user_id", "reason", "expires_at")
          values ('org_a', ${lockedPatientId}, 'u-1', 'autoridad', now() + interval '1 hour')`,
    )
    try {
      expect((await get("admin", `/clinical-forms/orders?patientId=${lockedPatientId}`)).status).toBe(200)
      const order = { patientId: lockedPatientId, kind: "laboratorio", recipient: "Laboratorio", title: "Perfil lipídico" }
      const refused = await send("admin", "POST", "/clinical-forms/orders", order)
      expect(refused.status).toBe(423)
      expect(((await refused.json()) as { error: { message: string } }).error.message).toBe(
        "La historia está abierta solo para leer",
      )
    } finally {
      await ownerDb.execute(sql`delete from "patient_record_opening" where "patient_id" = ${lockedPatientId}`)
    }
  })
})

describe("citas, permisos de mensajes y vínculos de una persona bloqueada (S2)", () => {
  it("sus citas no se listan por su paciente ni se abren por su id", async () => {
    expect((await get("reception", `/appointments?patientId=${lockedPatientId}`)).status).toBe(404)
    expect((await get("reception", `/appointments/${lockedAppointmentId}`)).status).toBe(404)
    expect((await get("reception", `/appointments/${lockedAppointmentId}/context`)).status).toBe(404)
    expect((await send("reception", "PATCH", `/appointments/${lockedAppointmentId}`, { reason: "x" })).status).toBe(404)
    expect((await get("admin", `/appointments/${lockedAppointmentId}`)).status).toBe(423)
  })

  it("recepción no lee ni vuelve a encender sus mensajes", async () => {
    expect((await get("reception", `/agent/admin/people/${lockedPersonId}/permissions`)).status).toBe(404)
    expect(
      (await send("reception", "POST", `/agent/admin/people/${lockedPersonId}/permissions`, { tipo: "recordatorios", recibir: true }))
        .status,
    ).toBe(404)
    expect((await get("reception", `/agent/admin/people/${openPersonId}/permissions`)).status).toBe(200)
  })

  it("no se le pasa una cuenta ni se la vincula a otra ficha", async () => {
    const move = await send("reception", "POST", `/contacts/${openPersonId}/identities/${openIdentityId}/move`, {
      toContactId: lockedPersonId,
      reason: "Es su número",
    })
    expect(move.status).toBe(404)
    const link = await send("reception", "PUT", `/patients/${openPatientId}/contacts/${lockedPersonId}`, {
      relationship: "guardian",
    })
    expect(link.status).toBe(404)
  })

  it("no se averigua de quién es su ficha", async () => {
    expect((await get("reception", `/people/by-patient/${lockedPatientId}`)).status).toBe(404)
    expect((await get("reception", `/people/by-patient/${openPatientId}`)).status).toBe(200)
  })
})

describe("la historia bloqueada en las demás rutas y formas de pedirla", () => {
  const order = () => ({ patientId: lockedPatientId, kind: "laboratorio", recipient: "Laboratorio", title: "Perfil lipídico" })

  it("un cuerpo JSON enviado como texto, o sin decir su tipo, pasa igual por la guarda", async () => {
    for (const headers of [{ "content-type": "text/plain;charset=UTF-8" }, {} as Record<string, string>]) {
      const response = await buildApp("clinician").request("/clinical-forms/orders", {
        method: "POST",
        headers,
        body: JSON.stringify(order()),
      })
      expect(response.status).toBe(404)
    }
  })

  it("un id escrito sin guiones o en mayúsculas es la misma ficha", async () => {
    const bare = lockedPatientId.replaceAll("-", "")
    expect((await get("clinician", `/clinical-forms/orders?patientId=${bare}`)).status).toBe(404)
    expect((await get("clinician", `/clinical-forms/orders/${lockedOrderId.replaceAll("-", "")}/print`)).status).toBe(404)
    expect((await get("reception", `/patients/${lockedPatientId.toUpperCase()}`)).status).toBe(404)
    expect((await get("reception", `/appointments/${lockedAppointmentId.replaceAll("-", "")}`)).status).toBe(404)
  })

  it("«Su enlace» desde la ficha o la persona no responde por una historia bloqueada", async () => {
    expect((await get("reception", `/patients/${lockedPatientId}/personal-link/preview`)).status).toBe(404)
    expect((await send("reception", "POST", `/patients/${lockedPatientId}/personal-link/show`, {})).status).toBe(404)
    expect((await send("reception", "POST", `/patients/${lockedPatientId}/personal-link`, {})).status).toBe(404)
    expect((await send("reception", "POST", `/contacts/${lockedPersonId}/personal-link`, {})).status).toBe(404)
    expect((await send("reception", "POST", `/contacts/${lockedPersonId}/registration-links`, {})).status).toBe(404)
  })

  it("el contexto, la actividad y las notas del CRM no existen para una persona bloqueada", async () => {
    expect((await get("reception", `/crm/contacts/${lockedPersonId}/context`)).status).toBe(404)
    expect((await get("reception", `/crm/contacts/${lockedPersonId}/activity`)).status).toBe(404)
    expect((await send("reception", "POST", `/crm/contacts/${lockedPersonId}/notes`, { body: "Nota" })).status).toBe(404)
  })

  it("caja no abre su ticket ni ve su nombre en Cobros, aunque el ticket sigue sumando", async () => {
    expect((await get("cashier", `/finance/tickets/${lockedTicketId}`)).status).toBe(404)
    const list = await get("cashier", `/finance/tickets?branchId=${branchId}`)
    expect(list.status).toBe(200)
    type Page = { data: { data: Array<{ id: string; displayName: string; docNumber: string | null }> } }
    const rows = ((await list.json()) as Page).data.data
    const row = rows.find((item) => item.id === lockedTicketId)
    expect(row?.displayName).toBe("Historia bloqueada")
    expect(row?.docNumber).toBeNull()
    const searched = await get("cashier", `/finance/tickets?branchId=${branchId}&q=${encodeURIComponent("Lucía")}`)
    const found = ((await searched.json()) as Page).data.data.map((item) => item.id)
    expect(found).not.toContain(lockedTicketId)
  })

  it("el 404 de una historia bloqueada dice lo mismo que el de una que no existe", async () => {
    const missing = await get("reception", `/patients/${crypto.randomUUID()}`)
    const blocked = await get("reception", `/patients/${lockedPatientId}`)
    expect(blocked.status).toBe(404)
    expect(((await blocked.json()) as { error: { message: string } }).error.message).toBe(
      ((await missing.json()) as { error: { message: string } }).error.message,
    )
  })

  it("Administración llega a la historia bloqueada por el número de su ficha; los demás no", async () => {
    expect((await get("admin", `/people/by-patient/${lockedPatientId}`)).status).toBe(200)
    expect((await get("reception", `/people/by-patient/${lockedPatientId}`)).status).toBe(404)
  })

  it("quitar a una persona bloqueada de la ficha de otro sigue permitido", async () => {
    await ownerDb.execute(
      sql`insert into "patient_contact" ("organization_id", "patient_id", "contact_id", "relationship")
          values ('org_a', ${openPatientId}, ${lockedPersonId}, 'guardian')`,
    )
    const removed = await buildApp("reception").request(`/patients/${openPatientId}/contacts/${lockedPersonId}`, {
      method: "DELETE",
    })
    expect(removed.status).toBe(200)
  })
})

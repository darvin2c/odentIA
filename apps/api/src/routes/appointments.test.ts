// Testcontainers usa el socket Podman compartido en /mnt/wsl (ver rls.test.ts).
process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { createAppDb, createOwnerDb, type Db } from "@odentia/db"
import type { Storage } from "@odentia/services"
import { secretsKeyFromEnv } from "@odentia/services"
import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Context } from "hono"
import { Hono, type Next } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import { createAgendaRoute, createAppointmentsRoute } from "./appointments.js"
import type { CrmDeps } from "./helpers.js"

const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("ee".repeat(32))

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db

const storageStub: Storage = {
  putAvatar: async () => {
    throw new Error("no usado")
  },
  deleteByUrl: async () => {},
  putAttachment: async () => {
    throw new Error("no usado")
  },
  attachmentUrl: async () => {
    throw new Error("no usado")
  },
  deleteAttachment: async () => {},
  putPatientDocument: async () => {
    throw new Error("no usado")
  },
  putPatientAvatar: async () => {
    throw new Error("no usado")
  },
}

function stubOrg(role: string) {
  return async (c: Context, next: Next) => {
    c.set("orgId", "org_agenda_api")
    c.set("userId", "api-agenda-actor")
    c.set("memberRole", role)
    await next()
  }
}

function buildApp(role: string): Hono {
  const deps: CrmDeps = {
    db: appDb,
    secretsKey: KEY,
    storage: storageStub,
    validateExternal: false,
    webhookBaseUrl: "https://api.example.com",
  }
  const app = new Hono()
  app.use("*", stubOrg(role))
  app.route("/agenda", createAgendaRoute(deps))
  app.route("/appointments", createAppointmentsRoute(deps))
  return app
}

const ORG = "org_agenda_api"
const DENTIST = "api-agenda-dentist"
let branchId = ""
let chairId = ""
let patientId = ""

const START = "2026-10-12T14:00:00Z"
const FROM = "2026-10-12T05:00:00Z"
const TO = "2026-10-13T05:00:00Z"

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
  const uri = `postgres://dentalagent:dentalagent@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`
  ownerDb = createOwnerDb(uri)
  await migrate(ownerDb, { migrationsFolder: "../../packages/db/drizzle" })
  appDb = createAppDb(
    `postgres://dentalagent_app:dentalagent_app@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`,
  )
  await ownerDb.execute(sql`
    insert into "organization" ("id", "name", "slug", "created_at")
    values (${ORG}, 'Clínica Agenda API', 'agenda-api', now())`)
  const [row] = await ownerDb.execute<{ id: string }>(sql`
    insert into "branch" ("organization_id", "name", "timezone")
    values (${ORG}, 'Sede API', 'America/Lima') returning "id"`)
  branchId = row!.id
  await ownerDb.execute(sql`
    insert into "user" ("id", "name", "email") values
      ('api-agenda-actor', 'Recepción API', 'api-agenda-actor@example.test'),
      (${DENTIST}, 'Dra. API Uno', 'api-agenda-dentist@example.test')`)
  await ownerDb.execute(sql`
    insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values
      ('m-api-actor', ${ORG}, 'api-agenda-actor', 'owner', now()),
      ('m-api-dentist', ${ORG}, ${DENTIST}, 'member', now())`)
  const [paciente] = await ownerDb.execute<{ id: string }>(sql`
    insert into "patient" ("organization_id", "display_name", "patient_number")
    values (${ORG}, 'Paciente API', 9201) returning "id"`)
  patientId = paciente!.id
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

const json = { "content-type": "application/json" }

it("recursos: member lee; member no crea sillón, owner sí", async () => {
  const member = buildApp("member")
  const denied = await member.request("/agenda/chairs", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ branchId, name: "Sillón API" }),
  })
  expect(denied.status).toBe(403)

  const owner = buildApp("owner")
  const created = await owner.request("/agenda/chairs", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ branchId, name: "Sillón API" }),
  })
  expect(created.status).toBe(201)
  chairId = ((await created.json()) as { data: { id: string } }).data.id

  const resources = await member.request(`/agenda/resources?branchId=${branchId}`)
  expect(resources.status).toBe(200)
  const body = (await resources.json()) as {
    data: {
      timeZone: string
      professionals: Array<{ id: string; label: string }>
      chairs: Array<{ id: string; label: string }>
    }
  }
  expect(body.data.timeZone).toBe("America/Lima")
  expect(body.data.professionals.map((p) => p.id)).toContain(DENTIST)
  expect(body.data.chairs.map((c) => c.id)).toEqual([chairId])
})

it("cita: crear, listar con filtro, mover, conflicto 409 y cancelar", async () => {
  const owner = buildApp("owner")
  const created = await owner.request("/appointments", {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      branchId,
      patientId,
      dentistUserId: DENTIST,
      chairId,
      startsAt: START,
      durationMin: 45,
      reason: "Control",
    }),
  })
  expect(created.status).toBe(201)
  const cita = ((await created.json()) as { data: { id: string; version: number } }).data

  const list = await owner.request(
    `/appointments?from=${FROM}&to=${TO}&q=Paciente%20API&status=programada`,
  )
  expect(list.status).toBe(200)
  const listBody = (await list.json()) as { data: Array<{ id: string }> }
  expect(listBody.data.map((item) => item.id)).toContain(cita.id)

  // Solape del mismo sillón: la exclusión llega como 409 APPOINTMENT_CONFLICT.
  const overlap = await owner.request("/appointments", {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      branchId,
      patientId,
      dentistUserId: DENTIST,
      chairId,
      startsAt: "2026-10-12T14:30:00Z",
      durationMin: 30,
    }),
  })
  expect(overlap.status).toBe(409)
  expect(await overlap.json()).toMatchObject({ error: { code: "APPOINTMENT_CONFLICT" } })

  const moved = await owner.request(`/appointments/${cita.id}/move`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      expectedVersion: cita.version,
      startsAt: "2026-10-12T16:00:00Z",
    }),
  })
  expect(moved.status).toBe(200)
  const movedBody = (await moved.json()) as {
    data: { startsAt: string; endsAt: string; version: number }
  }
  expect(movedBody.data.endsAt).toBe("2026-10-12T16:45:00.000Z")
  expect(movedBody.data.version).toBe(2)

  // Versión vieja: 409 STALE_VERSION.
  const stale = await owner.request(`/appointments/${cita.id}/move`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      expectedVersion: 1,
      startsAt: "2026-10-12T17:00:00Z",
    }),
  })
  expect(stale.status).toBe(409)
  expect(await stale.json()).toMatchObject({ error: { code: "STALE_VERSION" } })

  const cancelled = await owner.request(`/appointments/${cita.id}/status`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ status: "cancelada" }),
  })
  expect(cancelled.status).toBe(200)

  // El rango liberado admite una nueva cita.
  const reuse = await owner.request("/appointments", {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      branchId,
      patientId,
      dentistUserId: DENTIST,
      chairId,
      startsAt: "2026-10-12T16:00:00Z",
      durationMin: 30,
    }),
  })
  expect(reuse.status).toBe(201)
})

it("valida el query y el body con 400", async () => {
  const owner = buildApp("owner")
  const badQuery = await owner.request("/appointments?from=nope&to=nope")
  expect(badQuery.status).toBe(400)
  const badBody = await owner.request("/appointments", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ patientId: "x" }),
  })
  expect(badBody.status).toBe(400)
})

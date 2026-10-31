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
const PROFESSIONAL = "api-agenda-professional"
let branchId = ""
let roomId = ""
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
      (${PROFESSIONAL}, 'Dra. API Uno', 'api-agenda-professional@example.test')`)
  await ownerDb.execute(sql`
    insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values
      ('m-api-actor', ${ORG}, 'api-agenda-actor', 'owner', now()),
      ('m-api-professional', ${ORG}, ${PROFESSIONAL}, 'member', now())`)
  const [paciente] = await ownerDb.execute<{ id: string }>(sql`
    with pp as (insert into "contact" ("organization_id", "display_name") values (${ORG}, 'Paciente API') returning "id")
    insert into "patient" ("organization_id", "person_id", "patient_number")
    select ${ORG}, pp."id", 9201 from pp returning "id"`)
  patientId = paciente!.id
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

const json = { "content-type": "application/json" }

it("recursos: reception lee; member no crea unidad dental ni lee agenda, owner sí", async () => {
  const member = buildApp("member")
  const denied = await member.request("/agenda/rooms", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ branchId, name: "Unidad dental API" }),
  })
  expect(denied.status).toBe(403)
  const memberReads = await member.request(`/agenda/resources?branchId=${branchId}`)
  expect(memberReads.status).toBe(403)
  expect((await member.request(`/agenda/hours?branchId=${branchId}`)).status).toBe(403)

  const owner = buildApp("owner")
  const created = await owner.request("/agenda/rooms", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ branchId, name: "Unidad dental API" }),
  })
  expect(created.status).toBe(201)
  roomId = ((await created.json()) as { data: { id: string } }).data.id

  const reception = buildApp("reception")
  const resources = await reception.request(`/agenda/resources?branchId=${branchId}`)
  expect(resources.status).toBe(200)
  const body = (await resources.json()) as {
    data: {
      timeZone: string
      professionals: Array<{ id: string; label: string }>
      rooms: Array<{ id: string; label: string }>
    }
  }
  expect(body.data.timeZone).toBe("America/Lima")
  // El horario de atención de la sede: el mismo que dice el agente, sin escribirse aparte (ADR 0118).
  const hours = await reception.request(`/agenda/hours?branchId=${branchId}`)
  expect(hours.status).toBe(200)
  expect(((await hours.json()) as { data: { id: string; week: unknown[] } }).data).toMatchObject({ id: branchId, week: expect.any(Array) })
  expect((await reception.request("/agenda/hours?branchId=otra")).status).toBe(400)
  expect(body.data.professionals.map((p) => p.id)).toContain(PROFESSIONAL)
  expect(body.data.rooms.map((c) => c.id)).toEqual([roomId])
})

it("cita: crear, listar con filtro, mover, conflicto 409 y cancelar", async () => {
  const owner = buildApp("owner")
  // Horario explícito del profesional (lunes 09:00–13:00 y 14:00–18:00 Lima).
  const schedule = await owner.request("/agenda/schedules", {
    method: "PUT",
    headers: json,
    body: JSON.stringify({
      branchId,
      professionalUserId: PROFESSIONAL,
      rules: [
        { weekday: 1, startMin: 540, endMin: 780 },
        { weekday: 1, startMin: 840, endMin: 1080 },
      ],
    }),
  })
  expect(schedule.status).toBe(200)
  const created = await owner.request("/appointments", {
    method: "POST",
    body: JSON.stringify({
      branchId,
      patientId,
      professionalUserId: PROFESSIONAL,
      roomId,
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

  // Solape de la misma unidad dental: la exclusión llega como 409 APPOINTMENT_CONFLICT.
  const overlap = await owner.request("/appointments", {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      branchId,
      patientId,
      professionalUserId: PROFESSIONAL,
      roomId,
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
      professionalUserId: PROFESSIONAL,
      roomId,
      startsAt: "2026-10-12T16:00:00Z",
      durationMin: 30,
    }),
  })
  expect(reuse.status).toBe(201)
})

it("el cajón de la cita: a quién se le escribe y de dónde salió, para quien ve la agenda", async () => {
  const owner = buildApp("owner")
  const created = await owner.request("/appointments", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ branchId, patientId, professionalUserId: PROFESSIONAL, roomId, startsAt: "2026-10-12T15:00:00Z", durationMin: 15, outsideSchedule: true }),
  })
  expect(created.status).toBe(201)
  const cita = ((await created.json()) as { data: { id: string; notice?: unknown } }).data
  // Sin «Recordar la cita» prendida nadie le avisa: lo dice la respuesta.
  expect(cita.notice).toEqual({ queued: false })
  const seen = await buildApp("reception").request(`/appointments/${cita.id}/context`)
  expect(seen.status).toBe(200)
  const context = ((await seen.json()) as { data: { person: { name: string; relationship: string } | null; origin: { source: string; conversationId: string | null }; confirmation: unknown } }).data
  expect(context.person).toMatchObject({ name: "Paciente API", relationship: "self" })
  expect(context.origin).toMatchObject({ source: "recepcion", conversationId: null })
  expect(context.confirmation).toBeNull()
  // «Faltan datos para atenderla» lo calcula el servidor con la regla de la
  // página (aquí, sin fecha de nacimiento ni apellidos) y solo lo recibe quien
  // edita sus datos: el odontólogo ve la cita sin el aviso.
  const missing = (context as unknown as { missingData: Array<{ key: string }> | null }).missingData
  expect(missing?.map((datum) => datum.key)).toContain("birthDate")
  const forProfessional = await buildApp("clinician").request(`/appointments/${cita.id}/context`)
  expect(((await forProfessional.json()) as { data: { missingData: unknown } }).data.missingData).toBeNull()
  // Caja no ve la agenda: tampoco lo que dice la cita de la persona.
  expect((await buildApp("cashier").request(`/appointments/${cita.id}/context`)).status).toBe(403)
  await owner.request(`/appointments/${cita.id}/status`, { method: "POST", headers: json, body: JSON.stringify({ status: "cancelada" }) })
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

it("unidades dentales: administrarlas exige configuración; desactivada sale de la agenda y sigue en la lista", async () => {
  const owner = buildApp("owner")
  const reception = buildApp("reception")
  const patch = (app: Hono, id: string, body: unknown) =>
    app.request(`/agenda/rooms/${id}`, { method: "PATCH", headers: json, body: JSON.stringify(body) })

  // Recepción reserva, pero no ve la lista de administración ni cambia una unidad dental.
  expect((await reception.request(`/agenda/rooms?branchId=${branchId}`)).status).toBe(403)
  expect((await patch(reception, roomId, { name: "Otro nombre" })).status).toBe(403)
  expect((await patch(reception, roomId, { isActive: false })).status).toBe(403)

  expect((await owner.request("/agenda/rooms")).status).toBe(400)
  expect((await patch(owner, roomId, {})).status).toBe(400)
  expect((await patch(owner, roomId, { name: "  " })).status).toBe(400)
  expect((await patch(owner, roomId, { color: "rojo" })).status).toBe(400)
  expect((await patch(owner, "no-es-un-id", { name: "Unidad dental" })).status).toBe(404)
  expect((await patch(owner, crypto.randomUUID(), { name: "Unidad dental" })).status).toBe(404)

  const renamed = await patch(owner, roomId, { name: "Unidad dental Uno" })
  expect(renamed.status).toBe(200)
  expect(await renamed.json()).toEqual({ data: { id: roomId, name: "Unidad dental Uno", isActive: true } })

  expect((await patch(owner, roomId, { isActive: false })).status).toBe(200)
  const resources = await reception.request(`/agenda/resources?branchId=${branchId}`)
  expect(((await resources.json()) as { data: { rooms: unknown[] } }).data.rooms).toEqual([])
  const listed = await owner.request(`/agenda/rooms?branchId=${branchId}`)
  expect(listed.status).toBe(200)
  const rooms = ((await listed.json()) as { data: Array<{ id: string; name: string; isActive: boolean }> }).data
  expect(rooms).toMatchObject([{ id: roomId, name: "Unidad dental Uno", isActive: false }])

  expect((await patch(owner, roomId, { isActive: true })).status).toBe(200)
  const again = await reception.request(`/agenda/resources?branchId=${branchId}`)
  expect(((await again.json()) as { data: { rooms: Array<{ label: string }> } }).data.rooms).toEqual([
    { id: roomId, label: "Unidad dental Uno" },
  ])
})

it("«Llegó»: lo marcan recepción y el odontólogo, caja no; el estado no se cambia por PATCH", async () => {
  const owner = buildApp("owner")
  // Una cita de hoy, a la hora actual: llegar solo vale para las de hoy.
  const startsAt = new Date(Date.now() + 2 * 60_000).toISOString()
  const created = await owner.request("/appointments", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ branchId, patientId, professionalUserId: PROFESSIONAL, roomId, startsAt, durationMin: 15, outsideSchedule: true }),
  })
  expect(created.status).toBe(201)
  const cita = ((await created.json()) as { data: { id: string; version: number } }).data
  const arrive = (role: string, arrived: boolean) =>
    buildApp(role).request(`/appointments/${cita.id}/arrival`, { method: "POST", headers: json, body: JSON.stringify({ arrived }) })

  expect((await arrive("cashier", true)).status).toBe(403)
  const arrived = await arrive("reception", true)
  expect(arrived.status).toBe(200)
  expect(((await arrived.json()) as { data: { visit: string; status: string } }).data).toMatchObject({ visit: "llego", status: "confirmada" })
  // Con la persona en la clínica, «No vino» se rechaza en palabras.
  const noShow = await owner.request(`/appointments/${cita.id}/status`, { method: "POST", headers: json, body: JSON.stringify({ status: "no_asistio" }) })
  expect(noShow.status).toBe(409)
  expect(await noShow.json()).toMatchObject({ error: { code: "APPOINTMENT_ARRIVED" } })
  // «Atendida» solo la pone el cierre de la atención.
  const attended = await owner.request(`/appointments/${cita.id}/status`, { method: "POST", headers: json, body: JSON.stringify({ status: "atendida" }) })
  expect(await attended.json()).toMatchObject({ error: { code: "ATTENDED_BY_ENCOUNTER" } })
  const viaPatch = await owner.request(`/appointments/${cita.id}`, {
    method: "PATCH",
    headers: json,
    body: JSON.stringify({ expectedVersion: 2, status: "atendida" }),
  })
  expect(viaPatch.status).toBe(400)
  expect((await arrive("clinician", false)).status).toBe(200)
  expect((await arrive("reception", "si" as unknown as boolean)).status).toBe(400)
  await owner.request(`/appointments/${cita.id}/status`, { method: "POST", headers: json, body: JSON.stringify({ status: "cancelada" }) })
})

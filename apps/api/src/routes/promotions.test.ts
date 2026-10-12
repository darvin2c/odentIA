process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { createAppDb, createOwnerDb, type Db } from "@odentia/db"
import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Context } from "hono"
import { Hono, type Next } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import { createPromotionsRoute } from "./promotions.js"

const IMAGE = "dentalagent-postgres:18.6"
const ORG = "org_promo"
const OTHER_ORG = "org_promo_otra"
const SERVICE = "11111111-1111-4111-8111-111111111111"

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db

function buildApp(role: string, orgId = ORG): Hono {
  const app = new Hono()
  app.use("*", async (c: Context, next: Next) => {
    c.set("orgId", orgId)
    c.set("userId", "u-promo")
    c.set("memberRole", role)
    await next()
  })
  app.route("/promotions", createPromotionsRoute({ db: appDb }))
  return app
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
  const uri = `postgres://dentalagent:dentalagent@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`
  ownerDb = createOwnerDb(uri)
  await migrate(ownerDb, { migrationsFolder: "../../packages/db/drizzle" })
  appDb = createAppDb(
    `postgres://dentalagent_app:dentalagent_app@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`,
  )
  await ownerDb.execute(sql`
    insert into "organization" ("id", "name", "slug", "created_at") values
      (${ORG}, 'Clínica Promo', 'promo', now()),
      (${OTHER_ORG}, 'Clínica Otra', 'promo-otra', now())`)
  // Región explícita: la moneda nunca sale de un valor por defecto.
  await ownerDb.execute(sql`
    insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale") values
      (${ORG}, 'Clínica Promo', 'CL', 'CLP', 'America/Santiago', 'es-CL'),
      (${OTHER_ORG}, 'Clínica Otra', 'CL', 'CLP', 'America/Santiago', 'es-CL')`)
  await ownerDb.execute(
    sql`insert into "user" ("id", "name", "email") values ('u-promo', 'Admin', 'promo@example.test')`,
  )
  await ownerDb.execute(sql`
    insert into "service_catalog"
      ("id", "organization_id", "source", "name", "specialty", "scope", "price_cents", "currency", "billing_mode", "is_active")
    values (${SERVICE}, ${ORG}, 'custom', 'Limpieza', 'prevencion', 'general', 35000, 'CLP', 'treatment', true)`)
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

interface PromotionBody {
  id: string
  name: string
  state: string
  metrics: null | {
    promotionId: string
    uses: number
    chargedByCurrency: Array<{ currency: string; cents: number }>
    averageByCurrency: Array<{ currency: string; cents: number }>
  }
  items: Array<{ serviceId: string; mode: string; priceCents: number; currency: string }>
}

const DAY = 86_400_000

async function create(name: string, startsAt: Date, endsAt: Date | null): Promise<string> {
  const res = await buildApp("owner").request("/promotions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt ? endsAt.toISOString() : null,
      items: [{ serviceId: SERVICE, mode: "fixed", priceCents: 25000 }],
    }),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { data: { id: string } }).data.id
}

async function list(role: string, scope: "vigentes" | "todas", orgId = ORG) {
  const res = await buildApp(role, orgId).request(`/promotions?scope=${scope}`, { method: "GET" })
  return { status: res.status, body: (await res.json()) as { data: PromotionBody[] } }
}

async function detail(role: string, id: string, orgId = ORG) {
  const res = await buildApp(role, orgId).request(`/promotions/${id}`, { method: "GET" })
  return { status: res.status, body: (await res.json()) as { data: PromotionBody } }
}

let vigenteId = ""
let programadaId = ""
let terminadaId = ""

it("promociones: la lista dice en qué momento está cada una", async () => {
  const now = Date.now()
  vigenteId = await create("Vigente sin fin", new Date(now - DAY), null)
  programadaId = await create("Para el mes que viene", new Date(now + 30 * DAY), null)
  terminadaId = await create("Ya terminó", new Date(now - 10 * DAY), new Date(now - 5 * DAY))

  const todas = await list("owner", "todas")
  expect(todas.status).toBe(200)
  const stateOf = (id: string) => todas.body.data.find((row) => row.id === id)?.state
  expect(stateOf(vigenteId)).toBe("vigente")
  expect(stateOf(programadaId)).toBe("programada")
  expect(stateOf(terminadaId)).toBe("terminada")

  // «vigentes» es lo que caja y presupuestos ofrecen: solo lo que rige ahora.
  const vigentes = await list("owner", "vigentes")
  expect(vigentes.body.data.map((row) => row.id)).toEqual([vigenteId])
  expect(vigentes.body.data[0]?.state).toBe("vigente")

  for (const [id, state] of [
    [vigenteId, "vigente"],
    [programadaId, "programada"],
    [terminadaId, "terminada"],
  ] as const) {
    const one = await detail("owner", id)
    expect(one.status).toBe(200)
    expect(one.body.data.state).toBe(state)
  }
})

it("promociones: terminarla hoy la pasa a terminada", async () => {
  const id = await create("Se termina hoy", new Date(Date.now() - DAY), null)
  expect((await detail("owner", id)).body.data.state).toBe("vigente")
  const ended = await buildApp("owner").request(`/promotions/${id}/end`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  })
  expect(ended.status).toBe(200)
  expect((await detail("owner", id)).body.data.state).toBe("terminada")
  expect((await list("owner", "vigentes")).body.data.map((row) => row.id)).not.toContain(id)
})

it("promociones: el uso y lo cobrado llegan solo a quien ve dinero", async () => {
  // Administración (settings.read) y caja (finance.read) reciben las métricas.
  for (const role of ["owner", "admin", "cashier"]) {
    const todas = await list(role, "todas")
    expect(todas.status).toBe(200)
    expect(todas.body.data.length).toBeGreaterThanOrEqual(3)
    for (const row of todas.body.data) {
      expect(row.metrics).toEqual({
        promotionId: row.id,
        uses: 0,
        chargedByCurrency: [],
        averageByCurrency: [],
      })
    }
    const one = await detail(role, vigenteId)
    expect(one.body.data.metrics).toMatchObject({ promotionId: vigenteId, uses: 0 })
  }

  // Recepción y odontología leen la promoción y sus precios, no su caja.
  for (const role of ["reception", "dentist"]) {
    const todas = await list(role, "todas")
    expect(todas.status).toBe(200)
    expect(todas.body.data.length).toBeGreaterThanOrEqual(3)
    for (const row of todas.body.data) {
      expect(row.metrics).toBeNull()
      expect(row.state).toMatch(/^(programada|vigente|terminada)$/)
      expect(row.items[0]).toMatchObject({ serviceId: SERVICE, priceCents: 25000, currency: "CLP" })
    }
    const one = await detail(role, vigenteId)
    expect(one.status).toBe(200)
    expect(one.body.data.metrics).toBeNull()
    expect(one.body.data.state).toBe("vigente")
  }
})

it("promociones: sin permiso de tarifario no se leen, ni las de otra clínica", async () => {
  expect((await list("member", "todas")).status).toBe(403)
  expect((await detail("member", vigenteId)).status).toBe(403)
  expect((await list("owner", "todas", OTHER_ORG)).body.data).toEqual([])
  expect((await detail("owner", vigenteId, OTHER_ORG)).status).toBe(404)
  // Solo administración crea: caja lee, no configura.
  const denied = await buildApp("cashier").request("/promotions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "No debería",
      startsAt: new Date().toISOString(),
      items: [{ serviceId: SERVICE, mode: "fixed", priceCents: 1 }],
    }),
  })
  expect(denied.status).toBe(403)
})

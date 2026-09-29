process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { createAppDb, createOwnerDb, type Db, seedProcedureCodes } from "@odentia/db"
import { secretsKeyFromEnv } from "@odentia/services"
import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Context } from "hono"
import { Hono, type Next } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import type { CrmDeps } from "./helpers.js"
import { createServicesRoute } from "./services.js"

const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("ee".repeat(32))

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db

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
function stubOrg(role: string, orgId = "org_a") {
  return async (c: Context, next: Next) => {
    c.set("orgId", orgId)
    c.set("userId", "u-1")
    c.set("memberRole", role)
    await next()
  }
}

function buildApp(role: string, orgId = "org_a"): Hono {
  const deps: CrmDeps = {
    db: appDb,
    secretsKey: KEY,
    storage: storageStub,
    validateExternal: false,
    webhookBaseUrl: "https://api.example.com",
  }
  const app = new Hono()
  app.use("*", stubOrg(role, orgId))
  app.route("/services", createServicesRoute(deps))
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
  await ownerDb.execute(
    sql`insert into "organization" ("id", "name", "slug", "created_at") values ('org_a', 'Clínica', 'norte', now())`,
  )
  await ownerDb.execute(
    sql`insert into "organization" ("id", "name", "slug", "created_at") values ('org_b', 'Clínica Sur', 'sur', now())`,
  )
  await ownerDb.execute(
    sql`insert into "user" ("id", "name", "email") values ('u-1', 'Doctora', 'doc@test.dev') on conflict do nothing`,
  )
  // Catálogo oficial real (mismo seed que dev/CI): la biblioteca y la
  // proyección 1:1 plantilla↔código son prerrequisito de /services/templates
  // y de las ofertas derivadas de plantilla.
  await seedProcedureCodes(ownerDb)
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

interface ServiceItem {
  id: string
  templateId: string | null
  source: string
  code: string | null
  name: string
  specialty: string | null
  scope: string | null
  priceCents: number | null
  currency: string
  durationMin: number | null
  isActive: boolean
}

async function getJson(app: Hono, path: string): Promise<Response> {
  return app.request(path, { method: "GET" })
}

// Plantillas de la biblioteca oficial vigente (RM-550-2023-MINSA): el ámbito
// y la especialidad se heredan del catálogo 1:1, no de un fixture propio.
const PREVENCION_KEY = "cpms:RM-550-2023-MINSA:D1110" // Profilaxis dental
const RESTAURADORA_KEY = "cpms:RM-550-2023-MINSA:D2391" // Resina, 1 superficie

async function templateIdByKey(key: string): Promise<string> {
  const rows = (await ownerDb.execute(
    sql`select "id" from "treatment_template" where "key" = ${key}`,
  )) as unknown as Array<{ id: string }>
  if (!rows[0]) throw new Error(`template ausente: ${key}`)
  return rows[0].id
}

it("services: leer un tarifario vacío no crea ofertas (recepción; member 403)", async () => {
  const app = buildApp("reception")
  const res = await getJson(app, "/services")
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ data: [], nextCursor: null })
  const legacy = await getJson(app, "/services?state=legacy")
  expect(await legacy.json()).toEqual({ data: [], nextCursor: null })
  const member = buildApp("member")
  expect((await getJson(member, "/services")).status).toBe(403)
})

it("services: biblioteca global sin precios y con filtro (recepción; member 403)", async () => {
  const app = buildApp("reception")
  const res = await getJson(app, "/services/templates?specialty=prevencion")
  expect(res.status).toBe(200)
  const body = (await res.json()) as { data: Array<{ key: string }> }
  expect(body.data.map((row) => row.key)).toContain(PREVENCION_KEY)
  expect(body.data.every((row) => !("priceCents" in row))).toBe(true)
  const member = buildApp("member")
  expect((await getJson(member, "/services/templates?specialty=prevencion")).status).toBe(403)
})

it("services: POST crea y PATCH edita con owner/admin; member 403", async () => {
  const owner = buildApp("owner")
  const created = await owner.request("/services", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: "car-01",
      name: "Carilla propia",
      specialty: "estetica",
      scope: "tooth",
      priceCents: 150000,
    }),
  })
  expect(created.status).toBe(201)
  const createdBody = (await created.json()) as { data: ServiceItem }
  expect(createdBody.data.code).toBe("CAR-01")
  expect(createdBody.data.source).toBe("custom")
  expect(createdBody.data.currency).toBe("PEN")

  const patched = await owner.request(`/services/${createdBody.data.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ priceCents: 160000 }),
  })
  expect(patched.status).toBe(200)
  expect(((await patched.json()) as { data: ServiceItem }).data.priceCents).toBe(160000)

  const member = buildApp("member")
  const deniedCreate = await member.request("/services", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "X", specialty: "estetica", scope: "tooth" }),
  })
  expect(deniedCreate.status).toBe(403)
  const deniedPatch = await member.request(`/services/${createdBody.data.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Intruso" }),
  })
  expect(deniedPatch.status).toBe(403)
})

it("services: oferta desde plantilla hereda especialidad y ámbito", async () => {
  const app = buildApp("owner")
  const tpl = await templateIdByKey(PREVENCION_KEY)
  const res = await app.request("/services", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ templateId: tpl, priceCents: 12000 }),
  })
  expect(res.status).toBe(201)
  const body = (await res.json()) as { data: ServiceItem }
  expect(body.data.source).toBe("template")
  expect(body.data.specialty).toBe("prevencion")
  expect(body.data.scope).toBe("general")
  expect(body.data.name).toBe("Profilaxis dental")

  const contradict = await app.request(`/services/${body.data.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "tooth" }),
  })
  expect(contradict.status).toBe(400)
})

it("services: incorporar otra vez una plantilla conserva su tarifa configurada", async () => {
  const app = buildApp("owner")
  const tpl = await templateIdByKey(RESTAURADORA_KEY)
  const first = await app.request("/services/from-templates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ templateIds: [tpl] }),
  })
  expect(first.status).toBe(201)
  const firstBody = (await first.json()) as {
    data: { created: ServiceItem[]; existing: ServiceItem[] }
  }
  expect(firstBody.data.created).toHaveLength(1)

  const withPrice = await app.request(`/services/${firstBody.data.created[0]?.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ priceCents: 18000 }),
  })
  expect(withPrice.status).toBe(200)

  const second = await app.request("/services/from-templates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ templateIds: [tpl] }),
  })
  expect(second.status).toBe(201)
  const secondBody = (await second.json()) as {
    data: { created: ServiceItem[]; existing: ServiceItem[] }
  }
  expect(secondBody.data.created).toHaveLength(0)
  expect(secondBody.data.existing).toHaveLength(1)
  expect(secondBody.data.existing[0]?.priceCents).toBe(18000)
})

it("services: state filtra activas e inactivas", async () => {
  const app = buildApp("owner")
  const created = await app.request("/services", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Temporal",
      specialty: "cirugia",
      scope: "general",
      priceCents: 0,
    }),
  })
  expect(created.status).toBe(201)
  const id = ((await created.json()) as { data: ServiceItem }).data.id

  const off = await app.request(`/services/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ isActive: false }),
  })
  expect(off.status).toBe(200)

  const active = (await (await getJson(app, "/services")).json()) as { data: ServiceItem[] }
  expect(active.data.map((s) => s.id)).not.toContain(id)
  const inactive = (await (await getJson(app, "/services?state=inactive")).json()) as {
    data: ServiceItem[]
  }
  expect(inactive.data.map((s) => s.id)).toContain(id)
})

it("services: aislamiento por org y moneda desde el perfil", async () => {
  const app = buildApp("owner")
  await ownerDb.execute(
    sql`insert into "org_profile" ("organization_id", "legal_name", "currency") values ('org_b', 'Sur', 'USD')
      on conflict ("organization_id") do update set "currency" = 'USD'`,
  )
  const other = buildApp("owner", "org_b")
  const created = await other.request("/services", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Oferta sur",
      specialty: "cirugia",
      scope: "general",
      priceCents: 5000,
    }),
  })
  expect(created.status).toBe(201)
  expect(((await created.json()) as { data: ServiceItem }).data.currency).toBe("USD")

  const mine = (await (await getJson(app, "/services?state=inactive")).json()) as {
    data: ServiceItem[]
  }
  const foreignId =
    ((await (await getJson(other, "/services")).json()) as { data: ServiceItem[] }).data[0]?.id ??
    ""
  expect(mine.data.map((s) => s.id)).not.toContain(foreignId)
  const cross = await app.request(`/services/${foreignId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Intruso" }),
  })
  expect(cross.status).toBe(404)
})

it("services: código duplicado responde 409 DUPLICATE_CODE", async () => {
  const app = buildApp("owner")
  const payload = {
    code: "dup",
    name: "Duplicado",
    specialty: "cirugia",
    scope: "general",
    priceCents: 100,
  }
  const first = await app.request("/services", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
  expect(first.status).toBe(201)
  const second = await app.request("/services", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
  expect(second.status).toBe(409)
  expect(((await second.json()) as { error: { code: string } }).error.code).toBe("DUPLICATE_CODE")
})

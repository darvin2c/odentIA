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
  // Clínica nueva (con su región configurada y sin servicios) y otra que aún
  // no configuró su región: sin perfil no se pone precio a nada.
  await ownerDb.execute(
    sql`insert into "organization" ("id", "name", "slug", "created_at") values ('org_c', 'Clínica Nueva', 'nueva', now())`,
  )
  await ownerDb.execute(
    sql`insert into "organization" ("id", "name", "slug", "created_at") values ('org_d', 'Clínica sin región', 'sin-region', now())`,
  )
  // La moneda sale del perfil de cada clínica, nunca de un valor por defecto.
  await ownerDb.execute(
    sql`insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale")
      values ('org_a', 'Norte', 'PE', 'PEN', 'America/Lima', 'es-PE'),
             ('org_c', 'Nueva', 'CL', 'CLP', 'America/Santiago', 'es-CL')`,
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
    body: JSON.stringify({ items: [{ templateId: tpl, priceCents: 12000, billingMode: "treatment" }] }),
  })
  expect(first.status).toBe(201)
  const firstBody = (await first.json()) as {
    data: { created: ServiceItem[]; existing: ServiceItem[] }
  }
  expect(firstBody.data.created).toHaveLength(1)
  expect(firstBody.data.created[0]).toMatchObject({ priceCents: 12000, isActive: true })

  const withPrice = await app.request(`/services/${firstBody.data.created[0]?.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ priceCents: 18000 }),
  })
  expect(withPrice.status).toBe(200)

  const second = await app.request("/services/from-templates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: [{ templateId: tpl, priceCents: 9000, billingMode: "treatment" }] }),
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
    sql`insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale") values ('org_b', 'Sur', 'PE', 'USD', 'America/Lima', 'es-PE')
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

interface MostUsedConcept {
  key: string
  label: string
  templates: Array<{ id: string; key: string; name: string; codings: Array<{ code: string }> }>
}

async function mostUsed(app: Hono): Promise<MostUsedConcept[]> {
  const res = await getJson(app, "/services/most-used")
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: MostUsedConcept[] }).data
}

it("services: «Más usados» sugiere por concepto a una clínica sin servicios", async () => {
  const app = buildApp("owner", "org_c")
  expect(await (await getJson(app, "/services")).json()).toEqual({ data: [], nextCursor: null })

  const concepts = await mostUsed(app)
  // Conceptos generales, no códigos: la biblioteca disponible los resuelve.
  expect(concepts.map((concept) => concept.key)).toEqual(
    expect.arrayContaining([
      "consulta",
      "radiografia",
      "profilaxis",
      "resina",
      "endodoncia",
      "exodoncia",
      "corona",
    ]),
  )
  for (const concept of concepts) {
    expect(concept.label).not.toBe("")
    expect(concept.templates.length).toBeGreaterThanOrEqual(1)
    expect(concept.templates.length).toBeLessThanOrEqual(3)
    // Sin precios propuestos y con su código oficial único.
    expect(concept.templates.every((tpl) => !("priceCents" in tpl))).toBe(true)
    expect(concept.templates.every((tpl) => tpl.codings.length === 1)).toBe(true)
  }
  const ids = concepts.flatMap((concept) => concept.templates.map((tpl) => tpl.id))
  expect(new Set(ids).size).toBe(ids.length)
  const profilaxis = concepts.find((concept) => concept.key === "profilaxis")
  expect(profilaxis?.templates.map((tpl) => tpl.key)).toContain(PREVENCION_KEY)
  // «Limpieza» no trae la limpieza de una prótesis: el concepto acota su área.
  expect(profilaxis?.templates.every((tpl) => !/pr[oó]tesis/i.test(tpl.name))).toBe(true)

  // Lo lee quien ve el tarifario; el mínimo seguro no.
  expect((await getJson(buildApp("reception", "org_c"), "/services/most-used")).status).toBe(200)
  expect((await getJson(buildApp("member", "org_c"), "/services/most-used")).status).toBe(403)
  expect((await getJson(app, "/services/most-used?perConcept=0")).status).toBe(400)
})

it("services: lo incorporado no se repite en «Más usados» y guarda nombre, precio y cobro", async () => {
  const app = buildApp("owner", "org_c")
  const before = await mostUsed(app)
  const profilaxisId = await templateIdByKey(PREVENCION_KEY)
  const resina = before.find((concept) => concept.key === "resina")
  const resinaIds = resina?.templates.map((tpl) => tpl.id) ?? []
  expect(resinaIds.length).toBeGreaterThan(0)

  const saved = await app.request("/services/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      items: [
        {
          kind: "template",
          templateId: profilaxisId,
          name: "Limpieza dental",
          priceCents: 35000,
          billingMode: "treatment",
          durationMin: 30,
        },
        ...resinaIds.map((templateId) => ({ kind: "template", templateId, priceCents: 45000 })),
        {
          kind: "custom",
          name: "Control de ortodoncia",
          specialty: "ortodoncia",
          scope: "general",
          priceCents: 25000,
          billingMode: "session",
          durationMin: 30,
        },
      ],
    }),
  })
  expect(saved.status).toBe(201)
  const body = (await saved.json()) as {
    data: { created: Array<ServiceItem & { billingMode: string }>; existing: ServiceItem[] }
  }
  expect(body.data.created).toHaveLength(resinaIds.length + 2)
  expect(body.data.existing).toHaveLength(0)
  // Todo queda activo y en la moneda de la clínica.
  expect(body.data.created.every((row) => row.isActive && row.currency === "CLP")).toBe(true)
  const limpieza = body.data.created.find((row) => row.templateId === profilaxisId)
  expect(limpieza).toMatchObject({
    name: "Limpieza dental",
    source: "template",
    specialty: "prevencion",
    priceCents: 35000,
    durationMin: 30,
  })
  const propio = body.data.created.find((row) => row.source === "custom")
  expect(propio).toMatchObject({
    name: "Control de ortodoncia",
    templateId: null,
    billingMode: "session",
    priceCents: 25000,
  })

  const after = await mostUsed(app)
  const afterIds = after.flatMap((concept) => concept.templates.map((tpl) => tpl.id))
  expect(afterIds).not.toContain(profilaxisId)
  for (const id of resinaIds) expect(afterIds).not.toContain(id)
  // El concepto sigue ofreciendo lo que la biblioteca aún tiene sin incorporar.
  expect(after.find((concept) => concept.key === "resina")?.templates.length ?? 0).toBeGreaterThan(0)
  // Lo incorporado es de cada organización: otra clínica sigue viendo lo que
  // ella misma no tiene, aunque esta ya lo haya agregado.
  const otherApp = buildApp("owner", "org_a")
  const ownedByOther = new Set<string | null>()
  for (const state of ["active", "inactive"]) {
    const page = (await (await getJson(otherApp, `/services?state=${state}&limit=100`)).json()) as {
      data: ServiceItem[]
    }
    for (const row of page.data) ownedByOther.add(row.templateId)
  }
  const otherIds = (await mostUsed(otherApp)).flatMap((concept) =>
    concept.templates.map((tpl) => tpl.id),
  )
  const stillOffered = resinaIds.filter((id) => !ownedByOther.has(id))
  expect(stillOffered.length).toBeGreaterThan(0)
  expect(otherIds).toEqual(expect.arrayContaining(stillOffered))
  for (const id of otherIds) expect(ownedByOther.has(id)).toBe(false)
})

it("services: la carga rápida es todo o nada", async () => {
  const app = buildApp("owner", "org_c")
  const before = ((await (await getJson(app, "/services")).json()) as { data: ServiceItem[] }).data
  const corona = (await mostUsed(app)).find((concept) => concept.key === "corona")
  const templateId = corona?.templates[0]?.id
  expect(templateId).toBeDefined()
  const failed = await app.request("/services/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      items: [
        { kind: "template", templateId, priceCents: 90000 },
        { kind: "custom", name: "Sin área", specialty: "no-existe", scope: "general", priceCents: 1 },
      ],
    }),
  })
  expect(failed.status).toBe(400)
  const after = ((await (await getJson(app, "/services")).json()) as { data: ServiceItem[] }).data
  expect(after.map((row) => row.id).sort()).toEqual(before.map((row) => row.id).sort())

  const member = await buildApp("member", "org_c").request("/services/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: [{ kind: "template", templateId, priceCents: 90000 }] }),
  })
  expect(member.status).toBe(403)
})

it("services: sin biblioteca vigente «Más usados» queda vacío", async () => {
  // Un país sin biblioteca importada: la clínica arma su tarifario con servicios propios.
  const current = (await ownerDb.execute(
    sql`update "procedure_catalog_release" set "is_current" = false where "is_current" returning "system_key", "version"`,
  )) as unknown as Array<{ system_key: string; version: string }>
  expect(current.length).toBeGreaterThan(0)
  try {
    expect(await mostUsed(buildApp("owner", "org_c"))).toEqual([])
  } finally {
    for (const release of current) {
      await ownerDb.execute(
        sql`update "procedure_catalog_release" set "is_current" = true
          where "system_key" = ${release.system_key} and "version" = ${release.version}`,
      )
    }
  }
  expect((await mostUsed(buildApp("owner", "org_c"))).length).toBeGreaterThan(0)
})

it("services: sin región configurada no se pone precio a un servicio", async () => {
  const app = buildApp("owner", "org_d")
  const created = await app.request("/services", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Sin moneda",
      specialty: "cirugia",
      scope: "general",
      priceCents: 5000,
    }),
  })
  expect(created.status).toBe(409)
  expect(((await created.json()) as { error: { code: string } }).error.code).toBe(
    "ORG_PROFILE_REQUIRED",
  )
  const fromLibrary = await app.request("/services/from-templates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      items: [{ templateId: await templateIdByKey(PREVENCION_KEY), priceCents: 5000 }],
    }),
  })
  expect(fromLibrary.status).toBe(409)
  expect(await (await getJson(app, "/services")).json()).toEqual({ data: [], nextCursor: null })
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

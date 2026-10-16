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
  specialtyId: string | null
  specialtyName?: string | null
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

/**
 * La especialidad de la clínica con esa clave (ADR 0039): las organizaciones
 * de la prueba se crean a mano, así que nace aquí si falta.
 */
async function sp(key: string, orgId = "org_a"): Promise<string> {
  const rows = (await ownerDb.execute(
    sql`insert into "org_specialty" ("organization_id", "key", "name") values (${orgId}, ${key}, ${key})
      on conflict ("organization_id", "key") do update set "key" = excluded."key" returning "id"`,
  )) as unknown as Array<{ id: string }>
  return rows[0]!.id
}

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
  expect(await res.json()).toEqual({ data: [], nextCursor: null, total: 0 })
  const legacy = await getJson(app, "/services?state=legacy")
  expect(await legacy.json()).toEqual({ data: [], nextCursor: null, total: 0 })
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
      specialtyId: await sp("estetica"),
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
    body: JSON.stringify({ name: "X", specialtyId: await sp("estetica"), scope: "tooth" }),
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
  // La especialidad de la clínica con la clave de la plantilla.
  expect(body.data.specialtyId).toBe(await sp("prevencion"))
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
  const first = await app.request("/services/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      items: [{ kind: "template", templateId: tpl, priceCents: 12000, billingMode: "treatment" }],
    }),
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

  const second = await app.request("/services/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      items: [{ kind: "template", templateId: tpl, priceCents: 9000, billingMode: "treatment" }],
    }),
  })
  expect(second.status).toBe(201)
  const secondBody = (await second.json()) as {
    data: { created: ServiceItem[]; existing: ServiceItem[] }
  }
  expect(secondBody.data.created).toHaveLength(0)
  expect(secondBody.data.existing).toHaveLength(1)
  expect(secondBody.data.existing[0]?.priceCents).toBe(18000)
})

it("services: «Cómo dice el precio» se elige al agregar y se cambia para varios a la vez; member 403", async () => {
  const app = buildApp("owner")
  const added = await app.request("/services/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      items: [
        { kind: "custom", name: "Férula de descarga propia", specialtyId: await sp("disfuncion"), scope: "general", priceCents: 25000 },
        { kind: "custom", name: "Guarda nocturna propia", specialtyId: await sp("disfuncion"), scope: "general", priceCents: 30000 },
      ],
      priceDisclosure: "exacto",
    }),
  })
  expect(added.status).toBe(201)
  const created = ((await added.json()) as { data: { created: Array<ServiceItem & { priceDisclosure: string }> } }).data.created
  expect(created.map((row) => row.priceDisclosure)).toEqual(["exacto", "exacto"])
  const ids = created.map((row) => row.id)
  const changed = await app.request("/services/price-disclosure", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ serviceIds: ids, priceDisclosure: "desde" }),
  })
  expect(changed.status).toBe(200)
  expect(await changed.json()).toEqual({ data: { updated: 2 } })
  const denied = await buildApp("member").request("/services/price-disclosure", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ serviceIds: ids, priceDisclosure: "evaluacion" }),
  })
  expect(denied.status).toBe(403)
  const invalid = await app.request("/services/price-disclosure", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ serviceIds: ids, priceDisclosure: "gratis" }),
  })
  expect(invalid.status).toBe(400)
})

it("services: state filtra activas e inactivas", async () => {
  const app = buildApp("owner")
  const created = await app.request("/services", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Temporal",
      specialtyId: await sp("cirugia"),
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
      specialtyId: await sp("cirugia", "org_b"),
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
  expect(await (await getJson(app, "/services")).json()).toEqual({ data: [], nextCursor: null, total: 0 })

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
          specialtyId: await sp("ortodoncia", "org_c"),
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
    specialtyId: await sp("prevencion", "org_c"),
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
        // Una especialidad de otra clínica no sirve: todo o nada.
        { kind: "custom", name: "Sin área", specialtyId: await sp("cirugia", "org_a"), scope: "general", priceCents: 1 },
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
      specialtyId: await sp("cirugia", "org_d"),
      scope: "general",
      priceCents: 5000,
    }),
  })
  expect(created.status).toBe(409)
  expect(((await created.json()) as { error: { code: string } }).error.code).toBe(
    "ORG_PROFILE_REQUIRED",
  )
  const fromLibrary = await app.request("/services/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      items: [
        { kind: "template", templateId: await templateIdByKey(PREVENCION_KEY), priceCents: 5000 },
      ],
    }),
  })
  expect(fromLibrary.status).toBe(409)
  expect(await (await getJson(app, "/services")).json()).toEqual({ data: [], nextCursor: null, total: 0 })
})

it("services: código duplicado responde 409 DUPLICATE_CODE", async () => {
  const app = buildApp("owner")
  const payload = {
    code: "dup",
    name: "Duplicado",
    specialtyId: await sp("cirugia"),
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

it("services: con más de 100 servicios la lista pagina y dice el total; lo elegido se nombra por id", async () => {
  // Una clínica mediana aparte: 105 servicios activos y uno inactivo.
  await ownerDb.execute(
    sql`insert into "organization" ("id", "name", "slug", "created_at") values ('org_e', 'Clínica Grande', 'grande', now())`,
  )
  await ownerDb.execute(
    sql`insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale")
      values ('org_e', 'Grande', 'PE', 'PEN', 'America/Lima', 'es-PE')`,
  )
  const endo = await sp("endodoncia", "org_e")
  const general = await sp("general", "org_e")
  await ownerDb.execute(sql`
    insert into "service_catalog" ("organization_id", "source", "name", "specialty_id", "scope", "price_cents", "currency", "is_active")
    select 'org_e', 'custom', 'Servicio ' || lpad(n::text, 3, '0'), case when n <= 6 then ${endo}::uuid else ${general}::uuid end, 'general', 1000, 'PEN', n <> 106
    from generate_series(1, 106) as n`)
  const app = buildApp("reception", "org_e")
  const first = (await (await getJson(app, "/services?limit=100")).json()) as {
    data: ServiceItem[]
    nextCursor: string | null
    total: number
  }
  expect(first.total).toBe(105)
  expect(first.data).toHaveLength(100)
  expect(first.nextCursor).not.toBeNull()
  const second = (await (
    await getJson(app, `/services?limit=100&cursor=${encodeURIComponent(first.nextCursor!)}`)
  ).json()) as { data: ServiceItem[]; nextCursor: string | null; total: number }
  expect(second.data.map((row) => row.name)).toEqual(["Servicio 101", "Servicio 102", "Servicio 103", "Servicio 104", "Servicio 105"])
  expect(second.nextCursor).toBeNull()
  expect(second.total).toBe(105)
  // El buscador encuentra el último aunque no esté en la primera página.
  const found = (await (await getJson(app, "/services?q=105&limit=30")).json()) as { data: ServiceItem[]; total: number }
  expect(found.data.map((row) => row.name)).toEqual(["Servicio 105"])
  expect(found.total).toBe(1)
  // Filtrado por la especialidad de la clínica, con su nombre en cada fila.
  const byEndo = (await (await getJson(app, `/services?specialtyId=${endo}`)).json()) as { data: ServiceItem[]; total: number }
  expect(byEndo.total).toBe(6)
  expect(byEndo.data.every((row) => row.specialtyId === endo && row.specialtyName === "endodoncia")).toBe(true)
  // Lo ya elegido se nombra aunque no esté en la primera página ni siga activo.
  const all = [...first.data, ...second.data]
  const last = all.find((row) => row.name === "Servicio 105")!
  const inactive = ((await ownerDb.execute(
    sql`select "id" from "service_catalog" where "organization_id" = 'org_e' and not "is_active"`,
  )) as unknown as Array<{ id: string }>)[0]!.id
  const named = (await (await getJson(app, `/services?ids=${last.id},${inactive}`)).json()) as { data: ServiceItem[] }
  expect(named.data.map((row) => row.name).sort()).toEqual(["Servicio 105", "Servicio 106"])
  const one = await getJson(app, `/services/${last.id}`)
  expect(one.status).toBe(200)
  expect(((await one.json()) as { data: ServiceItem }).data).toMatchObject({ name: "Servicio 105", specialtyName: "general" })
  // Otra clínica no lo ve.
  expect((await getJson(buildApp("owner", "org_a"), `/services/${last.id}`)).status).toBe(404)
  expect((await getJson(app, "/services?ids=no-es-un-id")).status).toBe(400)
})

it("services: cada servicio tiene una sola especialidad de la clínica, también el de la biblioteca", async () => {
  const app = buildApp("owner")
  const tpl = await templateIdByKey(RESTAURADORA_KEY)
  // De la biblioteca: la especialidad de la clínica con la clave de la plantilla.
  const listed = (await (await getJson(app, "/services?limit=100")).json()) as { data: ServiceItem[] }
  const fromLibrary = listed.data.find((row) => row.templateId === tpl)!
  expect(fromLibrary.specialtyId).toBe(await sp("restauradora"))
  // La clínica la cambia en el formulario del servicio: una sola, la nueva.
  const estetica = await sp("estetica")
  const moved = await app.request(`/services/${fromLibrary.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ specialtyId: estetica }),
  })
  expect(moved.status).toBe(200)
  expect(((await moved.json()) as { data: ServiceItem }).data.specialtyId).toBe(estetica)
  // Una especialidad de otra clínica no sirve.
  const foreign = await app.request(`/services/${fromLibrary.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ specialtyId: await sp("estetica", "org_b") }),
  })
  expect(foreign.status).toBe(400)
  // Un servicio propio sin especialidad no se crea.
  const missing = await app.request("/services", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Sin especialidad", scope: "general", priceCents: 100 }),
  })
  expect(missing.status).toBe(400)
})

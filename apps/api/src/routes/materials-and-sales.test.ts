/**
 * Materiales de los servicios, de la atención y venta desde «Cobrar» (ADR 0067)
 * en la frontera HTTP: cada ruta con su permiso, sin precios para quien no los
 * ve y los errores dichos con palabras.
 */
process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { randomUUID } from "node:crypto"
import { createAppDb, createOwnerDb, type Db } from "@odentia/db"
import { secretsKeyFromEnv } from "@odentia/services"
import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Context } from "hono"
import { Hono, type Next } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import { createFinanceRoute } from "./finance.js"
import type { CrmDeps } from "./helpers.js"
import { createPatientsRoute } from "./patients.js"
import { createServicesRoute } from "./services.js"

const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("ee".repeat(32))
const ORG = "org_mat"
const OWNER = "u-owner"
const DENTIST = "u-dentist"
const OTHER_DENTIST = "u-dentist-2"
const BRANCH = randomUUID()
const SERVICE = randomUUID()
const GLOVES = randomUUID()
const BRUSH = randomUUID()
const PERSON = randomUUID()
const PATIENT = randomUUID()
const ENCOUNTER = randomUUID()

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

function buildApp(role: string, userId: string): Hono {
  const deps: CrmDeps = {
    db: appDb,
    secretsKey: KEY,
    storage: storageStub as unknown as CrmDeps["storage"],
    validateExternal: false,
    webhookBaseUrl: "https://api.example.com",
  }
  const app = new Hono()
  app.use("*", async (c: Context, next: Next) => {
    c.set("orgId", ORG)
    c.set("userId", userId)
    c.set("memberRole", role)
    await next()
  })
  app.route("/services", createServicesRoute(deps))
  app.route("/patients", createPatientsRoute(deps))
  app.route("/finance", createFinanceRoute(deps))
  return app
}

async function call(app: Hono, method: string, path: string, payload?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  })
  const text = await res.text()
  // biome-ignore lint/suspicious/noExplicitAny: la respuesta JSON se compara campo a campo en cada prueba
  let body: Record<string, any> = {}
  try {
    body = JSON.parse(text)
  } catch {
    body = { text }
  }
  return { status: res.status, body }
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
  await ownerDb.execute(sql`insert into "organization" ("id", "name", "slug", "created_at") values (${ORG}, 'Clínica Materiales', 'materiales', now())`)
  await ownerDb.execute(sql`
    insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale")
    values (${ORG}, 'Clínica Materiales', 'PE', 'PEN', 'America/Lima', 'es-PE')`)
  for (const [id, role] of [
    [OWNER, "owner"],
    [DENTIST, "dentist"],
    [OTHER_DENTIST, "dentist"],
    ["u-reception", "reception"],
    ["u-cashier", "cashier"],
  ] as const) {
    await ownerDb.execute(sql`insert into "user" ("id", "name", "email") values (${id}, ${`Equipo ${role}`}, ${`${id}@example.test`})`)
    await ownerDb.execute(sql`insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values (${`m-${id}`}, ${ORG}, ${id}, ${role}, now())`)
  }
  // La sede nace con su almacén principal (disparador de la base).
  await ownerDb.execute(sql`insert into "branch" ("id", "organization_id", "name") values (${BRANCH}::uuid, ${ORG}, 'Sede Miraflores')`)
  await ownerDb.execute(sql`
    insert into "service_catalog" ("id", "organization_id", "name", "scope", "source", "price_cents", "currency")
    values (${SERVICE}::uuid, ${ORG}, 'Limpieza dental', 'general', 'custom', 12000, 'PEN')`)
  await ownerDb.execute(sql`
    insert into "product" ("id", "organization_id", "sku", "name", "unit", "used_in_care", "for_sale")
    values (${GLOVES}::uuid, ${ORG}, 'GUA', 'Guantes de nitrilo', 'guante', true, false)`)
  await ownerDb.execute(sql`
    insert into "product" ("id", "organization_id", "sku", "name", "unit", "used_in_care", "for_sale", "sale_price_cents", "sale_currency")
    values (${BRUSH}::uuid, ${ORG}, 'CEP', 'Cepillo dental suave', 'cepillo', false, true, 1500, 'PEN')`)
  await ownerDb.execute(sql`insert into "contact" ("id", "organization_id", "display_name") values (${PERSON}::uuid, ${ORG}, 'Lucía Paredes')`)
  await ownerDb.execute(sql`insert into "patient" ("id", "organization_id", "person_id", "patient_number") values (${PATIENT}::uuid, ${ORG}, ${PERSON}::uuid, 1)`)
  // Una atención firmada por la odontóloga, en la sede.
  await ownerDb.execute(sql`
    insert into "encounter" ("id", "organization_id", "patient_id", "branch_id", "dentist_user_id", "reason")
    values (${ENCOUNTER}::uuid, ${ORG}, ${PATIENT}::uuid, ${BRANCH}::uuid, ${DENTIST}, 'Control')`)
  await ownerDb.execute(sql`
    update "encounter" set "status" = 'finalizada', "finalized_at" = now(), "ended_at" = now(), "finalized_by" = ${DENTIST},
      "signer_name" = 'Dra. Ana', "signer_title" = 'Cirujano dentista', "signer_registration" = 'COP 1'
    where "id" = ${ENCOUNTER}::uuid`)
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

it("materiales de un servicio: los cambia quien lleva el inventario y el costo solo lo ve quien ve precios", async () => {
  const owner = buildApp("owner", OWNER)
  const dentist = buildApp("dentist", DENTIST)
  const reception = buildApp("reception", "u-reception")

  const denied = await call(dentist, "PUT", `/services/${SERVICE}/materials`, { items: [{ productId: GLOVES, quantity: 2 }] })
  expect(denied.status).toBe(403)
  expect(denied.body.error.message).toBe("No tienes permiso para cambiar los materiales")
  expect((await call(reception, "PUT", `/services/${SERVICE}/materials`, { items: [] })).status).toBe(403)

  const wrong = await call(owner, "PUT", `/services/${SERVICE}/materials`, { items: [{ productId: GLOVES, quantity: 0 }] })
  expect(wrong.status).toBe(400)
  expect(wrong.body.error.message).toBe("La cantidad de cada material va de 1 a 9999")
  const forSale = await call(owner, "PUT", `/services/${SERVICE}/materials`, { items: [{ productId: BRUSH, quantity: 1 }] })
  expect(forSale.status).toBe(409)
  expect(forSale.body.error.message).toContain("no se usa en las atenciones")

  const saved = await call(owner, "PUT", `/services/${SERVICE}/materials`, { items: [{ productId: GLOVES, quantity: 2 }] })
  expect(saved.status).toBe(200)
  expect(saved.body.data).toMatchObject({
    serviceId: SERVICE,
    serviceName: "Limpieza dental",
    items: [{ productId: GLOVES, quantity: 2, quantityText: "2 guantes", discounted: true, costCents: null }],
    cost: null,
  })

  // Recepción ve Inventario sin precios: los materiales, sí; el costo, nunca.
  const seen = await call(reception, "GET", `/services/${SERVICE}/materials`)
  expect(seen.status).toBe(200)
  expect(seen.body.data.cost).toBeNull()
  expect((await call(buildApp("cashier", "u-cashier"), "GET", `/services/${SERVICE}/materials`)).status).toBe(403)
  const missing = await call(owner, "GET", "/services/abc-123/materials")
  expect(missing.status).toBe(404)
  expect(missing.body.error.message).toBe("Servicio no encontrado")

  // En la lista: el número de materiales para quien ve Inventario; nada para los demás.
  const ownerList = await call(owner, "GET", "/services")
  expect(ownerList.body.data.find((row: { id: string }) => row.id === SERVICE)?.materials).toEqual({ count: 1, cost: null })
  const dentistList = await call(dentist, "GET", "/services")
  expect(dentistList.body.data.find((row: { id: string }) => row.id === SERVICE)).not.toHaveProperty("materials")

  // «Empieza por estos 5» y el buscador de materiales son de quien los configura.
  expect((await call(owner, "GET", "/services/without-materials")).status).toBe(200)
  expect((await call(reception, "GET", "/services/without-materials")).status).toBe(403)
  const options = await call(owner, "GET", "/services/material-products?q=guantes")
  expect(options.body.data).toEqual([{ productId: GLOVES, name: "Guantes de nitrilo", unit: "guante" }])
})

it("vender desde Cobrar: lo busca y lo agrega quien cobra, con la sede y el precio del producto", async () => {
  const cashier = buildApp("cashier", "u-cashier")
  const found = await call(cashier, "GET", `/finance/sale-products?branchId=${BRANCH}&q=cepillo`)
  expect(found.status).toBe(200)
  expect(found.body.data).toMatchObject({
    branch: { id: BRANCH, name: "Sede Miraflores" },
    items: [{ productId: BRUSH, salePriceCents: 1500, currency: "PEN", onHand: 0, onHandText: null }],
  })
  expect(found.body.data.items[0]).not.toHaveProperty("costCents")
  expect((await call(buildApp("reception", "u-reception"), "GET", `/finance/sale-products?branchId=${BRANCH}`)).status).toBe(403)
  expect((await call(buildApp("dentist", DENTIST), "GET", `/finance/sale-products?branchId=${BRANCH}`)).status).toBe(403)

  const noBranch = await call(cashier, "POST", `/patients/${PATIENT}/charges`, { productId: BRUSH, quantity: 2 })
  expect(noBranch.status).toBe(400)
  expect(noBranch.body.error.message).toBe("Elige la sede del cobro: el producto sale de su almacén")
  const ownPrice = await call(cashier, "POST", `/patients/${PATIENT}/charges`, { productId: BRUSH, branchId: BRANCH, amountCents: 100, requestId: randomUUID() })
  expect(ownPrice.status).toBe(400)
  const notSold = await call(cashier, "POST", `/patients/${PATIENT}/charges`, { productId: GLOVES, branchId: BRANCH, requestId: randomUUID() })
  expect(notSold.status).toBe(409)
  expect(notSold.body.error.message).toContain("no se vende")

  const sold = await call(cashier, "POST", `/patients/${PATIENT}/charges`, { productId: BRUSH, quantity: 2, branchId: BRANCH, requestId: randomUUID() })
  expect(sold.status).toBe(201)
  expect(sold.body.data).toMatchObject({
    description: "Cepillo dental suave × 2",
    amountCents: 3000,
    productId: BRUSH,
    productQuantity: 2,
  })
  // No había: se vendió igual y queda como faltante en la sede.
  const after = await call(cashier, "GET", `/finance/sale-products?branchId=${BRANCH}&q=cepillo`)
  expect(after.body.data.items[0]).toMatchObject({ onHand: -2, onHandText: null })
  const voided = await call(cashier, "POST", `/patients/${PATIENT}/charges/${sold.body.data.id}/void`, { reason: "Se arrepintió" })
  expect(voided.status).toBe(200)
  const back = await call(cashier, "GET", `/finance/sale-products?branchId=${BRANCH}&q=cepillo`)
  expect(back.body.data.items[0].onHand).toBe(0)
})

it("materiales usados en la atención: los lee quien lee la historia y los corrige quien atendió o el dueño", async () => {
  const dentist = buildApp("dentist", DENTIST)
  const other = buildApp("dentist", OTHER_DENTIST)
  const owner = buildApp("owner", OWNER)
  const path = `/patients/${PATIENT}/encounters/${ENCOUNTER}/materials`

  const empty = await call(dentist, "GET", path)
  expect(empty.status).toBe(200)
  expect(empty.body.data).toEqual({ branch: { id: BRANCH, name: "Sede Miraflores" }, items: [], canCorrect: true })
  expect((await call(buildApp("cashier", "u-cashier"), "GET", path)).status).toBe(403)

  const fixed = await call(dentist, "POST", path, { productId: GLOVES, quantity: 4, idempotencyKey: "form-1" })
  expect(fixed.status).toBe(200)
  expect(fixed.body.data).toMatchObject({ changed: 4, items: [{ productId: GLOVES, quantity: 4, quantityText: "4 guantes" }] })

  const denied = await call(other, "POST", path, { productId: GLOVES, quantity: 2, idempotencyKey: "form-2" })
  expect(denied.status).toBe(403)
  expect(denied.body.error.message).toBe("Corrigen los materiales quien atendió, el dueño y la administración")
  expect((await call(other, "GET", path)).body.data.canCorrect).toBe(false)

  const byOwner = await call(owner, "POST", path, { productId: GLOVES, quantity: 2, idempotencyKey: "form-3" })
  expect(byOwner.status).toBe(200)
  expect(byOwner.body.data).toMatchObject({ changed: -2, items: [{ quantity: 2 }] })

  const bad = await call(owner, "POST", path, { productId: GLOVES, quantity: -1, idempotencyKey: "form-4" })
  expect(bad.status).toBe(400)
  expect(bad.body.error.message).toBe("Lo usado va de 0 a 9999")
})

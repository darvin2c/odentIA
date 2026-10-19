process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { createAppDb, createOwnerDb, type Db } from "@odentia/db"
import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Context } from "hono"
import { Hono, type Next } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import { z } from "zod"
import type { CrmDeps } from "./helpers.js"
import { createInventoryRoute } from "./inventory.js"

// Inventario por la API real con PostgreSQL efímero: solo quien lee el
// inventario lo ve, solo quien lo cambia lo cambia, y lo mal formado responde
// 400 o 404 con palabras, nunca un 500 ni un texto interno.

const IMAGE = "dentalagent-postgres:18.6"
const ORG = "org_inv"
const OWNER = "u-inv-owner"
const RECEPTION = "u-inv-recep"
const DENTIST = "u-inv-dent"
const BRANCH = "0b0b0b0b-0000-4000-8000-000000000001"
const PATIENT = "0b0b0b0b-0000-4000-8000-000000000002"
const PERSON = "0b0b0b0b-0000-4000-8000-000000000003"

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db

const Created = z.object({ data: z.object({ id: z.string() }).passthrough() })
const ErrorShape = z.object({ error: z.object({ code: z.string(), message: z.string() }) })

function buildApp(role: string, userId: string): Hono {
  const deps = { db: appDb } as unknown as CrmDeps
  const app = new Hono()
  app.use("*", async (c: Context, next: Next) => {
    c.set("orgId", ORG)
    c.set("userId", userId)
    c.set("memberRole", role)
    await next()
  })
  app.route("/inventory", createInventoryRoute(deps))
  return app
}

const owner = () => buildApp("owner", OWNER)

async function call(app: Hono, method: string, path: string, body?: unknown, raw?: string) {
  const res = await app.request(`/inventory${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(raw !== undefined ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: (await res.json()) as unknown }
}

/** El error llega con palabras: ni el inglés de la librería, ni permisos ni claves internas. */
function expectWords(body: unknown, message?: string) {
  const { error } = ErrorShape.parse(body)
  expect(error.message).not.toMatch(/Invalid|expected|received|inventory\.|idempotencia|2147483647|_/)
  if (message) expect(error.message).toBe(message)
  return error
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
  await ownerDb.execute(sql`insert into "organization" ("id", "name", "slug", "created_at") values (${ORG}, 'Clínica Inventario', 'inventario', now())`)
  // Región explícita: la moneda de la orden sale del perfil, nunca de un valor por defecto.
  await ownerDb.execute(sql`
    insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale")
    values (${ORG}, 'Clínica Inventario', 'CL', 'CLP', 'America/Santiago', 'es-CL')`)
  for (const [id, role] of [[OWNER, "owner"], [RECEPTION, "reception"], [DENTIST, "dentist"]] as const) {
    await ownerDb.execute(sql`insert into "user" ("id", "name", "email") values (${id}, ${`Equipo ${role}`}, ${`${id}@example.test`})`)
    await ownerDb.execute(sql`insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values (${`m-${id}`}, ${ORG}, ${id}, ${role}, now())`)
  }
  await ownerDb.execute(sql`insert into "branch" ("id", "organization_id", "name") values (${BRANCH}::uuid, ${ORG}, 'Sede Centro')`)
  await ownerDb.execute(sql`insert into "contact" ("id", "organization_id", "display_name") values (${PERSON}::uuid, ${ORG}, 'Paciente Inventario')`)
  await ownerDb.execute(sql`insert into "patient" ("id", "organization_id", "person_id", "patient_number") values (${PATIENT}::uuid, ${ORG}, ${PERSON}::uuid, 1)`)
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

it("solo quien lee el inventario lo ve y solo quien lo cambia lo cambia, dicho con palabras", async () => {
  for (const [role, user] of [["reception", RECEPTION], ["dentist", DENTIST]] as const) {
    const read = await call(buildApp(role, user), "GET", "/products")
    expect(read.status, role).toBe(403)
    expectWords(read.body, "No tienes permiso para ver el inventario")
    const write = await call(buildApp(role, user), "POST", "/products", { sku: "X", name: "X" })
    expect(write.status, role).toBe(403)
    expectWords(write.body, "No tienes permiso para cambiar el inventario")
    const move = await call(buildApp(role, user), "POST", "/movements", {})
    expect(move.status, role).toBe(403)
  }
  expect((await call(owner(), "GET", "/products")).status).toBe(200)
  expect((await call(buildApp("admin", OWNER), "GET", "/alerts")).status).toBe(200)
})

it("lo mal formado responde 400 o 404 en palabras, nunca 500", async () => {
  const app = owner()
  const notFound = [
    ["GET", "/products/abc", "Producto no encontrado"],
    ["PATCH", "/products/abc", "Producto no encontrado"],
    ["POST", "/products/abc/activation", "Producto no encontrado"],
    ["PATCH", "/suppliers/abc", "Proveedor no encontrado"],
    ["PATCH", "/warehouses/abc", "Almacén no encontrado"],
    ["GET", "/purchase-orders/abc", "Orden de compra no encontrada"],
    ["POST", "/purchase-orders/abc/confirm", "Orden de compra no encontrada"],
    ["POST", "/purchase-orders/abc/receive", "Orden de compra no encontrada"],
    ["POST", "/purchase-orders/abc/cancel", "Orden de compra no encontrada"],
  ] as const
  for (const [method, path, message] of notFound) {
    const res = await call(app, method, path, method === "GET" ? undefined : {})
    expect(res.status, `${method} ${path}`).toBe(404)
    expectWords(res.body, message)
  }
  // Un id bien formado que no existe también es «no encontrada», en femenino.
  const missingOrder = await call(app, "GET", `/purchase-orders/${crypto.randomUUID()}`)
  expect(missingOrder.status).toBe(404)
  expectWords(missingOrder.body, "Orden de compra no encontrada")

  const badQueries = [
    ["/purchase-orders?supplierId=abc", "El proveedor del filtro no es válido"],
    ["/movements?productId=abc", "El producto del filtro no es válido"],
    ["/movements?warehouseId=1", "El almacén del filtro no es válido"],
    ["/movements?patientId=x", "El paciente del filtro no es válido"],
    ["/movements?limit=diez", "La cantidad de movimientos por página debe ser un número entero"],
    ["/movements?offset=-1", "La página pedida no es válida"],
    ["/alerts?expiryDays=pronto", "Los días para vencer deben ser un número entero"],
  ] as const
  for (const [path, message] of badQueries) {
    const res = await call(app, "GET", path)
    expect(res.status, path).toBe(400)
    expectWords(res.body, message)
  }
  expect((await call(app, "GET", "/movements?limit=5&offset=0")).status).toBe(200)
  expect((await call(app, "GET", "/alerts?expiryDays=15")).status).toBe(200)

  const badBodies = [
    ["POST", "/products", undefined, "{no es json", "No llegaron los datos del formulario. Vuelve a intentarlo."],
    ["POST", "/products", { sku: 5, name: "Guantes" }, undefined, "El SKU no es válido"],
    ["POST", "/products", { sku: "G-1", name: "Guantes", minStock: -1 }, undefined, "El stock mínimo no puede ser negativo"],
    ["POST", "/warehouses", { branchId: "sede", name: "Almacén" }, undefined, "Elige la sede del almacén"],
    ["POST", "/purchase-orders", { supplierId: crypto.randomUUID(), warehouseId: crypto.randomUUID(), lines: [] }, undefined, "La orden necesita al menos una línea"],
    ["POST", "/movements", { productId: crypto.randomUUID(), kind: "consumo", quantity: 1, reason: "Uso" }, undefined, "No se pudo identificar este movimiento: cierra el formulario y vuelve a abrirlo"],
    ["POST", "/movements", { productId: crypto.randomUUID(), kind: "consumo", quantity: 1, reason: "Uso", patientId: "Ana", idempotencyKey: crypto.randomUUID() }, undefined, "Elige el paciente atendido"],
    ["POST", "/movements", { productId: crypto.randomUUID(), kind: "ajuste", quantity: 0, reason: "Conteo", idempotencyKey: crypto.randomUUID() }, undefined, "La cantidad no puede ser cero"],
    ["POST", "/movements", { productId: crypto.randomUUID(), kind: "regalo", quantity: 1, reason: "x", idempotencyKey: crypto.randomUUID() }, undefined, "Elige el tipo de movimiento"],
  ] as const
  for (const [method, path, body, raw, message] of badBodies) {
    const res = await call(app, method, path, body, raw)
    expect(res.status, message).toBe(400)
    expectWords(res.body, message)
  }
})

it("el recorrido por la API: crear, confirmar, recibir y reintentar; un movimiento con su clave no se duplica", async () => {
  const app = owner()
  const supplier = Created.parse((await call(app, "POST", "/suppliers", { name: "Insumos del Sur" })).body).data.id
  const warehouse = Created.parse((await call(app, "POST", "/warehouses", { branchId: BRANCH, name: "Almacén central" })).body).data.id
  const product = Created.parse((await call(app, "POST", "/products", { sku: "GNT-1", name: "Guantes", unit: "caja x 100", minStock: 2 })).body).data.id
  const created = await call(app, "POST", "/purchase-orders", {
    supplierId: supplier,
    warehouseId: warehouse,
    lines: [{ productId: product, quantity: 4, unitCostCents: 3500 }],
  })
  expect(created.status).toBe(201)
  const order = z.object({ data: z.object({ id: z.string(), currency: z.string(), orderNumber: z.number() }) }).parse(created.body).data
  expect(order.currency).toBe("CLP")
  expect((await call(app, "POST", `/purchase-orders/${order.id}/confirm`)).status).toBe(200)
  const again = await call(app, "POST", `/purchase-orders/${order.id}/confirm`)
  expect(again.status).toBe(409)
  expectWords(again.body, "La orden ya está confirmada: solo se confirma una orden en borrador")

  const reception = { idempotencyKey: crypto.randomUUID(), lines: [{ productId: product, quantity: 4 }] }
  const received = await call(app, "POST", `/purchase-orders/${order.id}/receive`, reception)
  expect(received.status).toBe(200)
  // La respuesta se perdió: el reintento devuelve lo aplicado aunque la orden ya esté completa.
  const retried = await call(app, "POST", `/purchase-orders/${order.id}/receive`, reception)
  expect(retried.status).toBe(200)
  expect(z.object({ data: z.object({ status: z.string() }).passthrough() }).parse(retried.body).data.status).toBe("recibida")

  const detail = z
    .object({ data: z.object({ onHand: z.number(), lots: z.array(z.object({ id: z.string(), code: z.string() }).passthrough()) }).passthrough() })
    .parse((await call(app, "GET", `/products/${product}`)).body).data
  expect(detail.onHand).toBe(4)
  expect(detail.lots[0]?.code).toBe(`OC-${String(order.orderNumber).padStart(4, "0")}`)

  const movement = {
    productId: product,
    kind: "consumo",
    quantity: 3,
    lotId: detail.lots[0]!.id,
    reason: "Endodoncia",
    patientId: PATIENT,
    idempotencyKey: crypto.randomUUID(),
  }
  const first = await call(app, "POST", "/movements", movement)
  expect(first.status).toBe(201)
  const repeated = await call(app, "POST", "/movements", movement)
  expect(repeated.status).toBe(201)
  expect(Created.parse(repeated.body).data.id).toBe(Created.parse(first.body).data.id)
  const other = await call(app, "POST", "/movements", { ...movement, quantity: 1 })
  expect(other.status).toBe(409)
  expectWords(other.body, "Este movimiento ya se registró con otros datos. Cierra el formulario y vuelve a abrirlo para registrar uno nuevo.")
  const after = z.object({ data: z.object({ onHand: z.number() }).passthrough() }).parse((await call(app, "GET", `/products/${product}`)).body).data
  expect(after.onHand).toBe(1)

  // Los dos estados de la orden en el filtro, y un proveedor bien escrito filtra.
  const bySupplier = z.object({ data: z.array(z.object({ id: z.string() }).passthrough()) })
    .parse((await call(app, "GET", `/purchase-orders?supplierId=${supplier}&status=recibida`)).body).data
  expect(bySupplier.map((row) => row.id)).toEqual([order.id])
})

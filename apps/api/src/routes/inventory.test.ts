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

// Inventario por la API real con PostgreSQL efímero (ADR 0067): quien ve el
// inventario lo ve, con precios o sin ellos; recepción registra lo que llega y
// el uso sin ver precios ni tocarlos; lo demás es de quien lleva el
// inventario. Lo mal formado responde 400 o 404 con palabras, nunca un 500 ni
// un texto interno.

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
const Data = z.object({ data: z.record(z.string(), z.unknown()) })

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
const reception = () => buildApp("reception", RECEPTION)

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

/** Ninguna clave de precio en lo que llega: ni en el objeto ni en sus listas. */
function expectNoPrices(value: unknown) {
  const text = JSON.stringify(value)
  for (const key of ["unitCostCents", "orderedUnitCostCents", "salePriceCents", "totalCents", "balance", "payments", "dueCents", "creditCents", "supplierCreditCents", "subtotalCents"])
    expect(text, key).not.toContain(`"${key}"`)
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
  // La sede nace con su almacén principal (disparador de la base).
  await ownerDb.execute(sql`insert into "branch" ("id", "organization_id", "name") values (${BRANCH}::uuid, ${ORG}, 'Sede Centro')`)
  await ownerDb.execute(sql`insert into "contact" ("id", "organization_id", "display_name") values (${PERSON}::uuid, ${ORG}, 'Paciente Inventario')`)
  await ownerDb.execute(sql`insert into "patient" ("id", "organization_id", "person_id", "patient_number") values (${PATIENT}::uuid, ${ORG}, ${PERSON}::uuid, 1)`)
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

/** Un producto que se compra por caja de 100 y una compra pedida de él. */
async function orderedGloves(sku: string, boxes = 4) {
  const app = owner()
  const supplier = Created.parse((await call(app, "POST", "/suppliers", { name: `Insumos ${sku}` })).body).data.id
  const product = Created.parse(
    (await call(app, "POST", "/products", { sku, name: `Guantes ${sku}`, unit: "guante", purchaseUnit: "caja", purchaseFactor: 100, forSale: true, salePriceCents: 90 }))
      .body,
  ).data.id
  const created = await call(app, "POST", "/purchase-orders", {
    supplierId: supplier,
    branchId: BRANCH,
    mode: "pedir",
    lines: [{ productId: product, quantity: boxes, unitCostCents: 3500 }],
  })
  expect(created.status).toBe(201)
  const order = z.object({ data: z.object({ id: z.string(), currency: z.string(), orderNumber: z.number(), status: z.string() }).passthrough() }).parse(created.body).data
  return { supplier, product, order }
}

it("quien ve el inventario lo ve; recepción sin precios recibe lo que llega y registra el uso; lo demás es de quien lo lleva", async () => {
  for (const role of ["dentist", "cashier", "member"] as const) {
    const app = buildApp(role, DENTIST)
    const read = await call(app, "GET", "/products")
    expect(read.status, role).toBe(403)
    expectWords(read.body, "No tienes permiso para ver el inventario")
    const write = await call(app, "POST", "/products", { name: "X" })
    expect(write.status, role).toBe(403)
    expectWords(write.body, "No tienes permiso para cambiar el inventario")
    const use = await call(app, "POST", "/usage", {})
    expect(use.status, role).toBe(403)
    expectWords(use.body, "No tienes permiso para registrar lo que llega o se usa del inventario")
  }

  const { product, order } = await orderedGloves("REC-1")
  const desk = reception()
  // Ve productos, compras, movimientos y proveedores, sin ningún precio.
  const products = await call(desk, "GET", `/products?branchId=${BRANCH}`)
  expect(products.status).toBe(200)
  expectNoPrices(products.body)
  const detail = await call(desk, "GET", `/products/${product}?branchId=${BRANCH}`)
  expect(detail.status).toBe(200)
  expectNoPrices(detail.body)
  const orderSeen = await call(desk, "GET", `/purchase-orders/${order.id}`)
  expect(orderSeen.status).toBe(200)
  expectNoPrices(orderSeen.body)
  const list = await call(desk, "GET", `/purchase-orders?branchId=${BRANCH}&view=por_llegar`)
  expect(list.status).toBe(200)
  expectNoPrices(list.body)
  expect((await call(desk, "GET", "/suppliers")).status).toBe(200)
  expectNoPrices((await call(desk, "GET", "/suppliers")).body)
  expect((await call(desk, "GET", `/movements?branchId=${BRANCH}`)).status).toBe(200)
  const due = await call(desk, "GET", "/purchase-orders?view=por_pagar")
  expect(due.status).toBe(403)
  expectWords(due.body, "Lo que falta pagar de las compras lo ve quien lleva las compras")

  // Registra lo que llegó, pero no el precio de la factura.
  const priced = await call(desk, "POST", `/purchase-orders/${order.id}/receive`, {
    idempotencyKey: crypto.randomUUID(),
    lines: [{ productId: product, quantity: 1, unitCostCents: 3000 }],
  })
  expect(priced.status).toBe(403)
  expectWords(priced.body, "Corregir el precio de la factura es de quien lleva las compras")
  const received = await call(desk, "POST", `/purchase-orders/${order.id}/receive`, {
    idempotencyKey: crypto.randomUUID(),
    lines: [{ productId: product, lots: [{ quantity: 1, lotCode: "L-1", expiresAt: "2030-01-01" }, { quantity: 1, lotCode: "L-2" }] }],
  })
  expect(received.status).toBe(200)
  expectNoPrices(received.body)
  expect(Data.parse(received.body).data.status).toBe("parcialmente_recibida")
  // Registra el uso fuera de una atención.
  const used = await call(desk, "POST", "/usage", { productId: product, branchId: BRANCH, quantity: 3, patientId: PATIENT, idempotencyKey: crypto.randomUUID() })
  expect(used.status).toBe(201)
  // Pedir, contar, ajustar, trasladar, agregar y cerrar no son suyos.
  for (const [method, path, body] of [
    ["POST", "/purchase-orders", {}],
    ["POST", `/purchase-orders/${order.id}/close`, undefined],
    ["POST", "/count", {}],
    ["POST", "/transfers", {}],
    ["POST", "/additions", {}],
    ["POST", `/products/${product}/write-off`, {}],
    ["POST", "/products/import/preview", {}],
    ["GET", `/reorder?branchId=${BRANCH}`, undefined],
  ] as const) {
    const res = await call(desk, method, path, body)
    expect(res.status, path).toBe(403)
    expectWords(res.body, "No tienes permiso para cambiar el inventario")
  }

  // Quien lleva el inventario sí ve los precios.
  const full = Data.parse((await call(owner(), "GET", `/purchase-orders/${order.id}`)).body).data
  expect(full).toHaveProperty("balance")
  expect(JSON.stringify(full)).toContain('"unitCostCents":3500')
})

it("lo mal formado responde 400 o 404 en palabras, nunca 500", async () => {
  const app = owner()
  const notFound = [
    ["GET", "/products/abc", "Producto no encontrado"],
    ["PATCH", "/products/abc", "Producto no encontrado"],
    ["POST", "/products/abc/activation", "Producto no encontrado"],
    ["POST", "/products/abc/write-off", "Producto no encontrado"],
    ["POST", "/lots/abc/adjust", "Lote no encontrado"],
    ["PATCH", "/suppliers/abc", "Proveedor no encontrado"],
    ["PATCH", "/warehouses/abc", "Almacén no encontrado"],
    ["GET", "/purchase-orders/abc", "Orden de compra no encontrada"],
    ["PATCH", "/purchase-orders/abc", "Orden de compra no encontrada"],
    ["POST", "/purchase-orders/abc/confirm", "Orden de compra no encontrada"],
    ["POST", "/purchase-orders/abc/receive", "Orden de compra no encontrada"],
    ["POST", "/purchase-orders/abc/close", "Orden de compra no encontrada"],
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
    ["/products?need=poco", "El filtro de productos no es válido"],
    ["/products?branchId=centro", "La sede del filtro no es válida"],
    ["/purchase-orders?supplierId=abc", "El proveedor del filtro no es válido"],
    ["/purchase-orders?view=todo", "La vista de compras no es válida"],
    ["/purchase-orders?status=perdida", "Estado de orden inválido"],
    ["/movements?productId=abc", "El producto del filtro no es válido"],
    ["/movements?warehouseId=1", "El almacén del filtro no es válido"],
    ["/movements?patientId=x", "El paciente del filtro no es válido"],
    ["/movements?kind=regalo", "Tipo de movimiento inválido"],
    ["/movements?limit=diez", "La cantidad de movimientos por página debe ser un número entero"],
    ["/movements?offset=-1", "La página pedida no es válida"],
    ["/reorder?branchId=centro", "La sede del filtro no es válida"],
  ] as const
  for (const [path, message] of badQueries) {
    const res = await call(app, "GET", path)
    expect(res.status, path).toBe(400)
    expectWords(res.body, message)
  }
  expect((await call(app, "GET", "/movements?limit=5&offset=0")).status).toBe(200)

  const key = crypto.randomUUID()
  const badBodies = [
    ["POST", "/products", undefined, "{no es json", "No llegaron los datos del formulario. Vuelve a intentarlo."],
    ["POST", "/products", { sku: 5, name: "Guantes" }, undefined, "El código no es válido"],
    ["POST", "/products", { name: "Guantes", minimums: [{ branchId: BRANCH, minQuantity: -1 }] }, undefined, "El mínimo no puede ser negativo"],
    ["POST", "/warehouses", { branchId: "sede", name: "Almacén" }, undefined, "Elige la sede del almacén"],
    ["POST", "/purchase-orders", { supplierId: crypto.randomUUID(), branchId: BRANCH, lines: [] }, undefined, "La orden necesita al menos una línea"],
    ["POST", "/purchase-orders", { supplierId: crypto.randomUUID(), branchId: BRANCH, mode: "regalo", lines: [{ productId: crypto.randomUUID(), quantity: 1 }] }, undefined, "Elige si la compra se pide o ya la tienes"],
    ["POST", `/purchase-orders/${crypto.randomUUID()}/receive`, { idempotencyKey: key, lines: [{ productId: crypto.randomUUID() }] }, undefined, "Escribe cuánto llegó de cada producto"],
    ["POST", "/usage", { productId: crypto.randomUUID(), branchId: BRANCH, quantity: 1 }, undefined, "No se pudo identificar esta operación: cierra el formulario y vuelve a abrirlo"],
    ["POST", "/usage", { productId: crypto.randomUUID(), branchId: BRANCH, quantity: 1, patientId: "Ana", idempotencyKey: key }, undefined, "Elige el paciente"],
    ["POST", "/usage", { productId: crypto.randomUUID(), branchId: BRANCH, quantity: 0, idempotencyKey: key }, undefined, "La cantidad debe ser mayor que cero"],
    ["POST", `/lots/${crypto.randomUUID()}/adjust`, { counted: 3, reason: "porque", idempotencyKey: key }, undefined, "Elige por qué se ajusta"],
    ["POST", "/count", { branchId: BRANCH, items: [], idempotencyKey: key }, undefined, "Escribe lo que hay de al menos un producto"],
    ["POST", "/products/import/preview", { branchId: BRANCH, rows: [] }, undefined, "Pega al menos una fila"],
    ["POST", "/additions", { productId: crypto.randomUUID(), branchId: BRANCH, quantity: 1, reason: "robo", idempotencyKey: key }, undefined, "Elige por qué entra"],
  ] as const
  for (const [method, path, body, raw, message] of badBodies) {
    const res = await call(app, method, path, body, raw)
    expect(res.status, message).toBe(400)
    expectWords(res.body, message)
  }
})

it("el recorrido por la API: pedir, recibir y reintentar; lo que hay por sede; un uso con su clave no se duplica", async () => {
  const app = owner()
  const { product, order } = await orderedGloves("GNT-1")
  expect(order).toMatchObject({ currency: "CLP", status: "confirmada" })
  const again = await call(app, "POST", `/purchase-orders/${order.id}/confirm`)
  expect(again.status).toBe(409)
  expectWords(again.body, "La orden ya está confirmada: solo se confirma una orden en borrador")

  const reception = { idempotencyKey: crypto.randomUUID(), lines: [{ productId: product, quantity: 4 }] }
  expect((await call(app, "POST", `/purchase-orders/${order.id}/receive`, reception)).status).toBe(200)
  // La respuesta se perdió: el reintento devuelve lo aplicado aunque la orden ya esté completa.
  const retried = await call(app, "POST", `/purchase-orders/${order.id}/receive`, reception)
  expect(retried.status).toBe(200)
  expect(Data.parse(retried.body).data.status).toBe("recibida")

  const detail = z
    .object({ data: z.object({ onHand: z.number(), lots: z.array(z.object({ id: z.string(), code: z.string() }).passthrough()) }).passthrough() })
    .parse((await call(app, "GET", `/products/${product}?branchId=${BRANCH}`)).body).data
  // 4 cajas de 100 guantes.
  expect(detail.onHand).toBe(400)
  expect(detail.lots[0]?.code).toBe(`OC-${String(order.orderNumber).padStart(4, "0")}`)

  const usage = { productId: product, branchId: BRANCH, quantity: 3, patientId: PATIENT, idempotencyKey: crypto.randomUUID() }
  const first = await call(app, "POST", "/usage", usage)
  expect(first.status).toBe(201)
  const repeated = await call(app, "POST", "/usage", usage)
  expect(repeated.status).toBe(201)
  expect(Data.parse(repeated.body).data.replayed).toBe(true)
  const other = await call(app, "POST", "/usage", { ...usage, quantity: 1 })
  expect(other.status).toBe(409)
  expectWords(other.body, "Esto ya se registró con otros datos. Cierra y vuelve a abrir para registrarlo de nuevo.")
  const tooMuch = await call(app, "POST", "/usage", { ...usage, quantity: 1000, idempotencyKey: crypto.randomUUID() })
  expect(tooMuch.status).toBe(409)
  expectWords(tooMuch.body, "No alcanza: en Sede Centro hay 397 guantes.")

  const list = z
    .object({ data: z.object({ items: z.array(z.object({ id: z.string(), onHand: z.number(), state: z.string() }).passthrough()), counts: z.record(z.string(), z.number()) }) })
    .parse((await call(app, "GET", `/products?branchId=${BRANCH}&q=GNT-1`)).body).data
  expect(list.items.find((item) => item.id === product)).toMatchObject({ onHand: 397, state: "ok" })
  const movements = z
    .object({ data: z.object({ total: z.number(), items: z.array(z.object({ kind: z.string() }).passthrough()) }) })
    .parse((await call(app, "GET", `/movements?branchId=${BRANCH}&productId=${product}`)).body).data
  expect(movements.items.map((row) => row.kind)).toEqual(["consumo", "ingreso"])
})

process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { randomUUID } from "node:crypto"
import { createAppDb, createOwnerDb, type Db } from "@odentia/db"
import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Context } from "hono"
import { Hono, type Next } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import { z } from "zod"
import type { CrmDeps } from "./helpers.js"
import { createOrdersRoute } from "./orders.js"

// El pedido por la API real con PostgreSQL efímero (ADR 0170): Ventas vende con
// la receta vigente; el taller ve la copia de la receta y marca cómo va, sin
// anular ni rehacer, que mueven la caja; recepción ve cómo va, sin la receta ni
// el dinero; leer la copia queda en «Consultas a la historia».

const IMAGE = "dentalagent-postgres:18.6"
const ORG = "org_pedidos_api"
const BRANCH = "0c0c0c0c-0000-4000-8000-000000000001"
const PATIENT = "0c0c0c0c-0000-4000-8000-000000000002"
const PERSON = "0c0c0c0c-0000-4000-8000-000000000003"
const PRESCRIPTION = "0c0c0c0c-0000-4000-8000-000000000004"
const USERS = { owner: "u-ped-owner", sales: "u-ped-ventas", workshop: "u-ped-taller", reception: "u-ped-recep", cashier: "u-ped-caja" } as const
type Role = keyof typeof USERS

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db

const OrderBody = z.object({
  data: z.object({
    id: z.string(),
    status: z.string(),
    prescription: z.record(z.string(), z.unknown()).nullable(),
    prescriptionHidden: z.boolean(),
    dueCents: z.number().nullable(),
  }).passthrough(),
})
const ErrorShape = z.object({ error: z.object({ code: z.string(), message: z.string() }) })

function app(role: Role): Hono {
  const deps = { db: appDb } as unknown as CrmDeps
  const hono = new Hono()
  hono.use("*", async (c: Context, next: Next) => {
    c.set("orgId", ORG)
    c.set("userId", USERS[role])
    c.set("memberRole", role)
    await next()
  })
  hono.route("/orders", createOrdersRoute(deps))
  return hono
}

async function call(role: Role, method: string, path: string, body?: unknown) {
  const res = await app(role).request(`/orders${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: (await res.json()) as unknown }
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
  await ownerDb.execute(sql`insert into "organization" ("id", "name", "slug", "created_at") values (${ORG}, 'Óptica Pedidos', 'optica-pedidos', now())`)
  await ownerDb.execute(sql`
    insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale", "product")
    values (${ORG}, 'Óptica Pedidos', 'PE', 'PEN', 'America/Lima', 'es-PE', 'optical')`)
  for (const [role, id] of Object.entries(USERS)) {
    await ownerDb.execute(sql`insert into "user" ("id", "name", "email") values (${id}, ${`Equipo ${role}`}, ${`${id}@example.test`})`)
    await ownerDb.execute(sql`insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values (${`m-${id}`}, ${ORG}, ${id}, ${role}, now())`)
  }
  await ownerDb.execute(sql`insert into "branch" ("id", "organization_id", "name") values (${BRANCH}::uuid, ${ORG}, 'Sede Centro')`)
  await ownerDb.execute(sql`insert into "contact" ("id", "organization_id", "display_name") values (${PERSON}::uuid, ${ORG}, 'Cliente Pedidos')`)
  await ownerDb.execute(sql`insert into "patient" ("id", "organization_id", "person_id", "patient_number") values (${PATIENT}::uuid, ${ORG}, ${PERSON}::uuid, 1)`)
  await ownerDb.execute(sql`
    insert into optical.lens_prescription
      (id, organization_id, patient_id, kind, source, lenses, issued_on, valid_until, prescriber_name, verified_at)
    values (${PRESCRIPTION}::uuid, ${ORG}, ${PATIENT}::uuid, 'anteojos', 'externa', '{"od":{"esfera":-1.5},"oi":{"esfera":-1.25}}'::jsonb,
      current_date - 10, current_date + 300, 'Dra. Ana Ruiz', now())`)
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

async function sale(role: Role = "sales") {
  const promisedOn = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
  return call(role, "POST", "/sale", {
    patientId: PATIENT,
    branchId: BRANCH,
    requestId: randomUUID(),
    title: "Anteojos monofocales",
    maker: "Laboratorio Visión Andina",
    promisedOn,
    lines: [{ kind: "lunas", description: "Lunas monofocales", amountCents: 20_000 }],
    referenceId: PRESCRIPTION,
    fitting: { alturaOd: 18, alturaOi: 18 },
  })
}

it("Ventas vende con la receta vigente y ve lo que falta pagar", async () => {
  const sold = await sale()
  expect(sold.status).toBe(201)
  const order = z.object({ data: z.object({ order: OrderBody.shape.data, ticketId: z.string().nullable() }) }).parse(sold.body).data.order
  expect(order).toMatchObject({ status: "por_enviar", prescriptionHidden: false, dueCents: 20_000 })
  expect(order.prescription).toMatchObject({ id: PRESCRIPTION, verified: true })
})

it("el taller ve la copia de la receta y marca cómo va, pero no anula ni rehace, ni ve el dinero", async () => {
  const id = z.object({ data: z.object({ order: z.object({ id: z.string() }) }) }).parse((await sale()).body).data.order.id
  const seen = await call("workshop", "GET", `/${id}`)
  expect(seen.status).toBe(200)
  const order = OrderBody.parse(seen.body).data
  expect(order.prescription).toMatchObject({ id: PRESCRIPTION })
  expect(order.dueCents).toBeNull()
  // Leer la copia de la receta queda en «Consultas a la historia».
  const [traced] = (await ownerDb.execute(sql`select count(*)::int as n from clinical_access_log
    where organization_id = ${ORG} and user_id = ${USERS.workshop} and patient_id = ${PATIENT}::uuid`)) as unknown as Array<{ n: number }>
  expect(traced?.n).toBeGreaterThan(0)
  expect((await call("workshop", "POST", `/${id}/advance`, { status: "en_laboratorio" })).status).toBe(200)
  const voided = await call("workshop", "POST", `/${id}/void`, { reason: "No" })
  expect(voided.status).toBe(403)
  expect(ErrorShape.parse(voided.body).error.code).toBe("FORBIDDEN")
  const remade = await call("workshop", "POST", `/${id}/remake`, { reason: "Se rompió", promisedOn: "2099-01-01", requestId: randomUUID() })
  expect(remade.status).toBe(403)
  // El taller no vende: le falta la caja.
  expect((await sale("workshop")).status).toBe(403)
})

it("recepción ve cómo va, sin la receta ni el dinero, y no lo cambia; la caja lo anula", async () => {
  const id = z.object({ data: z.object({ order: z.object({ id: z.string() }) }) }).parse((await sale()).body).data.order.id
  const seen = OrderBody.parse((await call("reception", "GET", `/${id}`)).body).data
  expect(seen).toMatchObject({ prescription: null, prescriptionHidden: true, dueCents: null })
  expect((await call("reception", "POST", `/${id}/advance`, { status: "listo" })).status).toBe(403)
  const list = await call("reception", "GET", "?status=abiertos")
  expect(list.status).toBe(200)
  expect(JSON.stringify(list.body)).not.toContain('"lenses"')
  const voided = await call("cashier", "POST", `/${id}/void`, { reason: "Se arrepintió" })
  expect(voided.status).toBe(200)
  expect(OrderBody.parse(voided.body).data.status).toBe("anulado")
})

it("lo mal formado responde con palabras, nunca un 500", async () => {
  const bad = await call("sales", "POST", "/sale", { patientId: PATIENT })
  expect(bad.status).toBe(400)
  expect((await call("sales", "GET", "/no-es-un-id")).status).toBe(404)
  expect((await call("sales", "GET", "?status=cualquiera")).status).toBe(400)
})

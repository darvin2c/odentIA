process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { randomUUID } from "node:crypto"
import { createAppDb, createOwnerDb, type Db } from "@odentia/db"
import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Context } from "hono"
import { Hono, type Next } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import { createFinanceRoute } from "./finance.js"
import type { CrmDeps } from "./helpers.js"

// La venta de mostrador por la API real con PostgreSQL efímero (ADR 0172): la
// vende quien cobra (`finance.write`), con el cuerpo exacto; recepción y quien
// atiende no la ven; su ticket se abre, se imprime y se anula sin ficha.

const IMAGE = "dentalagent-postgres:18.6"
const ORG = "org_mostrador_api"
const BRANCH = "0d0d0d0d-0000-4000-8000-000000000001"
const PRODUCT = "0d0d0d0d-0000-4000-8000-000000000002"
const METHOD = "0d0d0d0d-0000-4000-8000-000000000003"
const PERSON = "0d0d0d0d-0000-4000-8000-000000000004"
const USERS = { owner: "u-mos-owner", cashier: "u-mos-caja", reception: "u-mos-recep", clinician: "u-mos-clin" } as const
type Role = keyof typeof USERS

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db

function app(role: Role): Hono {
  const deps = { db: appDb } as unknown as CrmDeps
  const hono = new Hono()
  hono.use("*", async (c: Context, next: Next) => {
    c.set("orgId", ORG)
    c.set("userId", USERS[role])
    c.set("memberRole", role)
    await next()
  })
  hono.route("/finance", createFinanceRoute(deps))
  return hono
}

async function call(role: Role, method: string, path: string, body?: unknown) {
  const res = await app(role).request(`/finance${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const type = res.headers.get("content-type") ?? ""
  // biome-ignore lint/suspicious/noExplicitAny: la prueba lee el cuerpo tal como llega
  return { status: res.status, type, body: type.includes("json") ? ((await res.json()) as any) : null }
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
  await ownerDb.execute(sql`insert into "organization" ("id", "name", "slug", "created_at") values (${ORG}, 'Óptica Mostrador', 'optica-mostrador', now())`)
  await ownerDb.execute(sql`
    insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale", "product")
    values (${ORG}, 'Óptica Mostrador', 'PE', 'PEN', 'America/Lima', 'es-PE', 'optical')`)
  for (const [role, id] of Object.entries(USERS)) {
    await ownerDb.execute(sql`insert into "user" ("id", "name", "email") values (${id}, ${`Equipo ${role}`}, ${`${id}@example.test`})`)
    await ownerDb.execute(sql`insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values (${`m-${id}`}, ${ORG}, ${id}, ${role}, now())`)
  }
  await ownerDb.execute(sql`insert into "branch" ("id", "organization_id", "name") values (${BRANCH}::uuid, ${ORG}, 'Sede Centro')`)
  await ownerDb.execute(sql`
    insert into "organization_payment_method" ("id", "organization_id", "name", "type_code")
    values (${METHOD}::uuid, ${ORG}, 'Efectivo', '10')`)
  await ownerDb.execute(sql`
    insert into "product" ("id", "organization_id", "sku", "name", "unit", "used_in_care", "for_sale", "sale_price_cents", "sale_currency")
    values (${PRODUCT}::uuid, ${ORG}, 'LENTES-SOL', 'Lentes de sol', 'unidad', false, true, 9000, 'PEN')`)
  await ownerDb.execute(sql`insert into "contact" ("id", "organization_id", "display_name") values (${PERSON}::uuid, ${ORG}, 'Lucía Ramos')`)
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

const body = (extra: Record<string, unknown> = {}) => ({
  branchId: BRANCH,
  requestId: randomUUID(),
  lines: [{ productId: PRODUCT }],
  payments: [{ paymentMethodId: METHOD, amountCents: 9000 }],
  cashReceivedCents: 10000,
  ...extra,
})

it("solo quien cobra vende en el mostrador, con el cuerpo exacto", async () => {
  expect((await call("reception", "POST", "/counter-sales", body())).status).toBe(403)
  expect((await call("clinician", "POST", "/counter-sales", body())).status).toBe(403)
  const extra = await call("cashier", "POST", "/counter-sales", body({ patientId: randomUUID() }))
  expect(extra.status).toBe(400)
  const both = await call("cashier", "POST", "/counter-sales", body({ contactId: PERSON, buyerName: "Otra persona" }))
  expect(both).toMatchObject({ status: 400, body: { error: { fields: { buyerName: expect.stringContaining("no los dos") } } } })
  const empty = await call("cashier", "POST", "/counter-sales", body({ lines: [] }))
  expect(empty).toMatchObject({ status: 400, body: { error: { message: "Agrega lo que se vende" } } })
  const short = await call("cashier", "POST", "/counter-sales", body({ payments: [{ paymentMethodId: METHOD, amountCents: 5000 }], cashReceivedCents: 5000 }))
  expect(short).toMatchObject({ status: 409, body: { error: { code: "COUNTER_SALE_SHORT" } } })
})

it("el ticket sin ficha se abre, se imprime, se devuelve y se anula por su id", async () => {
  // Caja solo ve a los pacientes: quien no lo es no se elige como quien compra (se le escribe el nombre).
  const unseen = await call("cashier", "POST", "/counter-sales", body({ contactId: PERSON }))
  expect(unseen).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND" } } })
  const request = body({ contactId: PERSON })
  const sold = await call("owner", "POST", "/counter-sales", request)
  expect(sold.status).toBe(201)
  const ticket = sold.body.data.ticket
  expect(ticket).toMatchObject({ patientId: null, buyerContactId: PERSON, totalCents: 9000, changeCents: 1000 })
  expect(ticket.snapshot.buyer).toEqual({ contactId: PERSON, displayName: "Lucía Ramos" })
  // El mismo pedido otra vez: el mismo ticket.
  const again = await call("cashier", "POST", "/counter-sales", request)
  expect(again.status).toBe(201)
  expect(again.body.data).toMatchObject({ duplicate: true, ticket: { id: ticket.id } })

  const opened = await call("cashier", "GET", `/tickets/${ticket.id}`)
  expect(opened).toMatchObject({ status: 200, body: { data: { patientId: null, ticket: { id: ticket.id } } } })
  // Recepción no ve la caja.
  expect((await call("reception", "GET", `/tickets/${ticket.id}`)).status).toBe(403)
  const pdf = await call("cashier", "GET", `/counter-sales/${ticket.id}/pdf`)
  expect(pdf).toMatchObject({ status: 200, type: "application/pdf" })
  expect((await call("cashier", "GET", `/counter-sales/${ticket.id}/pdf?paper=A4`)).status).toBe(200)
  const returnable = await call("cashier", "GET", `/counter-sales/${ticket.id}/returnable`)
  expect(returnable.status).toBe(200)
  const [line] = returnable.body.data.lines
  // Sin medio no hay a dónde devolverlo: la API lo pide.
  const noMethod = await call("cashier", "POST", `/counter-sales/${ticket.id}/returns`, {
    branchId: BRANCH,
    lines: [{ chargeId: line.chargeId, quantity: 1 }],
    paymentMethodId: null,
    reason: "No le quedaron",
    requestId: randomUUID(),
  })
  expect(noMethod.status).toBe(400)
  expect((await call("reception", "POST", `/counter-sales/${ticket.id}/void`, { reason: "Error" })).status).toBe(403)

  // Otra venta que se anula: el ticket queda marcado.
  const other = await call("cashier", "POST", "/counter-sales", body())
  const voided = await call("cashier", "POST", `/counter-sales/${other.body.data.ticket.id}/void`, { reason: "Se cobró dos veces" })
  expect(voided).toMatchObject({ status: 200, body: { data: { account: null, ticket: { voidReason: "Se cobró dos veces" } } } })

  const back = await call("owner", "POST", `/counter-sales/${ticket.id}/returns`, {
    branchId: BRANCH,
    lines: [{ chargeId: line.chargeId, quantity: 1 }],
    paymentMethodId: METHOD,
    reason: "No le quedaron",
    requestId: randomUUID(),
  })
  expect(back).toMatchObject({ status: 201, body: { data: { paymentReturn: { outcome: "pagado", patientId: null } } } })
  const returnPdf = await call("owner", "GET", `/counter-sales/${ticket.id}/returns/${back.body.data.paymentReturn.id}/pdf`)
  expect(returnPdf).toMatchObject({ status: 200, type: "application/pdf" })
  // La devolución de otro ticket no se abre por este.
  expect((await call("owner", "GET", `/counter-sales/${other.body.data.ticket.id}/returns/${back.body.data.paymentReturn.id}/pdf`)).status).toBe(404)

  // La lista de Cobros la muestra con quien compró.
  const list = await call("cashier", "GET", `/tickets?branchId=${BRANCH}`)
  expect(list.body.data.data.find((row: { id: string }) => row.id === ticket.id)).toMatchObject({
    patientId: null,
    buyerContactId: PERSON,
    displayName: "Lucía Ramos",
  })
})

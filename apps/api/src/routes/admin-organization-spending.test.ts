process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import type { Auth } from "@odentia/auth"
import { createAppDb, createOwnerDb, type Db } from "@odentia/db"
import { adminSessionVerification, adminStaff, twoFactor } from "@odentia/db/schema/admin-core"
import { aiUsage } from "@odentia/db/schema/agent"
import { organization } from "@odentia/db/schema/auth"
import { saasAction, saasPlan, saasSubscription } from "@odentia/db/schema/saas-billing"
import { type Storage, secretsKeyFromEnv } from "@odentia/services"
import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Hono } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import { createApp } from "../app.js"

/**
 * La ficha de una clínica en la administración contra la app real
 * (lienzo «Gastos por organización», ADR 0094): la administración ve cada
 * acción con su costo y su detalle; soporte ve cuántas cosas hicieron los
 * agentes, sin importes, y no abre ni cambia el precio ni la prueba.
 */

const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("ee".repeat(32))
const ADMIN = "https://admin.odentia.localhost"
const ORG = "org-gastos"

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db
let app: Hono
let actionId: string

const authStub = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const id = headers.get("x-test-user")
      if (!id) return null
      return {
        user: { id, email: `${id}@example.test`, emailVerified: true, name: id },
        session: { id: `s-${id}`, createdAt: new Date() },
      }
    },
  },
} as unknown as Auth

function call(path: string, user: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-test-user", user)
  headers.set("origin", ADMIN)
  if (init.body) headers.set("content-type", "application/json")
  return app.request(`/api/admin${path}`, { ...init, headers })
}

async function staff(id: string, role: "admin" | "support") {
  await ownerDb.execute(
    sql`insert into "user" (id, name, email, email_verified) values (${id}, ${id}, ${`${id}@example.test`}, true)`,
  )
  await ownerDb.insert(adminStaff).values({ userId: id, role })
  await ownerDb
    .insert(twoFactor)
    .values({ id: `f-${id}`, userId: id, secret: "x", backupCodes: "[]", verified: true })
  await ownerDb.insert(adminSessionVerification).values({
    userId: id,
    sessionId: `s-${id}`,
    factorId: `f-${id}`,
    method: "totp",
    expiresAt: new Date(Date.now() + 3_600_000),
  })
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
  const url = `${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`
  ownerDb = createOwnerDb(`postgres://dentalagent:dentalagent@${url}`)
  await migrate(ownerDb, { migrationsFolder: "../../packages/db/drizzle" })
  appDb = createAppDb(`postgres://dentalagent_app:dentalagent_app@${url}`)
  app = createApp({
    auth: authStub,
    db: appDb,
    ownerDb,
    secretsKey: KEY,
    storage: {} as unknown as Storage,
    validateExternal: false,
    webhookBaseUrl: "https://api.example.com",
    trustedOrigins: [ADMIN],
    cookieDomain: "odentia.localhost",
    webURL: "https://app.odentia.localhost",
    adminURL: ADMIN,
    mailer: { send: async () => {} },
    listenUrl: "postgres://localhost:5432/dentalagent",
  })
  await staff("u-admin", "admin")
  await staff("u-soporte", "support")

  const now = Date.now()
  await ownerDb
    .insert(organization)
    .values({ id: ORG, name: "Dental Gastos", slug: "dental-gastos", createdAt: new Date() })
  const [plan] = await ownerDb
    .insert(saasPlan)
    .values({
      code: "gastos",
      name: "Plan odentIA",
      currency: "USD",
      priceCents: 2900,
      creditCents: 2900,
      conversationMicros: 500_000,
      consultationMicros: 500_000,
      trialCreditCents: 0,
      trialMaxCreditCents: 0,
    })
    .returning()
  // La organización nace con su suscripción: se deja activa en su mes.
  const active = {
    status: "activa",
    isDemo: false,
    planId: plan!.id,
    activatedAt: new Date(now - 10 * 86_400_000),
    currentPeriodStart: new Date(now - 10 * 86_400_000),
    currentPeriodEnd: new Date(now + 20 * 86_400_000),
    // Un precio negociado: lo ve la administración, no soporte.
    discountBps: 1000,
  }
  await ownerDb
    .insert(saasSubscription)
    .values({ organizationId: ORG, ...active })
    .onConflictDoUpdate({ target: saasSubscription.organizationId, set: active })
  const [row] = await ownerDb
    .insert(saasAction)
    .values({
      organizationId: ORG,
      kind: "consulta",
      tier: "simple",
      occurredAt: new Date(now - 86_400_000),
      encounterId: crypto.randomUUID(),
      detail: "Dejó lista una cosa de la consulta dictada",
      currency: "USD",
      basePriceMicros: 100_000,
      priceMicros: 100_000,
      dedupeKey: "gastos:1",
    })
    .returning({ id: saasAction.id, encounterId: saasAction.encounterId })
  actionId = row!.id
  await ownerDb.insert(aiUsage).values({
    organizationId: ORG,
    origin: "dictado",
    provider: "openai",
    model: "gpt-6-luna",
    calls: 1,
    costMicros: 300,
    encounterId: row!.encounterId,
    createdAt: new Date(now - 86_400_000 - 60_000),
  })
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

it("la administración ve cada acción con su costo y lo que la compone", async () => {
  const list = await call(`/billing/cost-margin/${ORG}/actions?agente=clio`, "u-admin")
  expect(list.status).toBe(200)
  const body = (await list.json()) as {
    data: {
      items: Array<{ key: string; costMicros: number; chargedMicros: number }>
      counts: { clio: number }
    }
  }
  expect(body.data.items).toEqual([
    expect.objectContaining({ key: `a:${actionId}`, costMicros: 300, chargedMicros: 100_000 }),
  ])
  expect(body.data.counts.clio).toBe(1)
  const detail = await call(`/billing/cost-margin/${ORG}/actions/a:${actionId}`, "u-admin")
  expect(detail.status).toBe(200)
  expect(
    ((await detail.json()) as { data: { steps: Array<{ costMicros: number }> } }).data.steps,
  ).toEqual([expect.objectContaining({ costMicros: 300 })])
  expect((await call(`/billing/cost-margin/${ORG}/actions/otra-cosa`, "u-admin")).status).toBe(400)
  expect((await call(`/billing/cost-margin/${ORG}/actions?agente=nadie`, "u-admin")).status).toBe(
    400,
  )
})

it("soporte ve cuántas cosas hicieron los agentes, sin importes, y no abre el precio ni los gastos", async () => {
  const counts = await call(`/organizations/${ORG}/agents`, "u-soporte")
  expect(counts.status).toBe(200)
  const text = await counts.text()
  expect(JSON.parse(text).data).toMatchObject({ clio: { consultations: 1, byTier: { simple: 1 } } })
  expect(text).not.toMatch(/Micros|Cents/)
  expect((await call(`/organizations/${ORG}/billing`, "u-soporte")).status).toBe(403)
  expect(
    (
      await call(`/organizations/${ORG}/billing/discount`, "u-soporte", {
        method: "POST",
        body: JSON.stringify({ discountBps: 500 }),
      })
    ).status,
  ).toBe(403)
  expect(
    (
      await call(`/organizations/${ORG}/billing/trial`, "u-soporte", {
        method: "POST",
        body: JSON.stringify({ trialCreditCents: 0, trialDays: 7 }),
      })
    ).status,
  ).toBe(403)
  expect(
    (
      await call(`/organizations/${ORG}/billing/cycle`, "u-soporte", {
        method: "POST",
        body: JSON.stringify({ cycle: "mensual" }),
      })
    ).status,
  ).toBe(403)
  expect((await call(`/billing/cost-margin/${ORG}/actions`, "u-soporte")).status).toBe(403)
  expect(
    (await call(`/billing/cost-margin/${ORG}/actions/a:${actionId}`, "u-soporte")).status,
  ).toBe(403)
  // La administración sí abre el precio.
  expect((await call(`/organizations/${ORG}/billing`, "u-admin")).status).toBe(200)
})

it("el precio negociado de la lista es de la administración: soporte no lo ve ni filtra por él", async () => {
  type List = { data: { items: Array<{ id: string; negotiated: { discountBps: number } | null }> } }
  const listed = async (user: string, query = "") =>
    (
      (await (await call(`/organizations?q=dental-gastos${query}`, user)).json()) as List
    ).data.items.find((item) => item.id === ORG)
  expect((await listed("u-admin"))?.negotiated).toMatchObject({ discountBps: 1000 })
  expect((await listed("u-soporte"))?.negotiated).toBeNull()
  // Con el filtro de las negociadas tampoco aparece el descuento.
  expect(await listed("u-soporte", "&negotiated=1")).toMatchObject({ id: ORG, negotiated: null })
})

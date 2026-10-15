// Testcontainers usa el socket Podman compartido en /mnt/wsl (ver rls.test.ts).
process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import type { Auth } from "@odentia/auth"
import { createAppDb, createOwnerDb, type Db } from "@odentia/db"
import { type Storage, secretsKeyFromEnv } from "@odentia/services"
import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Hono } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import { createApp } from "./app.js"

/**
 * Datos de la clínica, impresión y sedes contra la app real (`createApp`): los
 * guards de sesión y de organización siguen en el camino; solo se simula la
 * búsqueda de la sesión.
 */

const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("ee".repeat(32))
const ORG = "org_settings_a"
const SLUG = "ajustes"
const OTHER_ORG = "org_settings_b"
const OTHER_SLUG = "ajena"

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db
let app: Hono
let branchId = ""

type Who = "owner" | "reception" | "other"
const SESSIONS: Record<Who, { userId: string; activeOrg: string }> = {
  owner: { userId: "u-set-owner", activeOrg: ORG },
  reception: { userId: "u-set-reception", activeOrg: ORG },
  other: { userId: "u-set-other", activeOrg: OTHER_ORG },
}

const authStub = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const who = headers.get("x-test-session") as Who | null
      const found = who ? SESSIONS[who] : undefined
      if (!found) return null
      return {
        user: { id: found.userId, image: null },
        session: { activeOrganizationId: found.activeOrg },
      }
    },
  },
} as unknown as Auth

const unused = async () => {
  throw new Error("no usado")
}
const storageStub = {
  putAvatar: unused,
  deleteByUrl: async () => {},
  putAttachment: unused,
  attachmentUrl: unused,
  deleteAttachment: async () => {},
  putPatientDocument: unused,
  putPatientAvatar: unused,
} as unknown as Storage

function request(who: Who, method: string, path: string, body?: unknown) {
  return app.request(`/api${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-test-session": who,
      "x-odentia-org": who === "other" ? OTHER_SLUG : SLUG,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function data<T>(response: Response): Promise<T> {
  return ((await response.json()) as { data: T }).data
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
  const host = `${container.getHost()}:${container.getMappedPort(5432)}`
  ownerDb = createOwnerDb(`postgres://dentalagent:dentalagent@${host}/dentalagent`)
  await migrate(ownerDb, { migrationsFolder: "../../packages/db/drizzle" })
  appDb = createAppDb(`postgres://dentalagent_app:dentalagent_app@${host}/dentalagent`)
  await ownerDb.execute(sql`
    insert into "organization" ("id", "name", "slug", "created_at") values
      (${ORG}, 'Clínica Ajustes', ${SLUG}, now()),
      (${OTHER_ORG}, 'Clínica Ajena', ${OTHER_SLUG}, now())`)
  await ownerDb.execute(sql`
    insert into "user" ("id", "name", "email") values
      ('u-set-owner', 'Olga Propietaria', 'u-set-owner@example.test'),
      ('u-set-reception', 'Rita Recepción', 'u-set-reception@example.test'),
      ('u-set-other', 'Otra Clínica', 'u-set-other@example.test')`)
  await ownerDb.execute(sql`
    insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values
      ('m-set-owner', ${ORG}, 'u-set-owner', 'owner', now()),
      ('m-set-reception', ${ORG}, 'u-set-reception', 'reception', now()),
      ('m-set-other', ${OTHER_ORG}, 'u-set-other', 'owner', now())`)
  const [row] = await ownerDb.execute<{ id: string }>(sql`
    insert into "branch" ("organization_id", "name") values (${ORG}, 'Sede Central') returning "id"`)
  branchId = row?.id ?? ""
  app = createApp({
    auth: authStub,
    db: appDb,
    ownerDb,
    secretsKey: KEY,
    storage: storageStub,
    validateExternal: false,
    webhookBaseUrl: "https://api.example.com",
    trustedOrigins: [],
    cookieDomain: "odentia.localhost",
    webURL: "https://app.odentia.localhost",
    adminURL: "https://admin.odentia.localhost",
    mailer: { send: async () => { throw new Error("Correo no esperado en este recorrido") } },
    listenUrl: "postgres://localhost:5432/dentalagent",
  })
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

interface Profile {
  legalName: string
  tradeName: string | null
  fiscalDocNumber: string | null
  fiscalAddress: string | null
  billingEmail: string | null
  countryCode: string
  currency: string
  timezone: string
  locale: string
  receiptWidth: string
  sheetSize: string
  ticketFooter: string
}

it("datos de la clínica: vaciar un dato lo guarda vacío y lo que la pantalla ya no envía se conserva", async () => {
  const region = { countryCode: "PE", currency: "PEN", timezone: "America/Lima", locale: "es-PE" }
  const created = await request("owner", "PUT", "/org-profile", {
    legalName: "Clínica Ajustes S.A.C.",
    tradeName: "Ajustes",
    fiscalDocNumber: "20123456789",
    fiscalAddress: "Av. Central 123",
    billingEmail: "cobros@example.test",
    ...region,
  })
  expect(created.status).toBe(200)
  // Al crear la clínica viene prendida «Recordar la cita», a nombre de quien la crea, y nada más (ADR 0026).
  const lines = await ownerDb.execute<{ kind: string; enabled: boolean; enabled_by: string | null }>(
    sql`select kind, enabled, enabled_by from automation_rule where organization_id = ${ORG}`,
  )
  expect([...lines].map((row) => [row.kind, row.enabled, row.enabled_by])).toEqual([["recordatorio_cita", true, "u-set-owner"]])

  // La pantalla ya no muestra el correo de facturación: no lo envía y no se borra.
  const saved = await request("owner", "PUT", "/org-profile", {
    legalName: "Clínica Ajustes S.A.C.",
    tradeName: null,
    fiscalDocType: null,
    fiscalDocNumber: null,
    fiscalAddress: "Av. Central 456",
    ...region,
  })
  expect(saved.status).toBe(200)
  expect(await data<Profile>(saved)).toMatchObject({
    tradeName: null,
    fiscalDocNumber: null,
    fiscalAddress: "Av. Central 456",
    billingEmail: "cobros@example.test",
    // Tampoco envía la impresión: queda como estaba.
    receiptWidth: "80",
    ticketFooter: "Recibo interno. No es un documento fiscal.",
  })

  // Recepción lee el perfil (lo usa la agenda), pero no lo cambia.
  expect((await request("reception", "GET", "/org-profile")).status).toBe(200)
  expect(
    (await request("reception", "PUT", "/org-profile", { legalName: "Otra", ...region })).status,
  ).toBe(403)

  // Al elegir país se ofrecen sus formatos, el propuesto primero.
  const defaults = await request("owner", "GET", "/org-profile/region-defaults?countryCode=CL")
  expect(
    await data<{ locale: string; locales: string[]; currency: string }>(defaults),
  ).toMatchObject({
    currency: "CLP",
    locale: "es-CL",
    locales: expect.arrayContaining(["es-CL", "en-CL"]),
  })
})

it("impresión: se guarda aparte de los datos de la clínica y solo la cambia quien configura", async () => {
  const printing = {
    receiptWidth: "58",
    sheetSize: "Letter",
    ticketFooter: "  Gracias por su visita.  ",
  }
  expect((await request("reception", "PUT", "/org-profile/printing", printing)).status).toBe(403)
  expect(
    (await request("owner", "PUT", "/org-profile/printing", { ...printing, receiptWidth: "72" }))
      .status,
  ).toBe(400)
  expect(
    (await request("owner", "PUT", "/org-profile/printing", { ...printing, ticketFooter: "   " }))
      .status,
  ).toBe(400)
  // Sin perfil no hay dónde guardarla: se dice, no se crea uno a medias.
  expect((await request("other", "PUT", "/org-profile/printing", printing)).status).toBe(404)

  const saved = await request("owner", "PUT", "/org-profile/printing", printing)
  expect(saved.status).toBe(200)
  expect(await data<Profile>(saved)).toMatchObject({
    receiptWidth: "58",
    sheetSize: "Letter",
    ticketFooter: "Gracias por su visita.",
    legalName: "Clínica Ajustes S.A.C.",
    countryCode: "PE",
    currency: "PEN",
    timezone: "America/Lima",
    locale: "es-PE",
  })
})

it("sedes: desactivar y reactivar exigen configuración y no cruzan de organización", async () => {
  const isActive = async () =>
    (
      await data<Array<{ id: string; isActive: boolean }>>(
        await request("owner", "GET", "/branches"),
      )
    ).find((row) => row.id === branchId)?.isActive

  expect((await request("reception", "DELETE", `/branches/${branchId}`)).status).toBe(403)
  expect((await request("reception", "POST", `/branches/${branchId}/reactivate`)).status).toBe(403)
  // Otra clínica no la encuentra aunque conozca su identificador.
  expect((await request("other", "DELETE", `/branches/${branchId}`)).status).toBe(404)
  expect((await request("other", "POST", `/branches/${branchId}/reactivate`)).status).toBe(404)
  expect(await isActive()).toBe(true)

  const off = await request("owner", "DELETE", `/branches/${branchId}`)
  expect(off.status).toBe(200)
  expect(await data(off)).toEqual({ id: branchId, isActive: false })
  expect(await isActive()).toBe(false)

  const on = await request("owner", "POST", `/branches/${branchId}/reactivate`)
  expect(on.status).toBe(200)
  expect(await data(on)).toEqual({ id: branchId, isActive: true })
  expect(await isActive()).toBe(true)

  const missing = await request("owner", "POST", `/branches/${crypto.randomUUID()}/reactivate`)
  expect(missing.status).toBe(404)
  expect(await missing.json()).toMatchObject({
    error: { code: "NOT_FOUND", message: "Sede no encontrada" },
  })
})

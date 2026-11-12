// Testcontainers usa el socket Podman compartido en /mnt/wsl (ver rls.test.ts).
process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import type { Auth } from "@odentia/auth"
import { createAppDb, createOwnerDb, type Db } from "@odentia/db"
import { isInAvatarFolder, type Storage, secretsKeyFromEnv } from "@odentia/services"
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

type Who = "owner" | "reception" | "cashier" | "other"
const SESSIONS: Record<Who, { userId: string; activeOrg: string }> = {
  owner: { userId: "u-set-owner", activeOrg: ORG },
  reception: { userId: "u-set-reception", activeOrg: ORG },
  cashier: { userId: "u-set-cashier", activeOrg: ORG },
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
const deleted: Array<{ url: string; folder: string }> = []
/** La hoja membretada: su PDF en el bucket privado y sus franjas en el público. */
const privateObjects = new Map<string, Uint8Array>()
const publicImages: string[] = []
const storageStub = {
  putAvatar: async ({ userId, ext }: { userId: string; ext: string }) => {
    const key = `avatars/${userId}/${publicImages.length}.${ext}`
    publicImages.push(key)
    return { key, url: `https://cdn.example.com/${key}` }
  },
  putAttachmentAt: async (key: string, bytes: Uint8Array) => {
    privateObjects.set(key, bytes)
  },
  getAttachment: async (key: string) => {
    const bytes = privateObjects.get(key)
    if (!bytes) throw new Error("no está")
    return bytes
  },
  deleteByUrl: async (url: string, folder: string) => {
    deleted.push({ url, folder })
  },
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
      ('u-set-cashier', 'Carla Caja', 'u-set-cashier@example.test'),
      ('u-set-other', 'Otra Clínica', 'u-set-other@example.test')`)
  await ownerDb.execute(sql`
    insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values
      ('m-set-owner', ${ORG}, 'u-set-owner', 'owner', now()),
      ('m-set-reception', ${ORG}, 'u-set-reception', 'reception', now()),
      ('m-set-cashier', ${ORG}, 'u-set-cashier', 'cashier', now()),
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
    productDomains: { medical: "latidia.localhost", optical: "vistia.localhost" },
    webURL: "https://app.odentia.localhost",
    adminURL: "https://admin.odentia.localhost",
    mailer: { send: async () => { throw new Error("Correo no esperado en este recorrido") } },
    listenUrl: "postgres://localhost:5432/dentalagent",
    vapidPublicKey: "BPublicaDePrueba",
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
  countryCode: string
  currency: string
  timezone: string
  locale: string
  receiptWidth: string
  sheetSize: string
  ticketFooter: string
  taxLegalForm?: string | null
  servicesTaxCategory?: string | null
  servicesTaxBps?: number | null
  productsTaxCategory?: string | null
  productsTaxBps?: number | null
}

it("datos de la clínica: vaciar un dato lo guarda vacío, lo que no se envía se conserva y el nombre comercial es el de la cuenta", async () => {
  const region = { countryCode: "PE", currency: "PEN", timezone: "America/Lima", locale: "es-PE" }
  // Al crear la clínica la razón social es obligatoria: sin ella no nace el perfil.
  const nameless = await request("owner", "PUT", "/org-profile", { tradeName: "Ajustes", ...region })
  expect(nameless.status).toBe(400)
  expect(await nameless.json()).toMatchObject({ error: { fields: { legalName: "Escribe la razón social" } } })
  const created = await request("owner", "PUT", "/org-profile", {
    legalName: "Clínica Ajustes S.A.C.",
    tradeName: "Ajustes",
    fiscalDocNumber: "20123456789",
    fiscalAddress: "Av. Central 123",
    ...region,
  })
  expect(created.status).toBe(200)
  // Un solo nombre visible (decisión 19): el nombre comercial es también el de la cuenta.
  const [account] = await ownerDb.execute<{ name: string }>(sql`select name from organization where id = ${ORG}`)
  expect(account?.name).toBe("Ajustes")
  // Esta ya tenía una sede: no es una clínica que nace, y no se enciende nada (ADR 0141).
  const lines = await ownerDb.execute<{ kind: string }>(sql`select kind from automation_rule where organization_id = ${ORG}`)
  expect([...lines]).toEqual([])

  // El nombre comercial es obligatorio: vacío no se acepta; si no se envía, queda como estaba.
  const blank = await request("owner", "PUT", "/org-profile", { legalName: "Clínica Ajustes S.A.C.", tradeName: "  ", ...region })
  expect(blank.status).toBe(400)
  const saved = await request("owner", "PUT", "/org-profile", {
    legalName: "Clínica Ajustes S.A.C.",
    fiscalDocType: null,
    fiscalDocNumber: null,
    fiscalAddress: "Av. Central 456",
    ...region,
  })
  expect(saved.status).toBe(200)
  expect(await data<Profile>(saved)).toMatchObject({
    tradeName: "Ajustes",
    fiscalDocNumber: null,
    fiscalAddress: "Av. Central 456",
    // Tampoco envía la impresión: queda como estaba.
    receiptWidth: "80",
    ticketFooter: "Recibo interno. No es un documento fiscal.",
  })

  // Dos personas con la pantalla abierta: cada una envía solo lo que cambió y no pisa lo de la otra.
  expect((await request("owner", "PUT", "/org-profile", { fiscalAddress: "Av. Norte 1" })).status).toBe(200)
  const other = await request("owner", "PUT", "/org-profile", { tradeName: "Ajustes Norte" })
  expect(await data<Profile>(other)).toMatchObject({
    legalName: "Clínica Ajustes S.A.C.",
    tradeName: "Ajustes Norte",
    fiscalAddress: "Av. Norte 1",
  })

  // Recepción lee el perfil (lo usa la agenda), pero no lo cambia.
  expect((await request("reception", "GET", "/org-profile")).status).toBe(200)
  expect(
    (await request("reception", "PUT", "/org-profile", { legalName: "Otra", ...region })).status,
  ).toBe(403)

  // Al elegir país se propone lo suyo; el formato es siempre el español del país (#48).
  const defaults = await request("owner", "GET", "/org-profile/region-defaults?countryCode=BR")
  expect(await data<{ locale: string; currency: string }>(defaults)).toMatchObject({
    currency: "BRL",
    locale: "es-BR",
  })
  expect(
    (await request("owner", "PUT", "/org-profile", { legalName: "Clínica", ...region, locale: "en-US" })).status,
  ).toBe(400)
})

it("impuestos: viene lo del país, solo se guarda lo que cambia y otro país vuelve a lo suyo (ADR 0083)", async () => {
  const region = { countryCode: "PE", currency: "PEN", timezone: "America/Lima", locale: "es-PE" }
  const body = { legalName: "Clínica Ajustes S.A.C.", ...region }
  expect((await request("owner", "PUT", "/org-profile", body)).status).toBe(200)
  // Elegir lo del país no guarda nada; otra tasa sí.
  const same = await request("owner", "PUT", "/org-profile", { ...body, taxes: { servicios: { category: "S", rateBps: 1800 } } })
  expect(await data<Profile>(same)).toMatchObject({ servicesTaxCategory: null, servicesTaxBps: null })
  const other = await request("owner", "PUT", "/org-profile", {
    ...body,
    taxes: { servicios: { category: "S", rateBps: 1000 }, productos: { category: "O", rateBps: 0 } },
  })
  expect(await data<Profile>(other)).toMatchObject({
    servicesTaxCategory: "S",
    servicesTaxBps: 1000,
    productsTaxCategory: "O",
    productsTaxBps: 0,
  })
  // Lo que no tiene sentido no se guarda: una tasa fuera de rango o una forma que el país no tiene.
  expect(
    (await request("owner", "PUT", "/org-profile", { ...body, taxes: { servicios: { category: "S", rateBps: 9000 } } })).status,
  ).toBe(400)
  expect((await request("owner", "PUT", "/org-profile", { ...body, taxes: { legalForm: "sociedad_mercantil" } })).status).toBe(400)
  // Recepción no cambia los impuestos.
  expect((await request("reception", "PUT", "/org-profile", { ...body, taxes: {} })).status).toBe(403)
  // Otro país, otro impuesto: lo cambiado vuelve a lo que propone el nuevo.
  const mexico = await request("owner", "PUT", "/org-profile", {
    legalName: "Clínica Ajustes S.A.C.",
    countryCode: "MX",
    currency: "MXN",
    timezone: "America/Mexico_City",
    locale: "es-MX",
  })
  expect(await data<Profile>(mexico)).toMatchObject({ servicesTaxCategory: null, productsTaxCategory: null, taxLegalForm: null })
  const form = await request("owner", "PUT", "/org-profile", {
    legalName: "Clínica Ajustes S.A.C.",
    taxes: { legalForm: "sociedad_mercantil" },
  })
  expect(await data<Profile>(form)).toMatchObject({ taxLegalForm: "sociedad_mercantil" })
  // Vuelve al Perú para lo que sigue.
  expect((await request("owner", "PUT", "/org-profile", body)).status).toBe(200)
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

it("logo: quitarlo solo borra dentro de la carpeta de la clínica, aunque el guardado apunte al de otra", async () => {
  // Alguien dejó en `organization.logo` la dirección del logo de otra clínica.
  const foreign = "https://cdn.example.com/avatars/clinica-org_settings_b/logo.png"
  await ownerDb.execute(sql`update "organization" set "logo" = ${foreign} where "id" = ${ORG}`)
  deleted.length = 0
  const removed = await request("owner", "DELETE", "/org-profile/logo")
  expect(removed.status).toBe(200)
  // La ruta pide borrar solo en su carpeta, y esa dirección no está en ella.
  expect(deleted).toEqual([{ url: foreign, folder: `clinica-${ORG}` }])
  expect(isInAvatarFolder("avatars/clinica-org_settings_b/logo.png", `clinica-${ORG}`)).toBe(false)
  expect(isInAvatarFolder(`avatars/clinica-${ORG}/logo.png`, `clinica-${ORG}`)).toBe(true)
  expect(isInAvatarFolder(`avatars/clinica-${ORG}/../clinica-org_settings_b/logo.png`, `clinica-${ORG}`)).toBe(false)
  expect(isInAvatarFolder("avatars/u-otra/foto.png", `clinica-${ORG}`)).toBe(false)
})

it("la clínica nace con el producto del dominio donde se crea, y no cambia (entrega 3 del issue 229)", async () => {
  const region = { countryCode: "PE", currency: "PEN", timezone: "America/Lima", locale: "es-PE" }
  const put = (body: unknown) =>
    app.request("https://api.latidia.localhost/api/org-profile", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-test-session": "other", "x-odentia-org": OTHER_SLUG },
      body: JSON.stringify(body),
    })
  expect((await put({ legalName: "Consultorio Ajeno", ...region })).status).toBe(200)
  // Nace sin ninguna sede: viene con todo encendido a nombre de quien la crea, como una de odentIA (ADR 0141).
  const lines = await ownerDb.execute<{ enabled: boolean; enabled_by: string | null }>(
    sql`select enabled, enabled_by from automation_rule where organization_id = ${OTHER_ORG}`,
  )
  expect(lines.length).toBeGreaterThan(1)
  expect([...lines].every((row) => row.enabled && row.enabled_by === "u-set-other")).toBe(true)
  const [agent] = await ownerDb.execute<{ enabled: boolean; clinical: boolean }>(
    sql`select enabled, clinical_assistant_enabled as clinical from agent_config where organization_id = ${OTHER_ORG}`,
  )
  expect(agent).toEqual({ enabled: true, clinical: true })
  const [portal] = await ownerDb.execute<{ enabled: boolean }>(
    sql`select portal_enabled as enabled from portal_policy where organization_id = ${OTHER_ORG}`,
  )
  expect(portal?.enabled).toBe(true)
  const productOf = async (org: string) =>
    (await ownerDb.execute<{ product: string }>(sql`select product from org_profile where organization_id = ${org}`))[0]?.product
  expect(await productOf(OTHER_ORG)).toBe("medical")
  // La de odentIA nació en su dominio; guardar sus datos desde otro no la cambia.
  expect(await productOf(ORG)).toBe("dental")
  expect((await put({ legalName: "Consultorio Ajeno", ...region })).status).toBe(200)
  expect(await productOf(OTHER_ORG)).toBe("medical")
})

it("la otra moneda la activa quien configura y el cambio de hoy también lo escribe quien cobra", async () => {
  const region = { countryCode: "PE", currency: "PEN", timezone: "America/Lima", locale: "es-PE" }
  const body = { legalName: "Clínica Ajustes S.A.C.", tradeName: "Ajustes", ...region }
  expect((await request("owner", "PUT", "/org-profile", body)).status).toBe(200)

  // Sin nada activado, leer el perfil no dice nada de otra moneda y escribir el cambio no se puede.
  expect(await data<Record<string, unknown>>(await request("reception", "GET", "/org-profile"))).toMatchObject({
    secondCurrency: null,
    exchangeRate: null,
    exchangeRateByName: null,
  })
  const early = await request("cashier", "PUT", "/org-profile/exchange-rate", { exchangeRate: "3.75" })
  expect(early.status).toBe(400)

  // Activar exige escribir el cambio, y es de quien configura.
  const noRate = await request("owner", "PUT", "/org-profile", { ...body, secondCurrency: "USD" })
  expect(noRate.status).toBe(400)
  const noRateBody = (await noRate.json()) as { error: { fields?: Record<string, string> } }
  expect(noRateBody.error.fields?.exchangeRate).toContain("USD")
  expect(
    (await request("cashier", "PUT", "/org-profile", { ...body, secondCurrency: "USD", exchangeRate: "3.75" })).status,
  ).toBe(403)
  const activated = await request("owner", "PUT", "/org-profile", { ...body, secondCurrency: "USD", exchangeRate: "3.75" })
  expect(activated.status).toBe(200)
  expect(await data<Record<string, unknown>>(activated)).toMatchObject({
    secondCurrency: "USD",
    exchangeRate: "3.75",
    exchangeFactor: "3.75",
    exchangeRateBy: "u-set-owner",
  })

  // El cambio lo escribe también quien cobra; recepción, no.
  expect((await request("reception", "PUT", "/org-profile/exchange-rate", { exchangeRate: "3.8" })).status).toBe(403)
  const bad = await request("cashier", "PUT", "/org-profile/exchange-rate", { exchangeRate: "3,8" })
  expect(bad.status).toBe(400)
  const changed = await request("cashier", "PUT", "/org-profile/exchange-rate", { exchangeRate: "3.8" })
  expect(changed.status).toBe(200)
  expect(await data<Record<string, unknown>>(await request("reception", "GET", "/org-profile"))).toMatchObject({
    exchangeRate: "3.8",
    exchangeRateBy: "u-set-cashier",
    exchangeRateByName: "Carla Caja",
  })
  // Guardar los datos de la clínica sin tocar esto no lo pisa.
  expect((await request("owner", "PUT", "/org-profile", body)).status).toBe(200)
  expect(await data<Record<string, unknown>>(await request("owner", "GET", "/org-profile"))).toMatchObject({
    secondCurrency: "USD",
    exchangeRate: "3.8",
  })

  // La moneda del negocio queda quieta y se libera en el mismo guardado que quita la otra.
  const locked = await request("owner", "PUT", "/org-profile", { ...body, currency: "EUR" })
  expect(locked.status).toBe(409)
  expect(((await locked.json()) as { error: { code: string } }).error.code).toBe("SECOND_CURRENCY_ACTIVE")

  // Lo que ya hay en otra moneda, solo para quien configura.
  expect((await request("cashier", "GET", "/org-profile/currency-usage?currency=USD")).status).toBe(403)
  expect(await data(await request("owner", "GET", "/org-profile/currency-usage?currency=USD"))).toEqual({
    currency: "USD",
    dueCents: 0,
    favorCents: 0,
    cashCents: 0,
    services: 0,
    pending: 0,
    commissionsCents: 0,
  })

  const removed = await request("owner", "PUT", "/org-profile", { ...body, secondCurrency: null })
  expect(removed.status).toBe(200)
  expect(await data<Record<string, unknown>>(removed)).toMatchObject({ secondCurrency: null, exchangeRate: null })
})

it("color de la marca: lo cambia quien configura, se guarda aparte y lo leen sus páginas públicas (ADR 0162)", async () => {
  const region = { countryCode: "PE", currency: "PEN", timezone: "America/Lima", locale: "es-PE" }
  expect((await request("owner", "PUT", "/org-profile", { legalName: "Clínica Ajustes S.A.C.", ...region })).status).toBe(200)
  const appearance = async (slug: string) =>
    (await data<{ brandColor: string | null }>(await app.request(`/api/public/appearance/${slug}`))).brandColor

  // Recepción y caja no lo cambian: lo dice el servidor, no solo la pantalla.
  expect((await request("reception", "PUT", "/org-profile/brand-color", { color: "#1d5fa8" })).status).toBe(403)
  expect((await request("cashier", "DELETE", "/org-profile/brand-color")).status).toBe(403)
  expect((await request("reception", "GET", "/org-profile/logo-colors")).status).toBe(403)

  const saved = await request("owner", "PUT", "/org-profile/brand-color", { color: "#1D5FA8" })
  expect(saved.status).toBe(200)
  expect(await data(saved)).toEqual({ brandColor: "#1d5fa8" })
  expect(await data<Record<string, unknown>>(await request("owner", "GET", "/org-profile"))).toMatchObject({ brandColor: "#1d5fa8" })
  expect(await appearance(SLUG)).toBe("#1d5fa8")
  // Otra clínica sigue con el suyo, y una dirección que no es de una clínica no dice nada distinto.
  expect(await appearance(OTHER_SLUG)).toBe(null)
  expect(await appearance("no-existe")).toBe(null)
  expect(await appearance("..%2Fajustes")).toBe(null)

  // Guardar los datos de la clínica no lo pisa.
  expect((await request("owner", "PUT", "/org-profile", { fiscalAddress: "Av. Norte 2" })).status).toBe(200)
  expect(await appearance(SLUG)).toBe("#1d5fa8")

  const wrong = await request("owner", "PUT", "/org-profile/brand-color", { color: "azul" })
  expect(wrong.status).toBe(400)
  expect(((await wrong.json()) as { error: { fields?: Record<string, string> } }).error.fields).toHaveProperty("color")

  // Sin logo legible, «De tu logo» no sugiere nada.
  expect(await data(await request("owner", "GET", "/org-profile/logo-colors"))).toEqual({ colors: [] })

  expect((await request("owner", "DELETE", "/org-profile/brand-color")).status).toBe(200)
  expect(await appearance(SLUG)).toBe(null)
})

it("la app instalada se llama como la clínica: su nombre y producto son públicos, como su color; una dirección ajena no dice nada", async () => {
  const read = async (slug: string) => data<Record<string, unknown>>(await app.request(`/api/public/appearance/${slug}`))
  expect(await read(SLUG)).toMatchObject({ name: expect.any(String), product: "dental" })
  expect(await read("no-existe")).toEqual({ brandColor: null, name: null, product: null })
})

it("avisos en este equipo: cada persona activa y apaga los suyos, y el servidor nunca muestra los de otra clínica", async () => {
  const endpoint = "https://fcm.googleapis.com/fcm/send/equipo-de-prueba"
  const subscription = { endpoint, keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } }
  expect(await data(await request("reception", "GET", "/push/key"))).toEqual({ publicKey: "BPublicaDePrueba" })
  // Sin sesión no hay clave ni suscripción.
  expect((await app.request("/api/push/key")).status).toBe(401)
  expect((await request("reception", "POST", "/push/subscriptions", { endpoint: "http://inseguro", keys: subscription.keys })).status).toBe(400)
  expect(await data(await request("reception", "POST", "/push/subscriptions", subscription))).toEqual({ active: true })
  expect(await data(await request("reception", "POST", "/push/subscriptions/state", { endpoint }))).toEqual({ active: true })
  // Otra persona de la clínica no lo ve como suyo, ni la de otra clínica.
  expect(await data(await request("cashier", "POST", "/push/subscriptions/state", { endpoint }))).toEqual({ active: false })
  expect(await data(await request("other", "POST", "/push/subscriptions/state", { endpoint }))).toEqual({ active: false })
  expect(await data(await request("reception", "DELETE", "/push/subscriptions", { endpoint }))).toEqual({ active: false })
  expect(await data(await request("reception", "POST", "/push/subscriptions/state", { endpoint }))).toEqual({ active: false })
})

it("la hoja membretada: solo quien configura la sube, la ve sobre una receta de ejemplo, la quita y la vuelve a poner (ADR 0181)", async () => {
  const sharp = (await import("sharp")).default
  // Una hoja A4 mínima, escrita a mano: su diseño es un rectángulo arriba.
  const content = "0.1 0.3 0.5 rg 40 760 515 40 re f"
  const pdf = new Blob(
    [
      [
        "%PDF-1.4",
        "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
        "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
        "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Contents 4 0 R /Resources << >> >> endobj",
        `4 0 obj << /Length ${content.length} >> stream`,
        content,
        "endstream endobj",
        "trailer << /Root 1 0 R >>",
        "%%EOF",
      ].join(String.fromCharCode(10)),
    ],
    { type: "application/pdf" },
  )
  const png = new Blob([await sharp({ create: { width: 40, height: 10, channels: 3, background: "#fff" } }).png().toBuffer()], {
    type: "image/png",
  })
  const form = (file: Blob | null, current?: string) => {
    const body = new FormData()
    if (current) body.append("current", current)
    for (const [key, value] of Object.entries({ topMm: "50", bottomMm: "41", leftMm: "19", rightMm: "19", hasContact: "true" }))
      body.append(key, value)
    if (file) body.append("file", file, "hoja.pdf")
    body.append("topBand", png, "arriba.png")
    body.append("bottomBand", png, "abajo.png")
    body.append("thumbnail", png, "mini.png")
    return body
  }
  const send = (who: Who, method: string, path: string, body?: FormData) =>
    app.request(`/api/org-profile/letterhead${path}`, {
      method,
      headers: { "x-test-session": who, "x-odentia-org": who === "other" ? OTHER_SLUG : SLUG },
      body,
    })

  // Recepción y caja no la cambian ni la ven: lo dice el servidor, no solo la pantalla.
  expect((await send("reception", "PUT", "", form(pdf))).status).toBe(403)
  expect((await send("reception", "POST", "/preview", form(pdf))).status).toBe(403)
  expect((await send("cashier", "DELETE", "")).status).toBe(403)

  // Lo que no es una hoja se dice junto al archivo.
  const wrong = await send("owner", "PUT", "", form(new Blob(["hola"], { type: "application/pdf" })))
  expect(wrong.status).toBe(400)
  expect(((await wrong.json()) as { error: { fields?: Record<string, string> } }).error.fields).toHaveProperty("file")

  const preview = await data<{ pdf: string; pages: number; margins: Record<string, number> }>(
    await send("owner", "POST", "/preview", form(pdf)),
  )
  expect(Buffer.from(preview.pdf, "base64").subarray(0, 5).toString()).toBe("%PDF-")
  expect(preview.pages).toBe(1)
  expect(preview.margins).toEqual({ topMm: 50, bottomMm: 41, leftMm: 19, rightMm: 19 })

  const saved = await data<{ letterhead: Record<string, unknown> & { id: string } }>(
    await send("owner", "PUT", "", form(pdf, "none")),
  )
  expect(saved.letterhead).toMatchObject({ topMm: 50, hasContact: true, fileName: "hoja.pdf" })
  // La pantalla nunca sabe dónde está guardado su PDF.
  expect(saved.letterhead).not.toHaveProperty("pdfKey")
  expect(privateObjects.size).toBe(1)
  // Corregir sin volver a subirla no guarda otro PDF.
  await data(await send("owner", "PUT", "", form(null, saved.letterhead.id)))
  // Quien la tenía abierta antes de este cambio no lo pisa.
  expect((await send("owner", "PUT", "", form(null, saved.letterhead.id))).status).toBe(409)
  expect(privateObjects.size).toBe(1)
  // La de hoy, otra vez, para «Cambiar la hoja»; otra clínica no tiene ninguna.
  expect((await send("owner", "GET", "/pdf")).headers.get("content-type")).toBe("application/pdf")
  expect(await data(await send("other", "GET", ""))).toMatchObject({ letterhead: null })

  const removed = await data<{ removedId: string }>(await send("owner", "DELETE", ""))
  expect(await data(await send("owner", "GET", ""))).toMatchObject({ letterhead: null })
  const back = await app.request("/api/org-profile/letterhead/restore", {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-session": "owner", "x-odentia-org": SLUG },
    body: JSON.stringify({ id: removed.removedId }),
  })
  expect(back.status).toBe(200)
  expect(await data(await send("owner", "GET", ""))).toMatchObject({ letterhead: { topMm: 50 } })
})

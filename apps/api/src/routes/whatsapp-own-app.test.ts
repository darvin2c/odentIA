process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { createHmac } from "node:crypto"
import { createAppDb, createOwnerDb, type Db, withOrgContext } from "@odentia/db"
import { channelConnection } from "@odentia/db/schema/crm"
import { workspaceNotification } from "@odentia/db/schema/workspace"
import {
  decryptConfig,
  listOwnAppTokensExpiring,
  notifyOwnAppTokenExpiring,
  secretsKeyFromEnv,
  settleWorkspaceNotifications,
  type Storage,
} from "@odentia/services"
import { and, eq, sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Context } from "hono"
import { Hono, type Next } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { createConnectionsRoute } from "./connections.js"
import type { CrmDeps } from "./helpers.js"
import { createWebhooksRoute } from "./webhooks.js"

/**
 * WhatsApp con la app propia de la clínica, de punta a punta contra la base,
 * con un `fetch` de prueba que responde como publica Meta. NO acredita que
 * Meta acepte nada de esto: no se probó con una cuenta real.
 */
const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("cd".repeat(32))
const SECRET = "secreto-de-la-clinica"

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db

interface Call {
  url: string
  method: string
  body: unknown
}
type Answer = { status?: number; json: unknown } | undefined

/** Meta de prueba: una app sana con una clave permanente, salvo lo que el caso cambie. */
function fakeMeta(override?: (call: Call) => Answer) {
  const calls: Call[] = []
  let created = 900
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    const answer = override?.(call) ?? healthy(call)
    return new Response(JSON.stringify(answer.json), { status: answer.status ?? 200 })
  }) as typeof fetch
  function healthy(call: Call): { status?: number; json: unknown } {
    const parsed = new URL(call.url)
    const path = parsed.pathname
    if (path.endsWith("/app")) return { json: { id: "APP-CLINICA" } }
    if (path.endsWith("/debug_token")) {
      if (parsed.searchParams.get("access_token") !== `APP-CLINICA|${SECRET}`) {
        return { status: 400, json: { error: { message: "Invalid OAuth access token signature.", code: 190 } } }
      }
      return {
        json: {
          data: {
            is_valid: true,
            app_id: "APP-CLINICA",
            type: "SYSTEM_USER",
            expires_at: 0,
            scopes: ["business_management", "whatsapp_business_management", "whatsapp_business_messaging"],
          },
        },
      }
    }
    if (path.endsWith("/subscribed_apps")) return { json: { success: true } }
    if (path.endsWith("/register")) return { json: { success: true } }
    if (call.url.includes("fields=platform_type")) return { json: { id: path.split("/").at(-1) } }
    if (call.url.includes("fields=display_phone_number")) {
      const id = path.split("/").at(-1)
      return { json: { id, display_phone_number: `+51 ${id}`, verified_name: "Clínica Sonríe" } }
    }
    if (call.url.includes("fields=quality_rating")) return { json: { quality_rating: "GREEN", whatsapp_business_manager_messaging_limit: "TIER_250" } }
    if (path.endsWith("/message_templates")) {
      if (call.method === "POST") return { json: { id: String(++created), status: "PENDING", category: (call.body as { category: string }).category } }
      return { json: { data: [] } }
    }
    return { status: 404, json: { error: { message: "Llamada no prevista", code: 100 } } }
  }
  const of = (method: string, part: string) => calls.filter((call) => call.method === method && call.url.includes(part))
  return { calls, fetch: impl, of }
}

function useMeta(meta: ReturnType<typeof fakeMeta>) {
  vi.stubGlobal("fetch", meta.fetch)
  return meta
}

function buildApp(orgId: string) {
  const deps: CrmDeps = {
    db: appDb,
    secretsKey: KEY,
    storage: {} as Storage,
    validateExternal: true,
    webhookBaseUrl: "https://api.example.com",
  }
  const app = new Hono()
  app.use("*", async (c: Context, next: Next) => {
    c.set("orgId", orgId)
    c.set("userId", `u-${orgId}`)
    c.set("memberRole", "owner")
    await next()
  })
  app.route("/channels/connections", createConnectionsRoute(deps))
  return app
}

const post = (app: Hono, path: string, body?: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) })

interface OwnApp {
  registeredAt: string | null
  subscribedAt: string | null
  problems: { registrar?: string; suscribir?: string }
  pinNeeded: boolean
  tokenExpiresAt: string | null
  keysCheckedAt: string | null
  signatureRejectedAt: string | null
}

async function connect(orgId: string, config: Record<string, string>) {
  const res = await post(buildApp(orgId), "/channels/connections", { channel: "whatsapp", provider: "whatsapp_cloud_api", config })
  const json = (await res.json()) as { data?: { id: string; ownApp: OwnApp | null }; error?: { code: string; message: string } }
  return { status: res.status, data: json.data, error: json.error }
}

const keys = (phone: string, extra: Record<string, string> = {}) => ({
  phoneNumberId: phone,
  wabaId: `w${phone}`,
  accessToken: "clave-permanente",
  appSecret: SECRET,
  ...extra,
})

const rowOf = async (id: string) => (await ownerDb.select().from(channelConnection).where(eq(channelConnection.id, id)))[0]!

async function newOrg(id: string) {
  await ownerDb.execute(sql`insert into "organization" ("id", "name", "slug", "created_at") values (${id}, ${`Clínica ${id}`}, ${id}, now())`)
  await ownerDb.execute(
    sql`insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale")
        values (${id}, ${`Clínica ${id}`}, 'PE', 'PEN', 'America/Lima', 'es-PE')`,
  )
  await ownerDb.execute(sql`insert into "user" ("id", "name", "email", "email_verified", "created_at", "updated_at")
    values (${`u-${id}`}, 'Dueña', ${`${id}@example.com`}, true, now(), now())`)
  await ownerDb.execute(sql`insert into "member" ("id", "organization_id", "user_id", "role", "created_at")
    values (${`m-${id}`}, ${id}, ${`u-${id}`}, 'owner', now())`)
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
  for (const id of ["org_a", "org_b", "org_c", "org_d", "org_e"]) await newOrg(id)
}, 180_000)

afterEach(() => {
  vi.unstubAllGlobals()
})

afterAll(async () => {
  await container?.stop()
})

describe("conectar con la app propia de la clínica", () => {
  it("comprueba las claves, suscribe la app y registra el número con un PIN que guarda cifrado", async () => {
    const meta = useMeta(fakeMeta())
    const { status, data } = await connect("org_a", keys("8001"))
    expect(status).toBe(201)
    expect(data!.ownApp).toMatchObject({ pinNeeded: false, tokenExpiresAt: null, problems: {}, signatureRejectedAt: null })
    expect(data!.ownApp!.registeredAt).not.toBeNull()
    expect(data!.ownApp!.subscribedAt).not.toBeNull()
    expect(data!.ownApp!.keysCheckedAt).not.toBeNull()
    expect(meta.of("POST", "/w8001/subscribed_apps")).toHaveLength(1)
    const [register] = meta.of("POST", "/8001/register")
    const pin = (register!.body as { pin: string }).pin
    expect(pin).toMatch(/^\d{6}$/)
    const row = await rowOf(data!.id)
    expect(decryptConfig(KEY, row.configEncrypted)["pin"]).toBe(pin)
    // El PIN no viaja a la pantalla.
    expect(JSON.stringify(data)).not.toContain(pin)
  })

  it("la clave temporal no se acepta y no guarda nada", async () => {
    useMeta(
      fakeMeta((call) =>
        call.url.includes("/debug_token")
          ? { json: { data: { is_valid: true, app_id: "APP-CLINICA", type: "USER", expires_at: Math.floor(Date.now() / 1000) + 3600, scopes: [] } } }
          : undefined,
      ),
    )
    const { status, error } = await connect("org_b", keys("8002"))
    expect(status).toBe(400)
    expect(error).toMatchObject({ code: "WHATSAPP_TEMPORARY_KEY" })
    expect(error!.message).toContain("clave temporal de 24 horas")
    expect(await ownerDb.select().from(channelConnection).where(eq(channelConnection.organizationId, "org_b"))).toHaveLength(0)
  })

  it("una clave sin los permisos de mensajes, o una clave secreta de otra app, se rechazan diciendo cuál corregir", async () => {
    useMeta(
      fakeMeta((call) =>
        call.url.includes("/debug_token") && call.url.includes(encodeURIComponent(SECRET))
          ? { json: { data: { is_valid: true, type: "SYSTEM_USER", expires_at: 0, scopes: ["whatsapp_business_messaging"] } } }
          : undefined,
      ),
    )
    const scopes = await connect("org_b", keys("8002"))
    expect(scopes.error).toMatchObject({ code: "WHATSAPP_KEY_SCOPES" })
    expect(scopes.error!.message).toContain("administrar mensajes")

    useMeta(fakeMeta())
    const secret = await connect("org_b", keys("8002", { appSecret: "de-otra-app" }))
    expect(secret.status).toBe(400)
    expect(secret.error).toMatchObject({ code: "WHATSAPP_APP_SECRET_REJECTED" })
  })

  it("si Meta no dice de qué app es la clave, no se bloquea: se conecta sin afirmar nada de las claves", async () => {
    useMeta(fakeMeta((call) => (new URL(call.url).pathname.endsWith("/app") ? { status: 400, json: { error: { message: "no", code: 100 } } } : undefined)))
    const { status, data } = await connect("org_b", keys("8002"))
    expect(status).toBe(201)
    expect(data!.ownApp).toMatchObject({ keysCheckedAt: null })
    expect(data!.ownApp!.registeredAt).not.toBeNull()
  })

  it("un número que ya tenía PIN lo pide, olvida el que se probó y registra con el que escribe la clínica", async () => {
    let tries = 0
    const meta = useMeta(
      fakeMeta((call) => {
        if (!call.url.includes("/register")) return undefined
        tries += 1
        return (call.body as { pin: string }).pin === "246810"
          ? { json: { success: true } }
          : { status: 400, json: { error: { message: "Two-step verification PIN incorrect.", code: 133005 } } }
      }),
    )
    const { data } = await connect("org_c", keys("8003"))
    expect(data!.ownApp).toMatchObject({ registeredAt: null, pinNeeded: true })
    expect(data!.ownApp!.problems.registrar).toContain("ya tiene un PIN")
    expect(decryptConfig(KEY, (await rowOf(data!.id)).configEncrypted)["pin"]).toBeUndefined()

    // «Volver a comprobar» sin PIN no gasta otro intento del número.
    const again = await post(buildApp("org_c"), `/channels/connections/${data!.id}/own-app`)
    expect(again.status).toBe(200)
    expect(tries).toBe(1)

    expect((await post(buildApp("org_c"), `/channels/connections/${data!.id}/own-app`, { pin: "12a" })).status).toBe(400)
    const fixed = await post(buildApp("org_c"), `/channels/connections/${data!.id}/own-app`, { pin: "246810" })
    const body = (await fixed.json()) as { data: { ownApp: OwnApp; problem: string | null } }
    expect(body.data.problem).toBeNull()
    expect(body.data.ownApp).toMatchObject({ pinNeeded: false, problems: {} })
    expect(body.data.ownApp.registeredAt).not.toBeNull()
    expect(decryptConfig(KEY, (await rowOf(data!.id)).configEncrypted)["pin"]).toBe("246810")
    expect(meta.of("POST", "/register")).toHaveLength(2)
  })

  it("un número ya registrado no se vuelve a registrar", async () => {
    const meta = useMeta(fakeMeta((call) => (call.url.includes("fields=platform_type") ? { json: { platform_type: "CLOUD_API" } } : undefined)))
    const { data } = await connect("org_d", keys("8004"))
    expect(data!.ownApp!.registeredAt).not.toBeNull()
    expect(meta.of("POST", "/register")).toHaveLength(0)
  })
})

describe("la dirección de avisos de una conexión con la app propia", () => {
  const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [] })
  const sign = (secret: string) => `sha256=${createHmac("sha256", secret).update(raw, "utf8").digest("hex")}`
  const webhooks = () => {
    const app = new Hono()
    app.route("/", createWebhooksRoute({ ownerDb, db: appDb, secretsKey: KEY }))
    return app
  }
  const deliver = (id: string, signature: string) =>
    webhooks().request(`/channels/whatsapp_cloud_api/${id}`, {
      method: "POST",
      headers: { "x-hub-signature-256": signature, "content-type": "application/json" },
      body: raw,
    })

  it("un aviso firmado con otra clave se anota y avisa en la campana; uno bien firmado lo borra", async () => {
    const [row] = await ownerDb.select().from(channelConnection).where(eq(channelConnection.organizationId, "org_a"))
    expect((await deliver(row!.id, sign("de-otra-app"))).status).toBe(401)
    expect((await rowOf(row!.id)).ownApp?.signatureRejectedAt).toBeTruthy()
    const notices = () =>
      ownerDb
        .select()
        .from(workspaceNotification)
        .where(and(eq(workspaceNotification.organizationId, "org_a"), eq(workspaceNotification.subject, `firma-meta:${row!.id}`)))
    expect(await notices()).toHaveLength(1)

    expect((await deliver(row!.id, sign(SECRET))).status).toBe(200)
    expect((await rowOf(row!.id)).ownApp?.signatureRejectedAt).toBeUndefined()
    await withOrgContext(appDb, "org_a", (tx) => settleWorkspaceNotifications(tx, "org_a"))
    expect((await notices())[0]!.resolvedAt).not.toBeNull()
  })
})

describe("la clave que vence", () => {
  it("se avisa en la campana los últimos 7 días y el aviso se retira con una clave que no vence", async () => {
    useMeta(
      fakeMeta((call) =>
        call.url.includes("/debug_token")
          ? {
              json: {
                data: {
                  is_valid: true,
                  type: "SYSTEM_USER",
                  expires_at: Math.floor(Date.now() / 1000) + 5 * 86_400,
                  scopes: ["whatsapp_business_management", "whatsapp_business_messaging"],
                },
              },
            }
          : undefined,
      ),
    )
    const { data } = await connect("org_e", keys("8005"))
    expect(data!.ownApp!.tokenExpiresAt).not.toBeNull()
    const due = (await listOwnAppTokensExpiring(ownerDb, new Date())).filter((item) => item.orgId === "org_e")
    expect(due).toHaveLength(1)
    await withOrgContext(appDb, "org_e", (tx) => notifyOwnAppTokenExpiring(tx, "org_e", due[0]!.connectionId, due[0]!.expiresAt))
    const [notice] = await ownerDb.select().from(workspaceNotification).where(eq(workspaceNotification.organizationId, "org_e"))
    expect(notice!.title).toMatch(/^La clave de WhatsApp vence el /)

    // Una clave que no vence: el aviso se retira solo.
    useMeta(fakeMeta())
    expect((await post(buildApp("org_e"), `/channels/connections/${data!.id}/credentials`, { config: { accessToken: "clave-nunca" } })).status).toBe(200)
    expect((await rowOf(data!.id)).ownApp?.tokenExpiresAt).toBeNull()
    await withOrgContext(appDb, "org_e", (tx) => settleWorkspaceNotifications(tx, "org_e"))
    const [after] = await ownerDb.select().from(workspaceNotification).where(eq(workspaceNotification.organizationId, "org_e"))
    expect(after!.resolvedAt).not.toBeNull()
  })
})

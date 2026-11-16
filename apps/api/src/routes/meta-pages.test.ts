process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { createHmac } from "node:crypto"
import type { Auth } from "@odentia/auth"
import { createAppDb, createOwnerDb, type Db, withOrgContext } from "@odentia/db"
import { channelConnection, inboundEvent } from "@odentia/db/schema/crm"
import { workspaceNotification } from "@odentia/db/schema/workspace"
import {
  beginMetaPagesLogin,
  createConnection,
  decryptConfig,
  listInstagramTokensDue,
  listPageConnections,
  type MetaPagesApp,
  notePageTokenState,
  saveRenewedInstagramToken,
  secretsKeyFromEnv,
  settleWorkspaceNotifications,
} from "@odentia/services"
import { and, eq, sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createMetaPagesRoute, metaPagesFromEnv } from "./meta-pages.js"
import { createWebhooksRoute } from "./webhooks.js"

/**
 * «Conectar con Facebook» de Messenger e Instagram contra la base, con un
 * `fetch` que responde con la forma que publica Meta. NO acredita que Meta
 * acepte nada: los permisos de páginas de la app de odentIA aún no están aprobados.
 */
const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("cd".repeat(32))
const META: MetaPagesApp = {
  appId: "APP1",
  appSecret: "secreto-de-la-app",
  graphVersion: "v25.0",
  configId: "CFG-PAGINAS",
  redirectUri: "https://api.example.com/api/meta-pages/callback",
}

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db

/** Facebook de prueba: la persona marcó las páginas que el caso diga. */
function fakeFacebook(pages: unknown[], override?: (url: URL, method: string) => { status?: number; json: unknown } | undefined) {
  const calls: Array<{ method: string; url: URL; auth: string | null }> = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? "GET"
    calls.push({ method, url, auth: ((init?.headers ?? {}) as Record<string, string>)["Authorization"] ?? null })
    const answer = override?.(url, method) ?? healthy(url)
    return new Response(JSON.stringify(answer.json), { status: answer.status ?? 200 })
  }) as typeof fetch
  function healthy(url: URL): { status?: number; json: unknown } {
    if (url.pathname.endsWith("/oauth/access_token")) {
      return { json: { access_token: url.searchParams.get("grant_type") ? "LARGA" : "CORTA", token_type: "bearer" } }
    }
    if (url.pathname.endsWith("/me/accounts")) return { json: { data: pages } }
    if (url.pathname.endsWith("/subscribed_apps")) return { json: { success: true } }
    return { status: 404, json: { error: { message: "Llamada no prevista", code: 100 } } }
  }
  return { calls, fetch: impl }
}

const fakeAuth = (userId: string | null) =>
  ({ api: { getSession: async () => (userId ? { user: { id: userId } } : null) } }) as unknown as Auth

function route(fetchImpl: typeof fetch, userId: string | null, app: MetaPagesApp | undefined = META) {
  return createMetaPagesRoute({ auth: fakeAuth(userId), db: appDb, ownerDb, secretsKey: KEY, webUrl: "https://clinica.example.com/", app, fetch: fetchImpl })
}

async function start(orgId: string, userId: string): Promise<string> {
  const { url } = await withOrgContext(appDb, orgId, (tx) => beginMetaPagesLogin(tx, orgId, userId, KEY, META))
  const window = new URL(url)
  expect(window.origin + window.pathname).toBe("https://www.facebook.com/v25.0/dialog/oauth")
  expect(window.searchParams.get("config_id")).toBe("CFG-PAGINAS")
  expect(window.searchParams.get("redirect_uri")).toBe(META.redirectUri)
  return window.searchParams.get("state") ?? ""
}

async function back(fetchImpl: typeof fetch, userId: string | null, query: Record<string, string>) {
  const res = await route(fetchImpl, userId).request(`/callback?${new URLSearchParams(query).toString()}`)
  expect(res.status).toBe(302)
  return new URL(res.headers.get("location") ?? "")
}

const rowsOf = (orgId: string) => ownerDb.select().from(channelConnection).where(eq(channelConnection.organizationId, orgId))

async function newOrg(id: string, owner: string) {
  await ownerDb.execute(sql`insert into "organization" ("id", "name", "slug", "created_at") values (${id}, ${`Clínica ${id}`}, ${id}, now())`)
  await ownerDb.execute(
    sql`insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale")
        values (${id}, ${`Clínica ${id}`}, 'PE', 'PEN', 'America/Lima', 'es-PE')`,
  )
  await ownerDb.execute(sql`insert into "user" (id, name, email, email_verified) values (${owner}, ${owner}, ${`${owner}@example.test`}, true) on conflict do nothing`)
  await ownerDb.execute(
    sql`insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values (${`m-${id}-${owner}`}, ${id}, ${owner}, 'owner', now())`,
  )
}

const SONRISA = { id: "P1", name: "Clínica Sonrisa", access_token: "TP1", instagram_business_account: { id: "IG1", username: "sonrisadental" } }
const LIMA = { id: "P2", name: "Dental Lima", access_token: "TP2" }

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
  await newOrg("org_a", "u-a")
  await newOrg("org_b", "u-b")
  await newOrg("org_c", "u-c")
  await ownerDb.execute(sql`insert into "user" (id, name, email, email_verified) values ('u-recepcion', 'r', 'r@example.test', true)`)
  await ownerDb.execute(sql`insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values ('m-rec', 'org_a', 'u-recepcion', 'reception', now())`)
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

describe("la configuración de páginas es opcional", () => {
  it("sin la configuración o la vuelta no hay botón; con una de las dos, se dice", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const app = { appId: "APP1", appSecret: "s", graphVersion: "v25.0" }
    expect(metaPagesFromEnv(app, { META_PAGES_CONFIG_ID: "", META_PAGES_REDIRECT_URI: "" })).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
    expect(metaPagesFromEnv(app, { META_PAGES_CONFIG_ID: "C", META_PAGES_REDIRECT_URI: "" })).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(metaPagesFromEnv(undefined, { META_PAGES_CONFIG_ID: "C", META_PAGES_REDIRECT_URI: "r" })).toBeUndefined()
    warn.mockRestore()
    expect(metaPagesFromEnv(app, { META_PAGES_CONFIG_ID: " C ", META_PAGES_REDIRECT_URI: "r" })).toEqual({ ...app, configId: "C", redirectUri: "r" })
  })
})

describe("conectar con Facebook", () => {
  it("C1 y C2: un botón conecta Messenger de cada página marcada y el Instagram unido; sin Instagram, lo dice", async () => {
    const meta = fakeFacebook([SONRISA, LIMA])
    const state = await start("org_a", "u-a")
    const location = await back(meta.fetch, "u-a", { state, code: "COD" })
    expect(location.origin + location.pathname).toBe("https://clinica.example.com/settings/integrations")
    expect(Object.fromEntries(location.searchParams)).toEqual({ org: "org_a", facebook: "ok", messenger: "2", instagram: "1", sinig: "1", otra: "0" })
    // El código se cambió con la vuelta fija y la clave corta por la larga.
    const exchange = meta.calls.filter((call) => call.url.pathname.endsWith("/oauth/access_token"))
    expect(exchange[0]?.url.searchParams.get("redirect_uri")).toBe(META.redirectUri)
    expect(exchange[1]?.url.searchParams.get("fb_exchange_token")).toBe("CORTA")
    // Una suscripción por página, con su clave: sirve a Messenger y a su Instagram.
    expect(meta.calls.filter((call) => call.method === "POST").map((call) => [call.url.pathname, call.auth])).toEqual([
      ["/v25.0/P1/subscribed_apps", "Bearer TP1"],
      ["/v25.0/P2/subscribed_apps", "Bearer TP2"],
    ])
    const rows = await rowsOf("org_a")
    const summary = rows.map((row) => [row.provider, row.externalId, row.displayName, row.status, Boolean(row.signup?.subscribedAt)]).sort()
    expect(summary).toEqual([
      ["instagram", "IG1", "@sonrisadental", "active", true],
      ["messenger", "P1", "Clínica Sonrisa", "active", true],
      ["messenger", "P2", "Dental Lima", "active", true],
    ])
    const instagram = rows.find((row) => row.provider === "instagram")!
    expect(decryptConfig(KEY, instagram.configEncrypted)).toEqual({ instagramId: "IG1", pageId: "P1", pageAccessToken: "TP1", appId: "APP1" })
  })

  it("el state es de un solo uso, de la misma persona y de quien administra", async () => {
    const meta = fakeFacebook([SONRISA])
    const state = await start("org_c", "u-c")
    const stranger = await back(meta.fetch, "u-a", { state, code: "COD" })
    expect(stranger.searchParams.get("facebook")).toBe("fallo")
    // Ya se consumió: tampoco sirve a su dueña.
    expect((await back(meta.fetch, "u-c", { state, code: "COD" })).searchParams.get("facebook")).toBe("fallo")
    // Un state forjado.
    expect((await back(meta.fetch, "u-c", { state: "abc.def", code: "COD" })).searchParams.get("facebook")).toBe("fallo")
    // Recepción no conecta canales, aunque empiece el flujo.
    const reception = await start("org_a", "u-recepcion")
    expect((await back(meta.fetch, "u-recepcion", { state: reception, code: "COD" })).searchParams.get("facebook")).toBe("fallo")
    // Sin sesión, o si la persona cerró la ventana.
    const again = await start("org_c", "u-c")
    expect((await back(meta.fetch, null, { state: again, code: "COD" })).searchParams.get("facebook")).toBe("sin-sesion")
    expect((await back(meta.fetch, "u-c", { error: "access_denied", state: again })).searchParams.get("facebook")).toBe("cancelado")
    expect(meta.calls.filter((call) => call.url.pathname.endsWith("/me/accounts"))).toHaveLength(0)
    expect(await rowsOf("org_c")).toHaveLength(0)
  })

  it("sin páginas marcadas lo dice; una cuenta activa en otra clínica no se toca", async () => {
    const none = fakeFacebook([])
    const state = await start("org_b", "u-b")
    expect((await back(none.fetch, "u-b", { state, code: "COD" })).searchParams.get("facebook")).toBe("sin-paginas")
    const meta = fakeFacebook([SONRISA])
    const again = await start("org_b", "u-b")
    const location = await back(meta.fetch, "u-b", { state: again, code: "COD" })
    expect(Object.fromEntries(location.searchParams)).toMatchObject({ facebook: "ok", messenger: "0", instagram: "0", otra: "2" })
    expect(await rowsOf("org_b")).toHaveLength(0)
  })

  it("C4: volver a conectar una cuenta desconectada o hecha a mano reusa su fila y sus conversaciones", async () => {
    const [messenger] = (await rowsOf("org_a")).filter((row) => row.externalId === "P2")
    await ownerDb.update(channelConnection).set({ status: "disabled" }).where(eq(channelConnection.id, messenger!.id))
    const meta = fakeFacebook([LIMA])
    const state = await start("org_a", "u-a")
    await back(meta.fetch, "u-a", { state, code: "COD" })
    const rows = (await rowsOf("org_a")).filter((row) => row.externalId === "P2")
    expect(rows.map((row) => [row.id, row.status])).toEqual([[messenger!.id, "active"]])
  })
})

describe("los avisos de las páginas", () => {
  const sign = (body: string) => `sha256=${createHmac("sha256", META.appSecret).update(body).digest("hex")}`
  const hooks = () => createWebhooksRoute({ ownerDb, db: appDb, secretsKey: KEY, metaApp: { appSecret: META.appSecret, verifyToken: "reto" } })
  const deliver = (body: string, signature = sign(body)) =>
    hooks().request("/meta/pages", { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature }, body })
  const seen = async (mid: string) =>
    (await ownerDb.select().from(inboundEvent).where(eq(inboundEvent.externalEventId, mid))).length > 0

  it("responde el reto con la clave de la app y rechaza una firma ajena", async () => {
    const ok = await hooks().request("/meta/pages?hub.mode=subscribe&hub.verify_token=reto&hub.challenge=123")
    expect(await ok.text()).toBe("123")
    expect((await hooks().request("/meta/pages?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=123")).status).toBe(403)
    expect((await deliver(JSON.stringify({ object: "page", entry: [] }), "sha256=00")).status).toBe(401)
  })

  it("C3: cada página va a su conexión; lo respondido desde Meta Business Suite entra; lo de otra página no", async () => {
    const body = JSON.stringify({
      object: "page",
      entry: [
        { id: "P1", messaging: [{ sender: { id: "PSID1" }, recipient: { id: "P1" }, timestamp: 1, message: { mid: "m.p1", text: "Hola" } }] },
        { id: "P2", messaging: [{ sender: { id: "P2" }, recipient: { id: "PSID2" }, timestamp: 2, message: { mid: "m.suite", text: "Te esperamos", is_echo: true, app_id: 263902037430900 } }] },
        { id: "P2", messaging: [{ sender: { id: "P2" }, recipient: { id: "PSID2" }, timestamp: 3, message: { mid: "m.nuestro", text: "Listo", is_echo: true, app_id: "APP1" } }] },
        { id: "P9", messaging: [{ sender: { id: "PSID9" }, recipient: { id: "P9" }, timestamp: 4, message: { mid: "m.ajena", text: "?" } }] },
      ],
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect((await deliver(body)).status).toBe(200)
    warn.mockRestore()
    expect([await seen("m.p1"), await seen("m.suite"), await seen("m.nuestro"), await seen("m.ajena")]).toEqual([true, true, false, false])
    const instagram = JSON.stringify({
      object: "instagram",
      entry: [{ id: "IG1", messaging: [{ sender: { id: "IGSID1" }, recipient: { id: "IG1" }, timestamp: 5, message: { mid: "m.ig", text: "Precio?" } }] }],
    })
    expect((await deliver(instagram)).status).toBe(200)
    expect(await seen("m.ig")).toBe(true)
  })

  it("C7: desconectar Messenger no corta al Instagram de la misma página", async () => {
    const [messenger] = (await rowsOf("org_a")).filter((row) => row.externalId === "P1")
    await ownerDb.update(channelConnection).set({ status: "disabled" }).where(eq(channelConnection.id, messenger!.id))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await deliver(JSON.stringify({ object: "page", entry: [{ id: "P1", messaging: [{ sender: { id: "PSID1" }, recipient: { id: "P1" }, timestamp: 6, message: { mid: "m.off", text: "x" } }] }] }))
    warn.mockRestore()
    await deliver(JSON.stringify({ object: "instagram", entry: [{ id: "IG1", messaging: [{ sender: { id: "IGSID1" }, recipient: { id: "IG1" }, timestamp: 7, message: { mid: "m.ig2", text: "y" } }] }] }))
    expect([await seen("m.off"), await seen("m.ig2")]).toEqual([false, true])
    await ownerDb.update(channelConnection).set({ status: "active" }).where(eq(channelConnection.id, messenger!.id))
  })
})

describe("la revisión diaria", () => {
  it("si Facebook ya no acepta la clave de una página, la fila y la campana lo dicen; al volver, se retira", async () => {
    expect((await listPageConnections(ownerDb)).filter((row) => row.orgId === "org_a")).toHaveLength(3)
    const [instagram] = (await rowsOf("org_a")).filter((row) => row.provider === "instagram")
    const id = instagram!.id
    expect(await withOrgContext(appDb, "org_a", (tx) => notePageTokenState(tx, "org_a", id, true))).toBe(true)
    // La segunda vez no cambia nada ni repite el aviso.
    expect(await withOrgContext(appDb, "org_a", (tx) => notePageTokenState(tx, "org_a", id, true))).toBe(false)
    const notices = await ownerDb.select().from(workspaceNotification).where(eq(workspaceNotification.subject, `clave-meta:${id}`))
    expect(notices.map((n) => [n.userId, n.title, n.href])).toEqual([["u-a", "Instagram dejó de recibir mensajes", "/settings/integrations/instagram"]])
    expect((await rowsOf("org_a")).find((row) => row.id === id)?.signup?.tokenProblem).toBeTruthy()
    expect(await withOrgContext(appDb, "org_a", (tx) => notePageTokenState(tx, "org_a", id, false))).toBe(true)
    await withOrgContext(appDb, "org_a", (tx) => settleWorkspaceNotifications(tx, "org_a"))
    const [settled] = await ownerDb.select().from(workspaceNotification).where(eq(workspaceNotification.subject, `clave-meta:${id}`))
    expect(settled?.resolvedAt).not.toBeNull()
  })

  it("C5: el Instagram hecho a mano se renueva antes de los 60 días; si no se pudo, avisa", async () => {
    const created = await withOrgContext(appDb, "org_b", (tx) =>
      createConnection(tx, "org_b", KEY, { channel: "instagram", provider: "instagram", config: { instagramId: "IG-MANO", accessToken: "VIEJA", appSecret: "s" } }, { fetch, validateExternal: false }),
    )
    // Recién hecha: Instagram no renueva una clave de menos de 24 horas.
    expect((await listInstagramTokensDue(ownerDb, KEY)).map((due) => due.connectionId)).not.toContain(created.id)
    const tomorrow = new Date(Date.now() + 25 * 3_600_000)
    expect(await listInstagramTokensDue(ownerDb, KEY, tomorrow)).toContainEqual({ orgId: "org_b", connectionId: created.id, token: "VIEJA" })
    // Si alguien pegó otra mientras tanto, no se pisa.
    expect(await withOrgContext(appDb, "org_b", (tx) => saveRenewedInstagramToken(tx, "org_b", created.id, KEY, "OTRA", "NUEVA"))).toBe(false)
    expect(await withOrgContext(appDb, "org_b", (tx) => saveRenewedInstagramToken(tx, "org_b", created.id, KEY, "VIEJA", "NUEVA"))).toBe(true)
    const [row] = await ownerDb.select().from(channelConnection).where(and(eq(channelConnection.id, created.id)))
    expect(decryptConfig(KEY, row!.configEncrypted)).toMatchObject({ accessToken: "NUEVA" })
    // Renovada hoy: la próxima, en 7 días.
    expect((await listInstagramTokensDue(ownerDb, KEY, tomorrow)).map((due) => due.connectionId)).not.toContain(created.id)
    expect((await listInstagramTokensDue(ownerDb, KEY, new Date(Date.now() + 8 * 24 * 3_600_000))).map((due) => due.connectionId)).toContain(created.id)
  })
})

describe("volver a conectar a mano una cuenta desconectada", () => {
  it("la misma cuenta vuelve con su fila y sus conversaciones, con los datos nuevos; activa, se dice que ya está", async () => {
    const instagram = (async () => new Response(JSON.stringify({ id: "IG-VUELVE", username: "vuelve" }), { status: 200 })) as unknown as typeof fetch
    const deps = { fetch: instagram, validateExternal: true }
    const input = { channel: "instagram" as const, provider: "instagram" as const, config: { instagramId: "IG-VUELVE", accessToken: "UNO", appSecret: "s" } }
    const first = await withOrgContext(appDb, "org_c", (tx) => createConnection(tx, "org_c", KEY, input, deps))
    await ownerDb.update(channelConnection).set({ status: "disabled" }).where(eq(channelConnection.id, first.id))
    const again = await withOrgContext(appDb, "org_c", (tx) =>
      createConnection(tx, "org_c", KEY, { ...input, config: { ...input.config, accessToken: "DOS" } }, deps),
    )
    expect(again.id).toBe(first.id)
    const [row] = await ownerDb.select().from(channelConnection).where(eq(channelConnection.id, first.id))
    expect(row?.status).toBe("active")
    expect(decryptConfig(KEY, row!.configEncrypted)).toMatchObject({ accessToken: "DOS" })
    await expect(withOrgContext(appDb, "org_c", (tx) => createConnection(tx, "org_c", KEY, input, deps))).rejects.toMatchObject({ code: "CONNECTION_EXISTS" })
  })
})

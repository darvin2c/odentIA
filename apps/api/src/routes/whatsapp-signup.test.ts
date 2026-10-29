process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { createHmac } from "node:crypto"
import type { Auth } from "@odentia/auth"
import { createAppDb, createOwnerDb, type Db, withOrgContext } from "@odentia/db"
import { channelConnection, channelTemplate, contact, contactIdentity } from "@odentia/db/schema/crm"
import { createConnection, decryptConfig, secretsKeyFromEnv, type Storage } from "@odentia/services"
import { and, eq, sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Context } from "hono"
import { Hono, type Next } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { requireOrgContext, requireSession } from "../lib/context.js"
import { createConnectionsRoute } from "./connections.js"
import type { CrmDeps } from "./helpers.js"
import { createWebhooksRoute } from "./webhooks.js"
import { createWhatsAppSignupRoute, type MetaSignupConfig, metaSignupFromEnv } from "./whatsapp-signup.js"

/**
 * «Conectar con Facebook» de punta a punta contra la base, con un `fetch` de
 * prueba que responde como publica Meta. NO acredita que Meta acepte nada de
 * esto: la app de odentIA todavía no existe y el flujo real no se ha probado.
 */
const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("ab".repeat(32))
const META: MetaSignupConfig = {
  appId: "APP1",
  appSecret: "secreto-de-la-app",
  configId: "CONFIG1",
  webhookVerifyToken: "reto-de-odentia",
  graphVersion: "v25.0",
}

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db

const storageStub = {} as Storage

interface Call {
  url: string
  method: string
  auth: string | null
  body: unknown
}

type Answer = { status?: number; json: unknown } | undefined

/** Meta de prueba: una cuenta sana, salvo lo que el caso dicte para una llamada. */
function fakeMeta(override?: (call: Call) => Answer) {
  const calls: Call[] = []
  let created = 500
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const call: Call = {
      url: String(url),
      method: init?.method ?? "GET",
      auth: headers["Authorization"] ?? null,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    const answer = override?.(call) ?? healthy(call)
    return new Response(JSON.stringify(answer.json), { status: answer.status ?? 200 })
  }) as typeof fetch
  function healthy(call: Call): { status?: number; json: unknown } {
    const path = new URL(call.url).pathname
    if (path.endsWith("/oauth/access_token")) return { json: { access_token: `clave-de-${new URL(call.url).searchParams.get("code")}`, token_type: "bearer", expires_in: 5_184_000 } }
    if (path.endsWith("/subscribed_apps")) return { json: { success: true } }
    if (path.endsWith("/register")) return { json: { success: true } }
    if (path.endsWith("/smb_app_data")) return { json: { request_id: `pedido-${(call.body as { sync_type: string }).sync_type}` } }
    if (call.url.includes("fields=display_phone_number")) {
      const id = path.split("/").at(-1)
      return { json: { id, display_phone_number: `+51 ${id}`, verified_name: "Clínica Sonríe" } }
    }
    if (call.url.includes("fields=quality_rating")) {
      return { json: { quality_rating: "GREEN", whatsapp_business_manager_messaging_limit: "TIER_250" } }
    }
    if (path.endsWith("/message_templates")) {
      if (call.method === "POST") return { json: { id: String(++created), status: "PENDING", category: (call.body as { category: string }).category } }
      return { json: { data: [] } }
    }
    return { status: 404, json: { error: { message: "Llamada no prevista", code: 100 } } }
  }
  /** Cada llamada como «MÉTODO ruta», sin la versión ni la consulta. */
  const steps = () => calls.map((call) => `${call.method} ${new URL(call.url).pathname.replace("/v25.0", "").replace("/v21.0", "")}`)
  const of = (method: string, part: string) => calls.filter((call) => call.method === method && call.url.includes(part))
  return { calls, fetch: impl, steps, of }
}

function stubOrg(orgId: string, role: string) {
  return async (c: Context, next: Next) => {
    c.set("orgId", orgId)
    c.set("userId", `u-${orgId}`)
    c.set("memberRole", role)
    await next()
  }
}

function buildApp(orgId: string, options: { role?: string; meta?: MetaSignupConfig | undefined; fetch?: typeof fetch; validateExternal?: boolean } = {}) {
  const deps: CrmDeps = {
    db: appDb,
    secretsKey: KEY,
    storage: storageStub,
    validateExternal: options.validateExternal ?? true,
    webhookBaseUrl: "https://api.example.com",
  }
  const app = new Hono()
  app.use("*", stubOrg(orgId, options.role ?? "owner"))
  app.route(
    "/channels/whatsapp/signup",
    createWhatsAppSignupRoute({ ...deps, meta: "meta" in options ? options.meta : META, ...(options.fetch ? { fetch: options.fetch } : {}) }),
  )
  app.route("/channels/connections", createConnectionsRoute(deps))
  return app
}

const post = (app: Hono, path: string, body?: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

interface SignupData {
  id: string
  displayName: string
  externalId: string
  status: string
  account: { name: string | null; number: string | null } | null
  templates: { canManage: boolean; requested: number; error: string | null } | null
  health: { quality: string | null; dailyLimit: number | null; number: string | null } | null
  signup: { subscribedAt: string | null; registeredAt: string | null; pending: { step: string; title: string; problem: string | null }[] } | null
}

async function connect(orgId: string, meta: ReturnType<typeof fakeMeta>, body: Record<string, unknown>) {
  const res = await post(buildApp(orgId, { fetch: meta.fetch }), "/channels/whatsapp/signup", body)
  const json = (await res.json()) as { data?: SignupData; error?: { code: string; message: string } }
  return { status: res.status, data: json.data, error: json.error }
}

const rowOf = async (id: string) => (await ownerDb.select().from(channelConnection).where(eq(channelConnection.id, id)))[0]!
const rowsOf = (orgId: string) => ownerDb.select().from(channelConnection).where(eq(channelConnection.organizationId, orgId))

async function newOrg(id: string) {
  await ownerDb.execute(sql`insert into "organization" ("id", "name", "slug", "created_at") values (${id}, ${`Clínica ${id}`}, ${id}, now())`)
  await ownerDb.execute(
    sql`insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale")
        values (${id}, ${`Clínica ${id}`}, 'PE', 'PEN', 'America/Lima', 'es-PE')`,
  )
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
  for (const id of ["org_a", "org_b", "org_c", "org_d", "org_e", "org_f", "org_g", "org_h", "org_j"]) await newOrg(id)
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

describe("la configuración de plataforma es opcional", () => {
  it("sin las cuatro variables no hay botón; con alguna de menos, tampoco, y se dice cuál falta", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const none = { META_APP_ID: "", META_APP_SECRET: "", META_LOGIN_CONFIG_ID: "", META_WEBHOOK_VERIFY_TOKEN: "", META_GRAPH_VERSION: "v25.0" }
    expect(metaSignupFromEnv(none)).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
    expect(metaSignupFromEnv({ ...none, META_APP_ID: "APP1", META_APP_SECRET: "s" })).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain("faltan META_LOGIN_CONFIG_ID, META_WEBHOOK_VERIFY_TOKEN")
    warn.mockRestore()
    expect(
      metaSignupFromEnv({ META_APP_ID: " APP1 ", META_APP_SECRET: "s", META_LOGIN_CONFIG_ID: "C", META_WEBHOOK_VERIFY_TOKEN: "t", META_GRAPH_VERSION: "v26.0" }),
    ).toEqual({ appId: "APP1", appSecret: "s", configId: "C", webhookVerifyToken: "t", graphVersion: "v26.0" })
  })

  it("la pantalla recibe lo que necesita para abrir la ventana, nunca la clave secreta", async () => {
    const on = await buildApp("org_a").request("/channels/whatsapp/signup")
    expect(on.status).toBe(200)
    const text = await on.text()
    expect(JSON.parse(text)).toEqual({ data: { enabled: true, appId: "APP1", configId: "CONFIG1", graphVersion: "v25.0" } })
    expect(text).not.toContain("secreto-de-la-app")
    expect(text).not.toContain("reto-de-odentia")

    const off = await buildApp("org_a", { meta: undefined }).request("/channels/whatsapp/signup")
    expect(await off.json()).toEqual({ data: { enabled: false, appId: null, configId: null, graphVersion: null } })
    // Donde no se llama al proveedor (desarrollo, pruebas de pantalla) el botón tampoco existe.
    const offline = await buildApp("org_a", { validateExternal: false }).request("/channels/whatsapp/signup")
    expect(await offline.json()).toMatchObject({ data: { enabled: false } })
    const refused = await post(buildApp("org_a", { meta: undefined }), "/channels/whatsapp/signup", { code: "c", wabaId: "1", phoneNumberId: "2" })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ error: { code: "SIGNUP_UNAVAILABLE" } })
  })

  it("leer es de quien abre Configuración; conectar, de quien la administra", async () => {
    const receptionist = buildApp("org_a", { role: "receptionist" })
    expect((await receptionist.request("/channels/whatsapp/signup")).status).toBe(403)
    expect((await post(receptionist, "/channels/whatsapp/signup", { code: "c", wabaId: "1", phoneNumberId: "2" })).status).toBe(403)
    expect((await post(receptionist, "/channels/whatsapp/signup/00000000-0000-4000-8000-000000000000/retry")).status).toBe(403)
  })

  it("desde el panel, la clínica sale de la membresía, nunca de la dirección", async () => {
    // La página del panel (`app.<dominio>/whatsapp/conectar?org=<slug>`) pide con
    // `x-odentia-org`; los guards reales comprueban la membresía y el rol.
    await ownerDb.execute(
      sql`insert into "user" ("id", "name", "email") values ('u-fb-owner', 'Dueña', 'fb-owner@test.dev'), ('u-fb-reception', 'Recepción', 'fb-reception@test.dev') on conflict do nothing`,
    )
    await ownerDb.execute(
      sql`insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values ('m-fb-owner', 'org_a', 'u-fb-owner', 'owner', now()), ('m-fb-reception', 'org_a', 'u-fb-reception', 'reception', now()) on conflict do nothing`,
    )
    const auth = {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const userId = headers.get("x-test-user")
          return userId ? { user: { id: userId, image: null }, session: { activeOrganizationId: null } } : null
        },
      },
    } as unknown as Auth
    const app = new Hono()
    app.use("*", requireSession({ auth }), requireOrgContext({ db: appDb }))
    app.route(
      "/channels/whatsapp/signup",
      createWhatsAppSignupRoute({ db: appDb, secretsKey: KEY, storage: storageStub, validateExternal: true, webhookBaseUrl: "https://api.example.com", meta: META }),
    )
    const ask = (userId: string | null, slug: string, method: "GET" | "POST" = "GET") =>
      app.request("/channels/whatsapp/signup", {
        method,
        headers: { "content-type": "application/json", "x-odentia-org": slug, ...(userId ? { "x-test-user": userId } : {}) },
        ...(method === "POST" ? { body: JSON.stringify({ code: "c", wabaId: "1", phoneNumberId: "2" }) } : {}),
      })

    expect((await ask("u-fb-owner", "org_a")).status).toBe(200)
    // Sin sesión, de otra clínica o sin administrar la configuración: no se abre ni se conecta.
    expect((await ask(null, "org_a")).status).toBe(401)
    const foreign = await ask("u-fb-owner", "org_b")
    expect(foreign.status).toBe(403)
    expect(await foreign.json()).toMatchObject({ error: { code: "FORBIDDEN" } })
    expect((await ask("u-fb-owner", "org_b", "POST")).status).toBe(403)
    expect((await ask("u-fb-reception", "org_a")).status).toBe(403)
    expect((await ask("u-fb-reception", "org_a", "POST")).status).toBe(403)
    expect((await ask("u-fb-owner", "no-existe")).status).toBe(404)
  })
})

describe("conectar con Facebook", () => {
  it("canjea el código, guarda la conexión, suscribe la app, registra el número y pide los doce mensajes", async () => {
    const meta = fakeMeta()
    const { status, data } = await connect("org_a", meta, { code: "codigo-a", wabaId: "7001", phoneNumberId: "9001" })
    expect(status).toBe(201)
    // El orden importa: el código primero (30 segundos) y la suscripción antes de pedir mensajes.
    expect(meta.steps()).toEqual([
      "GET /oauth/access_token",
      "GET /9001",
      "POST /7001/subscribed_apps",
      "POST /9001/register",
      "GET /9001",
      "GET /7001/message_templates",
      // Los diez del agente, «Retomar la conversación» y «Ver respuesta» (R1 del pulido de la Bandeja).
      ...Array<string>(12).fill("POST /7001/message_templates"),
    ])
    // Todo lo que sigue al canje viaja con la clave de la clínica, no con la de la app.
    expect(new Set(meta.calls.slice(1).map((call) => call.auth))).toEqual(new Set(["Bearer clave-de-codigo-a"]))
    expect(data).toMatchObject({
      displayName: "Clínica Sonríe",
      externalId: "9001",
      status: "active",
      account: { name: "Clínica Sonríe", number: "+51 9001" },
      templates: { canManage: true, requested: 12, error: null },
      health: { quality: "alta", dailyLimit: 250, number: "+51 9001" },
      signup: { pending: [] },
    })
    expect(data!.signup!.subscribedAt).not.toBeNull()
    expect(data!.signup!.registeredAt).not.toBeNull()
    expect(JSON.stringify(data)).not.toContain("clave-de-codigo-a")
    expect(data).not.toHaveProperty("webhookSecret")

    const row = await rowOf(data!.id)
    expect(row).toMatchObject({ provider: "whatsapp_cloud_api", channel: "whatsapp", externalId: "9001", accountExternalId: "7001" })
    const config = decryptConfig(KEY, row.configEncrypted)
    // Sin clave secreta de una app: los avisos llegan por la de odentIA. El PIN queda cifrado con la conexión.
    expect(Object.keys(config).sort()).toEqual(["accessToken", "phoneNumberId", "registrationPin", "wabaId"])
    expect(config["registrationPin"]).toMatch(/^\d{6}$/)
    expect(meta.of("POST", "/register")[0]!.body).toEqual({ messaging_product: "whatsapp", pin: config["registrationPin"] })
    expect(row.configEncrypted).not.toContain(String(config["registrationPin"]))
    // Cuándo vence la clave que dio Meta: a los 60 días que dijo `expires_in`.
    const expiresIn = new Date(row.signup!.tokenExpiresAt!).getTime() - Date.now()
    expect(expiresIn).toBeGreaterThan(59.9 * 86_400_000)
    expect(expiresIn).toBeLessThanOrEqual(60 * 86_400_000)

    // La lista de conexiones la muestra con sus pasos hechos.
    const list = (await (await buildApp("org_a").request("/channels/connections")).json()) as { data: SignupData[] }
    expect(list.data.find((item) => item.id === data!.id)?.signup).toMatchObject({ pending: [] })
  })

  it("un número que sigue en la app WhatsApp Business del celular no se registra: ya lo está", async () => {
    const meta = fakeMeta()
    const { status, data } = await connect("org_g", meta, { code: "codigo-g", wabaId: "7007", phoneNumberId: "9007", businessApp: true })
    expect(status).toBe(201)
    expect(meta.of("POST", "/register")).toHaveLength(0)
    // Suscrita la app, se pide la agenda y después el historial del celular, una vez cada uno.
    expect(meta.steps().slice(0, 5)).toEqual([
      "GET /oauth/access_token",
      "GET /9007",
      "POST /7007/subscribed_apps",
      "POST /9007/smb_app_data",
      "POST /9007/smb_app_data",
    ])
    expect(meta.of("POST", "/smb_app_data").map((call) => call.body)).toEqual([
      { messaging_product: "whatsapp", sync_type: "smb_app_state_sync" },
      { messaging_product: "whatsapp", sync_type: "history" },
    ])
    expect(data).toMatchObject({ externalId: "9007", signup: { pending: [], businessApp: true, historyDeclined: false } })
    expect(data!.signup!.registeredAt).not.toBeNull()
    expect((await rowOf(data!.id)).signup).toMatchObject({
      businessApp: true,
      sync: { contacts: { requestId: "pedido-smb_app_state_sync" }, history: { requestId: "pedido-history" } },
    })
  })

  it("si el historial falla, queda pendiente y el reintento no vuelve a pedir la agenda", async () => {
    await newOrg("org_i")
    const meta = fakeMeta((call) =>
      call.url.includes("/smb_app_data") && (call.body as { sync_type: string }).sync_type === "history"
        ? { status: 500, json: { error: { message: "Error temporal", code: 2 } } }
        : undefined,
    )
    const { data } = await connect("org_i", meta, { code: "codigo-i", wabaId: "7009", phoneNumberId: "9009", businessApp: true })
    expect(data!.signup!.pending).toEqual([
      { step: "sincronizar", title: expect.stringContaining("24 horas"), problem: "Meta no respondió. Reintenta en un momento." },
    ])
    const again = fakeMeta()
    const retry = await post(buildApp("org_i", { fetch: again.fetch }), `/channels/whatsapp/signup/${data!.id}/retry`)
    expect(retry.status).toBe(200)
    expect(again.of("POST", "/smb_app_data").map((call) => (call.body as { sync_type: string }).sync_type)).toEqual(["history"])
    expect(((await retry.json()) as { data: SignupData }).data.signup!.pending).toEqual([])
    // Pasadas las 24 horas ya no se pide: Meta no lo deja; se dice que hay que volver a conectar.
    const row = await rowOf(data!.id)
    await ownerDb
      .update(channelConnection)
      .set({ signup: { ...row.signup!, grantedAt: new Date(Date.now() - 25 * 3_600_000).toISOString(), sync: {} } })
      .where(eq(channelConnection.id, data!.id))
    const late = fakeMeta()
    const expired = (await (await post(buildApp("org_i", { fetch: late.fetch }), `/channels/whatsapp/signup/${data!.id}/retry`)).json()) as { data: SignupData }
    expect(late.of("POST", "/smb_app_data")).toHaveLength(0)
    expect(expired.data.signup!.pending[0]!.problem).toContain("Vuelve a conectar con Facebook")
  })

  it("si Meta solo dice la cuenta, el número de la app del celular se busca en ella", async () => {
    const meta = fakeMeta((call) =>
      call.url.includes("/7008/phone_numbers") ? { json: { data: [{ id: "9008" }] } } : undefined,
    )
    const { status, data } = await connect("org_h", meta, { code: "codigo-h", wabaId: "7008", businessApp: true })
    expect(status).toBe(201)
    expect(meta.steps().slice(0, 3)).toEqual(["GET /oauth/access_token", "GET /7008/phone_numbers", "GET /9008"])
    expect(data).toMatchObject({ externalId: "9008", signup: { pending: [] } })
    // Sin `businessApp` el número sigue siendo obligatorio.
    const missing = await connect("org_h", fakeMeta(), { code: "codigo-x", wabaId: "7008" })
    expect(missing.status).toBe(400)
  })

  it("el número que ya está conectado responde el mismo 409, aquí o en otra clínica", async () => {
    const meta = fakeMeta()
    const again = await connect("org_a", meta, { code: "codigo-a2", wabaId: "7001", phoneNumberId: "9001" })
    expect(again.status).toBe(409)
    expect(again.error).toMatchObject({
      code: "CONNECTION_EXISTS",
      message: "Esa cuenta ya está conectada como «Clínica Sonríe». Ábrela y vuelve a conectarla con Facebook en vez de crear otra conexión.",
    })
    const other = await connect("org_b", meta, { code: "codigo-b", wabaId: "7001", phoneNumberId: "9001" })
    expect(other.status).toBe(409)
    expect(other.error).toMatchObject({ code: "CONNECTION_EXISTS", message: "Esa cuenta ya está conectada en otra clínica de odentIA." })
    // No se tocó Meta más allá de canjear y leer el número: ni suscripción ni registro.
    expect(meta.of("POST", "/subscribed_apps")).toEqual([])
    expect(meta.of("POST", "/register")).toEqual([])
    expect(await rowsOf("org_b")).toEqual([])
  })

  it("un código vencido se dice con su arreglo y no guarda nada ni sigue llamando", async () => {
    const meta = fakeMeta((call) =>
      call.url.includes("/oauth/access_token")
        ? { status: 400, json: { error: { message: "This authorization code has expired.", type: "OAuthException", code: 100 } } }
        : undefined,
    )
    const { status, error } = await connect("org_b", meta, { code: "viejo", wabaId: "7002", phoneNumberId: "9002" })
    expect(status).toBe(400)
    expect(error).toMatchObject({
      code: "SIGNUP_CODE_EXPIRED",
      message:
        "El permiso de Facebook ya no sirve: dura 30 segundos y se usa una sola vez. No se conectó nada: vuelve a pulsar «Conectar con Facebook». Meta dijo: «This authorization code has expired.».",
    })
    expect(meta.calls).toHaveLength(1)
    expect(await rowsOf("org_b")).toEqual([])
  })

  it("si Meta no responde, o no deja leer el número, tampoco se guarda nada", async () => {
    const down = fakeMeta((call) => (call.url.includes("/oauth/access_token") ? { status: 503, json: { error: { message: "Service temporarily unavailable", code: 2 } } } : undefined))
    expect((await connect("org_b", down, { code: "c1", wabaId: "7002", phoneNumberId: "9002" })).error).toMatchObject({
      code: "META_UNAVAILABLE",
      message: "Meta no respondió, y el permiso que diste dura 30 segundos. No se conectó nada: vuelve a pulsar «Conectar con Facebook».",
    })
    const misconfigured = fakeMeta((call) =>
      call.url.includes("/oauth/access_token") ? { status: 400, json: { error: { message: "Error validating client secret.", type: "OAuthException", code: 1 } } } : undefined,
    )
    expect((await connect("org_b", misconfigured, { code: "c2", wabaId: "7002", phoneNumberId: "9002" })).error).toMatchObject({ code: "SIGNUP_MISCONFIGURED" })
    const hidden = fakeMeta((call) => (call.url.includes("fields=display_phone_number") ? { status: 400, json: { error: { message: "Unsupported get request", code: 100 } } } : undefined))
    const refused = await connect("org_b", hidden, { code: "c3", wabaId: "7002", phoneNumberId: "9002" })
    expect(refused.status).toBe(400)
    expect(refused.error).toMatchObject({ code: "CONNECTION_REJECTED", message: expect.stringContaining("Meta no dejó leer ese número") })
    expect(await rowsOf("org_b")).toEqual([])
    // Lo que no tiene forma de dato de Meta no llega a Meta.
    const untouched = fakeMeta()
    expect((await connect("org_b", untouched, { code: "c4", wabaId: "7002/x", phoneNumberId: "9002" })).status).toBe(400)
    expect(untouched.calls).toEqual([])
  })

  it("si el registro falla después de crear, la conexión queda con el paso pendiente y se reintenta sin otra ventana", async () => {
    const meta = fakeMeta((call) =>
      call.url.endsWith("/register")
        ? { status: 400, json: { error: { message: "(#133005) Two step verification PIN Mismatch", code: 133005, error_data: { messaging_product: "whatsapp", details: "PIN mismatch" } } } }
        : undefined,
    )
    const { status, data } = await connect("org_c", meta, { code: "codigo-c", wabaId: "7003", phoneNumberId: "9003" })
    // La conexión existe: el código ya se gastó y no se deshace nada. Dice qué falta.
    expect(status).toBe(201)
    expect(data!.signup!.subscribedAt).not.toBeNull()
    expect(data!.signup).toMatchObject({
      registeredAt: null,
      pending: [
        {
          step: "registrar",
          title: expect.stringContaining("Falta registrar el número en WhatsApp"),
          problem:
            "Ese número ya tiene un PIN de verificación en dos pasos que odentIA no conoce. Desactiva la verificación en dos pasos del número en el Administrador de WhatsApp de la clínica y reintenta.",
        },
      ],
    })
    // Lo demás siguió: la salud y los mensajes no dependen del registro.
    expect(data).toMatchObject({ templates: { requested: 12 }, health: { quality: "alta" } })
    const pin = decryptConfig(KEY, (await rowOf(data!.id)).configEncrypted)["registrationPin"]

    // «Reintentar»: solo el paso que falta, con el permiso y el PIN guardados.
    const fixed = fakeMeta()
    const retried = await post(buildApp("org_c", { fetch: fixed.fetch }), `/channels/whatsapp/signup/${data!.id}/retry`)
    expect(retried.status).toBe(200)
    const after = ((await retried.json()) as { data: SignupData }).data
    expect(fixed.steps().slice(0, 1)).toEqual(["POST /9003/register"])
    expect(fixed.of("POST", "/subscribed_apps")).toEqual([])
    expect(fixed.of("POST", "/register")[0]).toMatchObject({ auth: "Bearer clave-de-codigo-c", body: { messaging_product: "whatsapp", pin } })
    expect(fixed.of("GET", "/oauth/access_token")).toEqual([])
    expect(after.id).toBe(data!.id)
    expect(after.signup).toMatchObject({ pending: [] })
    expect(after.signup!.registeredAt).not.toBeNull()
    // Los mensajes ya estaban pedidos: no se piden dos veces.
    expect(after.templates).toMatchObject({ requested: 0, error: null })
    expect((await rowsOf("org_c")).length).toBe(1)

    expect((await post(buildApp("org_c"), "/channels/whatsapp/signup/no-es-un-id/retry")).status).toBe(404)
  })

  it("si la suscripción falla, lo dice; y cada falla de Meta lleva su frase", async () => {
    const meta = fakeMeta((call) => {
      if (call.url.endsWith("/subscribed_apps")) return { status: 403, json: { error: { message: "(#200) Permissions error", code: 200 } } }
      if (call.url.endsWith("/register")) return { status: 400, json: { error: { message: "(#133006) Phone number needs to be verified", code: 133006 } } }
      return undefined
    })
    const { status, data } = await connect("org_d", meta, { code: "codigo-d", wabaId: "7004", phoneNumberId: "9004" })
    expect(status).toBe(201)
    expect(data!.signup).toMatchObject({
      subscribedAt: null,
      registeredAt: null,
      pending: [
        {
          step: "suscribir",
          title: expect.stringContaining("todavía no llega a la Bandeja"),
          problem: "A odentIA le falta permiso sobre esa cuenta de WhatsApp. Vuelve a conectar con Facebook y acepta todos los permisos que pide la ventana de Meta.",
        },
        {
          step: "registrar",
          problem: "El número todavía no está verificado. Vuelve a conectar con Facebook y, en la ventana de Meta, confírmalo con el código que llega al teléfono.",
        },
      ],
    })
    const problems = async (answer: (call: Call) => Answer) => {
      const res = await post(buildApp("org_d", { fetch: fakeMeta(answer).fetch }), `/channels/whatsapp/signup/${data!.id}/retry`)
      return ((await res.json()) as { data: SignupData }).data.signup!.pending.map((item) => item.problem)
    }
    expect(
      await problems((call) => (call.method === "POST" && !call.url.includes("message_templates") ? { status: 500, json: { error: { message: "An unexpected error occurred", code: 2 } } } : undefined)),
    ).toEqual(["Meta no respondió. Reintenta en un momento.", "Meta no respondió. Reintenta en un momento."])
    expect(
      await problems((call) => {
        if (call.url.endsWith("/subscribed_apps")) return { status: 401, json: { error: { message: "Error validating access token", code: 190 } } }
        if (call.url.endsWith("/register")) return { status: 400, json: { error: { message: "(#133016) Account register deregister rate limit exceeded", code: 133016 } } }
        return undefined
      }),
    ).toEqual([
      "El permiso que diste con Facebook venció o fue retirado. Vuelve a conectar con Facebook.",
      "WhatsApp bloqueó el registro de ese número por demasiados intentos. Dura 72 horas: reintenta cuando pasen.",
    ])
    expect(
      await problems((call) => (call.url.endsWith("/register") ? { status: 400, json: { error: { message: "(#100) Invalid parameter", code: 100, error_data: { details: "Algo que no conocemos" } } } } : undefined)),
    ).toEqual(["Meta no aceptó este paso: Algo que no conocemos. Reintenta; si sigue igual, vuelve a conectar con Facebook."])
    // Sigue siendo una sola conexión, con la suscripción ya hecha y el registro pendiente.
    const [row] = await rowsOf("org_d")
    expect(row!.signup).toMatchObject({ registeredAt: null, problems: { registrar: expect.stringContaining("Algo que no conocemos") } })
    expect(row!.signup!.subscribedAt).not.toBeNull()
    expect(row!.signup!.problems).not.toHaveProperty("suscribir")
  })
})

describe("volver a conectar", () => {
  it("reemplaza el permiso de la misma conexión: no crea otra ni registra de nuevo el número", async () => {
    const [before] = await rowsOf("org_a")
    // La clave nueva dura otro plazo: el vencimiento guardado es el de esta, no el de la anterior.
    const meta = fakeMeta((call) =>
      call.url.includes("/oauth/access_token") ? { json: { access_token: "clave-de-codigo-nuevo", expires_in: 86_400 } } : undefined,
    )
    const { status, data } = await connect("org_a", meta, { code: "codigo-nuevo", wabaId: "7001", phoneNumberId: "9001", reconnectConnectionId: before!.id })
    expect(status).toBe(200)
    expect(data!.id).toBe(before!.id)
    expect(meta.steps().slice(0, 3)).toEqual(["GET /oauth/access_token", "GET /9001", "POST /7001/subscribed_apps"])
    expect(meta.of("POST", "/register")).toEqual([])
    expect(meta.of("POST", "/message_templates")).toEqual([])
    const after = await rowOf(before!.id)
    expect(await rowsOf("org_a")).toHaveLength(1)
    const config = decryptConfig(KEY, after.configEncrypted)
    expect(config["accessToken"]).toBe("clave-de-codigo-nuevo")
    // El PIN, la dirección y lo ya hecho siguen siendo los mismos.
    expect(config["registrationPin"]).toBe(decryptConfig(KEY, before!.configEncrypted)["registrationPin"])
    expect(after).toMatchObject({ webhookSecret: before!.webhookSecret, externalId: "9001", displayName: before!.displayName, createdAt: before!.createdAt })
    expect(after.signup!.registeredAt).toBe(before!.signup!.registeredAt)
    expect(new Date(after.signup!.tokenExpiresAt!).getTime() - Date.now()).toBeLessThanOrEqual(86_400_000)
    expect(data!.signup).toMatchObject({ pending: [] })
  })

  it("con otro número no cambia nada; y una conexión hecha a mano no se vuelve a conectar con el botón", async () => {
    const [mine] = await rowsOf("org_a")
    const other = await connect("org_a", fakeMeta(), { code: "codigo-x", wabaId: "7001", phoneNumberId: "9999", reconnectConnectionId: mine!.id })
    expect(other.status).toBe(400)
    expect(other.error!.message).toContain("En la ventana de Meta elegiste otro número.")
    expect(decryptConfig(KEY, (await rowOf(mine!.id)).configEncrypted)["accessToken"]).toBe("clave-de-codigo-nuevo")

    const manual = await withOrgContext(appDb, "org_e", (tx) =>
      createConnection(
        tx,
        "org_e",
        KEY,
        { channel: "whatsapp", provider: "whatsapp_cloud_api", displayName: "A mano", config: { phoneNumberId: "9005", wabaId: "7005", accessToken: "clave-a-mano", appSecret: "secreto-de-la-clinica" } },
        { fetch: fakeMeta().fetch },
      ),
    )
    expect(manual.signup).toBeNull()
    const refused = await connect("org_e", fakeMeta(), { code: "codigo-e", wabaId: "7005", phoneNumberId: "9005", reconnectConnectionId: manual.id })
    expect(refused.status).toBe(400)
    expect(refused.error!.message).toBe("Esta conexión se hizo con los datos de la app de Meta de la clínica: se le cambia la clave, no se vuelve a conectar con Facebook.")
    expect(decryptConfig(KEY, (await rowOf(manual.id)).configEncrypted)).toMatchObject({ accessToken: "clave-a-mano", appSecret: "secreto-de-la-clinica" })
    expect((await post(buildApp("org_e"), `/channels/whatsapp/signup/${manual.id}/retry`)).status).toBe(400)
  })

  it("una conexión hecha con el botón no admite una clave escrita ni ofrece una dirección que copiar", async () => {
    const [mine] = await rowsOf("org_a")
    const app = buildApp("org_a", { fetch: fakeMeta().fetch })
    const key = await post(app, `/channels/connections/${mine!.id}/credentials`, { config: { accessToken: "otra" } })
    expect(key.status).toBe(400)
    expect(((await key.json()) as { error: { message: string } }).error.message).toContain("no usa una clave escrita")
    const setup = await app.request(`/channels/connections/${mine!.id}/setup`)
    expect(setup.status).toBe(400)
    expect(((await setup.json()) as { error: { message: string } }).error.message).toContain("no hay una dirección que copiar")
  })
})

describe("la dirección de avisos de la app de odentIA", () => {
  const sign = (raw: string, secret = META.appSecret) => `sha256=${createHmac("sha256", secret).update(raw, "utf8").digest("hex")}`
  const webhooks = (metaApp: { appSecret: string; verifyToken: string } | undefined = { appSecret: META.appSecret, verifyToken: META.webhookVerifyToken }) =>
    createWebhooksRoute({ ownerDb, db: appDb, secretsKey: KEY, metaApp })
  const deliver = (raw: string, signature = sign(raw)) =>
    webhooks().request("/meta/whatsapp", { method: "POST", headers: { "x-hub-signature-256": signature, "content-type": "application/json" }, body: raw })

  const queued = async () =>
    ((await ownerDb.execute(sql`select message from pgmq.q_inbound_messages order by msg_id`)) as unknown as { message: { orgId: string; connectionId: string; event: { externalEventId: string } } }[]).map(
      (row) => `${row.message.orgId} ${row.message.event.externalEventId}`,
    )
  const text = (id: string, from: string) => ({ from, id, timestamp: "1735689600", type: "text", text: { body: "Hola" } })
  const messages = (accountId: string, phoneNumberId: string, list: unknown[]) => ({
    id: accountId,
    changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "x", phone_number_id: phoneNumberId }, messages: list } }],
  })
  const templateChange = (accountId: string, name: string, event: string, reason = "NONE") => ({
    id: accountId,
    changes: [{ field: "message_template_status_update", value: { event, message_template_id: 1, message_template_name: name, message_template_language: "es", reason } }],
  })
  const body = (...entry: unknown[]) => JSON.stringify({ object: "whatsapp_business_account", entry })
  const templateOf = async (orgId: string, name: string) => {
    const [connection] = await rowsOf(orgId)
    const [row] = await ownerDb
      .select({ status: channelTemplate.status, reason: channelTemplate.reason })
      .from(channelTemplate)
      .where(and(eq(channelTemplate.connectionId, connection!.id), eq(channelTemplate.name, name)))
    return row
  }

  it("responde el reto con la clave de la plataforma, y no existe sin configurar", async () => {
    const ok = await webhooks().request(`/meta/whatsapp?hub.mode=subscribe&hub.verify_token=${META.webhookVerifyToken}&hub.challenge=RETO`)
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe("RETO")
    expect((await webhooks().request("/meta/whatsapp?hub.mode=subscribe&hub.verify_token=otra&hub.challenge=RETO")).status).toBe(403)
    const off = createWebhooksRoute({ ownerDb, db: appDb, secretsKey: KEY })
    expect((await off.request(`/meta/whatsapp?hub.mode=subscribe&hub.verify_token=${META.webhookVerifyToken}&hub.challenge=RETO`)).status).toBe(404)
    expect((await off.request("/meta/whatsapp", { method: "POST", body: "{}" })).status).toBe(404)
  })

  it("una firma inválida no entra", async () => {
    const raw = body(messages("7001", "9001", [text("wamid.firma", "51911111111")]))
    expect((await deliver(raw, "sha256=00")).status).toBe(401)
    // Firmado con la clave de la app de otra clínica tampoco.
    expect((await deliver(raw, sign(raw, "secreto-de-la-clinica"))).status).toBe(401)
    expect((await webhooks().request("/meta/whatsapp", { method: "POST", body: raw })).status).toBe(401)
    expect(await queued()).toEqual([])
  })

  it("reparte cada mensaje a la conexión de su número, de dos clínicas en el mismo envío, y no lo repite", async () => {
    const raw = body(
      messages("7001", "9001", [text("wamid.A1", "51911111111")]),
      messages("7003", "9003", [text("wamid.C1", "51922222222"), text("wamid.C2", "51922222222")]),
    )
    expect((await deliver(raw)).status).toBe(200)
    expect(await queued()).toEqual(["org_a wamid.A1", "org_c wamid.C1", "org_c wamid.C2"])
    const [a] = await rowsOf("org_a")
    const rows = (await ownerDb.execute(sql`select message from pgmq.q_inbound_messages order by msg_id`)) as unknown as { message: { connectionId: string } }[]
    expect(rows[0]!.message.connectionId).toBe(a!.id)
    // Meta reintenta: el libro de duplicados es el mismo que el de la dirección por conexión.
    expect((await deliver(raw)).status).toBe(200)
    expect(await queued()).toHaveLength(3)
  })

  it("lo que no es de ninguna conexión se descarta con registro y sin error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const raw = body(
      messages("7999", "9999", [text("wamid.nadie", "51933333333")]),
      // El número de una conexión hecha a mano con otra app no recibe por aquí: sigue con su propia dirección.
      messages("7005", "9005", [text("wamid.a-mano", "51944444444")]),
      templateChange("7999", "odentia_recordatorio_cita_v2", "APPROVED"),
    )
    const res = await deliver(raw)
    expect(res.status).toBe(200)
    expect(await queued()).toHaveLength(3)
    expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
      "[webhooks] aviso de WhatsApp descartado: el número 9999 no es de una conexión activa de la app de odentIA",
      "[webhooks] aviso de WhatsApp descartado: el número 9005 no es de una conexión activa de la app de odentIA",
      "[webhooks] cambio de plantilla descartado: la cuenta 7999 no es de una conexión activa y suscrita",
    ])
    warn.mockRestore()
  })

  it("una conexión hecha a mano con la misma app de odentIA recibe por aquí: Meta no le deja otra dirección", async () => {
    const mine = await withOrgContext(appDb, "org_j", (tx) =>
      createConnection(
        tx,
        "org_j",
        KEY,
        { channel: "whatsapp", provider: "whatsapp_cloud_api", displayName: "Con la app de odentIA", config: { phoneNumberId: "9010", wabaId: "7010", accessToken: "clave-del-sistema", appSecret: META.appSecret } },
        { fetch: fakeMeta().fetch },
      ),
    )
    expect(mine.signup).toBeNull()
    expect((await rowOf(mine.id)).ownApp).not.toBeNull()
    const raw = body(messages("7010", "9010", [text("wamid.misma-app", "51966666666")]))
    expect((await deliver(raw)).status).toBe(200)
    expect((await queued()).at(-1)).toBe("org_j wamid.misma-app")
  })

  it("una plantilla que cambia de estado se aplica a la cuenta que la tiene, y solo a esa", async () => {
    expect(await templateOf("org_a", "odentia_recordatorio_cita_v2")).toEqual({ status: "en_revision", reason: null })
    const raw = body(
      templateChange("7001", "odentia_recordatorio_cita_v2", "APPROVED"),
      templateChange("7003", "odentia_cita_cancelada_v1", "REJECTED", "INVALID_FORMAT"),
    )
    expect((await deliver(raw)).status).toBe(200)
    expect(await templateOf("org_a", "odentia_recordatorio_cita_v2")).toEqual({ status: "aprobada", reason: null })
    expect(await templateOf("org_c", "odentia_cita_cancelada_v1")).toEqual({ status: "rechazada", reason: "INVALID_FORMAT" })
    // La misma plantilla en la otra clínica no se movió.
    expect(await templateOf("org_c", "odentia_recordatorio_cita_v2")).toEqual({ status: "en_revision", reason: null })
    expect(await templateOf("org_a", "odentia_cita_cancelada_v1")).toEqual({ status: "en_revision", reason: null })
  })

  it("quien dice ser de una cuenta sin que Meta haya confirmado su suscripción no recibe los cambios de esa cuenta", async () => {
    // org_f conecta su propio número diciendo que es de la cuenta 7001, que es de org_a: Meta no le deja suscribirse.
    const meta = fakeMeta((call) => (call.url.endsWith("/7001/subscribed_apps") ? { status: 403, json: { error: { message: "(#200) Permissions error", code: 200 } } } : undefined))
    const { data } = await connect("org_f", meta, { code: "codigo-f", wabaId: "7001", phoneNumberId: "9006" })
    expect(data!.signup).toMatchObject({ subscribedAt: null })
    expect((await deliver(body(templateChange("7001", "odentia_cita_cancelada_v1", "PAUSED")))).status).toBe(200)
    expect((await templateOf("org_a", "odentia_cita_cancelada_v1"))?.status).toBe("pausada")
    expect((await templateOf("org_f", "odentia_cita_cancelada_v1"))?.status).toBe("en_revision")
  })

  it("coexistencia: lo del celular entra por la misma cola; la agenda solo nombra a quien ya escribió sin nombres", async () => {
    const [g] = await rowsOf("org_g")
    const person = async (name: string, number: string, given: string | null) => {
      const [row] = await ownerDb.insert(contact).values({ organizationId: "org_g", displayName: name, givenNames: given }).returning({ id: contact.id })
      await ownerDb.insert(contactIdentity).values({ organizationId: "org_g", contactId: row!.id, channel: "whatsapp", externalUserId: `wa:${number}` })
      return row!.id
    }
    const unnamed = await person("51977000111", "51977000111", null)
    const registered = await person("Ana Torres", "51977000222", "Ana")
    const change = (field: string, value: Record<string, unknown>) => ({
      id: "7007",
      changes: [{ field, value: { messaging_product: "whatsapp", metadata: { display_phone_number: "x", phone_number_id: "9007" }, ...value } }],
    })
    const raw = body(
      change("smb_message_echoes", {
        message_echoes: [{ from: "51900000007", to: "51977000111", id: "wamid.ECO1", timestamp: "1735689600", type: "text", text: { body: "Te esperamos" } }],
      }),
      change("smb_app_state_sync", {
        state_sync: [
          { type: "contact", action: "add", contact: { full_name: "Rosa Quispe", phone_number: "51977000111" } },
          { type: "contact", action: "add", contact: { full_name: "Anita", phone_number: "51977000222" } },
          // Quien nunca escribió no se crea.
          { type: "contact", action: "add", contact: { full_name: "Proveedor", phone_number: "51977000333" } },
        ],
      }),
      change("history", { history: [{ errors: [{ code: 2593109, title: "History sync is turned off" }] }] }),
    )
    expect((await deliver(raw)).status).toBe(200)
    expect((await queued()).at(-1)).toBe("org_g wamid.ECO1")
    const names = await ownerDb.select({ id: contact.id, name: contact.displayName }).from(contact).where(eq(contact.organizationId, "org_g"))
    expect(names.find((row) => row.id === unnamed)?.name).toBe("Rosa Quispe")
    // Registrada con sus nombres (el nombre visible lo arma la base): la agenda no la cambia.
    expect(names.find((row) => row.id === registered)?.name).toBe("Ana")
    expect(names).toHaveLength(2)
    expect((await rowOf(g!.id)).signup?.sync?.historyDeclinedAt).toBeTruthy()
  })

  it("la dirección propia de una conexión hecha con el botón no acepta avisos; la de una hecha a mano sigue igual", async () => {
    const [embedded] = await rowsOf("org_a")
    const [manual] = await rowsOf("org_e")
    const raw = body(messages("7005", "9005", [text("wamid.manual-propia", "51955555555")]))
    const own = (id: string, secret: string) =>
      webhooks().request(`/channels/whatsapp_cloud_api/${id}`, { method: "POST", headers: { "x-hub-signature-256": sign(raw, secret), "content-type": "application/json" }, body: raw })
    expect((await own(embedded!.id, META.appSecret)).status).toBe(401)
    expect((await own(manual!.id, "secreto-de-la-clinica")).status).toBe(200)
    expect((await queued()).at(-1)).toBe("org_e wamid.manual-propia")
  })
})

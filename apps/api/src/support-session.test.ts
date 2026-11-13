// Testcontainers usa el socket Podman compartido en /mnt/wsl (ver rls.test.ts).
process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import type { Auth } from "@odentia/auth"
import { createAppDb, createOwnerDb, type Db, withOrgContext } from "@odentia/db"
import { createSupportPass, giveSupportAccessFromHelp, secretsKeyFromEnv, type Storage } from "@odentia/services"
import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Hono } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import { createApp } from "./app.js"

/**
 * Soporte mirando la clínica con un rol (ADR 0184), contra la app real: solo
 * lee, no descarga, no sale de su clínica y, quitado el acceso, no sigue.
 * Solo se simula la sesión de Better Auth (soporte no la usa).
 */

const IMAGE = "dentalagent-postgres:18.6"
const ORG = "org_sop_a"
const SLUG = "sopa"
const OTHER_ORG = "org_sop_b"
const OTHER_SLUG = "sopb"
const ORIGIN = `https://${SLUG}.odentia.localhost`

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db
let app: Hono

const authStub = { api: { getSession: async () => null } } as unknown as Auth

function call(cookie: string | null, method: string, path: string, body?: unknown, slug = SLUG) {
  return app.request(`/api${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "x-odentia-org": slug,
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function code(response: Response): Promise<string | undefined> {
  return ((await response.clone().json()) as { error?: { code?: string } }).error?.code
}

/** La propietaria da acceso como `role`, soporte pide el pase y lo canjea: la cookie de la sesión. */
async function enter(role: string): Promise<{ cookie: string; caseId: string; grantId: string }> {
  const { caseId, grant } = await withOrgContext(appDb, ORG, (tx) =>
    giveSupportAccessFromHelp(tx, ORG, "u-sop-owner", true, { minutes: 30, viewRole: role, screen: "/", role: "Propietario", appVersion: null }),
  )
  const pass = await ownerDb.transaction((tx) => createSupportPass(tx as Db, { userId: "u-sop-staff", role: "support" }, caseId))
  const redeemed = await call(null, "POST", "/support-session/redeem", { pass: pass.token })
  expect(redeemed.status).toBe(200)
  const setCookie = redeemed.headers.get("set-cookie") ?? ""
  const cookie = setCookie.split(";")[0] ?? ""
  expect(cookie).toMatch(/^odentia_soporte=/)
  expect(setCookie).toMatch(/HttpOnly/)
  return { cookie, caseId, grantId: grant.id }
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
  await ownerDb.execute(sql`
    insert into "organization" ("id", "name", "slug", "created_at") values
      (${ORG}, 'Clínica Soporte A', ${SLUG}, now()),
      (${OTHER_ORG}, 'Clínica Soporte B', ${OTHER_SLUG}, now())`)
  await ownerDb.execute(sql`
    insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale") values
      (${ORG}, 'Clínica Soporte A', 'PE', 'PEN', 'America/Lima', 'es-PE'),
      (${OTHER_ORG}, 'Clínica Soporte B', 'PE', 'PEN', 'America/Lima', 'es-PE')`)
  await ownerDb.execute(sql`
    insert into "user" ("id", "name", "email") values
      ('u-sop-owner', 'Ana Propietaria', 'ana@sop.test'),
      ('u-sop-staff', 'Sofía Soporte', 'sofia@sop.test')`)
  await ownerDb.execute(sql`insert into "admin"."admin_staff" ("user_id", "role") values ('u-sop-staff', 'support')`)
  await ownerDb.execute(sql`
    insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values
      ('m-sop-owner', ${ORG}, 'u-sop-owner', 'owner', now())`)
  app = createApp({
    auth: authStub,
    db: appDb,
    ownerDb,
    secretsKey: secretsKeyFromEnv("ee".repeat(32)),
    storage: { attachmentUrl: async (key: string) => `https://firmada.test/${key}` } as unknown as Storage,
    validateExternal: false,
    webhookBaseUrl: "https://api.odentia.localhost",
    trustedOrigins: [],
    cookieDomain: "odentia.localhost",
    productDomains: { medical: "latidia.localhost", optical: "vistia.localhost" },
    webURL: "https://app.odentia.localhost",
    adminURL: "https://admin.odentia.localhost",
    mailer: { send: async () => undefined },
    listenUrl: "postgres://localhost:5432/dentalagent",
  })
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

it("soporte lee con el rol elegido, no escribe y no sale de su clínica", async () => {
  const { cookie } = await enter("reception")
  // Lee lo que lee recepción.
  expect((await call(cookie, "GET", "/org-profile")).status).toBe(200)
  const me = await call(cookie, "GET", "/support-session/me")
  expect(((await me.json()) as { data: { viewRole: string; staffName: string } }).data).toMatchObject({ viewRole: "reception", staffName: "Sofía Soporte" })
  // No escribe: el servidor lo rechaza aunque la pantalla no ofrezca el botón.
  const write = await call(cookie, "POST", "/help/support-access", { minutes: 30, viewRole: null })
  expect(write.status).toBe(403)
  expect(await code(write)).toBe("SUPPORT_READ_ONLY")
  // El intento queda en la auditoría del permiso (el contrato pide «cada intento»).
  const denied = await ownerDb.execute(sql`select count(*)::int as n from support_access_audit where action = 'denegado_solo_lectura'`)
  expect((denied[0] as { n: number }).n).toBeGreaterThanOrEqual(1)
  // Lo que no es de recepción, tampoco.
  expect((await call(cookie, "GET", "/team/two-factor")).status).toBe(403)
  // Otra clínica, no.
  const other = await call(cookie, "GET", "/org-profile", undefined, OTHER_SLUG)
  expect(other.status).toBe(403)
})

it("quitado el acceso, la siguiente lectura dice que terminó y por qué", async () => {
  const { cookie, caseId, grantId } = await enter("clinician")
  const removed = await withOrgContext(appDb, ORG, async (tx) => {
    const { revokeSupportAccess } = await import("@odentia/services")
    await revokeSupportAccess(tx, ORG, "u-sop-owner", true, grantId, caseId)
    return true
  })
  expect(removed).toBe(true)
  const after = await call(cookie, "GET", "/org-profile")
  expect(after.status).toBe(401)
  expect(await code(after)).toBe("SUPPORT_ACCESS_ENDED")
  const ended = await call(cookie, "GET", "/support-session/ended")
  expect(((await ended.json()) as { data: { reason: string; byName: string } }).data).toMatchObject({ reason: "quitado", byName: "Ana Propietaria" })
})

it("sin cookie de soporte nada terminó: «/me» responde sin error y sin datos, y ninguna ruta dice que el acceso terminó", async () => {
  // El equipo de la clínica: su navegador nunca tuvo la cookie, y la app pregunta por ella en
  // cada comprobación del acceso. Decirle «terminó» lo sacaba de su clínica a los dos minutos.
  const me = await call(null, "GET", "/support-session/me")
  expect(me.status).toBe(200)
  expect(await me.json()).toEqual({ data: null })
  // Tampoco con otras cookies del navegador, ni con la de soporte vacía.
  for (const cookie of ["otra=1; sesion=abc", "odentia_soporte="]) {
    const other = await call(cookie, "GET", "/support-session/me")
    expect(other.status).toBe(200)
    expect(await other.json()).toEqual({ data: null })
  }
  // Las rutas de la clínica siguen el camino de siempre: aquí, sin sesión, el 401 de la sesión.
  const clinic = await call(null, "GET", "/org-profile")
  expect(clinic.status).toBe(401)
  expect(await code(clinic)).not.toBe("SUPPORT_ACCESS_ENDED")
})

it.each([
  [
    "lo quitaron",
    async ({ caseId, grantId }: { cookie: string; caseId: string; grantId: string }) => {
      const { revokeSupportAccess } = await import("@odentia/services")
      await withOrgContext(appDb, ORG, (tx) => revokeSupportAccess(tx, ORG, "u-sop-owner", true, grantId, caseId))
    },
    "quitado",
  ],
  [
    "venció",
    async ({ grantId }: { cookie: string; caseId: string; grantId: string }) => {
      await ownerDb.execute(sql`
        update support_access_grant
        set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
        where id = ${grantId}`)
    },
    "vencido",
  ],
  [
    "salió",
    async ({ cookie }: { cookie: string; caseId: string; grantId: string }) => {
      expect((await call(cookie, "POST", "/support-session/end", {})).status).toBe(200)
    },
    "salio",
  ],
] as const)("con la cookie de una sesión que terminó (%s), «/me» dice que el acceso terminó y nunca atiende otra sesión", async (_caso, end, reason) => {
  const entered = await enter("reception")
  expect((await call(entered.cookie, "GET", "/support-session/me")).status).toBe(200)
  await end(entered)
  const me = await call(entered.cookie, "GET", "/support-session/me")
  expect(me.status).toBe(401)
  expect(await code(me)).toBe("SUPPORT_ACCESS_ENDED")
  // Con esa cookie el pedido es de soporte o de nadie: tampoco las rutas de la clínica.
  const clinic = await call(entered.cookie, "GET", "/org-profile")
  expect(clinic.status).toBe(401)
  expect(await code(clinic)).toBe("SUPPORT_ACCESS_ENDED")
  const ended = await call(entered.cookie, "GET", "/support-session/ended")
  expect(((await ended.json()) as { data: { reason: string } }).data.reason).toBe(reason)
})

it("una cookie de soporte que no es de ninguna sesión no abre nada: responde igual que una terminada", async () => {
  const me = await call(`odentia_soporte=${"x".repeat(43)}`, "GET", "/support-session/me")
  expect(me.status).toBe(401)
  expect(await code(me)).toBe("SUPPORT_ACCESS_ENDED")
})

it("el pase sirve una vez y solo desde la app de una clínica", async () => {
  const { caseId } = await withOrgContext(appDb, ORG, (tx) =>
    giveSupportAccessFromHelp(tx, ORG, "u-sop-owner", true, { minutes: 15, viewRole: "cashier", screen: "/", role: "Propietario", appVersion: null }),
  )
  const pass = await ownerDb.transaction((tx) => createSupportPass(tx as Db, { userId: "u-sop-staff", role: "support" }, caseId))
  const foreign = await app.request("/api/support-session/redeem", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://malo.example.com" },
    body: JSON.stringify({ pass: pass.token }),
  })
  expect(foreign.status).toBe(403)
  expect((await call(null, "POST", "/support-session/redeem", { pass: pass.token })).status).toBe(200)
  const again = await call(null, "POST", "/support-session/redeem", { pass: pass.token })
  expect(again.status).toBe(403)
  expect(await code(again)).toBe("SUPPORT_PASS_INVALID")
})

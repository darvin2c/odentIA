process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { randomBytes } from "node:crypto"
import { createOwnerDb, type Db } from "@odentia/db"
import {
  saasClient,
  saasClientFile,
  saasImportDraft,
  saasSkillKey,
} from "@odentia/db/schema/admin-arm"
import { adminAudit, adminStaff } from "@odentia/db/schema/admin-core"
import { createSkillKey, hashSkillKey, revokeSkillKey, type Storage } from "@odentia/services"
import { and, eq, sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { Hono } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createAdminSkillRoute } from "./admin-skill.js"

/**
 * La llave de la skill contra Postgres real: solo con `Bearer sk_…` vigente y
 * de Administración deposita; sube el JSON y el PDF fuera de la transacción y
 * borra lo subido si el depósito falla.
 */

const IMAGE = "dentalagent-postgres:18.6"
const ORG = "org-llave"
const SLUG = "clinica-llave"
const ADMIN = { userId: "u-sk-admin", role: "admin" as const }
const SUPPORT = { userId: "u-sk-soporte", role: "support" as const }
const PDF = Buffer.from("%PDF-1.4\n% prueba\n%%EOF\n").toString("base64")

let container: StartedTestContainer
let ownerDb: Db
let app: Hono
let clientId: string
let token: string

/** El bucket privado, en memoria. `failOn` hace fallar la subida de una clave que termina así. */
const objects = new Map<string, Uint8Array>()
let failOn: string | null = null
let onPut: (() => Promise<void>) | null = null
const storage: Pick<Storage, "putAttachmentAt" | "deleteAttachment"> = {
  putAttachmentAt: async (key, bytes) => {
    if (failOn && key.endsWith(failOn)) throw new Error("bucket caído")
    objects.set(key, bytes)
    if (onPut) await onPut()
  },
  deleteAttachment: async (key) => {
    objects.delete(key)
  },
}

const patientsPlan = {
  version: 1,
  countryCode: "PE",
  sources: [{ name: "pacientes.xlsx", sha256: "a".repeat(64) }],
  people: [
    {
      key: "1",
      patient: true,
      demographics: { displayName: "Rosa Mamani", givenNames: "Rosa", familyName: "Mamani" },
    },
  ],
}

function post(body: unknown, auth: string | null = `Bearer ${token}`) {
  const headers = new Headers({ "content-type": "application/json" })
  if (auth) headers.set("authorization", auth)
  return app.request("/api/admin-skill/drafts", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
}

function whoami(auth: string | null) {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return app.request("/api/admin-skill/whoami", { headers })
}

async function auditCount(action: string): Promise<number> {
  const rows = await ownerDb.select().from(adminAudit).where(eq(adminAudit.action, action))
  return rows.length
}

/** Una llave escrita a mano (vencida, de Soporte): la huella es lo único que se guarda. */
async function rawKey(userId: string, expiresAt: Date): Promise<string> {
  const value = `sk_${randomBytes(32).toString("base64url")}`
  await ownerDb.insert(saasSkillKey).values({
    userId,
    label: "A mano",
    tokenHash: hashSkillKey(value),
    expiresAt,
  })
  return value
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
  app = new Hono().route("/api/admin-skill", createAdminSkillRoute({ ownerDb, storage }))
  for (const staff of [ADMIN, SUPPORT]) {
    await ownerDb.execute(
      sql`insert into "user" (id, name, email, email_verified) values (${staff.userId}, ${staff.userId}, ${`${staff.userId}@example.test`}, true)`,
    )
    await ownerDb.insert(adminStaff).values({ userId: staff.userId, role: staff.role })
  }
  await ownerDb.execute(
    sql`insert into "organization" (id, name, slug, created_at) values (${ORG}, 'Clínica Llave', ${SLUG}, now())`,
  )
  await ownerDb.execute(
    sql`insert into "org_profile" (organization_id, legal_name, country_code, currency, timezone, locale)
        values (${ORG}, 'Clínica Llave', 'PE', 'PEN', 'America/Lima', 'es-PE')`,
  )
  const [client] = await ownerDb
    .select({ id: saasClient.id })
    .from(saasClient)
    .where(eq(saasClient.organizationId, ORG))
  clientId =
    client?.id ??
    (
      await ownerDb
        .insert(saasClient)
        .values({ name: "Clínica Llave (ficticia)", product: "dental", organizationId: ORG })
        .returning({ id: saasClient.id })
    )[0]!.id
  token = (
    await ownerDb.transaction((tx) => createSkillKey(tx as Db, ADMIN, { label: "Mi equipo" }))
  ).token
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

beforeEach(() => {
  failOn = null
  onPut = null
})

describe("quién entra", () => {
  it("sin llave o con una mal escrita: 401 y no se sube nada", async () => {
    const none = await post(
      { organizationSlug: SLUG, kind: "plan_pacientes", number: 1, payload: patientsPlan },
      null,
    )
    expect(none.status).toBe(401)
    expect(((await none.json()) as { error: { code: string } }).error.code).toBe(
      "SKILL_KEY_REQUIRED",
    )
    const bad = await post(
      { organizationSlug: SLUG, kind: "plan_pacientes", number: 1, payload: patientsPlan },
      "Bearer sk_inventada",
    )
    expect(bad.status).toBe(401)
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("SKILL_KEY_INVALID")
    // Una llave con la forma correcta pero que no existe.
    expect((await whoami(`Bearer sk_${"Z".repeat(43)}`)).status).toBe(401)
    expect(objects.size).toBe(0)
  })

  it("una llave vencida o revocada no vale", async () => {
    const expired = await rawKey(ADMIN.userId, new Date(Date.now() - 1000))
    expect((await whoami(`Bearer ${expired}`)).status).toBe(401)
    const revoked = await ownerDb.transaction((tx) =>
      createSkillKey(tx as Db, ADMIN, { label: "Para revocar" }),
    )
    await ownerDb.transaction((tx) => revokeSkillKey(tx as Db, ADMIN, revoked.id))
    const response = await post(
      {
        organizationSlug: SLUG,
        kind: "plan_pacientes",
        number: 1,
        payload: patientsPlan,
        pdfBase64: PDF,
      },
      `Bearer ${revoked.token}`,
    )
    expect(response.status).toBe(401)
    expect(objects.size).toBe(0)
  })

  it("la llave de alguien de Soporte: 403 claro y queda en la auditoría", async () => {
    const supportKey = await rawKey(SUPPORT.userId, new Date(Date.now() + 86_400_000))
    const before = await auditCount("skill.key_denied")
    const response = await post(
      { organizationSlug: SLUG, kind: "plan_pacientes", number: 1, payload: patientsPlan },
      `Bearer ${supportKey}`,
    )
    expect(response.status).toBe(403)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe("SKILL_KEY_FORBIDDEN")
    expect(body.error.message).toMatch(/Soporte/)
    expect((await whoami(`Bearer ${supportKey}`)).status).toBe(403)
    expect(await auditCount("skill.key_denied")).toBe(before + 2)
    expect(objects.size).toBe(0)
  })

  it("whoami dice de quién es la llave y deja auditoría", async () => {
    const response = await whoami(`Bearer ${token}`)
    expect(response.status).toBe(200)
    const { data } = (await response.json()) as {
      data: { user: { userId: string }; role: string; label: string; can: string[] }
    }
    expect(data).toMatchObject({
      user: { userId: ADMIN.userId },
      role: "admin",
      label: "Mi equipo",
      can: ["depositar"],
    })
    expect(JSON.stringify(data)).not.toContain(token)
    expect(await auditCount("skill.key_checked")).toBeGreaterThanOrEqual(1)
    const [key] = await ownerDb
      .select()
      .from(saasSkillKey)
      .where(eq(saasSkillKey.tokenHash, hashSkillKey(token)))
    expect(key?.lastUsedAt).not.toBeNull()
  })

  it("la llave no abre nada más", async () => {
    const response = await app.request("/api/admin-skill/clients", {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(404)
  })
})

describe("depositar", () => {
  it("sube el JSON y el PDF, registra el PDF y deja el borrador «lista»", async () => {
    const response = await post({
      organizationSlug: SLUG,
      kind: "plan_pacientes",
      number: 1,
      payload: patientsPlan,
      pdfBase64: PDF,
    })
    expect(response.status).toBe(201)
    const { data } = (await response.json()) as {
      data: { id: string; status: string; clientId: string }
    }
    expect(data).toMatchObject({ status: "lista", clientId })
    const [draft] = await ownerDb
      .select()
      .from(saasImportDraft)
      .where(eq(saasImportDraft.id, data.id))
    expect(draft?.payloadKey.startsWith(`clients/${clientId}/`)).toBe(true)
    expect(objects.has(draft!.payloadKey)).toBe(true)
    expect(JSON.parse(new TextDecoder().decode(objects.get(draft!.payloadKey)))).toEqual(
      patientsPlan,
    )
    const [file] = await ownerDb
      .select()
      .from(saasClientFile)
      .where(eq(saasClientFile.id, draft!.pdfFileId!))
    expect(file).toMatchObject({
      kind: "plan_carga",
      source: "skill",
      adminOnly: true,
      contentType: "application/pdf",
    })
    // El PDF del plan de pacientes trae sus datos: se borra a los 30 días.
    expect(file?.deleteAfter).not.toBeNull()
    expect(objects.has(file!.objectKey)).toBe(true)
    const [audit] = await ownerDb
      .select()
      .from(adminAudit)
      .where(and(eq(adminAudit.action, "skill.draft_deposited"), eq(adminAudit.entityId, data.id)))
    expect(audit?.actorUserId).toBe(ADMIN.userId)
    expect(audit?.metadata).toMatchObject({ via: "skill" })
    // Nada de los datos de pacientes en la auditoría.
    expect(JSON.stringify(audit?.metadata)).not.toContain("Rosa")
  })

  it("el mismo número otra vez: 409 sin subir nada", async () => {
    const before = objects.size
    const response = await post({
      organizationSlug: SLUG,
      kind: "plan_pacientes",
      number: 1,
      payload: patientsPlan,
    })
    expect(response.status).toBe(409)
    expect(objects.size).toBe(before)
  })

  it("un archivo que no es del tipo o un PDF falso se rechazan con su campo", async () => {
    const wrong = await post({
      organizationSlug: SLUG,
      kind: "plan_pacientes",
      number: 2,
      payload: { hola: 1 },
    })
    expect(wrong.status).toBe(400)
    const fakePdf = await post({
      organizationSlug: SLUG,
      kind: "plan_pacientes",
      number: 2,
      payload: patientsPlan,
      pdfBase64: Buffer.from("<html>").toString("base64"),
    })
    expect(fakePdf.status).toBe(400)
    expect(
      ((await fakePdf.json()) as { error: { fields: Record<string, string> } }).error.fields,
    ).toHaveProperty("pdfBase64")
    const otherClinic = await post({
      organizationSlug: "no-existe",
      kind: "plan_pacientes",
      number: 2,
      payload: patientsPlan,
    })
    expect(otherClinic.status).toBe(400)
  })

  it("si falla una subida, borra lo que ya subió", async () => {
    const before = new Set(objects.keys())
    failOn = ".pdf"
    const response = await post({
      organizationSlug: SLUG,
      kind: "plan_pacientes",
      number: 3,
      payload: patientsPlan,
      pdfBase64: PDF,
    })
    expect(response.status).toBe(503)
    expect(new Set(objects.keys())).toEqual(before)
    const drafts = await ownerDb
      .select()
      .from(saasImportDraft)
      .where(and(eq(saasImportDraft.organizationId, ORG), eq(saasImportDraft.number, 3)))
    expect(drafts).toHaveLength(0)
  })

  it("si la llave se revoca mientras sube, no deposita y borra lo subido", async () => {
    const key = await ownerDb.transaction((tx) =>
      createSkillKey(tx as Db, ADMIN, { label: "Se revoca" }),
    )
    const before = new Set(objects.keys())
    onPut = async () => {
      onPut = null
      await ownerDb.transaction((tx) => revokeSkillKey(tx as Db, ADMIN, key.id))
    }
    const response = await post(
      {
        organizationSlug: SLUG,
        kind: "plan_pacientes",
        number: 4,
        payload: patientsPlan,
        pdfBase64: PDF,
      },
      `Bearer ${key.token}`,
    )
    expect(response.status).toBe(401)
    expect(new Set(objects.keys())).toEqual(before)
    const drafts = await ownerDb
      .select()
      .from(saasImportDraft)
      .where(and(eq(saasImportDraft.organizationId, ORG), eq(saasImportDraft.number, 4)))
    expect(drafts).toHaveLength(0)
  })
})

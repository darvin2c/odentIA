process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import type { Auth } from "@odentia/auth"
import { createAppDb, createOwnerDb, type Db } from "@odentia/db"
import { saasClient, saasTask } from "@odentia/db/schema/admin-arm"
import { adminSessionVerification, adminStaff, twoFactor } from "@odentia/db/schema/admin-core"
import {
  type AdminActor,
  clinicImportPlanSchema,
  clinicSetupPlanSchema,
  progressReportSchema,
  type Storage,
  secretsKeyFromEnv,
} from "@odentia/services"
import { eq, sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Hono } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import { createApp } from "../app.js"
import { createClinicLoad } from "../lib/clinic-load.js"

/**
 * La carga de una clínica (ADR 0104) contra una base real: lo que corre la skill en el
 * servidor (`createClinicLoad`, lo mismo que `cli/carga.ts`) solo lo hace la administración,
 * y la pestaña «Carga» de la administración solo lee el registro, con su segundo factor. Un
 * informe que no se sabe si salió se cierra o se reenvía desde ahí, solo Administración.
 */

const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("ee".repeat(32))
const ADMIN = "https://admin.odentia.localhost"
const ORG = "org-carga"
const admin: AdminActor = { userId: "u-admin", role: "admin" }
const support: AdminActor = { userId: "u-soporte", role: "support" }

/** Lo que salió por correo en estas pruebas. */
const sent: Array<{
  to: string
  subject: string
  html?: string
  attachments?: ReadonlyArray<{ filename: string; content?: Uint8Array }>
}> = []
/** Si el correo de la app se corta (como el de producción cuando no se sabe si salió). */
let mailFails = false

/** Lo que se guardó en el almacenamiento privado en estas pruebas. */
const stored = new Map<string, Uint8Array>()

let container: StartedTestContainer
let ownerDb: Db
let app: Hono
let load: ReturnType<typeof createClinicLoad>

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

const storage = {
  putAttachmentAt: async (key: string, bytes: Uint8Array) => {
    stored.set(key, bytes)
  },
  attachmentUrl: async (key: string) => `https://almacen.example/${key}`,
  deleteAttachment: async (key: string) => {
    stored.delete(key)
  },
  getAttachment: async (key: string) => {
    const bytes = stored.get(key)
    if (!bytes) throw new Error(`no está ${key}`)
    return bytes
  },
} as unknown as Storage

const mailer = {
  send: async (message: (typeof sent)[number]) => {
    if (mailFails) throw new Error("se cortó la conexión")
    sent.push(message)
  },
}

/** La misma carga con un correo que siempre se corta: el informe queda «no se sabe si salió». */
const cutMailer = {
  send: async () => {
    throw new Error("se cortó la conexión")
  },
}

function read(path: string, user: string) {
  return app.request(`/api/admin/imports/${ORG}${path}`, { headers: new Headers({ "x-test-user": user, origin: ADMIN }) })
}

function post(path: string, user: string) {
  return app.request(`/api/admin/imports/${ORG}${path}`, {
    method: "POST",
    headers: new Headers({ "x-test-user": user, origin: ADMIN }),
  })
}

async function record<T>(): Promise<T> {
  return ((await (await read("/record", "u-admin")).json()) as { data: T }).data
}

async function staff(id: string, role: "admin" | "support") {
  await ownerDb.execute(sql`insert into "user" (id, name, email, email_verified) values (${id}, ${id}, ${`${id}@example.test`}, true)`)
  await ownerDb.insert(adminStaff).values({ userId: id, role })
  await ownerDb.insert(twoFactor).values({ id: `f-${id}`, userId: id, secret: "x", backupCodes: "[]", verified: true })
  await ownerDb.insert(adminSessionVerification).values({
    userId: id,
    sessionId: `s-${id}`,
    factorId: `f-${id}`,
    method: "totp",
    expiresAt: new Date(Date.now() + 3_600_000),
  })
}

const plan = {
  version: 1,
  countryCode: "PE",
  sources: [{ name: "pacientes.csv", sha256: "c".repeat(64) }],
  people: [
    {
      key: "1",
      patient: true,
      demographics: { displayName: "Rosa Quispe", givenNames: "Rosa", familyName: "Quispe", phone: "+51987654322", birthDate: "1990-11-15" },
      origin: { file: "pacientes.csv", row: 2 },
    },
    {
      key: "2",
      patient: true,
      demographics: { displayName: "Mateo Quispe", givenNames: "Mateo", familyName: "Quispe", birthDate: "2018-08-20" },
      guardian: { key: "1", relationship: "guardian", kinship: "MTH" },
      origin: { file: "pacientes.csv", row: 3 },
    },
  ],
}

const setup = {
  kind: "clinica",
  version: 1,
  product: "dental",
  countryCode: "PE",
  clinic: "Clínica Carga",
  slug: "clinica-carga",
  identity: { tradeName: "Clínica Carga", legalName: "Clínica Carga S.A.C." },
  papers: { budgetValidDays: 120 },
  branches: [{ key: "principal", name: "Principal", addressLine1: "Av. Larco 100", district: "Miraflores", city: "Lima" }],
  knowledge: [{ basicKey: "cuotas", body: "No: los pagos son al contado." }],
  team: [{ email: "recepcion.carga@example.com", role: "reception" }],
}

const report = {
  clinic: "Clínica Carga",
  to: "Dra. Carga",
  email: "recepcion.carga@example.com",
  number: 1,
  stage: "Alta de su cuenta",
  date: "2026-11-12",
  companion: { name: "Implementación", email: "implementacion@odentia32.com" },
  done: ["Creamos su cuenta."],
  where: ["Con el enlace de la invitación."],
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
  const url = `${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`
  ownerDb = createOwnerDb(`postgres://dentalagent:dentalagent@${url}`)
  await migrate(ownerDb, { migrationsFolder: "../../packages/db/drizzle" })
  app = createApp({
    auth: authStub,
    db: createAppDb(`postgres://dentalagent_app:dentalagent_app@${url}`),
    ownerDb,
    secretsKey: KEY,
    storage,
    validateExternal: false,
    webhookBaseUrl: "https://api.example.com",
    trustedOrigins: [ADMIN],
    cookieDomain: "odentia.localhost",
    webURL: "https://app.odentia.localhost",
    adminURL: ADMIN,
    mailer,
    listenUrl: "postgres://localhost:5432/dentalagent",
  })
  load = createClinicLoad({ ownerDb, storage, mailer, webURL: "https://app.odentia.localhost" })
  await staff("u-admin", "admin")
  await staff("u-soporte", "support")
  await ownerDb.execute(sql`insert into "organization" (id, name, slug, created_at) values (${ORG}, 'Clínica Carga', 'clinica-carga', now())`)
  await ownerDb.execute(
    sql`insert into "org_profile" (organization_id, legal_name, country_code, currency, timezone, locale)
        values (${ORG}, 'Clínica Carga', 'PE', 'PEN', 'America/Lima', 'es-PE')`,
  )
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

it("soporte no carga, no envía ni ve el registro", async () => {
  const patients = clinicImportPlanSchema.parse(plan)
  const clinic = clinicSetupPlanSchema.parse(setup)
  await expect(load.previewPatients(ORG, support, patients)).rejects.toMatchObject({ status: 403 })
  await expect(load.applyPatients(ORG, support, patients)).rejects.toMatchObject({ status: 403 })
  await expect(load.rehearseSetup(ORG, support, clinic)).rejects.toMatchObject({ status: 403 })
  await expect(load.applySetup(ORG, support, clinic)).rejects.toMatchObject({ status: 403 })
  await expect(load.sendReport(ORG, support, progressReportSchema.parse(report))).rejects.toMatchObject({ status: 403 })
  expect((await read("/record", "u-soporte")).status).toBe(403)
  expect((await read("/reports/1/pdf", "u-soporte")).status).toBe(403)
})

it("los pacientes se ensayan, se cargan por tandas y repetir no duplica", async () => {
  const patients = clinicImportPlanSchema.parse(plan)
  const preview = await load.previewPatients(ORG, admin, patients)
  expect(preview.order).toEqual(["1", "2"])
  expect(preview.totals).toMatchObject({ nuevas: 2, pacientes: 2, errores: 0 })

  expect(await load.applyPatients(ORG, admin, patients)).toMatchObject({ total: 2, done: { creadas: 2, errores: 0 } })
  expect(await load.applyPatients(ORG, admin, patients)).toMatchObject({ done: { creadas: 0, yaCargadas: 2 } })
  const [count] = await ownerDb.execute<{ n: number }>(sql`select count(*)::int as n from patient where organization_id = ${ORG}`)
  expect(count?.n).toBe(2)

  // Cada pasada es una carga en el registro: la segunda no se suma a la primera.
  const { loads } = await record<{ loads: Array<{ kind: string; by: string | null; summary: string }> }>()
  expect(loads).toEqual([
    { id: expect.any(String), kind: "pacientes", at: expect.any(String), by: "u-admin", summary: "2 ya se habían cargado" },
    { id: expect.any(String), kind: "pacientes", at: expect.any(String), by: "u-admin", summary: "2 personas creadas" },
  ])
})

it("la configuración se ensaya sin guardar, se carga con su invitación y repetir no duplica", async () => {
  const clinic = clinicSetupPlanSchema.parse(setup)
  const rehearsal = await load.rehearseSetup(ORG, admin, clinic)
  expect(rehearsal.totals.error).toBe(0)
  const [none] = await ownerDb.execute<{ n: number }>(sql`select count(*)::int as n from branch where organization_id = ${ORG}`)
  expect(none?.n).toBe(0)
  expect(sent).toHaveLength(0)

  const loaded = await load.applySetup(ORG, admin, clinic)
  expect(loaded.totals.error).toBe(0)
  expect(loaded.emails).toEqual([{ email: "recepcion.carga@example.com", sent: true }])
  expect(sent.map((message) => message.to)).toEqual(["recepcion.carga@example.com"])

  const repeated = await load.applySetup(ORG, admin, clinic)
  expect(repeated.totals.nueva).toBe(0)
  expect(repeated.emails).toEqual([])
  const [branches] = await ownerDb.execute<{ n: number }>(sql`select count(*)::int as n from branch where organization_id = ${ORG}`)
  expect(branches?.n).toBe(1)

  const { loads } = await record<{ loads: Array<{ kind: string; summary: string }> }>()
  expect(loads.map((item) => item.kind)).toEqual(["configuracion", "configuracion", "pacientes", "pacientes"])
  expect(loads[0]?.summary).not.toMatch(/nuevo/)
  expect(loads[1]?.summary).toMatch(/nuevos?/)
})

it("el informe se ve antes, sale con su PDF una sola vez y el registro lo abre", async () => {
  sent.length = 0
  const input = progressReportSchema.parse(report)
  const shown = await load.previewReport(ORG, admin, input)
  expect(shown).toMatchObject({ to: "recepcion.carga@example.com", pages: 1, sent: null })
  expect(sent).toHaveLength(0)

  await load.sendReport(ORG, admin, input)
  expect(sent).toHaveLength(1)
  expect(sent[0]?.attachments?.map((file) => file.filename)).toEqual(["informe-1.pdf"])
  await expect(load.sendReport(ORG, admin, input)).rejects.toMatchObject({ status: 409 })
  expect(sent).toHaveLength(1)
  expect([...stored.keys()]).toEqual([expect.stringMatching(/^clinics\/org-carga\/informes\/informe-1-/)])

  const { reports } = await record<{ reports: unknown[] }>()
  expect(reports).toEqual([
    expect.objectContaining({ number: 1, state: "enviado", to: "recepcion.carga@example.com", by: "u-admin", registeredLater: false, hasPdf: true }),
  ])
  const pdf = await read("/reports/1/pdf", "u-admin")
  expect(((await pdf.json()) as { data: { url: string } }).data.url).toMatch(/^https:\/\/almacen\.example\/clinics\/org-carga\/informes\//)
})

it("un informe que salió por otra vía se registra con su fecha, sin enviarse", async () => {
  sent.length = 0
  const second = progressReportSchema.parse({ ...report, number: 2 })
  await expect(load.registerReport(ORG, admin, { ...second, date: undefined }, "2026-11-12T15:14:00.000Z")).rejects.toMatchObject({ status: 400 })
  await load.registerReport(ORG, admin, second, "2026-11-12T15:14:00.000Z")
  expect(sent).toHaveLength(0)
  const { reports } = await record<{ reports: Array<{ number: number }> }>()
  expect(reports[0]).toMatchObject({ number: 2, at: "2026-11-12T15:14:00.000Z", registeredLater: true, hasPdf: true })
  await expect(load.registerReport(ORG, admin, second, "2026-11-12T15:14:00.000Z")).rejects.toMatchObject({ status: 409 })
})

it("un informe que no se sabe si salió se cierra como enviado, sin volver a enviarlo", async () => {
  const failing = createClinicLoad({ ownerDb, storage, mailer: cutMailer, webURL: "https://app.odentia.localhost" })
  const fourth = progressReportSchema.parse({ ...report, number: 4 })
  await expect(failing.sendReport(ORG, admin, fourth)).rejects.toMatchObject({ code: "SEND_UNKNOWN" })
  const before = await record<{ reports: Array<{ number: number; state: string; at: string }> }>()
  const unknown = before.reports.find((item) => item.number === 4)
  expect(unknown?.state).toBe("desconocido")

  sent.length = 0
  await expect(load.confirmReportSent(ORG, support, 4)).rejects.toMatchObject({ status: 403 })
  expect(await load.confirmReportSent(ORG, admin, 4)).toEqual({ confirmed: true, number: 4 })
  expect(sent).toHaveLength(0)
  const after = await record<{ reports: Array<{ number: number; state: string; at: string; registeredLater: boolean }> }>()
  expect(after.reports.find((item) => item.number === 4)).toMatchObject({ state: "enviado", at: unknown?.at, registeredLater: false })
  await expect(load.confirmReportSent(ORG, admin, 4)).rejects.toMatchObject({ status: 409 })
})

it("el plan de otra clínica no se carga aquí y el informe no va a alguien de fuera", async () => {
  await expect(load.rehearseSetup(ORG, admin, clinicSetupPlanSchema.parse({ ...setup, slug: "otra-clinica" }))).rejects.toMatchObject({ status: 400 })
  await expect(load.previewReport(ORG, admin, progressReportSchema.parse({ ...report, number: 3, email: "alguien@example.com" }))).rejects.toMatchObject({
    status: 400,
  })
  await expect(
    load.previewReport(ORG, admin, progressReportSchema.parse({ ...report, number: 3, companion: { name: "Alguien", email: "x@gmail.com" } })),
  ).rejects.toMatchObject({ status: 400 })
})

it("de un informe que no se sabe si salió, soporte no lo cierra ni lo reenvía", async () => {
  const failing = createClinicLoad({ ownerDb, storage, mailer: cutMailer, webURL: "https://app.odentia.localhost" })
  await expect(failing.sendReport(ORG, admin, progressReportSchema.parse({ ...report, number: 5 }))).rejects.toMatchObject({
    code: "SEND_UNKNOWN",
  })
  expect((await post("/reports/5/confirm-sent", "u-soporte")).status).toBe(403)
  expect((await post("/reports/5/resend", "u-soporte")).status).toBe(403)
  const { reports } = await record<{ reports: Array<{ number: number; state: string; canResend: boolean }> }>()
  expect(reports.find((item) => item.number === 5)).toMatchObject({ state: "desconocido", canResend: true })
  expect(JSON.stringify(reports)).not.toContain("pdfKey")
})

it("«No salió: reenviar» manda el mismo informe una vez; si vuelve a cortarse, queda otra vez sin saberse", async () => {
  // Uno ya enviado no se reenvía.
  const already = await post("/reports/1/resend", "u-admin")
  expect(already.status).toBe(409)

  // La tarea urgente que Kairós puso por el N.º 5.
  const [client] = await ownerDb
    .insert(saasClient)
    .values({ name: "Clínica Carga", product: "dental", organizationId: ORG })
    .returning({ id: saasClient.id })
  const clientId = client?.id ?? ""
  const [task] = await ownerDb
    .insert(saasTask)
    .values({
      clientId,
      kind: "alta",
      title: "Revisar en Zoho si salió el informe N.º 5",
      dueOn: "2026-11-12",
      byKairos: true,
      kairosKey: `informe_desconocido:${clientId}:informe-5-1:2026-11-12`,
    })
    .returning({ id: saasTask.id })

  sent.length = 0
  mailFails = true
  const cut = await post("/reports/5/resend", "u-admin")
  mailFails = false
  expect(cut.status).toBe(502)
  expect(((await cut.json()) as { error: { code: string } }).error.code).toBe("SEND_UNKNOWN")
  const still = await record<{ reports: Array<{ number: number; state: string; resent: boolean }> }>()
  expect(still.reports.find((item) => item.number === 5)).toMatchObject({ state: "desconocido", resent: true })
  const [open] = await ownerDb.select({ status: saasTask.status }).from(saasTask).where(eq(saasTask.id, task?.id ?? ""))
  expect(open?.status).toBe("abierta")

  const pdfKey = [...stored.keys()].find((key) => key.includes("/informe-5-")) ?? ""
  const resent = await post("/reports/5/resend", "u-admin")
  expect(resent.status).toBe(200)
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({ to: "recepcion.carga@example.com" })
  expect(sent[0]?.attachments?.map((file) => file.filename)).toEqual(["informe-5.pdf"])
  // El mismo PDF que se guardó al primer intento, no uno armado otra vez.
  expect(sent[0]?.attachments?.[0]?.content).toEqual(stored.get(pdfKey))
  const after = await record<{ reports: Array<{ number: number; state: string; canResend: boolean }> }>()
  expect(after.reports.find((item) => item.number === 5)).toMatchObject({ state: "enviado", canResend: false })
  const [closed] = await ownerDb
    .select({ status: saasTask.status, doneNote: saasTask.doneNote })
    .from(saasTask)
    .where(eq(saasTask.id, task?.id ?? ""))
  expect(closed).toEqual({ status: "hecha", doneNote: "Kairós la cerró: salió el informe N.º 5" })

  // Una segunda pulsación ya no envía nada.
  expect((await post("/reports/5/resend", "u-admin")).status).toBe(409)
  expect(sent).toHaveLength(1)
})

it("«Revisé en Zoho: salió» lo cierra como enviado sin reenviarlo", async () => {
  const failing = createClinicLoad({ ownerDb, storage, mailer: cutMailer, webURL: "https://app.odentia.localhost" })
  await expect(failing.sendReport(ORG, admin, progressReportSchema.parse({ ...report, number: 6 }))).rejects.toMatchObject({
    code: "SEND_UNKNOWN",
  })
  sent.length = 0
  const confirmed = await post("/reports/6/confirm-sent", "u-admin")
  expect(confirmed.status).toBe(200)
  expect(sent).toHaveLength(0)
  const { reports } = await record<{ reports: Array<{ number: number; state: string }> }>()
  expect(reports.find((item) => item.number === 6)).toMatchObject({ state: "enviado" })
  expect((await post("/reports/6/confirm-sent", "u-admin")).status).toBe(409)
  expect((await post("/reports/abc/resend", "u-admin")).status).toBe(404)
})

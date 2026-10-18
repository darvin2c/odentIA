process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { createAppDb, createOwnerDb, type Db } from "@odentia/db"
import { secretsKeyFromEnv, type Storage } from "@odentia/services"
import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Context } from "hono"
import { Hono, type Next } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import type { CrmDeps } from "./helpers.js"
import { createPatientsRoute } from "./patients.js"

/**
 * Tomografías (ADR 0055): recepción sube y ve el avance sin abrirla; la API
 * solo da por recibido lo que de verdad llegó al bucket y es DICOM; la
 * descarga es un ZIP con los archivos tal como llegaron.
 */

const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("dd".repeat(32))
const STUDY = "2.25.77001"

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db

/** Lo que el «navegador» subió con su URL firmada, por clave. */
const bucket = new Map<string, Uint8Array>()

function dicomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes.set([0x44, 0x49, 0x43, 0x4d], 128)
  for (let i = 132; i < size; i++) bytes[i] = i % 251
  return bytes
}

const storage: Storage = {
  putAvatar: async () => {
    throw new Error("no usado")
  },
  deleteByUrl: async () => {},
  putAttachment: async () => {
    throw new Error("no usado")
  },
  attachmentUrl: async (key) => `https://signed.example.com/get/${key}`,
  deleteAttachment: async () => {},
  putPatientDocument: async ({ orgId, patientId, bytes, contentType, ext }) => {
    const objectKey = `patients/${orgId}/${patientId}/docs/${crypto.randomUUID()}.${ext}`
    bucket.set(objectKey, bytes)
    return { objectKey, mimeType: contentType, filename: `doc.${ext}`, size: bytes.byteLength }
  },
  putPatientAvatar: async () => {
    throw new Error("no usado")
  },
  uploadUrl: async (key) => `https://signed.example.com/put/${key}`,
  probeAttachment: async (key, first) => {
    const bytes = bucket.get(key)
    return bytes ? { size: bytes.byteLength, head: bytes.slice(0, first) } : null
  },
  streamAttachment: async (key) => {
    const bytes = bucket.get(key)
    if (!bytes) throw new Error("No existe")
    return new Blob([new Uint8Array(bytes)]).stream()
  },
}

function buildApp(role: string): Hono {
  const deps: CrmDeps = {
    db: appDb,
    secretsKey: KEY,
    storage,
    validateExternal: false,
    webhookBaseUrl: "https://api.example.com",
  }
  const app = new Hono()
  app.use("*", async (c: Context, next: Next) => {
    c.set("orgId", "org_a")
    c.set("userId", "u-1")
    c.set("memberRole", role)
    await next()
  })
  app.route("/patients", createPatientsRoute(deps))
  return app
}

function post(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function patientId(): Promise<string> {
  const response = await post(buildApp("owner"), "/patients", {
    submissionId: crypto.randomUUID(),
    answers: {
      demographics: { displayName: "Carmen Díaz" },
      respondent: "staff",
      privacyAccepted: false,
    },
  })
  expect(response.status).toBe(201)
  return ((await response.json()) as { data: { id: string } }).data.id
}

const sizes = [400, 500, 600]
const start = {
  label: "Tomografía (CBCT)",
  studyInstanceUid: STUDY,
  dicomPatientName: "DIAZ^CARMEN",
  modality: "CT",
  sliceCount: 3,
  voxelMm: 0.2,
  files: sizes.map((sizeBytes, i) => ({
    sopInstanceUid: `${STUDY}.4.${i + 1}`,
    seriesInstanceUid: `${STUDY}.2`,
    sizeBytes,
  })),
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
  await ownerDb.execute(
    sql`insert into "organization" ("id", "name", "slug", "created_at") values ('org_a', 'Clínica', 'norte', now())`,
  )
  await ownerDb.execute(
    sql`insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale") values ('org_a', 'Clínica', 'PE', 'PEN', 'America/Lima', 'es-PE')`,
  )
  await ownerDb.execute(
    sql`insert into "user" ("id", "name", "email") values ('u-1', 'Lucía', 'lucia@test.dev') on conflict do nothing`,
  )
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

it("recepción sube la tomografía y ve el avance, pero no la abre ni la descarga", async () => {
  const id = await patientId()
  const reception = buildApp("reception")
  const started = await post(reception, `/patients/${id}/imaging/uploads`, start)
  expect(started.status).toBe(201)
  const body = (await started.json()) as {
    data: { state: string; document: { id: string }; pending: number[]; targets: { index: number; url: string }[] }
  }
  expect(body.data.state).toBe("new")
  expect(body.data.pending).toEqual([0, 1, 2])
  const documentId = body.data.document.id

  // El «navegador» sube dos archivos bien y uno que no es DICOM.
  for (const target of body.data.targets) {
    const key = target.url.replace("https://signed.example.com/put/", "")
    const bytes = target.index === 2 ? new Uint8Array(sizes[2]!) : dicomBytes(sizes[target.index]!)
    bucket.set(key, bytes)
  }
  const confirmed = await post(reception, `/patients/${id}/imaging/uploads/${documentId}/confirm`, {
    indexes: [0, 1, 2],
  })
  expect(confirmed.status).toBe(200)
  const progress = (await confirmed.json()) as {
    data: { uploadedCount: number; completedAt: string | null; rejected: { index: number; problem: string }[] }
  }
  expect(progress.data).toMatchObject({ uploadedCount: 2, completedAt: null, rejected: [{ index: 2, problem: "not_dicom" }] })

  // Lo vuelve a subir bien: queda completa.
  const resign = await post(reception, `/patients/${id}/imaging/uploads/${documentId}/sign`, { indexes: [2] })
  const [target] = ((await resign.json()) as { data: { index: number; url: string }[] }).data
  bucket.set(target!.url.replace("https://signed.example.com/put/", ""), dicomBytes(sizes[2]!))
  const done = await post(reception, `/patients/${id}/imaging/uploads/${documentId}/confirm`, { indexes: [2] })
  expect(((await done.json()) as { data: { completedAt: string | null } }).data.completedAt).not.toBeNull()

  const list = await reception.request(`/patients/${id}/imaging/uploads`)
  expect(list.status).toBe(200)
  const rows = ((await list.json()) as { data: { documentId: string; uploadedCount: number }[] }).data
  expect(rows).toMatchObject([{ documentId, uploadedCount: 3 }])

  // Abrirla, descargarla o ver los documentos sigue siendo clínico.
  expect((await reception.request(`/patients/${id}/imaging/studies/${documentId}/files`)).status).toBe(403)
  expect((await reception.request(`/patients/${id}/imaging/studies/${documentId}/download`)).status).toBe(403)
  expect((await reception.request(`/patients/${id}/documents`)).status).toBe(403)

  // Caja no sube tomografías.
  expect((await post(buildApp("cashier"), `/patients/${id}/imaging/uploads`, start)).status).toBe(403)
})

it("quien lee la ficha la abre y la descarga como ZIP con los archivos tal como llegaron", async () => {
  const id = await patientId()
  const dentist = buildApp("dentist")
  const started = await post(dentist, `/patients/${id}/imaging/uploads`, {
    ...start,
    studyInstanceUid: `${STUDY}.9`,
  })
  const { data } = (await started.json()) as {
    data: { document: { id: string }; targets: { index: number; url: string }[] }
  }
  for (const target of data.targets)
    bucket.set(target.url.replace("https://signed.example.com/put/", ""), dicomBytes(sizes[target.index]!))
  await post(dentist, `/patients/${id}/imaging/uploads/${data.document.id}/confirm`, { indexes: [0, 1, 2] })

  const files = await dentist.request(`/patients/${id}/imaging/studies/${data.document.id}/files`)
  expect(files.status).toBe(200)
  const listed = ((await files.json()) as { data: { files: { index: number; url: string }[] } }).data.files
  expect(listed.map((file) => file.index)).toEqual([0, 1, 2])

  const zip = await dentist.request(`/patients/${id}/imaging/studies/${data.document.id}/download`)
  expect(zip.status).toBe(200)
  expect(zip.headers.get("content-type")).toBe("application/zip")
  const bytes = new Uint8Array(await zip.arrayBuffer())
  const { unzipSync } = await import("fflate")
  const entries = unzipSync(bytes)
  expect(Object.keys(entries).sort()).toEqual(["DICOM/00001.dcm", "DICOM/00002.dcm", "DICOM/00003.dcm"])
  expect(entries["DICOM/00002.dcm"]).toEqual(dicomBytes(500))

  // Medidas: la odontóloga las guarda; recepción ni las lee ni las escribe.
  const measure = { kind: "distancia", view: "transversal", points: [[1, 2, 3], [1, 2, 14.8]], value: 11.8, toothNumber: 36 }
  const savedMeasure = await post(dentist, `/patients/${id}/imaging/studies/${data.document.id}/measurements`, measure)
  expect(savedMeasure.status).toBe(201)
  const reception = buildApp("reception")
  expect((await reception.request(`/patients/${id}/imaging/studies/${data.document.id}/measurements`)).status).toBe(403)
  expect(
    (await post(reception, `/patients/${id}/imaging/studies/${data.document.id}/measurements`, measure)).status,
  ).toBe(403)

  // La URL de un solo archivo no sirve para la tomografía: no hay uno solo.
  const single = await dentist.request(`/patients/${id}/documents/${data.document.id}/url`)
  expect(single.status).toBe(400)
})

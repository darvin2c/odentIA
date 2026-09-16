import type { FindingDetails } from "@odentia/clinical"

process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { createAppDb, createOwnerDb, type Db, withOrgContext } from "@odentia/db"
import { createPatient, type Storage, secretsKeyFromEnv } from "@odentia/services"
import { type SQL, sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Context } from "hono"
import { Hono, type Next } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import type { CrmDeps } from "./helpers.js"
import { createPatientsRoute } from "./patients.js"

const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("ee".repeat(32))

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db

const storageStub: Storage = {
  putAvatar: async () => {
    throw new Error("no usado")
  },
  deleteByUrl: async () => {},
  putAttachment: async () => {
    throw new Error("no usado")
  },
  attachmentUrl: async (key: string) => `https://signed.example.com/${key}`,
  deleteAttachment: async () => {},
  putPatientDocument: async ({ orgId, patientId, bytes, contentType, ext }) => ({
    objectKey: `patients/${orgId}/${patientId}/${crypto.randomUUID()}.${ext}`,
    mimeType: contentType,
    filename: `doc.${ext}`,
    size: bytes.byteLength,
  }),
  putPatientAvatar: async ({ orgId, patientId, bytes, contentType, ext }) => ({
    objectKey: `patients/${orgId}/${patientId}/avatar/${crypto.randomUUID()}.${ext}`,
    mimeType: contentType,
    filename: `avatar.${ext}`,
    size: bytes.byteLength,
  }),
}

function stubOrg(role: string) {
  return async (c: Context, next: Next) => {
    c.set("orgId", "org_a")
    c.set("userId", "u-1")
    c.set("memberRole", role)
    await next()
  }
}

function buildApp(role: string): Hono {
  const deps: CrmDeps = {
    db: appDb,
    secretsKey: KEY,
    storage: storageStub,
    validateExternal: false,
    webhookBaseUrl: "https://api.example.com",
  }
  const app = new Hono()
  app.use("*", stubOrg(role))
  app.route("/patients", createPatientsRoute(deps))
  return app
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
  const uri = `postgres://dentalagent:dentalagent@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`
  ownerDb = createOwnerDb(uri)
  await migrate(ownerDb, { migrationsFolder: "../../packages/db/drizzle" })
  appDb = createAppDb(
    `postgres://dentalagent_app:dentalagent_app@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`,
  )
  await ownerDb.execute(
    sql`insert into "organization" ("id", "name", "slug", "created_at") values ('org_a', 'Clínica', 'norte', now())`,
  )
  await ownerDb.execute(
    sql`insert into "organization" ("id", "name", "slug", "created_at") values ('org_b', 'Clínica Sur', 'sur', now())`,
  )
  await ownerDb.execute(
    sql`insert into "user" ("id", "name", "email") values ('u-1', 'Doctora', 'doc@test.dev') on conflict do nothing`,
  )
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

interface TimelineItemDto {
  id: string
  type: "encounter" | "note" | "anamnesis" | "document" | "odontogram"
  createdAt: string
  title: string
  detail?: string | null
  toothNumbers: number[]
  refId: string
  category?: string
}

interface TimelinePage {
  data: TimelineItemDto[]
  nextCursor: string | null
}

interface ErrorBody {
  error: { code: string; message: string }
}

async function createFixturePatient(app: Hono, displayName: string): Promise<string> {
  const res = await app.request("/patients", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName }),
  })
  expect(res.status).toBe(201)
  const body = (await res.json()) as { data: { id: string } }
  return body.data.id
}

type StampTable =
  | "clinical_note"
  | "patient_anamnesis"
  | "patient_document"
  | "odontogram_entry"
  | "encounter"

const STAMP_TABLE: Record<StampTable, SQL> = {
  clinical_note: sql`"clinical_note"`,
  patient_anamnesis: sql`"patient_anamnesis"`,
  patient_document: sql`"patient_document"`,
  odontogram_entry: sql`"odontogram_entry"`,
  encounter: sql`"encounter"`,
}

async function stamp(table: StampTable, id: string, iso: string): Promise<void> {
  await ownerDb.execute(
    sql`update ${STAMP_TABLE[table]} set "created_at" = ${iso}::timestamptz where "id" = ${id}::uuid`,
  )
}

async function postNote(
  app: Hono,
  patientId: string,
  note: string,
  encounterId?: string,
): Promise<string> {
  const res = await app.request(`/patients/${patientId}/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(encounterId ? { note, encounterId } : { note }),
  })
  expect(res.status).toBe(201)
  const body = (await res.json()) as { data: { id: string } }
  return body.data.id
}

async function postAnamnesis(app: Hono, patientId: string, motivo: string): Promise<string> {
  // La escritura de anamnesis vive en PUT /health (agregado transaccional).
  const saved = await app.request(`/patients/${patientId}/health`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedRevision: 0,
      reviewStatus: { allergies: "none", conditions: "none", medications: "none" },
      allergies: [],
      conditions: [],
      medications: [],
      anamnesis: { expectedVersion: 0, answers: { antecedentesFamiliares: motivo } },
    }),
  })
  expect(saved.status).toBe(200)
  const read = await app.request(`/patients/${patientId}/anamnesis`, { method: "GET" })
  expect(read.status).toBe(200)
  const body = (await read.json()) as { data: { id: string } }
  return body.data.id
}

async function postOdontogramEntry(
  app: Hono,
  patientId: string,
  input: {
    toothNumber: number
    condition: string
    surfaces?: string[]
    details?: FindingDetails
    encounterId?: string
  },
): Promise<string> {
  const res = await app.request(`/patients/${patientId}/odontogram/entries`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  })
  expect(res.status).toBe(201)
  const body = (await res.json()) as { data: { id: string }[] }
  return body.data[0]!.id
}

async function postDocument(
  app: Hono,
  patientId: string,
  input: {
    category: string
    label: string
    toothNumbers?: number[]
    tags?: string[]
    encounterId?: string
  },
): Promise<string> {
  const form = new FormData()
  form.append(
    "file",
    new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "doc.png", { type: "image/png" }),
  )
  form.append("category", input.category)
  form.append("label", input.label)
  // Contexto versionado: piezas como arreglo JSON (vacío = imagen general).
  form.append("toothNumbers", JSON.stringify(input.toothNumbers ?? []))
  form.append("tags", JSON.stringify(input.tags ?? []))
  if (input.encounterId) form.append("encounterId", input.encounterId)
  const res = await app.request(`/patients/${patientId}/documents`, { method: "POST", body: form })
  expect(res.status).toBe(201)
  const body = (await res.json()) as { data: { id: string } }
  return body.data.id
}

async function createEncounter(
  app: Hono,
  patientId: string,
  reason: string,
  teeth: number[],
): Promise<string> {
  const res = await app.request(`/patients/${patientId}/encounters`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason, teeth }),
  })
  expect(res.status).toBe(201)
  const body = (await res.json()) as { data: { id: string } }
  return body.data.id
}

async function finalizeEncounter(app: Hono, patientId: string, encounterId: string): Promise<void> {
  // El cierre exige evolución clínica: se registra antes de finalizar.
  const patched = await app.request(`/patients/${patientId}/encounters/${encounterId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ evolution: "Evolución de control" }),
  })
  expect(patched.status).toBe(200)
  const res = await app.request(`/patients/${patientId}/encounters/${encounterId}/finalize`, {
    method: "POST",
  })
  expect(res.status).toBe(200)
}

interface FullFixture {
  patientId: string
  noteId: string
  anamnesisId: string
  docId: string
  odontoId: string
  encounterId: string
  linkedNoteId: string
  linkedDocId: string
  linkedEntryId: string
}

/** Paciente fresco con 5 eventos standalone + 3 hijos vinculados a la atención. */
async function seedFullTimeline(app: Hono, tag: string): Promise<FullFixture> {
  const patientId = await createFixturePatient(app, `Timeline ${tag}`)
  const noteId = await postNote(app, patientId, `nota suelta ${tag}`)
  const anamnesisId = await postAnamnesis(app, patientId, `dolor ${tag}`)
  const docId = await postDocument(app, patientId, {
    category: "radiografia",
    label: `rx 36 ${tag}`,
    toothNumbers: [36],
  })
  const odontoId = await postOdontogramEntry(app, patientId, {
    toothNumber: 36,
    condition: "caries",
    surfaces: ["occlusal"],
    details: { variant: "enamel" },
  })
  const encounterId = await createEncounter(app, patientId, `control ${tag}`, [36])
  const linkedNoteId = await postNote(app, patientId, `nota vinculada ${tag}`, encounterId)
  const linkedEntryId = await postOdontogramEntry(app, patientId, {
    toothNumber: 36,
    condition: "caries",
    surfaces: ["occlusal"],
    details: { variant: "enamel" },
    encounterId,
  })
  const linkedDocId = await postDocument(app, patientId, {
    category: "radiografia",
    label: `rx vinculada ${tag}`,
    toothNumbers: [36],
    encounterId,
  })
  await finalizeEncounter(app, patientId, encounterId)
  const base = `2026-02-02T10:0`
  await stamp("clinical_note", noteId, `${base}0:00.000Z`)
  await stamp("patient_anamnesis", anamnesisId, `${base}1:00.000Z`)
  await stamp("patient_document", docId, `${base}2:00.000Z`)
  await stamp("odontogram_entry", odontoId, `${base}3:00.000Z`)
  await stamp("encounter", encounterId, `${base}4:00.000Z`)
  await stamp("clinical_note", linkedNoteId, `${base}5:00.000Z`)
  await stamp("odontogram_entry", linkedEntryId, `${base}6:00.000Z`)
  await stamp("patient_document", linkedDocId, `${base}7:00.000Z`)
  return {
    patientId,
    noteId,
    anamnesisId,
    docId,
    odontoId,
    encounterId,
    linkedNoteId,
    linkedDocId,
    linkedEntryId,
  }
}

it("timeline: 5 eventos standalone en orden descendente, sin duplicar hijos vinculados", async () => {
  const app = buildApp("admin")
  const f = await seedFullTimeline(app, "orden")

  const res = await app.request(`/patients/${f.patientId}/timeline`, { method: "GET" })
  expect(res.status).toBe(200)
  const page = (await res.json()) as TimelinePage
  expect(page.nextCursor).toBeNull()
  expect(page.data).toHaveLength(5)

  expect(page.data.map((e) => e.type)).toEqual([
    "encounter",
    "odontogram",
    "document",
    "anamnesis",
    "note",
  ])
  expect(page.data.map((e) => e.id)).toEqual([
    f.encounterId,
    f.odontoId,
    f.docId,
    f.anamnesisId,
    f.noteId,
  ])

  const ids = new Set(page.data.map((e) => e.id))
  expect(ids.has(f.linkedNoteId)).toBe(false)
  expect(ids.has(f.linkedDocId)).toBe(false)
  expect(ids.has(f.linkedEntryId)).toBe(false)

  for (const item of page.data) {
    expect(item.id).toBe(item.refId)
    expect(typeof item.title).toBe("string")
  }
  for (let i = 1; i < page.data.length; i += 1) {
    expect(Date.parse(page.data[i - 1]!.createdAt)).toBeGreaterThan(
      Date.parse(page.data[i]!.createdAt),
    )
  }
  const itemOf = (type: TimelineItemDto["type"]): TimelineItemDto =>
    page.data.find((e) => e.type === type)!
  expect(itemOf("encounter").toothNumbers).toContain(36)
  expect(itemOf("document").toothNumbers).toEqual([36])
  expect(itemOf("odontogram").toothNumbers).toEqual([36])
  expect(itemOf("note").toothNumbers).toEqual([])
  expect(itemOf("anamnesis").toothNumbers).toEqual([])
  const onlyDocuments = await app.request(`/patients/${f.patientId}/timeline?types=document`)
  expect(onlyDocuments.status).toBe(200)
  const documents = (await onlyDocuments.json()) as TimelinePage
  expect(documents.data.map((item) => item.id).sort()).toEqual([f.docId, f.linkedDocId].sort())
})

it("timeline types=note devuelve solo la nota suelta", async () => {
  const app = buildApp("admin")
  const f = await seedFullTimeline(app, "nota")

  const res = await app.request(`/patients/${f.patientId}/timeline?types=note`, { method: "GET" })
  expect(res.status).toBe(200)
  const page = (await res.json()) as TimelinePage
  expect(page.nextCursor).toBeNull()
  expect(page.data).toHaveLength(1)
  expect(page.data[0]!.type).toBe("note")
  expect(page.data[0]!.id).toBe(f.noteId)
})

it("timeline toothNumber=36 devuelve encounter, document y odontogram", async () => {
  const app = buildApp("admin")
  const f = await seedFullTimeline(app, "pieza")

  const res = await app.request(`/patients/${f.patientId}/timeline?toothNumber=36`, {
    method: "GET",
  })
  expect(res.status).toBe(200)
  const page = (await res.json()) as TimelinePage
  expect(page.nextCursor).toBeNull()
  expect(page.data).toHaveLength(3)
  expect(page.data.map((e) => e.type).sort()).toEqual(["document", "encounter", "odontogram"])
  for (const item of page.data) {
    expect(item.toothNumbers).toContain(36)
  }
  const ids = new Set(page.data.map((e) => e.id))
  expect(ids.has(f.encounterId)).toBe(true)
  expect(ids.has(f.docId)).toBe(true)
  expect(ids.has(f.odontoId)).toBe(true)
})

it("timeline documentCategory=radiografia excluye foto_clinica", async () => {
  const app = buildApp("admin")
  const patientId = await createFixturePatient(app, "Timeline fotos")
  const rxId = await postDocument(app, patientId, { category: "radiografia", label: "rx control" })
  const photoId = await postDocument(app, patientId, {
    category: "foto_clinica",
    label: "foto frente",
  })

  const all = await app.request(`/patients/${patientId}/timeline?types=document`, {
    method: "GET",
  })
  expect(all.status).toBe(200)
  expect(((await all.json()) as TimelinePage).data).toHaveLength(2)

  const onlyRx = await app.request(
    `/patients/${patientId}/timeline?types=document&documentCategory=radiografia`,
    {
      method: "GET",
    },
  )
  expect(onlyRx.status).toBe(200)
  const rxPage = (await onlyRx.json()) as TimelinePage
  expect(rxPage.data).toHaveLength(1)
  expect(rxPage.data[0]!.id).toBe(rxId)
  expect(rxPage.data[0]!.category).toBe("radiografia")

  const onlyPhoto = await app.request(
    `/patients/${patientId}/timeline?types=document&documentCategory=foto_clinica`,
    {
      method: "GET",
    },
  )
  expect(onlyPhoto.status).toBe(200)
  const photoPage = (await onlyPhoto.json()) as TimelinePage
  expect(photoPage.data).toHaveLength(1)
  expect(photoPage.data[0]!.id).toBe(photoId)
})

it("timeline solo incluye encuentros finalizados", async () => {
  const app = buildApp("admin")
  const patientId = await createFixturePatient(app, "Timeline borrador")
  const encounterId = await createEncounter(app, patientId, "control borrador", [36])

  const draft = await app.request(`/patients/${patientId}/timeline?types=encounter`, {
    method: "GET",
  })
  expect(draft.status).toBe(200)
  const draftPage = (await draft.json()) as TimelinePage
  expect(draftPage.data).toHaveLength(0)
  expect(draftPage.nextCursor).toBeNull()

  await finalizeEncounter(app, patientId, encounterId)
  const done = await app.request(`/patients/${patientId}/timeline?types=encounter`, {
    method: "GET",
  })
  expect(done.status).toBe(200)
  const donePage = (await done.json()) as TimelinePage
  expect(donePage.data).toHaveLength(1)
  expect(donePage.data[0]!.id).toBe(encounterId)
})

it("timeline pagina con limit=2 sin duplicados y cursor inválido responde 400", async () => {
  const app = buildApp("admin")
  const f = await seedFullTimeline(app, "paginado")

  const seen: string[] = []
  let cursor: string | null = null
  let pages = 0
  for (;;) {
    const qs = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : "?limit=2"
    const res = await app.request(`/patients/${f.patientId}/timeline${qs}`, { method: "GET" })
    expect(res.status).toBe(200)
    const page = (await res.json()) as TimelinePage
    expect(page.data.length).toBeGreaterThan(0)
    expect(page.data.length).toBeLessThanOrEqual(2)
    seen.push(...page.data.map((e) => e.id))
    pages += 1
    cursor = page.nextCursor
    if (!cursor) break
    expect(pages).toBeLessThan(10)
  }
  expect(pages).toBe(3)
  expect(seen).toHaveLength(5)
  expect(new Set(seen).size).toBe(5)
  expect(new Set(seen)).toEqual(
    new Set([f.encounterId, f.odontoId, f.docId, f.anamnesisId, f.noteId]),
  )

  const bad = await app.request(`/patients/${f.patientId}/timeline?cursor=no-es-un-cursor`, {
    method: "GET",
  })
  expect(bad.status).toBe(400)
  const badBody = (await bad.json()) as ErrorBody
  expect(typeof badBody.error.code).toBe("string")
  expect(badBody.error.code.length).toBeGreaterThan(0)
})

it("timeline de paciente de otra organización responde 404", async () => {
  const other = await withOrgContext(appDb, "org_b", (tx) =>
    createPatient(tx, "org_b", "u-1", { displayName: "Paciente B timeline" }),
  )
  const app = buildApp("member")
  const res = await app.request(`/patients/${other.id}/timeline`, { method: "GET" })
  expect(res.status).toBe(404)
  const body = (await res.json()) as ErrorBody
  expect(typeof body.error.code).toBe("string")
})

it("timeline: documento multi-pieza aparece en el filtro de cada pieza", async () => {
  const app = buildApp("admin")
  const patientId = await createFixturePatient(app, "Timeline multipieza")
  const docId = await postDocument(app, patientId, {
    category: "radiografia",
    label: "rx panoramicada",
    toothNumbers: [36, 37],
    tags: ["control"],
  })

  for (const tooth of [36, 37]) {
    const res = await app.request(`/patients/${patientId}/timeline?toothNumber=${tooth}`, {
      method: "GET",
    })
    expect(res.status).toBe(200)
    const page = (await res.json()) as TimelinePage
    expect(page.data.map((e) => e.id)).toContain(docId)
    expect(page.data.find((e) => e.id === docId)!.toothNumbers.sort()).toEqual([36, 37])
  }

  const other = await app.request(`/patients/${patientId}/timeline?toothNumber=11`, {
    method: "GET",
  })
  expect(other.status).toBe(200)
  expect(((await other.json()) as TimelinePage).data.map((e) => e.id)).not.toContain(docId)
})

it("documentos: la lectura devuelve el contexto vigente fusionado", async () => {
  const app = buildApp("admin")
  const patientId = await createFixturePatient(app, "Timeline contexto")
  const docId = await postDocument(app, patientId, {
    category: "foto_clinica",
    label: "foto frente",
    toothNumbers: [11, 21],
    tags: ["control"],
  })

  const res = await app.request(`/patients/${patientId}/documents`, { method: "GET" })
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    data: Array<{
      id: string
      toothNumbers: number[]
      tags: string[]
      contextVersion: number
      encounterId: string | null
    }>
  }
  const doc = body.data.find((d) => d.id === docId)!
  expect(doc.toothNumbers).toEqual([11, 21])
  expect(doc.tags).toEqual(["control"])
  expect(doc.contextVersion).toBe(1)
  expect(doc.encounterId).toBeNull()
})

it("timeline: member lee 200 pero mutar clínica o corregir contexto responde 403 sin efectos", async () => {
  const admin = buildApp("admin")
  const member = buildApp("member")
  const patientId = await createFixturePatient(admin, "Timeline permisos")
  const docId = await postDocument(admin, patientId, {
    category: "radiografia",
    label: "rx",
    toothNumbers: [36],
  })

  const read = await member.request(`/patients/${patientId}/timeline`, { method: "GET" })
  expect(read.status).toBe(200)

  const note = await member.request(`/patients/${patientId}/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ note: "Nota de miembro" }),
  })
  expect(note.status).toBe(403)
  expect(((await note.json()) as ErrorBody).error.code).toBe("FORBIDDEN")

  const correction = await member.request(`/patients/${patientId}/documents/${docId}/context`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedVersion: 1, toothNumbers: [37] }),
  })
  expect(correction.status).toBe(403)
  expect(((await correction.json()) as ErrorBody).error.code).toBe("FORBIDDEN")

  // Sin efectos: el contexto vigente sigue intacto.
  const context = await admin.request(`/patients/${patientId}/documents/${docId}/context`, {
    method: "GET",
  })
  expect(context.status).toBe(200)
  const contextBody = (await context.json()) as {
    data: { document: { toothNumbers: number[]; contextVersion: number } }
  }
  expect(contextBody.data.document.toothNumbers).toEqual([36])
  expect(contextBody.data.document.contextVersion).toBe(1)
})

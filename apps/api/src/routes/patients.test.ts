process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { createAppDb, createOwnerDb, type Db, withOrgContext } from "@odentia/db"
import { createPatient, secretsKeyFromEnv } from "@odentia/services"
import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Context } from "hono"
import { Hono, type Next } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, expect, it } from "vitest"
import { createCie10Route } from "./cie10.js"
import type { CrmDeps } from "./helpers.js"
import { createPatientsRoute } from "./patients.js"

const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("ee".repeat(32))

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db

const storageStub = {
  putAvatar: async () => {
    throw new Error("no usado")
  },
  deleteByUrl: async () => {},
  putAttachment: async () => {
    throw new Error("no usado")
  },
  attachmentUrl: async (key: string) => `https://signed.example.com/${key}`,
  deleteAttachment: async () => {},
  putPatientDocument: async () => {
    throw new Error("no usado")
  },
  putPatientAvatar: async ({
    orgId,
    patientId,
    bytes,
    contentType,
    ext,
  }: {
    orgId: string
    patientId: string
    bytes: Uint8Array
    contentType: string
    ext: string
  }) => ({
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
  app.route("/cie10", createCie10Route(deps))
  return app
}

let patientId = ""

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
  await ownerDb.execute(
    sql`insert into "cie10_code" ("code", "description") values
        ('K02.1', 'Caries de la dentina'),
        ('K04.0', 'Pulpitis'),
        ('Z01.2', 'Examen dental')
        on conflict ("code") do nothing`,
  )
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

it("pacientes: POST 201 y GET 200", async () => {
  const app = buildApp("admin")
  const created = await app.request("/patients", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "María Pérez", docType: "DNI", docNumber: "12345678" }),
  })
  expect(created.status).toBe(201)
  const body = (await created.json()) as { data: { id: string; patientNumber: number } }
  expect(body.data.patientNumber).toBe(1)
  patientId = body.data.id

  const list = await app.request("/patients", { method: "GET" })
  expect(list.status).toBe(200)
  const listed = (await list.json()) as { data: { id: string }[] }
  expect(listed.data.map((p) => p.id)).toContain(patientId)

  const detail = await app.request(`/patients/${patientId}`, { method: "GET" })
  expect(detail.status).toBe(200)
})

it("cross-org: paciente de B responde 404 en A", async () => {
  const other = await withOrgContext(appDb, "org_b", (tx) =>
    createPatient(tx, "org_b", "u-1", { displayName: "Paciente B" }),
  )
  const app = buildApp("member")
  const res = await app.request(`/patients/${other.id}`, { method: "GET" })
  expect(res.status).toBe(404)
})

it("POST /:id/notes como admin responde 201; como member 403 FORBIDDEN", async () => {
  const admin = buildApp("admin")
  const member = buildApp("member")
  const res = await admin.request(`/patients/${patientId}/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ note: "Se indica endodoncia", diagnosisCode: "K04.0" }),
  })
  expect(res.status).toBe(201)
  const denied = await member.request(`/patients/${patientId}/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ note: "Nota de miembro" }),
  })
  expect(denied.status).toBe(403)
  expect(((await denied.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN")
})

it("GET /cie10?q=caries devuelve resultados", async () => {
  const app = buildApp("member")
  const res = await app.request("/cie10?q=caries", { method: "GET" })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { data: { code: string }[] }
  expect(body.data.length).toBeGreaterThan(0)
  expect(body.data[0]!.code).toBe("K02.1")
})

it("salud PUT guarda el agregado; claves viejas de entrevista y endpoints retirados responden 400/404", async () => {
  const app = buildApp("admin")
  const base = {
    expectedRevision: 0,
    reviewStatus: { allergies: "recorded", conditions: "none", medications: "none" },
    allergies: [{ substance: "Penicilina", severity: "severa" }],
    conditions: [],
    medications: [],
    anamnesis: { expectedVersion: 0, answers: { antecedentesFamiliares: "Ninguno" } },
  }
  const saved = await app.request(`/patients/${patientId}/health`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(base),
  })
  expect(saved.status).toBe(200)
  const savedBody = (await saved.json()) as {
    data: { revision: number; latestAnamnesis: { version: number } }
  }
  expect(savedBody.data.revision).toBe(1)
  expect(savedBody.data.latestAnamnesis.version).toBe(1)

  const read = await app.request(`/patients/${patientId}/health`, { method: "GET" })
  expect(read.status).toBe(200)
  const readBody = (await read.json()) as { data: { revision: number; allergies: unknown[] } }
  expect(readBody.data.revision).toBe(1)
  expect(readBody.data.allergies).toHaveLength(1)

  // Motivo/examen/diagnóstico ya no pertenecen a la entrevista.
  const forbidden = await app.request(`/patients/${patientId}/health`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...base,
      expectedRevision: 1,
      anamnesis: { expectedVersion: 1, answers: { motivoConsulta: "dolor" } },
    }),
  })
  expect(forbidden.status).toBe(400)

  // Revisión vieja: 409 sin sobrescribir.
  const stale = await app.request(`/patients/${patientId}/health`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(base),
  })
  expect(stale.status).toBe(409)
  expect(((await stale.json()) as { error: { code: string } }).error.code).toBe(
    "STALE_HEALTH_REVISION",
  )

  // Endpoints individuales retirados.
  const gone = await app.request(`/patients/${patientId}/allergies`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ substance: "X", severity: "leve" }),
  })
  expect(gone.status).toBe(404)
})

it("odontograma con pieza inválida responde 400", async () => {
  const app = buildApp("admin")
  const res = await app.request(`/patients/${patientId}/odontogram/entries`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ toothNumber: 99, condition: "caries", surfaces: [] }),
  })
  expect(res.status).toBe(400)
})

it("odontograma: buccal en anterior 400; facial en anterior 201; void exige motivo", async () => {
  const app = buildApp("admin")
  const post = (body: unknown) =>
    app.request(`/patients/${patientId}/odontogram/entries`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  expect((await post({ toothNumber: 11, condition: "caries", surfaces: ["buccal"] })).status).toBe(
    400,
  )
  const created = await post({
    toothNumber: 11,
    condition: "caries",
    surfaces: ["facial"],
    details: { variant: "enamel" },
  })
  expect(created.status).toBe(201)
  const { data } = (await created.json()) as { data: { id: string }[] }
  const entryId = data[0]!.id
  const noReason = await app.request(`/patients/${patientId}/odontogram/entries/${entryId}/void`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  })
  expect(noReason.status).toBe(400)
  const voided = await app.request(`/patients/${patientId}/odontogram/entries/${entryId}/void`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "Error de registro" }),
  })
  expect(voided.status).toBe(200)
  const voidBody = (await voided.json()) as { data: { status: string; voidReason: string } }
  expect(voidBody.data.status).toBe("voided")
  expect(voidBody.data.voidReason).toBe("Error de registro")
})

it("actas: POST 201 con identidad firmada y GET lista; firma vacía 400", async () => {
  const app = buildApp("admin")
  const base = {
    purpose: "initial",
    specifications: "Odontograma inicial",
    observations: "Sin observaciones",
    examinerName: "Doctora Test",
    registrationNumber: "COP 1",
    signature: [
      [
        [5, 90],
        [20, 70],
      ],
    ],
  }
  const empty = await app.request(`/patients/${patientId}/odontogram/assessments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...base, signature: [] }),
  })
  expect(empty.status).toBe(400)
  const sealed = await app.request(`/patients/${patientId}/odontogram/assessments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(base),
  })
  expect(sealed.status).toBe(201)
  const sealedBody = (await sealed.json()) as {
    data: { patientName: string; patientNumber: number; entries: unknown[] }
  }
  expect(sealedBody.data.patientName).toBe("María Pérez")
  expect(sealedBody.data.patientNumber).toBe(1)
  const listed = await app.request(`/patients/${patientId}/odontogram/assessments`)
  expect(listed.status).toBe(200)
  const listedBody = (await listed.json()) as { data: unknown[] }
  expect(listedBody.data).toHaveLength(1)
})

it("avatar privado: subida y URL firmada; rechaza tipo y tamaño inválidos", async () => {
  const app = buildApp("admin")
  const p = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", "u-1", { displayName: "Avatar" }),
  )
  const missing = await app.request(`/patients/${p.id}/avatar-url`)
  expect(missing.status).toBe(404)
  expect(await missing.json()).toMatchObject({ error: { code: "NO_AVATAR" } })
  const image = new FormData()
  image.set(
    "file",
    new File([new Uint8Array([255, 216, 255, 217])], "portrait.jpg", { type: "image/jpeg" }),
  )
  const uploaded = await app.request(`/patients/${p.id}/avatar`, { method: "POST", body: image })
  expect(uploaded.status).toBe(201)
  const url = await app.request(`/patients/${p.id}/avatar-url`)
  expect(url.status).toBe(200)
  expect(await url.json()).toMatchObject({
    data: { url: expect.stringMatching(/^https:\/\/signed\.example\.com\/patients\/org_a\//) },
  })
  const pdf = new FormData()
  pdf.set("file", new File(["pdf"], "portrait.pdf", { type: "application/pdf" }))
  expect(
    (await app.request(`/patients/${p.id}/avatar`, { method: "POST", body: pdf })).status,
  ).toBe(400)
  const huge = new FormData()
  huge.set(
    "file",
    new File([new Uint8Array(2 * 1024 * 1024 + 1)], "huge.png", { type: "image/png" }),
  )
  expect(
    (await app.request(`/patients/${p.id}/avatar`, { method: "POST", body: huge })).status,
  ).toBe(400)
})

it("filiación PATCH edita nombre y contacto sin tocar la identidad del CRM", async () => {
  const app = buildApp("admin")
  const created = await app.request("/patients", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      displayName: "Nombre Original",
      phone: "+51999111222",
      docType: "DNI",
      docNumber: "11223344",
    }),
  })
  expect(created.status).toBe(201)
  const id = ((await created.json()) as { data: { id: string; contactId: string } }).data.id

  const patched = await app.request(`/patients/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Nombre Editado", phone: "+51999333444" }),
  })
  expect(patched.status).toBe(200)
  const other = await app.request("/patients", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Otro", docType: "DNI", docNumber: "44332211" }),
  })
  expect(other.status).toBe(201)
  const detail = (await (await app.request(`/patients/${id}`, { method: "GET" })).json()) as {
    data: { displayName: string; patient: { phone: string }; contactId: string }
  }
  expect(detail.data.displayName).toBe("Nombre Editado")
  expect(detail.data.patient.phone).toBe("+51999333444")

  // Documento duplicado visible sin cerrar nada.
  const dup = await app.request(`/patients/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ docType: "DNI", docNumber: "44332211" }),
  })
  expect(dup.status).toBe(409)
  expect(((await dup.json()) as { error: { code: string } }).error.code).toBe("DUPLICATE_DOCUMENT")
})

it("filiación PATCH valida DNI exacto, pasaporte libre y tutor de la org", async () => {
  const app = buildApp("admin")
  const created = await app.request("/patients", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Doc Paciente" }),
  })
  const id = ((await created.json()) as { data: { id: string } }).data.id

  const badDni = await app.request(`/patients/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ docType: "DNI", docNumber: "123" }),
  })
  expect(badDni.status).toBe(400)

  const passport = await app.request(`/patients/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ docType: "PASAPORTE", docNumber: "AB123456" }),
  })
  expect(passport.status).toBe(200)

  const foreignGuardian = await app.request(`/patients/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ guardianContactId: "c0000000-0000-4000-8000-000000000000" }),
  })
  expect(foreignGuardian.status).toBe(404)
})

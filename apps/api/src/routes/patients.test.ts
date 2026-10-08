process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { createAppDb, createOwnerDb, type Db, withOrgContext } from "@odentia/db"
import { createContact, createPatient, secretsKeyFromEnv } from "@odentia/services"
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
let patientId = ""

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
function registrationBody(
  displayName: string,
  demographics: Record<string, unknown> = {},
  top: Record<string, unknown> = {},
) {
  return {
    submissionId: crypto.randomUUID(),
    answers: {
      demographics: { displayName, ...demographics },
      respondent: "staff",
      privacyAccepted: false,
    },
    ...top,
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
    body: JSON.stringify(
      registrationBody("María Pérez", { docType: "DNI", docNumber: "12345678" }),
    ),
  })
  expect(created.status).toBe(201)
  const body = await created.json() as { data: { id: string; patientNumber: number } }
  expect(body.data.patientNumber).toBe(1)
  patientId = body.data.id

  const list = await app.request("/patients", { method: "GET" })
  expect(list.status).toBe(200)
  const listed = await list.json() as { data: { id: string }[] }
  expect(listed.data.map((p) => p.id)).toContain(patientId)

  const detail = await app.request(`/patients/${patientId}`, { method: "GET" })
  expect(detail.status).toBe(200)
  const detailBody = await detail.json() as {
    data: {
      patient: { id: string; displayName: string }
      contacts: unknown[]
      registration: { entryPoint: string; respondent: string } | null
    }
  }
  expect(detailBody.data.patient.displayName).toBe("María Pérez")
  expect(detailBody.data.contacts).toEqual([
    expect.objectContaining({ relationship: "self", displayName: "María Pérez" }),
  ])
  expect(detailBody.data.registration).toMatchObject({
    entryPoint: "platform",
    respondent: "staff",
  })
})

it("cross-org: paciente de B responde 404 en A con rol legítimo; member 403", async () => {
  const other = await withOrgContext(appDb, "org_b", (tx) =>
    createPatient(tx, "org_b", "u-1", { displayName: "Paciente B" }),
  )
  const reception = buildApp("reception")
  const res = await reception.request(`/patients/${other.id}`, { method: "GET" })
  expect(res.status).toBe(404)
  const member = buildApp("member")
  const denied = await member.request(`/patients/${other.id}`, { method: "GET" })
  expect(denied.status).toBe(403)
})

it("cada subruta del paciente exige solo el permiso de su dominio", async () => {
  const get = (role: string, path: string) =>
    buildApp(role).request(`/patients/${patientId}${path}`, { method: "GET" })
  // Los guardas de caja no alcanzan a las subrutas clínicas ni de filiación.
  expect((await get("reception", "/responsibilities")).status).toBe(200)
  expect((await get("dentist", "/responsibilities")).status).toBe(200)
  expect((await get("dentist", "/follow-ups")).status).toBe(200)
  expect((await get("dentist", "/prescriptions")).status).toBe(200)
  // Caja sigue cerrada para quien no cobra, y clínica para quien no atiende.
  for (const role of ["reception", "dentist"]) {
    expect((await get(role, "/account")).status).toBe(403)
    expect((await get(role, "/budgets")).status).toBe(403)
    const charge = await buildApp(role).request(`/patients/${patientId}/charges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "Cargo", amountCents: 1000, currency: "PEN" }),
    })
    expect(charge.status).toBe(403)
  }
  // Coordinación: quien agenda la consulta sin leer la ficha; caja no.
  const coordination = await get("reception", "/coordination")
  expect(coordination.status).toBe(200)
  expect(Object.keys(((await coordination.json()) as { data: object }).data).sort()).toEqual([
    "budgetsAwaitingDecision",
    "followUps",
    "treatments",
  ])
  expect((await get("dentist", "/coordination")).status).toBe(200)
  expect((await get("cashier", "/coordination")).status).toBe(403)
  // La ficha completa lleva antecedentes para quien atiende: deja traza; para
  // recepción llega sin salud y no la deja.
  expect((await get("dentist", "")).status).toBe(200)
  expect((await get("reception", "")).status).toBe(200)
  // Cada lectura clínica atendida deja traza; la lee solo quien audita.
  const log = await buildApp("admin").request(`/patients/${patientId}/access-log`, { method: "GET" })
  expect(log.status).toBe(200)
  const entries = ((await log.json()) as { data: { resource: string; hits: number }[] }).data
  expect(entries.map((entry) => entry.resource).sort()).toEqual([
    "antecedentes",
    "controles",
    "recetas",
  ])
  expect(entries.find((entry) => entry.resource === "antecedentes")?.hits).toBe(1)
  expect((await get("dentist", "/access-log")).status).toBe(403)
  expect((await get("reception", "/access-log")).status).toBe(403)
  expect((await get("cashier", "/account")).status).toBe(200)
  expect((await get("cashier", "/follow-ups")).status).toBe(403)
  expect((await get("reception", "/follow-ups")).status).toBe(403)
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

it("GET /cie10?q=caries devuelve resultados con rol clínico; member 403", async () => {
  const dentist = buildApp("dentist")
  const res = await dentist.request("/cie10?q=caries", { method: "GET" })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { data: { code: string }[] }
  expect(body.data.length).toBeGreaterThan(0)
  expect(body.data[0]!.code).toBe("K02.1")
  const member = buildApp("member")
  const denied = await member.request("/cie10?q=caries", { method: "GET" })
  expect(denied.status).toBe(403)
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

  // Recepción recibe solo la alerta de alergias; caja, nada clínico.
  type Trimmed = {
    data: { registration: unknown; activeAllergies: { substance: string }[]; activeConditions: unknown[] }
  }
  const asReception = await buildApp("reception").request(`/patients/${patientId}`, { method: "GET" })
  const receptionBody = (await asReception.json()) as Trimmed
  expect(receptionBody.data.activeAllergies.map((item) => item.substance)).toEqual(["Penicilina"])
  expect(receptionBody.data.registration).toBeNull()
  expect(receptionBody.data.activeConditions).toEqual([])
  const receptionHealth = await buildApp("reception").request(`/patients/${patientId}/health`, {
    method: "GET",
  })
  expect(receptionHealth.status).toBe(403)
  const asCashier = await buildApp("cashier").request(`/patients/${patientId}`, { method: "GET" })
  expect(((await asCashier.json()) as Trimmed).data.activeAllergies).toEqual([])

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

it("filiación PATCH edita el nombre del paciente y el de su propia persona", async () => {
  const app = buildApp("admin")
  const contact = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Contacto Original" }),
  )
  const created = await app.request("/patients", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      registrationBody(
        "Nombre Original",
        { phone: "+51999111222", docType: "DNI", docNumber: "11223344" },
        {
          contacts: [{ contactId: contact.id, relationship: "self", isPreferred: true }],
        },
      ),
    ),
  })
  expect(created.status).toBe(201)
  const createdBody = await created.json() as { data: { id: string } }
  const id = createdBody.data.id

  const patched = await app.request(`/patients/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Nombre Editado", phone: "+51999333444" }),
  })
  expect(patched.status).toBe(200)
  const other = await app.request("/patients", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(registrationBody("Otro", { docType: "DNI", docNumber: "44332211" })),
  })
  expect(other.status).toBe(201)
  const detailRes = await app.request(`/patients/${id}`, { method: "GET" })
  const detail = await detailRes.json() as {
    data: {
      patient: { displayName: string; phone: string }
      contacts: { contactId: string; displayName: string; relationship: string }[]
    }
  }
  expect(detail.data.patient.displayName).toBe("Nombre Editado")
  expect(detail.data.patient.phone).toBe("+51999333444")
  // Persona única: su propia persona comparte la identidad de la ficha.
  expect(detail.data.contacts).toEqual([
    expect.objectContaining({
      contactId: contact.id,
      displayName: "Nombre Editado",
      relationship: "self",
    }),
  ])

  // Documento duplicado visible sin cerrar nada.
  const dup = await app.request(`/patients/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ docType: "DNI", docNumber: "44332211" }),
  })
  expect(dup.status).toBe(409)
  const dupBody = await dup.json() as { error: { code: string } }
  expect(dupBody.error.code).toBe("DUPLICATE_DOCUMENT")
})

it("filiación PATCH valida DNI exacto y pasaporte libre", async () => {
  const app = buildApp("admin")
  const created = await app.request("/patients", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(registrationBody("Doc Paciente")),
  })
  const createdBody = await created.json() as { data: { id: string } }
  const id = createdBody.data.id

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
})

it("relaciones: vincular, preferente, duplicados y desvincular sin borrar personas", async () => {
  const app = buildApp("admin")
  const madre = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Madre Vínculo" }),
  )
  const tia = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Tía Vínculo" }),
  )
  const created = await app.request("/patients", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(registrationBody("Hijo Vínculo")),
  })
  expect(created.status).toBe(201)
  const createdBody = await created.json() as { data: { id: string } }
  const id = createdBody.data.id

  const linkMadre = await app.request(`/patients/${id}/contacts/${madre.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ relationship: "guardian", relationshipDetail: "Madre", isPreferred: true }),
  })
  expect(linkMadre.status).toBe(200)
  const linkTia = await app.request(`/patients/${id}/contacts/${tia.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ relationship: "family", isPreferred: false }),
  })
  expect(linkTia.status).toBe(200)

  // Sugerencias por nombre antes de registrar otro parecido.
  const dupes = await app.request(
    `/patients/duplicates?displayName=${encodeURIComponent("Hijo Vínculo")}`,
    { method: "GET" },
  )
  expect(dupes.status).toBe(200)
  const dupesBody = await dupes.json() as { data: unknown[] }
  expect(Array.isArray(dupesBody.data)).toBe(true)

  const fichaMadre = await app.request("/patients", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...registrationBody("Madre Vínculo"),
      contacts: [{ contactId: madre.id, relationship: "self", isPreferred: true }],
    }),
  })
  expect(fichaMadre.status).toBe(201)
  // Segundo self del mismo contacto en otra ficha da 409.
  const segundo = await app.request("/patients", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(registrationBody("Otra Ficha")),
  })
  expect(segundo.status).toBe(201)
  const segundoBody = await segundo.json() as { data: { id: string } }
  const segundoSelf = await app.request(
    `/patients/${segundoBody.data.id}/contacts/${madre.id}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ relationship: "self", isPreferred: false }),
    },
  )
  expect(segundoSelf.status).toBe(409)

  // Desvincular no borra al paciente ni al contacto.
  const unlinked = await app.request(`/patients/${id}/contacts/${tia.id}`, { method: "DELETE" })
  expect(unlinked.status).toBe(200)
  const afterRes = await app.request(`/patients/${id}`, { method: "GET" })
  expect(afterRes.status).toBe(200)
  const after = await afterRes.json() as {
    data: { contacts: { contactId: string }[] }
  }
  expect(after.data.contacts.map((c) => c.contactId)).not.toContain(tia.id)
  expect(after.data.contacts.map((c) => c.contactId)).toContain(madre.id)
})

it("relaciones: contacto de otra organización responde 404", async () => {
  const app = buildApp("admin")
  const ajeno = await withOrgContext(appDb, "org_b", (tx) =>
    createContact(tx, "org_b", { displayName: "Contacto Ajeno" }),
  )
  const created = await app.request("/patients", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(registrationBody("Paciente Propio Rel")),
  })
  const createdBody = await created.json() as { data: { id: string } }
  const foreign = await app.request(`/patients/${createdBody.data.id}/contacts/${ajeno.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ relationship: "family", isPreferred: false }),
  })
  expect(foreign.status).toBe(404)
})

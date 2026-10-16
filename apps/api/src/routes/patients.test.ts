process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { createAppDb, createOwnerDb, type Db, withOrgContext } from "@odentia/db"
import { contactIdentity, conversation } from "@odentia/db/schema/crm"
import {
  createConnection,
  createContact,
  createPatient,
  getPatientRegistrationConfig,
  savePatientRegistrationConfig,
  secretsKeyFromEnv,
} from "@odentia/services"
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
  // Clínicas de Perú: el DNI es uno de sus documentos (ADR 0036).
  await ownerDb.execute(
    sql`insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale")
        values ('org_a', 'Clínica', 'PE', 'PEN', 'America/Lima', 'es-PE'), ('org_b', 'Clínica Sur', 'PE', 'PEN', 'America/Lima', 'es-PE')`,
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

it("recepción registra con lo mínimo al reservar a la persona de una conversación aunque la clínica exija más", async () => {
  // La clínica publica su registro: exige la fecha de nacimiento.
  await withOrgContext(appDb, "org_a", async (tx) => {
    const current = await getPatientRegistrationConfig(tx, "org_a")
    await savePatientRegistrationConfig(tx, "org_a", "u-1", {
      expectedVersion: current.version,
      enabled: false,
      fields: current.fields,
      privacyNotice: "Aviso.",
    })
  })
  const person = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Carmen Huamán", phone: "+51987654100" }),
  )
  const conn = await withOrgContext(appDb, "org_a", (tx) =>
    createConnection(
      tx,
      "org_a",
      KEY,
      { channel: "telegram", provider: "telegram_bot_api", displayName: "Bot", config: { botToken: "T" } },
      { fetch, validateExternal: false },
    ),
  )
  const externalId = `tg:${crypto.randomUUID()}`
  const [identity] = await ownerDb
    .insert(contactIdentity)
    .values({ organizationId: "org_a", contactId: person.id, channel: "telegram", externalUserId: externalId })
    .returning()
  const [thread] = await ownerDb
    .insert(conversation)
    .values({
      organizationId: "org_a",
      contactId: person.id,
      channelConnectionId: conn.id,
      externalThreadId: externalId,
      contactIdentityId: identity!.id,
    })
    .returning({ id: conversation.id })
  const body = (top: Record<string, unknown>) =>
    JSON.stringify(
      registrationBody("Carmen Huamán", { givenNames: "Carmen", paternalSurname: "Huamán", phone: "+51987654100" }, {
        contextContactId: person.id,
        contacts: [{ contactId: person.id, relationship: "self", isPreferred: true }],
        ...top,
      }),
    )
  const post = (role: string, top: Record<string, unknown>) =>
    buildApp(role).request("/patients", { method: "POST", headers: { "content-type": "application/json" }, body: body(top) })

  // Sin lo mínimo, el alta interna exige lo que pide la clínica: lo que fallaba al reservar.
  const full = await post("reception", { conversationId: thread!.id })
  expect(full.status).toBe(400)
  // Fuera de la conversación de la persona, lo mínimo no se acepta; sin permiso de pacientes, tampoco.
  expect((await post("reception", { scope: "essentials" })).status).toBe(400)
  expect((await post("dentist", { scope: "essentials", conversationId: thread!.id })).status).toBe(403)
  expect((await post("reception", { scope: "otro", conversationId: thread!.id })).status).toBe(400)

  const created = await post("reception", { scope: "essentials", conversationId: thread!.id })
  expect(created.status).toBe(201)
  const { data } = (await created.json()) as { data: { id: string } }
  const detail = await buildApp("reception").request(`/patients/${data.id}`, { method: "GET" })
  const detailBody = (await detail.json()) as {
    data: { patient: { birthDate: string | null; identityNeedsReview: boolean }; contacts: { contactId: string; relationship: string }[] }
  }
  expect(detailBody.data.patient).toMatchObject({ birthDate: null, identityNeedsReview: true })
  expect(detailBody.data.contacts).toEqual([expect.objectContaining({ contactId: person.id, relationship: "self" })])

  // Desde la Agenda, sin conversación: alguien nuevo con nombres, apellidos y
  // teléfono, aunque la clínica pida la fecha de nacimiento. Pide además agendar.
  const fresh = (phone: string | null) =>
    JSON.stringify({
      ...registrationBody("Pedro Ríos", { givenNames: "Pedro", paternalSurname: "Ríos", ...(phone ? { phone } : {}) }),
      scope: "essentials",
    })
  const postFresh = (role: string, phone: string | null) =>
    buildApp(role).request("/patients", { method: "POST", headers: { "content-type": "application/json" }, body: fresh(phone) })
  expect((await postFresh("dentist", "+51987111222")).status).toBe(403)
  expect((await postFresh("reception", null)).status).toBe(400)
  const agenda = await postFresh("reception", "+51987111222")
  expect(agenda.status).toBe(201)
  const agendaId = ((await agenda.json()) as { data: { id: string } }).data.id
  const agendaDetail = (await (await buildApp("reception").request(`/patients/${agendaId}`, { method: "GET" })).json()) as {
    data: { patient: { birthDate: string | null; identityNeedsReview: boolean } }
  }
  expect(agendaDetail.data.patient).toMatchObject({ birthDate: null, identityNeedsReview: true })
  // Las demás pruebas registran sin configuración publicada (alta rápida).
  await ownerDb.execute(sql`delete from patient_registration_config where organization_id = 'org_a'`)
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
  // Presupuestos tienen permiso propio: el odontólogo lee los de su plan.
  for (const role of ["reception", "dentist"]) {
    expect((await get(role, "/account")).status).toBe(403)
    const charge = await buildApp(role).request(`/patients/${patientId}/charges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "Cargo", amountCents: 1000, currency: "PEN" }),
    })
    expect(charge.status).toBe(403)
  }
  // Recepción lee el presupuesto como documento de la persona (decisión 4).
  expect((await get("reception", "/budgets")).status).toBe(200)
  expect((await get("dentist", "/budgets")).status).toBe(200)
  // «Qué sigue» del Plan: lo pide quien ve alguna parte del plan; quien solo
  // tiene tareas, no.
  expect((await get("reception", "/next-step")).status).toBe(200)
  expect((await get("cashier", "/next-step")).status).toBe(200)
  expect((await get("member", "/next-step")).status).toBe(403)
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
  // Cada lectura clínica atendida deja traza; la lee solo quien audita. Todos
  // los roles de prueba comparten usuario: se compara el contador de la franja.
  const readLog = async () => {
    const log = await buildApp("admin").request(`/patients/${patientId}/access-log`, {
      method: "GET",
    })
    expect(log.status).toBe(200)
    return ((await log.json()) as { data: { resource: string; hits: number }[] }).data
  }
  const hitsOf = (entries: { resource: string; hits: number }[], resource: string) =>
    entries.find((entry) => entry.resource === resource)?.hits ?? 0
  // Abrir la página de la persona pide la ficha administrativa: no es una
  // lectura clínica y no deja traza (ADR 0029). Lo clínico de la ficha
  // (condiciones, medicación, salud declarada) se pide con `?clinical=1`
  // desde Clínica o la atención, y esa lectura sí la deja.
  const before = hitsOf(await readLog(), "antecedentes")
  expect((await get("dentist", "")).status).toBe(200)
  expect(hitsOf(await readLog(), "antecedentes")).toBe(before)
  expect((await get("dentist", "?clinical=1")).status).toBe(200)
  const afterDentist = hitsOf(await readLog(), "antecedentes")
  expect(afterDentist).toBe(before + 1)
  expect((await get("reception", "")).status).toBe(200)
  const entries = await readLog()
  expect(hitsOf(entries, "antecedentes")).toBe(afterDentist)
  expect(entries.map((entry) => entry.resource).sort()).toEqual([
    "antecedentes",
    "controles",
    "recetas",
  ])
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
    body: JSON.stringify({ note: "Se indica endodoncia" }),
  })
  expect(res.status).toBe(201)
  // El diagnóstico se registra en la atención, no en una nota suelta.
  const coded = await admin.request(`/patients/${patientId}/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ note: "Se indica endodoncia", diagnosisCode: "K04.0" }),
  })
  expect(coded.status).toBe(400)
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
  // Del registro le llega lo administrativo, nunca la salud declarada.
  const receptionRegistration = receptionBody.data.registration as { entryPoint: string; answers: Record<string, unknown> } | null
  expect(receptionRegistration?.entryPoint).toBeTruthy()
  expect(receptionRegistration?.answers).not.toHaveProperty("health")
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

/** Atención en borrador de la persona del archivo, llevada por quien llama («u-1»). */
async function openDraft(app: Hono): Promise<string> {
  await ownerDb.execute(
    sql`insert into "member" ("id", "organization_id", "user_id", "role", "created_at")
        values ('m-u-1', 'org_a', 'u-1', 'admin', now()) on conflict do nothing`,
  )
  const res = await app.request(`/patients/${patientId}/encounters`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "Control" }),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { data: { id: string } }).data.id
}

it("odontograma: solo dentro de una atención; buccal en anterior 400; facial 201; void exige motivo", async () => {
  const app = buildApp("admin")
  const post = (body: unknown) =>
    app.request(`/patients/${patientId}/odontogram/entries`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  // Sin atención no se registra: desde la ficha el odontograma se consulta.
  const outside = await post({ toothNumber: 11, condition: "caries", surfaces: ["facial"] })
  expect(outside.status).toBe(400)
  const encounterId = await openDraft(app)
  expect((await post({ toothNumber: 99, condition: "caries", surfaces: [], encounterId })).status).toBe(400)
  expect(
    (await post({ toothNumber: 11, condition: "caries", surfaces: ["buccal"], encounterId })).status,
  ).toBe(400)
  const created = await post({
    toothNumber: 11,
    condition: "caries",
    surfaces: ["facial"],
    details: { variant: "enamel" },
    encounterId,
  })
  expect(created.status).toBe(201)
  const { data } = (await created.json()) as { data: { id: string }[] }
  const entryId = data[0]!.id
  // La hoja neutra lista lo vigente por pieza.
  const sheet = await app.request(`/patients/${patientId}/odontogram/print`)
  expect(sheet.status).toBe(200)
  const sheetBody = (await sheet.json()) as { data: { entries: Array<{ id: string }> } }
  expect(sheetBody.data.entries.map((entry) => entry.id)).toContain(entryId)
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
  // La atención de prueba se anula: las siguientes no tienen una en curso.
  const closed = await app.request(`/patients/${patientId}/encounters/${encounterId}/void`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "Atención de prueba" }),
  })
  expect(closed.status).toBe(200)
})

it("odontograma firmado: solo en clínicas de Perú, con el perfil, sin trazo ni firmante escrito", async () => {
  const app = buildApp("admin")
  const post = (body: unknown) =>
    app.request(`/patients/${patientId}/odontogram/assessments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  // El trazo y el firmante no se escriben: un cuerpo que los trae se rechaza.
  expect((await post({ purpose: "personal", signature: [[[5, 90], [20, 70]]] })).status).toBe(400)
  expect(
    (await post({ purpose: "personal", examinerName: "Otra persona", registrationNumber: "COP 1" }))
      .status,
  ).toBe(400)
  // En un país sin odontograma firmado no se firma.
  await ownerDb.execute(sql`update "org_profile" set "country_code" = 'CO' where "organization_id" = 'org_a'`)
  try {
    const abroad = await post({ purpose: "personal" })
    expect(abroad.status).toBe(409)
    expect(await abroad.json()).toMatchObject({ error: { code: "SIGNED_ODONTOGRAM_UNAVAILABLE" } })
  } finally {
    await ownerDb.execute(sql`update "org_profile" set "country_code" = 'PE' where "organization_id" = 'org_a'`)
  }
  try {
    await ownerDb.execute(
      sql`insert into "member" ("id", "organization_id", "user_id", "role", "created_at")
          values ('m-u-1', 'org_a', 'u-1', 'admin', now()) on conflict do nothing`,
    )
    // Sin perfil con colegiatura no se firma.
    const unsigned = await post({ purpose: "personal" })
    expect(unsigned.status).toBe(409)
    expect(await unsigned.json()).toMatchObject({ error: { code: "PROFILE_INCOMPLETE" } })
    await ownerDb.execute(
      sql`insert into "professional_profile" ("organization_id", "user_id", "signature_name", "professional_title", "registration_body", "registration_number")
          values ('org_a', 'u-1', 'Doctora Perfil', 'Cirujano dentista', 'COP', '4321')`,
    )
    // El inicio, los nuevos hallazgos y la culminación los firma el cierre de la atención.
    expect((await post({ purpose: "initial" })).status).toBe(400)
    const sealed = await post({ purpose: "personal", observations: "Copia para su seguro" })
    expect(sealed.status).toBe(201)
    const sealedBody = (await sealed.json()) as {
      data: { id: string; patientName: string; patientNumber: number; encounterId: string | null }
    }
    expect(sealedBody.data).toMatchObject({
      examinerName: "Doctora Perfil",
      examinerTitle: "Cirujano dentista",
      registrationNumber: "COP 4321",
      standard: "NTS 188-MINSA/DGIESP-2022",
      encounterId: null,
      patientName: "María Pérez",
      patientNumber: 1,
    })
    const listed = await app.request(`/patients/${patientId}/odontogram/assessments`)
    expect(listed.status).toBe(200)
    expect(((await listed.json()) as { data: unknown[] }).data).toHaveLength(1)
    const sheet = await app.request(
      `/patients/${patientId}/odontogram/assessments/${sealedBody.data.id}/print`,
    )
    expect(sheet.status).toBe(200)
    expect(await sheet.json()).toMatchObject({ data: { assessment: { id: sealedBody.data.id } } })
  } finally {
    await ownerDb.execute(sql`update "org_profile" set "country_code" = 'PE' where "organization_id" = 'org_a'`)
  }
})

it("atención en curso: solo cuál es y quién la lleva, para quien atiende y sin traza", async () => {
  const path = `/patients/${patientId}/open-encounter`
  expect((await buildApp("reception").request(path)).status).toBe(403)
  expect((await buildApp("cashier").request(path)).status).toBe(403)
  const dentist = buildApp("dentist")
  const none = await dentist.request(path)
  expect(none.status).toBe(200)
  expect(await none.json()).toEqual({ data: null })
  const created = await dentist.request(`/patients/${patientId}/encounters`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "Dolor" }),
  })
  expect(created.status).toBe(201)
  const draft = ((await created.json()) as { data: { id: string } }).data
  const log = async () =>
    (
      (await (await buildApp("admin").request(`/patients/${patientId}/access-log`)).json()) as {
        data: { resource: string; hits: number }[]
      }
    ).data.reduce((sum, entry) => sum + entry.hits, 0)
  const before = await log()
  const open = await dentist.request(path)
  expect(open.status).toBe(200)
  expect(await open.json()).toEqual({ data: { id: draft.id, dentistUserId: "u-1" } })
  // No es una lectura de la historia: no deja traza en la bitácora.
  expect(await log()).toBe(before)
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
  // Un pasaporte exige el país que lo emitió (ISO 3166-1).
  expect(passport.status).toBe(400)
  const withCountry = await app.request(`/patients/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ docType: "PASAPORTE", docNumber: "AB123456", docCountry: "VE" }),
  })
  expect(withCountry.status).toBe(200)
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

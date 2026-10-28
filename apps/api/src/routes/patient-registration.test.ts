process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import type { Auth } from "@odentia/auth"
import { DEFAULT_REGISTRATION_CONFIG } from "@odentia/clinical"
import { createAppDb, createOwnerDb, type Db, withOrgContext } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { contact, contactIdentity, conversation } from "@odentia/db/schema/crm"
import { patient, patientContact, patientDataConsent, patientRegistration } from "@odentia/db/schema/clinical"
import {
  createConnection,
  createContact,
  createPatient,
  secretsKeyFromEnv,
  type Storage,
} from "@odentia/services"
import { and, eq, sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type { Hono } from "hono"
import { afterAll, beforeAll, expect, it } from "vitest"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { createApp } from "../app.js"

/**
 * (`createApp`), nunca contra un subrouter con guards simulados.
 *
 * Cubre: público anónimo (éxito genérico y contextual), 401 en privado sin
 * sesión, 404 uniforme sin filtraciones, anti-spoofing de tenant, body-limit,
 * rate-limit por instancia/dirección (sin confiar en X-Forwarded-For),
 * permisos member frente a owner/admin, envelope interno y CAS de config.
 * Cada escritura pública verificada deja estado real: snapshot sin revisor,
 * sin crear cuentas ni contactos automáticos.
 */

const IMAGE = "dentalagent-postgres:18.6"
const KEY = secretsKeyFromEnv("ee".repeat(32))

const ORG_A = "org_reg_a"
const SLUG_A = "sonrisa"
const ORG_B = "org_reg_b"
const SLUG_B = "norte"
const PRIVACY =
  "Aviso de demostración: tus datos se usan solo para tu atención clínica."

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db

type SessionWho = "owner" | "member" | "reception" | "other"
const SESSIONS: Record<SessionWho, { userId: string; activeOrg: string }> = {
  owner: { userId: "u-reg-owner", activeOrg: ORG_A },
  member: { userId: "u-reg-member", activeOrg: ORG_A },
  reception: { userId: "u-reg-reception", activeOrg: ORG_A },
  other: { userId: "u-reg-other", activeOrg: ORG_B },
}

// Solo se simula la búsqueda de sesión; los guards reales (requireSession +
// requireOrgContext con membresía de DB) siguen en el camino del request.
const authStub = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const who = headers.get("x-test-session") as SessionWho | null
      if (!who || !(who in SESSIONS)) return null
      const found = SESSIONS[who]!
      return {
        user: { id: found.userId, image: null },
        session: { activeOrganizationId: found.activeOrg },
      }
    },
  },
} as unknown as Auth

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
  putPatientAvatar: async () => {
    throw new Error("no usado")
  },
} as unknown as Storage

// Cada instancia de la app real aísla sus buckets de rate-limit; una
// dirección distinta por grupo aísla los contadores entre pruebas.
function buildApp(remoteAddress: string, webURL = "https://app.odentia.localhost"): Hono {
  return createApp({
    auth: authStub,
    db: appDb,
    ownerDb,
    secretsKey: KEY,
    storage: storageStub,
    validateExternal: false,
    webhookBaseUrl: "https://api.example.com",
    trustedOrigins: [],
    cookieDomain: "odentia.localhost",
    webURL,
    adminURL: "https://admin.odentia.localhost",
    mailer: { send: async () => { throw new Error("Correo no esperado en este recorrido") } },
    listenUrl: "postgres://localhost:5432/dentalagent",
    registrationRemoteAddress: () => remoteAddress,
  })
}

function authed(who: SessionWho, slug: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-test-session": who,
    "x-odentia-org": slug,
  }
}

let seq = 0
function adultQrAnswers(displayName?: string) {
  seq += 1
  return {
    demographics: {
      displayName: displayName ?? `Paciente QR ${seq}`,
      birthDate: "1990-04-11",
      phone: `+5199900${String(100 + seq)}`,
    },
    respondent: "patient",
    health: {
      allergies: {
        state: "recorded",
        items: [{ substance: "Penicilina", severity: "severa" }],
      },
      conditions: { state: "none", items: [] },
      medications: { state: "none", items: [] },
    },
    privacyAccepted: true,
  }
}

let configVersion = 0
let publishedVersion = 0

async function publish(app: Hono, enabled: boolean) {
  const res = await app.request("/api/patient-registration/config", {
    method: "PUT",
    headers: authed("owner", SLUG_A),
    body: JSON.stringify({
      enabled,
      fields: DEFAULT_REGISTRATION_CONFIG.fields,
      privacyNotice: PRIVACY,
      expectedVersion: configVersion,
    }),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { data: { version: number; enabled: boolean } }
  expect(body.data.enabled).toBe(enabled)
  configVersion = body.data.version
  if (enabled) publishedVersion = body.data.version
  return body.data
}

function qrBody(answers: unknown, overrides: Record<string, unknown> = {}) {
  return {
    submissionId: crypto.randomUUID(),
    formVersion: publishedVersion,
    entryPoint: "qr",
    answers,
    ...overrides,
  }
}

function publicPost(app: Hono, slug: string, body: unknown, extraHeaders: Record<string, string> = {}) {
  return app.request(`/api/public/patient-registration/${slug}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  })
}

const countUsers = async () =>
  (await ownerDb.select({ id: user.id }).from(user)).length
const countContacts = async (orgId: string) =>
  (
    await ownerDb
      .select({ id: contact.id })
      .from(contact)
      .where(eq(contact.organizationId, orgId))
  ).length
const countPatients = async (orgId: string) =>
  (
    await ownerDb
      .select({ id: patient.id })
      .from(patient)
      .where(eq(patient.organizationId, orgId))
  ).length

let sharedContactId = ""
let sharedConversationId = ""
let qrPatientSubmission = ""

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
    sql`insert into "organization" ("id", "name", "slug", "created_at") values (${ORG_A}, 'Clínica Sonrisa', ${SLUG_A}, now())`,
  )
  await ownerDb.execute(
    sql`insert into "organization" ("id", "name", "slug", "created_at") values (${ORG_B}, 'Clínica Norte', ${SLUG_B}, now())`,
  )
  // Clínicas de Perú: el DNI es uno de sus documentos (ADR 0036). Sin país, el núcleo no lo ofrece.
  await ownerDb.execute(
    sql`insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale")
        values (${ORG_A}, 'Clínica Sonrisa', 'PE', 'PEN', 'America/Lima', 'es-PE'), (${ORG_B}, 'Clínica Norte', 'PE', 'PEN', 'America/Lima', 'es-PE')
        on conflict do nothing`,
  )
  await ownerDb.execute(
    sql`insert into "user" ("id", "name", "email") values ('u-reg-owner', 'Dueña', 'owner-reg@test.dev'), ('u-reg-member', 'Miembro', 'member-reg@test.dev'), ('u-reg-reception', 'Recepción', 'reception-reg@test.dev'), ('u-reg-other', 'Otra', 'other-reg@test.dev') on conflict do nothing`,
  )
  await ownerDb.execute(
    sql`insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values ('m-reg-owner', ${ORG_A}, 'u-reg-owner', 'owner', now()), ('m-reg-member', ${ORG_A}, 'u-reg-member', 'member', now()), ('m-reg-reception', ${ORG_A}, 'u-reg-reception', 'reception', now()), ('m-reg-other', ${ORG_B}, 'u-reg-other', 'owner', now()) on conflict do nothing`,
  )
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

it("configuración: publicar el formulario versiona desde cero", async () => {
  const app = buildApp("cfg-publish")
  const data = await publish(app, true)
  expect(data.version).toBe(1)
})

it("público anónimo: GET genérico expone solo catálogo y marca", async () => {
  const app = buildApp("pub-get")
  const res = await app.request(`/api/public/patient-registration/${SLUG_A}`)
  expect(res.status).toBe(200)
  expect(res.headers.get("cache-control")).toContain("no-store")
  const body = (await res.json()) as {
    data: {
      organization: { name: string; logo: unknown }
      config: { enabled: boolean; version: number }
      today: string
      context: { kind: string }
    }
  }
  expect(body.data.organization.name).toBe("Clínica Sonrisa")
  expect(body.data.context).toEqual({ kind: "generic" })
  expect(body.data.config.enabled).toBe(true)
  expect(body.data.today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  const raw = JSON.stringify(body)
  expect(raw).not.toContain("contactId")
  expect(raw).not.toContain("patientId")
  expect(raw).not.toContain("token")
  expect(raw).not.toContain("u-reg-")
})

it("privado sin sesión: el router real responde 401", async () => {
  const app = buildApp("priv-401")
  expect((await app.request("/api/patients")).status).toBe(401)
  expect(
    (
      await app.request("/api/patients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ submissionId: crypto.randomUUID(), answers: {} }),
      })
    ).status,
  ).toBe(401)
  expect((await app.request("/api/patient-registration/config")).status).toBe(401)
  const body = await (await app.request("/api/patients")).json() as {
    error: { code: string }
  }
  expect(body.error.code).toBe("UNAUTHORIZED")
})

it("interno: el envelope crea la ficha con snapshot platform/staff", async () => {
  const app = buildApp("internal-envelope")
  const created = await app.request("/api/patients", {
    method: "POST",
    headers: authed("owner", SLUG_A),
    body: JSON.stringify({
      submissionId: crypto.randomUUID(),
      answers: {
        demographics: { displayName: "Paciente Interno", birthDate: "1990-01-01", phone: "+51977550001" },
        respondent: "staff",
        privacyAccepted: false,
      },
    }),
  })
  expect(created.status).toBe(201)
  const createdBody = (await created.json()) as { data: { id: string } }
  expect(typeof createdBody.data.id).toBe("string")

  const detail = await app.request(`/api/patients/${createdBody.data.id}`, {
    headers: authed("owner", SLUG_A),
  })
  expect(detail.status).toBe(200)
  const detailBody = (await detail.json()) as {
    data: {
      patient: { displayName: string }
      contacts: unknown[]
      registration: { entryPoint: string; respondent: string } | null
    }
  }
  expect(detailBody.data.patient.displayName).toBe("Paciente Interno")
  // Todo paciente es una persona: el alta interna crea la suya.
  expect(detailBody.data.contacts).toEqual([
    expect.objectContaining({ relationship: "self", displayName: "Paciente Interno" }),
  ])
  expect(detailBody.data.registration).toMatchObject({
    entryPoint: "platform",
    respondent: "staff",
  })
})

it("configuración: CAS rechaza versión obsoleta y acepta la vigente", async () => {
  const app = buildApp("cfg-cas")
  const stale = await app.request("/api/patient-registration/config", {
    method: "PUT",
    headers: authed("owner", SLUG_A),
    body: JSON.stringify({
      enabled: true,
      fields: DEFAULT_REGISTRATION_CONFIG.fields,
      privacyNotice: PRIVACY,
      expectedVersion: 0,
    }),
  })
  expect(stale.status).toBe(409)
  expect(((await stale.json()) as { error: { code: string } }).error.code).toBe(
    "STALE_REGISTRATION_CONFIG",
  )
  const before = configVersion
  await publish(app, true)
  expect(configVersion).toBe(before + 1)
})

it("QR público: crea paciente real sin cuenta, sin contacto y sin revisión", async () => {
  const app = buildApp("qr-write")
  const usersBefore = await countUsers()
  const contactsBefore = await countContacts(ORG_A)
  const answers = adultQrAnswers()
  const submissionId = crypto.randomUUID()
  qrPatientSubmission = submissionId

  const res = await publicPost(app, SLUG_A, {
    submissionId,
    formVersion: publishedVersion,
    entryPoint: "qr",
    answers,
  })
  expect(res.status).toBe(201)
  const body = (await res.json()) as { data: { registered: boolean } }
  expect(body).toEqual({ data: { registered: true } })

  const snapshots = await ownerDb
    .select()
    .from(patientRegistration)
    .where(eq(patientRegistration.submissionId, submissionId))
  expect(snapshots).toHaveLength(1)
  expect(snapshots[0]).toMatchObject({
    entryPoint: "qr",
    respondent: "patient",
    actorUserId: null,
    linkId: null,
  })

  const [row] = await ownerDb
    .select()
    .from(patient)
    .where(
      and(
        eq(patient.organizationId, ORG_A),
        eq(patient.id, snapshots[0]!.patientId),
      ),
    )
  expect(row!.healthReviewedAt).toBeNull()
  expect(row!.healthReviewedBy).toBeNull()
  // La declaración persiste (revisión 1) sin marcar revisión profesional.
  expect(row!.healthRevision).toBe(1)
  // El consentimiento queda como fila de «Datos y consentimiento», por versión
  // del aviso, sin autor del equipo: lo dio la persona en el formulario.
  const consents = await ownerDb
    .select()
    .from(patientDataConsent)
    .where(eq(patientDataConsent.patientId, snapshots[0]!.patientId))
  expect(consents).toHaveLength(1)
  expect(consents[0]).toMatchObject({
    organizationId: ORG_A,
    channel: "formulario_publico",
    recordedBy: null,
    revokedAt: null,
  })
  expect(consents[0]!.purposes).toContain("atencion")

  const links = await ownerDb
    .select()
    .from(patientContact)
    .where(
      and(
        eq(patientContact.organizationId, ORG_A),
        eq(patientContact.patientId, snapshots[0]!.patientId),
      ),
    )
  // El registro público no reclama contactos existentes ni crea usuarios: solo
  // nace la persona del propio paciente.
  expect(links).toEqual([expect.objectContaining({ relationship: "self" })])
  expect(await countUsers()).toBe(usersBefore)
  expect(await countContacts(ORG_A)).toBe(contactsBefore + 1)

  const detail = await app.request(`/api/patients/${snapshots[0]!.patientId}`, {
    headers: authed("owner", SLUG_A),
  })
  expect(detail.status).toBe(200)
  expect(JSON.stringify(await detail.json())).toContain("Penicilina")
})

it("menor sin responsable: 400 sin escrituras", async () => {
  const app = buildApp("minor-400")
  const patientsBefore = await countPatients(ORG_A)
  const answers = {
    ...adultQrAnswers("Menor Sin Responsable"),
    demographics: {
      displayName: "Menor Sin Responsable",
      birthDate: "2020-06-01",
      phone: "+51999777111",
    },
  }
  const res = await publicPost(app, SLUG_A, qrBody(answers))
  expect(res.status).toBe(400)
  expect(await countPatients(ORG_A)).toBe(patientsBefore)
})

it("documento duplicado público: se responde como un registro recibido, sin filtrar la ficha, y queda para recepción", async () => {
  const app = buildApp("dup-doc")
  const patientsBefore = await countPatients(ORG_A)
  const demographics = {
    displayName: "Paciente Duplicada",
    birthDate: "1985-09-09",
    phone: "+51999777222",
    docType: "DNI",
    docNumber: "87654321",
  }
  const first = await publicPost(
    app,
    SLUG_A,
    qrBody({ ...adultQrAnswers(), demographics }),
  )
  expect(first.status).toBe(201)
  expect(await countPatients(ORG_A)).toBe(patientsBefore + 1)

  const second = await publicPost(
    app,
    SLUG_A,
    qrBody({ ...adultQrAnswers("Otra Persona"), demographics }),
  )
  // La misma respuesta que un registro recibido: quien se registra no sabe que ese documento ya estaba.
  expect(second.status).toBe(201)
  const body = await second.json()
  expect(body).toEqual({ data: { registered: true } })
  const raw = JSON.stringify(body)
  expect(raw).not.toContain("Paciente Duplicada")
  expect(raw).not.toContain("87654321")
  expect(raw).not.toContain(qrPatientSubmission)
  expect(await countPatients(ORG_A)).toBe(patientsBefore + 1)
  // Lo que no se completó queda para recepción con todo lo que escribió, aunque el alta se revirtió entera.
  const held = await ownerDb.execute<{ title: string; reason: string; area: string; answers: { demographics: { displayName: string } } | null }>(sql`
    select t.title, t.reason, t.area, h.answers from task t join contact c on c.id = t.contact_id and c.organization_id = t.organization_id
    left join registration_hold h on h.organization_id = t.organization_id and h.task_id = t.id
    where t.organization_id = ${ORG_A} and c.doc_number = '87654321' and t.kind = 'registro_con_documento' and t.status = 'open'`)
  expect([...held]).toEqual([
    expect.objectContaining({
      area: "recepcion",
      title: "Se registró por el código QR: ¿es Paciente Duplicada?",
      reason: expect.stringContaining("No se creó a nadie: elige si es la misma persona."),
      answers: expect.objectContaining({ demographics: expect.objectContaining({ displayName: "Paciente Duplicada" }) }),
    }),
  ])
})

it.each(["https://app.odentia.localhost", "https://app.odentia.localhost:4463"])("enlace contextual (%s): crea, resuelve, vincula y se consume una sola vez", async (webURL) => {
  const app = buildApp("link-flow", webURL)
  const person = await withOrgContext(appDb, ORG_A, (tx) =>
    createContact(tx, ORG_A, { displayName: "Titular Conversación" }, { userId: "u-reg-owner" }),
  )
  // Una clínica tiene un solo WhatsApp activo y este caso corre dos veces sobre la misma.
  await ownerDb.execute(
    sql`update channel_connection set status = 'disabled' where organization_id = ${ORG_A} and channel = 'whatsapp' and status = 'active'`,
  )
  const conn = await withOrgContext(appDb, ORG_A, (tx) =>
    createConnection(
      tx,
      ORG_A,
      KEY,
      {
        channel: "whatsapp",
        provider: "whatsapp_cloud_api",
        displayName: "WA",
        config: {
          phoneNumberId: "P",
          wabaId: "W",
          accessToken: "T",
          appSecret: "S",
          templates: [],
        },
      },
      { fetch, validateExternal: false },
    ),
  )
  const externalId = `wa:${crypto.randomUUID()}`
  const [identity] = await ownerDb.insert(contactIdentity).values({ organizationId: ORG_A, contactId: person.id, channel: "whatsapp", externalUserId: externalId }).returning()
  const [thread] = await ownerDb
    .insert(conversation)
    .values({
      organizationId: ORG_A,
      contactId: person.id,
      channelConnectionId: conn.id,
      externalThreadId: externalId,
      contactIdentityId: identity!.id,
    })
    .returning({ id: conversation.id })
  sharedContactId = person.id
  sharedConversationId = thread!.id

  const created = await app.request(`/api/contacts/${person.id}/registration-links`, {
    method: "POST",
    headers: authed("owner", SLUG_A),
    body: JSON.stringify({ conversationId: thread!.id }),
  })
  expect(created.status).toBe(201)
  const createdBody = (await created.json()) as { data: { url: string; expiresAt: string } }
  const linkUrl = new URL(createdBody.data.url)
  const expectedOrigin = new URL(webURL)
  expectedOrigin.hostname = `${SLUG_A}.odentia.localhost`
  expect(linkUrl.origin).toBe(expectedOrigin.origin)
  expect(linkUrl.pathname).toBe("/registro")
  const token = linkUrl.searchParams.get("token")!
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)

  const resolved = await app.request(
    `/api/public/patient-registration/${SLUG_A}?token=${token}`,
  )
  expect(resolved.status).toBe(200)
  expect(((await resolved.json()) as { data: { context: unknown } }).data.context).toEqual({
    kind: "conversation",
    ownRecord: false,
  })

  const answers = {
    demographics: {
      displayName: "Hermana Registro",
      birthDate: "1988-02-20",
      phone: "+51999888777",
    },
    respondent: "representative",
    representative: {
      displayName: "Titular Conversación",
      relationship: "family",
      relationshipDetail: "Hermana",
      phone: "+51999111222",
    },
    health: {
      allergies: { state: "none", items: [] },
      conditions: { state: "none", items: [] },
      medications: { state: "none", items: [] },
    },
    privacyAccepted: true,
  }
  const submissionId = crypto.randomUUID()
  const registered = await publicPost(app, SLUG_A, {
    submissionId,
    formVersion: publishedVersion,
    entryPoint: "public_link",
    token,
    answers,
  })
  expect(registered.status).toBe(201)
  const patientsAfterFirst = await countPatients(ORG_A)

  const snapshots = await ownerDb
    .select()
    .from(patientRegistration)
    .where(eq(patientRegistration.submissionId, submissionId))
  expect(snapshots).toHaveLength(1)
  expect(snapshots[0]).toMatchObject({ entryPoint: "conversation", respondent: "representative" })

  const detail = await app.request(`/api/patients/${snapshots[0]!.patientId}`, {
    headers: authed("owner", SLUG_A),
  })
  expect(detail.status).toBe(200)
  const detailBody = (await detail.json()) as {
    data: { contacts: { contactId: string; relationship: string; isPreferred: boolean }[] }
  }
  expect(detailBody.data.contacts).toHaveLength(2)
  expect(detailBody.data.contacts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        contactId: person.id,
        relationship: "family",
        isPreferred: true,
      }),
      expect.objectContaining({ relationship: "self", isPreferred: false }),
    ]),
  )

  // Reintento idéntico: éxito sin duplicar la ficha.
  const retry = await publicPost(app, SLUG_A, {
    submissionId,
    formVersion: publishedVersion,
    entryPoint: "public_link",
    token,
    answers,
  })
  expect(retry.status).toBe(201)
  expect(await countPatients(ORG_A)).toBe(patientsAfterFirst)

  // Enlace consumido: ya no resuelve.
  const gone = await app.request(
    `/api/public/patient-registration/${SLUG_A}?token=${token}`,
  )
  expect(gone.status).toBe(404)
})

it("enlace contextual de quien ya tiene su ficha: se emite para un familiar y registrarse a sí misma da 409 en palabras", async () => {
  const app = buildApp("link-own-record")
  const person = await withOrgContext(appDb, ORG_A, (tx) =>
    createContact(tx, ORG_A, { displayName: "Paciente Con Ficha" }, { userId: "u-reg-owner" }),
  )
  await withOrgContext(appDb, ORG_A, (tx) =>
    createPatient(tx, ORG_A, "u-reg-owner", {
      displayName: "Paciente Con Ficha",
      contacts: [{ contactId: person.id, relationship: "self", isPreferred: true }],
    }),
  )
  const conn = await withOrgContext(appDb, ORG_A, (tx) =>
    createConnection(
      tx,
      ORG_A,
      KEY,
      { channel: "telegram", provider: "telegram_bot_api", displayName: "Bot", config: { botToken: "T" } },
      { fetch, validateExternal: false },
    ),
  )
  const externalId = `tg:${crypto.randomUUID()}`
  const [identity] = await ownerDb.insert(contactIdentity).values({ organizationId: ORG_A, contactId: person.id, channel: "telegram", externalUserId: externalId }).returning()
  const [thread] = await ownerDb
    .insert(conversation)
    .values({
      organizationId: ORG_A,
      contactId: person.id,
      channelConnectionId: conn.id,
      externalThreadId: externalId,
      contactIdentityId: identity!.id,
    })
    .returning({ id: conversation.id })

  const created = await app.request(`/api/contacts/${person.id}/registration-links`, {
    method: "POST",
    headers: authed("reception", SLUG_A),
    body: JSON.stringify({ conversationId: thread!.id }),
  })
  expect(created.status).toBe(201)
  const token = new URL(((await created.json()) as { data: { url: string } }).data.url).searchParams.get("token")!
  const resolved = await app.request(`/api/public/patient-registration/${SLUG_A}?token=${token}`)
  expect(((await resolved.json()) as { data: { context: unknown } }).data.context).toEqual({
    kind: "conversation",
    ownRecord: true,
  })

  // Registrarse a sí misma con su enlace: 409 en palabras, sin otra ficha.
  const patientsBefore = await countPatients(ORG_A)
  const refused = await publicPost(app, SLUG_A, {
    submissionId: crypto.randomUUID(),
    formVersion: publishedVersion,
    entryPoint: "public_link",
    token,
    answers: adultQrAnswers("Segunda Ficha Propia"),
  })
  expect(refused.status).toBe(409)
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("ALREADY_REGISTERED")
  expect(await countPatients(ORG_A)).toBe(patientsBefore)
})

it("tokens: inválido, desconocido u otra organización responden 404 uniforme", async () => {
  const app = buildApp("token-404")
  const unknown = "A".repeat(43)
  const cases = [
    await app.request(`/api/public/patient-registration/${SLUG_A}?token=corto`),
    await app.request(`/api/public/patient-registration/${SLUG_A}?token=${unknown}`),
    await app.request(`/api/public/patient-registration/${SLUG_B}?token=${unknown}`),
    await app.request(`/api/public/patient-registration/inexistente`),
    await publicPost(app, SLUG_A, qrBody(adultQrAnswers(), { token: unknown })),
  ]
  for (const res of cases) {
    expect(res.status).toBe(404)
  }
  const bodies = (await Promise.all(
    cases.map((r) => r.json()),
  )) as { error: { code: string; message: string } }[]
  for (const body of bodies) {
    expect(body.error.code).toBe("NOT_FOUND")
    expect(body.error.message).toBe("Enlace no disponible")
  }
  const raw = bodies.map((b) => JSON.stringify(b)).join("")
  expect(raw).not.toContain("Titular Conversación")
  expect(raw).not.toContain(sharedContactId)
  expect(raw).not.toContain(unknown)
})

it("deshabilitar bloquea lo público sin borrar fichas", async () => {
  const app = buildApp("disable-flow")
  await publish(app, false)
  expect(
    (await app.request(`/api/public/patient-registration/${SLUG_A}`)).status,
  ).toBe(404)
  expect((await publicPost(app, SLUG_A, qrBody(adultQrAnswers()))).status).toBe(404)

  const snapshots = await ownerDb
    .select()
    .from(patientRegistration)
    .where(eq(patientRegistration.submissionId, qrPatientSubmission))
  expect(snapshots).toHaveLength(1)
  const still = await app.request(`/api/patients/${snapshots[0]!.patientId}`, {
    headers: authed("owner", SLUG_A),
  })
  expect(still.status).toBe(200)

  await publish(app, true)
})

it("el aviso de privacidad tiene su página mientras el registro está encendido; apagado o sin aviso, no (ADR 0101)", async () => {
  const app = buildApp("aviso")
  await publish(app, false)
  expect((await app.request(`/api/public/patient-registration/${SLUG_A}/aviso`)).status).toBe(404)
  await publish(app, true)
  const res = await app.request(`/api/public/patient-registration/${SLUG_A}/aviso`)
  expect(res.status).toBe(200)
  expect(res.headers.get("cache-control")).toContain("no-store")
  const body = (await res.json()) as { data: { notice: string; version: number; organization: { name: string } } }
  expect(body.data.notice).toBe(PRIVACY)
  expect(Object.keys(body.data).sort()).toEqual(["notice", "organization", "version"])
  expect((await app.request(`/api/public/patient-registration/${SLUG_B}/aviso`)).status).toBe(404)
  expect((await app.request(`/api/public/patient-registration/inexistente/aviso`)).status).toBe(404)
})

it("spoofing: contactos, pacientes y organización ajenos se rechazan", async () => {
  const app = buildApp("spoof")
  const contactB = await withOrgContext(appDb, ORG_B, (tx) =>
    createContact(tx, ORG_B, { displayName: "Contacto B" }, { userId: "u-reg-other" }),
  )
  const patientB = await withOrgContext(appDb, ORG_B, (tx) =>
    createPatient(tx, ORG_B, "u-reg-other", { displayName: "Paciente B" }),
  )

  const foreignLink = await app.request("/api/patients", {
    method: "POST",
    headers: authed("owner", SLUG_A),
    body: JSON.stringify({
      submissionId: crypto.randomUUID(),
      answers: {
        demographics: { displayName: "Paciente Espía", birthDate: "1990-01-01", phone: "+51977550002" },
        respondent: "staff",
        privacyAccepted: false,
      },
      contacts: [{ contactId: contactB.id, relationship: "family", isPreferred: false }],
    }),
  })
  expect(foreignLink.status).toBe(404)

  const foreignRead = await app.request(`/api/patients/${patientB.id}`, {
    headers: authed("owner", SLUG_A),
  })
  expect(foreignRead.status).toBe(404)

  const foreignRelation = await app.request(
    `/api/patients/${patientB.id}/contacts/${sharedContactId}`,
    {
      method: "PUT",
      headers: authed("owner", SLUG_A),
      body: JSON.stringify({ relationship: "family", isPreferred: false }),
    },
  )
  expect(foreignRelation.status).toBe(404)

  // Miembro real de A haciéndose pasar por B: sin membresía, 403.
  const wrongOrg = await app.request("/api/patients", {
    headers: authed("owner", SLUG_B),
  })
  expect(wrongOrg.status).toBe(403)
  expect(((await wrongOrg.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN")

  // Contacto contextual que no figura en los vínculos: 400.
  const contextSpoof = await app.request("/api/patients", {
    method: "POST",
    headers: authed("owner", SLUG_A),
    body: JSON.stringify({
      submissionId: crypto.randomUUID(),
      answers: {
        demographics: { displayName: "Paciente Contexto", birthDate: "1990-01-01", phone: "+51977550003" },
        respondent: "staff",
        privacyAccepted: false,
      },
      contacts: [],
      contextContactId: contactB.id,
    }),
  })
  expect(contextSpoof.status).toBe(400)
})

it("público: cuerpo mayor a 64 KiB responde 413", async () => {
  const app = buildApp("oversize")
  const answers = adultQrAnswers()
  const res = await publicPost(
    app,
    SLUG_A,
    qrBody({ ...answers, demographics: { ...answers.demographics, displayName: "x".repeat(70_000) } }),
  )
  expect(res.status).toBe(413)
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe("BODY_TOO_LARGE")
})

it("límite: 10 POST y 120 GET por 10 minutos, sin confiar en X-Forwarded-For", async () => {
  const app = buildApp("rate-post")
  for (let i = 0; i < 10; i++) {
    const res = await publicPost(
      app,
      SLUG_A,
      { submissionId: "no-es-uuid" },
      { "X-Forwarded-For": `10.0.0.${i}` },
    )
    expect(res.status).toBe(400)
  }
  const limited = await publicPost(
    app,
    SLUG_A,
    { submissionId: "no-es-uuid" },
    { "X-Forwarded-For": "99.99.99.99" },
  )
  expect(limited.status).toBe(429)
  expect(limited.headers.get("retry-after")).toBeTruthy()
  expect(((await limited.json()) as { error: { code: string } }).error.code).toBe(
    "RATE_LIMITED",
  )

  // Otra dirección remota conserva su propio presupuesto.
  const otherAddress = buildApp("rate-post-other")
  const fresh = await publicPost(otherAddress, SLUG_A, { submissionId: "no-es-uuid" })
  expect(fresh.status).toBe(400)

  const gets = buildApp("rate-get")
  for (let i = 0; i < 120; i++) {
    const res = await gets.request(`/api/public/patient-registration/inexistente`)
    expect(res.status).toBe(404)
  }
  const getLimited = await gets.request(`/api/public/patient-registration/inexistente`)
  expect(getLimited.status).toBe(429)
  expect(getLimited.headers.get("retry-after")).toBeTruthy()
})

it("recepción opera CRM y member queda en solo tareas (403 sin efectos)", async () => {
  const app = buildApp("member-perms")
  const edited = await app.request(`/api/contacts/${sharedContactId}`, {
    method: "PATCH",
    headers: authed("reception", SLUG_A),
    body: JSON.stringify({ displayName: "Titular Editado" }),
  })
  expect(edited.status).toBe(200)

  const created = await app.request("/api/contacts", {
    method: "POST",
    headers: authed("reception", SLUG_A),
    body: JSON.stringify({ displayName: "Contacto Recepción" }),
  })
  expect(created.status).toBe(201)

  const memberEdit = await app.request(`/api/contacts/${sharedContactId}`, {
    method: "PATCH",
    headers: authed("member", SLUG_A),
    body: JSON.stringify({ displayName: "Titular Miembro" }),
  })
  expect(memberEdit.status).toBe(403)

  const memberCreate = await app.request("/api/contacts", {
    method: "POST",
    headers: authed("member", SLUG_A),
    body: JSON.stringify({ displayName: "Contacto Miembro" }),
  })
  expect(memberCreate.status).toBe(403)

  const clinical = await app.request("/api/patients", {
    method: "POST",
    headers: authed("member", SLUG_A),
    body: JSON.stringify({
      submissionId: crypto.randomUUID(),
      answers: {
        demographics: { displayName: "Paciente Miembro", birthDate: "1990-01-01", phone: "+51977550004" },
        respondent: "staff",
        privacyAccepted: false,
      },
    }),
  })
  expect(clinical.status).toBe(403)

  const config = await app.request("/api/patient-registration/config", {
    method: "PUT",
    headers: authed("member", SLUG_A),
    body: JSON.stringify({
      enabled: true,
      fields: DEFAULT_REGISTRATION_CONFIG.fields,
      privacyNotice: PRIVACY,
      expectedVersion: configVersion,
    }),
  })
  expect(config.status).toBe(403)

  const receptionConfig = await app.request("/api/patient-registration/config", {
    method: "PUT",
    headers: authed("reception", SLUG_A),
    body: JSON.stringify({
      enabled: true,
      fields: DEFAULT_REGISTRATION_CONFIG.fields,
      privacyNotice: PRIVACY,
      expectedVersion: configVersion,
    }),
  })
  expect(receptionConfig.status).toBe(403)

  const receptionLink = await app.request(`/api/contacts/${sharedContactId}/registration-links`, {
    method: "POST",
    headers: authed("reception", SLUG_A),
    body: JSON.stringify({ conversationId: sharedConversationId }),
  })
  expect(receptionLink.status).toBe(201)

  const identity = await app.request(`/api/contacts/${sharedContactId}/identities`, {
    method: "POST",
    headers: authed("member", SLUG_A),
    body: JSON.stringify({ channel: "whatsapp", externalUserId: "+51999111222" }),
  })
  expect(identity.status).toBe(403)
  expect(((await identity.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN")

  const resolve = await app.request(`/api/conversations/${sharedConversationId}/identity`, {
    method: "PUT",
    headers: authed("member", SLUG_A),
    body: JSON.stringify({ identityId: crypto.randomUUID() }),
  })
  expect(resolve.status).toBe(403)
})

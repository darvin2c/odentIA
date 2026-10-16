import type { RegistrationAnswers } from "@odentia/clinical"
import { withOrgContext } from "@odentia/db"
import { contactIdentity, conversation } from "@odentia/db/schema/crm"
import { randomUUID } from "node:crypto"
import { expect, it } from "vitest"
import { getCaseBrief } from "./agent-case-brief.js"
import { getPatientHealth, savePatientHealth } from "./clinical.js"
import { createConnection } from "./connections.js"
import { createContact, getContact } from "./contacts.js"
import { listDataConsents } from "./data-consents.js"
import {
  createPatient,
  findPatientDuplicates,
  getPatient,
  listPatients,
  listPatientsByContact,
} from "./patients.js"
import {
  createPatientRegistrationLink,
  getPatientRegistrationConfig,
  getPublicPatientRegistration,
  registerPatient,
  savePatientRegistrationConfig,
  type RegistrationInput,
} from "./patient-registration.js"
import { listPersonNotes } from "./people.js"
import { listResponsibilities } from "./responsibilities.js"
import { secretsKeyFromEnv } from "./secrets.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"
import { and, eq, sql } from "drizzle-orm"
import { auditEvent } from "@odentia/db/schema/org"

setupTestDb()

const ACTOR = "u-registration"
const KEY = secretsKeyFromEnv("dd".repeat(32))
const NOTICE = "Aviso de demostración: tus datos se usan solo para tu atención."
const ADULT_BIRTH = "1990-05-01"
const MINOR_BIRTH = "2020-05-06"

async function seedActor(): Promise<void> {
  await ownerDb.execute(
    sql`insert into "user" ("id", "name", "email") values (${ACTOR}, 'Registro', 'registro@example.com')
        on conflict ("id") do nothing`,
  )
}

async function publish(orgId: string, enabled = true) {
  await seedActor()
  return withOrgContext(appDb, orgId, async (tx) => {
    const current = await getPatientRegistrationConfig(tx, orgId)
    return savePatientRegistrationConfig(tx, orgId, ACTOR, {
      expectedVersion: current.version,
      enabled,
      fields: current.fields,
      privacyNotice: NOTICE,
    })
  })
}

function emptyClinical(): NonNullable<RegistrationAnswers["health"]> {
  return {
    allergies: { state: "unanswered", items: [] },
    conditions: { state: "unanswered", items: [] },
    medications: { state: "unanswered", items: [] },
  }
}

function adultQrAnswers(displayName: string, phone: string): RegistrationAnswers {
  return {
    demographics: { displayName, birthDate: ADULT_BIRTH, phone },
    respondent: "patient",
    health: emptyClinical(),
    privacyAccepted: true,
  }
}

async function publishedVersion(orgId: string): Promise<number> {
  const config = await withOrgContext(appDb, orgId, (tx) =>
    getPatientRegistrationConfig(tx, orgId),
  )
  return config.version
}
async function makeThread(orgId: string, contactId: string) {
  const connectionId = await withOrgContext(appDb, orgId, (tx) =>
    createConnection(
      tx,
      orgId,
      KEY,
      { channel: "telegram", provider: "telegram_bot_api", displayName: "Bot", config: { botToken: "T" } },
      { fetch, validateExternal: false },
    ).then((c) => c.id),
  )
  return withOrgContext(appDb, orgId, async (tx) => {
    const externalId = `tg:${Date.now()}${Math.floor(Math.random() * 100000)}`
    const [identity] = await tx.insert(contactIdentity).values({ organizationId: orgId, contactId, channel: "telegram", externalUserId: externalId }).returning()
    const [row] = await tx
      .insert(conversation)
      .values({
        organizationId: orgId,
        contactId,
        channelConnectionId: connectionId,
        externalThreadId: externalId,
        contactIdentityId: identity!.id,
        lastInboundAt: new Date(),
      })
      .returning({ id: conversation.id })
    return row!.id
  })
}

async function makeContactWithConversation(orgId: string, name: string) {
  const person = await withOrgContext(appDb, orgId, (tx) =>
    createContact(tx, orgId, { displayName: name, phone: "+51977000100" }),
  )
  const threadId = await makeThread(orgId, person.id)
  return { person, threadId }
}

async function makeLink(orgId: string, contactId: string, threadId: string) {
  return withOrgContext(appDb, orgId, (tx) =>
    createPatientRegistrationLink(tx, orgId, ACTOR, { contactId, conversationId: threadId }),
  )
}

it("config ausente es versión 0; publicar exige aviso y un medio; versión obsoleta da 409", async () => {
  await seedActor()
  const initial = await withOrgContext(appDb, "org_a", (tx) =>
    getPatientRegistrationConfig(tx, "org_a"),
  )
  expect(initial.version).toBe(0)
  expect(initial.enabled).toBe(false)

  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      savePatientRegistrationConfig(tx, "org_a", ACTOR, {
        expectedVersion: 0,
        enabled: true,
        fields: initial.fields,
        privacyNotice: "",
      }),
    ),
  ).rejects.toMatchObject({ status: 400 })

  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      savePatientRegistrationConfig(tx, "org_a", ACTOR, {
        expectedVersion: 0,
        enabled: false,
        fields: { ...initial.fields, phone: "optional", email: "optional" },
        privacyNotice: "",
      }),
    ),
  ).rejects.toMatchObject({ status: 400 })

  const published = await withOrgContext(appDb, "org_a", (tx) =>
    savePatientRegistrationConfig(tx, "org_a", ACTOR, {
      expectedVersion: 0,
      enabled: true,
      fields: initial.fields,
      privacyNotice: NOTICE,
    }),
  )
  expect(published.version).toBe(1)
  expect(published.enabled).toBe(true)

  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      savePatientRegistrationConfig(tx, "org_a", ACTOR, {
        expectedVersion: 0,
        enabled: true,
        fields: initial.fields,
        privacyNotice: NOTICE,
      }),
    ),
  ).rejects.toMatchObject({ code: "STALE_REGISTRATION_CONFIG", status: 409 })
})

it("QR adulto con penicilina y O+: ficha sin revisión, sin vínculo automático ni usuario", async () => {
  await seedActor()
  await publish("org_a")
  const qrVersion = await publishedVersion("org_a")
  const existing = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Vecino QR", phone: "+51977111222" }),
  )
  const answers: RegistrationAnswers = {
    demographics: { displayName: "Paciente QR Penicilina", birthDate: ADULT_BIRTH, phone: "+51977111222" },
    respondent: "patient",
    health: {
      bloodGroup: "O+",
      allergies: {
        state: "recorded",
        items: [{ substance: "Penicilina", reaction: "Sarpullido", severity: "moderada" }],
      },
      conditions: { state: "none", items: [] },
      medications: { state: "none", items: [] },
    },
    privacyAccepted: true,
  }
  const input: RegistrationInput = { submissionId: randomUUID(), formVersion: qrVersion, answers }
  const created = await withOrgContext(appDb, "org_a", (tx) =>
    registerPatient(tx, "org_a", { kind: "public", entryPoint: "qr" }, input),
  )
  expect(created.displayName).toBe("Paciente QR Penicilina")
  expect(created.isActive).toBe(true)

  const detail = await withOrgContext(appDb, "org_a", (tx) => getPatient(tx, "org_a", created.id))
  // Todo paciente es una persona, pero el teléfono coincidente no reclama al
  // contacto existente: su persona es nueva.
  expect(detail.contacts).toEqual([
    expect.objectContaining({ relationship: "self", displayName: "Paciente QR Penicilina" }),
  ])
  expect(detail.contacts[0]?.contactId).not.toBe(existing.id)
  expect(detail.registration).toMatchObject({ entryPoint: "qr", respondent: "patient", actor: null })
  expect(detail.registration?.answers.health).toMatchObject({
    bloodGroup: "O+",
    allergies: { state: "recorded" },
  })
  expect(detail.activeAllergies.map((a) => a.substance)).toContain("Penicilina")

  const health = await withOrgContext(appDb, "org_a", (tx) =>
    getPatientHealth(tx, "org_a", created.id),
  )
  expect(health.bloodGroup).toBe("O+")
  expect(health.reviewedAt).toBeNull()
  expect(health.reviewedBy).toBeNull()
  expect(health.revision).toBe(1)

  // El consentimiento queda en «Datos y consentimiento», por versión del aviso:
  // lo dio la persona en el formulario, sin nadie del equipo.
  const consents = await withOrgContext(appDb, "org_a", (tx) =>
    listDataConsents(tx, "org_a", created.id),
  )
  expect(consents).toEqual([
    expect.objectContaining({ noticeVersion: qrVersion, channel: "formulario_publico", recordedBy: null, revokedAt: null }),
  ])
  expect(consents[0]!.purposes).toContain("atencion")
  // El contacto preexistente sigue sin pacientes vinculados.
  const linked = await withOrgContext(appDb, "org_a", (tx) =>
    listPatientsByContact(tx, "org_a", existing.id),
  )
  expect(linked).toEqual([])
})

it("menor público sin responsable falla 400 sin escrituras", async () => {
  await publish("org_a")
  const minorVersion = await publishedVersion("org_a")
  const answers: RegistrationAnswers = {
    demographics: { displayName: "Menor Sin Responsable Único", birthDate: MINOR_BIRTH, phone: "+51977222333" },
    respondent: "patient",
    health: emptyClinical(),
    privacyAccepted: true,
  }
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      registerPatient(tx, "org_a", { kind: "public", entryPoint: "qr" }, { submissionId: randomUUID(), formVersion: minorVersion, answers }),
    ),
  ).rejects.toMatchObject({ status: 400 })
  const dupes = await withOrgContext(appDb, "org_a", (tx) =>
    findPatientDuplicates(tx, "org_a", { displayName: "Menor Sin Responsable Único", birthDate: MINOR_BIRTH }),
  )
  expect(dupes).toEqual([])
})

it("menor con enlace contextual queda como guardian sin modificar el contacto", async () => {
  await publish("org_a")
  const linkVersion = await publishedVersion("org_a")
  const { person, threadId } = await makeContactWithConversation("org_a", "Madre Enlace")
  const { token } = await makeLink("org_a", person.id, threadId)
  const answers: RegistrationAnswers = {
    demographics: { displayName: "Hijo Enlace Menor", birthDate: MINOR_BIRTH, phone: "+51977333444" },
    respondent: "representative",
    representative: {
      displayName: "Madre Enlace",
      relationship: "guardian",
      relationshipDetail: "Madre",
      phone: "+51977000100",
      docType: "DNI",
      docNumber: "41526374",
    },
    health: emptyClinical(),
    privacyAccepted: true,
  }
  const created = await withOrgContext(appDb, "org_a", (tx) =>
    registerPatient(tx, "org_a", { kind: "public", token, entryPoint: "public_link" }, { submissionId: randomUUID(), formVersion: linkVersion, answers }),
  )
  const detail = await withOrgContext(appDb, "org_a", (tx) => getPatient(tx, "org_a", created.id))
  // La tutora conserva su vínculo y preferencia; el menor recibe su propia persona.
  expect(detail.contacts).toHaveLength(2)
  expect(detail.contacts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ contactId: person.id, relationship: "guardian", isPreferred: true }),
      expect.objectContaining({ relationship: "self", isPreferred: false }),
    ]),
  )
  expect(detail.registration).toMatchObject({
    entryPoint: "conversation",
    respondent: "representative",
    contextContactId: person.id,
    conversationId: threadId,
  })
  // La tutora queda como representante legal vigente en la misma alta.
  const responsibilities = await withOrgContext(appDb, "org_a", (tx) =>
    listResponsibilities(tx, "org_a", created.id),
  )
  expect(responsibilities).toEqual([
    expect.objectContaining({ contactId: person.id, kind: "representante_legal", isCurrent: true }),
  ])
  // El contacto existente conserva sus datos: lo público no lo actualiza.
  const untouched = await withOrgContext(appDb, "org_a", (tx) => getContact(tx, "org_a", person.id))
  expect(untouched.contact.displayName).toBe("Madre Enlace")
  expect(untouched.contact.phone).toBe("+51977000100")
})

it("quien ya tiene su ficha recibe su enlace solo para registrar a otra persona; registrarse a sí misma se rechaza en palabras", async () => {
  await publish("org_a")
  const version = await publishedVersion("org_a")
  const { person, threadId } = await makeContactWithConversation("org_a", "Madre Con Ficha")
  await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, {
      displayName: "Madre Con Ficha",
      contacts: [{ contactId: person.id, relationship: "self", isPreferred: true }],
    }),
  )
  // El equipo puede enviárselo: es para un familiar.
  const { token } = await makeLink("org_a", person.id, threadId)
  const view = await withOrgContext(appDb, "org_a", (tx) => getPublicPatientRegistration(tx, "org_a", token))
  expect(view.context).toEqual({ kind: "conversation", ownRecord: true })

  // Para sí misma no: se le dice en palabras, sin otra ficha ni consumir el enlace.
  const patientsBefore = await withOrgContext(appDb, "org_a", (tx) => listPatientsByContact(tx, "org_a", person.id))
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      registerPatient(
        tx,
        "org_a",
        { kind: "public", token, entryPoint: "public_link" },
        { submissionId: randomUUID(), formVersion: version, answers: adultQrAnswers("Segunda Ficha Propia", "+51977333010") },
      ),
    ),
  ).rejects.toMatchObject({ code: "ALREADY_REGISTERED", status: 409 })
  expect(await withOrgContext(appDb, "org_a", (tx) => listPatientsByContact(tx, "org_a", person.id))).toHaveLength(
    patientsBefore.length,
  )

  // A su hijo sí, con ella como tutora.
  const child = await withOrgContext(appDb, "org_a", (tx) =>
    registerPatient(
      tx,
      "org_a",
      { kind: "public", token, entryPoint: "public_link" },
      {
        submissionId: randomUUID(),
        formVersion: version,
        answers: {
          demographics: { displayName: "Hijo De Madre Con Ficha", birthDate: MINOR_BIRTH, phone: "+51977333011" },
          respondent: "representative",
          representative: {
            displayName: "Madre Con Ficha",
            relationship: "guardian",
            relationshipDetail: "Madre",
            phone: "+51977000100",
            docType: "DNI",
            docNumber: "41526375",
          },
          health: emptyClinical(),
          privacyAccepted: true,
        },
      },
    ),
  )
  const detail = await withOrgContext(appDb, "org_a", (tx) => getPatient(tx, "org_a", child.id))
  expect(detail.contacts).toEqual(
    expect.arrayContaining([expect.objectContaining({ contactId: person.id, relationship: "guardian" })]),
  )

  // Sin ficha propia, el mismo enlace se abre para registrarse.
  const newcomer = await makeContactWithConversation("org_a", "Contacto Sin Ficha")
  const open = await makeLink("org_a", newcomer.person.id, newcomer.threadId)
  const openView = await withOrgContext(appDb, "org_a", (tx) => getPublicPatientRegistration(tx, "org_a", open.token))
  expect(openView.context).toEqual({ kind: "conversation", ownRecord: false })
})

it("replay idéntico devuelve la misma ficha; payload distinto da 409", async () => {
  await publish("org_a")
  const replayVersion = await publishedVersion("org_a")
  const submissionId = randomUUID()
  const base: RegistrationInput = {
    submissionId,
    formVersion: replayVersion,
    answers: adultQrAnswers("Paciente Replay", "+51977444555"),
  }
  const first = await withOrgContext(appDb, "org_a", (tx) =>
    registerPatient(tx, "org_a", { kind: "public", entryPoint: "qr" }, base),
  )
  const second = await withOrgContext(appDb, "org_a", (tx) =>
    registerPatient(tx, "org_a", { kind: "public", entryPoint: "qr" }, base),
  )
  expect(second.id).toBe(first.id)
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      registerPatient(
        tx,
        "org_a",
        { kind: "public", entryPoint: "qr" },
        { submissionId, formVersion: replayVersion, answers: adultQrAnswers("Paciente Replay Cambiado", "+51977444555") },
      ),
    ),
  ).rejects.toMatchObject({ code: "SUBMISSION_CONFLICT", status: 409 })
  const page = await withOrgContext(appDb, "org_a", (tx) =>
    listPatients(tx, "org_a", { q: "Paciente Replay", sort: "name", limit: 10 }),
  )
  expect(page.items.filter((p) => p.displayName === "Paciente Replay")).toHaveLength(1)
})

it("envíos simultáneos con el mismo submissionId crean una sola ficha", async () => {
  await publish("org_a")
  const concurrentVersion = await publishedVersion("org_a")
  const input: RegistrationInput = {
    submissionId: randomUUID(),
    formVersion: concurrentVersion,
    answers: adultQrAnswers("Paciente Concurrente", "+51977555666"),
  }
  const [a, b] = await Promise.all([
    withOrgContext(appDb, "org_a", (tx) => registerPatient(tx, "org_a", { kind: "public", entryPoint: "qr" }, input)),
    withOrgContext(appDb, "org_a", (tx) => registerPatient(tx, "org_a", { kind: "public", entryPoint: "qr" }, input)),
  ])
  expect(a.id).toBe(b.id)
})

it("replay concurrente con UUID en distinto casing resuelve al mismo paciente", async () => {
  await publish("org_a")
  const casingVersion = await publishedVersion("org_a")
  const submissionId = randomUUID()
  const answers = adultQrAnswers("Paciente Casing Concurrente", "+51977555999")
  const [a, b] = await Promise.all([
    withOrgContext(appDb, "org_a", (tx) =>
      registerPatient(tx, "org_a", { kind: "public", entryPoint: "qr" }, { submissionId, formVersion: casingVersion, answers }),
    ),
    withOrgContext(appDb, "org_a", (tx) =>
      registerPatient(tx, "org_a", { kind: "public", entryPoint: "qr" }, { submissionId: submissionId.toUpperCase(), formVersion: casingVersion, answers }),
    ),
  ])
  expect(a.id).toBe(b.id)
})

it("token concurrente admite un solo registro; el reintento idéntico responde éxito", async () => {
  await publish("org_a")
  const tokenVersion = await publishedVersion("org_a")
  const { person, threadId } = await makeContactWithConversation("org_a", "Padre Token")
  const { token } = await makeLink("org_a", person.id, threadId)
  const context = { kind: "public", token, entryPoint: "public_link" } as const
  const firstId = randomUUID()
  const first: RegistrationInput = { submissionId: firstId, formVersion: tokenVersion, answers: adultQrAnswers("Paciente Token Uno", "+51977666777") }
  const other: RegistrationInput = { submissionId: randomUUID(), formVersion: tokenVersion, answers: adultQrAnswers("Paciente Token Dos", "+51977777888") }
  const [one, two] = await Promise.allSettled([
    withOrgContext(appDb, "org_a", (tx) => registerPatient(tx, "org_a", context, first)),
    withOrgContext(appDb, "org_a", (tx) => registerPatient(tx, "org_a", context, other)),
  ])
  const fulfilled = [one, two].filter((r) => r.status === "fulfilled")
  const rejected = [one, two].filter((r) => r.status === "rejected")
  expect(fulfilled).toHaveLength(1)
  expect(rejected).toHaveLength(1)
  expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "NOT_FOUND" })
  // El mismo envío ya confirmado responde éxito sin consumir otra vez.
  const winnerInput = one.status === "fulfilled" ? first : other
  const winnerId = (one.status === "fulfilled" ? one : two as PromiseFulfilledResult<{ id: string }>).value.id
  const retry = await withOrgContext(appDb, "org_a", (tx) =>
    registerPatient(tx, "org_a", context, winnerInput),
  )
  expect(retry.id).toBe(winnerId)
})

it("campo oculto, versión obsoleta y formulario deshabilitado se rechazan sin borrar", async () => {
  const config = await publish("org_a")
  const hidden: RegistrationAnswers = {
    ...adultQrAnswers("Paciente Campo Oculto", "+51977888999"),
    health: { ...emptyClinical(), dental: { ultimaVisita: "2024-01-01" } },
  }
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      registerPatient(tx, "org_a", { kind: "public", entryPoint: "qr" }, { submissionId: randomUUID(), formVersion: config.version, answers: hidden }),
    ),
  ).rejects.toMatchObject({ status: 400 })

  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      registerPatient(
        tx,
        "org_a",
        { kind: "public", entryPoint: "qr" },
        { submissionId: randomUUID(), formVersion: config.version + 99, answers: adultQrAnswers("Paciente Versión Vieja", "+51977999000") },
      ),
    ),
  ).rejects.toMatchObject({ code: "FORM_CHANGED", status: 409 })

  await withOrgContext(appDb, "org_a", async (tx) => {
    const current = await getPatientRegistrationConfig(tx, "org_a")
    await savePatientRegistrationConfig(tx, "org_a", ACTOR, {
      expectedVersion: current.version,
      enabled: false,
      fields: current.fields,
      privacyNotice: NOTICE,
    })
  })
  await expect(
    withOrgContext(appDb, "org_a", (tx) => getPublicPatientRegistration(tx, "org_a")),
  ).rejects.toMatchObject({ code: "NOT_FOUND" })
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      registerPatient(tx, "org_a", { kind: "public", entryPoint: "qr" }, { submissionId: randomUUID(), formVersion: config.version, answers: adultQrAnswers("Paciente Bloqueado", "+51977000999") }),
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND" })
  const survivors = await withOrgContext(appDb, "org_a", (tx) =>
    listPatients(tx, "org_a", { q: "Paciente Replay", sort: "name", limit: 5 }),
  )
  expect(survivors.items.length).toBeGreaterThan(0)
  await publish("org_a")
})

it("la revisión clínica firma sin mutar el snapshot declarado", async () => {
  await publish("org_a")
  const reviewVersion = await publishedVersion("org_a")
  const created = await withOrgContext(appDb, "org_a", (tx) =>
    registerPatient(
      tx,
      "org_a",
      { kind: "public", entryPoint: "qr" },
      {
        submissionId: randomUUID(),
        formVersion: reviewVersion,
        answers: {
          demographics: { displayName: "Paciente Revisión", birthDate: ADULT_BIRTH, phone: "+51977123999" },
          respondent: "patient",
          health: {
            bloodGroup: "O+",
            allergies: { state: "recorded", items: [{ substance: "Penicilina", severity: "severa" }] },
            conditions: { state: "none", items: [] },
            medications: { state: "none", items: [] },
          },
          privacyAccepted: true,
        },
      },
    ),
  )
  const before = await withOrgContext(appDb, "org_a", (tx) => getPatientHealth(tx, "org_a", created.id))
  expect(before.reviewedAt).toBeNull()
  const reviewed = await withOrgContext(appDb, "org_a", (tx) =>
    savePatientHealth(tx, "org_a", ACTOR, created.id, {
      expectedRevision: before.revision,
      bloodGroup: "O+",
      reviewStatus: { allergies: "recorded", conditions: "none", medications: "none" },
      allergies: before.allergies.map((a) => ({
        id: a.id,
        substance: a.substance,
        reaction: a.reaction,
        severity: a.severity,
        isActive: true,
      })),
      conditions: [],
      medications: [],
    }),
  )
  expect(reviewed.reviewedBy).toBe(ACTOR)
  expect(reviewed.reviewedAt).not.toBeNull()
  expect(reviewed.allergies.filter((a) => a.isActive).map((a) => a.substance)).toContain("Penicilina")
  const detail = await withOrgContext(appDb, "org_a", (tx) => getPatient(tx, "org_a", created.id))
  expect(detail.registration?.answers.health).toMatchObject({
    bloodGroup: "O+",
    allergies: { state: "recorded", items: [{ substance: "Penicilina", severity: "severa" }] },
  })
})

it("conflictos públicos neutros; internos específicos; sin cruce de tenant", async () => {
  await seedActor()
  await publish("org_a")
  await publish("org_b")
  const neutralVersionA = await publishedVersion("org_a")
  const neutralVersionB = await publishedVersion("org_b")
  await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, {
      displayName: "Paciente Documento Neutral",
      docType: "DNI",
      docNumber: "40506070",
    }),
  )
  const clash: RegistrationAnswers = {
    demographics: { displayName: "Otro Nombre", birthDate: ADULT_BIRTH, phone: "+51977222000", docType: "DNI", docNumber: "40506070" },
    respondent: "patient",
    health: emptyClinical(),
    privacyAccepted: true,
  }
  const failure = await withOrgContext(appDb, "org_a", (tx) =>
    registerPatient(tx, "org_a", { kind: "public", entryPoint: "qr" }, { submissionId: randomUUID(), formVersion: neutralVersionA, answers: clash }),
  ).then(
    () => null,
    (e: unknown) => e,
  )
  expect(failure).toMatchObject({
    code: "REGISTRATION_NOT_COMPLETED",
    status: 409,
    message: "No pudimos completar el registro. Comunícate con recepción.",
  })
  expect(JSON.stringify(failure)).not.toContain("Paciente Documento Neutral")

  // Interno conserva el conflicto específico.
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      createPatient(tx, "org_a", ACTOR, { displayName: "Duplicado Interno", docType: "DNI", docNumber: "40506070" }),
    ),
  ).rejects.toMatchObject({ code: "DUPLICATE_DOCUMENT", status: 409 })

  // Un segundo registro propio por enlace ya no es neutro: se dice en palabras
  // (lo prueba «quien ya tiene su ficha recibe su enlace…»). Este contacto sirve
  // abajo para el vínculo desde otra organización.
  const mother = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Madre Self Neutral" }),
  )

  // Token de otra organización no cruza el tenant.
  const foreign = await makeContactWithConversation("org_a", "Contacto Origen A")
  const foreignLink = await makeLink("org_a", foreign.person.id, foreign.threadId)
  await expect(
    withOrgContext(appDb, "org_b", (tx) =>
      registerPatient(
        tx,
        "org_b",
        { kind: "public", token: foreignLink.token, entryPoint: "public_link" },
        { submissionId: randomUUID(), formVersion: neutralVersionB, answers: adultQrAnswers("Paciente Otra Org", "+51977444000") },
      ),
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND" })
  await expect(
    withOrgContext(appDb, "org_b", (tx) =>
      getPublicPatientRegistration(tx, "org_b", foreignLink.token),
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND" })

  // Contacto de otra organización no se vincula en interno.
  await expect(
    withOrgContext(appDb, "org_b", (tx) =>
      registerPatient(
        tx,
        "org_b",
        { kind: "internal", userId: ACTOR },
        {
          submissionId: randomUUID(),
          answers: {
            demographics: { displayName: "Paciente Vínculo Foráneo", birthDate: ADULT_BIRTH, phone: "+51977555001" },
            respondent: "staff",
            privacyAccepted: false,
          },
          contacts: [{ contactId: mother.id, relationship: "family", isPreferred: true }],
        },
      ),
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND" })
})

it("interno exige el contacto contextual en los vínculos y lo público rechaza forma interna", async () => {
  await seedActor()
  await publish("org_a")
  const shapeVersion = await publishedVersion("org_a")
  const person = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Contacto Contextual" }),
  )
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      registerPatient(
        tx,
        "org_a",
        { kind: "internal", userId: ACTOR, contactId: person.id },
        {
          submissionId: randomUUID(),
          answers: { demographics: { displayName: "Paciente Sin Vínculo", birthDate: ADULT_BIRTH, phone: "+51977555002" }, respondent: "staff", privacyAccepted: false },
        },
      ),
    ),
  ).rejects.toMatchObject({ status: 400 })

  const created = await withOrgContext(appDb, "org_a", (tx) =>
    registerPatient(
      tx,
      "org_a",
      { kind: "internal", userId: ACTOR, contactId: person.id },
      {
        submissionId: randomUUID(),
        answers: { demographics: { displayName: "Paciente Contextual", birthDate: ADULT_BIRTH, phone: "+51977555003" }, respondent: "staff", privacyAccepted: false },
        contacts: [{ contactId: person.id, relationship: "self", isPreferred: true }],
      },
    ),
  )
  const detail = await withOrgContext(appDb, "org_a", (tx) => getPatient(tx, "org_a", created.id))
  expect(detail.contacts).toEqual([
    expect.objectContaining({ contactId: person.id, relationship: "self" }),
  ])
  expect(detail.registration).toMatchObject({
    entryPoint: "platform",
    respondent: "staff",
    contextContactId: person.id,
  })

  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      registerPatient(
        tx,
        "org_a",
        { kind: "public", entryPoint: "qr" },
        {
          submissionId: randomUUID(),
          formVersion: shapeVersion,
          answers: adultQrAnswers("Paciente Forma Interna", "+51977555000"),
          contacts: [{ contactId: person.id, relationship: "family", isPreferred: true }],
        },
      ),
    ),
  ).rejects.toMatchObject({ status: 400 })
})

it("al reservar, el equipo registra con lo mínimo a la persona de la conversación: lo que falta queda anotado y la identidad por revisar", async () => {
  await seedActor()
  // La clínica exige la fecha de nacimiento (configuración por defecto, publicada).
  await publish("org_a")
  const { person, threadId } = await makeContactWithConversation("org_a", "Carmen Huamán")
  const minimal: RegistrationAnswers = {
    demographics: { displayName: "Carmen Huamán", givenNames: "Carmen", paternalSurname: "Huamán", phone: "+51977000100" },
    respondent: "staff",
    privacyAccepted: false,
  }
  const self = [{ contactId: person.id, relationship: "self" as const, isPreferred: true }]
  const register = (
    context: Partial<{ conversationId: string; scope: "essentials" }>,
    answers: RegistrationAnswers = minimal,
    contacts: RegistrationInput["contacts"] = self,
  ) =>
    withOrgContext(appDb, "org_a", (tx) =>
      registerPatient(
        tx,
        "org_a",
        { kind: "internal", userId: ACTOR, contactId: person.id, ...context },
        { submissionId: randomUUID(), answers, contacts },
      ),
    )

  // El alta interna de siempre sigue exigiendo lo que pide la clínica (el fallo que se veía al reservar).
  await expect(register({ conversationId: threadId })).rejects.toMatchObject({
    status: 400,
    message: "Fecha de nacimiento: obligatorio según la configuración del registro",
  })
  // Lo mínimo solo vale para la persona de una conversación, como su propia ficha, y solo con lo esencial.
  await expect(register({ scope: "essentials" })).rejects.toMatchObject({ status: 400 })
  await expect(
    register({ conversationId: threadId, scope: "essentials" }, minimal, [{ ...self[0]!, relationship: "family" }]),
  ).rejects.toMatchObject({ status: 400 })
  await expect(
    register({ conversationId: threadId, scope: "essentials" }, { ...minimal, demographics: { ...minimal.demographics, occupation: "Abogada" } }),
  ).rejects.toMatchObject({ status: 400 })
  await expect(
    register({ conversationId: threadId, scope: "essentials" }, { ...minimal, health: emptyClinical() }),
  ).rejects.toMatchObject({ status: 400 })
  await expect(
    register({ conversationId: threadId, scope: "essentials" }, { ...minimal, demographics: { displayName: "Carmen", givenNames: "Carmen" } }),
  ).rejects.toMatchObject({ status: 400 })
  expect(await withOrgContext(appDb, "org_a", (tx) => listPatientsByContact(tx, "org_a", person.id))).toEqual([])

  const created = await register({ conversationId: threadId, scope: "essentials" })
  const detail = await withOrgContext(appDb, "org_a", (tx) => getPatient(tx, "org_a", created.id))
  expect(detail.patient).toMatchObject({ displayName: "Carmen Huamán", birthDate: null, identityNeedsReview: true })
  expect(detail.contacts).toEqual([expect.objectContaining({ contactId: person.id, relationship: "self" })])
  expect(detail.registration).toMatchObject({ entryPoint: "conversation", respondent: "staff", contextContactId: person.id, conversationId: threadId })
  // Lo que la clínica pide y falta queda en el caso, con las mismas palabras que el enlace de reserva.
  const notes = (await withOrgContext(appDb, "org_a", (tx) => getCaseBrief(tx, "org_a", threadId))).known.map((item) => item.text)
  expect(notes).toContain("El equipo creó su ficha con lo mínimo al reservar. Falta en la clínica: confirmar apellidos y nombres, fecha de nacimiento.")
})

it("desde la Agenda, sin conversación, el equipo registra a alguien nuevo con lo mínimo y lo que falta queda en sus notas", async () => {
  await seedActor()
  await publish("org_a")
  const answers = (phone?: string): RegistrationAnswers => ({
    demographics: { displayName: "Pedro Ríos", givenNames: "Pedro", paternalSurname: "Ríos", ...(phone ? { phone } : {}) },
    respondent: "staff",
    privacyAccepted: false,
  })
  const register = (input: { answers: RegistrationAnswers; contacts?: RegistrationInput["contacts"] }) =>
    withOrgContext(appDb, "org_a", (tx) =>
      registerPatient(tx, "org_a", { kind: "internal", userId: ACTOR, scope: "essentials" }, { submissionId: randomUUID(), ...input }),
    )
  // Sin teléfono no hay cómo ubicarlo; con vínculos ya no es «alguien nuevo».
  await expect(register({ answers: answers() })).rejects.toMatchObject({ status: 400, message: "Indica el teléfono" })
  const { person } = await makeContactWithConversation("org_a", "Otra Persona")
  await expect(
    register({ answers: answers("+51987111222"), contacts: [{ contactId: person.id, relationship: "self", isPreferred: true }] }),
  ).rejects.toMatchObject({ status: 400 })

  const created = await register({ answers: answers("+51987111222") })
  const detail = await withOrgContext(appDb, "org_a", (tx) => getPatient(tx, "org_a", created.id))
  expect(detail.patient).toMatchObject({ displayName: "Pedro Ríos", birthDate: null, identityNeedsReview: true })
  expect(detail.registration).toMatchObject({ entryPoint: "platform", respondent: "staff", conversationId: null })
  const self = detail.contacts.find((link) => link.relationship === "self")
  expect(self).toBeTruthy()
  const notes = await withOrgContext(appDb, "org_a", (tx) => listPersonNotes(tx, "org_a", self!.contactId))
  expect(notes.map((note) => note.body)).toContain(
    "El equipo creó su ficha con lo mínimo al reservar. Falta en la clínica: confirmar apellidos y nombres, fecha de nacimiento.",
  )
})

it("desde la Agenda, su teléfono pasa a ser su WhatsApp a nombre de quien la registra; si ya es de otra persona, no se mueve y se dice", async () => {
  await seedActor()
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, `wa-${orgId.slice(0, 8)}`)
  const register = (givenNames: string, paternalSurname: string, phone: string) =>
    withOrgContext(appDb, orgId, (tx) =>
      registerPatient(tx, orgId, { kind: "internal", userId: ACTOR, scope: "essentials" }, {
        submissionId: randomUUID(),
        answers: { demographics: { displayName: `${givenNames} ${paternalSurname}`, givenNames, paternalSurname, phone }, respondent: "staff", privacyAccepted: false },
      }),
    )
  const ownPerson = async (patientId: string) =>
    (await withOrgContext(appDb, orgId, (tx) => getPatient(tx, orgId, patientId))).contacts.find((link) => link.relationship === "self")!.contactId
  // Sin WhatsApp conectado no nace ninguna identidad.
  const before = await register("Ana", "Lara", "+51987000301")
  expect(before.whatsapp).toBeUndefined()
  expect(await ownerDb.select().from(contactIdentity).where(eq(contactIdentity.contactId, await ownPerson(before.id)))).toEqual([])
  await withOrgContext(appDb, orgId, (tx) =>
    createConnection(tx, orgId, KEY, {
      channel: "whatsapp", provider: "whatsapp_cloud_api", displayName: "WA",
      config: { phoneNumberId: "P", wabaId: "W", accessToken: "T", appSecret: "S" },
    }, { fetch, validateExternal: false }),
  )
  // Con WhatsApp: la misma operación que «Escribirle», auditada a nombre de quien la registra.
  const pedro = await register("Pedro", "Ríos", "+51987111222")
  expect(pedro.whatsapp).toBe("creado")
  const pedroPerson = await ownPerson(pedro.id)
  const identities = await ownerDb.select().from(contactIdentity).where(eq(contactIdentity.contactId, pedroPerson))
  expect(identities.map((row) => [row.channel, row.externalUserId])).toEqual([["whatsapp", "wa:51987111222"]])
  const trail = await ownerDb.select({ actor: auditEvent.actorUserId }).from(auditEvent)
    .where(and(eq(auditEvent.organizationId, orgId), eq(auditEvent.entityId, pedroPerson), eq(auditEvent.action, "contact.identity_added")))
  expect(trail).toEqual([{ actor: ACTOR }])
  // El mismo número para otra persona: su ficha se crea igual, el número no se mueve y se dice.
  const pablo = await register("Pablo", "Ríos", "+51987111222")
  expect(pablo.whatsapp).toBe("en_uso")
  expect(await ownerDb.select().from(contactIdentity).where(eq(contactIdentity.contactId, await ownPerson(pablo.id)))).toEqual([])
  const owner = await ownerDb.select({ contactId: contactIdentity.contactId }).from(contactIdentity)
    .where(and(eq(contactIdentity.organizationId, orgId), eq(contactIdentity.externalUserId, "wa:51987111222")))
  expect(owner).toEqual([{ contactId: pedroPerson }])
})

it("enlace inválido o vacío no cae al formulario genérico", async () => {
  await publish("org_a")
  const invalidVersion = await publishedVersion("org_a")
  await expect(
    withOrgContext(appDb, "org_a", (tx) => getPublicPatientRegistration(tx, "org_a", "token-invalido")),
  ).rejects.toMatchObject({ code: "NOT_FOUND" })
  await expect(
    withOrgContext(appDb, "org_a", (tx) => getPublicPatientRegistration(tx, "org_a", "")),
  ).rejects.toMatchObject({ code: "NOT_FOUND" })
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      registerPatient(
        tx,
        "org_a",
        { kind: "public", token: "", entryPoint: "public_link" },
        { submissionId: randomUUID(), formVersion: invalidVersion, answers: adultQrAnswers("Paciente Token Vacío", "+51977555111") },
      ),
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND" })
  const generic = await withOrgContext(appDb, "org_a", (tx) => getPublicPatientRegistration(tx, "org_a"))
  expect(generic.context).toEqual({ kind: "generic" })
  expect(generic.config.enabled).toBe(true)
  expect(generic.today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  const { person, threadId } = await makeContactWithConversation("org_a", "Contacto Expira")
  const created = await makeLink("org_a", person.id, threadId)
  expect(created.expiresAt).toBeInstanceOf(Date)
})

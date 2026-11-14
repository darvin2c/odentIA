import { readFileSync } from "node:fs"
import type { RegistrationAnswers } from "@odentia/clinical"
import { withOrgContext } from "@odentia/db"
import { contact, contactIdentity, conversation, crmTask, message } from "@odentia/db/schema/crm"
import { patientContact } from "@odentia/db/schema/clinical"
import { automationConsent } from "@odentia/db/schema/automation"
import { randomUUID } from "node:crypto"
import { expect, it } from "vitest"
import { getCaseBrief } from "./agent-case-brief.js"
import { getPatientHealth, savePatientHealth } from "./clinical.js"
import { createConnection } from "./connections.js"
import { createContact, getContact } from "./contacts.js"
import { listDataConsents } from "./data-consents.js"
import {
  createPatient,
  declareEmergencyContact,
  nextPatientNumber,
  findPatientDuplicates,
  getPatient,
  listPatients,
  listPatientsByContact,
  patientOrganizationToday,
  RegistrationHeld,
} from "./patients.js"
import {
  attachLegalRepresentative,
  confirmPendingRepresentative,
  createPatientRegistrationLink,
  discardRegistrationTask,
  getPatientRegistrationConfig,
  getRegistrationHold,
  getPublicPatientRegistration,
  leaveRegistrationHold,
  registerPatient,
  resolveRegistrationHold,
  savePatientRegistrationConfig,
  type RegistrationInput,
} from "./patient-registration.js"
import { listPersonNotes } from "./people.js"
import { createTask, updateTask } from "./tasks.js"
import { getWorkspaceHome, type WorkspaceAccess } from "./workspace.js"
import { listDecisionRecipients, listResponsibilities } from "./responsibilities.js"
import { secretsKeyFromEnv } from "./secrets.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"
import { insertTestPatients } from "./test-patient.js"
import { and, eq, sql } from "drizzle-orm"
import { auditEvent } from "@odentia/db/schema/org"

setupTestDb()

const ACTOR = "u-registration"
const KEY = secretsKeyFromEnv("dd".repeat(32))
const NOTICE = "Aviso de demostración: tus datos se usan solo para tu atención."
const ADULT_BIRTH = "1990-05-01"
/** Recepción en «Te espera»: pacientes y tareas de toda la clínica. */
const RECEPTION: WorkspaceAccess = { patients: true, appointments: false, conversations: false, tasks: true, finance: false, clinical: false, crm: false, agent: false, allTasks: true, configure: false, ownAppointments: false }
const waitingRow = async (taskId: string) =>
  (await withOrgContext(appDb, "org_a", (tx) => getWorkspaceHome(tx, "org_a", ACTOR, RECEPTION))).waiting.find(
    (row) => row.kind === "possibleDuplicate" && row.id === taskId,
  )
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
    // Otro celular: el mismo celular queda para recepción («¿Es la misma persona?», prueba aparte).
    createContact(tx, "org_a", { displayName: "Vecino QR", phone: "+51977111999" }),
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
  // Todo paciente es una persona: la suya es nueva, no la de otro contacto.
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

it("la madre registra a su segundo hijo con su mismo documento: es la misma persona, y recepción la confirma con un clic", async () => {
  await publish("org_a")
  const version = await publishedVersion("org_a")
  const child = (displayName: string, phone: string): RegistrationAnswers => ({
    demographics: { displayName, birthDate: MINOR_BIRTH, phone },
    respondent: "representative",
    representative: {
      displayName: "Rosa Segundo Hijo",
      relationship: "guardian",
      relationshipDetail: "Madre",
      phone: "+51977000177",
      docType: "DNI",
      docNumber: "41529977",
    },
    health: emptyClinical(),
    privacyAccepted: true,
  })
  const register = (answers: RegistrationAnswers) =>
    withOrgContext(appDb, "org_a", (tx) =>
      registerPatient(tx, "org_a", { kind: "public", entryPoint: "qr" }, { submissionId: randomUUID(), formVersion: version, answers }),
    )
  const representativeOf = async (patientId: string) =>
    (await withOrgContext(appDb, "org_a", (tx) => listResponsibilities(tx, "org_a", patientId))).find(
      (row) => row.kind === "representante_legal",
    )?.contactId
  const first = await register(child("Mateo Segundo Hijo", "+51977000178"))
  const mother = await representativeOf(first.id)
  expect(mother).toBeTruthy()
  const permissionsOf = async () =>
    ownerDb.execute<{ purpose: string; status: string }>(
      sql`select purpose, status from automation_consent where organization_id = 'org_a' and contact_id = ${mother!} order by purpose`,
    )
  const permissionsBefore = [...(await permissionsOf())]

  // El segundo, desde fuera: el documento ya es de una persona, así que el
  // vínculo espera a recepción y no se escriben sus permisos (M1).
  const second = await register({ ...child("Sofía Segundo Hijo", "+51977000179"), acceptsReminders: false })
  expect(await representativeOf(second.id)).toBeUndefined()
  const secondDetail = await withOrgContext(appDb, "org_a", (tx) => getPatient(tx, "org_a", second.id))
  expect(secondDetail.contacts.map((link) => link.contactId)).not.toContain(mother)
  expect([...(await permissionsOf())]).toEqual(permissionsBefore)
  const [pending] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select().from(crmTask).where(and(eq(crmTask.patientId, second.id), eq(crmTask.contactId, mother!))),
  )
  // Lo que escribieron como parentesco se guarda con su código para aplicarlo al confirmar.
  expect(pending).toMatchObject({ status: "open", kind: "confirmar_representante", area: "recepcion", relationshipDetail: "Madre", kinship: "MTH" })
  expect(pending!.title).toBe("Confirma si Rosa Segundo Hijo representa a Sofía Segundo Hijo")
  expect(await waitingRow(pending!.id)).toMatchObject({
    source: "representante",
    patientId: second.id,
    personId: mother,
    patientName: "Sofía Segundo Hijo",
    personName: "Rosa Segundo Hijo",
  })

  // «Confirmar» en «Te espera»: el vínculo con su parentesco y el rol, sin tocar sus datos ni sus permisos.
  await withOrgContext(appDb, "org_a", (tx) => confirmPendingRepresentative(tx, "org_a", ACTOR, second.id, pending!.id))
  expect(await representativeOf(second.id)).toBe(mother)
  const confirmed = await withOrgContext(appDb, "org_a", (tx) => getPatient(tx, "org_a", second.id))
  expect(confirmed.contacts.find((link) => link.contactId === mother)).toMatchObject({ relationship: "guardian", relationshipDetail: "Madre", kinship: "MTH" })
  // Ya confirmado, no se puede descartar.
  await expect(
    withOrgContext(appDb, "org_a", (tx) => discardRegistrationTask(tx, "org_a", ACTOR, pending!.id)),
  ).rejects.toMatchObject({ code: "ALREADY_REVIEWED" })
  expect([...(await permissionsOf())]).toEqual(permissionsBefore)
  const [done] = await withOrgContext(appDb, "org_a", (tx) => tx.select({ status: crmTask.status }).from(crmTask).where(eq(crmTask.id, pending!.id)))
  expect(done!.status).toBe("done")
  await expect(
    withOrgContext(appDb, "org_a", (tx) => confirmPendingRepresentative(tx, "org_a", ACTOR, second.id, pending!.id)),
  ).rejects.toMatchObject({ code: "ALREADY_REVIEWED" })
  const [{ count }] = await ownerDb.execute<{ count: number }>(
    sql`select count(*)::int as count from contact where organization_id = 'org_a' and doc_number = '41529977'`,
  )
  expect(count).toBe(1)
})

it("un anónimo se registra con el DNI de una madre existente: no cambia su correo, no recibe nada y queda para recepción", async () => {
  await seedActor()
  await publish("org_a")
  const version = await publishedVersion("org_a")
  // La madre: persona con su DNI y su correo, representante legal de su hijo, sin ficha propia.
  const son = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, { displayName: "Hijo De Madre Real", birthDate: MINOR_BIRTH }),
  )
  const motherId = await withOrgContext(appDb, "org_a", async (tx) =>
    attachLegalRepresentative(tx, "org_a", ACTOR, son.id, {
      representative: {
        displayName: "Madre Real Ochoa",
        relationshipDetail: "Madre",
        docType: "DNI",
        docNumber: "45678123",
        email: "madre.real@example.com",
        phone: "+51977600001",
      },
      countryCode: "PE",
      today: await patientOrganizationToday(tx, "org_a"),
    }),
  )
  expect(motherId).toBeTruthy()
  const motherBefore = await withOrgContext(appDb, "org_a", (tx) => getContact(tx, "org_a", motherId!))

  const attempt = (answers: RegistrationAnswers) =>
    withOrgContext(appDb, "org_a", (tx) =>
      registerPatient(tx, "org_a", { kind: "public", entryPoint: "qr" }, { submissionId: randomUUID(), formVersion: version, answers }),
    ).then(
      () => null,
      (error: unknown) => error,
    )
  // Como paciente, con su propio correo y teléfono.
  const asPatient = await attempt({
    demographics: {
      displayName: "Intruso Anónimo",
      birthDate: ADULT_BIRTH,
      phone: "+51977600099",
      email: "intruso@example.com",
      docType: "DNI",
      docNumber: "45678123",
    },
    respondent: "patient",
    health: emptyClinical(),
    privacyAccepted: true,
  })
  // La variante: con fecha de menor, «registro a otra persona», él como representante.
  const asGuardian = await attempt({
    demographics: { displayName: "Madre Real Ochoa", birthDate: MINOR_BIRTH, phone: "+51977600098", docType: "DNI", docNumber: "45678123" },
    respondent: "representative",
    representative: {
      displayName: "Intruso Tutor",
      relationship: "guardian",
      relationshipDetail: "Padre",
      phone: "+51977600097",
      email: "intruso.tutor@example.com",
      docType: "DNI",
      docNumber: "70000001",
    },
    health: emptyClinical(),
    privacyAccepted: true,
  })
  for (const failure of [asPatient, asGuardian]) {
    // A quien se registra, el texto neutro: no confirma que el documento exista ni de quién es.
    expect(failure).toBeInstanceOf(RegistrationHeld)
    expect(failure).toMatchObject({ code: "REGISTRATION_NOT_COMPLETED", status: 409, message: "No pudimos completar el registro. Comunícate con recepción." })
    expect((failure as Error).message).not.toContain("Madre Real Ochoa")
  }

  // Nada de la madre cambió: ni identidad, ni ficha, ni representante, ni quién recibe por su hijo.
  const motherAfter = await withOrgContext(appDb, "org_a", (tx) => getContact(tx, "org_a", motherId!))
  expect(motherAfter.contact).toMatchObject({
    displayName: "Madre Real Ochoa",
    email: "madre.real@example.com",
    phone: "+51977600001",
    birthDate: motherBefore.contact.birthDate,
  })
  const [{ ownRecords }] = await ownerDb.execute<{ ownRecords: number }>(
    sql`select count(*)::int as "ownRecords" from patient where organization_id = 'org_a' and person_id = ${motherId!}`,
  )
  expect(ownRecords).toBe(0)
  const recipients = await withOrgContext(appDb, "org_a", (tx) => listDecisionRecipients(tx, "org_a", son.id))
  expect(recipients).toEqual([expect.objectContaining({ contactId: motherId, email: "madre.real@example.com", phone: "+51977600001" })])
  const [{ strangers }] = await ownerDb.execute<{ strangers: number }>(
    sql`select count(*)::int as strangers from contact where organization_id = 'org_a' and (email like 'intruso%' or display_name like 'Intruso%')`,
  )
  expect(strangers).toBe(0)
  // No recibe nada: ningún mensaje salió hacia ella.
  const sent = await withOrgContext(appDb, "org_a", (tx) =>
    tx
      .select({ id: message.id })
      .from(message)
      .innerJoin(conversation, eq(conversation.id, message.conversationId))
      .where(eq(conversation.contactId, motherId!)),
  )
  expect(sent).toEqual([])

  // Lo que deja la ruta, en otra transacción: una fila de «Te espera» para recepción, una por día.
  for (const failure of [asPatient, asGuardian]) {
    await withOrgContext(appDb, "org_a", (tx) => leaveRegistrationHold(tx, "org_a", (failure as RegistrationHeld).hold))
  }
  const holds = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select().from(crmTask).where(and(eq(crmTask.contactId, motherId!), eq(crmTask.kind, "registro_con_documento"))),
  )
  expect(holds).toHaveLength(1)
  expect(holds[0]!.title).toBe("Se registró por el código QR: ¿es Madre Real Ochoa?")
  expect(holds[0]!.reason).toBe("Tiene el mismo documento que Madre Real Ochoa. No se creó a nadie: elige si es la misma persona.")
  expect(holds[0]!.area).toBe("recepcion")
  expect(await waitingRow(holds[0]!.id)).toMatchObject({ source: "registro", patientId: null, personId: motherId, patientName: "Madre Real Ochoa" })
  const unchanged = await withOrgContext(appDb, "org_a", (tx) => tx.select({ email: contact.email }).from(contact).where(eq(contact.id, motherId!)))
  expect(unchanged[0]!.email).toBe("madre.real@example.com")

  // «Descartar»: la fila se va, la tarea queda cancelada con su motivo y la madre sigue igual.
  await withOrgContext(appDb, "org_a", (tx) => discardRegistrationTask(tx, "org_a", ACTOR, holds[0]!.id, { editsPeople: true }))
  expect(await waitingRow(holds[0]!.id)).toBeUndefined()
  const [discarded] = await withOrgContext(appDb, "org_a", (tx) => tx.select().from(crmTask).where(eq(crmTask.id, holds[0]!.id)))
  expect(discarded).toMatchObject({ status: "cancelled", settledReason: "Se revisó y se descartó: no se cambió nada de esa persona" })
  const afterDiscard = await withOrgContext(appDb, "org_a", (tx) => getContact(tx, "org_a", motherId!))
  expect(afterDiscard.contact).toMatchObject({ displayName: "Madre Real Ochoa", email: "madre.real@example.com", phone: "+51977600001" })
})

it("«No es representante»: el representante que nombró el registro en línea no se vincula y la tarea queda cerrada con su motivo", async () => {
  await publish("org_a")
  const version = await publishedVersion("org_a")
  // Una persona de la clínica con su DNI (la registró el equipo).
  const stranger = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, { displayName: "Persona Ajena", birthDate: ADULT_BIRTH, docType: "DNI", docNumber: "41529001" }),
  )
  const [{ personId: strangerId }] = await ownerDb.execute<{ personId: string }>(
    sql`select person_id as "personId" from patient where organization_id = 'org_a' and id = ${stranger.id}`,
  )
  const child = await withOrgContext(appDb, "org_a", (tx) =>
    registerPatient(tx, "org_a", { kind: "public", entryPoint: "qr" }, {
      submissionId: randomUUID(),
      formVersion: version,
      answers: {
        demographics: { displayName: "Niña Del Registro", birthDate: MINOR_BIRTH, phone: "+51977000301" },
        respondent: "representative",
        representative: {
          displayName: "Quien Dice Ser Tutor",
          relationship: "guardian",
          relationshipDetail: "Tutor legal",
          phone: "+51977000302",
          docType: "DNI",
          docNumber: "41529001",
        },
        health: emptyClinical(),
        privacyAccepted: true,
      },
    }),
  )
  const [pending] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select().from(crmTask).where(and(eq(crmTask.patientId, child.id), eq(crmTask.kind, "confirmar_representante"))),
  )
  // Un parentesco que no es de la lista se guarda escrito, sin código.
  expect(pending).toMatchObject({ contactId: strangerId, relationshipDetail: "Tutor legal", kinship: null })
  expect(await waitingRow(pending!.id)).toMatchObject({ source: "representante", personName: "Persona Ajena", patientName: "Niña Del Registro" })

  await withOrgContext(appDb, "org_a", (tx) => discardRegistrationTask(tx, "org_a", ACTOR, pending!.id))
  expect(await waitingRow(pending!.id)).toBeUndefined()
  const [closed] = await withOrgContext(appDb, "org_a", (tx) => tx.select().from(crmTask).where(eq(crmTask.id, pending!.id)))
  expect(closed).toMatchObject({ status: "cancelled", settledReason: "No es su representante: no se vinculó" })
  const detail = await withOrgContext(appDb, "org_a", (tx) => getPatient(tx, "org_a", child.id))
  expect(detail.contacts.map((link) => link.contactId)).not.toContain(strangerId)
  expect(
    (await withOrgContext(appDb, "org_a", (tx) => listResponsibilities(tx, "org_a", child.id))).map((row) => row.contactId),
  ).not.toContain(strangerId)
  // Descartado, ya no se puede confirmar ni volver a descartar.
  await expect(
    withOrgContext(appDb, "org_a", (tx) => confirmPendingRepresentative(tx, "org_a", ACTOR, child.id, pending!.id)),
  ).rejects.toMatchObject({ code: "ALREADY_REVIEWED" })
  await expect(
    withOrgContext(appDb, "org_a", (tx) => discardRegistrationTask(tx, "org_a", ACTOR, pending!.id)),
  ).rejects.toMatchObject({ code: "ALREADY_REVIEWED" })
  // Solo descarta lo del registro en línea: una tarea cualquiera no.
  const other = await withOrgContext(appDb, "org_a", (tx) => createTask(tx, "org_a", { title: "Llamar", createdBy: "user", patientId: child.id }))
  await expect(withOrgContext(appDb, "org_a", (tx) => discardRegistrationTask(tx, "org_a", ACTOR, other.id))).rejects.toMatchObject({ status: 404 })
})

it("con el enlace de su conversación se completa lo vacío, nunca se reemplaza lo que ya tenía y su nombre es el que escribió", async () => {
  await seedActor()
  await publish("org_a")
  const version = await publishedVersion("org_a")
  const { person, threadId } = await makeContactWithConversation("org_a", "Lucía Enlace Propio")
  await ownerDb.execute(
    sql`update contact set email = 'lucia.real@example.com', birth_date = ${ADULT_BIRTH}, given_names = 'Lucía' where id = ${person.id}`,
  )
  const { token } = await makeLink("org_a", person.id, threadId)
  const created = await withOrgContext(appDb, "org_a", (tx) =>
    registerPatient(
      tx,
      "org_a",
      { kind: "public", token, entryPoint: "public_link" },
      {
        submissionId: randomUUID(),
        formVersion: version,
        answers: {
          demographics: { displayName: "Otro Nombre Escrito", birthDate: "1985-01-01", phone: "+51977000100", email: "otro@example.com", docType: "DNI", docNumber: "47000111" },
          respondent: "patient",
          health: emptyClinical(),
          privacyAccepted: true,
        },
      },
    ),
  )
  const after = await withOrgContext(appDb, "org_a", (tx) => getContact(tx, "org_a", person.id))
  // Lo que ya tenía queda; lo vacío (el documento) se completa. Su ficha nace con el nombre con que se registró.
  expect(after.contact).toMatchObject({ displayName: "Otro Nombre Escrito", email: "lucia.real@example.com", birthDate: ADULT_BIRTH, docNumber: "47000111" })
  expect(created.birthDate).toBe(ADULT_BIRTH)
  // Lo distinto, y el nombre de antes, quedan en sus notas para revisar.
  const notes = await withOrgContext(appDb, "org_a", (tx) => listPersonNotes(tx, "org_a", person.id))
  expect(notes.map((note) => note.body)).toEqual([
    "Se registró como Otro Nombre Escrito; antes figuraba como Lucía. En el registro escribió otros datos, que no se guardaron: correo otro@example.com, fecha de nacimiento 1985-01-01. Revisa cuáles valen.",
  ])
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
    demographics: { displayName: "Carmen Huamán", givenNames: "Carmen", familyName: "Huamán", phone: "+51977000100" },
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
  // Lo mínimo es solo lo esencial: ni otros datos, ni salud, ni sin apellidos.
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
  expect(detail.patient).toMatchObject({ displayName: "Carmen Huamán", birthDate: null, identityNeedsReview: false })
  expect(detail.contacts).toEqual([expect.objectContaining({ contactId: person.id, relationship: "self" })])
  expect(detail.registration).toMatchObject({ entryPoint: "conversation", respondent: "staff", contextContactId: person.id, conversationId: threadId })
  // Lo que la clínica pide y falta queda en el caso, con las mismas palabras que el enlace de reserva.
  const notes = (await withOrgContext(appDb, "org_a", (tx) => getCaseBrief(tx, "org_a", threadId))).known.map((item) => item.text)
  expect(notes).toContain("El equipo registró a esta persona con lo mínimo. Faltan datos para la atención: confirmar apellidos y nombres, fecha de nacimiento.")
})

it("desde su página, sin conversación, el equipo registra con lo mínimo a una persona que ya existe y a alguien a su cargo", async () => {
  await seedActor()
  await publish("org_a")
  const { person } = await makeContactWithConversation("org_a", "Rosa Quispe")
  const register = (answers: RegistrationAnswers, contacts: RegistrationInput["contacts"]) =>
    withOrgContext(appDb, "org_a", (tx) =>
      registerPatient(
        tx,
        "org_a",
        { kind: "internal", userId: ACTOR, contactId: person.id, scope: "essentials" },
        { submissionId: randomUUID(), answers, contacts },
      ),
    )
  // Ella misma, sin conversación: lo que la clínica pide y falta no bloquea.
  const own = await register(
    {
      demographics: { displayName: "Rosa Quispe", givenNames: "Rosa", familyName: "Quispe", phone: "+51977000200" },
      respondent: "staff",
      privacyAccepted: false,
    },
    [{ contactId: person.id, relationship: "self", isPreferred: true }],
  )
  const ownDetail = await withOrgContext(appDb, "org_a", (tx) => getPatient(tx, "org_a", own.id))
  expect(ownDetail.patient).toMatchObject({ displayName: "Rosa Quispe", birthDate: null })
  expect(ownDetail.registration).toMatchObject({ entryPoint: "platform", contextContactId: person.id, conversationId: null })
  // Alguien a su cargo: un adulto de la familia, con el teléfono de ella como representante.
  const relative = await register(
    {
      demographics: { displayName: "Lucio Quispe", givenNames: "Lucio", familyName: "Quispe" },
      respondent: "staff",
      representative: { displayName: "Rosa Quispe", relationship: "family", relationshipDetail: "Madre", phone: "+51977000200" },
      privacyAccepted: false,
    },
    [{ contactId: person.id, relationship: "family", isPreferred: true }],
  )
  const relativeDetail = await withOrgContext(appDb, "org_a", (tx) => getPatient(tx, "org_a", relative.id))
  expect(relativeDetail.contacts).toEqual(expect.arrayContaining([expect.objectContaining({ contactId: person.id, relationship: "family" })]))
  // Sin el vínculo con la persona de la página no es «alguien a su cargo».
  await expect(
    register(
      { demographics: { displayName: "Ana Quispe", givenNames: "Ana", familyName: "Quispe" }, respondent: "staff", privacyAccepted: false },
      [],
    ),
  ).rejects.toMatchObject({ status: 400 })
})

it("a su cargo, el documento que se escribe de su madre ya registrada se le guarda: después puede firmar por el menor", async () => {
  await seedActor()
  await publish("org_a")
  const { person } = await makeContactWithConversation("org_a", "Rosa Quispe")
  const child = await withOrgContext(appDb, "org_a", (tx) =>
    registerPatient(
      tx,
      "org_a",
      { kind: "internal", userId: ACTOR, contactId: person.id, scope: "essentials" },
      {
        submissionId: randomUUID(),
        answers: {
          demographics: { displayName: "Lía Quispe", givenNames: "Lía", familyName: "Quispe", birthDate: `${new Date().getUTCFullYear() - 8}-03-10` },
          respondent: "staff",
          representative: { displayName: "Rosa Quispe", relationship: "guardian", relationshipDetail: "Madre", phone: "+51977000200", docType: "DNI", docNumber: "40123456" },
          privacyAccepted: false,
        },
        contacts: [{ contactId: person.id, relationship: "guardian", isPreferred: true }],
      },
    ),
  )
  expect(child.id).toBeTruthy()
  const [mother] = await ownerDb.select({ docType: contact.docType, docNumber: contact.docNumber }).from(contact).where(eq(contact.id, person.id))
  expect(mother).toMatchObject({ docType: "DNI", docNumber: "40123456" })
})

// Lo que falta lo dice «Faltan datos» de su página, al día: no queda una nota que envejece a
// nombre de quien la registró (repaso final de la ficha del 10 nov, B2).
it("desde la Agenda, sin conversación, el equipo registra a alguien nuevo con lo mínimo y lo que falta no queda en sus notas", async () => {
  await seedActor()
  await publish("org_a")
  const answers = (phone?: string): RegistrationAnswers => ({
    demographics: { displayName: "Pedro Ríos", givenNames: "Pedro", familyName: "Ríos", ...(phone ? { phone } : {}) },
    respondent: "staff",
    privacyAccepted: false,
  })
  const register = (input: { answers: RegistrationAnswers; contacts?: RegistrationInput["contacts"] }) =>
    withOrgContext(appDb, "org_a", (tx) =>
      registerPatient(tx, "org_a", { kind: "internal", userId: ACTOR, scope: "essentials" }, { submissionId: randomUUID(), ...input }),
    )
  // Sin teléfono también se registra (una urgencia sin celular): una sola ficha, sin una nota
  // de lo que falta. Con vínculos ya no es «alguien nuevo».
  const withoutPhone = await register({
    answers: {
      ...answers(),
      demographics: { displayName: "Elsa Mori", givenNames: "Elsa", familyName: "Mori" },
    },
  })
  const elsa = await withOrgContext(appDb, "org_a", (tx) =>
    getPatient(tx, "org_a", withoutPhone.id),
  )
  const elsaSelf = elsa.contacts.find((link) => link.relationship === "self")!
  expect(elsa.contacts.filter((link) => link.relationship === "self")).toHaveLength(1)
  expect(withoutPhone.whatsapp).toBeUndefined()
  expect(
    await withOrgContext(appDb, "org_a", (tx) => listPersonNotes(tx, "org_a", elsaSelf.contactId)),
  ).toEqual([])
  const { person } = await makeContactWithConversation("org_a", "Otra Persona")
  await expect(
    register({ answers: answers("+51987111222"), contacts: [{ contactId: person.id, relationship: "self", isPreferred: true }] }),
  ).rejects.toMatchObject({ status: 400 })

  const created = await register({ answers: answers("+51987111222") })
  const detail = await withOrgContext(appDb, "org_a", (tx) => getPatient(tx, "org_a", created.id))
  expect(detail.patient).toMatchObject({ displayName: "Pedro Ríos", birthDate: null, identityNeedsReview: false })
  expect(detail.registration).toMatchObject({ entryPoint: "platform", respondent: "staff", conversationId: null })
  const self = detail.contacts.find((link) => link.relationship === "self")
  expect(self).toBeTruthy()
  expect(
    await withOrgContext(appDb, "org_a", (tx) => listPersonNotes(tx, "org_a", self!.contactId)),
  ).toEqual([])
})

it("desde la Agenda, su teléfono pasa a ser su WhatsApp a nombre de quien la registra; si ya es de otra persona, no se mueve y se dice", async () => {
  await seedActor()
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, `wa-${orgId.slice(0, 8)}`)
  const register = (givenNames: string, familyName: string, phone: string) =>
    withOrgContext(appDb, orgId, (tx) =>
      registerPatient(tx, orgId, { kind: "internal", userId: ACTOR, scope: "essentials" }, {
        submissionId: randomUUID(),
        answers: { demographics: { displayName: `${givenNames} ${familyName}`, givenNames, familyName, phone }, respondent: "staff", privacyAccepted: false },
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

/** El registro en línea sin enlace (el código QR): el paciente que crea o lo que deja para recepción. */
async function registerOnline(answers: RegistrationAnswers) {
  const version = await publishedVersion("org_a")
  return withOrgContext(appDb, "org_a", (tx) =>
    registerPatient(tx, "org_a", { kind: "public", entryPoint: "qr" }, { submissionId: randomUUID(), formVersion: version, answers }),
  ).then(
    (patient) => ({ patient, held: null }),
    (error: unknown) => {
      if (error instanceof RegistrationHeld) return { patient: null, held: error }
      throw error
    },
  )
}

async function testPatient(values: Omit<Parameters<typeof insertTestPatients>[1] & object, "organizationId" | "patientNumber">) {
  const patientNumber = await withOrgContext(appDb, "org_a", (tx) => nextPatientNumber(tx, "org_a"))
  const [row] = await insertTestPatients(ownerDb, { ...values, organizationId: "org_a", patientNumber } as Parameters<typeof insertTestPatients>[1])
  return row!
}

it("QR con el DNI de una ficha guardada sin país emisor: es el mismo DNI y queda para recepción", async () => {
  await publish("org_a")
  // Una ficha de antes, con el DNI guardado sin su país.
  const willy = await testPatient({ displayName: "Willy Cotrina", givenNames: "Willy", familyName: "Cotrina", docType: "DNI", docNumber: "44044201", birthDate: ADULT_BIRTH, phone: "+51993029201" })
  const result = await registerOnline({
    demographics: { displayName: "Willy Cotrina", givenNames: "Willy", familyName: "Cotrina", birthDate: ADULT_BIRTH, phone: "+51987650201", docType: "DNI", docNumber: "44044201" },
    respondent: "patient",
    health: emptyClinical(),
    privacyAccepted: true,
  })
  expect(result.patient).toBeNull()
  expect(result.held?.hold).toMatchObject({ ownerId: willy.personId, match: "documento" })
  const twins = await ownerDb.select({ id: contact.id }).from(contact).where(and(eq(contact.organizationId, "org_a"), eq(contact.docNumber, "44044201")))
  expect(twins).toHaveLength(1)
  // Y recepción lo ve en «Te espera».
  await withOrgContext(appDb, "org_a", (tx) => leaveRegistrationHold(tx, "org_a", result.held!.hold))
  const [task] = await ownerDb.select().from(crmTask).where(and(eq(crmTask.contactId, willy.personId), eq(crmTask.kind, "registro_con_documento")))
  expect(await waitingRow(task!.id)).toBeDefined()
})

it("QR con el celular y el DNI de una persona de prueba: no es ella, se registra y la prueba suelta el documento", async () => {
  await publish("org_a")
  // Una persona de prueba («Probar») a la que se le dio ese celular y ese DNI.
  const [person] = await ownerDb
    .insert(contact)
    .values({ organizationId: "org_a", displayName: "Paciente de prueba", phone: "+51987650202", docType: "DNI", docNumber: "44044202", docCountry: "PE", isTest: true })
    .returning({ id: contact.id })
  const probe = await testPatient({ personId: person!.id })
  const result = await registerOnline({
    demographics: { displayName: "Willy Cotrina", givenNames: "Willy", familyName: "Cotrina", birthDate: ADULT_BIRTH, phone: "+51987650202", docType: "DNI", docNumber: "44044202" },
    respondent: "patient",
    health: emptyClinical(),
    privacyAccepted: true,
  })
  expect(result.held).toBeNull()
  expect(result.patient).toMatchObject({ displayName: "Willy Cotrina", docNumber: "44044202" })
  expect(result.patient?.personId).not.toBe(probe.personId)
  const [after] = await ownerDb.select().from(contact).where(eq(contact.id, probe.personId))
  expect(after).toMatchObject({ isTest: true, docNumber: null })
})

/** Publica el registro preguntando también estos datos. */
async function publishAsking(orgId: string, fields: Record<string, "hidden" | "optional" | "required">) {
  await seedActor()
  return withOrgContext(appDb, orgId, async (tx) => {
    const current = await getPatientRegistrationConfig(tx, orgId)
    return savePatientRegistrationConfig(tx, orgId, ACTOR, {
      expectedVersion: current.version,
      enabled: true,
      fields: { ...current.fields, ...fields },
      privacyNotice: NOTICE,
    })
  })
}

it("QR con el celular de quien solo dijo su nombre: «es la misma» con su nombre marcado lo guarda entero, sin mezclarlo y sin el documento", async () => {
  await seedActor()
  await publish("org_a")
  const version = await publishedVersion("org_a")
  const carla = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Carla", givenNames: "Carla", phone: "+51987654377" }),
  )
  const held = await withOrgContext(appDb, "org_a", (tx) =>
    registerPatient(tx, "org_a", { kind: "public", entryPoint: "qr" }, {
      submissionId: randomUUID(),
      formVersion: version,
      answers: {
        demographics: { displayName: "Ana Ríos Vega", givenNames: "Ana", familyName: "Ríos Vega", birthDate: "1991-03-12", phone: "+51987654377", docType: "DNI", docNumber: "45129899" },
        respondent: "patient",
        health: { ...emptyClinical(), allergies: { state: "recorded", items: [{ substance: "Penicilina", severity: "desconocida" }] } },
        privacyAccepted: true,
      },
    }),
  ).then(
    () => null,
    (error: unknown) => error,
  )
  expect(held).toBeInstanceOf(RegistrationHeld)
  await withOrgContext(appDb, "org_a", (tx) => leaveRegistrationHold(tx, "org_a", (held as RegistrationHeld).hold))
  const [task] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select().from(crmTask).where(and(eq(crmTask.contactId, carla.id), eq(crmTask.kind, "registro_con_documento"))),
  )
  const view = await withOrgContext(appDb, "org_a", (tx) => getRegistrationHold(tx, "org_a", task!.id))
  await withOrgContext(appDb, "org_a", (tx) =>
    resolveRegistrationHold(tx, "org_a", ACTOR, task!.id, { same: true, apply: ["names"], revision: view.revision }),
  )
  const [person] = await ownerDb.select().from(contact).where(eq(contact.id, carla.id))
  // El documento que escribió no se guarda desde aquí: es lo que identifica a una persona.
  expect(person).toMatchObject({ displayName: "Ana Ríos Vega", givenNames: "Ana", familyName: "Ríos Vega", docNumber: null, birthDate: null })
  const notes = await withOrgContext(appDb, "org_a", (tx) => listPersonNotes(tx, "org_a", carla.id))
  expect(JSON.stringify(notes)).toContain("Guardado desde su registro en línea: nombres y apellidos (antes Carla).")
})

it("QR general con el celular de alguien que ya está: no se crea a nadie y recepción revisa dato por dato", async () => {
  await seedActor()
  await publish("org_a")
  const version = await publishedVersion("org_a")
  const diego = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Diego Salazar", givenNames: "Diego", familyName: "Salazar", phone: "+51987654308" }),
  )
  const register = (answers: RegistrationAnswers) =>
    withOrgContext(appDb, "org_a", (tx) =>
      registerPatient(tx, "org_a", { kind: "public", entryPoint: "qr" }, { submissionId: randomUUID(), formVersion: version, answers }),
    ).then(
      () => null,
      (error: unknown) => error,
    )
  const answers: RegistrationAnswers = {
    // El celular escrito sin el prefijo del país es el mismo celular.
    demographics: { displayName: "Diego Salazar Romero", givenNames: "Diego", familyName: "Salazar Romero", birthDate: "1991-03-12", phone: "987654308", email: "diego@correo.pe", docType: "DNI", docNumber: "45129876" },
    respondent: "patient",
    health: { ...emptyClinical(), allergies: { state: "recorded", items: [{ substance: "Penicilina", severity: "desconocida" }] } },
    privacyAccepted: true,
  }
  const held = await register(answers)
  expect(held).toBeInstanceOf(RegistrationHeld)
  expect((held as RegistrationHeld).hold).toMatchObject({ ownerId: diego.id, match: "celular" })
  await withOrgContext(appDb, "org_a", (tx) => leaveRegistrationHold(tx, "org_a", (held as RegistrationHeld).hold))
  const [task] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select().from(crmTask).where(and(eq(crmTask.contactId, diego.id), eq(crmTask.kind, "registro_con_documento"))),
  )
  expect(task!.reason).toBe("Tiene el mismo celular que Diego Salazar. No se creó a nadie: elige si es la misma persona.")
  // Su fila dice por qué se parece y cuántos datos son distintos.
  expect(await waitingRow(task!.id)).toMatchObject({ held: true, match: "celular", differences: 4 })

  // Lo que escribió hoy al lado de lo que ya estaba. Quién es y por dónde se le escribe vienen sin marcar.
  const view = await withOrgContext(appDb, "org_a", (tx) => getRegistrationHold(tx, "org_a", task!.id))
  expect(view).toMatchObject({ match: "celular", ownerId: diego.id, ownerPatientId: null, declaredName: "Diego Salazar Romero" })
  expect(view.health).toEqual({ allergies: "Penicilina", more: false })
  expect(view.rows.map((row) => [row.key, row.declared, row.saved, row.state, row.checked, row.blocked !== null])).toEqual([
    ["names", "Diego Salazar Romero", "Diego Salazar", "changed", false, false],
    ["birthDate", "1991-03-12", null, "new", false, false],
    ["phone", "987654308", "+51987654308", "same", false, false],
    ["email", "diego@correo.pe", null, "new", false, false],
    ["document", "DNI 45129876", null, "new", false, true],
  ])

  // Lo que no se puede guardar desde aquí se rechaza aunque llegue marcado, y lo que cambió mientras lo revisaba también.
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      resolveRegistrationHold(tx, "org_a", ACTOR, task!.id, { same: true, apply: ["phone"], revision: view.revision }),
    ),
  ).rejects.toMatchObject({ code: "VALIDATION" })
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      resolveRegistrationHold(tx, "org_a", ACTOR, task!.id, { same: true, apply: ["names"], revision: "otra" }),
    ),
  ).rejects.toMatchObject({ code: "HOLD_CHANGED" })

  // «Sí, guardar 2 cambios»: queda como paciente en la misma persona, con lo marcado y sin el documento.
  const same = await withOrgContext(appDb, "org_a", (tx) =>
    resolveRegistrationHold(tx, "org_a", ACTOR, task!.id, { same: true, apply: ["names", "birthDate"], revision: view.revision }),
  )
  expect(same.applied).toBe(2)
  const [person] = await ownerDb.select().from(contact).where(eq(contact.id, diego.id))
  expect(person).toMatchObject({ familyName: "Salazar Romero", birthDate: "1991-03-12", docNumber: null, email: null, phone: "+51987654308" })
  const patient = await withOrgContext(appDb, "org_a", (tx) => getPatient(tx, "org_a", same.patientId))
  expect(patient.contacts[0]?.contactId).toBe(diego.id)
  expect(patient.activeAllergies.map((item) => item.substance)).toContain("Penicilina")
  const [done] = await ownerDb.select().from(crmTask).where(eq(crmTask.id, task!.id))
  expect(done).toMatchObject({ status: "done", settledReason: "Era la misma persona: se guardaron los cambios marcados" })
  const [{ holds }] = await ownerDb.execute<{ holds: number }>(sql`select count(*)::int as holds from registration_hold where task_id = ${task!.id}`)
  expect(holds).toBe(0)
  await expect(withOrgContext(appDb, "org_a", (tx) => getRegistrationHold(tx, "org_a", task!.id))).rejects.toMatchObject({ status: 404 })
  const [resolved] = await ownerDb
    .select({ metadata: auditEvent.metadata })
    .from(auditEvent)
    .where(and(eq(auditEvent.action, "registration_hold.resolved"), eq(auditEvent.entityId, same.patientId)))
  expect(resolved?.metadata).toMatchObject({ same: true, applied: ["names", "birthDate"], notApplied: ["email"] })

  // Ya con su salud en la ficha, otra alergia declarada se suma a sus antecedentes sin confirmar: la receta avisa.
  const latex = await register({
    ...answers,
    health: {
      ...emptyClinical(),
      allergies: { state: "recorded", items: [{ substance: "Látex", severity: "desconocida" }] },
      conditions: { state: "recorded", items: [{ name: "Asma" }] },
    },
  })
  await withOrgContext(appDb, "org_a", (tx) => leaveRegistrationHold(tx, "org_a", (latex as RegistrationHeld).hold))
  const [third] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select().from(crmTask).where(and(eq(crmTask.contactId, diego.id), eq(crmTask.kind, "registro_con_documento"), eq(crmTask.status, "open"))),
  )
  const latexView = await withOrgContext(appDb, "org_a", (tx) => getRegistrationHold(tx, "org_a", third!.id))
  expect(latexView.health).toEqual({ allergies: "Látex", more: true })
  await withOrgContext(appDb, "org_a", (tx) => resolveRegistrationHold(tx, "org_a", ACTOR, third!.id, { same: true, revision: latexView.revision }))
  const withLatex = await withOrgContext(appDb, "org_a", (tx) => getPatient(tx, "org_a", same.patientId))
  expect(withLatex.activeAllergies.map((item) => [item.substance, item.verification])).toEqual(
    expect.arrayContaining([["Látex", "no_confirmada"]]),
  )
  // Lo demás de su salud va a sus antecedentes con su nota de dónde vino, pendiente de revisión; no a las notas de su persona.
  const healthNotes = JSON.stringify(await withOrgContext(appDb, "org_a", (tx) => listPersonNotes(tx, "org_a", diego.id)))
  expect(healthNotes).not.toContain("Asma")
  const declaredHealth = await withOrgContext(appDb, "org_a", (tx) => getPatientHealth(tx, "org_a", same.patientId))
  expect(declaredHealth.conditions.find((row) => row.name === "Asma")?.notes).toMatch(/^Lo declaró en su registro en línea el \d{2}\/\d{2}\/\d{4}\.$/)
  expect(declaredHealth).toMatchObject({ reviewPending: true, reviewStatus: { conditions: "recorded" } })
  const [quiet] = await ownerDb.select().from(crmTask).where(eq(crmTask.id, third!.id))
  expect(quiet).toMatchObject({ status: "done", settledReason: "Era la misma persona: no se cambió ningún dato" })

  // Otra vez el mismo celular, pero «Es otra persona»: se registra como nueva.
  const again = await register({ ...answers, demographics: { ...answers.demographics, displayName: "Dana Salazar", givenNames: "Dana", docNumber: "45129877" } })
  expect(again).toBeInstanceOf(RegistrationHeld)
  await withOrgContext(appDb, "org_a", (tx) => leaveRegistrationHold(tx, "org_a", (again as RegistrationHeld).hold))
  const [second] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select().from(crmTask).where(and(eq(crmTask.contactId, diego.id), eq(crmTask.kind, "registro_con_documento"), eq(crmTask.status, "open"))),
  )
  const secondView = await withOrgContext(appDb, "org_a", (tx) => getRegistrationHold(tx, "org_a", second!.id))
  const other = await withOrgContext(appDb, "org_a", (tx) =>
    resolveRegistrationHold(tx, "org_a", ACTOR, second!.id, { same: false, revision: secondView.revision }),
  )
  expect(other.patientId).not.toBe(same.patientId)
  const dana = await withOrgContext(appDb, "org_a", (tx) => getPatient(tx, "org_a", other.patientId))
  expect(dana.patient).toMatchObject({ displayName: "Dana Salazar Romero" })
  expect(dana.contacts[0]?.contactId).not.toBe(diego.id)
})

it("«¿Es la misma persona?» sobre un paciente: guarda solo lo marcado, la dirección entera y deja lo de antes en una nota", async () => {
  await seedActor()
  await publishAsking("org_a", { occupation: "optional" })
  const rosa = await testPatient({
    displayName: "Rosa Quispe", givenNames: "Rosa", familyName: "Quispe", docType: "DNI", docNumber: "44044210", docCountry: "PE",
    birthDate: ADULT_BIRTH, phone: "+51987650210", email: "rosa@antes.pe",
  })
  await ownerDb.execute(sql`update patient set address = 'Av. Larco 100', address_city = 'Miraflores', address_district = 'Lima' where id = ${rosa.id}`)
  const result = await registerOnline({
    demographics: {
      displayName: "Rosa Quispe", givenNames: "Rosa", familyName: "Quispe", docType: "DNI", docNumber: "44044210",
      birthDate: "1985-01-01", phone: "+51987650299", email: "rosa@nuevo.pe", address: "Jr. Puno 200", occupation: "Docente",
    },
    respondent: "patient",
    health: emptyClinical(),
    privacyAccepted: true,
  })
  expect(result.held?.hold).toMatchObject({ ownerId: rosa.personId, match: "documento" })
  await withOrgContext(appDb, "org_a", (tx) => leaveRegistrationHold(tx, "org_a", result.held!.hold))
  const [task] = await ownerDb.select().from(crmTask).where(and(eq(crmTask.contactId, rosa.personId), eq(crmTask.kind, "registro_con_documento")))
  const view = await withOrgContext(appDb, "org_a", (tx) => getRegistrationHold(tx, "org_a", task!.id))
  const row = (key: string) => view.rows.find((item) => item.key === key)
  expect(row("birthDate")).toMatchObject({ state: "changed", checked: false, blocked: null })
  expect(row("phone")).toMatchObject({ state: "changed", checked: false, format: "phone" })
  expect(row("address")).toMatchObject({ state: "changed", checked: true, declared: "Jr. Puno 200" })
  expect(row("occupation")).toMatchObject({ state: "new", checked: true })
  expect(row("document")).toMatchObject({ state: "same", blocked: null })
  await withOrgContext(appDb, "org_a", (tx) =>
    resolveRegistrationHold(tx, "org_a", ACTOR, task!.id, { same: true, apply: ["phone", "address", "occupation"], revision: view.revision }),
  )
  const after = await withOrgContext(appDb, "org_a", (tx) => getPatient(tx, "org_a", rosa.id))
  // La dirección se reemplaza entera: la calle nueva no se queda con el distrito de antes.
  expect(after.patient).toMatchObject({
    phone: "+51987650299", email: "rosa@antes.pe", birthDate: ADULT_BIRTH, address: "Jr. Puno 200", addressCity: null, addressDistrict: null, occupation: "Docente",
  })
  const notes = await withOrgContext(appDb, "org_a", (tx) => listPersonNotes(tx, "org_a", rosa.personId))
  const body = JSON.stringify(notes)
  expect(body).toContain("celular (antes +51987650210)")
  expect(body).toContain("dirección (antes Av. Larco 100 · Miraflores)")
  expect(body).not.toContain("ocupación")
  await publishAsking("org_a", { occupation: "hidden" })
})

it("descartar lo que escribió quien se registró es de quien edita personas, lo borra y no cambia a nadie; la tarea no se pasa a otra persona", async () => {
  await seedActor()
  await publish("org_a")
  const ana = await testPatient({ displayName: "Ana Tello", givenNames: "Ana", familyName: "Tello", docType: "DNI", docNumber: "44044220", docCountry: "PE", birthDate: ADULT_BIRTH })
  const result = await registerOnline({
    demographics: { displayName: "Ana Tello", givenNames: "Ana", familyName: "Tello", docType: "DNI", docNumber: "44044220", birthDate: ADULT_BIRTH, phone: "+51987650220" },
    respondent: "patient",
    health: emptyClinical(),
    privacyAccepted: true,
  })
  await withOrgContext(appDb, "org_a", (tx) => leaveRegistrationHold(tx, "org_a", result.held!.hold))
  const [task] = await ownerDb.select().from(crmTask).where(and(eq(crmTask.contactId, ana.personId), eq(crmTask.kind, "registro_con_documento")))
  const other = await withOrgContext(appDb, "org_a", (tx) => createContact(tx, "org_a", { displayName: "Otra Persona" }))
  await expect(
    withOrgContext(appDb, "org_a", (tx) => updateTask(tx, "org_a", task!.id, { contactId: other.id, actorUserId: ACTOR })),
  ).rejects.toMatchObject({ code: "VALIDATION" })
  await expect(withOrgContext(appDb, "org_a", (tx) => discardRegistrationTask(tx, "org_a", ACTOR, task!.id))).rejects.toMatchObject({ status: 403 })
  await withOrgContext(appDb, "org_a", (tx) => discardRegistrationTask(tx, "org_a", ACTOR, task!.id, { editsPeople: true }))
  const [{ holds }] = await ownerDb.execute<{ holds: number }>(sql`select count(*)::int as holds from registration_hold where task_id = ${task!.id}`)
  expect(holds).toBe(0)
  const [person] = await ownerDb.select().from(contact).where(eq(contact.id, ana.personId))
  expect(person).toMatchObject({ phone: null })
})

it("el documento manda sobre el celular, y «Es otra persona» nunca le pone a nadie el documento de un tercero", async () => {
  await seedActor()
  await publish("org_a")
  // A tiene ese celular; B, ese DNI (sin ficha).
  const a = await withOrgContext(appDb, "org_a", (tx) => createContact(tx, "org_a", { displayName: "Alba Celular", phone: "+51987650230" }))
  const b = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Berta Documento", givenNames: "Berta", familyName: "Documento", docType: "DNI", docNumber: "44044230", docCountry: "PE" }),
  )
  const both = await registerOnline({
    demographics: { displayName: "Carmen Ruiz", givenNames: "Carmen", familyName: "Ruiz", birthDate: ADULT_BIRTH, phone: "+51987650230", docType: "DNI", docNumber: "44044230" },
    respondent: "patient",
    health: emptyClinical(),
    privacyAccepted: true,
  })
  expect(both.held?.hold).toMatchObject({ ownerId: b.id, match: "documento" })

  // Por el celular de A, con un DNI que nadie tiene… hasta que alguien lo registra mientras tanto.
  const byPhone = await registerOnline({
    demographics: { displayName: "Carmen Ruiz", givenNames: "Carmen", familyName: "Ruiz", birthDate: ADULT_BIRTH, phone: "+51987650230", docType: "DNI", docNumber: "44044231" },
    respondent: "patient",
    health: emptyClinical(),
    privacyAccepted: true,
  })
  expect(byPhone.held?.hold).toMatchObject({ ownerId: a.id, match: "celular" })
  await withOrgContext(appDb, "org_a", (tx) => leaveRegistrationHold(tx, "org_a", byPhone.held!.hold))
  const [task] = await ownerDb.select().from(crmTask).where(and(eq(crmTask.contactId, a.id), eq(crmTask.kind, "registro_con_documento")))
  const third = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Dora Tercera", givenNames: "Dora", familyName: "Tercera", docType: "DNI", docNumber: "44044231", docCountry: "PE" }),
  )
  const view = await withOrgContext(appDb, "org_a", (tx) => getRegistrationHold(tx, "org_a", task!.id))
  const other = await withOrgContext(appDb, "org_a", (tx) => resolveRegistrationHold(tx, "org_a", ACTOR, task!.id, { same: false, revision: view.revision }))
  const carmen = await withOrgContext(appDb, "org_a", (tx) => getPatient(tx, "org_a", other.patientId))
  expect(carmen.patient).toMatchObject({ displayName: "Carmen Ruiz", docNumber: null })
  const [dora] = await ownerDb.select().from(contact).where(eq(contact.id, third.id))
  expect(dora).toMatchObject({ displayName: "Dora Tercera", docNumber: "44044231" })
})

it("su contacto de emergencia con el mismo nombre y otro teléfono se actualiza, y quien estaba archivada vuelve al decir que es ella", async () => {
  await seedActor()
  await publishAsking("org_a", { emergencyContactName: "optional", emergencyContactPhone: "optional" })
  const elena = await testPatient({ displayName: "Elena Paz", givenNames: "Elena", familyName: "Paz", docType: "DNI", docNumber: "44044240", docCountry: "PE", birthDate: ADULT_BIRTH })
  await withOrgContext(appDb, "org_a", (tx) => declareEmergencyContact(tx, "org_a", ACTOR, elena.id, { name: "Juan Paz", phone: "+51987650241", kinship: "SPS" }))
  const result = await registerOnline({
    demographics: {
      displayName: "Elena Paz", givenNames: "Elena", familyName: "Paz", docType: "DNI", docNumber: "44044240", birthDate: ADULT_BIRTH,
      phone: "+51987650240", emergencyContactName: "Juan Paz", emergencyContactPhone: "+51987650242",
    },
    respondent: "patient",
    health: emptyClinical(),
    privacyAccepted: true,
  })
  await withOrgContext(appDb, "org_a", (tx) => leaveRegistrationHold(tx, "org_a", result.held!.hold))
  const [task] = await ownerDb.select().from(crmTask).where(and(eq(crmTask.contactId, elena.personId), eq(crmTask.kind, "registro_con_documento")))
  const view = await withOrgContext(appDb, "org_a", (tx) => getRegistrationHold(tx, "org_a", task!.id))
  expect(view.rows.find((row) => row.key === "emergency")).toMatchObject({ state: "changed", checked: true, blocked: null })
  await withOrgContext(appDb, "org_a", (tx) => resolveRegistrationHold(tx, "org_a", ACTOR, task!.id, { same: true, apply: ["emergency"], revision: view.revision }))
  const [juan] = await ownerDb
    .select({ phone: contact.phone, kinship: patientContact.kinship })
    .from(patientContact)
    .innerJoin(contact, eq(contact.id, patientContact.contactId))
    .where(and(eq(patientContact.patientId, elena.id), eq(patientContact.isEmergency, true)))
  expect(juan).toEqual({ phone: "+51987650242", kinship: "SPS" })

  // Archivada y sin ficha, con su documento: decir que es ella la trae de vuelta.
  const filed = await withOrgContext(appDb, "org_a", (tx) =>
    createContact(tx, "org_a", { displayName: "Flor Archivada", givenNames: "Flor", familyName: "Archivada", docType: "DNI", docNumber: "44044244", docCountry: "PE" }),
  )
  await ownerDb.update(contact).set({ isActive: false }).where(eq(contact.id, filed.id))
  const back = await registerOnline({
    demographics: { displayName: "Flor Archivada", givenNames: "Flor", familyName: "Archivada", docType: "DNI", docNumber: "44044244", birthDate: ADULT_BIRTH, phone: "+51987650244" },
    respondent: "patient",
    health: emptyClinical(),
    privacyAccepted: true,
  })
  expect(back.held?.hold).toMatchObject({ ownerId: filed.id, match: "documento" })
  await withOrgContext(appDb, "org_a", (tx) => leaveRegistrationHold(tx, "org_a", back.held!.hold))
  const [floraTask] = await ownerDb.select().from(crmTask).where(and(eq(crmTask.contactId, filed.id), eq(crmTask.kind, "registro_con_documento")))
  const floraView = await withOrgContext(appDb, "org_a", (tx) => getRegistrationHold(tx, "org_a", floraTask!.id))
  await withOrgContext(appDb, "org_a", (tx) => resolveRegistrationHold(tx, "org_a", ACTOR, floraTask!.id, { same: true, revision: floraView.revision }))
  const [flor] = await ownerDb.select().from(contact).where(eq(contact.id, filed.id))
  expect(flor).toMatchObject({ isActive: true })
  await publishAsking("org_a", { emergencyContactName: "hidden", emergencyContactPhone: "hidden" })
})

it("al decir que es la misma persona se guarda su consentimiento con el aviso que vio y la fecha del registro; lo de después manda", async () => {
  await seedActor()
  await publish("org_a")
  const version = await publishedVersion("org_a")
  const gina = await testPatient({ displayName: "Gina Rojas", givenNames: "Gina", familyName: "Rojas", docType: "DNI", docNumber: "44044250", docCountry: "PE", birthDate: ADULT_BIRTH })
  const answers: RegistrationAnswers = {
    demographics: { displayName: "Gina Rojas", givenNames: "Gina", familyName: "Rojas", docType: "DNI", docNumber: "44044250", birthDate: ADULT_BIRTH, phone: "+51987650250" },
    respondent: "patient",
    health: emptyClinical(),
    privacyAccepted: true,
    acceptsMessages: true,
  }
  const first = await registerOnline(answers)
  await withOrgContext(appDb, "org_a", (tx) => leaveRegistrationHold(tx, "org_a", first.held!.hold))
  const [task] = await ownerDb.select().from(crmTask).where(and(eq(crmTask.contactId, gina.personId), eq(crmTask.kind, "registro_con_documento")))
  const [hold] = await ownerDb.execute<{ notice_version: number; notice_text: string; created_at: Date }>(
    sql`select notice_version, notice_text, created_at from registration_hold where task_id = ${task!.id}`,
  )
  expect(hold).toMatchObject({ notice_version: version, notice_text: NOTICE })
  // La clínica cambia su aviso mientras tanto: vale el que vio.
  await withOrgContext(appDb, "org_a", async (tx) => {
    const current = await getPatientRegistrationConfig(tx, "org_a")
    await savePatientRegistrationConfig(tx, "org_a", ACTOR, { expectedVersion: current.version, enabled: true, fields: current.fields, privacyNotice: `${NOTICE} (versión nueva)` })
  })
  const view = await withOrgContext(appDb, "org_a", (tx) => getRegistrationHold(tx, "org_a", task!.id))
  const resolved = await withOrgContext(appDb, "org_a", (tx) => resolveRegistrationHold(tx, "org_a", ACTOR, task!.id, { same: true, revision: view.revision }))
  expect(resolved.consent).toBe("guardado")
  const consents = await withOrgContext(appDb, "org_a", (tx) => listDataConsents(tx, "org_a", gina.id))
  expect(consents[0]).toMatchObject({ noticeVersion: version, noticeText: NOTICE, channel: "formulario_publico", recordedBy: null, grantedByContactId: gina.personId })
  expect(consents[0]?.purposes).toEqual(["atencion", "comunicaciones"])
  expect(new Date(consents[0]!.grantedAt).getTime()).toBe(new Date(hold!.created_at).getTime())

  // Si revocó su consentimiento después de registrarse, no se vuelve a guardar.
  const again = await registerOnline({ ...answers, demographics: { ...answers.demographics, phone: "+51987650251" } })
  await withOrgContext(appDb, "org_a", (tx) => leaveRegistrationHold(tx, "org_a", again.held!.hold))
  await ownerDb.execute(sql`update patient_data_consent set revoked_at = now() + interval '1 minute', revoke_reason = 'Lo pidió' where patient_id = ${gina.id}`)
  const [second] = await ownerDb.select().from(crmTask).where(and(eq(crmTask.contactId, gina.personId), eq(crmTask.kind, "registro_con_documento"), eq(crmTask.status, "open")))
  const secondView = await withOrgContext(appDb, "org_a", (tx) => getRegistrationHold(tx, "org_a", second!.id))
  const revoked = await withOrgContext(appDb, "org_a", (tx) => resolveRegistrationHold(tx, "org_a", ACTOR, second!.id, { same: true, revision: secondView.revision }))
  expect(revoked.consent).toBe("revocado")
  expect(await withOrgContext(appDb, "org_a", (tx) => listDataConsents(tx, "org_a", gina.id))).toHaveLength(1)
  await publish("org_a")
})

it("lo dejado sin el aviso (antes de guardarlo) no guarda consentimiento: se pide en la clínica", async () => {
  await seedActor()
  await publish("org_a")
  const hugo = await testPatient({ displayName: "Hugo Salas", givenNames: "Hugo", familyName: "Salas", docType: "DNI", docNumber: "44044260", docCountry: "PE", birthDate: ADULT_BIRTH })
  const result = await registerOnline({
    demographics: { displayName: "Hugo Salas", givenNames: "Hugo", familyName: "Salas", docType: "DNI", docNumber: "44044260", birthDate: ADULT_BIRTH, phone: "+51987650260" },
    respondent: "patient",
    health: emptyClinical(),
    privacyAccepted: true,
  })
  // Como lo que quedó antes de guardar el aviso.
  await withOrgContext(appDb, "org_a", (tx) => leaveRegistrationHold(tx, "org_a", { ...result.held!.hold, notice: undefined }))
  const [task] = await ownerDb.select().from(crmTask).where(and(eq(crmTask.contactId, hugo.personId), eq(crmTask.kind, "registro_con_documento")))
  const view = await withOrgContext(appDb, "org_a", (tx) => getRegistrationHold(tx, "org_a", task!.id))
  const resolved = await withOrgContext(appDb, "org_a", (tx) => resolveRegistrationHold(tx, "org_a", ACTOR, task!.id, { same: true, revision: view.revision }))
  expect(resolved.consent).toBe("pendiente")
  expect(await withOrgContext(appDb, "org_a", (tx) => listDataConsents(tx, "org_a", hugo.id))).toEqual([])
})

it("su entrevista declarada se suma campo por campo: lo que anotó el profesional sigue, y su salud queda por revisar", async () => {
  await seedActor()
  await publishAsking("org_a", { "personal.embarazo": "optional" })
  const ines = await testPatient({ displayName: "Inés Vera", givenNames: "Inés", familyName: "Vera", docType: "DNI", docNumber: "44044270", docCountry: "PE", birthDate: ADULT_BIRTH, sex: "F" })
  const before = await withOrgContext(appDb, "org_a", (tx) => getPatientHealth(tx, "org_a", ines.id))
  await withOrgContext(appDb, "org_a", (tx) =>
    savePatientHealth(tx, "org_a", ACTOR, ines.id, {
      expectedRevision: before.revision,
      reviewStatus: { allergies: "none", conditions: "none", medications: "none" },
      allergies: [],
      conditions: [],
      medications: [],
      anamnesis: { expectedVersion: 0, answers: { antecedentesPersonales: { cirugias: "Apendicectomía" } } },
    }),
  )
  const result = await registerOnline({
    demographics: { displayName: "Inés Vera", givenNames: "Inés", familyName: "Vera", docType: "DNI", docNumber: "44044270", birthDate: ADULT_BIRTH, sex: "F", phone: "+51987650270" },
    respondent: "patient",
    health: { ...emptyClinical(), medications: { state: "recorded", items: [{ name: "Losartán" }] }, personal: { embarazo: true, semanasEmbarazo: 20 } },
    privacyAccepted: true,
  })
  await withOrgContext(appDb, "org_a", (tx) => leaveRegistrationHold(tx, "org_a", result.held!.hold))
  const [task] = await ownerDb.select().from(crmTask).where(and(eq(crmTask.contactId, ines.personId), eq(crmTask.kind, "registro_con_documento")))
  const view = await withOrgContext(appDb, "org_a", (tx) => getRegistrationHold(tx, "org_a", task!.id))
  await withOrgContext(appDb, "org_a", (tx) => resolveRegistrationHold(tx, "org_a", ACTOR, task!.id, { same: true, revision: view.revision }))
  const after = await withOrgContext(appDb, "org_a", (tx) => getPatientHealth(tx, "org_a", ines.id))
  // El embarazo entra con el día en que lo dijo (el del registro), junto a lo que ya estaba.
  expect(after.latestAnamnesis?.answers).toMatchObject({
    antecedentesPersonales: { cirugias: "Apendicectomía" },
    embarazoLactancia: { embarazo: { estado: "si", semanas: 20 } },
  })
  expect(after.pregnancy).toMatchObject({ state: "vigente", weeksSaid: 20 })
  expect(after.medications.map((row) => row.name)).toEqual(["Losartán"])
  expect(after).toMatchObject({ reviewPending: true, reviewStatus: { medications: "recorded", conditions: "none" } })
  await publishAsking("org_a", { "personal.embarazo": "hidden" })
})

it("un registro retenido fecha lo que dijo con el día en que lo dijo, no con el día en que recepción lo resuelve", async () => {
  await seedActor()
  await publishAsking("org_a", { "personal.embarazo": "optional" })
  // Ya estaba como contacto, con su celular: su registro en línea queda para «¿Es la misma persona?».
  const [luz] = await ownerDb
    .insert(contact)
    .values({ organizationId: "org_a", displayName: "Luz Campos", givenNames: "Luz", familyName: "Campos", phone: "+51987650291" })
    .returning({ id: contact.id })
  const result = await registerOnline({
    demographics: { displayName: "Luz Campos", givenNames: "Luz", familyName: "Campos", docType: "DNI", docNumber: "44044291", birthDate: ADULT_BIRTH, sex: "F", phone: "+51987650291" },
    respondent: "patient",
    health: { ...emptyClinical(), allergies: { state: "none", items: [] }, personal: { embarazo: true, semanasEmbarazo: 30 } },
    privacyAccepted: true,
  })
  expect(result.held).not.toBeNull()
  await withOrgContext(appDb, "org_a", (tx) => leaveRegistrationHold(tx, "org_a", result.held!.hold))
  const [task] = await ownerDb.select().from(crmTask).where(and(eq(crmTask.contactId, luz!.id), eq(crmTask.kind, "registro_con_documento")))
  // Dijo 30 semanas hace dos semanas; recepción lo resuelve hoy.
  const saidAt = new Date(Date.now() - 14 * 86_400_000)
  await ownerDb.execute(sql`update registration_hold set created_at = ${saidAt.toISOString()}::timestamptz where task_id = ${task!.id}`)
  const view = await withOrgContext(appDb, "org_a", (tx) => getRegistrationHold(tx, "org_a", task!.id))
  const resolved = await withOrgContext(appDb, "org_a", (tx) =>
    resolveRegistrationHold(tx, "org_a", ACTOR, task!.id, { same: true, revision: view.revision }),
  )
  const health = await withOrgContext(appDb, "org_a", (tx) => getPatientHealth(tx, "org_a", resolved.patientId))
  const saidOn = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit" }).format(saidAt)
  // Hoy son 32, no 30: la fecha del embarazo es la del día en que lo dijo.
  expect(health.pregnancy).toEqual({ state: "vigente", saidOn, weeksSaid: 30, weeksToday: 32 })
  // Y la ficha lo nombra con ese día y con quien lo dijo.
  expect(health.declared).toHaveLength(1)
  expect(health.declared[0]).toMatchObject({ by: { kind: "patient" }, pregnancy: true, saidNo: { allergies: true } })
  expect(health.declared[0]!.at?.getTime()).toBe(saidAt.getTime())
  expect(health.declarations[0]).toMatchObject({ via: "registro", by: { kind: "patient" } })
  await publishAsking("org_a", { "personal.embarazo": "hidden" })
})

it("lo que declaró quien registró a otra persona lleva su nombre y su vínculo, también en los registros de antes", async () => {
  await seedActor()
  await publish("org_a")
  // Una adulta registrada por su hermana: no lo dijo ella.
  const result = await registerOnline({
    demographics: { displayName: "Nora Vera", givenNames: "Nora", familyName: "Vera", docType: "DNI", docNumber: "44044295", birthDate: ADULT_BIRTH, sex: "F", phone: "+51987650295" },
    respondent: "representative",
    representative: { displayName: "Rosa Vera", relationship: "family", relationshipDetail: "Hermana", phone: "+51987650296" },
    health: { ...emptyClinical(), medications: { state: "recorded", items: [{ name: "Losartán" }] } },
    privacyAccepted: true,
  })
  const patientId = result.patient!.id
  const sister = { kind: "representative", name: "Rosa Vera", relation: "hermana" }
  const health = await withOrgContext(appDb, "org_a", (tx) => getPatientHealth(tx, "org_a", patientId))
  expect(health.declared).toHaveLength(1)
  expect(health.declared[0]).toMatchObject({ by: sister, medications: health.medications.map((row) => row.id) })

  // Un registro de antes de guardarse quién lo dijo: sin su declaración, la ficha no afirma un autor…
  await ownerDb.execute(sql`delete from patient_health_declaration where patient_id = ${patientId}::uuid`)
  const before = await withOrgContext(appDb, "org_a", (tx) => getPatientHealth(tx, "org_a", patientId))
  expect(before.declared[0]?.by).toEqual({ kind: "unknown", name: null, relation: null })
  // …y la migración la copia de lo que el registro ya guardaba, tal como está escrita.
  const migration = readFileSync(new URL("../../db/drizzle/0114_quien_y_cuando_lo_dijo_reglas.sql", import.meta.url), "utf8")
  for (const statement of migration.split("--> statement-breakpoint")) await ownerDb.execute(sql.raw(statement))
  const after = await withOrgContext(appDb, "org_a", (tx) => getPatientHealth(tx, "org_a", patientId))
  expect(after.declared).toHaveLength(1)
  expect(after.declared[0]).toMatchObject({ by: sister, medications: health.medications.map((row) => row.id) })
  expect(after.declared[0]!.at?.getTime()).toBe(health.declared[0]!.at?.getTime())
  // Repetirla no duplica nada.
  for (const statement of migration.split("--> statement-breakpoint")) await ownerDb.execute(sql.raw(statement))
  const [{ rows }] = await ownerDb.execute<{ rows: number }>(
    sql`select count(*)::int as rows from patient_health_declaration where patient_id = ${patientId}::uuid`,
  )
  expect(rows).toBe(1)
})

it("quien registra a otra persona no da su consentimiento por ella, y un permiso que cambió después del registro no se pisa", async () => {
  await seedActor()
  await publish("org_a")
  const jose = await testPatient({ displayName: "José Ríos", givenNames: "José", familyName: "Ríos", docType: "DNI", docNumber: "44044280", docCountry: "PE", birthDate: ADULT_BIRTH })
  const forOther = await registerOnline({
    demographics: { displayName: "José Ríos", givenNames: "José", familyName: "Ríos", docType: "DNI", docNumber: "44044280", birthDate: ADULT_BIRTH, phone: "+51987650280" },
    respondent: "representative",
    representative: { displayName: "Ana Ríos", relationship: "family", relationshipDetail: "Hermana", phone: "+51987650281" },
    health: emptyClinical(),
    privacyAccepted: true,
  })
  await withOrgContext(appDb, "org_a", (tx) => leaveRegistrationHold(tx, "org_a", forOther.held!.hold))
  const [task] = await ownerDb.select().from(crmTask).where(and(eq(crmTask.contactId, jose.personId), eq(crmTask.kind, "registro_con_documento")))
  const view = await withOrgContext(appDb, "org_a", (tx) => getRegistrationHold(tx, "org_a", task!.id))
  const resolved = await withOrgContext(appDb, "org_a", (tx) => resolveRegistrationHold(tx, "org_a", ACTOR, task!.id, { same: true, revision: view.revision }))
  expect(resolved.consent).toBe("pendiente")
  expect(await withOrgContext(appDb, "org_a", (tx) => listDataConsents(tx, "org_a", jose.id))).toEqual([])
  expect(JSON.stringify(await withOrgContext(appDb, "org_a", (tx) => listPersonNotes(tx, "org_a", jose.personId)))).toContain("Falta su consentimiento de datos")

  // Él mismo, con novedades aceptadas en el formulario; pero después de registrarse dijo que no.
  const self = await registerOnline({
    demographics: { displayName: "José Ríos", givenNames: "José", familyName: "Ríos", docType: "DNI", docNumber: "44044280", birthDate: ADULT_BIRTH, phone: "+51987650282" },
    respondent: "patient",
    health: emptyClinical(),
    privacyAccepted: true,
    acceptsMessages: true,
  })
  await withOrgContext(appDb, "org_a", (tx) => leaveRegistrationHold(tx, "org_a", self.held!.hold))
  await ownerDb.insert(automationConsent).values({ organizationId: "org_a", contactId: jose.personId, purpose: "novedades", status: "revoked", source: "presencial" })
  await ownerDb.execute(sql`update automation_consent set updated_at = now() + interval '1 minute' where contact_id = ${jose.personId}`)
  const [second] = await ownerDb.select().from(crmTask).where(and(eq(crmTask.contactId, jose.personId), eq(crmTask.kind, "registro_con_documento"), eq(crmTask.status, "open")))
  const secondView = await withOrgContext(appDb, "org_a", (tx) => getRegistrationHold(tx, "org_a", second!.id))
  const mine = await withOrgContext(appDb, "org_a", (tx) => resolveRegistrationHold(tx, "org_a", ACTOR, second!.id, { same: true, revision: secondView.revision }))
  expect(mine.consent).toBe("guardado")
  const [novedades] = await ownerDb.select().from(automationConsent).where(and(eq(automationConsent.contactId, jose.personId), eq(automationConsent.purpose, "novedades")))
  expect(novedades).toMatchObject({ status: "revoked" })
})

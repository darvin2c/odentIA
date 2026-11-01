/**
 * «Su enlace» (fase 3, decisión 8; ADR 0037): una página por persona con lo
 * que tiene pendiente. Cada cosa sale de su regla y deja de servir cuando ya
 * no hace falta; nunca se muestra lo guardado y nunca se unen fichas solas.
 */
import { randomUUID } from "node:crypto"
import { appointment, appointmentBookingLink } from "@odentia/db/schema/agenda"
import { automationLinkToken } from "@odentia/db/schema/automation"
import { patient, patientContact, patientResponsibility } from "@odentia/db/schema/clinical"
import { consentDocument } from "@odentia/db/schema/clinical-forms"
import { agentActionLog, agentCaseMemory } from "@odentia/db/schema/agent"
import { agentConfig, channelConnection, channelTemplate, contact, contactIdentity, conversation, crmTask, message } from "@odentia/db/schema/crm"
import { crmNote } from "@odentia/db/schema/crm-workspace"
import { branch, orgProfile } from "@odentia/db/schema/org"
import { workspaceNotification } from "@odentia/db/schema/workspace"
import { and, eq } from "drizzle-orm"
import { createHash } from "node:crypto"
import { expect, it, onTestFinished, vi } from "vitest"
import { createRoom } from "./appointments.js"
import { setMessageChoice } from "./automation.js"
import { listApprovedMessages } from "./clinic-messages.js"
import { confirmBookingLinkAppointment, issuePersonalLink, listBookingLinkSlots, reserveBookingLink, revokePersonalLinks } from "./booking-links.js"
import { setProfessionalSchedule } from "./availability.js"
import { hidePersonalLinkRefs, personalLinkRef, personalLinkToken, resolvePersonalLinkRefs } from "./personal-link-token.js"
import { createBudget, deliverBudget } from "./budgets.js"
import {
  confirmLinkSignedConsent,
  createConsentDocument,
  createConsentTemplate,
  createFormTemplate,
  listConsentEvents,
  markConsentSentByLink,
  publishConsentTemplate,
  publishFormTemplate,
} from "./clinical-forms.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { getPatientHealth } from "./clinical.js"
import { DocumentKit } from "./document-kit.js"
import { renderHealthDocumentPdf } from "./health-documents.js"
import { addPlanItem } from "./plan.js"
import { getPatientRegistrationConfig, savePatientRegistrationConfig } from "./patient-registration.js"
import { createPatient, patientPersonId, requirePatient, setPatientContact } from "./patients.js"
import { configurePublicLinks } from "./public-links.js"
import { getWorkspaceHome, type WorkspaceAccess } from "./workspace.js"
import {
  decidePersonalLinkBudget,
  bookedDataLink,
  getPersonalLinkDataForm,
  getPersonalLinkView,
  personalLinkForEmailToken,
  sendPersonalLink,
  signPersonalLinkConsent,
  submitPersonalLinkData,
  submitPersonalLinkQuestionnaire,
} from "./su-enlace.js"
import { secretsKeyFromEnv } from "./secrets.js"
import { ownerDb, setupTestDb } from "./test-setup.js"
import { selectTestPatients } from "./test-patient.js"

setupTestDb()

const ORG = "org_a"
const KEY = secretsKeyFromEnv("cd".repeat(32))

/** Una persona registrada por teléfono con lo mínimo: nombres, apellido y celular. */
async function minimal(f: Awaited<ReturnType<typeof clinicalFixture>>, name: { given: string; surname: string }) {
  const created = await f.run((tx) =>
    createPatient(tx, ORG, f.actor, {
      displayName: `${name.given} ${name.surname}`,
      givenNames: name.given,
      familyName: name.surname,
      phone: "+51987111222",
    }),
  )
  const personId = await f.run((tx) => patientPersonId(tx, ORG, created.id))
  if (!personId) throw new Error("Sin persona propia")
  return { patientId: created.id, personId }
}

it("uno por persona; «Tus datos» pide solo lo que falta, se envía una vez y nunca muestra lo guardado", async () => {
  const f = await clinicalFixture()
  const pedro = await minimal(f, { given: "Pedro", surname: "Ríos" })
  const first = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: pedro.personId, patientId: pedro.patientId }, { secretsKey: KEY }))
  // Enviarlo otra vez da el mismo enlace: lo que llegue después aparece en él.
  const again = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: pedro.personId, patientId: pedro.patientId }, { secretsKey: KEY }))
  expect(again).toMatchObject({ token: first.token, reused: true })
  const rows = await ownerDb.select().from(appointmentBookingLink).where(eq(appointmentBookingLink.patientId, pedro.patientId))
  expect(rows).toHaveLength(1)
  // Solo se guarda su huella.
  expect(rows[0]?.tokenHash).not.toBe(first.token)

  const view = await f.run((tx) => getPersonalLinkView(tx, ORG, first.token))
  expect(view).toMatchObject({ status: "abierto", firstName: "Pedro", patientFirstName: null, booking: null, appointment: null })
  expect(view.data?.missing.map((item) => item.key)).toContain("birthDate")
  // Nada de lo guardado viaja a la página: ni su celular ni su apellido.
  expect(JSON.stringify(view)).not.toContain("987111222")
  expect(JSON.stringify(view)).not.toContain("Ríos")

  // Lo que no falta no se toca aunque venga en el envío.
  await f.run((tx) =>
    submitPersonalLinkData(tx, ORG, first.token, {
      data: { birthDate: "1988-02-14", docType: "DNI", docNumber: "47120836", phone: "+51900000000" },
    }),
  )
  const [saved] = await selectTestPatients(ownerDb).where(eq(patient.id, pedro.patientId))
  expect(saved).toMatchObject({ birthDate: "1988-02-14", phone: "+51987111222", identityNeedsReview: false })
  // Una sola vez: después dice «Recibido» y no se vuelve a llenar desde aquí.
  await expect(
    f.run((tx) => submitPersonalLinkData(tx, ORG, first.token, { data: { birthDate: "1990-01-01" } })),
  ).rejects.toMatchObject({ code: "DATA_ALREADY_SENT" })
  // Sin nada pendiente solo le queda «Tus mensajes» (ADR 0040): ni sus datos ni nada de lo guardado.
  expect(await f.run((tx) => getPersonalLinkView(tx, ORG, first.token))).toMatchObject({
    status: "abierto", data: null, budgets: [], consents: [], questionnaire: null, papers: [],
    messages: { recordatorio: true, seguimiento: true, novedades: false, nothing: false },
  })
  // Su persona guarda una nota con lo que completó.
  const notes = await ownerDb.select({ body: crmNote.body }).from(crmNote).where(eq(crmNote.contactId, pedro.personId))
  expect(notes.map((note) => note.body).join(" ")).toContain("Completó desde su enlace")
})

it("un documento que ya es de otra ficha no se guarda y deja «Posible ficha repetida» a recepción", async () => {
  const f = await clinicalFixture()
  // Esta clínica pide el documento para atender: es de lo que falta.
  const config = await f.run((tx) => getPatientRegistrationConfig(tx, ORG))
  await f.run((tx) =>
    savePatientRegistrationConfig(tx, ORG, f.actor, {
      expectedVersion: config.version,
      enabled: true,
      fields: { ...config.fields, docType: "required", docNumber: "required" },
      privacyNotice: "Tus datos se usan solo para tu atención.",
    }),
  )
  await f.run((tx) =>
    createPatient(tx, ORG, f.actor, {
      displayName: "Juan Pérez",
      givenNames: "Juan",
      familyName: "Pérez",
      docType: "DNI",
      docNumber: "41231234",
    }),
  )
  const otro = await minimal(f, { given: "Pedro", surname: "Ríos" })
  const link = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: otro.personId, patientId: otro.patientId }, { secretsKey: KEY }))
  // A la persona no se le dice de quién es: recibe «Recibido».
  expect(
    await f.run((tx) =>
      submitPersonalLinkData(tx, ORG, link.token, { data: { birthDate: "1991-04-04", docType: "DNI", docNumber: "41231234" } }),
    ),
  ).toEqual({ received: true })
  const [saved] = await selectTestPatients(ownerDb).where(eq(patient.id, otro.patientId))
  expect(saved).toMatchObject({ birthDate: "1991-04-04", docNumber: null })
  const tasks = await ownerDb
    .select({ title: crmTask.title, kind: crmTask.kind, area: crmTask.area, reason: crmTask.reason })
    .from(crmTask)
    .where(and(eq(crmTask.patientId, otro.patientId), eq(crmTask.kind, "ficha_repetida")))
  expect(tasks).toEqual([
    expect.objectContaining({ title: "Posible ficha repetida: Pedro Ríos", area: "recepcion", reason: expect.stringContaining("en la página de Juan Pérez") }),
  ])
})

it("si la fecha dice que es menor, desde el enlace no se registra a nadie: queda «Faltan datos» y una tarea a recepción", async () => {
  const f = await clinicalFixture()
  const nina = await minimal(f, { given: "Sofía", surname: "Paz" })
  const link = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: nina.personId, patientId: nina.patientId }, { secretsKey: KEY }))
  const minorDate = `${new Date().getUTCFullYear() - 10}-03-10`
  await expect(
    f.run((tx) => submitPersonalLinkData(tx, ORG, link.token, { data: { birthDate: minorDate } })),
  ).rejects.toMatchObject({ code: "REPRESENTATIVE_REQUIRED" })
  // El documento de su madre se revisa con las reglas del país y se dice qué arreglar.
  await expect(
    f.run((tx) =>
      submitPersonalLinkData(tx, ORG, link.token, {
        data: { birthDate: minorDate },
        representative: { displayName: "Rosa Paz", docType: "DNI", docNumber: "423" },
      }),
    ),
  ).rejects.toMatchObject({ code: "VALIDATION", message: "El DNI tiene 8 números; faltan 5" })
  await expect(
    f.run((tx) =>
      submitPersonalLinkData(tx, ORG, link.token, {
        data: { birthDate: minorDate },
        representative: { displayName: "Rosa Paz", docType: "INVENTADO", docNumber: "42345678" },
      }),
    ),
  ).rejects.toMatchObject({ code: "VALIDATION" })
  await f.run((tx) =>
    submitPersonalLinkData(tx, ORG, link.token, {
      data: { birthDate: minorDate },
      representative: { displayName: "Rosa Paz", docType: "DNI", docNumber: "42345678", phone: "+51955111222" },
    }),
  )
  // Ni la fecha ni un representante: la ficha sigue con lo que falta.
  const saved = await f.run((tx) => requirePatient(tx, ORG, nina.patientId))
  expect(saved?.birthDate).toBeNull()
  const reps = await ownerDb.select({ id: patientResponsibility.id }).from(patientResponsibility).where(eq(patientResponsibility.patientId, nina.patientId))
  expect(reps).toEqual([])
  const tasks = await ownerDb
    .select({ title: crmTask.title, area: crmTask.area })
    .from(crmTask)
    .where(eq(crmTask.patientId, nina.patientId))
  expect(tasks).toEqual([{ title: "Registrar a su representante legal: Sofía Paz", area: "recepcion" }])
  // Lo que escribió de su madre queda en una nota para recepción.
  const notes = await ownerDb.select({ body: crmNote.body }).from(crmNote).where(eq(crmNote.contactId, nina.personId))
  expect(notes.map((note) => note.body).join(" ")).toContain("Rosa Paz, DNI 42345678")
})

it("la tía: otro vínculo que abre el enlace ve solo la cita; ni presupuesto, ni consentimiento, ni sus datos", async () => {
  const f = await clinicalFixture()
  const [tia] = await ownerDb.insert(contact).values({ organizationId: ORG, displayName: "Marta Tía", givenNames: "Marta" }).returning({ id: contact.id })
  await ownerDb.insert(patientContact).values({ organizationId: ORG, patientId: f.patient.id, contactId: tia!.id, relationship: "family", createdBy: f.actor })
  const item = await f.run((tx) => addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }))
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  const link = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: tia!.id, patientId: f.patient.id }, { secretsKey: KEY }))
  const view = await f.run((tx) => getPersonalLinkView(tx, ORG, link.token))
  expect(view).toMatchObject({ budgets: [], consents: [], data: null, questionnaire: null })
  await expect(
    f.run((tx) => decidePersonalLinkBudget(tx, ORG, link.token, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] })),
  ).rejects.toMatchObject({ code: "PORTAL_FORBIDDEN" })
  await expect(
    f.run((tx) => submitPersonalLinkData(tx, ORG, link.token, { data: { birthDate: "1980-01-01" } })),
  ).rejects.toMatchObject({ code: "PORTAL_FORBIDDEN" })
  // La propia persona sí lo ve con su enlace.
  const personId = (await f.run((tx) => patientPersonId(tx, ORG, f.patient.id)))!
  const own = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: personId, patientId: f.patient.id }, { secretsKey: KEY }))
  expect((await f.run((tx) => getPersonalLinkView(tx, ORG, own.token))).budgets.map((row) => row.id)).toEqual([budget.id])
})

it("pasada su vigencia solo queda su cita; «Quitar enlace» y cambiar el vínculo lo dejan sin efecto", async () => {
  const f = await clinicalFixture()
  const personId = (await f.run((tx) => patientPersonId(tx, ORG, f.patient.id)))!
  const item = await f.run((tx) => addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }))
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  const link = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: personId, patientId: f.patient.id }, { secretsKey: KEY }))
  await ownerDb.update(appointmentBookingLink).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(appointmentBookingLink.id, link.linkId))
  expect((await f.run((tx) => getPersonalLinkView(tx, ORG, link.token))).budgets).toEqual([])
  await expect(
    f.run((tx) => decidePersonalLinkBudget(tx, ORG, link.token, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] })),
  ).rejects.toMatchObject({ code: "BOOKING_LINK_EXPIRED" })

  const fresh = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: personId, patientId: f.patient.id }, { secretsKey: KEY }))
  expect((await f.run((tx) => getPersonalLinkView(tx, ORG, fresh.token))).status).toBe("abierto")
  expect(await f.run((tx) => revokePersonalLinks(tx, ORG, f.actor, f.patient.id))).toEqual({ revoked: 1 })
  expect((await f.run((tx) => getPersonalLinkView(tx, ORG, fresh.token))).status).toBe("vencido")

  // Cambiar el vínculo de quien lo tenía también lo deja sin efecto.
  const [madre] = await ownerDb.insert(contact).values({ organizationId: ORG, displayName: "Elsa Madre" }).returning({ id: contact.id })
  await f.run((tx) => setPatientContact(tx, ORG, f.actor, f.patient.id, { contactId: madre!.id, relationship: "guardian", isPreferred: false }))
  const hers = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: madre!.id, patientId: f.patient.id }, { secretsKey: KEY }))
  await f.run((tx) => setPatientContact(tx, ORG, f.actor, f.patient.id, { contactId: madre!.id, relationship: "family", isPreferred: false }))
  const [row] = await ownerDb.select({ revokedAt: appointmentBookingLink.revokedAt }).from(appointmentBookingLink).where(eq(appointmentBookingLink.id, hers.linkId))
  expect(row?.revokedAt).toBeInstanceOf(Date)
})

it("el token de «Su enlace» no queda en el mensaje: se guarda una referencia que el worker resuelve al enviar", () => {
  const linkId = randomUUID()
  const stored = `Hola. Mira aquí: https://norte.odentia.test/reserva?token=${personalLinkRef(linkId)}`
  expect(stored).not.toMatch(/[0-9a-f]{64}/)
  const sent = resolvePersonalLinkRefs(stored, KEY)
  expect(sent).toBe(`Hola. Mira aquí: https://norte.odentia.test/reserva?token=${personalLinkToken(KEY, linkId)}`)
  expect(hidePersonalLinkRefs(stored)).toBe("Hola. Mira aquí: https://norte.odentia.test/reserva?token=…")
})

it("el consentimiento se firma en su enlace con su documento y el profesional lo confirma en la cita", async () => {
  const f = await clinicalFixture()
  const lucia = await f.run((tx) =>
    createPatient(tx, ORG, f.actor, {
      displayName: "Lucía Fernández",
      givenNames: "Lucía",
      familyName: "Fernández",
      birthDate: "1995-07-30",
      docType: "DNI",
      docNumber: "40000004",
      phone: "+51911222333",
    }),
  )
  const personId = (await f.run((tx) => patientPersonId(tx, ORG, lucia.id)))!
  const draft = await f.run((tx) =>
    createConsentTemplate(tx, ORG, f.actor, {
      key: `t-${randomUUID().slice(0, 8)}`,
      title: "Exodoncia",
      sections: {
        procedure: "Extracción de la pieza dentaria con anestesia local.",
        benefits: ["Quitar el dolor"],
        risks: ["Sangrado los primeros días"],
        alternatives: ["Tratamiento de conductos"],
        consequences: "La infección puede avanzar.",
      },
    }),
  )
  const template = await f.run((tx) => publishConsentTemplate(tx, ORG, f.actor, draft.id))
  const consent = await f.run((tx) => createConsentDocument(tx, ORG, f.actor, { templateId: template.id, patientId: lucia.id, procedureRef: "Exodoncia de la pieza 38" }))
  const link = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: personId, patientId: lucia.id }, { secretsKey: KEY }))
  // Sin enviarlo a firmar, no aparece en su enlace (solo «Tus mensajes», ADR 0040).
  expect((await f.run((tx) => getPersonalLinkView(tx, ORG, link.token))).consents).toEqual([])
  await f.run((tx) => markConsentSentByLink(tx, ORG, f.actor, consent.id))
  expect((await f.run((tx) => getPersonalLinkView(tx, ORG, link.token))).consents).toEqual([{ id: consent.id, title: "Exodoncia" }])

  const strokes = { strokes: [[[10, 10], [200, 120]]] }
  // El documento que escribe se compara con el de su registro.
  await expect(
    f.run((tx) => signPersonalLinkConsent(tx, ORG, link.token, consent.id, { docNumber: "99999999", comprehensionConfirmed: true, signatureData: strokes })),
  ).rejects.toMatchObject({ code: "VALIDATION" })
  await f.run((tx) =>
    signPersonalLinkConsent(
      tx,
      ORG,
      link.token,
      consent.id,
      { docNumber: "40.000.004", comprehensionConfirmed: true, signatureData: strokes },
      { ip: "203.0.113.7", userAgent: "Mozilla/5.0 (Android)" },
    ),
  )
  const [signed] = await ownerDb.select().from(consentDocument).where(eq(consentDocument.id, consent.id))
  // Firmó la persona, pero sigue pendiente hasta que el profesional la informe y confirme.
  expect(signed).toMatchObject({ status: "pendiente", signatureMethod: "enlace", signerKind: "paciente", signerContactId: personId })
  expect(signed?.personSignedAt).toBeInstanceOf(Date)
  // Firmó a distancia: queda desde dónde y la declaración que aceptó (#47).
  expect(signed).toMatchObject({ personSignedIp: "203.0.113.7", personSignedUserAgent: "Mozilla/5.0 (Android)" })
  expect(signed?.declarationSnapshot).toMatch(/He leído y comprendido/)
  expect((await f.run((tx) => getPersonalLinkView(tx, ORG, link.token))).consents).toEqual([])
  await f.run((tx) => confirmLinkSignedConsent(tx, ORG, f.actor, consent.id))
  const [confirmed] = await ownerDb.select().from(consentDocument).where(eq(consentDocument.id, consent.id))
  expect(confirmed).toMatchObject({ status: "firmado", signatureMethod: "enlace", signatureLevel: "simple", informedBy: f.actor })
})

/** Sofi encendida o apagada, en la clínica que comparten las pruebas de este archivo. */
async function setSofi(enabled: boolean) {
  await ownerDb
    .insert(agentConfig)
    .values({ organizationId: ORG, enabled })
    .onConflictDoUpdate({ target: agentConfig.organizationId, set: { enabled } })
}

/** Su conversación de WhatsApp, con Sofi encendida; `wrote`: cuándo escribió por última vez. */
async function chatOf(contactId: string, wrote: Date | null) {
  const phone = `519${randomUUID().replace(/\D/g, "").padEnd(8, "0").slice(0, 8)}`
  await setSofi(true)
  // Un solo número por clínica: las pruebas de este archivo comparten el suyo.
  const [existing] = await ownerDb
    .select({ id: channelConnection.id })
    .from(channelConnection)
    .where(and(eq(channelConnection.organizationId, ORG), eq(channelConnection.channel, "whatsapp")))
  const [connection] = existing
    ? [existing]
    : await ownerDb
        .insert(channelConnection)
        .values({
          organizationId: ORG, channel: "whatsapp", provider: "whatsapp_cloud_api", displayName: "WA",
          externalId: `wa-${randomUUID().slice(0, 8)}`, configEncrypted: "prueba", webhookSecret: "prueba", status: "active",
        })
        .returning({ id: channelConnection.id })
  const [identity] = await ownerDb
    .insert(contactIdentity)
    .values({ organizationId: ORG, contactId, channel: "whatsapp", externalUserId: phone, isPrimary: true })
    .returning({ id: contactIdentity.id })
  const [thread] = await ownerDb
    .insert(conversation)
    .values({
      organizationId: ORG, contactId, contactIdentityId: identity!.id, channelConnectionId: connection!.id,
      externalThreadId: phone, lastInboundAt: wrote,
    })
    .returning({ id: conversation.id })
  return thread!.id
}

/** Una persona con un consentimiento por firmar y su conversación de WhatsApp; `wrote`: cuándo escribió por última vez. */
async function consentInChat(f: Awaited<ReturnType<typeof clinicalFixture>>, wrote: Date | null) {
  const digits = randomUUID().replace(/\D/g, "").padEnd(16, "0")
  const docNumber = digits.slice(0, 8)
  const phone = `519${digits.slice(8, 16)}`
  const lucia = await f.run((tx) =>
    createPatient(tx, ORG, f.actor, {
      displayName: "Lucía Fernández",
      givenNames: "Lucía",
      familyName: "Fernández",
      birthDate: "1995-07-30",
      docType: "DNI",
      docNumber,
      phone: `+${phone}`,
    }),
  )
  const personId = (await f.run((tx) => patientPersonId(tx, ORG, lucia.id)))!
  const draft = await f.run((tx) =>
    createConsentTemplate(tx, ORG, f.actor, {
      key: `t-${randomUUID().slice(0, 8)}`,
      title: "Exodoncia",
      sections: {
        procedure: "Extracción de la pieza dentaria con anestesia local.",
        benefits: ["Quitar el dolor"],
        risks: ["Sangrado los primeros días"],
        alternatives: ["Tratamiento de conductos"],
        consequences: "La infección puede avanzar.",
      },
    }),
  )
  const template = await f.run((tx) => publishConsentTemplate(tx, ORG, f.actor, draft.id))
  const consent = await f.run((tx) =>
    createConsentDocument(tx, ORG, f.actor, { templateId: template.id, patientId: lucia.id, procedureRef: "Exodoncia de la pieza 38" }),
  )
  const conversationId = await chatOf(personId, wrote)
  return { patientId: lucia.id, personId, docNumber, consentId: consent.id, conversationId, templateId: template.id }
}

const FINGER = { strokes: [[[10, 10], [200, 120]]] }

async function agentTexts(conversationId: string) {
  const rows = await ownerDb
    .select({ body: message.body })
    .from(message)
    .where(and(eq(message.conversationId, conversationId), eq(message.senderKind, "agent")))
  return rows.map((row) => row.body ?? "")
}

it("firmar en su enlace: la historia y el PDF lo dicen, se avisa a quien lo generó y Sofi le agradece por su chat", async () => {
  const f = await clinicalFixture()
  const lucia = await consentInChat(f, new Date())
  const link = await f.run((tx) =>
    issuePersonalLink(tx, ORG, { contactId: lucia.personId, patientId: lucia.patientId, conversationId: lucia.conversationId }, { secretsKey: KEY }),
  )
  await f.run((tx) => markConsentSentByLink(tx, ORG, f.actor, lucia.consentId))
  const penSignatures = vi.spyOn(DocumentKit.prototype, "penSignatures")
  const stateBox = vi.spyOn(DocumentKit.prototype, "stateBox")
  const open = () =>
    f.run((tx) => renderHealthDocumentPdf(tx, ORG, lucia.patientId, "consent", lucia.consentId, {}, { viewing: true }))
  try {
    // Sin firmar: la hoja para firmar en papel, con los recuadros vacíos.
    await open()
    expect(penSignatures.mock.lastCall?.[0][0]?.strokes).toBeNull()
    expect(stateBox).not.toHaveBeenCalled()

    await f.run((tx) =>
      signPersonalLinkConsent(
        tx, ORG, link.token, lucia.consentId,
        { docNumber: lucia.docNumber, comprehensionConfirmed: true, signatureData: FINGER },
        {},
        { secretsKey: KEY },
      ),
    )

    // Firmado por la persona: su trazo y que falta confirmarlo.
    await open()
    expect(penSignatures.mock.lastCall?.[0][0]?.strokes).toEqual(FINGER.strokes)
    expect(stateBox).toHaveBeenCalledWith(expect.objectContaining({ title: "FALTA CONFIRMAR" }))
  } finally {
    penSignatures.mockRestore()
    stateBox.mockRestore()
  }

  const history = await f.run((tx) => listConsentEvents(tx, ORG, lucia.consentId))
  expect(history.map((event) => event.toStatus)).toEqual(["pendiente", "enlace_enviado", "enlace_firmado"])
  expect(history.at(-1)).toMatchObject({ actorUserId: null, reason: "paciente: Lucía Fernández" })

  // Sofi agradece sin nombrar el procedimiento: recepción lee la conversación y no la historia.
  const [thanks, ...others] = await agentTexts(lucia.conversationId)
  expect(others).toEqual([])
  expect(thanks).toBe("Gracias por firmar el consentimiento. El odontólogo lo revisará antes de empezar.")
  expect(thanks).not.toContain("Exodoncia")
  const actions = await ownerDb.select().from(agentActionLog).where(eq(agentActionLog.conversationId, lucia.conversationId))
  expect(actions).toEqual([expect.objectContaining({ kind: "enlace", title: "recibió la firma de un consentimiento" })])
  expect(JSON.stringify(actions)).not.toContain("Exodoncia")

  const notices = await ownerDb.select().from(workspaceNotification).where(eq(workspaceNotification.userId, f.actor))
  expect(notices.map((notice) => notice.title)).toContain("Firmaron un consentimiento desde su enlace")

  // La atención lo sabe: no se le pide otra firma, se confirma.
  await f.run((tx) => confirmLinkSignedConsent(tx, ORG, f.actor, lucia.consentId))
  const after = await f.run((tx) => listConsentEvents(tx, ORG, lucia.consentId))
  expect(after.map((event) => event.toStatus)).toEqual(["pendiente", "enlace_enviado", "enlace_firmado", "informado", "firmado"])
  expect(await agentTexts(lucia.conversationId)).toHaveLength(1)
})

it("en latidIA, Sofi agradece con las palabras de su producto", async () => {
  const f = await clinicalFixture()
  const lucia = await consentInChat(f, new Date())
  const link = await f.run((tx) =>
    issuePersonalLink(tx, ORG, { contactId: lucia.personId, patientId: lucia.patientId, conversationId: lucia.conversationId }, { secretsKey: KEY }),
  )
  await f.run((tx) => markConsentSentByLink(tx, ORG, f.actor, lucia.consentId))
  await ownerDb.update(orgProfile).set({ product: "medical" }).where(eq(orgProfile.organizationId, ORG))
  try {
    await f.run((tx) =>
      signPersonalLinkConsent(
        tx, ORG, link.token, lucia.consentId,
        { docNumber: lucia.docNumber, comprehensionConfirmed: true, signatureData: FINGER },
        {},
        { secretsKey: KEY },
      ),
    )
  } finally {
    await ownerDb.update(orgProfile).set({ product: "dental" }).where(eq(orgProfile.organizationId, ORG))
  }
  expect((await agentTexts(lucia.conversationId))[0]).toContain("El médico lo revisará")
})

it("con Sofi apagada nadie escribe en su nombre: la firma vale y queda la nota del caso", async () => {
  const f = await clinicalFixture()
  const lucia = await consentInChat(f, new Date())
  const link = await f.run((tx) =>
    issuePersonalLink(tx, ORG, { contactId: lucia.personId, patientId: lucia.patientId, conversationId: lucia.conversationId }, { secretsKey: KEY }),
  )
  await f.run((tx) => markConsentSentByLink(tx, ORG, f.actor, lucia.consentId))
  await setSofi(false)
  try {
    await f.run((tx) =>
      signPersonalLinkConsent(
        tx, ORG, link.token, lucia.consentId,
        { docNumber: lucia.docNumber, comprehensionConfirmed: true, signatureData: FINGER },
        {},
        { secretsKey: KEY },
      ),
    )
  } finally {
    await setSofi(true)
  }
  const [signed] = await ownerDb.select().from(consentDocument).where(eq(consentDocument.id, lucia.consentId))
  expect(signed?.personSignedAt).toBeInstanceOf(Date)
  expect(await agentTexts(lucia.conversationId)).toEqual([])
  expect(await ownerDb.select().from(agentActionLog).where(eq(agentActionLog.conversationId, lucia.conversationId))).toEqual([])
  const [memory] = await ownerDb.select().from(agentCaseMemory).where(eq(agentCaseMemory.conversationId, lucia.conversationId))
  expect(JSON.stringify(memory?.notes)).toContain("Firmó un consentimiento desde su enlace")
})

/** Meta aprobó «Recibido desde su enlace» en el número de la clínica, solo durante esta prueba. */
async function approveLinkReceived() {
  const [connection] = await ownerDb
    .select({ id: channelConnection.id })
    .from(channelConnection)
    .where(and(eq(channelConnection.organizationId, ORG), eq(channelConnection.channel, "whatsapp")))
  await ownerDb.insert(channelTemplate).values({
    organizationId: ORG,
    connectionId: connection!.id,
    name: "odentia_enlace_recibido_v1",
    language: "es",
    status: "aprobada",
    category: "utility",
    body: "Hola, {{1}}. {{2}} ya recibió lo que completaste desde tu enlace. Gracias por tu tiempo.",
    variables: 2,
  })
  onTestFinished(async () => {
    await ownerDb
      .delete(channelTemplate)
      .where(and(eq(channelTemplate.organizationId, ORG), eq(channelTemplate.name, "odentia_enlace_recibido_v1")))
  })
}

const TWO_DAYS_AGO = () => new Date(Date.now() - 48 * 3_600_000)

async function sentToChat(conversationId: string) {
  return ownerDb
    .select({ body: message.body, contentType: message.contentType, templateName: message.templateName, params: message.templateParams, status: message.status })
    .from(message)
    .where(and(eq(message.conversationId, conversationId), eq(message.senderKind, "agent")))
}

async function signWith(f: Awaited<ReturnType<typeof clinicalFixture>>, token: string, lucia: { consentId: string; docNumber: string }) {
  await f.run((tx) => markConsentSentByLink(tx, ORG, f.actor, lucia.consentId))
  await f.run((tx) =>
    signPersonalLinkConsent(
      tx, ORG, token, lucia.consentId,
      { docNumber: lucia.docNumber, comprehensionConfirmed: true, signatureData: FINGER },
      {},
      { secretsKey: KEY },
    ),
  )
}

it("pasadas las 24 horas, la firma se agradece con el mensaje aprobado, uno solo al día y sin nombrar el procedimiento", async () => {
  const f = await clinicalFixture()
  const lucia = await consentInChat(f, TWO_DAYS_AGO())
  await approveLinkReceived()
  const link = await f.run((tx) =>
    issuePersonalLink(tx, ORG, { contactId: lucia.personId, patientId: lucia.patientId, conversationId: lucia.conversationId }, { secretsKey: KEY }),
  )
  await signWith(f, link.token, lucia)
  const [thanks, ...others] = await sentToChat(lucia.conversationId)
  expect(others).toEqual([])
  expect(thanks).toMatchObject({ contentType: "template", templateName: "odentia_enlace_recibido_v1", status: "queued" })
  expect(thanks?.params).toEqual(["Lucía", expect.any(String)])
  expect(thanks?.body).toMatch(/^Hola, Lucía\. .+ ya recibió lo que completaste desde tu enlace\. Gracias por tu tiempo\.$/)
  expect(thanks?.body).not.toContain("Exodoncia")
  const actions = await ownerDb.select().from(agentActionLog).where(eq(agentActionLog.conversationId, lucia.conversationId))
  expect(actions).toEqual([expect.objectContaining({ kind: "enlace", title: "recibió la firma de un consentimiento" })])

  // Otra firma el mismo día: Meta cobra cada mensaje y el primero ya sirve para todo.
  const second = await f.run((tx) =>
    createConsentDocument(tx, ORG, f.actor, { templateId: lucia.templateId, patientId: lucia.patientId, procedureRef: "Exodoncia de la pieza 18" }),
  )
  await signWith(f, link.token, { consentId: second.id, docNumber: lucia.docNumber })
  const [signedAgain] = await ownerDb.select().from(consentDocument).where(eq(consentDocument.id, second.id))
  expect(signedAgain?.personSignedAt).toBeInstanceOf(Date)
  expect(await sentToChat(lucia.conversationId)).toHaveLength(1)
  // Queda anotada igual: el caso dice las dos.
  expect(await ownerDb.select().from(agentActionLog).where(eq(agentActionLog.conversationId, lucia.conversationId))).toHaveLength(2)

  // El agradecimiento no le quita a recepción poder escribirle: otro mensaje aprobado sale igual.
  const [connection] = await ownerDb
    .select({ id: channelConnection.id })
    .from(channelConnection)
    .where(and(eq(channelConnection.organizationId, ORG), eq(channelConnection.channel, "whatsapp")))
  await ownerDb.insert(channelTemplate).values({
    organizationId: ORG,
    connectionId: connection!.id,
    name: "odentia_retomar_conversacion_v1",
    language: "es",
    status: "aprobada",
    category: "utility",
    body: "Hola, {{1}}. Te escribimos de {{2}} para continuar con tu consulta. ¿Seguimos por aquí?",
    variables: 2,
  })
  onTestFinished(async () => {
    await ownerDb
      .delete(channelTemplate)
      .where(and(eq(channelTemplate.organizationId, ORG), eq(channelTemplate.name, "odentia_retomar_conversacion_v1")))
  })
  const approved = await f.run((tx) => listApprovedMessages(tx, ORG, lucia.conversationId, () => true))
  expect(approved.data.map((item) => item.id)).toEqual(["retomar_conversacion"])
})

it("pasadas las 24 horas, en latidIA sale el mismo mensaje aprobado", async () => {
  const f = await clinicalFixture()
  const lucia = await consentInChat(f, TWO_DAYS_AGO())
  await approveLinkReceived()
  const link = await f.run((tx) =>
    issuePersonalLink(tx, ORG, { contactId: lucia.personId, patientId: lucia.patientId, conversationId: lucia.conversationId }, { secretsKey: KEY }),
  )
  await ownerDb.update(orgProfile).set({ product: "medical" }).where(eq(orgProfile.organizationId, ORG))
  try {
    await signWith(f, link.token, lucia)
  } finally {
    await ownerDb.update(orgProfile).set({ product: "dental" }).where(eq(orgProfile.organizationId, ORG))
  }
  expect((await sentToChat(lucia.conversationId)).map((row) => row.templateName)).toEqual(["odentia_enlace_recibido_v1"])
})

it("dentro de las 24 horas sigue saliendo el texto, que no usa el mensaje aprobado", async () => {
  const f = await clinicalFixture()
  const lucia = await consentInChat(f, new Date())
  await approveLinkReceived()
  const link = await f.run((tx) =>
    issuePersonalLink(tx, ORG, { contactId: lucia.personId, patientId: lucia.patientId, conversationId: lucia.conversationId }, { secretsKey: KEY }),
  )
  await signWith(f, link.token, lucia)
  const [thanks, ...others] = await sentToChat(lucia.conversationId)
  expect(others).toEqual([])
  expect(thanks).toMatchObject({ contentType: "text", templateName: null })
  expect(thanks?.body).toContain("Gracias por firmar el consentimiento")
})

it("pasadas las 24 horas, «No quiero ningún mensaje» y Sofi apagada también lo frenan: la firma vale", async () => {
  const f = await clinicalFixture()
  await approveLinkReceived()

  const refused = await consentInChat(f, TWO_DAYS_AGO())
  await f.run((tx) => setMessageChoice(tx, ORG, f.actor, refused.personId, { choice: "ninguno", receive: false, source: "telefono" }))
  const refusedLink = await f.run((tx) =>
    issuePersonalLink(tx, ORG, { contactId: refused.personId, patientId: refused.patientId, conversationId: refused.conversationId }, { secretsKey: KEY }),
  )
  await signWith(f, refusedLink.token, refused)
  expect(await sentToChat(refused.conversationId)).toEqual([])

  const quiet = await consentInChat(f, TWO_DAYS_AGO())
  const quietLink = await f.run((tx) =>
    issuePersonalLink(tx, ORG, { contactId: quiet.personId, patientId: quiet.patientId, conversationId: quiet.conversationId }, { secretsKey: KEY }),
  )
  await setSofi(false)
  try {
    await signWith(f, quietLink.token, quiet)
  } finally {
    await setSofi(true)
  }
  expect(await sentToChat(quiet.conversationId)).toEqual([])
  for (const id of [refused.consentId, quiet.consentId]) {
    const [signed] = await ownerDb.select().from(consentDocument).where(eq(consentDocument.id, id))
    expect(signed?.personSignedAt).toBeInstanceOf(Date)
  }
})

it("responder el presupuesto, enviar sus datos o el cuestionario y confirmar la cita también se le reconocen por su chat", async () => {
  const f = await clinicalFixture()

  // Su presupuesto: una respuesta, un mensaje; repetirla no vuelve a escribir.
  const personId = (await f.run((tx) => patientPersonId(tx, ORG, f.patient.id)))!
  const budgetChat = await chatOf(personId, new Date())
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }),
  )
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  const budgetLink = await f.run((tx) =>
    issuePersonalLink(tx, ORG, { contactId: personId, patientId: f.patient.id, conversationId: budgetChat }, { secretsKey: KEY }),
  )
  const answer = { decisions: [{ planItemId: item.id, decision: "aceptado" as const }] }
  await f.run((tx) => decidePersonalLinkBudget(tx, ORG, budgetLink.token, budget.id, answer, { secretsKey: KEY }))
  await f.run((tx) => decidePersonalLinkBudget(tx, ORG, budgetLink.token, budget.id, answer, { secretsKey: KEY }))
  expect(await agentTexts(budgetChat)).toEqual(["Gracias, ya recibimos la respuesta al presupuesto."])
  const [budgetAction] = await ownerDb.select().from(agentActionLog).where(eq(agentActionLog.conversationId, budgetChat))
  expect(budgetAction).toMatchObject({ kind: "presupuesto", title: "recibió su respuesta al presupuesto" })

  // Sus datos.
  const pedro = await minimal(f, { given: "Pedro", surname: "Ríos" })
  const dataChat = await chatOf(pedro.personId, new Date())
  const dataLink = await f.run((tx) =>
    issuePersonalLink(tx, ORG, { contactId: pedro.personId, patientId: pedro.patientId, conversationId: dataChat }, { secretsKey: KEY }),
  )
  await f.run((tx) =>
    submitPersonalLinkData(tx, ORG, dataLink.token, { data: { birthDate: "1988-02-14", docType: "DNI", docNumber: "47120836" } }, { secretsKey: KEY }),
  )
  expect(await agentTexts(dataChat)).toEqual(["Gracias, ya recibimos los datos."])

  // Con su cita por venir: confirmarla y enviar el cuestionario.
  const ana = await minimal(f, { given: "Ana", surname: "Soto" })
  const visitChat = await chatOf(ana.personId, new Date())
  const [site] = await ownerDb.insert(branch).values({ organizationId: ORG, name: "Centro", timezone: "America/Lima" }).returning({ id: branch.id })
  const room = await f.run((tx) => createRoom(tx, ORG, { branchId: site!.id, name: "Unidad dental 1" }))
  const startsAt = new Date(Date.now() + 3 * 86_400_000)
  const [visit] = await ownerDb
    .insert(appointment)
    .values({
      organizationId: ORG, branchId: site!.id, patientId: ana.patientId, professionalUserId: f.actor, roomId: room.id,
      startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), durationMin: 30,
    })
    .returning({ id: appointment.id })
  const visitLink = await f.run((tx) =>
    issuePersonalLink(tx, ORG, { contactId: ana.personId, patientId: ana.patientId, conversationId: visitChat, appointmentId: visit!.id }, { secretsKey: KEY }),
  )
  const form = await f.run((tx) =>
    createFormTemplate(tx, ORG, f.actor, {
      title: "Cuestionario previo",
      respondent: "portal",
      schema: { sections: [{ id: "salud", title: "Salud", fields: [{ id: "medicamentos", label: "Medicamentos que tomas", type: "texto_largo" }] }] },
    }),
  )
  await f.run((tx) => publishFormTemplate(tx, ORG, f.actor, form.id))
  await f.run((tx) => submitPersonalLinkQuestionnaire(tx, ORG, visitLink.token, { medicamentos: "Ninguno" }, { secretsKey: KEY }))
  await f.run((tx) => confirmBookingLinkAppointment(tx, ORG, visitLink.token, { secretsKey: KEY }))
  // Confirmarla de nuevo no dice nada más: ya estaba.
  await f.run((tx) => confirmBookingLinkAppointment(tx, ORG, visitLink.token, { secretsKey: KEY }))
  const said = await agentTexts(visitChat)
  expect(said).toHaveLength(2)
  expect(said).toContain("Gracias, ya recibimos el cuestionario. El odontólogo lo revisará antes de la cita.")
  expect(said.find((text) => text.startsWith("Listo: la cita del"))).toMatch(/quedó confirmada\.$/)
})

it("si WhatsApp ya no deja escribirle y Meta no aprobó el mensaje, la firma vale igual: no sale nada y queda en el caso", async () => {
  const f = await clinicalFixture()
  const lucia = await consentInChat(f, new Date(Date.now() - 48 * 3_600_000))
  const link = await f.run((tx) =>
    issuePersonalLink(tx, ORG, { contactId: lucia.personId, patientId: lucia.patientId, conversationId: lucia.conversationId }, { secretsKey: KEY }),
  )
  await f.run((tx) => markConsentSentByLink(tx, ORG, f.actor, lucia.consentId))
  await f.run((tx) =>
    signPersonalLinkConsent(
      tx, ORG, link.token, lucia.consentId,
      { docNumber: lucia.docNumber, comprehensionConfirmed: true, signatureData: FINGER },
      {},
      { secretsKey: KEY },
    ),
  )
  const [signed] = await ownerDb.select().from(consentDocument).where(eq(consentDocument.id, lucia.consentId))
  expect(signed?.personSignedAt).toBeInstanceOf(Date)
  expect(await agentTexts(lucia.conversationId)).toEqual([])
  const [memory] = await ownerDb.select().from(agentCaseMemory).where(eq(agentCaseMemory.conversationId, lucia.conversationId))
  expect(JSON.stringify(memory?.notes)).toContain("Firmó un consentimiento desde su enlace")
})

it("el enlace que envía el equipo queda unido a su conversación: lo que haga ahí se le responde por ese chat", async () => {
  configurePublicLinks({ webURL: "https://app.odentia.test", cookieDomain: "odentia.test" })
  try {
    const f = await clinicalFixture()
    const lucia = await consentInChat(f, new Date())
    await f.run((tx) => markConsentSentByLink(tx, ORG, f.actor, lucia.consentId))
    await f.run((tx) => sendPersonalLink(tx, ORG, f.actor, { patientId: lucia.patientId }, { secretsKey: KEY }))
    const [link] = await ownerDb
      .select()
      .from(appointmentBookingLink)
      .where(and(eq(appointmentBookingLink.organizationId, ORG), eq(appointmentBookingLink.patientId, lucia.patientId)))
    expect(link?.conversationId).toBe(lucia.conversationId)
  } finally {
    configurePublicLinks(null)
  }
})

it("«Ver y responder»: el presupuesto aparece en el mismo enlace, se responde y deja de servir al decidirlo", async () => {
  const f = await clinicalFixture()
  await ownerDb.insert(branch).values({ organizationId: ORG, name: `Sede ${randomUUID().slice(0, 6)}`, timezone: "America/Lima" })
  const personId = (await f.run((tx) => patientPersonId(tx, ORG, f.patient.id)))!
  const link = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: personId, patientId: f.patient.id }, { secretsKey: KEY }))
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }),
  )
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  // Un borrador no se ve: solo lo que se le entregó.
  expect((await f.run((tx) => getPersonalLinkView(tx, ORG, link.token))).budgets).toEqual([])
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  const view = await f.run((tx) => getPersonalLinkView(tx, ORG, link.token))
  expect(view.budgets.map((row) => row.id)).toEqual([budget.id])
  const answer = await f.run((tx) =>
    decidePersonalLinkBudget(tx, ORG, link.token, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] }),
  )
  expect(answer.budget.status).toBe("aceptado")
  // «¿Reservamos…?»: lo aceptado queda para elegir horario.
  expect(answer.toSchedule.map((line) => line.planItemId)).toEqual([item.id])
  const after = await f.run((tx) => getPersonalLinkView(tx, ORG, link.token))
  expect(after.budgets).toEqual([])
  // «Elegir horario» sigue teniendo dónde: las sedes no se van al responder.
  expect(view.branches.length).toBeGreaterThan(0)
  expect(after.branches.map((row) => row.id)).toEqual(view.branches.map((row) => row.id))
})

it("revocado no sirve, y el enlace de un correo (/c/) solo lleva a «Su enlace» con esa cita", async () => {
  configurePublicLinks({ webURL: "https://app.odentia.test", cookieDomain: "odentia.test" })
  try {
    const f = await clinicalFixture()
    const ana = await minimal(f, { given: "Ana", surname: "Soto" })
    const issued = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: ana.personId, patientId: ana.patientId }, { secretsKey: KEY }))
    await ownerDb.update(appointmentBookingLink).set({ revokedAt: new Date() }).where(eq(appointmentBookingLink.id, issued.linkId))
    expect((await f.run((tx) => getPersonalLinkView(tx, ORG, issued.token))).status).toBe("vencido")
    await expect(
      f.run((tx) => submitPersonalLinkData(tx, ORG, issued.token, { data: { birthDate: "1980-01-01" } })),
    ).rejects.toMatchObject({ code: "BOOKING_LINK_EXPIRED" })

    // Un token de «confirmar» de un correo, aún vigente, da su enlace con esa cita.
    const [site] = await ownerDb.insert(branch).values({ organizationId: ORG, name: "Centro", timezone: "America/Lima" }).returning({ id: branch.id })
    const room = await f.run((tx) => createRoom(tx, ORG, { branchId: site!.id, name: "Unidad dental 1" }))
    const startsAt = new Date(Date.now() + 3 * 86_400_000)
    const [booked] = await ownerDb
      .insert(appointment)
      .values({
        organizationId: ORG,
        branchId: site!.id,
        patientId: ana.patientId,
        professionalUserId: f.actor,
        roomId: room.id,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60_000),
        durationMin: 30,
      })
      .returning({ id: appointment.id })
    const raw = randomUUID()
    await ownerDb.insert(automationLinkToken).values({
      tokenHash: createHash("sha256").update(raw).digest("hex"),
      organizationId: ORG,
      purpose: "confirm",
      appointmentId: booked!.id,
      contactId: ana.personId,
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    const redirect = await f.run((tx) => personalLinkForEmailToken(tx, ORG, raw, { secretsKey: KEY }))
    // La dirección es la de la clínica, con su subdominio, y el enlace muestra esa cita.
    expect(redirect.url).toBe(`https://norte.odentia.test/reserva?token=${redirect.token}`)
    const view = await f.run((tx) => getPersonalLinkView(tx, ORG, redirect.token))
    expect(view.appointment).toMatchObject({ canConfirm: true, canChange: true, branchName: "Centro" })
    // Un token vencido, o uno que no existe, ya no lleva a ningún lado.
    await expect(f.run((tx) => personalLinkForEmailToken(tx, ORG, randomUUID(), { secretsKey: KEY }))).rejects.toMatchObject({
      code: "BOOKING_LINK_EXPIRED",
    })
  } finally {
    configurePublicLinks(null)
  }
})

it("lo aceptado se reserva una sola vez, y solo quien decide por el paciente", async () => {
  const f = await clinicalFixture()
  const personId = (await f.run((tx) => patientPersonId(tx, ORG, f.patient.id)))!
  const item = await f.run((tx) => addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }))
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  const link = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: personId, patientId: f.patient.id }, { secretsKey: KEY }))
  await f.run((tx) => decidePersonalLinkBudget(tx, ORG, link.token, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] }))

  const [site] = await ownerDb.insert(branch).values({ organizationId: ORG, name: `Sede ${randomUUID().slice(0, 6)}`, timezone: "America/Lima" }).returning({ id: branch.id })
  await f.run((tx) => createRoom(tx, ORG, { branchId: site!.id, name: "Unidad dental 1" }))
  await f.run((tx) =>
    setProfessionalSchedule(tx, ORG, f.actor, {
      branchId: site!.id,
      professionalUserId: f.actor,
      rules: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMin: 8 * 60, endMin: 20 * 60 })),
    }),
  )
  const from = new Date(Date.now() + 2 * 86_400_000)
  from.setUTCHours(5, 0, 0, 0)
  const range = { branchId: site!.id, from: from.toISOString(), to: new Date(from.getTime() + 86_400_000).toISOString() }
  const { slots } = await f.run((tx) => listBookingLinkSlots(tx, ORG, link.token, range))
  const [first, second] = slots
  if (!first || !second) throw new Error("Sin horarios")
  const pick = (slot: typeof first) => ({ branchId: site!.id, startsAt: slot.startsAt, professionalUserId: slot.professionalUserId, ...(slot.roomId ? { roomId: slot.roomId } : {}), planItemIds: [item.id] })
  await f.run((tx) => reserveBookingLink(tx, ORG, link.token, pick(first)))
  // Un segundo toque, o el mismo tratamiento en otro horario, no crea otra cita.
  await expect(f.run((tx) => reserveBookingLink(tx, ORG, link.token, pick(second)))).rejects.toMatchObject({ code: "BOOKING_ALREADY_SCHEDULED" })
  const booked = await ownerDb.select({ id: appointment.id }).from(appointment).where(eq(appointment.patientId, f.patient.id))
  expect(booked).toHaveLength(1)

  // La tía no agenda lo aceptado por su sobrina.
  const [tia] = await ownerDb.insert(contact).values({ organizationId: ORG, displayName: "Marta Tía" }).returning({ id: contact.id })
  await ownerDb.insert(patientContact).values({ organizationId: ORG, patientId: f.patient.id, contactId: tia!.id, relationship: "family", createdBy: f.actor })
  const hers = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: tia!.id, patientId: f.patient.id }, { secretsKey: KEY }))
  await expect(f.run((tx) => reserveBookingLink(tx, ORG, hers.token, pick(second)))).rejects.toMatchObject({ code: "PORTAL_FORBIDDEN" })
})

it("«Tus datos y tu salud»: la salud se pregunta solo si nadie la registró y entra declarada", async () => {
  const f = await clinicalFixture()
  const lia = await minimal(f, { given: "Lía", surname: "Paz" })
  const link = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: lia.personId, patientId: lia.patientId }, { secretsKey: KEY }))
  const view = await f.run((tx) => getPersonalLinkView(tx, ORG, link.token))
  expect(view.data?.health).toBe(true)
  const form = await f.run((tx) => getPersonalLinkDataForm(tx, ORG, link.token))
  expect(form).toMatchObject({ asksHealth: true, firstName: "Lía" })
  expect(form.registration.fields).toBeDefined()

  await f.run((tx) =>
    submitPersonalLinkData(tx, ORG, link.token, {
      data: { birthDate: "1992-06-01" },
      health: { allergies: { state: "recorded", items: [{ substance: "Penicilina", severity: "desconocida" }] } },
    }),
  )
  const health = await f.run((tx) => getPatientHealth(tx, ORG, lia.patientId))
  expect(health.revision).toBeGreaterThan(0)
  expect(health.allergies.map((item) => item.substance)).toContain("Penicilina")
  const notes = await ownerDb.select({ body: crmNote.body }).from(crmNote).where(eq(crmNote.contactId, lia.personId))
  expect(notes.map((note) => note.body).join(" ")).toContain("Declaró su salud")
})

it("al confirmar la cita del agente, a quien le faltan datos se le da su enlace; a quien no, nada", async () => {
  const f = await clinicalFixture()
  configurePublicLinks({ webURL: "https://app.odentia.test", cookieDomain: "odentia.test" })
  try {
    const tomas = await minimal(f, { given: "Tomás", surname: "Vega" })
    const ask = () =>
      f.run((tx) => bookedDataLink(tx, ORG, { contactId: tomas.personId, patientId: tomas.patientId, appointmentId: null }, { secretsKey: KEY }))
    const data = await ask()
    expect(data?.missing).toContain("fecha de nacimiento")
    // Es su mismo enlace, con el token escrito: el que ya tiene, no otro.
    const again = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: tomas.personId, patientId: tomas.patientId }, { secretsKey: KEY }))
    expect(again.reused).toBe(true)
    expect(data?.url).toContain(again.token)

    await f.run((tx) => submitPersonalLinkData(tx, ORG, again.token, { data: { birthDate: "1990-03-03" } }))
    expect((await ask())?.missing ?? []).not.toContain("fecha de nacimiento")
  } finally {
    configurePublicLinks(null)
  }
})

it("Inicio: quien terminó su registro hoy y tiene cita hoy sale en «Te espera» hasta que llega", async () => {
  const f = await clinicalFixture()
  const carla = await minimal(f, { given: "Carla", surname: "Núñez" })
  const [site] = await ownerDb.insert(branch).values({ organizationId: ORG, name: "Centro", timezone: "UTC" }).returning({ id: branch.id })
  const room = await f.run((tx) => createRoom(tx, ORG, { branchId: site!.id, name: "Unidad dental 1" }))
  const startsAt = new Date(Date.now() + 60_000)
  const [booked] = await ownerDb
    .insert(appointment)
    .values({ organizationId: ORG, branchId: site!.id, patientId: carla.patientId, professionalUserId: f.actor, roomId: room.id, startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), durationMin: 30 })
    .returning({ id: appointment.id })
  const access: WorkspaceAccess = {
    patients: true, appointments: true, conversations: false, tasks: false, finance: false, clinical: false,
    crm: false, agent: false, allTasks: false, configure: false, ownAppointments: false,
  }
  const rows = async () =>
    (await f.run((tx) => getWorkspaceHome(tx, ORG, f.actor, access, { branchId: site!.id }))).waiting.filter((row) => row.kind === "registrationDone")
  expect(await rows()).toEqual([])

  const link = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: carla.personId, patientId: carla.patientId }, { secretsKey: KEY }))
  await f.run((tx) => submitPersonalLinkData(tx, ORG, link.token, { data: { birthDate: "1994-07-07" } }))
  expect(await rows()).toEqual([
    expect.objectContaining({ kind: "registrationDone", appointmentId: booked!.id, patientId: carla.patientId, patientName: "Carla Núñez", professionalName: "Clínico" }),
  ])

  // Llegó: la fila se va.
  await ownerDb.update(appointment).set({ status: "confirmada", arrivedAt: new Date(), arrivedBy: f.actor }).where(eq(appointment.id, booked!.id))
  expect(await rows()).toEqual([])
})

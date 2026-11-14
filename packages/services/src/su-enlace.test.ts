/**
 * «Su enlace» (fase 3, decisión 8; ADR 0037): una página por persona con lo
 * que tiene pendiente. Cada cosa sale de su regla y deja de servir cuando ya
 * no hace falta; nunca se muestra lo guardado y nunca se unen fichas solas.
 */
import { randomUUID } from "node:crypto"
import { appointment, appointmentBookingLink } from "@odentia/db/schema/agenda"
import { automationLinkToken } from "@odentia/db/schema/automation"
import { encounter, patient, patientContact, patientDataConsent, patientResponsibility } from "@odentia/db/schema/clinical"
import { clinicalFormResponse, consentDocument, consentEvent } from "@odentia/db/schema/clinical-forms"
import { agentActionLog, agentCaseMemory } from "@odentia/db/schema/agent"
import { agentConfig, channelConnection, channelTemplate, contact, contactIdentity, conversation, crmTask, message } from "@odentia/db/schema/crm"
import { crmNote } from "@odentia/db/schema/crm-workspace"
import { auditEvent, branch, orgProfile } from "@odentia/db/schema/org"
import { workspaceNotification } from "@odentia/db/schema/workspace"
import { and, eq } from "drizzle-orm"
import { createHash } from "node:crypto"
import { expect, it, onTestFinished, vi } from "vitest"
import { createRoom } from "./appointments.js"
import { invalidateAppointmentTokens, setMessageChoice } from "./automation.js"
import { listApprovedMessages } from "./clinic-messages.js"
import {
  cancelBookingLinkAppointment,
  changeBookingLinkAppointment,
  confirmBookingLinkAppointment,
  contactHandlesAppointment,
  createBookingLink,
  issueAgendaLink,
  issuePersonalLink,
  listBookingLinkSlots,
  reserveBookingLink,
  revokePersonalLinks,
} from "./booking-links.js"
import { grantResponsibility } from "./responsibilities.js"
import { setProfessionalSchedule } from "./availability.js"
import { hidePersonalLinkRefs, personalLinkRef, personalLinkToken, resolvePersonalLinkRefs } from "./personal-link-token.js"
import { createBudget, deliverBudget } from "./budgets.js"
import { sendBudget } from "./budget-send.js"
import type { Storage } from "./storage.js"
import {
  confirmLinkSignedConsent,
  createConsentDocument,
  listLinkSignedToConfirm,
  signConsentDocument,
  createConsentTemplate,
  createFormTemplate,
  listConsentDocuments,
  listConsentEvents,
  listFormResponses,
  markConsentSentByLink,
  publishConsentTemplate,
  publishFormTemplate,
} from "./clinical-forms.js"
import { clinicalFixture, seedDiagnosisCodes } from "./clinical-test-fixture.js"
import { getPatientHealth } from "./clinical.js"
import { DocumentKit } from "./document-kit.js"
import { renderHealthDocumentPdf } from "./health-documents.js"
import { getPatientSummary } from "./patient-history.js"
import { addPlanItem } from "./plan.js"
import { getPatientRegistrationConfig, savePatientRegistrationConfig } from "./patient-registration.js"
import { createPatient, patientPersonId, requirePatient, setPatientContact } from "./patients.js"
import { configurePublicLinks } from "./public-links.js"
import { getWorkspaceHome, type WorkspaceAccess } from "./workspace.js"
import {
  decidePersonalLinkBudget,
  bookedDataLink,
  getPersonalLinkConsent,
  getPersonalLinkDataForm,
  getPersonalLinkQuestionnaire,
  getPersonalLinkView,
  maskedAddress,
  personalLinkForEmailToken,
  resendPersonalLink,
  sendConsentToSign,
  sendPersonalLink,
  showPersonalLink,
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
  // Tampoco cuando el enlace ofrece reservar y muestra «Tus datos»: el celular va abreviado.
  const booking = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: pedro.personId, patientId: pedro.patientId, booking: true }, { secretsKey: KEY }))
  const bookingView = await f.run((tx) => getPersonalLinkView(tx, ORG, booking.token))
  expect(bookingView.you?.phone).toBe("•••222")
  expect(JSON.stringify(bookingView)).not.toContain("987111222")

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
    status: "abierto", data: null, budgets: [], consents: [], questionnaire: null,
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

it("la tía: otro vínculo que abre el enlace no ve el presupuesto, el consentimiento ni sus datos (y sin autorización, tampoco la cita)", async () => {
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

/** Una cita por venir del paciente, en una sede nueva. */
async function upcomingAppointment(f: Awaited<ReturnType<typeof clinicalFixture>>, patientId: string) {
  const [site] = await ownerDb
    .insert(branch)
    .values({ organizationId: ORG, name: `Sede ${randomUUID().slice(0, 6)}`, timezone: "America/Lima" })
    .returning({ id: branch.id })
  const room = await f.run((tx) => createRoom(tx, ORG, { branchId: site!.id, name: "Unidad dental 1" }))
  const startsAt = new Date(Date.now() + 3 * 86_400_000)
  const [booked] = await ownerDb
    .insert(appointment)
    .values({
      organizationId: ORG,
      branchId: site!.id,
      patientId,
      professionalUserId: f.actor,
      roomId: room.id,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      durationMin: 30,
    })
    .returning({ id: appointment.id })
  return booked!.id
}

/** Un token de «confirmar» o «cancelar» de un correo de recordatorio, para esa persona y esa cita. */
async function emailToken(appointmentId: string, contactId: string, purpose: "confirm" | "cancel" = "confirm") {
  const raw = randomUUID()
  await ownerDb.insert(automationLinkToken).values({
    tokenHash: createHash("sha256").update(raw).digest("hex"),
    organizationId: ORG,
    purpose,
    appointmentId,
    contactId,
    expiresAt: new Date(Date.now() + 3 * 86_400_000),
  })
  return raw
}

it("S3: un familiar sin autorización no ve ni maneja la cita, tampoco con un enlace que ya tenía", async () => {
  const f = await clinicalFixture()
  const appointmentId = await upcomingAppointment(f, f.patient.id)
  const [tia] = await ownerDb.insert(contact).values({ organizationId: ORG, displayName: "Marta Tía", givenNames: "Marta" }).returning({ id: contact.id })
  await ownerDb.insert(patientContact).values({ organizationId: ORG, patientId: f.patient.id, contactId: tia!.id, relationship: "family", createdBy: f.actor })
  // Un enlace que ya le llegó antes de este cambio: sigue sin mostrarle la cita ni dejarla tocar.
  const sent = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: tia!.id, patientId: f.patient.id, appointmentId }, { secretsKey: KEY }))
  expect((await f.run((tx) => getPersonalLinkView(tx, ORG, sent.token))).appointment).toBeNull()
  await expect(f.run((tx) => confirmBookingLinkAppointment(tx, ORG, sent.token))).rejects.toMatchObject({ code: "BOOKING_LINK_EXPIRED" })
  await expect(f.run((tx) => cancelBookingLinkAppointment(tx, ORG, sent.token))).rejects.toMatchObject({ code: "BOOKING_LINK_EXPIRED" })
  await expect(
    f.run((tx) => changeBookingLinkAppointment(tx, ORG, sent.token, { startsAt: new Date(Date.now() + 4 * 86_400_000).toISOString(), professionalUserId: f.actor })),
  ).rejects.toMatchObject({ code: "BOOKING_LINK_EXPIRED" })
  const [still] = await ownerDb.select({ status: appointment.status }).from(appointment).where(eq(appointment.id, appointmentId))
  expect(still?.status).toBe("programada")
  // Sofi y la Bandeja tampoco se lo dan: lo mismo que el chat le negaría.
  const conversationId = await chatOf(tia!.id, new Date())
  await expect(
    f.run((tx) => createBookingLink(tx, ORG, { conversationId, patientId: f.patient.id }, { secretsKey: KEY })),
  ).rejects.toMatchObject({ code: "PATIENT_CONTEXT_FORBIDDEN" })
  await expect(
    f.run((tx) => createBookingLink(tx, ORG, { conversationId, patientId: f.patient.id, booking: false }, { secretsKey: KEY })),
  ).rejects.toMatchObject({ code: "PATIENT_CONTEXT_FORBIDDEN" })
  await expect(
    f.run((tx) => issueAgendaLink(tx, ORG, { conversationId, patientId: f.patient.id }, { secretsKey: KEY })),
  ).rejects.toMatchObject({ code: "PATIENT_CONTEXT_FORBIDDEN" })
  // Solo la falta de autorización es «no autorizado»: un contacto desactivado no se disfraza de eso.
  expect(await f.run((tx) => contactHandlesAppointment(tx, ORG, tia!.id, f.patient.id))).toBe(false)
  const [primo] = await ownerDb.insert(contact).values({ organizationId: ORG, displayName: "Luis Primo", isActive: false }).returning({ id: contact.id })
  await ownerDb.insert(patientContact).values({ organizationId: ORG, patientId: f.patient.id, contactId: primo!.id, relationship: "family", createdBy: f.actor })
  await expect(f.run((tx) => contactHandlesAppointment(tx, ORG, primo!.id, f.patient.id))).rejects.toMatchObject({ code: "NOT_FOUND" })
  // Con su autorización vigente sí ve la cita (y nada más que la cita).
  await f.run((tx) =>
    grantResponsibility(tx, ORG, f.actor, f.patient.id, { contactId: tia!.id, kind: "autorizado_informacion", startsAt: "2020-01-01" }),
  )
  const allowed = await f.run((tx) => createBookingLink(tx, ORG, { conversationId, patientId: f.patient.id, booking: false }, { secretsKey: KEY }))
  const view = await f.run((tx) => getPersonalLinkView(tx, ORG, allowed.token))
  expect(view).toMatchObject({ appointment: { canConfirm: true }, budgets: [], consents: [], data: null })
})

it("S4: «Quitar enlace» y terminar el vínculo vencen los botones del correo; el correo de quien no tiene facultad no emite nada", async () => {
  configurePublicLinks({ webURL: "https://app.odentia.test", cookieDomain: "odentia.test" })
  try {
    const f = await clinicalFixture()
    const personId = (await f.run((tx) => patientPersonId(tx, ORG, f.patient.id)))!
    const appointmentId = await upcomingAppointment(f, f.patient.id)
    const confirm = await emailToken(appointmentId, personId, "confirm")
    const cancel = await emailToken(appointmentId, personId, "cancel")
    expect((await f.run((tx) => personalLinkForEmailToken(tx, ORG, confirm, { secretsKey: KEY }))).token).toMatch(/^[0-9a-f]{64}$/)
    // «Quitar enlace»: el botón del correo ya enviado no lo revive.
    await f.run((tx) => revokePersonalLinks(tx, ORG, f.actor, f.patient.id))
    await expect(f.run((tx) => personalLinkForEmailToken(tx, ORG, confirm, { secretsKey: KEY }))).rejects.toMatchObject({ code: "BOOKING_LINK_EXPIRED" })
    await expect(f.run((tx) => personalLinkForEmailToken(tx, ORG, cancel, { secretsKey: KEY }))).rejects.toMatchObject({ code: "BOOKING_LINK_EXPIRED" })
    // La baja nunca se toca.
    const baja = randomUUID()
    await ownerDb.insert(automationLinkToken).values({
      tokenHash: createHash("sha256").update(baja).digest("hex"),
      organizationId: ORG, purpose: "baja", contactId: personId, expiresAt: new Date(Date.now() + 30 * 86_400_000),
    })
    await f.run((tx) => revokePersonalLinks(tx, ORG, f.actor, f.patient.id))
    const [unsubscribe] = await ownerDb.select({ expiresAt: automationLinkToken.expiresAt }).from(automationLinkToken)
      .where(eq(automationLinkToken.tokenHash, createHash("sha256").update(baja).digest("hex")))
    expect(unsubscribe!.expiresAt.getTime()).toBeGreaterThan(Date.now())

    // Terminar el vínculo de la madre vence los suyos.
    const [madre] = await ownerDb.insert(contact).values({ organizationId: ORG, displayName: "Elsa Madre" }).returning({ id: contact.id })
    await f.run((tx) => setPatientContact(tx, ORG, f.actor, f.patient.id, { contactId: madre!.id, relationship: "guardian", isPreferred: false }))
    await f.run((tx) =>
      grantResponsibility(tx, ORG, f.actor, f.patient.id, { contactId: madre!.id, kind: "autorizado_informacion", startsAt: "2020-01-01" }),
    )
    const hers = await emailToken(appointmentId, madre!.id)
    await f.run((tx) => setPatientContact(tx, ORG, f.actor, f.patient.id, { contactId: madre!.id, relationship: "family", isPreferred: false }))
    const [row] = await ownerDb.select({ expiresAt: automationLinkToken.expiresAt }).from(automationLinkToken)
      .where(eq(automationLinkToken.tokenHash, createHash("sha256").update(hers).digest("hex")))
    expect(row!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now())

    // Un correo que llegó a un familiar sin autorización no le da el enlace de esa cita.
    const [tia] = await ownerDb.insert(contact).values({ organizationId: ORG, displayName: "Marta Tía" }).returning({ id: contact.id })
    await ownerDb.insert(patientContact).values({ organizationId: ORG, patientId: f.patient.id, contactId: tia!.id, relationship: "family", createdBy: f.actor })
    const tias = await emailToken(appointmentId, tia!.id)
    await expect(f.run((tx) => personalLinkForEmailToken(tx, ORG, tias, { secretsKey: KEY }))).rejects.toMatchObject({ code: "BOOKING_LINK_EXPIRED" })
    const issued = await ownerDb.select({ id: appointmentBookingLink.id }).from(appointmentBookingLink).where(eq(appointmentBookingLink.contactId, tia!.id))
    expect(issued).toEqual([])

    // Usado (la cita se movió, se canceló o se atendió: `invalidateAppointmentTokens`), ya no emite ni alarga «Su enlace».
    await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: personId, patientId: f.patient.id }, { secretsKey: KEY }))
    const used = await emailToken(appointmentId, personId, "confirm")
    expect((await f.run((tx) => personalLinkForEmailToken(tx, ORG, used, { secretsKey: KEY }))).token).toMatch(/^[0-9a-f]{64}$/)
    await f.run((tx) => invalidateAppointmentTokens(tx, ORG, appointmentId))
    await expect(f.run((tx) => personalLinkForEmailToken(tx, ORG, used, { secretsKey: KEY }))).rejects.toMatchObject({ code: "BOOKING_LINK_EXPIRED" })
  } finally {
    configurePublicLinks(null)
  }
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
  await seedDiagnosisCodes([{ code: "K02.1", title: "Caries de la dentina" }])
  const consent = await f.run((tx) =>
    createConsentDocument(tx, ORG, f.actor, { templateId: template.id, patientId: lucia.id, procedureRef: "Exodoncia de la pieza 38", diagnosisCode: "K02.1" }),
  )
  const link = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: personId, patientId: lucia.id }, { secretsKey: KEY }))
  // Sin enviarlo a firmar, no aparece en su enlace (solo «Tus mensajes», ADR 0040).
  expect((await f.run((tx) => getPersonalLinkView(tx, ORG, link.token))).consents).toEqual([])
  await f.run((tx) => markConsentSentByLink(tx, ORG, f.actor, consent.id))
  expect((await f.run((tx) => getPersonalLinkView(tx, ORG, link.token))).consents).toEqual([
    { id: consent.id, title: "Exodoncia", procedureRef: "Exodoncia de la pieza 38", appointment: null, signable: true, why: null },
  ])
  // Otra cita (una limpieza) no es la suya: sin su tratamiento agendado ahí, el consentimiento no lleva fecha.
  await upcomingAppointment(f, lucia.id)
  const withVisit = await f.run((tx) => getPersonalLinkView(tx, ORG, link.token))
  expect(withVisit.appointment).not.toBeNull()
  expect(withVisit.consents[0]?.appointment).toBeNull()
  // Lee la misma hoja que el papel: la pieza, el diagnóstico, la declaración que acepta y el pie de firma.
  const sheet = await f.run((tx) => getPersonalLinkConsent(tx, ORG, link.token, consent.id))
  expect(sheet).toMatchObject({
    procedureRef: "Exodoncia de la pieza 38",
    diagnosis: "CIE-10 MINSA · K02.1 · Caries de la dentina",
    declaration: expect.stringMatching(/^He leído y comprendido/),
    signatureWords: "Firma por enlace",
    signatureNote: expect.stringMatching(/^Tu firma queda en la historia clínica/),
    patient: { name: "Lucía Fernández", chartNumber: expect.stringMatching(/^HC-\d{6}$/) },
    signer: { name: "Lucía Fernández", asRepresentative: false, documentLabel: "DNI" },
    minor: false,
  })
  // El membrete es el del papel.
  expect(sheet.clinic.name).not.toBe("")
  // El número de su documento no viaja: lo escribe al firmar.
  expect(JSON.stringify(sheet)).not.toContain("40000004")
  // En la clínica, la lista trae la descripción del diagnóstico para la hoja de la tablet.
  const [listed] = await f.run((tx) => listConsentDocuments(tx, ORG, { patientId: lucia.id }))
  expect(listed?.diagnosisDescription).toBe("Caries de la dentina")
  // El Resumen distingue «espera su firma» de «por confirmar»: no todo pendiente está sin firmar.
  const pendingInSummary = async () => (await f.run((tx) => getPatientSummary(tx, ORG, lucia.id))).pendingConsents.find((row) => row.id === consent.id)
  expect(await pendingInSummary()).toMatchObject({ personSignedAt: null, linkSentAt: expect.any(Date) })

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
  expect(await pendingInSummary()).toMatchObject({ personSignedAt: expect.any(Date) })
  // Se confirma dentro de una atención en curso de ese paciente, nunca desde la ficha ni en la de otro.
  await expect(f.run((tx) => confirmLinkSignedConsent(tx, ORG, f.actor, consent.id, { encounterId: f.encounter.id }))).rejects.toMatchObject({
    code: "VALIDATION",
    fields: { encounterId: expect.any(String) },
  })
  const [closed] = await ownerDb
    .insert(encounter)
    .values({ organizationId: ORG, patientId: lucia.id, professionalUserId: f.actor, reason: "Control", status: "finalizada", startedAt: new Date(Date.now() - 7_200_000), endedAt: new Date(Date.now() - 3_600_000) })
    .returning({ id: encounter.id })
  await expect(f.run((tx) => confirmLinkSignedConsent(tx, ORG, f.actor, consent.id, { encounterId: closed!.id }))).rejects.toMatchObject({ code: "ENCOUNTER_CLOSED" })
  // El panel de antes (mientras dura el despliegue) confirma sin la atención: se le dice que recargue.
  await expect(f.run((tx) => confirmLinkSignedConsent(tx, ORG, f.actor, consent.id, {}))).rejects.toMatchObject({
    code: "CONFIRM_IN_ENCOUNTER",
    message: "Recarga la página: ahora se confirma dentro de su atención",
  })
  // Firmar en la tablet lo que ya firmó en su enlace pide decirlo: «Firmar de nuevo aquí».
  await expect(
    f.run((tx) =>
      signConsentDocument(tx, ORG, f.actor, consent.id, {
        signerKind: "paciente",
        signerContactId: lucia.personId,
        comprehensionConfirmed: true,
        signatureData: { strokes: [[[0, 0], [10, 10]]] },
      }),
    ),
  ).rejects.toMatchObject({ code: "LINK_SIGNED" })
  // La atención abierta en curso sirve sea del día que sea (aquí, de hace tres semanas): la
  // constancia dice el día real y a quién se informó (consentimientos, 10 nov).
  const [attention] = await ownerDb
    .insert(encounter)
    .values({ organizationId: ORG, patientId: lucia.id, professionalUserId: f.actor, reason: "Exodoncia", startedAt: new Date(Date.now() - 21 * 86_400_000) })
    .returning({ id: encounter.id })
  // La atención lo muestra arriba al abrirla, aunque se haya enviado desde Documentos: quién firmó, su documento abreviado, cuándo y qué.
  expect(await f.run((tx) => listLinkSignedToConfirm(tx, ORG, lucia.id))).toEqual([
    expect.objectContaining({
      id: consent.id,
      title: "Exodoncia",
      procedureRef: "Exodoncia de la pieza 38",
      signerName: "Lucía Fernández",
      signerKind: "paciente",
      signerDocument: "DNI ••••0004",
      personSignedAt: expect.any(Date),
    }),
  ])
  expect(JSON.stringify(await f.run((tx) => listLinkSignedToConfirm(tx, ORG, lucia.id)))).not.toContain("40000004")
  await f.run((tx) => confirmLinkSignedConsent(tx, ORG, f.actor, consent.id, { encounterId: attention!.id }))
  const [confirmed] = await ownerDb.select().from(consentDocument).where(eq(consentDocument.id, consent.id))
  expect(confirmed).toMatchObject({
    status: "firmado", signatureMethod: "enlace", signatureLevel: "simple", informedBy: f.actor, informedEncounterId: attention!.id,
  })
  expect(await f.run((tx) => listLinkSignedToConfirm(tx, ORG, lucia.id))).toEqual([])
  // La historia dice en qué atención.
  const history = await f.run((tx) => listConsentEvents(tx, ORG, consent.id))
  expect(history.find((event) => event.toStatus === "informado")?.reason).toMatch(/informó a .+ \(paciente\) · en la atención del .+, confirmado el .+ con la persona delante/)
  expect(await pendingInSummary()).toBeUndefined()
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

/** Un consentimiento enviado a firmar por enlace para ese paciente. */
async function sentToSign(f: Awaited<ReturnType<typeof clinicalFixture>>, patientId: string) {
  const draft = await f.run((tx) =>
    createConsentTemplate(tx, ORG, f.actor, {
      key: `t-${randomUUID().slice(0, 8)}`,
      title: "Exodoncia",
      sections: { procedure: "Extracción con anestesia local.", benefits: ["Quitar el dolor"], risks: ["Sangrado"], alternatives: ["Endodoncia"], consequences: "Puede avanzar." },
    }),
  )
  const template = await f.run((tx) => publishConsentTemplate(tx, ORG, f.actor, draft.id))
  const consent = await f.run((tx) =>
    createConsentDocument(tx, ORG, f.actor, { templateId: template.id, patientId, procedureRef: "Exodoncia de la pieza 38" }),
  )
  await f.run((tx) => markConsentSentByLink(tx, ORG, f.actor, consent.id))
  return consent.id
}

it("sin documento en la ficha de quien firma, sin fecha de nacimiento o menor: se lee la hoja y se firma en la cita", async () => {
  const f = await clinicalFixture()
  // Adulta sin documento en su ficha: cualquier número que escriba no se compara con nada.
  const ana = await f.run((tx) =>
    createPatient(tx, ORG, f.actor, { displayName: "Ana Soto", givenNames: "Ana", familyName: "Soto", birthDate: "1990-01-01", phone: "+51911000111" }),
  )
  const anaPerson = (await f.run((tx) => patientPersonId(tx, ORG, ana.id)))!
  const anaConsent = await sentToSign(f, ana.id)
  const anaLink = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: anaPerson, patientId: ana.id }, { secretsKey: KEY }))
  await expect(
    f.run((tx) => signPersonalLinkConsent(tx, ORG, anaLink.token, anaConsent, { docNumber: "12345678", comprehensionConfirmed: true, signatureData: FINGER })),
  ).rejects.toMatchObject({ code: "SIGNER_NOT_AUTHORIZED", message: expect.stringContaining("en tu cita") })
  expect(await f.run((tx) => getPersonalLinkConsent(tx, ORG, anaLink.token, anaConsent))).toMatchObject({
    signable: false,
    why: "sin-documento",
    speaksTo: "paciente",
    patientFirstName: "Ana",
    procedureRef: "Exodoncia de la pieza 38",
  })
  const [unsigned] = await ownerDb.select({ personSignedAt: consentDocument.personSignedAt }).from(consentDocument).where(eq(consentDocument.id, anaConsent))
  expect(unsigned?.personSignedAt).toBeNull()

  // Sin fecha de nacimiento no se sabe si es mayor de edad.
  const beto = await f.run((tx) =>
    createPatient(tx, ORG, f.actor, { displayName: "Beto Paz", givenNames: "Beto", familyName: "Paz", docType: "DNI", docNumber: "40000123", phone: "+51911000222" }),
  )
  const betoPerson = (await f.run((tx) => patientPersonId(tx, ORG, beto.id)))!
  const betoConsent = await sentToSign(f, beto.id)
  const betoLink = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: betoPerson, patientId: beto.id }, { secretsKey: KEY }))
  expect(await f.run((tx) => getPersonalLinkConsent(tx, ORG, betoLink.token, betoConsent))).toMatchObject({ signable: false, why: "sin-fecha" })

  // Mateo, de 8 años: su madre decide por él. Sin su documento en la ficha, lo firma ella en la cita.
  const mateo = await f.run((tx) =>
    createPatient(tx, ORG, f.actor, { displayName: "Mateo Ruiz", givenNames: "Mateo", familyName: "Ruiz", birthDate: `${new Date().getUTCFullYear() - 8}-03-10` }),
  )
  const [madre] = await ownerDb.insert(contact).values({ organizationId: ORG, displayName: "Rosa Ruiz", givenNames: "Rosa" }).returning({ id: contact.id })
  await ownerDb.insert(patientContact).values({ organizationId: ORG, patientId: mateo.id, contactId: madre!.id, relationship: "guardian", createdBy: f.actor })
  await ownerDb.insert(patientResponsibility).values({ organizationId: ORG, patientId: mateo.id, contactId: madre!.id, kind: "representante_legal", startsAt: "2020-01-01" })
  const mateoConsent = await sentToSign(f, mateo.id)
  const hers = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: madre!.id, patientId: mateo.id }, { secretsKey: KEY }))
  expect(await f.run((tx) => getPersonalLinkConsent(tx, ORG, hers.token, mateoConsent))).toMatchObject({
    signable: false, why: "sin-documento", speaksTo: "representante", patientFirstName: "Mateo", minor: true,
  })
  await expect(
    f.run((tx) => signPersonalLinkConsent(tx, ORG, hers.token, mateoConsent, { docNumber: "41111111", comprehensionConfirmed: true, signatureData: FINGER })),
  ).rejects.toMatchObject({ code: "SIGNER_NOT_AUTHORIZED" })
  // Con su documento en la ficha, la madre sí lo firma desde su teléfono.
  await ownerDb.update(contact).set({ docType: "DNI", docNumber: "41111111" }).where(eq(contact.id, madre!.id))
  expect(await f.run((tx) => getPersonalLinkConsent(tx, ORG, hers.token, mateoConsent))).toMatchObject({ signable: true, why: null })
  await f.run((tx) => signPersonalLinkConsent(tx, ORG, hers.token, mateoConsent, { docNumber: "41111111", comprehensionConfirmed: true, signatureData: FINGER }))
  const [signed] = await ownerDb.select({ signerKind: consentDocument.signerKind }).from(consentDocument).where(eq(consentDocument.id, mateoConsent))
  expect(signed?.signerKind).toBe("representante")
})

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

  // La atención lo sabe: no se le pide otra firma, se confirma ahí, y el PDF dice en cuál. Vale la
  // que se abrió antes para su cita de hoy.
  const today = await upcomingAppointment(f, lucia.patientId)
  await ownerDb.update(appointment).set({ startsAt: new Date(), endsAt: new Date(Date.now() + 1_800_000) }).where(eq(appointment.id, today))
  const [attention] = await ownerDb
    .insert(encounter)
    .values({ organizationId: ORG, patientId: lucia.patientId, professionalUserId: f.actor, reason: "Exodoncia", appointmentId: today, startedAt: new Date(Date.now() - 2 * 86_400_000) })
    .returning({ id: encounter.id })
  await f.run((tx) => confirmLinkSignedConsent(tx, ORG, f.actor, lucia.consentId, { encounterId: attention!.id }))
  const lines = vi.spyOn(DocumentKit.prototype, "text")
  try {
    await f.run((tx) => renderHealthDocumentPdf(tx, ORG, lucia.patientId, "consent", lucia.consentId, {}, { viewing: true }))
    expect(lines.mock.calls.map((call) => call[0])).toContainEqual(expect.stringMatching(/^Confirmado en la atención del /))
  } finally {
    lines.mockRestore()
  }
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

it("un enlace sin conversación, como el de un recordatorio o un presupuesto, se responde por su WhatsApp", async () => {
  const f = await clinicalFixture()
  const lucia = await consentInChat(f, TWO_DAYS_AGO())
  await approveLinkReceived()
  const link = await f.run((tx) =>
    issuePersonalLink(tx, ORG, { contactId: lucia.personId, patientId: lucia.patientId, createdBy: f.actor }, { secretsKey: KEY }),
  )
  await signWith(f, link.token, lucia)
  expect((await sentToChat(lucia.conversationId)).map((row) => row.templateName)).toEqual(["odentia_enlace_recibido_v1"])
  const [memory] = await ownerDb.select().from(agentCaseMemory).where(eq(agentCaseMemory.conversationId, lucia.conversationId))
  expect(JSON.stringify(memory?.notes)).toContain("Firmó un consentimiento desde su enlace")
})

it("el último envío decide por qué conversación se le responde", async () => {
  const f = await clinicalFixture()
  const lucia = await consentInChat(f, new Date())
  const older = await chatOf(lucia.personId, new Date())
  await f.run((tx) =>
    issuePersonalLink(tx, ORG, { contactId: lucia.personId, patientId: lucia.patientId, conversationId: older }, { secretsKey: KEY }),
  )
  const link = await f.run((tx) =>
    issuePersonalLink(tx, ORG, { contactId: lucia.personId, patientId: lucia.patientId, conversationId: lucia.conversationId }, { secretsKey: KEY }),
  )
  await signWith(f, link.token, lucia)
  expect(await agentTexts(older)).toEqual([])
  expect((await agentTexts(lucia.conversationId))[0]).toContain("Gracias por firmar el consentimiento")
})

it("repetir la misma petición de envío no agrega otro paso a la historia", async () => {
  const f = await clinicalFixture()
  const lucia = await consentInChat(f, new Date())
  const requestId = randomUUID()
  for (let time = 0; time < 2; time++) {
    await f.run((tx) => markConsentSentByLink(tx, ORG, f.actor, lucia.consentId, { requestId }))
  }
  const history = await f.run((tx) => listConsentEvents(tx, ORG, lucia.consentId))
  expect(history.map((event) => event.toStatus)).toEqual(["pendiente", "enlace_enviado"])
  // Otra petición sí es otro envío.
  await f.run((tx) => markConsentSentByLink(tx, ORG, f.actor, lucia.consentId, { requestId: randomUUID() }))
  expect(await f.run((tx) => listConsentEvents(tx, ORG, lucia.consentId))).toHaveLength(3)
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
    // Salió del botón: el agente no espera a que quien lo mandó termine de conversar.
    const sent = await ownerDb
      .select({ fromAction: message.fromAction })
      .from(message)
      .where(and(eq(message.conversationId, lucia.conversationId), eq(message.direction, "out"), eq(message.senderKind, "user")))
    expect(sent).toEqual([{ fromAction: true }])
  } finally {
    configurePublicLinks(null)
  }
})

/** Una plantilla aprobada en el WhatsApp que comparten las pruebas de este archivo, mientras dura la prueba. */
async function approveTemplate(name: string, variables: number) {
  const [connection] = await ownerDb
    .select({ id: channelConnection.id })
    .from(channelConnection)
    .where(and(eq(channelConnection.organizationId, ORG), eq(channelConnection.channel, "whatsapp")))
  await ownerDb.insert(channelTemplate).values({
    organizationId: ORG, connectionId: connection!.id, name, language: "es", status: "aprobada", category: "utility", body: "Hola, {{1}}.", variables,
  })
  onTestFinished(async () => {
    await ownerDb.delete(channelTemplate).where(and(eq(channelTemplate.organizationId, ORG), eq(channelTemplate.name, name)))
  })
}

it("«Firma tu consentimiento»: abre directo la hoja, no dice nada clínico y, mientras no lo aprueban, sale «Su enlace»", async () => {
  configurePublicLinks({ webURL: "https://app.odentia.test", cookieDomain: "odentia.test" })
  try {
    const f = await clinicalFixture()
    // Escribió hace dos días: por WhatsApp solo sale un mensaje aprobado.
    const lucia = await consentInChat(f, TWO_DAYS_AGO())
    await f.run((tx) => markConsentSentByLink(tx, ORG, f.actor, lucia.consentId))
    await approveTemplate("odentia_su_enlace_v1", 2)
    const sentOut = () =>
      ownerDb
        .select({ templateName: message.templateName, body: message.body, templateLink: message.templateLink })
        .from(message)
        .where(and(eq(message.conversationId, lucia.conversationId), eq(message.direction, "out")))
    await f.run((tx) => sendConsentToSign(tx, ORG, f.actor, { patientId: lucia.patientId, consentId: lucia.consentId }, { secretsKey: KEY }))
    expect((await sentOut()).map((row) => row.templateName)).toEqual(["odentia_su_enlace_v1"])
    // Aprobado el suyo, sale ese: de qué clínica, para cuándo y qué es; nunca el procedimiento.
    await approveTemplate("odentia_consentimiento_por_firmar_v1", 3)
    await f.run((tx) => sendConsentToSign(tx, ORG, f.actor, { patientId: lucia.patientId, consentId: lucia.consentId }, { secretsKey: KEY }))
    const own = (await sentOut()).find((row) => row.templateName === "odentia_consentimiento_por_firmar_v1")
    expect(own?.body).toMatch(/te envía un consentimiento para leer y firmar antes de tu próxima cita\. Lo encuentras aquí\.$/)
    expect(own?.body).not.toMatch(/Exodoncia|38/)
    expect(own?.templateLink).toMatch(/^\{\{su-enlace:[0-9a-f-]{36}\}\}$/)

    // Dentro de las 24 horas sale escrito, con la dirección que abre la hoja.
    const ana = await consentInChat(f, new Date())
    await f.run((tx) => markConsentSentByLink(tx, ORG, f.actor, ana.consentId))
    await f.run((tx) => sendConsentToSign(tx, ORG, f.actor, { patientId: ana.patientId, consentId: ana.consentId }, { secretsKey: KEY }))
    const [text] = await ownerDb
      .select({ body: message.body })
      .from(message)
      .where(and(eq(message.conversationId, ana.conversationId), eq(message.direction, "out")))
    // Lleva cuál: con otro enviado antes o después, abre este.
    expect(text?.body).toContain(`/pendientes?abre=firma&id=${ana.consentId}&token={{su-enlace:`)
    expect(text?.body).toMatch(/&token=\{\{su-enlace:[0-9a-f-]{36}\}\}$/)
    expect(text?.body).not.toContain("Exodoncia")
    // Sin `id` (el botón fijo de la plantilla) abre el último enviado, no el más antiguo.
    const later = await f.run((tx) =>
      createConsentDocument(tx, ORG, f.actor, { templateId: ana.templateId, patientId: ana.patientId, procedureRef: "Exodoncia de la pieza 48" }),
    )
    await f.run((tx) => markConsentSentByLink(tx, ORG, f.actor, later.id))
    const hers = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: ana.personId, patientId: ana.patientId }, { secretsKey: KEY }))
    expect((await f.run((tx) => getPersonalLinkView(tx, ORG, hers.token))).consents.map((row) => row.id)).toEqual([later.id, ana.consentId])
  } finally {
    configurePublicLinks(null)
  }
})

it("«Firmar en su teléfono»: el código abre la hoja y queda en su enlace, sin enviarle ningún mensaje", async () => {
  configurePublicLinks({ webURL: "https://app.odentia.test", cookieDomain: "odentia.test" })
  try {
    const f = await clinicalFixture()
    const lucia = await consentInChat(f, new Date())
    await f.run((tx) => markConsentSentByLink(tx, ORG, f.actor, lucia.consentId, { shown: true }))
    const shown = await f.run((tx) => showPersonalLink(tx, ORG, f.actor, lucia.patientId, { secretsKey: KEY }, lucia.consentId))
    expect(shown.url).toContain(`/pendientes?abre=firma&id=${lucia.consentId}&token=`)
    const token = new URL(shown.url).searchParams.get("token")!
    expect((await f.run((tx) => getPersonalLinkView(tx, ORG, token))).consents.map((row) => row.id)).toEqual([lucia.consentId])
    // No sale nada por su chat; la historia dice que se le mostró.
    const out = await ownerDb
      .select({ id: message.id })
      .from(message)
      .where(and(eq(message.conversationId, lucia.conversationId), eq(message.direction, "out")))
    expect(out).toEqual([])
    const [event] = await ownerDb
      .select({ reason: consentEvent.reason })
      .from(consentEvent)
      .where(and(eq(consentEvent.documentId, lucia.consentId), eq(consentEvent.toStatus, "enlace_enviado")))
    expect(event?.reason).toMatch(/sin enviarle mensaje/)
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

it("«Presupuesto listo»: abre ese presupuesto y no una reserva sin usar; sin `id`, el último enviado", async () => {
  configurePublicLinks({ webURL: "https://app.odentia.test", cookieDomain: "odentia.test" })
  const f = await clinicalFixture()
  const personId = (await f.run((tx) => patientPersonId(tx, ORG, f.patient.id)))!
  await ownerDb.update(contact).set({ email: `persona-${randomUUID().slice(0, 8)}@example.com` }).where(eq(contact.id, personId))
  const [mailbox] = await ownerDb
    .insert(channelConnection)
    .values({
      organizationId: ORG, channel: "email", provider: "gmail", displayName: "Correo de la clínica",
      externalId: `clinica-${randomUUID().slice(0, 8)}@example.com`, configEncrypted: "prueba", webhookSecret: "prueba", status: "active",
    })
    .returning({ id: channelConnection.id })
  const storage = {
    putAttachment: async ({ orgId, conversationId, bytes }: { orgId: string; conversationId: string; bytes: Uint8Array }) => ({
      objectKey: `${orgId}/${conversationId}/${randomUUID()}.pdf`, mimeType: "application/pdf", filename: "presupuesto.pdf", size: bytes.byteLength,
    }),
  } as unknown as Storage
  try {
    // Sofi le dio su enlace para reservar y no reservó.
    const link = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: personId, patientId: f.patient.id, booking: true }, { secretsKey: KEY }))
    const first = await f.run((tx) => addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }))
    const budgetA = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [first.id] }))
    await f.run((tx) => deliverBudget(tx, ...f.args, budgetA.id))
    const second = await f.run((tx) => addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }))
    const budgetB = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [second.id] }))
    const sent = await f.run((tx) =>
      sendBudget(tx, ORG, { userId: f.actor }, { patientId: f.patient.id, budgetId: budgetB.id, requestId: randomUUID() }, { storage, secretsKey: KEY }),
    )
    const [out] = await ownerDb
      .select({ body: message.body })
      .from(message)
      .where(and(eq(message.conversationId, sent.conversationId), eq(message.direction, "out")))
    expect(out?.body).toContain(`/pendientes?abre=presupuesto&id=${budgetB.id}&token={{su-enlace:${link.linkId}}}`)
    // El botón fijo de la plantilla (`/reserva`) ya no muestra «Elige tu cita»: lleva al presupuesto.
    const view = await f.run((tx) => getPersonalLinkView(tx, ORG, link.token))
    expect(view.booking).toBeNull()
    expect(view.budgets.map((row) => row.id)).toEqual([budgetB.id, budgetA.id])
  } finally {
    await ownerDb.update(channelConnection).set({ status: "disabled" }).where(eq(channelConnection.id, mailbox!.id))
    configurePublicLinks(null)
  }
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
    expect(redirect.url).toBe(`https://norte.odentia.test/pendientes?abre=cita&token=${redirect.token}`)
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

it("«Reservar otra»: quien decide reserva otra cita desde «Tu cita», hasta el tope de citas por venir", async () => {
  const f = await clinicalFixture()
  const personId = (await f.run((tx) => patientPersonId(tx, ORG, f.patient.id)))!
  const [site] = await ownerDb.insert(branch).values({ organizationId: ORG, name: `Sede ${randomUUID().slice(0, 6)}`, timezone: "America/Lima" }).returning({ id: branch.id })
  const room = await f.run((tx) => createRoom(tx, ORG, { branchId: site!.id, name: "Unidad dental 1" }))
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
  // Sin una cita a la vista, «otra» no reserva: un enlace para completar datos o firmar no ofrece reservar.
  const bare = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: personId, patientId: f.patient.id, booking: false }, { secretsKey: KEY }))
  expect((await f.run((tx) => getPersonalLinkView(tx, ORG, bare.token))).another).toBeNull()
  await expect(f.run((tx) => listBookingLinkSlots(tx, ORG, bare.token, { ...range, another: true }))).rejects.toMatchObject({ code: "BOOKING_LINK_EXPIRED" })
  const startsAt = new Date(Date.now() + 5 * 86_400_000)
  const [own] = await ownerDb.insert(appointment).values({
    organizationId: ORG, branchId: site!.id, patientId: f.patient.id, professionalUserId: f.actor, roomId: room.id,
    startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), durationMin: 30,
  }).returning({ id: appointment.id })
  // Su enlace para ver su cita: no ofrece reservar, pero sí otra cita con tope.
  const link = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: personId, patientId: f.patient.id, appointmentId: own!.id, booking: false }, { secretsKey: KEY }))
  const view = await f.run((tx) => getPersonalLinkView(tx, ORG, link.token))
  expect(view).toMatchObject({ booking: null, another: { upcoming: 1, cap: 2, allowed: true }, toSchedule: [], confirmVia: null, remindersVia: null })
  expect(view.branches.map((row) => row.id)).toContain(site!.id)
  // Sin «otra», el enlace no reserva.
  const { slots } = await f.run((tx) => listBookingLinkSlots(tx, ORG, link.token, { ...range, another: true }))
  const [first, second] = slots
  if (!first || !second) throw new Error("Sin horarios")
  const pick = (slot: typeof first) => ({ branchId: site!.id, startsAt: slot.startsAt, professionalUserId: slot.professionalUserId, ...(slot.roomId ? { roomId: slot.roomId } : {}) })
  await expect(f.run((tx) => reserveBookingLink(tx, ORG, link.token, pick(first)))).rejects.toMatchObject({ code: "BOOKING_LINK_EXPIRED" })
  await f.run((tx) => reserveBookingLink(tx, ORG, link.token, { ...pick(first), another: true }))
  const after = await f.run((tx) => getPersonalLinkView(tx, ORG, link.token))
  expect(after.another).toEqual({ upcoming: 2, cap: 2, allowed: false })
  // «La que ya tienes sigue igual»: la otra, aunque sea antes, no pasa a ser «Tu cita».
  expect(after.appointment?.startsAt).toBe(startsAt.toISOString())
  const [stored] = await ownerDb.select({ appointmentId: appointmentBookingLink.appointmentId }).from(appointmentBookingLink).where(eq(appointmentBookingLink.id, link.linkId))
  expect(stored?.appointmentId).toBe(own!.id)
  // Llegó al tope: la tercera la agenda recepción.
  await expect(f.run((tx) => reserveBookingLink(tx, ORG, link.token, { ...pick(second), another: true }))).rejects.toMatchObject({
    code: "BOOKING_ANOTHER_LIMIT",
  })
  // Quien no decide por el paciente no reserva otra, aunque esté autorizado a ver su cita.
  const [tia] = await ownerDb.insert(contact).values({ organizationId: ORG, displayName: "Marta Tía" }).returning({ id: contact.id })
  await ownerDb.insert(patientContact).values({ organizationId: ORG, patientId: f.patient.id, contactId: tia!.id, relationship: "family", createdBy: f.actor })
  await f.run((tx) => grantResponsibility(tx, ORG, f.actor, f.patient.id, { contactId: tia!.id, kind: "autorizado_informacion", startsAt: "2020-01-01" }))
  const hers = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: tia!.id, patientId: f.patient.id }, { secretsKey: KEY }))
  expect((await f.run((tx) => getPersonalLinkView(tx, ORG, hers.token))).another).toBeNull()
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
    // Es su mismo enlace, el que ya tiene y no otro, con la referencia: el token lo pone el worker al enviarlo.
    const again = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: tomas.personId, patientId: tomas.patientId }, { secretsKey: KEY }))
    expect(again.reused).toBe(true)
    expect(data?.url).toContain(personalLinkRef(again.linkId))
    expect(data?.url).not.toContain(again.token)
    expect(resolvePersonalLinkRefs(data!.url, KEY)).toContain(again.token)

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

it("sin aviso propio, «Tus datos» muestra el sugerido con su casilla y queda aceptado ese texto (decisión 22, ADR 0141)", async () => {
  const f = await clinicalFixture()
  // Una clínica de antes, que nunca escribió su aviso.
  const config = await f.run((tx) => getPatientRegistrationConfig(tx, ORG))
  await f.run((tx) =>
    savePatientRegistrationConfig(tx, ORG, f.actor, { expectedVersion: config.version, enabled: false, fields: config.fields, privacyNotice: "" }),
  )
  const ana = await minimal(f, { given: "Ana", surname: "Soto" })
  const link = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: ana.personId, patientId: ana.patientId }, { secretsKey: KEY }))
  const form = await f.run((tx) => getPersonalLinkDataForm(tx, ORG, link.token))
  expect(form.pending.privacy).toBe(true)
  expect(form.registration.privacyNotice).toContain("usará tus datos")
  await f.run((tx) => submitPersonalLinkData(tx, ORG, link.token, { data: { birthDate: "1990-03-03" }, privacyAccepted: true }))
  const [consent] = await ownerDb.select().from(patientDataConsent).where(eq(patientDataConsent.patientId, ana.patientId))
  expect(consent?.noticeText).toBe(form.registration.privacyNotice)
})


it("«Enviarme uno nuevo»: desde un enlace vencido le llega otro a su canal, uno al día; usado, quitado o sin nada pendiente no se ofrece", async () => {
  configurePublicLinks({ webURL: "https://app.odentia.test", cookieDomain: "odentia.test" })
  try {
    const f = await clinicalFixture()
    const lucia = await consentInChat(f, new Date())
    await f.run((tx) => markConsentSentByLink(tx, ORG, f.actor, lucia.consentId))
    const old = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: lucia.personId, patientId: lucia.patientId }, { secretsKey: KEY }))
    const expire = (linkId: string) =>
      ownerDb.update(appointmentBookingLink).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(appointmentBookingLink.id, linkId))
    await expire(old.linkId)
    const [person] = await ownerDb.select({ phone: contact.phone }).from(contact).where(eq(contact.id, lucia.personId))
    const masked = `•••${person!.phone!.slice(-3)}`
    // Venció con un consentimiento por firmar: se ofrece otro, por su WhatsApp y enmascarado.
    expect(await f.run((tx) => getPersonalLinkView(tx, ORG, old.token))).toMatchObject({
      status: "vencido",
      consents: [],
      closed: { reason: "vencido", resend: { channel: "whatsapp", to: masked, sentAt: null } },
    })
    const sent = await f.run((tx) => resendPersonalLink(tx, ORG, old.token, { secretsKey: KEY }))
    expect(sent).toMatchObject({ channel: "whatsapp", to: masked })
    expect(sent.sentAt).not.toBeNull()
    // Sale como aviso, sin nadie del equipo, con un enlace nuevo que abre sus pendientes.
    const out = await ownerDb
      .select({ senderKind: message.senderKind, senderUserId: message.senderUserId, body: message.body })
      .from(message)
      .where(and(eq(message.conversationId, lucia.conversationId), eq(message.direction, "out")))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ senderKind: "agent", senderUserId: null })
    expect(out[0]?.body).toMatch(/https:\/\/norte\.odentia\.test\/pendientes\?token=\{\{su-enlace:[0-9a-f-]{36}\}\}/)
    const links = await ownerDb.select().from(appointmentBookingLink).where(eq(appointmentBookingLink.patientId, lucia.patientId))
    const fresh = links.find((row) => row.id !== old.linkId)
    expect(fresh?.revokedAt).toBeNull()
    expect(fresh?.conversationId).toBe(lucia.conversationId)
    // El viejo queda sin efecto y dice cuándo salió el nuevo; un doble toque no manda otro.
    expect((await f.run((tx) => getPersonalLinkView(tx, ORG, old.token))).closed).toMatchObject({
      reason: "vencido",
      resend: { channel: "whatsapp", to: masked, sentAt: expect.any(String) },
    })
    await expect(f.run((tx) => resendPersonalLink(tx, ORG, old.token, { secretsKey: KEY }))).rejects.toMatchObject({ code: "LINK_RESEND_LIMIT" })
    // El tope es por persona y día: si el nuevo también vence hoy, tampoco sale otro.
    const renewed = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: lucia.personId, patientId: lucia.patientId }, { secretsKey: KEY }))
    expect(renewed.linkId).toBe(fresh!.id)
    await expire(renewed.linkId)
    await expect(f.run((tx) => resendPersonalLink(tx, ORG, renewed.token, { secretsKey: KEY }))).rejects.toMatchObject({ code: "LINK_RESEND_LIMIT" })
    expect(
      await ownerDb.select({ id: message.id }).from(message).where(and(eq(message.conversationId, lucia.conversationId), eq(message.direction, "out"))),
    ).toHaveLength(1)

    // «Quitar enlace»: no se ofrece ni se envía otro.
    const ana = await consentInChat(f, new Date())
    await f.run((tx) => markConsentSentByLink(tx, ORG, f.actor, ana.consentId))
    const hers = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: ana.personId, patientId: ana.patientId }, { secretsKey: KEY }))
    await f.run((tx) => revokePersonalLinks(tx, ORG, f.actor, ana.patientId))
    expect((await f.run((tx) => getPersonalLinkView(tx, ORG, hers.token))).closed).toEqual({ reason: "quitado", resend: null, appointment: null })
    await expect(f.run((tx) => resendPersonalLink(tx, ORG, hers.token, { secretsKey: KEY }))).rejects.toMatchObject({ code: "LINK_RESEND_UNAVAILABLE" })

    // Vencido sin nada pendiente (ya envió sus datos y no tiene nada más): no sirve pedir otro.
    const done = await consentInChat(f, new Date())
    const empty = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: done.personId, patientId: done.patientId }, { secretsKey: KEY }))
    await ownerDb
      .update(appointmentBookingLink)
      .set({ dataSubmittedAt: new Date(), expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(appointmentBookingLink.id, empty.linkId))
    expect((await f.run((tx) => getPersonalLinkView(tx, ORG, empty.token))).closed).toEqual({ reason: "hecho", resend: null, appointment: null })
    await expect(f.run((tx) => resendPersonalLink(tx, ORG, empty.token, { secretsKey: KEY }))).rejects.toMatchObject({ code: "LINK_RESEND_UNAVAILABLE" })

    // Un familiar sin facultad para decidir no pide uno nuevo.
    const [tia] = await ownerDb.insert(contact).values({ organizationId: ORG, displayName: "Marta Tía", givenNames: "Marta" }).returning({ id: contact.id })
    await ownerDb.insert(patientContact).values({ organizationId: ORG, patientId: lucia.patientId, contactId: tia!.id, relationship: "family", createdBy: f.actor })
    const aunt = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: tia!.id, patientId: lucia.patientId }, { secretsKey: KEY }))
    await expire(aunt.linkId)
    expect((await f.run((tx) => getPersonalLinkView(tx, ORG, aunt.token))).closed?.resend ?? null).toBeNull()
    await expect(f.run((tx) => resendPersonalLink(tx, ORG, aunt.token, { secretsKey: KEY }))).rejects.toMatchObject({ code: "LINK_RESEND_UNAVAILABLE" })

    // S3: sin facultad sobre la cita, tampoco le dice cuándo fue la que ya pasó.
    const passed = await upcomingAppointment(f, lucia.patientId)
    await ownerDb.update(appointment).set({ startsAt: new Date(Date.now() - 3_600_000), endsAt: new Date(Date.now() - 1_800_000) }).where(eq(appointment.id, passed))
    const withPast = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: tia!.id, patientId: lucia.patientId, appointmentId: passed }, { secretsKey: KEY }))
    await ownerDb.update(appointmentBookingLink).set({ expiresAt: new Date(Date.now() - 2 * 3_600_000) }).where(eq(appointmentBookingLink.id, withPast.linkId))
    const auntClosed = (await f.run((tx) => getPersonalLinkView(tx, ORG, withPast.token))).closed
    expect(auntClosed?.reason).not.toBe("cita-pasada")
    expect(auntClosed?.appointment ?? null).toBeNull()

    // Con Sofi apagada (o los agentes en pausa) no se ofrece ni sale: la página le dice que escriba a la clínica.
    const off = await consentInChat(f, new Date())
    await f.run((tx) => markConsentSentByLink(tx, ORG, f.actor, off.consentId))
    const offLink = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: off.personId, patientId: off.patientId }, { secretsKey: KEY }))
    await expire(offLink.linkId)
    await setSofi(false)
    try {
      expect((await f.run((tx) => getPersonalLinkView(tx, ORG, offLink.token))).closed).toMatchObject({ reason: "vencido", resend: null })
      await expect(f.run((tx) => resendPersonalLink(tx, ORG, offLink.token, { secretsKey: KEY }))).rejects.toMatchObject({ code: "LINK_RESEND_UNAVAILABLE" })
    } finally {
      await setSofi(true)
    }

    // El correo enmascarado no deja ver el dominio, que en uno propio diría de quién es.
    expect(maskedAddress("correo", "elsa@familia-quispe.pe")).toBe("e•••@f•••.pe")
    expect(maskedAddress("correo", "rosa@gmail.com")).toBe("r•••@g•••.com")
  } finally {
    configurePublicLinks(null)
  }
})

/** Una paciente con cita por venir, su enlace y el cuestionario de la clínica publicado. */
async function withQuestionnaire(f: Awaited<ReturnType<typeof clinicalFixture>>) {
  const marta = await minimal(f, { given: "Marta", surname: "Lazo" })
  const visit = await upcomingAppointment(f, marta.patientId)
  const link = await f.run((tx) =>
    issuePersonalLink(tx, ORG, { contactId: marta.personId, patientId: marta.patientId, appointmentId: visit }, { secretsKey: KEY }),
  )
  const form = await f.run((tx) =>
    createFormTemplate(tx, ORG, f.actor, {
      // Un título propio: uno que empieza igual que otro pasaría a ser su versión siguiente.
      title: `Antes de venir ${randomUUID().slice(0, 6)}`,
      respondent: "portal",
      schema: { sections: [{ id: "visita", title: "Tu visita", fields: [{ id: "motivo", label: "¿Por qué vienes?", type: "texto_largo" }] }] },
    }),
  )
  await f.run((tx) => publishFormTemplate(tx, ORG, f.actor, form.id))
  return { marta, visit, link }
}

// Mesa de formularios del 13 nov (F18): un segundo envío respondía «Este enlace ya no sirve» con el enlace vivo.
it("el segundo envío del cuestionario dice «Ya lo enviaste», no que el enlace ya no sirve", async () => {
  const f = await clinicalFixture()
  const { marta, visit, link } = await withQuestionnaire(f)
  await f.run((tx) => submitPersonalLinkQuestionnaire(tx, ORG, link.token, { motivo: "Me duele la muela de abajo" }, { secretsKey: KEY }))
  // Otra pestaña u otro teléfono con el cuestionario abierto, y volver a abrirlo: dicen lo que pasó.
  const again = f.run((tx) => submitPersonalLinkQuestionnaire(tx, ORG, link.token, { motivo: "Otra cosa" }, { secretsKey: KEY }))
  await expect(again).rejects.toMatchObject({ code: "ALREADY_SUBMITTED", status: 409, message: expect.stringMatching(/^Ya lo enviaste/) })
  await expect(f.run((tx) => getPersonalLinkQuestionnaire(tx, ORG, link.token))).rejects.toMatchObject({ code: "ALREADY_SUBMITTED" })
  // Lo primero que envió es lo que quedó, y el enlace sigue abierto.
  const [kept] = await f.run((tx) => listFormResponses(tx, ORG, { patientId: marta.patientId }))
  expect(kept?.answers).toMatchObject({ motivo: "Me duele la muela de abajo" })
  expect((await f.run((tx) => getPersonalLinkView(tx, ORG, link.token))).status).toBe("abierto")
  // A quien no decide por la paciente el enlace no le sirve para eso, como antes.
  const [tia] = await ownerDb.insert(contact).values({ organizationId: ORG, displayName: "Rosa Tía", givenNames: "Rosa" }).returning({ id: contact.id })
  await ownerDb.insert(patientContact).values({ organizationId: ORG, patientId: marta.patientId, contactId: tia!.id, relationship: "family", createdBy: f.actor })
  const hers = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: tia!.id, patientId: marta.patientId, appointmentId: visit }, { secretsKey: KEY }))
  await expect(f.run((tx) => submitPersonalLinkQuestionnaire(tx, ORG, hers.token, { motivo: "x" }, { secretsKey: KEY }))).rejects.toMatchObject({ code: "BOOKING_LINK_EXPIRED" })
})

// QA de la entrega 3 (14 nov): abrir un mensaje viejo con «abre=cuestionario» decía «Ya lo enviaste»
// por las respuestas de una cita que ya pasó.
it("lo enviado para una cita que ya pasó no es «Ya lo enviaste»: ese enlace ya no sirve para el cuestionario", async () => {
  const f = await clinicalFixture()
  const { marta, visit, link } = await withQuestionnaire(f)
  await f.run((tx) => submitPersonalLinkQuestionnaire(tx, ORG, link.token, { motivo: "Me duele la muela de abajo" }, { secretsKey: KEY }))
  await expect(f.run((tx) => getPersonalLinkQuestionnaire(tx, ORG, link.token))).rejects.toMatchObject({ code: "ALREADY_SUBMITTED" })
  // Pasa el tiempo: lo envió hace una semana para la cita de hace tres días.
  const days = (n: number) => new Date(Date.now() - n * 86_400_000)
  await ownerDb.update(clinicalFormResponse).set({ submittedAt: days(7) }).where(eq(clinicalFormResponse.patientId, marta.patientId))
  await ownerDb.update(appointment).set({ startsAt: days(3), endsAt: new Date(days(3).getTime() + 30 * 60_000) }).where(eq(appointment.id, visit))
  const next = await upcomingAppointment(f, marta.patientId)
  const fresh = await f.run((tx) =>
    issuePersonalLink(tx, ORG, { contactId: marta.personId, patientId: marta.patientId, appointmentId: next }, { secretsKey: KEY }),
  )
  const opened = f.run((tx) => getPersonalLinkQuestionnaire(tx, ORG, fresh.token))
  await expect(opened).rejects.toMatchObject({ code: "BOOKING_LINK_EXPIRED" })
})

// Mesa de formularios del 13 nov (C8): después de enviar, «Tus pendientes» no decía nada de lo enviado.
it("después de enviar, su enlace dice qué envió y cuándo, y nunca lo que respondió", async () => {
  const f = await clinicalFixture()
  const { marta, visit, link } = await withQuestionnaire(f)
  const open = () => f.run((tx) => getPersonalLinkView(tx, ORG, link.token))
  // Antes de enviar nada no hay nada que decir.
  expect((await open()).told).toBeNull()

  const before = Date.now()
  await f.run((tx) =>
    submitPersonalLinkData(tx, ORG, link.token, {
      data: { birthDate: "1960-03-04" },
      health: { allergies: { state: "recorded", items: [{ substance: "Penicilina", severity: "desconocida" }] } },
    }),
  )
  const afterData = await open()
  expect(afterData.told?.items.map((item) => item.what)).toEqual(["datos", "salud"])
  expect(afterData.told?.timeZone).toBeTruthy()
  expect(new Date(afterData.told!.items[0]!.at).getTime()).toBeGreaterThanOrEqual(before - 1000)

  await f.run((tx) => submitPersonalLinkQuestionnaire(tx, ORG, link.token, { motivo: "Me duele la muela de abajo" }, { secretsKey: KEY }))
  const afterAll = await open()
  expect(afterAll.questionnaire).toBeNull()
  expect(afterAll.told?.items.map((item) => item.what)).toEqual(["datos", "salud", "cuestionario"])
  // El enlace se abre sin código y se puede reenviar: nada de lo que respondió viaja en él.
  const sentToThePage = JSON.stringify(afterAll)
  for (const secret of ["Penicilina", "muela", "1960-03-04"]) expect(sentToThePage).not.toContain(secret)

  // Solo lo ve quien lo envió: otra persona que abre su propio enlace de la misma paciente, no.
  const [tia] = await ownerDb.insert(contact).values({ organizationId: ORG, displayName: "Rosa Tía", givenNames: "Rosa" }).returning({ id: contact.id })
  await ownerDb.insert(patientContact).values({ organizationId: ORG, patientId: marta.patientId, contactId: tia!.id, relationship: "family", createdBy: f.actor })
  const hers = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: tia!.id, patientId: marta.patientId, appointmentId: visit }, { secretsKey: KEY }))
  expect((await f.run((tx) => getPersonalLinkView(tx, ORG, hers.token))).told).toBeNull()
})

// Revisión de la entrega 3: lo enviado hace meses salía en un enlace nuevo como «Lo recibimos…
// Lo lee la Dra. X antes de atenderte». Solo cuenta lo enviado después de su última cita pasada.
it("«Lo que nos contaste» es de la cita que viene: lo enviado antes de su última cita pasada ya no sale", async () => {
  const f = await clinicalFixture()
  const { marta, visit, link } = await withQuestionnaire(f)
  await f.run((tx) =>
    submitPersonalLinkData(tx, ORG, link.token, {
      data: { birthDate: "1960-03-04" },
      health: { allergies: { state: "recorded", items: [{ substance: "Penicilina", severity: "desconocida" }] } },
    }),
  )
  await f.run((tx) => submitPersonalLinkQuestionnaire(tx, ORG, link.token, { motivo: "Me duele la muela de abajo" }, { secretsKey: KEY }))
  const told = async (token: string) => (await f.run((tx) => getPersonalLinkView(tx, ORG, token))).told?.items.map((item) => item.what) ?? null
  expect(await told(link.token)).toEqual(["datos", "salud", "cuestionario"])

  // Pasa el tiempo: sus datos y su salud los envió hace una semana, y esa cita fue hace tres días.
  const days = (n: number) => new Date(Date.now() - n * 86_400_000)
  await ownerDb
    .update(auditEvent)
    .set({ createdAt: days(7) })
    .where(and(eq(auditEvent.organizationId, ORG), eq(auditEvent.action, "personal_link.data_sent"), eq(auditEvent.entityId, marta.patientId)))
  await ownerDb.update(appointment).set({ startsAt: days(3), endsAt: new Date(days(3).getTime() + 30 * 60_000) }).where(eq(appointment.id, visit))
  const next = await upcomingAppointment(f, marta.patientId)
  const fresh = await f.run((tx) =>
    issuePersonalLink(tx, ORG, { contactId: marta.personId, patientId: marta.patientId, appointmentId: next }, { secretsKey: KEY }),
  )
  // El cuestionario lo envió después de esa cita: es de la que viene. Lo de antes ya no se anuncia.
  expect(await told(fresh.token)).toEqual(["cuestionario"])
  await ownerDb.update(clinicalFormResponse).set({ submittedAt: days(7) }).where(eq(clinicalFormResponse.patientId, marta.patientId))
  expect(await told(fresh.token)).toBeNull()
  // Una cita cancelada no fue una visita: lo enviado para ella sigue siendo de la que viene.
  await ownerDb.update(appointment).set({ status: "cancelada" }).where(eq(appointment.id, visit))
  expect(await told(fresh.token)).toEqual(["datos", "salud", "cuestionario"])
})

// QA de la entrega 3 (14 nov): «Lo que nos contaste» desaparecía a la hora en que empezaba la cita
// de hoy, mientras la persona aún esperaba en la sala.
it("«Lo que nos contaste» sigue mientras la cita de hoy no termina", async () => {
  const f = await clinicalFixture()
  const { marta, visit, link } = await withQuestionnaire(f)
  await f.run((tx) => submitPersonalLinkQuestionnaire(tx, ORG, link.token, { motivo: "Me duele la muela de abajo" }, { secretsKey: KEY }))
  const told = async () => (await f.run((tx) => getPersonalLinkView(tx, ORG, link.token))).told?.items.map((item) => item.what) ?? null
  // Lo envió hace una hora; la cita empezó hace diez minutos y termina en veinte: está en la sala.
  const minutes = (n: number) => new Date(Date.now() + n * 60_000)
  await ownerDb.update(clinicalFormResponse).set({ submittedAt: minutes(-60) }).where(eq(clinicalFormResponse.patientId, marta.patientId))
  await ownerDb.update(appointment).set({ startsAt: minutes(-10), endsAt: minutes(20) }).where(eq(appointment.id, visit))
  expect(await told()).toEqual(["cuestionario"])
})

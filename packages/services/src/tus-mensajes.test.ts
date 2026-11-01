import { randomUUID } from "node:crypto"
import { type Db, withOrgContext } from "@odentia/db"
import { appointment, scheduleRoom } from "@odentia/db/schema/agenda"
import { member, user } from "@odentia/db/schema/auth"
import { automationConsent, automationJob, automationRule } from "@odentia/db/schema/automation"
import { patientContact, paymentTicket } from "@odentia/db/schema/clinical"
import { agentConfig, channelConnection, channelTemplate, contact, contactIdentity, conversation, message } from "@odentia/db/schema/crm"
import { branch, orgProfile } from "@odentia/db/schema/org"
import { and, asc, eq } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { AUTOMATION_MESSAGES, type AutomationMessageKey, RESUME_MESSAGE, replyId } from "./automation-messages.js"
import {
  chooseMessagesInConversation,
  deliverDueJobs,
  getMessagePermissions,
  handleAutomationReply,
  mayWriteFirst,
  setLine,
  setMessageChoice,
  syncAppointmentReminders,
  syncBudgetFollowUps,
} from "./automation.js"
import { previewMessageRoute } from "./automation-routing.js"
import { issuePersonalLink } from "./booking-links.js"
import { applyTemplateCategories, assertTemplateSendable } from "./channel-templates.js"
import { listRecategorizedMessages, resumeConversationBySystem } from "./clinic-messages.js"
import { createConnection } from "./connections.js"
import { sendTicketReceiptByEmail } from "./financial-documents.js"
import { nextPatientNumber } from "./patients.js"
import { configurePublicLinks } from "./public-links.js"
import { secretsKeyFromEnv } from "./secrets.js"
import type { Storage } from "./storage.js"
import { getPersonalLinkPaper, getPersonalLinkView, setPersonalLinkMessages } from "./su-enlace.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"
import { setWritingHours } from "./writing-hours.js"
import { insertTestPatients } from "./test-patient.js"

/**
 * WhatsApp y los mensajes que se pueden apagar (ADR 0040): tres tipos que la
 * persona apaga y los avisos de lo que pasó, que siempre salen; la categoría
 * de WhatsApp manda; el sistema retoma la conversación (el agente no elige
 * plantillas); «Tus papeles» y el comprobante por correo. Sin proveedor real:
 * una plantilla «aprobada» es la que declara la conexión de prueba.
 */
setupTestDb()
configurePublicLinks({ webURL: "https://app.odentia.test", cookieDomain: "odentia.test" })
const KEY = secretsKeyFromEnv("cd".repeat(32))
const HOUR = 3_600_000
const NOW = new Date("2026-10-06T15:00:00.000Z")

interface Clinic {
  orgId: string
  ownerId: string
  professionalId: string
  branchId: string
  roomId: string
  whatsappId: string
}

async function clinic(options: { approved?: string[]; email?: boolean } = {}): Promise<Clinic> {
  const orgId = randomUUID()
  const ownerId = `owner-${orgId}`
  const professionalId = `professional-${orgId}`
  await insertOrg(ownerDb, orgId, `msg-${orgId}`)
  await ownerDb.update(orgProfile).set({ tradeName: "Clínica Sonríe" }).where(eq(orgProfile.organizationId, orgId))
  await ownerDb.insert(user).values([
    { id: ownerId, name: "Dueña", email: `${ownerId}@msg.test`, emailVerified: true },
    { id: professionalId, name: "Dra. Ana Torres", email: `${professionalId}@msg.test`, emailVerified: true },
  ])
  await ownerDb.insert(member).values([
    { id: `m-${ownerId}`, userId: ownerId, organizationId: orgId, role: "owner", createdAt: new Date() },
    { id: `m-${professionalId}`, userId: professionalId, organizationId: orgId, role: "clinician", createdAt: new Date() },
  ])
  // Con el horario de recontacto a toda hora: estas pruebas usan el reloj real.
  await ownerDb.insert(agentConfig).values({
    organizationId: orgId,
    enabled: true,
    advisor: { enabled: true },
    writingHours: Array.from({ length: 7 }, (): Array<[number, number]> => [[0, 1440]]),
  })
  const [site] = await ownerDb.insert(branch).values({ organizationId: orgId, name: "Centro", timezone: "America/Lima" }).returning({ id: branch.id })
  const [room] = await ownerDb.insert(scheduleRoom).values({ organizationId: orgId, branchId: site!.id, name: "Unidad dental 1" }).returning({ id: scheduleRoom.id })
  const templates = (options.approved ?? []).map((name) => ({ name, language: "es" }))
  const connection = await withOrgContext(appDb, orgId, (tx) =>
    createConnection(tx, orgId, KEY, {
      channel: "whatsapp", provider: "whatsapp_cloud_api", displayName: "WA",
      config: { phoneNumberId: "P", wabaId: "W", accessToken: "T", appSecret: "S", templates },
    }, { fetch, validateExternal: false }))
  if (options.email) {
    await ownerDb.insert(channelConnection).values({
      organizationId: orgId, channel: "email", provider: "gmail", displayName: "Correo de la clínica",
      externalId: `clinica-${orgId}@example.com`, configEncrypted: "prueba", webhookSecret: "prueba", status: "active",
    })
  }
  return { orgId, ownerId, professionalId, branchId: site!.id, roomId: room!.id, whatsappId: connection.id }
}

function run<T>(c: Clinic, fn: (tx: Db) => Promise<T>): Promise<T> {
  return withOrgContext(appDb, c.orgId, fn)
}

/** Paciente con su persona y su WhatsApp; `openWindow`: escribió hace poco. */
async function person(c: Clinic, name: string, options: { openWindow?: boolean; email?: string; wroteHoursAgo?: number } = {}) {
  const [row] = await insertTestPatients(ownerDb, { organizationId: c.orgId, displayName: name, patientNumber: await nextPatientNumber(ownerDb, c.orgId) })
  const [link] = await ownerDb
    .select({ contactId: patientContact.contactId })
    .from(patientContact)
    .where(and(eq(patientContact.organizationId, c.orgId), eq(patientContact.patientId, row!.id)))
  const contactId = link!.contactId
  if (options.email) await ownerDb.update(contact).set({ email: options.email }).where(eq(contact.id, contactId))
  const phone = `519${randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "0")}`
  const [identity] = await ownerDb
    .insert(contactIdentity)
    .values({ organizationId: c.orgId, contactId, channel: "whatsapp", externalUserId: phone, isPrimary: true })
    .returning({ id: contactIdentity.id })
  const wrote = options.openWindow ? new Date() : options.wroteHoursAgo ? new Date(Date.now() - options.wroteHoursAgo * HOUR) : null
  const [thread] = await ownerDb
    .insert(conversation)
    .values({
      organizationId: c.orgId, contactId, contactIdentityId: identity!.id, channelConnectionId: c.whatsappId,
      externalThreadId: phone, lastInboundAt: wrote,
    })
    .returning({ id: conversation.id })
  return { patientId: row!.id, contactId, conversationId: thread!.id }
}

async function ruleOn(c: Clinic, kind: string) {
  const rule = await run(c, (tx) => setLine(tx, c.orgId, c.ownerId, kind, { enabled: true }))
  await ownerDb.update(automationRule).set({ enabledAt: new Date(NOW.getTime() - 3 * 24 * HOUR) }).where(eq(automationRule.id, rule.id))
}

const jobsOf = (c: Clinic) =>
  ownerDb.select().from(automationJob).where(eq(automationJob.organizationId, c.orgId)).orderBy(asc(automationJob.scheduledFor))
const deliver = (c: Clinic, now = NOW) => run(c, (tx) => deliverDueJobs(tx, c.orgId, now, { secretsKey: KEY, publicBaseUrl: "https://clinica.test" }))
const lastOut = async (conversationId: string) =>
  (await ownerDb.select().from(message).where(eq(message.conversationId, conversationId)).orderBy(asc(message.createdAt))).filter((row) => row.direction === "out").at(-1)
const may = (c: Clinic, contactId: string, purpose: "recordatorio" | "seguimiento" | "novedades" | "avisos") =>
  run(c, (tx) => mayWriteFirst(tx, c.orgId, contactId, purpose))

/** Lucía con el recordatorio de mañana ya enviado por su WhatsApp (escribió hace poco). */
async function reminded() {
  const c = await clinic()
  await ruleOn(c, "recordatorio_cita")
  const p = await person(c, "Lucía Paredes", { openWindow: true })
  await ownerDb.insert(appointment).values({
    organizationId: c.orgId, branchId: c.branchId, patientId: p.patientId, professionalUserId: c.professionalId, roomId: c.roomId,
    startsAt: new Date(NOW.getTime() + 24 * HOUR), endsAt: new Date(NOW.getTime() + 24.5 * HOUR), durationMin: 30, status: "programada",
  })
  await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, NOW))
  await deliver(c)
  const [job] = (await jobsOf(c)).filter((row) => row.status === "enviado")
  return { c, p, job: job! }
}

describe("tres tipos de mensaje y los avisos de lo que pasó", () => {
  it("«No más recordatorios» apaga los recordatorios, no los avisos de su cita, y ofrece «Elegir mis mensajes»", async () => {
    const { c, p, job } = await reminded()
    expect((await lastOut(p.conversationId))?.replyButtons).toEqual([
      { id: replyId("confirmar", job.id), title: "Confirmar" },
      { id: replyId("responder", job.id), title: "No podré ir" },
      { id: replyId("baja", job.id), title: "No más recordatorios" },
    ])
    expect(
      await run(c, (tx) => handleAutomationReply(tx, c.orgId, { conversationId: p.conversationId, replyId: replyId("baja", job.id) }, { storage: noStorage, secretsKey: KEY })),
    ).toBe(true)
    expect(await may(c, p.contactId, "recordatorio")).toBe(false)
    // El aviso de que su cita cambió sigue llegando: es de lo que pasó, no un recordatorio.
    expect(await may(c, p.contactId, "avisos")).toBe(true)
    expect(await may(c, p.contactId, "seguimiento")).toBe(true)
    const reply = (await lastOut(p.conversationId))?.body ?? ""
    expect(reply).toMatch(/^Listo, Lucía, ya no te enviaremos recordatorios\. Si tu cita cambia, te avisamos igual\.\n\nElegir mis mensajes: https:\/\/msg-\S+\.odentia\.test\/reserva\?token=\{\{su-enlace:[0-9a-f-]{36}\}\}#mensajes$/)
    // Los avisos de la cita ya no llevan botón de baja.
    for (const key of ["aviso_cita_reservada", "aviso_cita_movida", "aviso_cita_cancelada", "aviso_cita_reservada_datos"] as AutomationMessageKey[]) {
      expect(AUTOMATION_MESSAGES[key].buttons.some((button) => button.action === "baja"), key).toBe(false)
      expect(AUTOMATION_MESSAGES[key].purpose).toBe("avisos")
    }
  })

  it("«BAJA» y «STOP» se resuelven sin modelo; «cancelar» nunca es una baja", async () => {
    const { c, p } = await reminded()
    const inbound = (text: string) => run(c, (tx) => handleAutomationReply(tx, c.orgId, { conversationId: p.conversationId, replyId: null, text }))
    // «Cancelar» es cancelar su cita: sigue a la conversación y no toca sus mensajes.
    expect(await inbound("Quiero cancelar")).toBe(false)
    expect(await inbound("cancelar")).toBe(false)
    expect(await ownerDb.select().from(automationConsent).where(eq(automationConsent.contactId, p.contactId))).toEqual([])
    // «BAJA» tras un recordatorio apaga ese tipo, nada más.
    expect(await inbound("BAJA")).toBe(true)
    expect(await may(c, p.contactId, "recordatorio")).toBe(false)
    expect(await may(c, p.contactId, "seguimiento")).toBe(true)
    expect(await may(c, p.contactId, "avisos")).toBe(true)
    expect((await lastOut(p.conversationId))?.body).toBe("Listo, Lucía, ya no te enviaremos recordatorios. Si tu cita cambia, te avisamos igual.")

    // Sin un mensaje automático reciente, «STOP» apaga los tres interruptores; los avisos siguen.
    const other = await person(c, "Jorge Salas", { openWindow: true })
    expect(await run(c, (tx) => handleAutomationReply(tx, c.orgId, { conversationId: other.conversationId, replyId: null, text: "stop" }))).toBe(true)
    for (const purpose of ["recordatorio", "seguimiento", "novedades"] as const) expect(await may(c, other.contactId, purpose)).toBe(false)
    expect(await may(c, other.contactId, "avisos")).toBe(true)
  })

  it("por el chat: el agente usa la misma operación, con la frase fija y su página", async () => {
    const c = await clinic()
    const p = await person(c, "Lucía Paredes", { openWindow: true })
    const choose = (choice: string | null, receive = false) =>
      run(c, (tx) => chooseMessagesInConversation(tx, c.orgId, { conversationId: p.conversationId, choice, receive }, { secretsKey: KEY }))
    // Sin tipo, solo su página para que elija ella.
    const page = await choose(null)
    expect(page.changed).toEqual([])
    expect(page.reply).toMatch(/^Lucía, aquí puedes elegir qué mensajes recibes de la clínica\.\n\nElegir mis mensajes: https:\/\/\S+\/reserva\?token=[0-9a-f]{64}#mensajes$/)
    const off = await choose("recordatorio")
    expect(off.reply).toMatch(/^Listo, Lucía, ya no te enviaremos recordatorios\. Si tu cita cambia, te avisamos igual\./)
    expect(await may(c, p.contactId, "recordatorio")).toBe(false)
    const on = await choose("recordatorio", true)
    expect(on.reply).toMatch(/^Listo, Lucía, te volveremos a enviar: recordatorios de tus citas\./)
    expect(await may(c, p.contactId, "recordatorio")).toBe(true)
  })

  it("los tres interruptores y «ningún mensaje», que apaga también los avisos y se deshace", async () => {
    const c = await clinic()
    const p = await person(c, "Lucía Paredes")
    // Por defecto: recordatorios y seguimiento llegan; novedades, solo con su sí; los avisos, siempre.
    expect([await may(c, p.contactId, "recordatorio"), await may(c, p.contactId, "seguimiento"), await may(c, p.contactId, "novedades"), await may(c, p.contactId, "avisos")])
      .toEqual([true, true, false, true])
    await run(c, (tx) => setMessageChoice(tx, c.orgId, c.ownerId, p.contactId, { choice: "novedades", receive: true, source: "telefono" }))
    expect(await may(c, p.contactId, "novedades")).toBe(true)
    await run(c, (tx) => setMessageChoice(tx, c.orgId, c.ownerId, p.contactId, { choice: "ninguno", receive: false, source: "telefono" }))
    for (const purpose of ["recordatorio", "seguimiento", "novedades", "avisos"] as const) expect(await may(c, p.contactId, purpose), purpose).toBe(false)
    expect((await run(c, (tx) => getMessagePermissions(tx, c.orgId, p.contactId))).map((row) => [row.purpose, row.granted, row.source])).toEqual([
      ["recordatorio", false, "telefono"],
      ["seguimiento", false, "telefono"],
      ["novedades", false, "telefono"],
      ["avisos", false, "telefono"],
    ])
    // Encender un tipo vuelve a encender los avisos de su cita.
    await run(c, (tx) => setMessageChoice(tx, c.orgId, c.ownerId, p.contactId, { choice: "seguimiento", receive: true, source: "presencial" }))
    expect([await may(c, p.contactId, "seguimiento"), await may(c, p.contactId, "avisos"), await may(c, p.contactId, "recordatorio")]).toEqual([true, true, false])
    await expect(
      run(c, (tx) => setMessageChoice(tx, c.orgId, c.ownerId, p.contactId, { choice: "todo", receive: false, source: "telefono" })),
    ).rejects.toMatchObject({ code: "VALIDATION" })
  })

  it("«Tus mensajes» en su enlace: solo para quien recibe sus mensajes, con origen «enlace»", async () => {
    const c = await clinic()
    const p = await person(c, "Lucía Paredes")
    const own = await run(c, (tx) => issuePersonalLink(tx, c.orgId, { contactId: p.contactId, patientId: p.patientId }, { secretsKey: KEY }))
    const view = await run(c, (tx) => getPersonalLinkView(tx, c.orgId, own.token))
    // Con nada pendiente el enlace sigue abierto: «Tus mensajes» siempre le sirve.
    expect(view).toMatchObject({ status: "abierto", messages: { recordatorio: true, seguimiento: true, novedades: false, nothing: false } })
    expect(await run(c, (tx) => setPersonalLinkMessages(tx, c.orgId, own.token, { tipo: "ninguno", recibir: false }))).toEqual({
      recordatorio: false, seguimiento: false, novedades: false, nothing: true,
    })
    expect((await run(c, (tx) => getMessagePermissions(tx, c.orgId, p.contactId))).find((row) => row.purpose === "avisos")).toMatchObject({ granted: false, source: "enlace" })
    // Un familiar que abre el enlace del paciente no elige sus mensajes.
    const [relative] = await ownerDb.insert(contact).values({ organizationId: c.orgId, displayName: "Su hermana" }).returning({ id: contact.id })
    await ownerDb.insert(patientContact).values({ organizationId: c.orgId, patientId: p.patientId, contactId: relative!.id, relationship: "family" })
    const theirs = await run(c, (tx) => issuePersonalLink(tx, c.orgId, { contactId: relative!.id, patientId: p.patientId }, { secretsKey: KEY }))
    await expect(run(c, (tx) => setPersonalLinkMessages(tx, c.orgId, theirs.token, { tipo: "recordatorio", recibir: false }))).rejects.toMatchObject({ code: "PORTAL_FORBIDDEN" })
  })
})

describe("la categoría manda y los retomar piden el sí", () => {
  it("retomar un presupuesto (promoción para WhatsApp) solo sale a quien aceptó novedades", async () => {
    const c = await clinic()
    await ruleOn(c, "seguimiento_presupuesto")
    const without = await person(c, "Sin el sí", { openWindow: true })
    const accepted = await person(c, "Con el sí", { openWindow: true })
    await ownerDb.insert(automationConsent).values({ organizationId: c.orgId, contactId: accepted.contactId, purpose: "novedades", status: "granted", source: "presencial" })
    const { treatmentBudget, treatmentPlan } = await import("@odentia/db/schema/clinical")
    let number = 1
    for (const who of [without, accepted]) {
      const [plan] = await ownerDb.insert(treatmentPlan).values({ organizationId: c.orgId, patientId: who.patientId, title: "Plan" }).returning({ id: treatmentPlan.id })
      await ownerDb.insert(treatmentBudget).values({
        organizationId: c.orgId, patientId: who.patientId, planId: plan!.id, budgetNumber: number++, title: "Implante", currency: "PEN",
        status: "presentado", presentedAt: new Date(NOW.getTime() - 48.5 * HOUR),
      })
    }
    await run(c, (tx) => syncBudgetFollowUps(tx, c.orgId, NOW))
    await deliver(c)
    const jobs = await jobsOf(c)
    expect(jobs.find((job) => job.contactId === without.contactId)).toMatchObject({ status: "omitido", cause: "sin_permiso" })
    expect(jobs.find((job) => job.contactId === accepted.contactId)).toMatchObject({ status: "enviado" })
  })

  it("un aviso de servicio que WhatsApp pasó a promoción solo sale a quien aceptó novedades, y se ve en la lista", async () => {
    const name = AUTOMATION_MESSAGES.recordatorio_cita.template
    const c = await clinic({ approved: [name] })
    await run(c, (tx) =>
      applyTemplateCategories(tx, c.orgId, c.whatsappId, [{ externalId: null, name, language: "es", category: "marketing", previous: "utility" }]),
    )
    expect(await run(c, (tx) => listRecategorizedMessages(tx, c.orgId))).toMatchObject([{ messageId: "recordatorio_cita", title: "Recordar la cita", inReview: false, rejected: false }])
    await ruleOn(c, "recordatorio_cita")
    const cold = await person(c, "No escribió")
    const yes = await person(c, "Aceptó novedades")
    await ownerDb.insert(automationConsent).values({ organizationId: c.orgId, contactId: yes.contactId, purpose: "novedades", status: "granted", source: "presencial" })
    for (const [index, who] of [cold, yes].entries()) {
      await ownerDb.insert(appointment).values({
        organizationId: c.orgId, branchId: c.branchId, patientId: who.patientId, professionalUserId: c.professionalId, roomId: c.roomId,
        startsAt: new Date(NOW.getTime() + 24 * HOUR + index * HOUR), endsAt: new Date(NOW.getTime() + 24.5 * HOUR + index * HOUR), durationMin: 30, status: "programada",
      })
    }
    await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, NOW))
    await deliver(c, new Date(NOW.getTime() + HOUR))
    const jobs = await jobsOf(c)
    // Nada falla en silencio: sin su sí no sale y queda con su motivo.
    expect(jobs.find((job) => job.contactId === cold.contactId)).toMatchObject({ status: "fallido", cause: "promocion" })
    expect(jobs.find((job) => job.contactId === yes.contactId)).toMatchObject({ status: "enviado", via: "plantilla" })
    // La regla única de la plantilla también lo dice si alguien intenta enviarla.
    await expect(
      run(c, (tx) => assertTemplateSendable(tx, c.orgId, c.whatsappId, { name, language: "es", params: 3, category: "utility", contactId: cold.contactId })),
    ).rejects.toMatchObject({ code: "TEMPLATE_IS_PROMOTION" })
  })

  it("«Invitar a volver» se pide como promoción: no es un cambio de WhatsApp, pero con plantilla solo sale a quien aceptó novedades", async () => {
    const spec = AUTOMATION_MESSAGES.invitar_a_volver
    const c = await clinic({ approved: [spec.template] })
    await run(c, (tx) =>
      applyTemplateCategories(tx, c.orgId, c.whatsappId, [{ externalId: null, name: spec.template, language: "es", category: "marketing", previous: "utility" }]),
    )
    expect(await run(c, (tx) => listRecategorizedMessages(tx, c.orgId))).toEqual([])
    const cold = await person(c, "No escribió")
    const yes = await person(c, "Aceptó novedades")
    await ownerDb.insert(automationConsent).values({ organizationId: c.orgId, contactId: yes.contactId, purpose: "novedades", status: "granted", source: "presencial" })
    expect(await run(c, (tx) => previewMessageRoute(tx, c.orgId, cold.contactId, spec))).toMatchObject({ cause: "promocion" })
    expect(await run(c, (tx) => previewMessageRoute(tx, c.orgId, yes.contactId, spec))).toMatchObject({ via: "plantilla" })
  })

  it("una plantilla de la cuenta con encabezado se ve, pero no se puede enviar", async () => {
    const c = await clinic()
    await ownerDb.insert(channelTemplate).values({
      organizationId: c.orgId, connectionId: c.whatsappId, name: "con_logo", language: "es", category: "utility",
      status: "aprobada", body: "Hola, {{1}}.", variables: 1, unsupported: "encabezado",
    })
    await expect(
      run(c, (tx) => assertTemplateSendable(tx, c.orgId, c.whatsappId, { name: "con_logo", language: "es", params: 1, category: "utility", contactId: null })),
    ).rejects.toThrow("lleva un encabezado con datos o con un archivo")
  })
})

describe("el agente no elige plantillas: retoma el sistema", () => {
  it("con «Retomar la conversación» aprobada la envía el sistema con los datos que conoce", async () => {
    const c = await clinic({ approved: [RESUME_MESSAGE.template] })
    const p = await person(c, "Lucía Paredes", { wroteHoursAgo: 60 })
    const outcome = await run(c, (tx) => resumeConversationBySystem(tx, c.orgId, KEY, p.conversationId))
    expect(outcome).toMatchObject({ sent: true })
    expect(await lastOut(p.conversationId)).toMatchObject({
      contentType: "template",
      senderKind: "agent",
      templateName: RESUME_MESSAGE.template,
      templateParams: ["Lucía", "Clínica Sonríe"],
      body: "Hola, Lucía. Te escribimos de Clínica Sonríe para continuar con tu consulta. ¿Seguimos por aquí?",
    })
  })

  it("fuera del «Horario de recontacto» el sistema no retoma: dice desde cuándo puede escribirle", async () => {
    const c = await clinic({ approved: [RESUME_MESSAGE.template] })
    const p = await person(c, "Lucía Paredes", { wroteHoursAgo: 60 })
    await run(c, (tx) => setWritingHours(tx, c.orgId, c.ownerId, [[], [[480, 1200]], [[480, 1200]], [[480, 1200]], [[480, 1200]], [[480, 1200]], [[480, 840]]]))
    // Domingo 11 de octubre a las 10:00 en Lima: el domingo no se escribe.
    const outcome = await run(c, (tx) => resumeConversationBySystem(tx, c.orgId, KEY, p.conversationId, new Date("2026-10-11T15:00:00Z")))
    expect(outcome).toMatchObject({ sent: false })
    expect(outcome.sent === false && outcome.waiting).toMatch(/^Es fuera del horario de recontacto: el agente puede escribirle a Lucía desde el lunes a las 08:00/)
    expect(await lastOut(p.conversationId)).toBeUndefined()
  })

  it("sin «Retomar» aprobada no se envía nada y «Te espera» dice qué hacer", async () => {
    const c = await clinic()
    const p = await person(c, "Lucía Paredes", { wroteHoursAgo: 60 })
    expect(await run(c, (tx) => resumeConversationBySystem(tx, c.orgId, KEY, p.conversationId))).toEqual({
      sent: false,
      waiting: 'WhatsApp no deja escribirle a Lucía hasta que Meta apruebe "Retomar la conversación". Llámala o espera la aprobación.',
    })
    expect(await lastOut(p.conversationId)).toBeUndefined()
  })
})

const noStorage: Storage = {
  putAvatar: async () => {
    throw new Error("no usado")
  },
  deleteByUrl: async () => {},
  putAttachment: async ({ conversationId, bytes }) => ({ objectKey: `adjuntos/${conversationId}.pdf`, mimeType: "application/pdf", filename: "x.pdf", size: bytes.byteLength }),
  attachmentUrl: async (key) => `https://signed.example.com/${key}`,
  deleteAttachment: async () => {},
  putPatientDocument: async () => {
    throw new Error("no usado")
  },
  putPatientAvatar: async () => {
    throw new Error("no usado")
  },
}

describe("«Tus papeles» y el comprobante por correo", () => {
  async function withTicket(email?: string) {
    const c = await clinic({ email: true })
    const p = await person(c, "Lucía Paredes", email ? { email } : {})
    const [ticket] = await ownerDb
      .insert(paymentTicket)
      .values({
        organizationId: c.orgId, patientId: p.patientId, branchId: c.branchId, ticketNumber: 7, currency: "PEN", totalCents: 4500,
        snapshot: {
          patient: { id: p.patientId, displayName: "Lucía Paredes", docType: null, docNumber: null },
          payer: null,
          issuer: { userId: c.ownerId, name: "Dueña" },
          clinic: { legalName: "Clínica Sonríe S.A.C.", tradeName: "Clínica Sonríe", fiscalAddress: null, locale: "es-PE", currency: "PEN", timezone: "America/Lima" },
          branch: { id: c.branchId, name: "Centro" },
          lines: [{ chargeId: randomUUID(), description: "Limpieza", amountCents: 4500, appliedCents: 4500, promotion: null }],
          methods: [{ paymentMethodId: randomUUID(), name: "Efectivo", typeCode: "10", amountCents: 4500, reference: null }],
          notice: "Gracias por tu visita.",
          remainingCents: 0,
        },
      })
      .returning({ id: paymentTicket.id })
    return { c, p, ticketId: ticket!.id }
  }

  it("al cobrar, el comprobante sale solo por correo; sin correo, Caja lo dice", async () => {
    const { c, p, ticketId } = await withTicket("lucia@example.com")
    const sent = await run(c, (tx) => sendTicketReceiptByEmail(tx, c.orgId, c.ownerId, p.patientId, ticketId, { storage: noStorage }))
    expect(sent).toMatchObject({ sent: "correo", email: "lucia@example.com" })
    if (sent.sent !== "correo") throw new Error("no salió")
    const [mail] = await ownerDb.select().from(message).where(eq(message.id, sent.messageId))
    expect(mail).toMatchObject({ contentType: "document" })
    expect(mail?.body).toMatch(/^Comprobante N\.º 000007 · /)
    // Nunca por WhatsApp sin que lo pida: su conversación de WhatsApp queda igual.
    expect(await lastOut(p.conversationId)).toBeUndefined()

    const none = await withTicket()
    expect(await run(none.c, (tx) => sendTicketReceiptByEmail(tx, none.c.orgId, none.c.ownerId, none.p.patientId, none.ticketId, { storage: noStorage }))).toEqual({
      sent: null, reason: "sin_correo", text: "Sin correo: entrégalo impreso o pídele su correo",
    })
  })

  it("«Tus papeles» es solo de quien decide por el paciente, y dura 30 días", async () => {
    const { c, p, ticketId } = await withTicket()
    const own = await run(c, (tx) => issuePersonalLink(tx, c.orgId, { contactId: p.contactId, patientId: p.patientId }, { secretsKey: KEY }))
    const view = await run(c, (tx) => getPersonalLinkView(tx, c.orgId, own.token))
    expect(view.papers).toEqual([expect.objectContaining({ kind: "comprobante", id: ticketId, title: "Comprobante N.º 000007" })])
    const paper = await run(c, (tx) => getPersonalLinkPaper(tx, c.orgId, own.token, { kind: "comprobante", id: ticketId }))
    expect(paper.filename).toMatch(/^Comprobante-.*\.pdf$/)
    expect(paper.bytes.byteLength).toBeGreaterThan(100)

    // Un familiar ve su cita, no sus papeles.
    const [relative] = await ownerDb.insert(contact).values({ organizationId: c.orgId, displayName: "Su hermana" }).returning({ id: contact.id })
    await ownerDb.insert(patientContact).values({ organizationId: c.orgId, patientId: p.patientId, contactId: relative!.id, relationship: "family" })
    const theirs = await run(c, (tx) => issuePersonalLink(tx, c.orgId, { contactId: relative!.id, patientId: p.patientId }, { secretsKey: KEY }))
    expect((await run(c, (tx) => getPersonalLinkView(tx, c.orgId, theirs.token))).papers).toEqual([])
    await expect(run(c, (tx) => getPersonalLinkPaper(tx, c.orgId, theirs.token, { kind: "comprobante", id: ticketId }))).rejects.toBeDefined()

    // Uno de hace 31 días ya no está aquí: se le pide a la clínica.
    const [old] = await ownerDb
      .insert(paymentTicket)
      .values({ organizationId: c.orgId, patientId: p.patientId, branchId: c.branchId, ticketNumber: 3, currency: "PEN", totalCents: 100, snapshot: {}, createdAt: new Date(Date.now() - 31 * 24 * HOUR) })
      .returning({ id: paymentTicket.id })
    expect((await run(c, (tx) => getPersonalLinkView(tx, c.orgId, own.token))).papers.map((item) => item.id)).toEqual([ticketId])
    await expect(run(c, (tx) => getPersonalLinkPaper(tx, c.orgId, own.token, { kind: "comprobante", id: old!.id }))).rejects.toMatchObject({ code: "PAPER_UNAVAILABLE" })
  })
})

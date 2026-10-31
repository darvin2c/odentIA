import { randomUUID } from "node:crypto"
import { channelAdapters } from "@odentia/channels"
import { type Db, withOrgContext } from "@odentia/db"
import { appointment, appointmentBookingLink, scheduleRoom } from "@odentia/db/schema/agenda"
import { professionalSchedule } from "@odentia/db/schema/availability"
import { member, user } from "@odentia/db/schema/auth"
import { automationConsent, automationJob, automationLinkToken, automationRule } from "@odentia/db/schema/automation"
import { clinicalFollowUp, patientContact, patientResponsibility, treatmentBudget, treatmentPlan } from "@odentia/db/schema/clinical"
import { agentConfig, channelConnection, channelTemplate, clinicMessageVersion, contact, contactIdentity, conversation, crmTask, message } from "@odentia/db/schema/crm"
import { opportunity } from "@odentia/db/schema/opportunities"
import { auditEvent, branch, orgProfile, } from "@odentia/db/schema/org"
import { saasAction, saasPlan, saasSubscription } from "@odentia/db/schema/saas-billing"
import { workspaceNotification } from "@odentia/db/schema/workspace"
import { and, asc, eq } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { applyAdminDraft, deleteAdminLine, discardAdminDraft, saveAdminDraft, setAdminDraftNote, testAdminLine } from "./admin-drafts.js"
import { adminLineOf } from "./admin-lines.js"
import { type AdminDecider, interpretAdminRequest, keywordAdminDecider, readNumbers } from "./admin-request.js"
import { getAdminLine, getAdminPage, getAdminRecommendation, listAdminLinePeople, runAdminLineOnce } from "./agent-admin.js"
import { confirmAppointmentByContact, confirmProposalByPhone, countAwaitingAnswer, createHandoff, createProposal, listAwaitingAnswer } from "./agent-operations.js"
import { AUTOMATION_MESSAGES, type AutomationMessageKey, replyId } from "./automation-messages.js"
import {
  applyTemplateUpdates,
  automationReplyOf,
  BUDGET_HOLD,
  cancelAppointmentByToken,
  confirmAppointmentByToken,
  deliverDueJobs,
  enqueueAppointmentNotice,
  getMessagePermissions,
  getPublicLinkInfo,
  handleAutomationReply,
  preferredContact,
  listBudgetHeldJobs,
  reconcileDeliveries,
  requestNeededTemplates,
  setConsent,
  setLine,
  type SetLineInput,
  syncAppointmentReminders,
  syncBudgetFollowUps,
  syncCancelledAppointments,
  syncCheckupReminders,
  syncOpportunityFollowUps,
  syncVisitFollowUps,
  UNSUBSCRIBE_WORDS,
  unsubscribeByToken,
} from "./automation.js"
import { assertTemplateSendable, listChannelTemplates, syncConnectionTemplates } from "./channel-templates.js"
import { saveMessageText } from "./clinic-messages.js"
import { createConnection } from "./connections.js"
import { setAppointmentStatus } from "./appointments.js"
import { closeConversationWith } from "./conversation-close.js"
import { ingestInbound } from "./conversations.js"
import { closeOpportunity, createOpportunity, setOpportunityTask } from "./opportunities.js"
import { nextPatientNumber } from "./patients.js"
import { configurePublicLinks } from "./public-links.js"
import { secretsKeyFromEnv } from "./secrets.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"
import type { Storage } from "./storage.js"
import { setWritingHours } from "./writing-hours.js"
import { insertTestPatients } from "./test-patient.js"
import { agentTextsFor } from "./products.js"

/**
 * Automatizaciones de punta a punta contra la base: qué se programa al prender,
 * por dónde le llega el mensaje a cada persona, qué pasa al tocar un botón y qué
 * recibe el equipo cuando no se pudo escribir. Sin proveedor real: «enviado» es
 * dejar el mensaje en la cola y una plantilla «aprobada» es la que declara la
 * conexión de prueba; nada de esto acredita que WhatsApp la acepte.
 */
setupTestDb()
// Los mensajes con «Su enlace» llevan un botón con la dirección de la clínica.
// latidIA en su propio dominio (decisión 9 del lienzo del issue 229).
configurePublicLinks({ webURL: "https://app.odentia.test", cookieDomain: "odentia.test", productDomains: { medical: "latidia.test" } })
const KEY = secretsKeyFromEnv("ab".repeat(32))
const HOUR = 3_600_000
const DAY = 24 * HOUR
// 15:00Z son las 10:00 en Lima de un martes: dentro del «Horario de recontacto».
const NOW = new Date("2026-10-06T15:00:00.000Z")
const all = () => true

interface Clinic {
  orgId: string
  ownerId: string
  professionalId: string
  branchId: string
  roomId: string
  whatsappId: string | null
}

async function clinic(
  options: { whatsapp?: boolean; email?: boolean; approved?: AutomationMessageKey[]; reception?: boolean; anyHour?: boolean } = {},
): Promise<Clinic> {
  const orgId = randomUUID()
  const ownerId = `owner-${orgId}`
  const professionalId = `professional-${orgId}`
  await insertOrg(ownerDb, orgId, `auto-${orgId}`)
  await ownerDb.update(orgProfile).set({ tradeName: "Clínica Sonríe" }).where(eq(orgProfile.organizationId, orgId))
  await ownerDb.insert(user).values([
    { id: ownerId, name: "Dueña", email: `${ownerId}@auto.test`, emailVerified: true },
    { id: professionalId, name: "Dra. Ana Torres", email: `${professionalId}@auto.test`, emailVerified: true },
  ])
  await ownerDb.insert(member).values([
    { id: `m-${ownerId}`, userId: ownerId, organizationId: orgId, role: "owner", createdAt: new Date() },
    { id: `m-${professionalId}`, userId: professionalId, organizationId: orgId, role: "clinician", createdAt: new Date() },
  ])
  // Recepción (quien escribe) y el Administrador, encendidos. Con el horario
  // para escribir a toda hora cuando el caso usa el reloj real.
  await ownerDb.insert(agentConfig).values({
    organizationId: orgId,
    enabled: options.reception !== false,
    advisor: { enabled: true },
    ...(options.anyHour ? { writingHours: Array.from({ length: 7 }, (): Array<[number, number]> => [[0, 1440]]) } : {}),
  })
  const [site] = await ownerDb.insert(branch).values({ organizationId: orgId, name: "Centro", timezone: "America/Lima" }).returning({ id: branch.id })
  const [room] = await ownerDb.insert(scheduleRoom).values({ organizationId: orgId, branchId: site!.id, name: "Unidad dental 1" }).returning({ id: scheduleRoom.id })
  const templates = (options.approved ?? []).map((key) => ({ name: AUTOMATION_MESSAGES[key].template, language: "es" }))
  const connection =
    options.whatsapp === false
      ? null
      : await withOrgContext(appDb, orgId, (tx) =>
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
  return { orgId, ownerId, professionalId, branchId: site!.id, roomId: room!.id, whatsappId: connection?.id ?? null }
}

function run<T>(c: Clinic, fn: (tx: Db) => Promise<T>): Promise<T> {
  return withOrgContext(appDb, c.orgId, fn)
}

type Purpose = "recordatorio" | "seguimiento" | "novedades"

/**
 * Paciente con su persona; opcionalmente con WhatsApp, correo, permisos y un
 * hilo con la ventana abierta (la ventana de 24 horas se mide con el reloj real).
 */
async function person(
  c: Clinic,
  name: string,
  /** `refused`: pidió no recibir ese tipo de mensaje (su baja). */
  options: { whatsapp?: boolean; email?: string; consent?: Purpose[]; refused?: Purpose[]; openWindow?: boolean } = {},
) {
  const [row] = await insertTestPatients(ownerDb, { organizationId: c.orgId, displayName: name, patientNumber: await nextPatientNumber(ownerDb, c.orgId) })
  const [link] = await ownerDb
    .select({ contactId: patientContact.contactId })
    .from(patientContact)
    .where(and(eq(patientContact.organizationId, c.orgId), eq(patientContact.patientId, row!.id)))
  const contactId = link!.contactId
  let conversationId: string | null = null
  if (options.email) await ownerDb.update(contact).set({ email: options.email }).where(eq(contact.id, contactId))
  if (options.whatsapp !== false) {
    const phone = `519${randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "0")}`
    const [identity] = await ownerDb
      .insert(contactIdentity)
      .values({ organizationId: c.orgId, contactId, channel: "whatsapp", externalUserId: phone, isPrimary: true })
      .returning({ id: contactIdentity.id })
    if (options.openWindow && c.whatsappId) {
      const [thread] = await ownerDb
        .insert(conversation)
        .values({
          organizationId: c.orgId, contactId, contactIdentityId: identity!.id, channelConnectionId: c.whatsappId,
          externalThreadId: phone, lastInboundAt: new Date(),
        })
        .returning({ id: conversation.id })
      conversationId = thread!.id
    }
  }
  for (const purpose of options.consent ?? []) {
    await ownerDb.insert(automationConsent).values({ organizationId: c.orgId, contactId, purpose, status: "granted", source: "presencial" })
  }
  for (const purpose of options.refused ?? []) {
    await ownerDb.insert(automationConsent).values({ organizationId: c.orgId, contactId, purpose, status: "revoked", source: "baja" })
  }
  return { patientId: row!.id, contactId, conversationId }
}

async function appointmentFor(c: Clinic, patientId: string, startsAt: Date, status = "programada", minutes = 30) {
  const [row] = await ownerDb
    .insert(appointment)
    .values({
      organizationId: c.orgId, branchId: c.branchId, patientId, professionalUserId: c.professionalId, roomId: c.roomId,
      startsAt, endsAt: new Date(startsAt.getTime() + minutes * 60_000), durationMin: minutes, status,
    })
    .returning({ id: appointment.id })
  return row!.id
}

let budgetNumber = 1
async function budgetFor(c: Clinic, patientId: string, presentedAt: Date, title = "Implante") {
  const [plan] = await ownerDb.insert(treatmentPlan).values({ organizationId: c.orgId, patientId, title: "Plan" }).returning({ id: treatmentPlan.id })
  const [row] = await ownerDb
    .insert(treatmentBudget)
    .values({
      organizationId: c.orgId, patientId, planId: plan!.id, budgetNumber: budgetNumber++, title, currency: "PEN",
      status: "presentado", presentedAt,
    })
    .returning({ id: treatmentBudget.id })
  return row!.id
}

/** Presupuesto que cumple sus 48 horas con la regla ya prendida. */
const dueBudget = (c: Clinic, patientId: string, title?: string) =>
  budgetFor(c, patientId, new Date(NOW.getTime() - 48.5 * HOUR), title)

/** Línea prendida «en» un momento dado: lo que importa es desde cuándo actúa. */
async function ruleOn(c: Clinic, kind: string, enabledAt: Date, config: SetLineInput = {}) {
  const rule = await run(c, (tx) => setLine(tx, c.orgId, c.ownerId, kind, { enabled: true, ...config }))
  await ownerDb.update(automationRule).set({ enabledAt }).where(eq(automationRule.id, rule.id))
  return rule
}

function tasksOf(c: Clinic) {
  return ownerDb.select().from(crmTask).where(eq(crmTask.organizationId, c.orgId))
}

function jobsOf(c: Clinic) {
  return ownerDb.select().from(automationJob).where(eq(automationJob.organizationId, c.orgId)).orderBy(asc(automationJob.scheduledFor), asc(automationJob.id))
}

function noticesOf(c: Clinic) {
  return ownerDb.select().from(workspaceNotification).where(eq(workspaceNotification.organizationId, c.orgId))
}

async function messageOf(id: string | null) {
  const [row] = await ownerDb.select().from(message).where(eq(message.id, id ?? randomUUID()))
  return row!
}

const deliver = (c: Clinic, now = NOW) =>
  run(c, (tx) => deliverDueJobs(tx, c.orgId, now, { secretsKey: KEY, publicBaseUrl: "https://clinica.test" }))

/** Cita cancelada, con la traza de quién la canceló y cuándo. */
async function cancelledAppointment(c: Clinic, patientId: string, cancelledAt: Date, by: "paciente" | "clinica" = "paciente") {
  const id = await appointmentFor(c, patientId, new Date(cancelledAt.getTime() + 2 * DAY), "cancelada", 10)
  await ownerDb.insert(auditEvent).values({
    organizationId: c.orgId, actorUserId: by === "paciente" ? null : c.ownerId, action: "appointment.status_cancelada",
    entity: "appointment", entityId: id, metadata: { from: "programada", cancelReason: by }, createdAt: cancelledAt,
  })
  return id
}

/** Lo que se le pide al Administrador, entendido por el doble determinista del modelo. */
const ask = async (c: Clinic, text: string, decider: AdminDecider = keywordAdminDecider()) => {
  const understood = await interpretAdminRequest(text, decider, agentTextsFor("dental"))
  return run(c, (tx) => saveAdminDraft(tx, c.orgId, c.ownerId, text, understood))
}
const rulesOf = (c: Clinic) => ownerDb.select().from(automationRule).where(eq(automationRule.organizationId, c.orgId))

describe("prender una regla no escribe por nada anterior", () => {
  it("presupuesto: solo los que cumplen el plazo con la regla ya prendida", async () => {
    const c = await clinic()
    const old = await person(c, "Lleva semanas")
    const crossing = await person(c, "Cumple hoy")
    const fresh = await person(c, "Recién presentado")
    await budgetFor(c, old.patientId, new Date(NOW.getTime() - 20 * DAY))
    const due = await budgetFor(c, crossing.patientId, new Date(NOW.getTime() - 49 * HOUR))
    await budgetFor(c, fresh.patientId, new Date(NOW.getTime() - 2 * HOUR))
    // Prendida hace una hora: el de 49 h cumplió sus 48 h ya con la regla prendida.
    await ruleOn(c, "seguimiento_presupuesto", new Date(NOW.getTime() - HOUR))
    expect(await run(c, (tx) => syncBudgetFollowUps(tx, c.orgId, NOW))).toEqual({ programados: 1, omitidos: 0 })
    expect((await jobsOf(c)).map((job) => job.budgetId)).toEqual([due])
    // Repetir el tick no programa nada más.
    expect((await run(c, (tx) => syncBudgetFollowUps(tx, c.orgId, NOW))).programados).toBe(0)
  })

  it("inasistencia: solo citas que empezaron con la regla prendida, y el plazo corre desde que terminó la cita", async () => {
    const c = await clinic()
    const before = await person(c, "Faltó antes")
    const after = await person(c, "Faltó después")
    const tooSoon = await person(c, "Faltó hace poco")
    const enabledAt = new Date(NOW.getTime() - 3 * DAY)
    await appointmentFor(c, before.patientId, new Date(enabledAt.getTime() - 2 * HOUR), "no_asistio")
    const missed = await appointmentFor(c, after.patientId, new Date(NOW.getTime() - 30 * HOUR), "no_asistio")
    await appointmentFor(c, tooSoon.patientId, new Date(NOW.getTime() - 5 * HOUR), "no_asistio")
    await ruleOn(c, "seguimiento_no_asistencia", enabledAt)
    expect((await run(c, (tx) => syncVisitFollowUps(tx, c.orgId, NOW))).programados).toBe(1)
    expect((await jobsOf(c)).map((job) => job.appointmentId)).toEqual([missed])
  })

  it("al volver a prender empieza de cero y lo pendiente no sale", async () => {
    const c = await clinic()
    const p = await person(c, "Con cita")
    await appointmentFor(c, p.patientId, new Date(NOW.getTime() + 20 * HOUR))
    const rule = await run(c, (tx) => setLine(tx, c.orgId, c.ownerId, "recordatorio_cita", { enabled: true }))
    expect(rule).toMatchObject({ enabled: true, agentPart: true, teamPart: true, enabledBy: c.ownerId })
    expect(rule.enabledAt).toBeInstanceOf(Date)
    await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, NOW))
    // De los dos recordatorios (24 h y 3 h) solo cabe el de 3 h: el de 24 h ya pasó hace más de media hora.
    const [job] = await jobsOf(c)
    expect(job).toMatchObject({ status: "pendiente", payload: { timeZone: "America/Lima" } })
    const off = await run(c, (tx) => setLine(tx, c.orgId, c.ownerId, "recordatorio_cita", { enabled: false }))
    expect(off.enabledAt).toEqual(rule.enabledAt)
    expect((await jobsOf(c)).map((item) => [item.status, item.lastError])).toEqual([["cancelado", "Línea apagada"]])
    const on = await run(c, (tx) => setLine(tx, c.orgId, c.ownerId, "recordatorio_cita", { enabled: true }))
    expect(on.enabledAt!.getTime()).toBeGreaterThan(rule.enabledAt!.getTime())
    // Cambiar otra cosa con la línea prendida no mueve desde cuándo actúa.
    const adjusted = await run(c, (tx) => setLine(tx, c.orgId, c.ownerId, "recordatorio_cita", { hoursBefore: [48, 2], enabled: true }))
    expect(adjusted.enabledAt).toEqual(on.enabledAt)
    expect(adjusted.config).toEqual({ hoursBefore: [48, 2] })
  })

  it("una línea es una sola fila con dos partes: apagar las dos la apaga, y solo se ajusta lo que tiene", async () => {
    const c = await clinic()
    const change = (key: string, input: SetLineInput) => run(c, (tx) => setLine(tx, c.orgId, c.ownerId, key, input))
    await change("seguimiento_no_asistencia", { enabled: true })
    const noTask = await change("seguimiento_no_asistencia", { teamPart: false })
    expect(noTask).toMatchObject({ enabled: true, agentPart: true, teamPart: false })
    // Sin ninguna parte no queda nada que hacer: se apaga.
    expect(await change("seguimiento_no_asistencia", { agentPart: false })).toMatchObject({ enabled: false, agentPart: false, teamPart: false })
    await expect(change("seguimiento_no_asistencia", { enabled: true })).rejects.toThrow(/al menos una parte/)
    expect(await ownerDb.select().from(automationRule).where(eq(automationRule.organizationId, c.orgId))).toHaveLength(1)
    // Una línea que solo deja trabajo al equipo no tiene «el agente le escribe».
    expect(await change("cobranza_vencida", { enabled: true, agentPart: true, days: 45 })).toMatchObject({ agentPart: false, teamPart: true, config: { days: 45 } })
    await expect(change("cobranza_vencida", { days: 0 })).rejects.toThrow(/1 a 365/)
    await expect(change("recordatorio_cita", { days: 3 })).rejects.toThrow(/no tiene un plazo/)
    await expect(change("cobranza_vencida", { hoursBefore: [24] })).rejects.toThrow(/no se ajusta por horas/)
    await expect(change("campana", { enabled: true })).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})

describe("los lotes avanzan en orden y no repiten", () => {
  it("con más casos que el tope, el segundo tick toma los siguientes", async () => {
    const c = await clinic()
    const p = await person(c, "Muchas citas")
    const enabledAt = new Date(NOW.getTime() - 6 * DAY)
    // Las inasistencias liberan la unidad dental: pueden coincidir en hora.
    await ownerDb.insert(appointment).values(
      Array.from({ length: 205 }, (_, index) => {
        const startsAt = new Date(NOW.getTime() - 3 * DAY + index * 60_000)
        return {
          organizationId: c.orgId, branchId: c.branchId, patientId: p.patientId, professionalUserId: c.professionalId, roomId: c.roomId,
          startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), durationMin: 30, status: "no_asistio",
        }
      }),
    )
    await ruleOn(c, "seguimiento_no_asistencia", enabledAt)
    expect((await run(c, (tx) => syncVisitFollowUps(tx, c.orgId, NOW))).programados).toBe(200)
    expect((await run(c, (tx) => syncVisitFollowUps(tx, c.orgId, NOW))).programados).toBe(5)
    expect((await run(c, (tx) => syncVisitFollowUps(tx, c.orgId, NOW))).programados).toBe(0)
    expect(await jobsOf(c)).toHaveLength(205)
  })
})

describe("por dónde le llega a cada persona", () => {
  it("escribió hace poco: sale como respuesta por WhatsApp, con sus datos y sus botones", async () => {
    const c = await clinic()
    await ruleOn(c, "seguimiento_presupuesto", new Date(NOW.getTime() - HOUR))
    const p = await person(c, "Lucía Paredes", { consent: ["seguimiento", "novedades"], openWindow: true })
    await dueBudget(c, p.patientId, "Ortodoncia")
    await run(c, (tx) => syncBudgetFollowUps(tx, c.orgId, NOW))
    expect((await deliver(c)).map((result) => result.outcome)).toEqual(["enviado"])
    const [job] = await jobsOf(c)
    expect(job).toMatchObject({ status: "enviado", via: "respuesta", channel: "whatsapp", cause: null })
    expect(await messageOf(job!.sentMessageId)).toMatchObject({
      contentType: "text",
      senderKind: "agent",
      body: "Hola, Lucía. El presupuesto «Ortodoncia» que te presentamos en Clínica Sonríe sigue pendiente. ¿Quieres retomarlo o tienes alguna duda?",
      replyButtons: [
        { id: replyId("responder", job!.id), title: "Quiero retomarlo" },
        { id: replyId("baja", job!.id), title: "No enviar más" },
      ],
    })
  })

  it("no escribió hace poco: sale el mensaje aprobado, con cada dato en su variable", async () => {
    const c = await clinic({ approved: ["recordatorio_cita"] })
    await ruleOn(c, "recordatorio_cita", new Date(NOW.getTime() - HOUR), { hoursBefore: [24] })
    const p = await person(c, "Lucía Paredes", { consent: ["recordatorio"] })
    await appointmentFor(c, p.patientId, new Date(NOW.getTime() + 24 * HOUR))
    await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, NOW))
    expect((await deliver(c)).map((result) => result.outcome)).toEqual(["enviado"])
    const [job] = await jobsOf(c)
    expect(job).toMatchObject({ status: "enviado", via: "plantilla", channel: "whatsapp" })
    const sent = await messageOf(job!.sentMessageId)
    expect(sent).toMatchObject({ contentType: "template", templateName: "odentia_recordatorio_cita_v2", templateLanguage: "es" })
    const params = sent.templateParams as string[]
    expect(params.slice(0, 2)).toEqual(["Lucía", "Clínica Sonríe, sede Centro"])
    // Fecha y hora en la zona de la sede (10:00 en Lima), con el profesional.
    expect(params[2]).toMatch(/^mañana, miércoles 7 de octubre, a las 10:00.*, con Dra\. Ana Torres$/)
    // El hilo muestra el texto que la persona recibió, no solo el nombre de la plantilla.
    expect(sent.body).toBe(`Hola, Lucía. Te recordamos la cita en Clínica Sonríe, sede Centro: ${params[2]}. Si necesitas cambiarla, responde a este mensaje.`)
    expect((sent.replyButtons as { id: string }[]).map((button) => button.id)).toEqual([
      replyId("confirmar", job!.id),
      replyId("responder", job!.id),
      replyId("baja", job!.id),
    ])
  })

  it("sin WhatsApp: sale por el correo de la clínica, con enlaces en vez de botones", async () => {
    const c = await clinic({ email: true })
    await ruleOn(c, "recordatorio_cita", new Date(NOW.getTime() - HOUR), { hoursBefore: [24] })
    const p = await person(c, "Jorge Salas", { whatsapp: false, email: "Jorge@Example.com", consent: ["recordatorio"] })
    await appointmentFor(c, p.patientId, new Date(NOW.getTime() + 24 * HOUR))
    await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, NOW))
    expect((await deliver(c)).map((result) => result.outcome)).toEqual(["enviado"])
    const [job] = await jobsOf(c)
    expect(job).toMatchObject({ status: "enviado", via: "correo", channel: "email" })
    const sent = await messageOf(job!.sentMessageId)
    const lines = (sent.body ?? "").split("\n")
    // La primera línea es el asunto.
    expect(lines[0]).toBe("Recordatorio de cita · Clínica Sonríe")
    // A Jorge le faltan datos: por correo sale el texto de la clínica con una línea más, la de su enlace.
    expect(sent.body).toMatch(/Completar mis datos: https:\/\/auto-\S+\.odentia\.test\/reserva\?token=\{\{su-enlace:[0-9a-f-]{36}\}\}\n/)
    expect(sent.body).toContain("Hola, Jorge. Te recordamos la cita en Clínica Sonríe, sede Centro: mañana, miércoles 7 de octubre")
    // «Confirmar», «Cancelar» y la baja van a la página de la clínica, que es donde viven.
    expect(sent.body).toMatch(/Para confirmar: https:\/\/auto-\S+\.odentia\.test\/c\/\S+\nSi no podrás ir: https:\/\/auto-\S+\.odentia\.test\/c\/\S+/)
    // Al pie, su página «Tus mensajes»; la baja de un toque va en la cabecera del correo (ADR 0040).
    expect(sent.body).toMatch(/Elegir mis mensajes: https:\/\/auto-\S+\.odentia\.test\/reserva\?token=\{\{su-enlace:[0-9a-f-]{36}\}\}#mensajes$/)
    expect(sent.listUnsubscribe).toMatch(/^https:\/\/auto-\S+\.odentia\.test\/baja\/\S+$/)
    expect(sent.replyButtons).toBeNull()
    const [thread] = await ownerDb.select().from(conversation).where(eq(conversation.id, sent.conversationId))
    expect(thread?.externalThreadId).toBe("mail:jorge@example.com")
  })

  it("en un consultorio de latidIA los enlaces del correo van a su dominio", async () => {
    const c = await clinic({ email: true })
    await ownerDb.update(orgProfile).set({ product: "medical" }).where(eq(orgProfile.organizationId, c.orgId))
    await ruleOn(c, "recordatorio_cita", new Date(NOW.getTime() - HOUR), { hoursBefore: [24] })
    const p = await person(c, "Jorge Salas", { whatsapp: false, email: "jorge@example.com", consent: ["recordatorio"] })
    await appointmentFor(c, p.patientId, new Date(NOW.getTime() + 24 * HOUR))
    await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, NOW))
    await deliver(c)
    const [job] = await jobsOf(c)
    const sent = await messageOf(job!.sentMessageId)
    expect(sent.body).toMatch(/Para confirmar: https:\/\/auto-\S+\.latidia\.test\/c\/\S+/)
    expect(sent.body).toMatch(/Elegir mis mensajes: https:\/\/auto-\S+\.latidia\.test\/reserva\?/)
    expect(sent.listUnsubscribe).toMatch(/^https:\/\/auto-\S+\.latidia\.test\/baja\/\S+$/)
  })

  it("mientras WhatsApp no aprueba el mensaje usa el correo de quien lo tiene", async () => {
    const c = await clinic({ email: true })
    await ruleOn(c, "seguimiento_presupuesto", new Date(NOW.getTime() - HOUR))
    const p = await person(c, "Con correo", { email: "con@example.com", consent: ["seguimiento", "novedades"] })
    await dueBudget(c, p.patientId)
    await run(c, (tx) => syncBudgetFollowUps(tx, c.orgId, NOW))
    await deliver(c)
    expect((await jobsOf(c))[0]).toMatchObject({ status: "enviado", via: "correo" })
  })

  it("nunca termina en blanco: cada motivo cierra el trabajo y dice cómo habilitarlo", async () => {
    const c = await clinic()
    await ruleOn(c, "seguimiento_presupuesto", new Date(NOW.getTime() - HOUR))
    const noWay = await person(c, "Sin número ni correo", { whatsapp: false, consent: ["seguimiento", "novedades"] })
    const cold = await person(c, "Nunca escribió", { consent: ["seguimiento", "novedades"] })
    // Retomar un presupuesto es promoción para WhatsApp: solo sale con el sí de novedades (ADR 0040).
    const refused = await person(c, "No aceptó", { refused: ["novedades"] })
    for (const p of [noWay, cold, refused]) await dueBudget(c, p.patientId)
    await run(c, (tx) => syncBudgetFollowUps(tx, c.orgId, NOW))
    await deliver(c)
    const jobs = await jobsOf(c)
    const of = (contactId: string) => jobs.find((job) => job.contactId === contactId)
    expect(of(noWay.contactId)).toMatchObject({ status: "fallido", cause: "sin_destino", attempts: 1 })
    // Sin mensaje aprobado no se intenta el envío: no hay un rechazo del canal que esperar.
    expect(of(cold.contactId)).toMatchObject({ status: "fallido", cause: "sin_plantilla", attempts: 1, sentMessageId: null })
    expect(of(refused.contactId)).toMatchObject({ status: "omitido", cause: "sin_permiso" })
    // La campana no repite «Te espera»: el motivo queda en cada caso y lo muestra
    // la fila «el agente no pudo escribirle a N personas» (ADR 0025).
    expect(await noticesOf(c)).toEqual([])
    // Con la tarea para el equipo prendida, cada persona queda como tarea de llamada, con el motivo y cómo habilitarla.
    const tasks = await tasksOf(c)
    expect(tasks).toHaveLength(3)
    expect(jobs.every((job) => tasks.some((task) => task.id === job.taskId))).toBe(true)
    expect(tasks.find((task) => task.id === of(refused.contactId)?.taskId)).toMatchObject({
      title: "Llamar a No aceptó por su presupuesto",
      createdBy: "admin",
      area: "recepcion",
      reason: "Sofi no pudo escribirle: no aceptó novedades y promociones. Si acepta, anótalo en su página, en Datos › Mensajes.",
      patientId: refused.patientId,
      status: "open",
    })

    const other = await clinic({ whatsapp: false })
    await ruleOn(other, "seguimiento_presupuesto", new Date(NOW.getTime() - HOUR))
    const p = await person(other, "Clínica sin WhatsApp", { consent: ["seguimiento", "novedades"] })
    await dueBudget(other, p.patientId)
    await run(other, (tx) => syncBudgetFollowUps(tx, other.orgId, NOW))
    await deliver(other)
    expect((await jobsOf(other))[0]).toMatchObject({ status: "fallido", cause: "sin_conexion" })
  })

  it("tres personas que se dieron de baja no llenan la campana: cada caso queda con su motivo para «Te espera»", async () => {
    const c = await clinic()
    await ruleOn(c, "seguimiento_presupuesto", new Date(NOW.getTime() - HOUR), { teamPart: false })
    for (const name of ["Uno", "Dos", "Tres"]) await dueBudget(c, (await person(c, name, { refused: ["novedades"] })).patientId)
    await run(c, (tx) => syncBudgetFollowUps(tx, c.orgId, NOW))
    expect((await deliver(c)).map((result) => result.outcome)).toEqual(["omitido", "omitido", "omitido"])
    expect(await noticesOf(c)).toEqual([])
    expect((await jobsOf(c)).map((job) => job.cause)).toEqual(["sin_permiso", "sin_permiso", "sin_permiso"])
    expect((await run(c, (tx) => listAdminLinePeople(tx, c.orgId, all, "seguimiento_presupuesto", { only: "no-pudo" })))).toMatchObject({ total: 3 })
    // Con la tarea apagada no queda ninguna tarea.
    expect(await tasksOf(c)).toHaveLength(0)
  })

  it("«enviado» no es «entregado»: se sigue al mensaje y, si el canal lo rechaza, queda como «no pudo»", async () => {
    const c = await clinic()
    await ruleOn(c, "seguimiento_presupuesto", new Date(NOW.getTime() - HOUR))
    const ok = await person(c, "Escribió hoy", { consent: ["seguimiento", "novedades"], openWindow: true })
    const bounced = await person(c, "Número dado de baja", { consent: ["seguimiento", "novedades"], openWindow: true })
    await dueBudget(c, ok.patientId)
    await dueBudget(c, bounced.patientId)
    await run(c, (tx) => syncBudgetFollowUps(tx, c.orgId, NOW))
    expect((await deliver(c)).map((result) => result.outcome)).toEqual(["enviado", "enviado"])
    // En la cola: todavía nadie lo recibió.
    const people = () => run(c, (tx) => listAdminLinePeople(tx, c.orgId, all, "seguimiento_presupuesto"))
    expect((await people()).items.map((row) => [row.outcome, row.text])).toEqual(
      Array(2).fill(["enviando", "Enviado por WhatsApp; todavía sin confirmación de entrega."]),
    )
    const jobs = await jobsOf(c)
    const okJob = jobs.find((job) => job.contactId === ok.contactId)!
    const bouncedJob = jobs.find((job) => job.contactId === bounced.contactId)!
    await ownerDb.update(message).set({ status: "delivered" }).where(eq(message.id, okJob.sentMessageId!))
    await ownerDb.update(message).set({ status: "failed", error: "131026: número no válido" }).where(eq(message.id, bouncedJob.sentMessageId!))
    expect(await run(c, (tx) => reconcileDeliveries(tx, c.orgId, NOW))).toBe(1)
    const after = (await people()).items
    expect(after.find((row) => row.id === okJob.id)).toMatchObject({ outcome: "entregado", text: "Entregado por WhatsApp. Sin respuesta todavía.", cause: null })
    expect(after.find((row) => row.id === bouncedJob.id)).toMatchObject({
      outcome: "no_pudo",
      cause: "no_entregado",
      text: "Sofi no pudo escribirle: el canal no entregó el mensaje. Lo tiene el equipo de recepción.",
      fix: "Revisa su número.",
    })
    expect((await jobsOf(c)).find((job) => job.id === bouncedJob.id)).toMatchObject({ status: "fallido", lastError: "131026: número no válido" })
    expect(await noticesOf(c)).toEqual([])
    // Solo lo que no llegó: la lista de «no pude» de la línea.
    expect((await run(c, (tx) => listAdminLinePeople(tx, c.orgId, all, "seguimiento_presupuesto", { only: "no-pudo" })))).toMatchObject({ total: 1 })
    // Conciliar otra vez no repite ni suma.
    expect(await run(c, (tx) => reconcileDeliveries(tx, c.orgId, NOW))).toBe(0)
    expect(await noticesOf(c)).toHaveLength(0)
  })

  it("si lo rechaza la cuenta de la clínica (clave vencida), no es del número de la persona ni deja su tarea (ADR 0110)", async () => {
    const c = await clinic()
    await ruleOn(c, "seguimiento_presupuesto", new Date(NOW.getTime() - HOUR))
    const one = await person(c, "Clave vencida", { consent: ["seguimiento", "novedades"], openWindow: true })
    await dueBudget(c, one.patientId)
    await run(c, (tx) => syncBudgetFollowUps(tx, c.orgId, NOW))
    expect((await deliver(c)).map((result) => result.outcome)).toEqual(["enviado"])
    const [job] = await jobsOf(c)
    const expired =
      "WhatsApp no envió el mensaje porque la conexión con Meta venció o fue retirada. Vuelve a conectar con Facebook en Configuración › Integraciones › WhatsApp."
    await ownerDb.update(message).set({ status: "failed", error: expired }).where(eq(message.id, job!.sentMessageId!))
    expect(await run(c, (tx) => reconcileDeliveries(tx, c.orgId, NOW))).toBe(1)
    expect((await jobsOf(c))[0]).toMatchObject({ status: "fallido", cause: "proveedor", lastError: expired })
    expect(await tasksOf(c)).toHaveLength(0)
  })

  it("tras una inasistencia, si la persona ya reservó otra cita no se le escribe", async () => {
    const c = await clinic()
    const p = await person(c, "Ya reservó", { consent: ["seguimiento"], openWindow: true })
    await appointmentFor(c, p.patientId, new Date(NOW.getTime() - 30 * HOUR), "no_asistio")
    await ruleOn(c, "seguimiento_no_asistencia", new Date(NOW.getTime() - 3 * DAY))
    await run(c, (tx) => syncVisitFollowUps(tx, c.orgId, NOW))
    await appointmentFor(c, p.patientId, new Date(NOW.getTime() + 2 * DAY))
    const [result] = await deliver(c)
    expect(result).toMatchObject({ outcome: "cancelado", detail: "Ya tiene otra cita reservada" })
    expect(await noticesOf(c)).toHaveLength(0)
  })
})

describe("el recordatorio de una cita ya confirmada no pide «Confirmar» (ADR 0109)", () => {
  /** Una persona con su cita de mañana a las 10:00 en Lima (o unos minutos antes), en el estado dado. */
  async function remind(c: Clinic, name: string, status: "confirmada" | "programada", options: Parameters<typeof person>[2] & { minutesEarlier?: number } = {}) {
    const p = await person(c, name, { consent: ["recordatorio"], ...options })
    const startsAt = new Date(NOW.getTime() + 24 * HOUR - (options.minutesEarlier ?? 0) * 60_000)
    const appointmentId = await appointmentFor(c, p.patientId, startsAt, status)
    return { ...p, appointmentId }
  }
  const sentTo = async (c: Clinic, contactId: string) => {
    const job = (await jobsOf(c)).find((item) => item.contactId === contactId)!
    return { job, sent: await messageOf(job.sentMessageId) }
  }

  it("con su plantilla aprobada: «Cambiar mi cita» abre su enlace, sin «Confirmar»; la cita por confirmar sigue con él", async () => {
    const c = await clinic({ approved: ["recordatorio_cita", "recordatorio_cita_confirmada"] })
    await ruleOn(c, "recordatorio_cita", new Date(NOW.getTime() - HOUR), { hoursBefore: [24] })
    // A Lucía le faltan datos, como a toda persona de prueba: el enlace del botón los pide primero.
    const lucia = await remind(c, "Lucía Paredes", "confirmada")
    const jorge = await remind(c, "Jorge Salas", "programada", { minutesEarlier: 30 })
    await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, NOW))
    expect((await deliver(c)).map((result) => result.outcome)).toEqual(["enviado", "enviado"])

    const confirmed = await sentTo(c, lucia.contactId)
    expect(confirmed.job).toMatchObject({ kind: "recordatorio_cita", status: "enviado", via: "plantilla", channel: "whatsapp" })
    expect(confirmed.sent).toMatchObject({ contentType: "template", templateName: "odentia_recordatorio_cita_confirmada_v1", templateLanguage: "es" })
    const params = confirmed.sent.templateParams as string[]
    expect([params[0], params[2]]).toEqual(["Lucía", "Clínica Sonríe, sede Centro"])
    expect(params[1]).toMatch(/^mañana, miércoles 7 de octubre, a las 10:00.*, con Dra\. Ana Torres$/)
    expect(confirmed.sent.body).toBe(
      `Hola, Lucía. Te esperamos ${params[1]} en Clínica Sonríe, sede Centro. Si necesitas cambiar la cita, responde a este mensaje.`,
    )
    expect(confirmed.sent.replyButtons).toEqual([
      { id: replyId("responder", confirmed.job.id), title: "No podré ir" },
      { id: replyId("baja", confirmed.job.id), title: "No más recordatorios" },
    ])
    // El botón de dirección lleva su enlace, con esa cita; el token lo pone el worker al enviar.
    expect(confirmed.sent.templateLink).toMatch(/^\{\{su-enlace:[0-9a-f-]{36}\}\}$/)
    const linkId = /su-enlace:([0-9a-f-]{36})/.exec(confirmed.sent.templateLink ?? "")![1]!
    const [link] = await ownerDb.select().from(appointmentBookingLink).where(eq(appointmentBookingLink.id, linkId))
    expect(link).toMatchObject({ contactId: lucia.contactId, patientId: lucia.patientId, appointmentId: lucia.appointmentId, revokedAt: null })

    // La cita que dio el equipo sigue pidiendo «Confirmar».
    const pending = await sentTo(c, jorge.contactId)
    expect(pending.sent.templateName).toBe("odentia_recordatorio_cita_v2")
    expect((pending.sent.replyButtons as { title: string }[]).map((button) => button.title)).toEqual(["Confirmar", "No podré ir", "No más recordatorios"])
    // «No podré ir» sigue la conversación igual que en el de siempre: quiere cambiarla.
    expect(AUTOMATION_MESSAGES.recordatorio_cita_confirmada.buttons.map((button) => button.action)).not.toContain("confirmar")
  })

  it("mientras WhatsApp no aprueba su plantilla sale el recordatorio de siempre, antes que el correo", async () => {
    const c = await clinic({ approved: ["recordatorio_cita"], email: true })
    await ruleOn(c, "recordatorio_cita", new Date(NOW.getTime() - HOUR), { hoursBefore: [24] })
    const lucia = await remind(c, "Lucía Paredes", "confirmada", { email: "lucia@example.com" })
    await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, NOW))
    expect((await deliver(c)).map((result) => result.outcome)).toEqual(["enviado"])
    const { job, sent } = await sentTo(c, lucia.contactId)
    expect(job).toMatchObject({ status: "enviado", via: "plantilla" })
    expect(sent.templateName).toBe("odentia_recordatorio_cita_v2")
    expect((sent.replyButtons as { title: string }[]).map((button) => button.title)).toEqual(["Confirmar", "No podré ir", "No más recordatorios"])
  })

  it("como respuesta dentro de las 24 horas no ofrece «Confirmar», aunque su plantilla espere a WhatsApp", async () => {
    const c = await clinic({ approved: ["recordatorio_cita"] })
    await ruleOn(c, "recordatorio_cita", new Date(NOW.getTime() - HOUR), { hoursBefore: [24] })
    const lucia = await remind(c, "Lucía Paredes", "confirmada", { openWindow: true })
    await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, NOW))
    await deliver(c)
    const { job, sent } = await sentTo(c, lucia.contactId)
    expect(job).toMatchObject({ status: "enviado", via: "respuesta" })
    expect(sent.contentType).toBe("text")
    // El botón de su enlace va escrito al final, como en los demás mensajes con «Su enlace».
    expect(sent.body).toMatch(
      /^Hola, Lucía\. Te esperamos mañana, miércoles 7 de octubre, a las 10:00.*, con Dra\. Ana Torres en Clínica Sonríe, sede Centro\. Si necesitas cambiar la cita, responde a este mensaje\.\n\nCambiar mi cita: https:\/\/auto-\S+\.odentia\.test\/reserva\?token=\{\{su-enlace:[0-9a-f-]{36}\}\}$/,
    )
    expect(sent.replyButtons).toEqual([
      { id: replyId("responder", job.id), title: "No podré ir" },
      { id: replyId("baja", job.id), title: "No más recordatorios" },
    ])
  })

  it("por correo: «Cambiar mi cita» y «Si no podrás ir», sin el enlace para confirmar", async () => {
    const c = await clinic({ whatsapp: false, email: true })
    await ruleOn(c, "recordatorio_cita", new Date(NOW.getTime() - HOUR), { hoursBefore: [24] })
    const rosa = await remind(c, "Rosa Díaz", "confirmada", { whatsapp: false, email: "rosa@example.com" })
    await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, NOW))
    await deliver(c)
    const { job, sent } = await sentTo(c, rosa.contactId)
    expect(job).toMatchObject({ status: "enviado", via: "correo" })
    expect(sent.body).toContain("Hola, Rosa. Te esperamos mañana, miércoles 7 de octubre")
    expect(sent.body).toMatch(/Cambiar mi cita: https:\/\/auto-\S+\.odentia\.test\/reserva\?token=\{\{su-enlace:[0-9a-f-]{36}\}\}\n/)
    expect(sent.body).toMatch(/\nSi no podrás ir: https:\/\/auto-\S+\.odentia\.test\/c\/\S+/)
    expect(sent.body).not.toContain("Para confirmar")
  })
})

describe("como mucho un mensaje al día por persona", () => {
  it("las citas de varios pacientes de una misma persona salen en un solo mensaje", async () => {
    const c = await clinic()
    await ruleOn(c, "recordatorio_cita", new Date(NOW.getTime() - HOUR), { hoursBefore: [24] })
    const parent = await person(c, "Jorge Salas", { consent: ["recordatorio"], openWindow: true })
    const kids = [await person(c, "Mateo Salas", { whatsapp: false }), await person(c, "Sofía Salas", { whatsapp: false })]
    for (const [index, kid] of kids.entries()) {
      // El padre es la persona preferida para lo del niño (solo puede haber una).
      await ownerDb.update(patientContact).set({ isPreferred: false }).where(eq(patientContact.patientId, kid.patientId))
      await ownerDb.insert(patientContact).values({
        organizationId: c.orgId, patientId: kid.patientId, contactId: parent.contactId, relationship: "guardian", isPreferred: true,
      })
      await appointmentFor(c, kid.patientId, new Date(NOW.getTime() + 24 * HOUR + index * 10 * 60_000), "programada", 10)
    }
    await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, NOW))
    expect(await jobsOf(c)).toHaveLength(2)
    // El primero sale ahora y arrastra al segundo, que vence diez minutos después.
    expect((await deliver(c)).map((result) => result.outcome)).toEqual(["enviado"])
    const jobs = await jobsOf(c)
    expect(jobs.map((job) => job.status)).toEqual(["enviado", "enviado"])
    expect(new Set(jobs.map((job) => job.sentMessageId)).size).toBe(1)
    const sent = await messageOf(jobs[0]!.sentMessageId)
    expect(sent.body).toMatch(/^Hola, Jorge\. Te recordamos la cita en Clínica Sonríe, sede Centro: Mateo: mañana, .*, con Dra\. Ana Torres; Sofía: mañana, .*, con Dra\. Ana Torres\./)
    expect(await ownerDb.select().from(message).where(eq(message.conversationId, parent.conversationId!))).toHaveLength(1)
  })

  it("lo de un menor le llega a su representante legal, aunque el registro dejó su propio vínculo como preferido", async () => {
    const c = await clinic()
    await ruleOn(c, "recordatorio_cita", new Date(NOW.getTime() - HOUR), { hoursBefore: [24] })
    const mother = await person(c, "Carla Ramos", { consent: ["recordatorio"], openWindow: true })
    const kid = await person(c, "Tomás Ramos", { whatsapp: false })
    await ownerDb.update(contact).set({ birthDate: "2018-05-01" }).where(eq(contact.id, kid.contactId))
    // Como lo deja el registro que hace su madre: el vínculo propio, preferido; el de ella, no.
    await ownerDb.update(patientContact).set({ isPreferred: true }).where(eq(patientContact.patientId, kid.patientId))
    await ownerDb.insert(patientContact).values({
      organizationId: c.orgId, patientId: kid.patientId, contactId: mother.contactId, relationship: "guardian", isPreferred: false,
    })
    await ownerDb.insert(patientResponsibility).values({
      organizationId: c.orgId, patientId: kid.patientId, contactId: mother.contactId, kind: "representante_legal", startsAt: "2018-05-01",
    })
    expect(await run(c, (tx) => preferredContact(tx, c.orgId, kid.patientId))).toBe(mother.contactId)
    await appointmentFor(c, kid.patientId, new Date(NOW.getTime() + 24 * HOUR))
    await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, NOW))
    expect((await deliver(c)).map((result) => result.outcome)).toEqual(["enviado"])
    const [job] = await jobsOf(c)
    expect((await messageOf(job!.sentMessageId)).conversationId).toBe(mother.conversationId)

    // Si el equipo elige a otra persona (la abuela que lo trae), le llega a ella.
    const grandma = await person(c, "Rosa Ramos", { consent: ["recordatorio"] })
    await ownerDb.update(patientContact).set({ isPreferred: false }).where(eq(patientContact.patientId, kid.patientId))
    await ownerDb.insert(patientContact).values({
      organizationId: c.orgId, patientId: kid.patientId, contactId: grandma.contactId, relationship: "family", isPreferred: true,
    })
    expect(await run(c, (tx) => preferredContact(tx, c.orgId, kid.patientId))).toBe(grandma.contactId)

    // Al cumplir 18 la representación termina: sin otra persona elegida, le llega a él.
    await ownerDb.update(patientContact).set({ isPreferred: false }).where(eq(patientContact.contactId, grandma.contactId))
    await ownerDb.update(contact).set({ birthDate: "2000-05-01" }).where(eq(contact.id, kid.contactId))
    expect(await run(c, (tx) => preferredContact(tx, c.orgId, kid.patientId))).toBe(kid.contactId)
  })

  it("un seguimiento espera a mañana si la persona ya recibió algo hoy; el recordatorio de cita no espera", async () => {
    const c = await clinic()
    await ruleOn(c, "seguimiento_presupuesto", new Date(NOW.getTime() - HOUR))
    await ruleOn(c, "recordatorio_cita", new Date(NOW.getTime() - HOUR), { hoursBefore: [24] })
    const p = await person(c, "Dos motivos", { consent: ["recordatorio", "seguimiento", "novedades"], openWindow: true })
    await appointmentFor(c, p.patientId, new Date(NOW.getTime() + 24 * HOUR))
    await dueBudget(c, p.patientId)
    await run(c, (tx) => syncBudgetFollowUps(tx, c.orgId, NOW))
    await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, NOW))
    const results = await deliver(c)
    expect(results.map((result) => [result.outcome, result.detail]).sort()).toEqual([
      ["enviado", undefined],
      ["pospuesto", "Ya recibió un mensaje hoy"],
    ])
    const jobs = await jobsOf(c)
    expect(jobs.find((job) => job.kind === "recordatorio_cita")?.status).toBe("enviado")
    const followUp = jobs.find((job) => job.kind === "seguimiento_presupuesto")!
    expect(followUp.status).toBe("pendiente")
    // Mañana a las 8:00 de Lima, cuando empieza el horario de recontacto.
    expect(followUp.scheduledFor.toISOString()).toBe("2026-10-07T13:00:00.000Z")
  })
})

describe("los botones que resuelve el sistema, sin modelo", () => {
  async function remindedByWhatsApp() {
    const c = await clinic({ anyHour: true })
    await ruleOn(c, "recordatorio_cita", new Date(Date.now() - HOUR), { hoursBefore: [24] })
    const p = await person(c, "Lucía Paredes", { consent: ["recordatorio"], openWindow: true })
    const appointmentId = await appointmentFor(c, p.patientId, new Date(Date.now() + 24 * HOUR))
    const now = new Date()
    await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, now))
    await deliver(c, now)
    const [job] = await jobsOf(c)
    return { c, p, appointmentId, job: job! }
  }

  it("el «sí» de un padre confirma las citas de quienes lleva y dice cuáles, por escrito y con el botón", async () => {
    const c = await clinic({ anyHour: true })
    await ruleOn(c, "recordatorio_cita", new Date(Date.now() - HOUR), { hoursBefore: [24] })
    const parent = await person(c, "Martín Salas", { openWindow: true })
    const kids = [await person(c, "Sofía Salas", { whatsapp: false }), await person(c, "Pedro Salas", { whatsapp: false })]
    const ids: string[] = []
    for (const [index, kid] of kids.entries()) {
      await ownerDb.update(patientContact).set({ isPreferred: false }).where(eq(patientContact.patientId, kid.patientId))
      await ownerDb.insert(patientContact).values({
        organizationId: c.orgId, patientId: kid.patientId, contactId: parent.contactId, relationship: "guardian", isPreferred: true,
      })
      await ownerDb.insert(patientResponsibility).values({
        organizationId: c.orgId, patientId: kid.patientId, contactId: parent.contactId, kind: "representante_legal", startsAt: "2020-01-01",
      })
      ids.push(await appointmentFor(c, kid.patientId, new Date(Date.now() + 24 * HOUR + index * 10 * 60_000), "programada", 10))
    }
    const now = new Date()
    await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, now))
    await deliver(c, now)
    // Escribe «sí, ahí estaremos»: sin decir cuál, confirma las del recordatorio que recibió, como el botón.
    const written = await run(c, (tx) => confirmAppointmentByContact(tx, c.orgId, { contactId: parent.contactId, conversationId: parent.conversationId! }))
    expect(written).toMatchObject({ outcome: "confirmada", reply: "¡Listo! Confirmé las citas de Sofía y Pedro. Te esperamos." })
    const rows = await ownerDb.select({ status: appointment.status }).from(appointment).where(eq(appointment.organizationId, c.orgId))
    expect(rows.map((row) => row.status)).toEqual(["confirmada", "confirmada"])
    // El botón después: ya estaban confirmadas, y lo dice con sus nombres.
    const [job] = await jobsOf(c)
    expect(await run(c, (tx) => handleAutomationReply(tx, c.orgId, { conversationId: parent.conversationId!, replyId: replyId("confirmar", job!.id) }))).toBe(true)
    const thread = await ownerDb.select().from(message).where(eq(message.conversationId, parent.conversationId!)).orderBy(asc(message.createdAt))
    expect(thread.at(-1)?.body).toBe("Las citas de Sofía y Pedro ya estaban confirmadas. ¡Te esperamos!")
  })

  it("«Confirmar» confirma la cita por la operación de la agenda y responde con un texto fijo", async () => {
    const { c, p, appointmentId, job } = await remindedByWhatsApp()
    const handled = await run(c, (tx) =>
      handleAutomationReply(tx, c.orgId, { conversationId: p.conversationId!, replyId: replyId("confirmar", job.id) }),
    )
    expect(handled).toBe(true)
    const [row] = await ownerDb.select().from(appointment).where(eq(appointment.id, appointmentId))
    expect(row).toMatchObject({ status: "confirmada", version: 2 })
    const audits = await ownerDb.select().from(auditEvent).where(and(eq(auditEvent.organizationId, c.orgId), eq(auditEvent.entityId, appointmentId)))
    expect(audits.map((event) => [event.action, event.actorUserId, event.metadata])).toEqual([
      ["appointment.status_confirmada", null, { from: "programada", via: "respuesta" }],
    ])
    const thread = await ownerDb.select().from(message).where(eq(message.conversationId, p.conversationId!)).orderBy(asc(message.createdAt))
    expect(thread.at(-1)).toMatchObject({ direction: "out", senderKind: "agent", body: "¡Listo! Tu cita quedó confirmada. Te esperamos." })
    // Tocarlo otra vez no cambia nada y lo dice.
    await run(c, (tx) => handleAutomationReply(tx, c.orgId, { conversationId: p.conversationId!, replyId: replyId("confirmar", job.id) }))
    const again = await ownerDb.select().from(message).where(eq(message.conversationId, p.conversationId!)).orderBy(asc(message.createdAt))
    expect(again.at(-1)?.body).toBe("Tu cita ya estaba confirmada. ¡Te esperamos!")
  })

  it("«Confirmar» en una conversación cerrada: el toque la reabre, confirma la cita y el mensaje no se pierde", async () => {
    const { c, p, appointmentId, job } = await remindedByWhatsApp()
    await run(c, (tx) => closeConversationWith(tx, c.orgId, p.conversationId!, { reason: "sin_respuesta", byUserId: null }))
    const [thread] = await ownerDb.select().from(conversation).where(eq(conversation.id, p.conversationId!))
    const tapped = await run(c, (tx) =>
      ingestInbound(
        tx,
        {
          orgId: c.orgId,
          connectionId: c.whatsappId!,
          event: {
            externalEventId: `evt-${randomUUID()}`,
            externalMessageId: `wamid-${randomUUID()}`,
            externalThreadId: thread!.externalThreadId,
            senderExternalId: thread!.externalThreadId,
            content: { type: "text", text: "Confirmar", replyId: replyId("confirmar", job.id) },
            sentAt: new Date().toISOString(),
          },
        },
        channelAdapters.whatsapp_cloud_api!,
        { storage: {} as never, fetch, secretsKey: KEY },
      ),
    )
    expect(tapped.conversationId).toBe(p.conversationId)
    const handled = await run(c, (tx) =>
      handleAutomationReply(tx, c.orgId, { conversationId: p.conversationId!, replyId: replyId("confirmar", job.id) }),
    )
    expect(handled).toBe(true)
    const [reopened] = await ownerDb.select().from(conversation).where(eq(conversation.id, p.conversationId!))
    expect(reopened).toMatchObject({ status: "open", closeReason: null, closedAt: null, agentStatus: "on", nudgedAt: null })
    const [row] = await ownerDb.select().from(appointment).where(eq(appointment.id, appointmentId))
    expect(row?.status).toBe("confirmada")
    const messages = await ownerDb.select().from(message).where(eq(message.conversationId, p.conversationId!)).orderBy(asc(message.createdAt))
    expect(messages.some((item) => item.id === tapped.messageId && item.body === "Confirmar")).toBe(true)
    expect(messages.at(-1)).toMatchObject({ direction: "out", body: "¡Listo! Tu cita quedó confirmada. Te esperamos." })
    const reopenedBy = await ownerDb.select().from(auditEvent).where(and(eq(auditEvent.organizationId, c.orgId), eq(auditEvent.entityId, p.conversationId!), eq(auditEvent.action, "conversation.reopened_by_message")))
    expect(reopenedBy).toHaveLength(1)
  })

  it("«No podré ir» y un texto cualquiera siguen la conversación; un botón ajeno no hace nada", async () => {
    const { c, p, appointmentId, job } = await remindedByWhatsApp()
    const reply = (conversationId: string, value: string | null) =>
      run(c, (tx) => handleAutomationReply(tx, c.orgId, { conversationId, replyId: value }))
    expect(await reply(p.conversationId!, replyId("responder", job.id))).toBe(false)
    expect(await reply(p.conversationId!, null)).toBe(false)
    expect(await reply(p.conversationId!, "odentia:confirmar:no-es-un-trabajo")).toBe(false)
    // El mismo botón, llegado por la conversación de otra persona.
    const stranger = await person(c, "Otra persona", { openWindow: true })
    expect(await reply(stranger.conversationId!, replyId("confirmar", job.id))).toBe(false)
    const [row] = await ownerDb.select().from(appointment).where(eq(appointment.id, appointmentId))
    expect(row?.status).toBe("programada")
  })

  it("«No enviar más» apaga ese tipo de mensaje, no los demás, y queda en su ficha", async () => {
    const { c, p, job } = await remindedByWhatsApp()
    await run(c, (tx) => setConsent(tx, c.orgId, c.ownerId, p.contactId, { purpose: "seguimiento", granted: true, source: "conversacion" }))
    const handled = await run(c, (tx) =>
      handleAutomationReply(tx, c.orgId, { conversationId: p.conversationId!, replyId: replyId("baja", job.id) }),
    )
    expect(handled).toBe(true)
    expect(await run(c, (tx) => getMessagePermissions(tx, c.orgId, p.contactId))).toMatchObject([
      { purpose: "recordatorio", granted: false, source: "baja" },
      { purpose: "seguimiento", granted: true, source: "conversacion" },
      { purpose: "novedades", granted: null },
      // Los avisos de su cita siguen: «No más recordatorios» no los apaga (ADR 0040).
      { purpose: "avisos", granted: null },
    ])
    const thread = await ownerDb.select().from(message).where(eq(message.conversationId, p.conversationId!)).orderBy(asc(message.createdAt))
    expect(thread.at(-1)?.body).toBe("Listo, Lucía, ya no te enviaremos recordatorios. Si tu cita cambia, te avisamos igual.")
  })
})

describe("los enlaces del correo pasan por la agenda", () => {
  async function remindedByEmail() {
    const c = await clinic({ whatsapp: false, email: true, anyHour: true })
    await ruleOn(c, "recordatorio_cita", new Date(Date.now() - HOUR), { hoursBefore: [24] })
    const p = await person(c, "Lucía Paredes", { whatsapp: false, email: "lucia@example.com", consent: ["recordatorio", "seguimiento"] })
    const appointmentId = await appointmentFor(c, p.patientId, new Date(Date.now() + 24 * HOUR))
    const now = new Date()
    await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, now))
    await deliver(c, now)
    const [job] = await jobsOf(c)
    const sent = await messageOf(job!.sentMessageId)
    const body = sent.body ?? ""
    const [confirmToken, cancelToken] = [...body.matchAll(/https:\/\/auto-\S+\.odentia\.test\/c\/(\S+)/g)].map((match) => match[1]!)
    // La baja de un toque va en la cabecera `List-Unsubscribe` (RFC 2369).
    const bajaToken = /https:\/\/auto-\S+\.odentia\.test\/baja\/(\S+)/.exec(sent.listUnsubscribe ?? "")![1]!
    return { c, p, appointmentId, confirmToken: confirmToken!, cancelToken: cancelToken!, bajaToken }
  }

  it("confirmar deja la traza de la cita e invalida el otro enlace", async () => {
    const { c, appointmentId, confirmToken, cancelToken } = await remindedByEmail()
    expect(await run(c, (tx) => confirmAppointmentByToken(tx, confirmToken))).toEqual({ appointmentId, status: "confirmada" })
    const [row] = await ownerDb.select().from(appointment).where(eq(appointment.id, appointmentId))
    expect(row).toMatchObject({ status: "confirmada", version: 2 })
    const audits = await ownerDb.select().from(auditEvent).where(and(eq(auditEvent.organizationId, c.orgId), eq(auditEvent.entityId, appointmentId)))
    expect(audits.map((event) => [event.entity, event.action, event.actorUserId, event.metadata])).toEqual([
      ["appointment", "appointment.status_confirmada", null, { from: "programada", via: "enlace-publico" }],
    ])
    const tokens = await ownerDb.select().from(automationLinkToken).where(and(eq(automationLinkToken.organizationId, c.orgId), eq(automationLinkToken.appointmentId, appointmentId)))
    expect(tokens.every((token) => token.usedAt !== null)).toBe(true)
    await expect(run(c, (tx) => cancelAppointmentByToken(tx, cancelToken))).rejects.toMatchObject({ code: "LINK_USED" })
  })

  it("cancelar anota que lo pidió la persona y no deja reabrir", async () => {
    const { c, appointmentId, confirmToken, cancelToken } = await remindedByEmail()
    expect(await run(c, (tx) => cancelAppointmentByToken(tx, cancelToken))).toEqual({ appointmentId, status: "cancelada" })
    const [event] = await ownerDb.select().from(auditEvent).where(and(eq(auditEvent.organizationId, c.orgId), eq(auditEvent.entityId, appointmentId)))
    expect(event).toMatchObject({ action: "appointment.status_cancelada", actorUserId: null, metadata: { from: "programada", via: "enlace-publico", cancelReason: "paciente" } })
    await expect(run(c, (tx) => confirmAppointmentByToken(tx, confirmToken))).rejects.toMatchObject({ code: "LINK_USED" })
  })

  it("la baja del enlace apaga solo el tipo de mensaje de ese correo", async () => {
    const { c, p, bajaToken } = await remindedByEmail()
    // La página dice el tipo que apaga (el del recordatorio), no «todos los mensajes».
    expect((await run(c, (tx) => getPublicLinkInfo(tx, bajaToken))).stops).toEqual(UNSUBSCRIBE_WORDS.recordatorio)
    await run(c, (tx) => unsubscribeByToken(tx, bajaToken))
    expect(await run(c, (tx) => getMessagePermissions(tx, c.orgId, p.contactId))).toMatchObject([
      { purpose: "recordatorio", granted: false, source: "baja" },
      { purpose: "seguimiento", granted: true },
      { purpose: "novedades", granted: null },
      { purpose: "avisos", granted: null },
    ])
  })
})

describe("quién lo hace: el agente, una persona o los dos", () => {
  it("con «el agente le escribe» apagado, el caso queda como tarea y no sale ningún mensaje", async () => {
    const c = await clinic()
    await ruleOn(c, "seguimiento_no_asistencia", new Date(NOW.getTime() - 3 * DAY), { agentPart: false })
    const p = await person(c, "Jorge Salas", { consent: ["seguimiento"], openWindow: true })
    await appointmentFor(c, p.patientId, new Date(NOW.getTime() - 30 * HOUR), "no_asistio")
    await run(c, (tx) => syncVisitFollowUps(tx, c.orgId, NOW))
    expect((await deliver(c)).map((result) => result.outcome)).toEqual(["tarea"])
    const [job] = await jobsOf(c)
    expect(job).toMatchObject({ status: "tarea", sentMessageId: null, cause: null })
    expect(await tasksOf(c)).toMatchObject([
      { id: job!.taskId, title: "Llamar a Jorge Salas para reagendar su cita", createdBy: "admin", area: "recepcion", reason: "Una persona falta a su cita" },
    ])
    expect(await noticesOf(c)).toHaveLength(0)
    expect((await run(c, (tx) => listAdminLinePeople(tx, c.orgId, all, "seguimiento_no_asistencia"))).items[0]).toMatchObject({
      outcome: "tarea", text: "Quedó una tarea para el equipo de recepción.",
    })
  })

  it("con Recepción apagada no sale nada, y lo que quedó atrás no se envía", async () => {
    const c = await clinic({ reception: false })
    await ruleOn(c, "seguimiento_presupuesto", new Date(NOW.getTime() - HOUR))
    const p = await person(c, "En pausa", { consent: ["seguimiento", "novedades"], openWindow: true })
    await dueBudget(c, p.patientId)
    await run(c, (tx) => syncBudgetFollowUps(tx, c.orgId, NOW))
    expect(await deliver(c)).toMatchObject([{ outcome: "cancelado", detail: "Sofi no atiende" }])
    expect(await tasksOf(c)).toHaveLength(0)
    expect(await noticesOf(c)).toHaveLength(0)
  })
})

describe("retirar un permiso", () => {
  it("cancela lo que estaba por salir de ese tipo y deja lo demás", async () => {
    const c = await clinic()
    await ruleOn(c, "seguimiento_presupuesto", new Date(NOW.getTime() - HOUR))
    await ruleOn(c, "recordatorio_control", new Date(NOW.getTime() - HOUR))
    const p = await person(c, "Dos pendientes", { consent: ["recordatorio", "seguimiento"] })
    await dueBudget(c, p.patientId)
    await ownerDb.insert(clinicalFollowUp).values({
      organizationId: c.orgId, patientId: p.patientId, kind: "mantenimiento", title: "Control de ortodoncia", dueAt: new Date(NOW.getTime() + DAY),
    })
    await run(c, (tx) => syncBudgetFollowUps(tx, c.orgId, NOW))
    await run(c, (tx) => syncCheckupReminders(tx, c.orgId, NOW))
    await run(c, (tx) => setConsent(tx, c.orgId, c.ownerId, p.contactId, { purpose: "seguimiento", granted: false }))
    // El control es de «Controles y seguimiento»; retomar el presupuesto, de novedades (ADR 0040).
    expect((await jobsOf(c)).map((job) => [job.kind, job.status]).sort()).toEqual([
      ["recordatorio_control", "cancelado"],
      ["seguimiento_presupuesto", "pendiente"],
    ])
    await expect(
      run(c, (tx) => setConsent(tx, c.orgId, c.ownerId, p.contactId, { purpose: "recordatorio", granted: true, source: "por_ahi" })),
    ).rejects.toMatchObject({ code: "VALIDATION" })
  })
})

// --------------------------------------------- mensajes aprobados por WhatsApp ---

/** `fetch` de prueba: guarda cada llamada y responde lo que se le diga, en orden. */
function fakeMeta(...responses: { status?: number; json: unknown }[]) {
  const calls: { url: string; method: string; body: unknown }[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined })
    const next = responses.shift()
    return new Response(JSON.stringify(next?.json ?? {}), { status: next?.status ?? 200 })
  }) as typeof fetch
  return { calls, fetch: impl }
}

/** Deja a la conexión sin la plantilla de un mensaje, como cuando WhatsApp no aceptó pedirla al conectar. */
async function forgetTemplate(c: Clinic, key: AutomationMessageKey) {
  await ownerDb
    .delete(channelTemplate)
    .where(and(eq(channelTemplate.connectionId, c.whatsappId!), eq(channelTemplate.name, AUTOMATION_MESSAGES[key].template)))
}

describe("odentIA pide a WhatsApp la aprobación de sus mensajes", () => {
  it("al conectar quedan pedidos los dieciocho, sin esperar a que se prenda una línea", async () => {
    const c = await clinic()
    expect((await run(c, (tx) => listChannelTemplates(tx, c.orgId, c.whatsappId!))).map((item) => [item.name, item.status, item.messageKey])).toEqual([
      ["odentia_aviso_cita_cancelada_v2", "en_revision", "aviso_cita_cancelada"],
      ["odentia_aviso_cita_datos_v2", "en_revision", "aviso_cita_reservada_datos"],
      ["odentia_aviso_cita_movida_v2", "en_revision", "aviso_cita_movida"],
      ["odentia_aviso_cita_reservada_v2", "en_revision", "aviso_cita_reservada"],
      ["odentia_cita_cancelada_v1", "en_revision", "cita_cancelada"],
      ["odentia_cita_sin_llegar_v1", "en_revision", "cita_sin_llegar"],
      ["odentia_invitar_a_volver_v1", "en_revision", "invitar_a_volver"],
      ["odentia_presupuesto_listo_v2", "en_revision", "presupuesto_listo"],
      ["odentia_recordatorio_cita_confirmada_v1", "en_revision", "recordatorio_cita_confirmada"],
      ["odentia_recordatorio_cita_datos_v1", "en_revision", "recordatorio_cita_datos"],
      ["odentia_recordatorio_cita_v2", "en_revision", "recordatorio_cita"],
      ["odentia_recordatorio_control_v1", "en_revision", "recordatorio_control"],
      ["odentia_retomar_conversacion_v1", "en_revision", "retomar_conversacion"],
      ["odentia_seguimiento_inasistencia_v1", "en_revision", "seguimiento_no_asistencia"],
      ["odentia_seguimiento_oportunidad_v1", "en_revision", "seguimiento_comercial"],
      ["odentia_seguimiento_presupuesto_v1", "en_revision", "seguimiento_presupuesto"],
      ["odentia_su_enlace_v1", "en_revision", "su_enlace"],
      ["odentia_ver_respuesta_v1", "en_revision", "ver_respuesta"],
    ])
    // Ya están pedidos: el ciclo no vuelve a llamar a WhatsApp.
    const meta = fakeMeta()
    expect(await run(c, (tx) => requestNeededTemplates(tx, c.orgId, KEY, NOW, { fetch: meta.fetch }))).toBe(0)
    expect(meta.calls).toHaveLength(0)
  })

  it("el ciclo pide lo que faltó una sola vez, y sale cuando WhatsApp lo aprueba", async () => {
    const c = await clinic()
    await forgetTemplate(c, "recordatorio_cita")
    await ruleOn(c, "recordatorio_cita", new Date(NOW.getTime() - HOUR), { hoursBefore: [24] })
    const meta = fakeMeta({ json: { id: "950", status: "PENDING", category: "UTILITY" } })
    expect(await run(c, (tx) => requestNeededTemplates(tx, c.orgId, KEY, NOW, { fetch: meta.fetch }))).toBe(1)
    expect(meta.calls).toHaveLength(1)
    expect(meta.calls[0]).toMatchObject({
      method: "POST",
      body: {
        name: "odentia_recordatorio_cita_v2",
        language: "es",
        category: "UTILITY",
        components: [
          { type: "BODY", text: AUTOMATION_MESSAGES.recordatorio_cita.body, example: { body_text: [["Lucía", "Clínica Sonríe, sede Centro", "mañana, martes 13 de octubre, a las 10:00, con Dra. Ana Torres"]] } },
          { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Confirmar" }, { type: "QUICK_REPLY", text: "No podré ir" }, { type: "QUICK_REPLY", text: "No más recordatorios" }] },
        ],
      },
    })
    expect((await run(c, (tx) => listChannelTemplates(tx, c.orgId, c.whatsappId!))).find((item) => item.name === "odentia_recordatorio_cita_v2")).toMatchObject(
      { status: "en_revision", category: "utility", variables: 3, messageKey: "recordatorio_cita" },
    )
    expect(
      (await ownerDb.select().from(channelTemplate).where(and(eq(channelTemplate.connectionId, c.whatsappId!), eq(channelTemplate.name, "odentia_recordatorio_cita_v2"))))[0]?.externalId,
    ).toBe("950")
    // Ya está pedido: el siguiente tick no vuelve a llamar.
    expect(await run(c, (tx) => requestNeededTemplates(tx, c.orgId, KEY, NOW, { fetch: meta.fetch }))).toBe(0)
    expect(meta.calls).toHaveLength(1)

    // En revisión todavía no se puede enviar, y se dice por qué.
    const p = await person(c, "Lucía Paredes", { consent: ["recordatorio"] })
    await appointmentFor(c, p.patientId, new Date(NOW.getTime() + 24 * HOUR))
    await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, NOW))
    await deliver(c)
    expect((await jobsOf(c))[0]).toMatchObject({ status: "fallido", cause: "sin_plantilla" })
    expect((await jobsOf(c))[0]?.lastError).toContain("WhatsApp aún no aprueba el mensaje")

    // WhatsApp avisa que la aprobó: quien administra se entera y el siguiente recordatorio sale.
    const update = { externalId: "950", name: "odentia_recordatorio_cita_v2", language: "es", status: "aprobada" as const, reason: null }
    expect(await run(c, (tx) => applyTemplateUpdates(tx, c.orgId, c.whatsappId!, [update]))).toBe(1)
    expect(await run(c, (tx) => applyTemplateUpdates(tx, c.orgId, c.whatsappId!, [update]))).toBe(0)
    expect((await noticesOf(c)).map((notice) => [notice.title, notice.href])).toContainEqual([
      "WhatsApp aprobó un mensaje: «Recordar la cita»",
      "/settings/integrations/whatsapp",
    ])
    const next = await person(c, "Jorge Salas", { consent: ["recordatorio"] })
    const later = new Date(NOW.getTime() + 45 * 60_000)
    await appointmentFor(c, next.patientId, new Date(later.getTime() + 24 * HOUR))
    await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, later))
    await deliver(c, later)
    expect((await jobsOf(c)).find((job) => job.contactId === next.contactId)).toMatchObject({ status: "enviado", via: "plantilla" })
  })

  it("si WhatsApp no acepta la solicitud, avisa una vez con el motivo y reintenta al día siguiente", async () => {
    const c = await clinic()
    // La línea está apagada: el mensaje se pide igual.
    await forgetTemplate(c, "seguimiento_presupuesto")
    const meta = fakeMeta(
      { status: 400, json: { error: { message: "(#200) Permissions error" } } },
      { json: { id: "951", status: "PENDING", category: "MARKETING" } },
    )
    expect(await run(c, (tx) => requestNeededTemplates(tx, c.orgId, KEY, NOW, { fetch: meta.fetch }))).toBe(0)
    expect(await run(c, (tx) => requestNeededTemplates(tx, c.orgId, KEY, NOW, { fetch: meta.fetch }))).toBe(0)
    expect(meta.calls).toHaveLength(1)
    const notices = await noticesOf(c)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ title: "WhatsApp no aceptó la solicitud de un mensaje", href: "/settings/integrations/whatsapp" })
    expect(notices[0]?.body).toContain("«Retomar un presupuesto». Motivo: WhatsApp no aceptó la solicitud de plantilla: (#200) Permissions error")
    expect((await run(c, (tx) => listChannelTemplates(tx, c.orgId, c.whatsappId!))).map((item) => item.name)).not.toContain("odentia_seguimiento_presupuesto_v1")
    const tomorrow = new Date(NOW.getTime() + DAY)
    expect(await run(c, (tx) => requestNeededTemplates(tx, c.orgId, KEY, tomorrow, { fetch: meta.fetch }))).toBe(1)
  })

  it("una plantilla rechazada o pausada dice el motivo de WhatsApp y no se puede enviar", async () => {
    const c = await clinic({ approved: ["seguimiento_presupuesto"] })
    const name = AUTOMATION_MESSAGES.seguimiento_presupuesto.template
    const sendable = (params: number) =>
      run(c, (tx) => assertTemplateSendable(tx, c.orgId, c.whatsappId!, { name, language: "es", params, category: "marketing", contactId: null }))
    await expect(sendable(3)).resolves.toMatchObject({ status: "aprobada" })
    await run(c, (tx) => applyTemplateUpdates(tx, c.orgId, c.whatsappId!, [{ externalId: null, name, language: "es", status: "pausada", reason: "Calidad baja" }]))
    await expect(sendable(3)).rejects.toThrow(`La plantilla «${name}» está pausada (Calidad baja): no se puede enviar`)
    expect((await noticesOf(c)).map((notice) => [notice.title, notice.body])).toEqual([
      ["WhatsApp pausó un mensaje: «Retomar un presupuesto»", "Motivo: Calidad baja. Mientras tanto solo sale como respuesta o por correo. WhatsApp lo reactiva solo si mejora su calidad."],
    ])
    await expect(run(c, (tx) => assertTemplateSendable(tx, c.orgId, c.whatsappId!, { name: "inventada", language: "es", params: 0, category: "utility", contactId: null }))).rejects.toThrow("Plantilla no autorizada en esta conexión")
  })

  it("si WhatsApp pausa un mensaje, el aviso dice a cuántas personas les toca ya", async () => {
    const c = await clinic({ approved: ["recordatorio_cita"], anyHour: true })
    await ruleOn(c, "recordatorio_cita", new Date(Date.now() - DAY))
    for (const name of ["Mañana uno", "Mañana dos"]) {
      const p = await person(c, name, { consent: ["recordatorio"] })
      await appointmentFor(c, p.patientId, new Date(Date.now() + (name.endsWith("uno") ? 20 : 21) * HOUR), "programada", 10)
    }
    await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, new Date()))
    const name = AUTOMATION_MESSAGES.recordatorio_cita.template
    await run(c, (tx) => applyTemplateUpdates(tx, c.orgId, c.whatsappId!, [{ externalId: null, name, language: "es", status: "pausada", reason: "Calidad baja" }]))
    const [notice] = await noticesOf(c)
    expect(notice!.body).toBe(
      "Motivo: Calidad baja. Mientras tanto solo sale como respuesta o por correo. WhatsApp lo reactiva solo si mejora su calidad. 2 personas lo tienen por salir en las próximas 24 horas: a quien no le llegue lo verás con su motivo en Agente › Argos.",
    )
  })

  it("lee el catálogo de la cuenta: nadie escribe nombres, y lo que ya no está deja de servir", async () => {
    const c = await clinic({ approved: ["recordatorio_control"] })
    const meta = fakeMeta({
      json: {
        data: [
          { id: "1", name: "bienvenida", language: "es", status: "APPROVED", category: "MARKETING", components: [{ type: "BODY", text: "Hola, {{1}}." }] },
          { id: "2", name: "odentia_recordatorio_cita_v2", language: "es", status: "REJECTED", category: "UTILITY", rejected_reason: "INVALID_FORMAT", components: [{ type: "BODY", text: "x {{1}} {{2}} {{3}}" }] },
        ],
      },
    })
    const synced = await run(c, (tx) => syncConnectionTemplates(tx, c.orgId, c.whatsappId!, KEY, { fetch: meta.fetch }))
    // Lo recién pedido puede no aparecer aún en la lectura de la cuenta: sigue en revisión.
    expect(synced.map((item) => [item.name, item.status, item.messageKey, item.variables])).toEqual([
      ["bienvenida", "aprobada", null, 1],
      ["odentia_aviso_cita_cancelada_v2", "en_revision", "aviso_cita_cancelada", 3],
      ["odentia_aviso_cita_datos_v2", "en_revision", "aviso_cita_reservada_datos", 3],
      ["odentia_aviso_cita_movida_v2", "en_revision", "aviso_cita_movida", 3],
      ["odentia_aviso_cita_reservada_v2", "en_revision", "aviso_cita_reservada", 3],
      ["odentia_cita_cancelada_v1", "en_revision", "cita_cancelada", 3],
      ["odentia_cita_sin_llegar_v1", "en_revision", "cita_sin_llegar", 3],
      ["odentia_invitar_a_volver_v1", "en_revision", "invitar_a_volver", 2],
      ["odentia_presupuesto_listo_v2", "en_revision", "presupuesto_listo", 2],
      ["odentia_recordatorio_cita_confirmada_v1", "en_revision", "recordatorio_cita_confirmada", 3],
      ["odentia_recordatorio_cita_datos_v1", "en_revision", "recordatorio_cita_datos", 3],
      ["odentia_recordatorio_cita_v2", "rechazada", "recordatorio_cita", 3],
      ["odentia_recordatorio_control_v1", "deshabilitada", "recordatorio_control", 0],
      ["odentia_retomar_conversacion_v1", "en_revision", "retomar_conversacion", 2],
      ["odentia_seguimiento_inasistencia_v1", "en_revision", "seguimiento_no_asistencia", 3],
      ["odentia_seguimiento_oportunidad_v1", "en_revision", "seguimiento_comercial", 3],
      ["odentia_seguimiento_presupuesto_v1", "en_revision", "seguimiento_presupuesto", 3],
      ["odentia_su_enlace_v1", "en_revision", "su_enlace", 2],
      ["odentia_ver_respuesta_v1", "en_revision", "ver_respuesta", 2],
    ])
    expect(synced.find((item) => item.status === "rechazada")?.reason).toBe("INVALID_FORMAT")
    // Con el cuerpo conocido, se exige un dato por variable.
    await expect(
      run(c, (tx) => assertTemplateSendable(tx, c.orgId, c.whatsappId!, { name: "bienvenida", language: "es", params: 0, category: "marketing", contactId: null })),
    ).rejects.toThrow("La plantilla «bienvenida» lleva 1 dato y se enviaron 0")
    const rows = await ownerDb.select().from(channelTemplate).where(eq(channelTemplate.connectionId, c.whatsappId!))
    expect(rows).toHaveLength(19)
  })
})

describe("pedírselo con palabras", () => {
  it("los números del pedido se leen con reglas, no con el modelo", () => {
    expect(readNumbers("Que espere 3 días")).toMatchObject({ days: 3, hours: null, hour: null })
    expect(readNumbers("una semana después")).toMatchObject({ days: 7 })
    expect(readNumbers("recuérdales dos horas antes")).toMatchObject({ hours: 2 })
    expect(readNumbers("que salga a las 10")).toMatchObject({ hour: 10, days: null })
    expect(readNumbers("a las 4 de la tarde")).toMatchObject({ hour: 16 })
    expect(readNumbers("a las 27")).toMatchObject({ hour: null })
  })

  it("el modelo solo elige entre opciones cerradas; con poca confianza no se da por entendido", async () => {
    const unsure: AdminDecider = {
      decide: async () => ({
        answers: [
          { id: "linea", kind: "choice", choice: "cobranza_vencida", confidence: 0.2 },
          { id: "intencion", kind: "choice", choice: "prender", confidence: 0.9 },
        ],
        model: "prueba",
        usage: { inputTokens: 300, outputTokens: 4 },
      }),
    }
    expect(await interpretAdminRequest("haz algo con la plata", unsure, agentTextsFor("dental"))).toMatchObject({ understood: false, key: null, changes: {}, usage: { inputTokens: 300, outputTokens: 4 } })
    // Una línea que no existe en el catálogo nunca se arma, aunque el modelo la nombre.
    const invents: AdminDecider = {
      decide: async () => ({ answers: [{ id: "linea", kind: "choice", choice: "felicitar_cumpleanos", confidence: 1 }, { id: "intencion", kind: "choice", choice: "prender", confidence: 1 }], model: "prueba", usage: null }),
    }
    expect((await interpretAdminRequest("felicita a quien cumple años", invents, agentTextsFor("dental"))).understood).toBe(false)
    // «Sin tareas» apaga una parte: aunque el modelo lo lea como apagar, la línea no se apaga.
    const confused: AdminDecider = {
      decide: async () => ({
        answers: [
          { id: "linea", kind: "choice", choice: "seguimiento_no_asistencia", confidence: 0.9 },
          { id: "intencion", kind: "choice", choice: "apagar", confidence: 0.9 },
          { id: "sin_respaldo", kind: "yesno", probability: 0.95 },
        ],
        model: "prueba",
        usage: null,
      }),
    }
    expect(await interpretAdminRequest("en las inasistencias no crees tareas", confused, agentTextsFor("dental"))).toMatchObject({ intent: "cambiar", changes: { teamPart: false } })
    const c = await clinic()
    expect(await ask(c, "felicita a quien cumple años", invents)).toMatchObject({ understood: false, draft: false, message: expect.stringContaining("No reconocí una línea") })
    expect(await rulesOf(c)).toEqual([])
  })

  it("crear: queda un borrador con su flujo, su prueba de 30 días y lo que se revisó, y no hace nada hasta prenderlo", async () => {
    const c = await clinic({ approved: [] })
    const wrote = await person(c, "Escribió hoy", { consent: ["seguimiento"], openWindow: true })
    const mail = await person(c, "Solo correo", { whatsapp: false, email: "correo@example.com", consent: ["seguimiento"] })
    const refused = await person(c, "Sin permiso")
    for (const p of [wrote, mail, refused]) await cancelledAppointment(c, p.patientId, new Date(Date.now() - 3 * DAY))
    // La que canceló la clínica no cuenta: nadie «canceló su cita».
    await cancelledAppointment(c, (await person(c, "La movió la clínica", { consent: ["seguimiento"] })).patientId, new Date(Date.now() - 3 * DAY), "clinica")

    expect((await run(c, (tx) => getAdminPage(tx, c.orgId, all))).lines.some((line) => line.key === "cita_cancelada")).toBe(false)
    const result = await ask(c, "Cuando alguien cancele su cita, que el agente le ofrezca otra fecha dos horas después")
    expect(result).toMatchObject({ understood: true, key: "cita_cancelada", draft: true, confirmDelete: false, model: "palabras-clave" })
    const [rule] = await rulesOf(c)
    expect(rule).toMatchObject({ kind: "cita_cancelada", enabled: false, enabledAt: null, config: {}, draft: { creates: true, changes: { enabled: true, delayHours: 2 } } })

    const line = await run(c, (tx) => getAdminLine(tx, c.orgId, all, "cita_cancelada"))
    expect(line).toMatchObject({ custom: true, enabled: false, hasDraft: true })
    expect(line.draft).toMatchObject({
      creates: true,
      action: "prender",
      summary: "La armé así: Sofi le escribe 2 horas después para ofrecerle otra fecha. Si no puede, avisa por qué y cómo habilitarlo, y queda una tarea para el equipo de recepción. Todavía no hace nada.",
      message: { text: "Hola, Lucía. Se canceló la cita del lunes 12 de octubre en Clínica Sonríe. ¿Te buscamos otra fecha?", buttons: ["Sí, otra fecha", "No enviar más"] },
      unsupported: [],
    })
    expect(line.draft!.flow.main.map((step) => step.label)).toEqual(["Una persona cancela su cita", "Espera 2 horas", "¿Puede escribirle Sofi?", "Le escribe", "Lo resuelve Sofi"])
    // La prueba cuenta lo que pasó y por dónde llegaría hoy; no envía nada.
    expect(line.draft!.test).toMatchObject({ total: 3, title: "3 cancelaciones" })
    expect(line.draft!.test!.rows.map((row) => [row.route, row.total])).toEqual([["respuesta", 1], ["no_pudo", 2]])
    expect(line.draft!.review.map((check) => check.ok)).toContain(false)
    expect(line.draft!.review.find((check) => !check.ok)!.text).toContain("WhatsApp todavía no aprobó el mensaje de esta línea")
    expect(await jobsOf(c)).toHaveLength(0)
    expect(await ownerDb.select().from(conversation).where(eq(conversation.organizationId, c.orgId))).toHaveLength(1)

    // Mientras es borrador, el ciclo no la toma.
    expect((await run(c, (tx) => syncCancelledAppointments(tx, c.orgId, new Date()))).programados).toBe(0)
    await run(c, (tx) => applyAdminDraft(tx, c.orgId, c.ownerId, "cita_cancelada"))
    const [on] = await rulesOf(c)
    expect(on).toMatchObject({ enabled: true, draft: null, config: { delayHours: 2 }, enabledBy: c.ownerId })
    // Prender no escribe por lo anterior: las tres cancelaciones de la prueba quedan atrás.
    expect((await run(c, (tx) => syncCancelledAppointments(tx, c.orgId, new Date()))).programados).toBe(0)
  })

  it("descartar un borrador de una línea nueva la quita; el de una línea que ya existe la deja como estaba", async () => {
    const c = await clinic()
    await ask(c, "Cuando alguien cancele su cita, ofrécele otra fecha")
    expect(await run(c, (tx) => discardAdminDraft(tx, c.orgId, c.ownerId, "cita_cancelada"))).toEqual({ removed: true })
    expect(await rulesOf(c)).toEqual([])
    await expect(run(c, (tx) => getAdminLine(tx, c.orgId, all, "cita_cancelada"))).rejects.toMatchObject({ code: "NOT_FOUND" })

    await ruleOn(c, "seguimiento_no_asistencia", new Date(NOW.getTime() - DAY))
    await ask(c, "Cuando alguien falte, que salga a las 10")
    expect(await run(c, (tx) => discardAdminDraft(tx, c.orgId, c.ownerId, "seguimiento_no_asistencia"))).toEqual({ removed: false })
    expect(await rulesOf(c)).toMatchObject([{ kind: "seguimiento_no_asistencia", enabled: true, draft: null, config: {} }])
  })

  it("editar: muestra qué cambia y lo que no se puede, y la línea sigue como estaba hasta guardar", async () => {
    const c = await clinic()
    const rule = await ruleOn(c, "seguimiento_no_asistencia", new Date(NOW.getTime() - 3 * DAY), { teamPart: false })
    const result = await ask(c, "Cuando alguien falte a su cita, que salga a las 10 y que además llame una persona si no puede. Y que les ofrezca 10 % de descuento")
    expect(result).toMatchObject({ key: "seguimiento_no_asistencia", draft: true })
    const line = await run(c, (tx) => getAdminLine(tx, c.orgId, all, "seguimiento_no_asistencia"))
    expect(line).toMatchObject({ enabled: true, teamPart: false, hour: null })
    expect(line.draft).toMatchObject({
      creates: false,
      action: "guardar",
      summary: "Así quedaría. Mientras no guardes, sigue funcionando como estaba.",
      changes: [
        { kind: "cambio", before: "Espera al día siguiente", after: "Espera al día siguiente, 10:00" },
        { kind: "nueva", before: null, after: "Si Sofi no puede, además queda una tarea para el equipo de recepción." },
      ],
      marks: { espera: "cambio", tarea: "nueva" },
    })
    expect(line.draft!.unsupported).toEqual([expect.stringContaining("Sofi no ofrece descuentos")])
    expect(line.draft!.flow.otherwise!.map((step) => step.label)).toEqual(["Avisa por qué y cómo habilitarlo", "Tarea de llamada", "Le toca a una persona"])
    // Sin guardar, la línea no cambió.
    expect((await rulesOf(c))[0]).toMatchObject({ id: rule.id, teamPart: false, config: {} })
    await run(c, (tx) => applyAdminDraft(tx, c.orgId, c.ownerId, "seguimiento_no_asistencia"))
    expect((await rulesOf(c))[0]).toMatchObject({ enabled: true, teamPart: true, config: { hour: 10 }, draft: null })
    const saved = await run(c, (tx) => getAdminLine(tx, c.orgId, all, "seguimiento_no_asistencia"))
    expect(saved).toMatchObject({ hour: 10, draft: null, description: "Sofi le escribe al día siguiente, a las 10:00, para reprogramar. Si no puede, avisa por qué y cómo habilitarlo, y queda una tarea para el equipo de recepción." })
    expect(saved.changes[0]!.what).toBe("prendió la tarea para el equipo y fijó la salida a las 10:00")
  })

  it("lo que no cambia nada o no se puede se dice, y no deja borrador", async () => {
    const c = await clinic()
    await ruleOn(c, "cobranza_vencida", new Date(NOW.getTime() - DAY))
    expect(await ask(c, "Prende la de saldos vencidos")).toMatchObject({ understood: true, draft: false, message: expect.stringContaining("ya está así: prendida") })
    expect(await ask(c, "Que la cobranza salga a las 10")).toMatchObject({ draft: false, message: "«Saldo vencido» no tiene una hora fija de salida que se pueda cambiar." })
    // Las que vienen armadas no se eliminan: lo más parecido es apagarlas, y se dice.
    expect(await ask(c, "Elimina la de cobranza")).toMatchObject({ key: "cobranza_vencida", draft: true, confirmDelete: false })
    const line = await run(c, (tx) => getAdminLine(tx, c.orgId, all, "cobranza_vencida"))
    expect(line.draft).toMatchObject({ action: "apagar", unsupported: [expect.stringContaining("no se eliminan")], test: null, review: [] })
    await expect(run(c, (tx) => deleteAdminLine(tx, c.orgId, c.ownerId, "cobranza_vencida"))).rejects.toThrow(/viene armada y no se elimina/)
    await run(c, (tx) => applyAdminDraft(tx, c.orgId, c.ownerId, "cobranza_vencida"))
    expect((await rulesOf(c))[0]).toMatchObject({ enabled: false, draft: null })
  })

  it("la línea creada escribe a quien canceló desde que se prende, pasada la espera, y se puede eliminar", async () => {
    const c = await clinic({ anyHour: true })
    const now = new Date()
    const p = await person(c, "Lucía Paredes", { consent: ["seguimiento"], openWindow: true })
    const recent = await person(c, "Acaba de cancelar", { consent: ["seguimiento"], openWindow: true })
    const byClinic = await person(c, "La canceló la clínica", { consent: ["seguimiento"], openWindow: true })
    await ask(c, "Cuando alguien cancele su cita, ofrécele otra fecha")
    await run(c, (tx) => applyAdminDraft(tx, c.orgId, c.ownerId, "cita_cancelada"))
    await ownerDb.update(automationRule).set({ enabledAt: new Date(now.getTime() - DAY) }).where(eq(automationRule.organizationId, c.orgId))
    const cancelled = await cancelledAppointment(c, p.patientId, new Date(now.getTime() - 2 * HOUR))
    await cancelledAppointment(c, recent.patientId, new Date(now.getTime() - 10 * 60_000))
    await cancelledAppointment(c, byClinic.patientId, new Date(now.getTime() - 2 * HOUR), "clinica")
    expect((await run(c, (tx) => syncCancelledAppointments(tx, c.orgId, now))).programados).toBe(1)
    expect((await run(c, (tx) => syncCancelledAppointments(tx, c.orgId, now))).programados).toBe(0)
    expect((await deliver(c, now)).map((r) => r.outcome)).toEqual(["enviado"])
    const [job] = await jobsOf(c)
    expect(job).toMatchObject({ kind: "cita_cancelada", appointmentId: cancelled, status: "enviado", via: "respuesta" })
    expect((await messageOf(job!.sentMessageId)).body).toMatch(/^Hola, Lucía\. Se canceló la cita del .+ en Clínica Sonríe\. ¿Te buscamos otra fecha\?$/)
    expect((await run(c, (tx) => getAdminPage(tx, c.orgId, all))).lines.find((line) => line.key === "cita_cancelada")).toMatchObject({ custom: true, enabled: true })

    // Eliminar: deja de ejecutarse, cancela lo pendiente y conserva lo hecho.
    await ownerDb.update(auditEvent).set({ createdAt: new Date(now.getTime() - 90 * 60_000) }).where(and(eq(auditEvent.organizationId, c.orgId), eq(auditEvent.action, "appointment.status_cancelada"), eq(auditEvent.actorUserId, c.ownerId)))
    await ownerDb.update(auditEvent).set({ metadata: { cancelReason: "paciente" } }).where(and(eq(auditEvent.organizationId, c.orgId), eq(auditEvent.actorUserId, c.ownerId), eq(auditEvent.action, "appointment.status_cancelada")))
    expect((await run(c, (tx) => syncCancelledAppointments(tx, c.orgId, now))).programados).toBe(1)
    expect(await run(c, (tx) => deleteAdminLine(tx, c.orgId, c.ownerId, "cita_cancelada"))).toEqual({ cancelled: 1 })
    expect(await rulesOf(c)).toEqual([])
    expect((await jobsOf(c)).map((item) => item.status).sort()).toEqual(["cancelado", "enviado"])
    expect((await run(c, (tx) => getAdminPage(tx, c.orgId, all))).lines.some((line) => line.key === "cita_cancelada")).toBe(false)
  })

  it("con hora fija, el mensaje por una inasistencia sale al día siguiente a esa hora de la sede", async () => {
    const c = await clinic()
    const p = await person(c, "Faltó ayer", { consent: ["seguimiento"] })
    // Faltó a las 11:00 de Lima (16:00Z) del 5 de octubre; son las 10:00 del 6.
    await appointmentFor(c, p.patientId, new Date("2026-10-05T16:00:00.000Z"), "no_asistio")
    await ruleOn(c, "seguimiento_no_asistencia", new Date(NOW.getTime() - 3 * DAY), { hour: 12 })
    expect((await run(c, (tx) => syncVisitFollowUps(tx, c.orgId, NOW))).programados).toBe(1)
    // 12:00 de Lima del 6 de octubre son las 17:00Z: aún no vence.
    expect((await jobsOf(c))[0]!.scheduledFor.toISOString()).toBe("2026-10-06T17:00:00.000Z")
    expect(await deliver(c)).toEqual([])
    await expect(run(c, (tx) => setLine(tx, c.orgId, c.ownerId, "cobranza_vencida", { hour: 9 }))).rejects.toThrow(/no tiene una hora de salida/)
    await expect(run(c, (tx) => setLine(tx, c.orgId, c.ownerId, "seguimiento_no_asistencia", { delayHours: 3 }))).rejects.toThrow(/no espera horas/)
  })

  it("Recepción no escribe si la persona ya avisó algo; si el modelo falla, escribe como siempre", async () => {
    const c = await clinic({ anyHour: true })
    const now = new Date()
    const told = await person(c, "Ya avisó", { consent: ["seguimiento"], openWindow: true })
    const silent = await person(c, "No dijo nada", { consent: ["seguimiento"], openWindow: true })
    await ownerDb.insert(message).values({ organizationId: c.orgId, conversationId: told.conversationId!, direction: "in", senderKind: "contact", body: "No voy a poder ir mañana, ¿me dan otra fecha?" })
    for (const p of [told, silent]) await appointmentFor(c, p.patientId, new Date(now.getTime() - (p === told ? 30 : 31) * HOUR), "no_asistio", 10)
    await ruleOn(c, "seguimiento_no_asistencia", new Date(now.getTime() - 3 * DAY))
    await run(c, (tx) => syncVisitFollowUps(tx, c.orgId, now))
    const seen: string[][] = []
    const results = await run(c, (tx) =>
      deliverDueJobs(tx, c.orgId, now, {
        secretsKey: KEY,
        alreadyTold: async (_, input) => {
          seen.push(input.messages)
          return true
        },
      }),
    )
    // Solo se pregunta por quien escribió algo, y solo ese caso se deja sin escribir.
    expect(seen).toEqual([["No voy a poder ir mañana, ¿me dan otra fecha?"]])
    expect(results.map((r) => [r.outcome, r.detail]).sort()).toEqual([["cancelado", "La persona ya había escrito sobre esto"], ["enviado", undefined]])
    const people = await run(c, (tx) => listAdminLinePeople(tx, c.orgId, all, "seguimiento_no_asistencia"))
    expect(people.items.find((row) => row.personName === "Ya avisó")).toMatchObject({ outcome: "no_hizo_falta", text: "No se hizo nada: la persona ya había escrito sobre esto." })
    expect(await tasksOf(c)).toHaveLength(0)

    const other = await clinic({ anyHour: true })
    const p = await person(other, "Escribió antes", { consent: ["seguimiento"], openWindow: true })
    await ownerDb.insert(message).values({ organizationId: other.orgId, conversationId: p.conversationId!, direction: "in", senderKind: "contact", body: "Hola" })
    await appointmentFor(other, p.patientId, new Date(now.getTime() - 30 * HOUR), "no_asistio", 10)
    await ruleOn(other, "seguimiento_no_asistencia", new Date(now.getTime() - 3 * DAY))
    await run(other, (tx) => syncVisitFollowUps(tx, other.orgId, now))
    const sent = await run(other, (tx) => deliverDueJobs(tx, other.orgId, now, { secretsKey: KEY, alreadyTold: async () => Promise.reject(new Error("sin modelo")) }))
    expect(sent.map((r) => r.outcome)).toEqual(["enviado"])
  })

  it("la prueba de 30 días separa por dónde llegaría, con el mensaje aprobado y con el agente apagado", async () => {
    const c = await clinic({ approved: ["seguimiento_no_asistencia"], email: true })
    const line = adminLineOf("seguimiento_no_asistencia")!
    const template = await person(c, "Con WhatsApp", { consent: ["seguimiento"] })
    const mail = await person(c, "Solo correo", { whatsapp: false, email: "x@example.com", consent: ["seguimiento"] })
    const none = await person(c, "Sin datos", { whatsapp: false, consent: ["seguimiento"] })
    for (const p of [template, mail, none]) await appointmentFor(c, p.patientId, new Date(Date.now() - 5 * DAY - Math.random() * DAY), "no_asistio", 10)
    await appointmentFor(c, template.patientId, new Date(Date.now() - 40 * DAY), "no_asistio", 10)
    const test = await run(c, (tx) => testAdminLine(tx, c.orgId, line, { agentPart: true, teamPart: false, days: null }))
    expect(test).toMatchObject({ days: 30, total: 3, title: "3 inasistencias" })
    expect(test!.rows.map((row) => [row.route, row.total, row.detail])).toEqual([
      ["plantilla", 1, "No escribieron en las últimas 24 horas."],
      ["correo", 1, "No hay WhatsApp por el que llegarles y sí tienen correo."],
      ["no_pudo", 1, "Avisa por qué y cómo habilitar a cada una."],
    ])
    const byPerson = await run(c, (tx) => testAdminLine(tx, c.orgId, line, { agentPart: false, teamPart: true, days: null }))
    expect(byPerson!.rows).toEqual([{ route: "tarea", total: 3, label: "Tarea para el equipo de recepción", detail: "Sofi no escribe: lo hace una persona." }])
    // Las líneas que no escriben a nadie no tienen esta prueba.
    expect(await run(c, (tx) => testAdminLine(tx, c.orgId, adminLineOf("cobranza_vencida")!, { agentPart: false, teamPart: true, days: 30 }))).toBeNull()
    expect(await jobsOf(c)).toHaveLength(0)
  })
})

describe("lo que el agente no hace queda para una persona", () => {
  it("«ponlo en la tarea»: la indicación entra al borrador, prende la tarea y llega a quien la recibe", async () => {
    const c = await clinic()
    await ruleOn(c, "seguimiento_no_asistencia", new Date(NOW.getTime() - 3 * DAY), { teamPart: false })
    await ask(c, "A los que falten a su cita, que salga a las 9 y ofréceles un descuento")
    const offered = await run(c, (tx) => getAdminLine(tx, c.orgId, all, "seguimiento_no_asistencia"))
    expect(offered.draft!.taskNote).toEqual({ value: null, max: 160, team: "el equipo de recepción" })
    await expect(run(c, (tx) => setAdminDraftNote(tx, c.orgId, "seguimiento_no_asistencia", "x".repeat(161)))).rejects.toThrow(/hasta 160 caracteres/)
    await run(c, (tx) => setAdminDraftNote(tx, c.orgId, "seguimiento_no_asistencia", "  Ofrecer 10 %   si reprograma "))
    const withNote = await run(c, (tx) => getAdminLine(tx, c.orgId, all, "seguimiento_no_asistencia"))
    expect(withNote.draft!.taskNote!.value).toBe("Ofrecer 10 % si reprograma")
    // Una indicación sin tarea no sirve: el borrador prende la tarea de respaldo.
    expect(withNote.draft!.changes.map((change) => change.after)).toEqual([
      "Espera al día siguiente, 9:00",
      "Si Sofi no puede, además queda una tarea para el equipo de recepción.",
      "La tarea para el equipo de recepción dirá: «Ofrecer 10 % si reprograma». Sofi no lo dice: lo hace una persona.",
    ])
    expect(withNote).toMatchObject({ teamPart: false, taskNote: null })
    await run(c, (tx) => applyAdminDraft(tx, c.orgId, c.ownerId, "seguimiento_no_asistencia"))
    expect((await rulesOf(c))[0]).toMatchObject({ teamPart: true, config: { hour: 9, taskNote: "Ofrecer 10 % si reprograma" } })
    // La auditoría dice que la indicación cambió, sin copiar su texto.
    const [event] = await ownerDb.select().from(auditEvent).where(and(eq(auditEvent.organizationId, c.orgId), eq(auditEvent.action, "admin_line.updated"))).orderBy(asc(auditEvent.createdAt)).offset(1)
    expect(event!.metadata).toMatchObject({ changes: { taskNote: true, teamPart: true, hour: 9 } })
    expect(JSON.stringify(event!.metadata)).not.toContain("Ofrecer")

    // Quien se dio de baja: el agente no escribe y la tarea lleva la indicación.
    const p = await person(c, "Tomás Rivas", { refused: ["seguimiento"] })
    await ownerDb.update(automationRule).set({ config: { taskNote: "Ofrecer 10 % si reprograma" } }).where(eq(automationRule.organizationId, c.orgId))
    await appointmentFor(c, p.patientId, new Date(NOW.getTime() - 30 * HOUR), "no_asistio")
    await run(c, (tx) => syncVisitFollowUps(tx, c.orgId, NOW))
    expect((await deliver(c)).map((result) => result.outcome)).toEqual(["omitido"])
    expect((await tasksOf(c))[0]!.reason).toBe(
      "Sofi no pudo escribirle: pidió no recibir este tipo de mensaje. Si cambia de opinión, anótalo en su página, en Datos › Mensajes. Indicación de la clínica: Ofrecer 10 % si reprograma",
    )
    // También se cambia a mano, sin pedirlo con palabras; vacía, se quita.
    await run(c, (tx) => setLine(tx, c.orgId, c.ownerId, "seguimiento_no_asistencia", { taskNote: "" }))
    expect((await run(c, (tx) => getAdminLine(tx, c.orgId, all, "seguimiento_no_asistencia"))).taskNote).toBeNull()
  })

  it("«prendida, pero casi no escribe» no aplica a lo que es parte del servicio: sale sin preguntar y no hay aviso", async () => {
    const c = await clinic()
    await ruleOn(c, "seguimiento_no_asistencia", new Date(NOW.getTime() - 9 * DAY))
    for (let index = 0; index < 6; index += 1) {
      const p = await person(c, `Sin preguntar ${index}`, { openWindow: true })
      await appointmentFor(c, p.patientId, new Date(NOW.getTime() - 30 * HOUR - index * 20 * 60_000), "no_asistio", 10)
    }
    await run(c, (tx) => syncVisitFollowUps(tx, c.orgId, NOW))
    // Nadie lo aceptó ni lo negó: la inasistencia es parte del servicio (ADR 0030).
    expect((await jobsOf(c)).filter((job) => job.cause === "sin_permiso")).toHaveLength(0)
    expect((await deliver(c)).every((result) => result.outcome !== "omitido")).toBe(true)
    expect((await run(c, (tx) => getAdminPage(tx, c.orgId, all))).permissionGaps).toEqual([])
  })
})

describe("un botón ya dice qué quiere la persona", () => {
  it("el toque de un botón de un mensaje automático se reconoce sin modelo: de qué línea venía y qué pide", async () => {
    const c = await clinic({ anyHour: true })
    const now = new Date()
    const missed = await person(c, "Faltó", { consent: ["seguimiento"], openWindow: true })
    const reminded = await person(c, "Tiene cita", { consent: ["recordatorio"], openWindow: true })
    await appointmentFor(c, missed.patientId, new Date(now.getTime() - 30 * HOUR), "no_asistio", 10)
    // El aviso de tres horas antes venció hace un cuarto de hora: sale en este ciclo.
    await appointmentFor(c, reminded.patientId, new Date(now.getTime() + 2.75 * HOUR), "programada", 10)
    await ruleOn(c, "seguimiento_no_asistencia", new Date(now.getTime() - 3 * DAY))
    await ruleOn(c, "recordatorio_cita", new Date(now.getTime() - 3 * DAY))
    await run(c, (tx) => syncVisitFollowUps(tx, c.orgId, now))
    await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, now))
    expect((await deliver(c, now)).map((result) => result.outcome).sort()).toEqual(["enviado", "enviado"])
    let tick = 0
    const says = async (conversationId: string, body: string) => {
      tick += 1
      const [row] = await ownerDb.insert(message)
        .values({ organizationId: c.orgId, conversationId, direction: "in", senderKind: "contact", body, createdAt: new Date(Date.now() + tick * 1000) })
        .returning({ id: message.id })
      return run(c, (tx) => automationReplyOf(tx, c.orgId, { conversationId, messageId: row!.id }))
    }
    // Quien faltó ya no tiene esa cita: «otro horario» es reservar una nueva, no mover la anterior.
    expect(await says(missed.conversationId!, "Sí, otro horario")).toMatchObject({
      kind: "seguimiento_no_asistencia", button: "Sí, otro horario", asks: "reservar",
      hint: expect.stringContaining("Quiere una cita nueva"),
    })
    // Quien recibió un recordatorio sí tiene su cita en pie.
    expect(await says(reminded.conversationId!, "No podré ir")).toMatchObject({ kind: "recordatorio_cita", asks: "cambiar", hint: expect.stringContaining("que sigue en pie") })
    // Lo que no es el botón, o llega después de otro mensaje, sigue el camino de siempre.
    expect(await says(reminded.conversationId!, "No podré ir")).toBeNull()
    expect(await says(missed.conversationId!, "¿Cuánto cuesta una limpieza?")).toBeNull()
    // «No enviar más» lo resuelve el sistema: nunca llega como algo que seguir conversando.
    const other = await person(c, "Otra persona", { consent: ["seguimiento"], openWindow: true })
    await appointmentFor(c, other.patientId, new Date(now.getTime() - 31 * HOUR), "no_asistio", 10)
    await run(c, (tx) => syncVisitFollowUps(tx, c.orgId, now))
    await deliver(c, now)
    expect(await says(other.conversationId!, "No enviar más")).toBeNull()
  })
})

describe("el texto de un mensaje es de cada clínica", () => {
  it("el cambio sale igual por las tres vías, y solo cuando WhatsApp lo aprueba reemplaza a la plantilla anterior", async () => {
    const c = await clinic({ approved: ["recordatorio_cita"], email: true })
    await ruleOn(c, "recordatorio_cita", new Date(NOW.getTime() - HOUR), { hoursBefore: [24] })
    const edited = "Estimada {{persona}}: su cita es {{citas}}, en {{lugar}}. Si necesita cambiarla, responda a este mensaje."
    await run(c, (tx) =>
      saveMessageText(tx, c.orgId, c.whatsappId!, c.ownerId, "recordatorio_cita", edited, { fetch, validateExternal: false, secretsKey: KEY }),
    )
    const [version] = await ownerDb.select().from(clinicMessageVersion).where(eq(clinicMessageVersion.organizationId, c.orgId))
    const sentTo = async (contactId: string) => {
      const job = (await jobsOf(c)).find((item) => item.contactId === contactId)!
      return { job, sent: await messageOf(job.sentMessageId) }
    }

    // En revisión: sigue saliendo la plantilla y el texto de antes.
    const first = await person(c, "Lucía Paredes", { consent: ["recordatorio"] })
    await appointmentFor(c, first.patientId, new Date(NOW.getTime() + 24 * HOUR), "programada", 10)
    await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, NOW))
    await deliver(c)
    const before = await sentTo(first.contactId)
    expect(before.job).toMatchObject({ status: "enviado", via: "plantilla" })
    expect(before.sent.templateName).toBe("odentia_recordatorio_cita_v2")
    expect(before.sent.body).toContain("Hola, Lucía. Te recordamos la cita en Clínica Sonríe, sede Centro")

    // WhatsApp lo aprueba: desde ahora el texto de la clínica, por donde salga.
    await run(c, (tx) =>
      applyTemplateUpdates(tx, c.orgId, c.whatsappId!, [{ externalId: null, name: version!.templateName, language: "es", status: "aprobada", reason: null }]),
    )
    const later = new Date(NOW.getTime() + 45 * 60_000)
    const cold = await person(c, "Jorge Salas", { consent: ["recordatorio"] })
    const warm = await person(c, "Ana Ríos", { consent: ["recordatorio"], openWindow: true })
    const mail = await person(c, "Rosa Díaz", { whatsapp: false, email: "rosa@example.com", consent: ["recordatorio"] })
    for (const [index, who] of [cold, warm, mail].entries()) {
      await appointmentFor(c, who.patientId, new Date(later.getTime() + 24 * HOUR - index * 10 * 60_000), "programada", 10)
    }
    await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, later))
    await deliver(c, later)

    const byTemplate = await sentTo(cold.contactId)
    expect(byTemplate.job).toMatchObject({ status: "enviado", via: "plantilla" })
    expect(byTemplate.sent).toMatchObject({ contentType: "template", templateName: version!.templateName, templateLanguage: "es" })
    // Cada dato va en la posición en que quedó en el texto nuevo.
    const params = byTemplate.sent.templateParams as string[]
    expect([params[0], params[2]]).toEqual(["Jorge", "Clínica Sonríe, sede Centro"])
    expect(byTemplate.sent.body).toBe(`Estimada Jorge: su cita es ${params[1]}, en Clínica Sonríe, sede Centro. Si necesita cambiarla, responda a este mensaje.`)
    // Los botones y lo que devuelven no cambian con el texto.
    expect(byTemplate.sent.replyButtons).toEqual([
      { id: replyId("confirmar", byTemplate.job.id), title: "Confirmar" },
      { id: replyId("responder", byTemplate.job.id), title: "No podré ir" },
      { id: replyId("baja", byTemplate.job.id), title: "No más recordatorios" },
    ])

    const asReply = await sentTo(warm.contactId)
    expect(asReply.job).toMatchObject({ status: "enviado", via: "respuesta" })
    // Como respuesta sale el texto de la clínica; a Ana le faltan datos, así que va una línea más con su enlace.
    expect(asReply.sent.body).toMatch(/^Estimada Ana: su cita es .+, en Clínica Sonríe, sede Centro\. Si necesita cambiarla, responda a este mensaje\.\n\nCompletar mis datos: \S+$/)

    const byMail = await sentTo(mail.contactId)
    expect(byMail.job).toMatchObject({ status: "enviado", via: "correo" })
    expect(byMail.sent.body).toContain("Estimada Rosa: su cita es ")
  })
})

describe("«Retomar una oportunidad» funciona como las demás líneas", () => {
  /** Oportunidad del contacto con su tarea (su próxima acción, una sola), por la operación de siempre. */
  async function opportunityFor(c: Clinic, contactId: string, nextActionAt: Date, options: { title?: string; owner?: string } = {}) {
    const created = await run(c, (tx) =>
      createOpportunity(tx, c.orgId, {
        contactId, title: options.title ?? "Ortodoncia",
        ...(options.owner ? { assignedUserId: options.owner } : {}),
      }, { userId: c.ownerId }),
    )
    await run(c, (tx) => setOpportunityTask(tx, c.orgId, created.id, { dueAt: nextActionAt.toISOString() }, { userId: c.ownerId, createdBy: "user" }))
    return created.id
  }
  const reschedule = (c: Clinic, opportunityId: string, dueAt: Date) =>
    run(c, (tx) => setOpportunityTask(tx, c.orgId, opportunityId, { dueAt: dueAt.toISOString() }, { userId: c.ownerId, createdBy: "user" }))
  const sync = (c: Clinic, now = NOW) => run(c, (tx) => syncOpportunityFollowUps(tx, c.orgId, now))
  const opportunityRow = async (id: string) => (await ownerDb.select().from(opportunity).where(eq(opportunity.id, id)))[0]!
  const followUpTask = async (opportunityId: string) =>
    (await ownerDb.select().from(crmTask).where(eq(crmTask.opportunityId, opportunityId)))[0]!

  it("anota el caso cuando la tarea de la oportunidad vence con la línea prendida, una vez por vencimiento", async () => {
    const c = await clinic()
    const enabledAt = new Date(NOW.getTime() - DAY)
    const old = await person(c, "Venció antes")
    const due = await person(c, "Venció hoy")
    const later = await person(c, "Vence mañana")
    await opportunityFor(c, old.contactId, new Date(enabledAt.getTime() - HOUR))
    const dueAt = new Date(NOW.getTime() - 2 * HOUR)
    const dueId = await opportunityFor(c, due.contactId, dueAt, { owner: c.professionalId })
    await opportunityFor(c, later.contactId, new Date(NOW.getTime() + DAY))
    // Apagada no anota nada.
    expect(await sync(c)).toEqual({ programados: 0, omitidos: 0 })
    await ruleOn(c, "seguimiento_comercial", enabledAt)
    expect(await sync(c)).toEqual({ programados: 1, omitidos: 0 })
    const [job] = await jobsOf(c)
    expect(job).toMatchObject({
      kind: "seguimiento_comercial", status: "pendiente", opportunityId: dueId, contactId: due.contactId, patientId: null,
      payload: { dueAt: dueAt.toISOString(), taskId: (await followUpTask(dueId)).id, ownerUserId: c.professionalId },
    })
    // Repetir el ciclo no lo duplica.
    expect((await sync(c)).programados).toBe(0)
    // Reprogramada y vencida otra vez es otro caso.
    await reschedule(c, dueId, new Date(NOW.getTime() - HOUR))
    expect((await sync(c)).programados).toBe(1)
    expect(await jobsOf(c)).toHaveLength(2)
  })

  it("escribió hace poco: le escribe por WhatsApp con el título de la oportunidad, y el hilo queda en la oportunidad", async () => {
    const c = await clinic()
    await ruleOn(c, "seguimiento_comercial", new Date(NOW.getTime() - DAY))
    const p = await person(c, "Lucía Paredes", { consent: ["seguimiento", "novedades"], openWindow: true })
    const oppId = await opportunityFor(c, p.contactId, new Date(NOW.getTime() - HOUR), { title: "Ortodoncia" })
    expect((await opportunityRow(oppId)).conversationId).toBeNull()
    await sync(c)
    expect((await deliver(c)).map((result) => result.outcome)).toEqual(["enviado"])
    const [job] = await jobsOf(c)
    expect(job).toMatchObject({ status: "enviado", via: "respuesta", channel: "whatsapp", cause: null })
    expect(await messageOf(job!.sentMessageId)).toMatchObject({
      contentType: "text",
      senderKind: "agent",
      conversationId: p.conversationId,
      body: "Hola, Lucía. Te escribimos de Clínica Sonríe sobre tu consulta de «Ortodoncia». ¿Seguimos conversando?",
      replyButtons: [
        { id: replyId("responder", job!.id), title: "Sí, continuemos" },
        { id: replyId("baja", job!.id), title: "No enviar más" },
      ],
    })
    // Recepción sigue la conversación con la oportunidad a la vista: el hilo queda en ella y en su tarea,
    // y la tarea se da por hecha porque el agente ya le escribió.
    expect((await opportunityRow(oppId)).conversationId).toBe(p.conversationId)
    expect(await followUpTask(oppId)).toMatchObject({
      conversationId: p.conversationId, status: "done", settledReason: "Sofi le escribió para retomarla",
    })
  })

  it("no escribió hace poco: sale el mensaje aprobado, con cada dato en su variable", async () => {
    const c = await clinic({ approved: ["seguimiento_comercial"] })
    await ruleOn(c, "seguimiento_comercial", new Date(NOW.getTime() - DAY))
    const p = await person(c, "Lucía Paredes", { consent: ["seguimiento", "novedades"] })
    const oppId = await opportunityFor(c, p.contactId, new Date(NOW.getTime() - HOUR), { title: "Implantes" })
    await sync(c)
    expect((await deliver(c)).map((result) => result.outcome)).toEqual(["enviado"])
    const [job] = await jobsOf(c)
    expect(job).toMatchObject({ status: "enviado", via: "plantilla", channel: "whatsapp" })
    const sent = await messageOf(job!.sentMessageId)
    expect(sent).toMatchObject({
      contentType: "template", templateName: "odentia_seguimiento_oportunidad_v1", templateLanguage: "es",
      templateParams: ["Lucía", "Clínica Sonríe", "Implantes"],
      body: "Hola, Lucía. Te escribimos de Clínica Sonríe sobre tu consulta de «Implantes». ¿Seguimos conversando?",
    })
    expect((await opportunityRow(oppId)).conversationId).toBe(sent.conversationId)
  })

  it("sin WhatsApp: sale por el correo de la clínica, con el enlace de baja", async () => {
    const c = await clinic({ whatsapp: false, email: true })
    await ruleOn(c, "seguimiento_comercial", new Date(NOW.getTime() - DAY))
    const p = await person(c, "Jorge Salas", { whatsapp: false, email: "jorge@example.com", consent: ["seguimiento", "novedades"] })
    await opportunityFor(c, p.contactId, new Date(NOW.getTime() - HOUR), { title: "Blanqueamiento" })
    await sync(c)
    await deliver(c)
    const [job] = await jobsOf(c)
    expect(job).toMatchObject({ status: "enviado", via: "correo", channel: "email" })
    const body = (await messageOf(job!.sentMessageId)).body ?? ""
    expect(body.split("\n")[0]).toBe("¿Seguimos conversando? · Clínica Sonríe")
    expect(body).toContain("Hola, Jorge. Te escribimos de Clínica Sonríe sobre tu consulta de «Blanqueamiento». ¿Seguimos conversando?")
    expect(body).toMatch(/Elegir mis mensajes: \S+#mensajes$/)
    expect((await messageOf(job!.sentMessageId)).listUnsubscribe).toMatch(/^https:\/\/auto-\S+\.odentia\.test\/baja\/\S+$/)
  })

  it("con su baja: cierra el caso con su causa y la misma tarea queda para quien lleva la oportunidad, sin otra", async () => {
    const c = await clinic()
    await ruleOn(c, "seguimiento_comercial", new Date(NOW.getTime() - DAY))
    // Dijeron que no a las novedades: retomar es promoción para WhatsApp y pide su sí (ADR 0040).
    const owned = await person(c, "Con responsable", { refused: ["novedades"] })
    const loose = await person(c, "Sin responsable", { refused: ["novedades"] })
    const ownedId = await opportunityFor(c, owned.contactId, new Date(NOW.getTime() - HOUR), { owner: c.professionalId })
    const looseId = await opportunityFor(c, loose.contactId, new Date(NOW.getTime() - HOUR))
    await sync(c)
    expect((await deliver(c)).map((result) => result.outcome)).toEqual(["omitido", "omitido"])
    const jobs = await jobsOf(c)
    expect(jobs.every((job) => job.status === "omitido" && job.cause === "sin_permiso")).toBe(true)
    const tasks = await tasksOf(c)
    expect(tasks.filter((task) => task.createdBy === "admin")).toEqual([])
    const taskOf = (opportunityId: string) => tasks.filter((task) => task.opportunityId === opportunityId)
    expect(taskOf(ownedId)).toEqual([expect.objectContaining({
      title: "Llamar a Con responsable por Ortodoncia", assigneeUserId: c.professionalId,
      contactId: owned.contactId, status: "open",
      reason: "Sofi no pudo escribirle: no aceptó novedades y promociones. Si acepta, anótalo en su página, en Datos › Mensajes.",
    })])
    expect(jobs.find((job) => job.opportunityId === ownedId)?.taskId).toBe(taskOf(ownedId)[0]?.id)
    // Sin responsable, la tarea va al equipo de recepción.
    expect(taskOf(looseId)).toEqual([expect.objectContaining({ assigneeUserId: null, area: "recepcion" })])
    // Sin aviso en la campana: lo dice «Te espera» a quien puede habilitarlo.
    expect((await noticesOf(c)).filter((notice) => notice.href.startsWith("/agent/administrador"))).toEqual([])
  })

  it("si la oportunidad se cerró o su tarea se reprogramó antes de escribir, no se escribe", async () => {
    const c = await clinic()
    await ruleOn(c, "seguimiento_comercial", new Date(NOW.getTime() - DAY))
    const closed = await person(c, "Ya decidió", { consent: ["seguimiento", "novedades"], openWindow: true })
    const moved = await person(c, "Ya la llamaron", { consent: ["seguimiento", "novedades"], openWindow: true })
    const closedId = await opportunityFor(c, closed.contactId, new Date(NOW.getTime() - HOUR))
    const movedId = await opportunityFor(c, moved.contactId, new Date(NOW.getTime() - HOUR))
    await sync(c)
    await run(c, (tx) => closeOpportunity(tx, c.orgId, closedId, { outcome: "won", reason: "acepto" }, { userId: c.ownerId }))
    await reschedule(c, movedId, new Date(NOW.getTime() + 3 * DAY))
    expect((await deliver(c)).map((result) => result.outcome)).toEqual(["cancelado", "cancelado"])
    const jobs = await jobsOf(c)
    expect(jobs.find((job) => job.opportunityId === closedId)).toMatchObject({ status: "cancelado", lastError: "La oportunidad ya se cerró", sentMessageId: null })
    expect(jobs.find((job) => job.opportunityId === movedId)).toMatchObject({ status: "cancelado", lastError: "La tarea de la oportunidad ya se hizo o se reprogramó", sentMessageId: null })
    expect((await noticesOf(c)).filter((notice) => notice.href.startsWith("/agent/administrador"))).toHaveLength(0)
  })

  it("«Sí, continuemos» sigue la conversación sin fijar camino; «No enviar más» apaga las novedades y no los recordatorios", async () => {
    const c = await clinic({ anyHour: true })
    const now = new Date()
    await ruleOn(c, "seguimiento_comercial", new Date(now.getTime() - DAY))
    const p = await person(c, "Lucía Paredes", { consent: ["seguimiento", "recordatorio", "novedades"], openWindow: true })
    await opportunityFor(c, p.contactId, new Date(now.getTime() - HOUR))
    await sync(c, now)
    expect((await deliver(c, now)).map((result) => result.outcome)).toEqual(["enviado"])
    const [job] = await jobsOf(c)
    const [tap] = await ownerDb.insert(message)
      .values({ organizationId: c.orgId, conversationId: p.conversationId!, direction: "in", senderKind: "contact", body: "Sí, continuemos", createdAt: new Date(Date.now() + 1000) })
      .returning({ id: message.id })
    expect(await run(c, (tx) => automationReplyOf(tx, c.orgId, { conversationId: p.conversationId!, messageId: tap!.id }))).toMatchObject({
      kind: "seguimiento_comercial", button: "Sí, continuemos", asks: null, hint: expect.stringContaining("Sigue la conversación"),
    })
    expect(await run(c, (tx) => handleAutomationReply(tx, c.orgId, { conversationId: p.conversationId!, replyId: replyId("responder", job!.id) }))).toBe(false)
    expect(await run(c, (tx) => handleAutomationReply(tx, c.orgId, { conversationId: p.conversationId!, replyId: replyId("baja", job!.id) }))).toBe(true)
    // «No enviar más» de un retomar apaga las novedades: los recordatorios siguen.
    expect(await run(c, (tx) => getMessagePermissions(tx, c.orgId, p.contactId))).toMatchObject([
      { purpose: "recordatorio", granted: true },
      { purpose: "seguimiento", granted: true },
      { purpose: "novedades", granted: false, source: "baja" },
      { purpose: "avisos", granted: null },
    ])
    const thread = await ownerDb.select().from(message).where(eq(message.conversationId, p.conversationId!)).orderBy(asc(message.createdAt))
    expect(thread.filter((item) => item.direction === "out").at(-1)?.body).toBe("Listo, Lucía, ya no te enviaremos novedades ni promociones. Si tu cita cambia, te avisamos igual.")
  })

  it("se ve como las demás: sus dos partes se apagan por separado, avisa cuando no puede y tiene «Solo esta vez»", async () => {
    const c = await clinic()
    const detail = await run(c, (tx) => getAdminLine(tx, c.orgId, all, "seguimiento_comercial"))
    expect(detail).toMatchObject({
      actor: "agente",
      description: "Sofi le escribiría para retomar la conversación y daría la tarea por hecha. Si no puede, avisa por qué y cómo habilitarlo, y la misma tarea quedaría para quien lleva la oportunidad.",
      message: { text: "Hola, Lucía. Te escribimos de Clínica Sonríe sobre tu consulta de «Ortodoncia». ¿Seguimos conversando?", buttons: ["Sí, continuemos", "No enviar más"] },
    })
    expect(detail.noticeExample).toContain("No pude escribirle a Tomás Rivas")
    expect(detail).not.toHaveProperty("teamFixed")
    expect(await run(c, (tx) => setLine(tx, c.orgId, c.ownerId, "seguimiento_comercial", { enabled: true, teamPart: false }))).toMatchObject({ enabled: true, agentPart: true, teamPart: false })
    await run(c, (tx) => setLine(tx, c.orgId, c.ownerId, "seguimiento_comercial", { enabled: false, teamPart: true }))
    // «Solo esta vez» escribe a quienes tienen hoy la próxima acción vencida, sin prender la línea.
    const p = await person(c, "Hoy vencida", { consent: ["seguimiento"] })
    const oppId = await opportunityFor(c, p.contactId, new Date(Date.now() - 2 * HOUR))
    const advice = await run(c, (tx) => getAdminRecommendation(tx, c.orgId, all, "seguimiento_comercial"))
    expect(advice).toMatchObject({ total: 1, actor: "agente", once: { label: "Escribirles esta vez" } })
    expect(await run(c, (tx) => runAdminLineOnce(tx, c.orgId, c.ownerId, all, "seguimiento_comercial", { secretsKey: KEY }))).toEqual({ created: 1, total: 1, writes: true, all: 1 })
    expect(await jobsOf(c)).toMatchObject([{ kind: "seguimiento_comercial", status: "pendiente", opportunityId: oppId, payload: { once: true } }])
  })
})

describe("una puerta para escribirle a alguien (ADR 0042)", () => {
  it("«Probar línea» cuenta a cada persona con la misma regla que el envío real", async () => {
    const c = await clinic({ approved: ["seguimiento_no_asistencia"], anyHour: true })
    const line = adminLineOf("seguimiento_no_asistencia")!
    // Nunca dijo nada de los mensajes de seguimiento: es parte del servicio y le llega.
    const silent = await person(c, "Nunca dijo nada")
    // Pidió no recibirlos: no le llega ni en la prueba ni de verdad.
    const refused = await person(c, "Pidió que no", { refused: ["seguimiento"] })
    const now = new Date()
    for (const p of [silent, refused]) await appointmentFor(c, p.patientId, new Date(now.getTime() - 2 * DAY), "no_asistio", 10)
    const test = await run(c, (tx) => testAdminLine(tx, c.orgId, line, { agentPart: true, teamPart: false, days: null }))
    expect(test!.rows.map((row) => [row.route, row.total])).toEqual([
      ["plantilla", 1],
      ["no_pudo", 1],
    ])
    // El envío real dice lo mismo, persona por persona.
    await run(c, (tx) => runAdminLineOnce(tx, c.orgId, c.ownerId, all, "seguimiento_no_asistencia", { secretsKey: KEY }))
    const sent = await run(c, (tx) => deliverDueJobs(tx, c.orgId, new Date(), { secretsKey: KEY }))
    expect(sent.map((result) => result.outcome).sort()).toEqual(["enviado", "omitido"])
    const jobs = await jobsOf(c)
    expect(jobs.find((job) => job.patientId === silent.patientId)).toMatchObject({ status: "enviado", via: "plantilla" })
    expect(jobs.find((job) => job.patientId === refused.patientId)).toMatchObject({ status: "omitido", cause: "sin_permiso" })
  })

  it("quien escribió hace poco tiene la ventana abierta aunque su conversación esté cerrada", async () => {
    const c = await clinic({ anyHour: true })
    const line = adminLineOf("seguimiento_no_asistencia")!
    const p = await person(c, "Escribió y se cerró", { openWindow: true })
    await ownerDb.update(conversation).set({ status: "closed", closedAt: new Date(), closeReason: "resuelta" }).where(eq(conversation.id, p.conversationId!))
    await appointmentFor(c, p.patientId, new Date(Date.now() - 2 * DAY), "no_asistio", 10)
    const test = await run(c, (tx) => testAdminLine(tx, c.orgId, line, { agentPart: true, teamPart: false, days: null }))
    expect(test!.rows.map((row) => [row.route, row.total])).toEqual([["respuesta", 1]])
  })
})

describe("el horario de recontacto", () => {
  // Domingo 11 de octubre, 8:00 en Lima: el domingo no se escribe (el horario que viene).
  const SUNDAY = new Date("2026-10-11T13:00:00.000Z")

  it("un recordatorio que toca el domingo sale el lunes a las 8:00 si aún falta una hora para la cita; si no, no sale", async () => {
    const c = await clinic()
    await ruleOn(c, "recordatorio_cita", new Date(SUNDAY.getTime() - DAY), { hoursBefore: [24] })
    const early = await person(c, "Cita a las 9")
    const tooEarly = await person(c, "Cita a las 8 y media")
    const nine = await appointmentFor(c, early.patientId, new Date("2026-10-12T14:00:00.000Z"))
    await appointmentFor(c, tooEarly.patientId, new Date("2026-10-12T13:30:00.000Z"))
    expect(await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, SUNDAY))).toMatchObject({ programados: 1 })
    expect((await jobsOf(c)).map((job) => [job.appointmentId, job.scheduledFor.toISOString()])).toEqual([[nine, "2026-10-12T13:00:00.000Z"]])
  })

  it("lo que vence fuera del horario espera; los avisos de lo que pasó salen al momento", async () => {
    const c = await clinic({ approved: ["seguimiento_no_asistencia", "aviso_cita_cancelada"] })
    const p = await person(c, "Faltó el viernes")
    await appointmentFor(c, p.patientId, new Date(SUNDAY.getTime() - 2 * DAY), "no_asistio", 10)
    await ruleOn(c, "seguimiento_no_asistencia", new Date(SUNDAY.getTime() - 3 * DAY))
    await run(c, (tx) => syncVisitFollowUps(tx, c.orgId, SUNDAY))
    // Al programarlo ya se corre al primer momento permitido.
    const [job] = await jobsOf(c)
    expect(job!.scheduledFor.toISOString()).toBe("2026-10-12T13:00:00.000Z")
    // Si vence igual en domingo (el horario cambió después), el envío lo pospone.
    await ownerDb.update(automationJob).set({ scheduledFor: SUNDAY }).where(eq(automationJob.id, job!.id))
    expect(await deliver(c, SUNDAY)).toMatchObject([{ outcome: "pospuesto", detail: "Fuera del horario de recontacto" }])
    expect((await jobsOf(c))[0]!.scheduledFor.toISOString()).toBe("2026-10-12T13:00:00.000Z")
    // Con el domingo abierto para escribir, sale.
    await run(c, (tx) => setWritingHours(tx, c.orgId, c.ownerId, Array.from({ length: 7 }, (): Array<[number, number]> => [[480, 1200]])))
    await ownerDb.update(automationJob).set({ scheduledFor: SUNDAY }).where(eq(automationJob.id, job!.id))
    expect((await deliver(c, SUNDAY)).map((result) => result.outcome)).toEqual(["enviado"])
  })
})

describe("«Esperan su sí» y «Confirmó por teléfono» (decisión 21)", () => {
  /** Una cita propuesta por el agente en la conversación de la persona, con el profesional que atiende ese día. */
  async function proposed(c: Clinic, startsAt: string) {
    // El profesional atiende todos los días de 8:00 a 20:00 en la sede.
    await ownerDb.insert(professionalSchedule).values(
      Array.from({ length: 7 }, (_, weekday) => ({ organizationId: c.orgId, branchId: c.branchId, professionalUserId: c.professionalId, weekday, startMin: 480, endMin: 1200 })),
    ).onConflictDoNothing()
    const p = await person(c, "Pedro Ruiz", { openWindow: true })
    const proposal = await run(c, (tx) =>
      createProposal(tx, c.orgId, {
        conversationId: p.conversationId!, action: "reservar_cita",
        payload: { patientId: p.patientId, branchId: c.branchId, professionalUserId: c.professionalId, roomId: c.roomId, startsAt, durationMin: 30 },
        idempotencyKey: `prueba:${randomUUID()}`,
      }),
    )
    return { p, proposal }
  }

  it("muestra solo las citas propuestas abiertas, con lo que se le propuso, y cuenta solo esas", async () => {
    const c = await clinic({ anyHour: true })
    const startsAt = new Date(Date.now() + 3 * DAY)
    startsAt.setUTCHours(21, 30, 0, 0) // 16:30 en Lima
    const { p, proposal } = await proposed(c, startsAt.toISOString())
    const list = await run(c, (tx) => listAwaitingAnswer(tx, c.orgId))
    expect(list.total).toBe(1)
    expect(list.items).toMatchObject([{ id: proposal.id, conversationId: p.conversationId, contactName: "Pedro Ruiz", action: "reservar_cita", taken: false }])
    expect(list.items[0]!.text).toMatch(/^Le propuse el \S+ \d+ a las 16:30 con Dra\. Ana Torres$/)
    expect(await run(c, (tx) => countAwaitingAnswer(tx, c.orgId))).toBe(1)
    // Un caso derivado no está aquí ni en el número.
    await run(c, (tx) => createHandoff(tx, c.orgId, null, { conversationId: p.conversationId!, reason: "Dolor", summary: "Dolor", createdBy: "agent" }))
    expect(await run(c, (tx) => countAwaitingAnswer(tx, c.orgId))).toBe(1)
  })

  it("«Confirmó por teléfono» reserva con la misma regla que el agente; si el horario se ocupó, lo dice y no hace nada", async () => {
    const c = await clinic({ anyHour: true })
    const startsAt = new Date(Date.now() + 3 * DAY)
    startsAt.setUTCHours(15, 0, 0, 0) // 10:00 en Lima
    const { p, proposal } = await proposed(c, startsAt.toISOString())
    const done = await run(c, (tx) => confirmProposalByPhone(tx, c.orgId, c.ownerId, proposal.id))
    expect(done.status).toBe("ejecutada")
    const booked = await ownerDb.select().from(appointment).where(eq(appointment.patientId, p.patientId))
    expect(booked).toMatchObject([{ startsAt, roomId: c.roomId, professionalUserId: c.professionalId, status: "confirmada" }])
    expect(await run(c, (tx) => listAwaitingAnswer(tx, c.orgId))).toEqual({ items: [], total: 0 })
    // Otra persona: le proponen el mismo horario, que ya no está libre.
    const other = await person(c, "Ana Gómez", { openWindow: true })
    const late = await run(c, (tx) =>
      createProposal(tx, c.orgId, {
        conversationId: other.conversationId!, action: "reservar_cita",
        payload: { patientId: other.patientId, branchId: c.branchId, professionalUserId: c.professionalId, roomId: c.roomId, startsAt: startsAt.toISOString(), durationMin: 30 },
        idempotencyKey: `prueba:${randomUUID()}`,
      }),
    )
    expect((await run(c, (tx) => listAwaitingAnswer(tx, c.orgId))).items).toMatchObject([{ id: late.id, taken: true }])
    await expect(run(c, (tx) => confirmProposalByPhone(tx, c.orgId, c.ownerId, late.id))).rejects.toMatchObject({
      code: "SLOT_TAKEN",
      message: "Ese horario ya no está libre: elige otro en la Agenda",
    })
    // La propuesta sigue esperando; nada quedó a medias.
    expect((await run(c, (tx) => listAwaitingAnswer(tx, c.orgId))).items.map((item) => item.id)).toEqual([late.id])
    expect(await ownerDb.select().from(appointment).where(eq(appointment.patientId, other.patientId))).toHaveLength(0)
  })
})

describe("La invitación de calendario en los avisos de cita por correo (issue 46)", () => {
  /** Guarda lo que se adjunta, como lo haría el bucket. */
  function capturingStorage() {
    const stored: Array<{ contentType: string; text: string }> = []
    const unused = async (): Promise<never> => {
      throw new Error("no usado")
    }
    const storage: Storage = {
      putAvatar: unused,
      deleteByUrl: async () => {},
      putAttachment: async ({ orgId, conversationId, bytes, contentType, ext }) => {
        stored.push({ contentType, text: new TextDecoder().decode(bytes) })
        return { objectKey: `${orgId}/${conversationId}/${stored.length}.${ext}`, mimeType: contentType, filename: `adjunto.${ext}`, size: bytes.byteLength }
      },
      attachmentUrl: async (key) => `https://signed.example.com/${key}`,
      deleteAttachment: async () => {},
      putPatientDocument: unused,
      putPatientAvatar: unused,
    }
    return { storage, stored }
  }

  it("reservar, mover y cancelar: el mismo evento, con su versión, y al final se borra", async () => {
    const c = await clinic({ whatsapp: false, email: true, anyHour: true })
    await ruleOn(c, "recordatorio_cita", new Date(Date.now() - DAY))
    const p = await person(c, "Jorge Salas", { whatsapp: false, email: "jorge@example.com", consent: ["recordatorio"] })
    const startsAt = new Date(Math.ceil((Date.now() + 3 * DAY) / HOUR) * HOUR)
    const id = await appointmentFor(c, p.patientId, startsAt)
    const { storage, stored } = capturingStorage()
    const send = async (change: "reservada" | "movida" | "cancelada") => {
      expect(await run(c, (tx) => enqueueAppointmentNotice(tx, c.orgId, id, change))).toEqual({ queued: true })
      const now = new Date()
      const results = await run(c, (tx) => deliverDueJobs(tx, c.orgId, now, { secretsKey: KEY, publicBaseUrl: "https://clinica.test", storage }))
      expect(results.map((result) => result.outcome)).toEqual(["enviado"])
      const jobs = await jobsOf(c)
      return messageOf(jobs[jobs.length - 1]!.sentMessageId)
    }
    const lines = (text: string) => text.replace(/\r\n /g, "").split("\r\n")

    const booked = await send("reservada")
    // El mismo correo de siempre, con el archivo adjunto.
    expect(booked.contentType).toBe("document")
    expect(booked.body?.split("\n")[0]).toContain("Clínica Sonríe")
    expect(booked.attachments).toEqual([expect.objectContaining({ filename: "cita.ics", mimeType: "text/calendar; charset=utf-8; method=REQUEST" })])
    const first = lines(stored[0]!.text)
    expect(first).toContain("METHOD:REQUEST")
    expect(first).toContain(`UID:${id}@odentia`)
    expect(first).toContain("SEQUENCE:0")
    expect(first).toContain("SUMMARY:Cita en Clínica Sonríe")
    expect(first).toContain(`ORGANIZER;CN="Clínica Sonríe":mailto:clinica-${c.orgId}@example.com`)
    expect(first).toContain("ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE:mailto:jorge@example.com")
    expect(first.some((line) => line.startsWith("DTSTART;TZID=America/Lima:"))).toBe(true)
    expect(first.join("\n")).toContain("Con Dra. Ana Torres")

    // Moverla sube la versión: el calendario actualiza el mismo evento.
    await ownerDb.update(appointment).set({ startsAt: new Date(startsAt.getTime() + HOUR), endsAt: new Date(startsAt.getTime() + HOUR + 30 * 60_000), version: 2 }).where(eq(appointment.id, id))
    await send("movida")
    const moved = lines(stored[1]!.text)
    expect(moved).toContain("METHOD:REQUEST")
    expect(moved).toContain(`UID:${id}@odentia`)
    expect(moved).toContain("SEQUENCE:1")

    // Cancelarla la borra del calendario.
    await ownerDb.update(appointment).set({ status: "cancelada", version: 3 }).where(eq(appointment.id, id))
    const cancelled = await send("cancelada")
    expect(cancelled.attachments).toEqual([expect.objectContaining({ mimeType: "text/calendar; charset=utf-8; method=CANCEL" })])
    const gone = lines(stored[2]!.text)
    expect(gone).toContain("METHOD:CANCEL")
    expect(gone).toContain("STATUS:CANCELLED")
    expect(gone).toContain("SEQUENCE:2")
  })

  it("el recordatorio sigue siendo solo texto", async () => {
    const c = await clinic({ whatsapp: false, email: true })
    await ruleOn(c, "recordatorio_cita", new Date(NOW.getTime() - DAY))
    const p = await person(c, "Rosa Pérez", { whatsapp: false, email: "rosa@example.com", consent: ["recordatorio"] })
    await appointmentFor(c, p.patientId, new Date(NOW.getTime() + 24 * HOUR))
    await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, NOW))
    const { storage, stored } = capturingStorage()
    await run(c, (tx) => deliverDueJobs(tx, c.orgId, NOW, { secretsKey: KEY, publicBaseUrl: "https://clinica.test", storage }))
    const [job] = await jobsOf(c)
    expect((await messageOf(job!.sentMessageId)).contentType).toBe("text")
    expect(stored).toEqual([])
  })
})

describe("al llegar al presupuesto del mes (ADR 0085)", () => {
  /** La clínica pasó su crédito de USD 29 y su presupuesto de USD 1 este mes (con el reloj real: así lo mide el cobro). */
  async function overBudget(c: Clinic) {
    const [plan] = await ownerDb
      .insert(saasPlan)
      .values({ code: `presupuesto-${c.orgId}`, name: "Plan", currency: "USD", priceCents: 2900, creditCents: 2900, conversationMicros: 500_000, trialCreditCents: 0, trialMaxCreditCents: 0 })
      .returning({ id: saasPlan.id })
    const now = Date.now()
    const values = { status: "activa", isDemo: false, planId: plan!.id, spendCapCents: 100, currentPeriodStart: new Date(now - 10 * DAY), currentPeriodEnd: new Date(now + 20 * DAY) }
    await ownerDb.insert(saasSubscription).values({ organizationId: c.orgId, ...values }).onConflictDoUpdate({ target: saasSubscription.organizationId, set: values })
    await ownerDb.insert(saasAction).values(
      Array.from({ length: 62 }, (_, index) => ({
        organizationId: c.orgId, kind: "conversacion", tier: "gestiona", occurredAt: new Date(now - (index + 1) * HOUR), contactId: randomUUID(),
        detail: "Atendió una conversación por WhatsApp", currency: "USD", basePriceMicros: 500_000, priceMicros: 500_000, dedupeKey: randomUUID(),
      })),
    )
  }

  it("Argos no escribe para recuperar: el mensaje espera y el recordatorio sale; al subirlo sale lo que sigue teniendo sentido (D5)", async () => {
    const c = await clinic()
    await overBudget(c)
    await ruleOn(c, "seguimiento_presupuesto", new Date(NOW.getTime() - HOUR))
    await ruleOn(c, "recordatorio_cita", new Date(NOW.getTime() - HOUR), { hoursBefore: [24] })
    const reminded = await person(c, "Con su cita", { consent: ["recordatorio"], openWindow: true })
    await appointmentFor(c, reminded.patientId, new Date(NOW.getTime() + 24 * HOUR))
    const waiting = await person(c, "Sin cita", { consent: ["seguimiento", "novedades"], openWindow: true })
    const booked = await person(c, "Reservó después", { consent: ["seguimiento", "novedades"], openWindow: true })
    await dueBudget(c, waiting.patientId)
    await dueBudget(c, booked.patientId)
    await run(c, (tx) => syncBudgetFollowUps(tx, c.orgId, NOW))
    await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, NOW))
    const held = await deliver(c)
    expect(held.map((result) => [result.outcome, result.detail ?? null]).sort()).toEqual([
      ["enviado", null],
      ["pospuesto", BUDGET_HOLD],
      ["pospuesto", BUDGET_HOLD],
    ])
    expect(await run(c, (tx) => listBudgetHeldJobs(tx, c.orgId))).toEqual([{ kind: "seguimiento_presupuesto", count: 2 }])
    // Mientras espera, una de las dos personas reservó su cita.
    await appointmentFor(c, booked.patientId, new Date(NOW.getTime() + 3 * DAY))
    await ownerDb.update(saasSubscription).set({ spendCapCents: 100_000 }).where(eq(saasSubscription.organizationId, c.orgId))
    const later = await deliver(c, new Date(NOW.getTime() + 2 * HOUR))
    expect(later.map((result) => result.outcome).sort()).toEqual(["cancelado", "enviado"])
    const jobs = await jobsOf(c)
    const followUp = (patientId: string) => jobs.find((job) => job.kind === "seguimiento_presupuesto" && job.patientId === patientId)
    expect(followUp(waiting.patientId)?.status).toBe("enviado")
    expect(followUp(booked.patientId)).toMatchObject({ status: "cancelado", lastError: expect.stringContaining("Ya tiene su cita") })
    expect(await run(c, (tx) => listBudgetHeldJobs(tx, c.orgId))).toEqual([])
  })

  it("quien ya tiene su cita no espera: el seguimiento de su presupuesto es servicio y sale igual", async () => {
    const c = await clinic()
    await overBudget(c)
    await ruleOn(c, "seguimiento_presupuesto", new Date(NOW.getTime() - HOUR))
    // Luis tiene un presupuesto pendiente y una limpieza la semana que viene.
    const luis = await person(c, "Luis con su limpieza", { consent: ["seguimiento", "novedades"], openWindow: true })
    await appointmentFor(c, luis.patientId, new Date(NOW.getTime() + 5 * DAY))
    await dueBudget(c, luis.patientId)
    await run(c, (tx) => syncBudgetFollowUps(tx, c.orgId, NOW))
    expect((await deliver(c)).map((result) => result.outcome)).toEqual(["enviado"])
    expect(await run(c, (tx) => listBudgetHeldJobs(tx, c.orgId))).toEqual([])
  })
})

describe("el ciclo de la cita: que la persona sepa que la tiene y no la pierda (ADR 0113)", () => {
  // Martes 6 de octubre, 15:00 en Lima: el recordatorio de un día antes de una cita del miércoles a esa hora.
  const TUESDAY_3PM = new Date(NOW.getTime() + 5 * HOUR)

  it("confirmar no quita el «Te esperamos» de pocas horas antes: sale sin «Confirmar»", async () => {
    const c = await clinic({ approved: ["recordatorio_cita", "recordatorio_cita_confirmada"] })
    await ruleOn(c, "recordatorio_cita", new Date(NOW.getTime() - HOUR), { hoursBefore: [24, 3] })
    const p = await person(c, "Carlos Ramos", { consent: ["recordatorio"] })
    const appointmentId = await appointmentFor(c, p.patientId, new Date(TUESDAY_3PM.getTime() + DAY))
    await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, TUESDAY_3PM))
    expect((await deliver(c, TUESDAY_3PM)).map((result) => result.outcome)).toEqual(["enviado"])
    const [asked] = await jobsOf(c)
    expect((await messageOf(asked!.sentMessageId)).templateName).toBe("odentia_recordatorio_cita_v2")

    // Confirma (con el botón, el enlace o por teléfono: todos pasan por la misma operación).
    await run(c, (tx) => setAppointmentStatus(tx, c.orgId, null, appointmentId, "confirmada", { via: "respuesta" }))
    const near = (await jobsOf(c)).find((job) => job.status === "pendiente")
    expect(near).toMatchObject({ kind: "recordatorio_cita", dedupeKey: `recordatorio_cita:${appointmentId}:3` })

    // Miércoles a las 12:00 en Lima, tres horas antes.
    const wednesdayNoon = new Date(TUESDAY_3PM.getTime() + 21 * HOUR)
    expect((await deliver(c, wednesdayNoon)).map((result) => result.outcome)).toEqual(["enviado"])
    const sent = await messageOf((await jobsOf(c)).find((job) => job.id === near!.id)!.sentMessageId)
    expect(sent.templateName).toBe("odentia_recordatorio_cita_confirmada_v1")
    expect(sent.body).toMatch(/^Hola, Carlos\. Te esperamos hoy, miércoles 7 de octubre, a las 3:00.*, con Dra\. Ana Torres en Clínica Sonríe, sede Centro\./)
    expect((sent.replyButtons as { title: string }[]).map((button) => button.title)).not.toContain("Confirmar")
  })

  it("dos recordatorios de la misma cita no salen el mismo día: el que el horario corre a la noche anterior se da por cubierto", async () => {
    const c = await clinic({ approved: ["recordatorio_cita"] })
    await ruleOn(c, "recordatorio_cita", new Date(NOW.getTime() - HOUR), { hoursBefore: [24, 3] })
    const p = await person(c, "Cita temprano", { consent: ["recordatorio"] })
    // Miércoles 10:30 en Lima: el de tres horas antes (7:30) cae antes del horario y se corre al último minuto del martes.
    const appointmentId = await appointmentFor(c, p.patientId, new Date(NOW.getTime() + DAY + 30 * 60_000))
    await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, NOW))
    const tuesdayNight = new Date("2026-10-07T00:59:00.000Z")
    expect((await jobsOf(c)).map((job) => job.scheduledFor.toISOString())).toEqual(["2026-10-06T15:30:00.000Z", tuesdayNight.toISOString()])
    expect((await deliver(c, new Date(NOW.getTime() + 30 * 60_000))).map((result) => result.outcome)).toEqual(["enviado"])
    expect(await deliver(c, tuesdayNight)).toMatchObject([{ outcome: "cancelado", detail: "Ya se le recordó esta cita hoy" }])
    expect((await jobsOf(c)).filter((job) => job.appointmentId === appointmentId).map((job) => job.status)).toEqual(["enviado", "cancelado"])
  })

  describe("«¿Vienes en camino?» si no llegó a la hora", () => {
    /** Alguien ya llegó hoy a otra cita de la sede: ahí se marcan las llegadas. */
    async function someoneArrived(c: Clinic, at = new Date(NOW.getTime() - HOUR)) {
      const other = await person(c, "Llegó temprano", { whatsapp: false })
      const id = await appointmentFor(c, other.patientId, new Date(at.getTime() + 5 * 60_000), "confirmada")
      await ownerDb.update(appointment).set({ arrivedAt: at, arrivedBy: c.ownerId }).where(eq(appointment.id, id))
    }
    async function late(c: Clinic, minutes = 20) {
      const p = await person(c, "Carlos Ramos", { consent: ["recordatorio"] })
      const appointmentId = await appointmentFor(c, p.patientId, new Date(NOW.getTime() - minutes * 60_000), "confirmada", 45)
      return { ...p, appointmentId }
    }

    it("a los 15 minutos le pregunta si viene en camino, con su cita, una sola vez", async () => {
      const c = await clinic({ approved: ["cita_sin_llegar"] })
      await ruleOn(c, "recordatorio_cita", new Date(NOW.getTime() - DAY))
      await someoneArrived(c)
      const carlos = await late(c)
      // A los 10 minutos de la hora todavía no se pregunta.
      expect(await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, new Date(NOW.getTime() - 10 * 60_000)))).toMatchObject({ programados: 0 })
      expect(await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, NOW))).toMatchObject({ programados: 1 })
      expect(await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, NOW))).toMatchObject({ programados: 0 })
      const [job] = (await jobsOf(c)).filter((item) => item.kind === "cita_sin_llegar")
      expect(job).toMatchObject({ appointmentId: carlos.appointmentId, contactId: carlos.contactId, scheduledFor: NOW })

      expect((await deliver(c)).map((result) => result.outcome)).toEqual(["enviado"])
      const sent = await messageOf((await jobsOf(c)).find((item) => item.id === job!.id)!.sentMessageId)
      expect(sent).toMatchObject({ contentType: "template", templateName: "odentia_cita_sin_llegar_v1" })
      expect(sent.body).toMatch(/^Hola, Carlos\. Te esperamos en Clínica Sonríe, sede Centro: tu cita es hoy, martes 6 de octubre, a las 9:40.*, con Dra\. Ana Torres\. ¿Vienes en camino\?/)
      expect((sent.replyButtons as { title: string }[]).map((button) => button.title)).toEqual(["Voy en camino", "No podré ir", "No más recordatorios"])
    })

    it("no pregunta donde no se marcan las llegadas, fuera del horario para escribir, ni a quien ya llegó", async () => {
      const c = await clinic({ approved: ["cita_sin_llegar"] })
      await ruleOn(c, "recordatorio_cita", new Date(NOW.getTime() - 2 * DAY))
      const carlos = await late(c)
      const asked = async () => (await jobsOf(c)).filter((job) => job.kind === "cita_sin_llegar").length
      // Nadie marcó una llegada hoy en la sede: no se sabe si llegó.
      await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, NOW))
      expect(await asked()).toBe(0)
      // A las 21:00 en Lima, fuera del horario para escribir.
      const night = new Date("2026-10-07T02:00:00.000Z")
      const nightOwl = await person(c, "Cita de noche", { consent: ["recordatorio"] })
      await appointmentFor(c, nightOwl.patientId, new Date(night.getTime() - 20 * 60_000), "confirmada", 45)
      await someoneArrived(c, new Date(night.getTime() - HOUR))
      await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, night))
      expect(await asked()).toBe(0)
      // Ya en horario: se anota, pero si llega antes de que salga, no sale.
      await someoneArrived(c)
      await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, NOW))
      expect(await asked()).toBe(1)
      await ownerDb.update(appointment).set({ arrivedAt: NOW, arrivedBy: c.ownerId }).where(eq(appointment.id, carlos.appointmentId))
      expect(await deliver(c)).toMatchObject([{ outcome: "cancelado", detail: "Ya llegó" }])
    })

    it("si no se le puede escribir, queda la llamada para recepción", async () => {
      const c = await clinic()
      await ruleOn(c, "recordatorio_cita", new Date(NOW.getTime() - DAY))
      await someoneArrived(c)
      const carlos = await late(c)
      await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, NOW))
      expect((await deliver(c)).map((result) => result.outcome)).toEqual(["fallido"])
      const tasks = await tasksOf(c)
      expect(tasks.map((task) => [task.title, task.patientId])).toEqual([["Llamar a Carlos Ramos: no ha llegado a su cita", carlos.patientId]])
    })
  })
})

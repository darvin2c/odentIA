import { randomUUID } from "node:crypto"
import { type Db, withOrgContext } from "@odentia/db"
import { appointment, scheduleRoom } from "@odentia/db/schema/agenda"
import { member, user } from "@odentia/db/schema/auth"
import { automationConsent, automationJob, automationRule } from "@odentia/db/schema/automation"
import { patientContact, treatmentBudget, treatmentPlan } from "@odentia/db/schema/clinical"
import { agentConfig, contact, contactIdentity, conversation, crmTask, message } from "@odentia/db/schema/crm"
import { auditEvent, branch, orgProfile } from "@odentia/db/schema/org"
import { portalSession } from "@odentia/db/schema/portal"
import { and, asc, eq } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { confirmAppointmentByContact, confirmProposalByPhone, createProposal } from "./agent-operations.js"
import { createAppointment, getAppointmentContext, moveAppointment, setAppointmentStatus } from "./appointments.js"
import { AUTOMATION_MESSAGES, type AutomationMessageKey, GENERAL_PERMISSION_QUESTION, GENERAL_PERMISSION_YES, replyId } from "./automation-messages.js"
import {
  answerGeneralPermission,
  appointmentConfirmationPlan,
  askGeneralPermissionAfterBooking,
  deliverDueJobs,
  getMessagePermissions,
  handleAutomationReply,
  mayWriteFirst,
  setLine,
  syncAppointmentReminders,
  syncBudgetFollowUps,
  syncCancelledAppointments,
  turnOnNewClinicLines,
} from "./automation.js"
import { setProfessionalSchedule } from "./availability.js"
import { createConnection } from "./connections.js"
import { createContact, listContacts } from "./contacts.js"
import { listConversations, writeToPerson } from "./conversations.js"
import { getContactWorkspace } from "./crm-workspace.js"
import { nextPatientNumber } from "./patients.js"
import { getBookingLinkCalendar, issuePersonalLink } from "./booking-links.js"
import { resolvePersonalLinkRefs } from "./personal-link-token.js"
import { getPortalAppointmentCalendar, reschedulePortalAppointment } from "./portal.js"
import { configurePublicLinks } from "./public-links.js"
import { secretsKeyFromEnv } from "./secrets.js"
import { getPersonalLinkView } from "./su-enlace.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"
import { insertTestPatients } from "./test-patient.js"

/**
 * Bandeja, Agenda y la confirmación de citas conectadas (fase 2, tablero 3):
 * «Escribirle», los avisos de «Recordar la cita» cuando la cita cambia, cuándo
 * pide el agente confirmar, la confirmación por escrito y lo que trae una
 * clínica nueva. Sin proveedor real: «enviado» es dejar el mensaje en la cola.
 */
setupTestDb()
const KEY = secretsKeyFromEnv("bd".repeat(32))
const HOUR = 3_600_000
const DAY = 24 * HOUR

interface Clinic {
  orgId: string
  ownerId: string
  professionalId: string
  branchId: string
  roomId: string
  whatsappId: string | null
}

async function clinic(options: { whatsapp?: boolean; approved?: AutomationMessageKey[]; admin?: boolean } = {}): Promise<Clinic> {
  const orgId = randomUUID()
  const ownerId = `owner-${orgId}`
  const professionalId = `professional-${orgId}`
  await insertOrg(ownerDb, orgId, `aviso-${orgId}`)
  await ownerDb.update(orgProfile).set({ tradeName: "Clínica Sonríe" }).where(eq(orgProfile.organizationId, orgId))
  await ownerDb.insert(user).values([
    { id: ownerId, name: "Dueña", email: `${ownerId}@aviso.test`, emailVerified: true },
    { id: professionalId, name: "Dra. Ana Torres", email: `${professionalId}@aviso.test`, emailVerified: true },
  ])
  await ownerDb.insert(member).values([
    { id: `m-${ownerId}`, userId: ownerId, organizationId: orgId, role: "owner", createdAt: new Date() },
    { id: `m-${professionalId}`, userId: professionalId, organizationId: orgId, role: "clinician", createdAt: new Date() },
  ])
  // Recepción y el Administrador encendidos y con el horario para escribir a toda hora: el reloj es el real.
  await ownerDb.insert(agentConfig).values({
    organizationId: orgId,
    enabled: true,
    advisor: { enabled: options.admin !== false },
    writingHours: Array.from({ length: 7 }, (): Array<[number, number]> => [[0, 1440]]),
  })
  const [site] = await ownerDb.insert(branch).values({ organizationId: orgId, name: "Centro", timezone: "America/Lima" }).returning({ id: branch.id })
  const [room] = await ownerDb.insert(scheduleRoom).values({ organizationId: orgId, branchId: site!.id, name: "Unidad dental 1" }).returning({ id: scheduleRoom.id })
  // Atiende todo el día, toda la semana: mover una cita valida el horario.
  await withOrgContext(appDb, orgId, (tx) =>
    setProfessionalSchedule(tx, orgId, ownerId, {
      branchId: site!.id,
      professionalUserId: professionalId,
      rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 0, endMin: 24 * 60 })),
    }),
  )
  const templates = (options.approved ?? []).map((key) => ({ name: AUTOMATION_MESSAGES[key].template, language: "es" }))
  const connection =
    options.whatsapp === false
      ? null
      : await withOrgContext(appDb, orgId, (tx) =>
          createConnection(tx, orgId, KEY, {
            channel: "whatsapp", provider: "whatsapp_cloud_api", displayName: "WA",
            config: { phoneNumberId: "P", wabaId: "W", accessToken: "T", appSecret: "S", templates },
          }, { fetch, validateExternal: false }))
  return { orgId, ownerId, professionalId, branchId: site!.id, roomId: room!.id, whatsappId: connection?.id ?? null }
}

function run<T>(c: Clinic, fn: (tx: Db) => Promise<T>): Promise<T> {
  return withOrgContext(appDb, c.orgId, fn)
}

/** Paciente con su persona; opcionalmente con WhatsApp, permisos y un hilo que escribió hace poco. */
async function person(
  c: Clinic,
  name: string,
  options: {
    consent?: Array<"recordatorio" | "seguimiento" | "novedades">
    /** Pidió no recibir ese tipo de mensaje (baja). */
    refused?: Array<"recordatorio" | "seguimiento" | "avisos">
    openWindow?: boolean
    phone?: string
  } = {},
) {
  const [row] = await insertTestPatients(ownerDb, { organizationId: c.orgId, displayName: name, patientNumber: await nextPatientNumber(ownerDb, c.orgId) })
  const [link] = await ownerDb
    .select({ contactId: patientContact.contactId })
    .from(patientContact)
    .where(and(eq(patientContact.organizationId, c.orgId), eq(patientContact.patientId, row!.id)))
  const contactId = link!.contactId
  const digits = options.phone ?? `519${randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "0")}`
  const [identity] = await ownerDb
    .insert(contactIdentity)
    .values({ organizationId: c.orgId, contactId, channel: "whatsapp", externalUserId: `wa:${digits}`, isPrimary: true })
    .returning({ id: contactIdentity.id })
  let conversationId: string | null = null
  if (options.openWindow && c.whatsappId) {
    const [thread] = await ownerDb
      .insert(conversation)
      .values({
        organizationId: c.orgId, contactId, contactIdentityId: identity!.id, channelConnectionId: c.whatsappId,
        externalThreadId: `wa:${digits}`, lastInboundAt: new Date(),
      })
      .returning({ id: conversation.id })
    conversationId = thread!.id
  }
  for (const purpose of options.consent ?? []) {
    await ownerDb.insert(automationConsent).values({ organizationId: c.orgId, contactId, purpose, status: "granted", source: "presencial" })
  }
  for (const purpose of options.refused ?? []) {
    await ownerDb.insert(automationConsent).values({ organizationId: c.orgId, contactId, purpose, status: "revoked", source: "baja" })
  }
  return { patientId: row!.id, contactId, conversationId }
}

async function lineOn(c: Clinic, kind = "recordatorio_cita") {
  const rule = await run(c, (tx) => setLine(tx, c.orgId, c.ownerId, kind, { enabled: true }))
  await ownerDb.update(automationRule).set({ enabledAt: new Date(Date.now() - HOUR) }).where(eq(automationRule.id, rule.id))
  return rule
}

/** Una hora redonda dentro de unos días, para que la cita no caiga en el pasado. */
function later(ms: number): Date {
  const at = new Date(Date.now() + ms)
  at.setUTCMinutes(0, 0, 0)
  return at
}

const book = (c: Clinic, patientId: string, startsAt: Date, extra: { notice?: boolean } = {}) =>
  run(c, (tx) =>
    createAppointment(tx, c.orgId, c.ownerId, {
      branchId: c.branchId, patientId, professionalUserId: c.professionalId, roomId: c.roomId,
      startsAt: startsAt.toISOString(), outsideSchedule: true, ...extra,
    }),
  )

const jobsOf = (c: Clinic) =>
  ownerDb.select().from(automationJob).where(eq(automationJob.organizationId, c.orgId)).orderBy(asc(automationJob.scheduledFor), asc(automationJob.id))

const deliver = (c: Clinic, now = new Date()) =>
  run(c, (tx) => deliverDueJobs(tx, c.orgId, now, { secretsKey: KEY, publicBaseUrl: "https://clinica.test" }))

async function bodyOf(id: string | null) {
  const [row] = await ownerDb.select({ body: message.body }).from(message).where(eq(message.id, id ?? randomUUID()))
  return row?.body ?? ""
}

describe("al cambiar la cita, el agente le avisa", () => {
  it("al reservar desde la Agenda le avisa por la conversación abierta, y eso cuenta como su mensaje del día", async () => {
    const c = await clinic()
    await lineOn(c)
    // Con el sí de novedades: retomar el presupuesto (más abajo) es promoción para WhatsApp (ADR 0040).
    const rosa = await person(c, "Rosa Quispe", { consent: ["recordatorio", "seguimiento", "novedades"], openWindow: true })
    const booked = await book(c, rosa.patientId, later(3 * DAY))
    expect(booked.notice).toEqual({ queued: true })
    expect((await jobsOf(c)).map((job) => [job.kind, job.status])).toEqual([["aviso_cita_reservada", "pendiente"]])
    expect((await deliver(c)).map((result) => result.outcome)).toEqual(["enviado"])
    const [job] = await jobsOf(c)
    expect(job).toMatchObject({ status: "enviado", via: "respuesta", channel: "whatsapp" })
    const body = await bodyOf(job!.sentMessageId)
    expect(body).toMatch(/^Hola, Rosa\. Tu cita en Clínica Sonríe, sede Centro quedó reservada: .+, a las .+, con Dra\. Ana Torres\. Si necesitas cambiarla, responde a este mensaje\.$/)

    // Lo demás de ese día espera a mañana: el aviso fue su mensaje del día.
    await lineOn(c, "seguimiento_presupuesto")
    await ownerDb.update(automationRule).set({ enabledAt: new Date(Date.now() - 3 * DAY) }).where(and(eq(automationRule.organizationId, c.orgId), eq(automationRule.kind, "seguimiento_presupuesto")))
    const [plan] = await ownerDb.insert(treatmentPlan).values({ organizationId: c.orgId, patientId: rosa.patientId, title: "Plan" }).returning({ id: treatmentPlan.id })
    await ownerDb.insert(treatmentBudget).values({
      organizationId: c.orgId, patientId: rosa.patientId, planId: plan!.id, budgetNumber: 1, title: "Blanqueamiento", currency: "PEN",
      status: "presentado", presentedAt: new Date(Date.now() - 49 * HOUR),
    })
    await run(c, (tx) => syncBudgetFollowUps(tx, c.orgId, new Date()))
    expect((await deliver(c)).map((result) => [result.outcome, result.detail])).toEqual([["pospuesto", "Ya recibió un mensaje hoy"]])
  })

  it("a quien le faltan datos, el aviso de reserva lleva su enlace para completarlos antes de venir", async () => {
    configurePublicLinks({ webURL: "https://app.odentia.test", cookieDomain: "odentia.test" })
    try {
      const c = await clinic()
      await lineOn(c)
      // Registrado por teléfono con lo mínimo: le falta, por ejemplo, su fecha de nacimiento.
      const pedro = await person(c, "Pedro Ríos", { consent: ["recordatorio"], openWindow: true })
      await book(c, pedro.patientId, later(3 * DAY))
      expect((await deliver(c)).map((result) => result.outcome)).toEqual(["enviado"])
      const [job] = await jobsOf(c)
      // Es el mismo aviso, ahora con su enlace: no un segundo mensaje ese día.
      expect(job).toMatchObject({ kind: "aviso_cita_reservada", status: "enviado", via: "respuesta" })
      const stored = await bodyOf(job!.sentMessageId)
      // En el mensaje guardado no queda el token: una referencia que el worker resuelve al enviar.
      expect(stored).toMatch(
        /^Hola, Pedro\. Te esperamos en Clínica Sonríe, sede Centro: .+\. Antes de venir, completa tus datos aquí\.\n\nVer mi cita y mis datos: https:\/\/aviso-[0-9a-f-]+\.odentia\.test\/reserva\?token=\{\{su-enlace:[0-9a-f-]{36}\}\}$/,
      )
      const body = resolvePersonalLinkRefs(stored, KEY)
      // El enlace es el de esa persona: muestra esa cita y lo que le falta.
      const token = /token=([0-9a-f]{64})/.exec(body)![1]!
      const view = await run(c, (tx) => getPersonalLinkView(tx, c.orgId, token))
      expect(view.appointment).toMatchObject({ canChange: true, branchName: "Centro" })
      expect(view.data?.missing.map((item) => item.key)).toContain("birthDate")
    } finally {
      configurePublicLinks(null)
    }
  })

  it("un aviso de cita no espera a mañana aunque la persona ya recibió otro mensaje hoy", async () => {
    const c = await clinic()
    await lineOn(c)
    const rosa = await person(c, "Rosa Quispe", { consent: ["recordatorio"], openWindow: true })
    await book(c, rosa.patientId, later(3 * DAY))
    await deliver(c)
    const moved = (await jobsOf(c))[0]!
    expect(moved.status).toBe("enviado")
    const current = (await ownerDb.select().from(appointment).where(eq(appointment.organizationId, c.orgId)))[0]!
    await run(c, (tx) => moveAppointment(tx, c.orgId, c.ownerId, current.id, { expectedVersion: current.version, startsAt: later(4 * DAY).toISOString() }))
    expect((await deliver(c)).map((result) => result.outcome)).toEqual(["enviado"])
    const notice = (await jobsOf(c)).find((job) => job.kind === "aviso_cita_movida")!
    expect(await bodyOf(notice.sentMessageId)).toMatch(/^Hola, Rosa\. Tu cita en Clínica Sonríe, sede Centro cambió de fecha: ahora es .+\. Si no te queda bien, responde a este mensaje\.$/)
  })

  it("no avisa lo que se dijo en la conversación ni nada si «Recordar la cita» está apagada", async () => {
    const c = await clinic()
    const rosa = await person(c, "Rosa Quispe", { consent: ["recordatorio"], openWindow: true })
    const off = await book(c, rosa.patientId, later(3 * DAY))
    expect(off.notice).toEqual({ queued: false })
    await lineOn(c)
    // El agente o el enlace ya se lo dijeron en la conversación.
    const told = await book(c, rosa.patientId, later(4 * DAY), { notice: false })
    expect(told.notice).toBeUndefined()
    await run(c, (tx) => setAppointmentStatus(tx, c.orgId, null, told.id, "cancelada", { notice: false }))
    expect(await jobsOf(c)).toEqual([])
  })

  it("reprogramar desde el portal no le avisa a la persona lo que ella misma hizo", async () => {
    const c = await clinic()
    await lineOn(c)
    const rosa = await person(c, "Rosa Quispe", { consent: ["recordatorio"], openWindow: true })
    const booked = await book(c, rosa.patientId, later(3 * DAY), { notice: false })
    const [session] = await ownerDb
      .insert(portalSession)
      .values({
        organizationId: c.orgId,
        patientId: rosa.patientId,
        contactId: rosa.contactId,
        scope: { appointments: true, budgets: false, account: false, documents: [] },
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + HOUR),
      })
      .returning()
    const to = later(4 * DAY)
    const moved = await run(c, (tx) =>
      reschedulePortalAppointment(tx, { orgId: c.orgId, session: session!, patientName: "Rosa Quispe" }, booked.id, {
        expectedVersion: booked.version,
        startsAt: to.toISOString(),
        professionalUserId: booked.professionalUserId,
      }),
    )
    expect(new Date(moved.startsAt).getTime()).toBe(to.getTime())
    expect(await jobsOf(c)).toEqual([])
  })

  it("«Añadir al calendario»: el portal y «Su enlace» bajan el mismo evento, y el portal solo el suyo (issue 46)", async () => {
    const c = await clinic()
    const rosa = await person(c, "Rosa Quispe", { consent: ["recordatorio"] })
    const other = await person(c, "Otra Persona", { consent: ["recordatorio"] })
    const booked = await book(c, rosa.patientId, later(3 * DAY), { notice: false })
    const foreign = await book(c, other.patientId, later(4 * DAY), { notice: false })
    const [session] = await ownerDb
      .insert(portalSession)
      .values({
        organizationId: c.orgId,
        patientId: rosa.patientId,
        contactId: rosa.contactId,
        scope: { appointments: true, budgets: false, account: false, documents: [] },
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + HOUR),
      })
      .returning()
    const ctx = { orgId: c.orgId, session: session!, patientName: "Rosa Quispe" }
    const fromPortal = await run(c, (tx) => getPortalAppointmentCalendar(tx, ctx, booked.id))
    const link = await run(c, (tx) =>
      issuePersonalLink(tx, c.orgId, { contactId: rosa.contactId, patientId: rosa.patientId, appointmentId: booked.id }, { secretsKey: KEY }),
    )
    const fromLink = await run(c, (tx) => getBookingLinkCalendar(tx, c.orgId, link.token))
    const event = (text: string) => text.split("\r\n").filter((line) => /^(UID|SEQUENCE|DTSTART|DTEND|SUMMARY):/.test(line.replace(/;TZID=[^:]+/, "")))
    expect(event(fromPortal)).toEqual(event(fromLink))
    expect(fromPortal).toContain(`UID:${booked.id}@odentia`)
    expect(fromPortal).toContain("SUMMARY:Cita en Clínica Sonríe")
    expect(fromPortal).not.toContain("METHOD:")
    await expect(run(c, (tx) => getPortalAppointmentCalendar(tx, ctx, foreign.id))).rejects.toMatchObject({ status: 404 })
  })

  it("con el Administrador apagado no queda nada en camino", async () => {
    const c = await clinic({ admin: false })
    await lineOn(c)
    const rosa = await person(c, "Rosa Quispe", { consent: ["recordatorio"], openWindow: true })
    expect((await book(c, rosa.patientId, later(3 * DAY))).notice).toEqual({ queued: false })
    expect(await jobsOf(c)).toEqual([])
  })

  it("mover una cita cuyo aviso aún no sale no deja otro aviso, y sus recordatorios cuentan desde la hora nueva", async () => {
    const c = await clinic()
    await lineOn(c)
    const rosa = await person(c, "Rosa Quispe", { consent: ["recordatorio"], openWindow: true })
    const booked = await book(c, rosa.patientId, later(20 * HOUR))
    await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, new Date()))
    const reminder = (await jobsOf(c)).find((job) => job.kind === "recordatorio_cita")!
    expect(reminder.dedupeKey).toBe(`recordatorio_cita:${booked.id}:3`)
    const to = later(30 * HOUR)
    const moved = await run(c, (tx) => moveAppointment(tx, c.orgId, c.ownerId, booked.id, { expectedVersion: booked.version, startsAt: to.toISOString() }))
    expect(moved.notice).toEqual({ queued: true })
    const jobs = await jobsOf(c)
    expect(jobs.map((job) => job.kind).sort()).toEqual(["aviso_cita_reservada", "recordatorio_cita"])
    expect(jobs.find((job) => job.kind === "recordatorio_cita")!.scheduledFor.getTime()).toBe(to.getTime() - 3 * HOUR)
  })

  it("si el recordatorio de la misma cita sale ahora, el aviso de reserva se da por cubierto", async () => {
    const c = await clinic()
    await lineOn(c)
    const rosa = await person(c, "Rosa Quispe", { consent: ["recordatorio"], openWindow: true })
    // El recordatorio de tres horas antes vence en cinco minutos.
    await book(c, rosa.patientId, new Date(Date.now() + 3 * HOUR + 5 * 60_000))
    await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, new Date()))
    await deliver(c, new Date(Date.now() + 10 * 60_000))
    const jobs = await jobsOf(c)
    expect(jobs.find((job) => job.kind === "aviso_cita_reservada")).toMatchObject({ status: "cancelado", lastError: "Cubierto por el recordatorio de la misma cita" })
    expect(jobs.find((job) => job.kind === "recordatorio_cita")).toMatchObject({ status: "enviado" })
  })

  it("al cancelar le ofrece otra fecha, y «Ofrecer otra fecha» no le vuelve a escribir por lo mismo", async () => {
    const c = await clinic()
    await lineOn(c)
    await lineOn(c, "cita_cancelada")
    const rosa = await person(c, "Rosa Quispe", { consent: ["recordatorio", "seguimiento"], openWindow: true })
    const booked = await book(c, rosa.patientId, later(3 * DAY), { notice: false })
    const cancelled = await run(c, (tx) => setAppointmentStatus(tx, c.orgId, c.ownerId, booked.id, "cancelada", { cancelReason: "paciente" }))
    expect(cancelled.notice).toEqual({ queued: true })
    await deliver(c)
    const notice = (await jobsOf(c)).find((job) => job.kind === "aviso_cita_cancelada")!
    expect(notice.status).toBe("enviado")
    expect(await bodyOf(notice.sentMessageId)).toMatch(/^Hola, Rosa\. Tu cita del .+ en Clínica Sonríe quedó cancelada\. ¿Te buscamos otra fecha\?$/)
    expect((await run(c, (tx) => syncCancelledAppointments(tx, c.orgId, new Date(Date.now() + 2 * HOUR)))).programados).toBe(0)
  })

  it("el aviso de su cita sale sin permiso previo y aunque no quiera recordatorios; con «ningún mensaje» no sale ni queda tarea", async () => {
    const c = await clinic()
    await lineOn(c)
    // Nunca se le preguntó: el aviso de su reserva sale igual (ADR 0030).
    const rosa = await person(c, "Rosa Quispe", { openWindow: true })
    await book(c, rosa.patientId, later(3 * DAY))
    expect((await deliver(c)).map((result) => result.outcome)).toEqual(["enviado"])
    // No quiere recordatorios: el aviso de que su cita quedó reservada le llega igual (ADR 0040).
    const lucia = await person(c, "Lucía Paredes", { openWindow: true, refused: ["recordatorio"] })
    await book(c, lucia.patientId, later(4 * DAY))
    expect((await deliver(c)).map((result) => result.outcome)).toEqual(["enviado"])
    // Pidió no recibir ningún mensaje de la clínica: ahí sí se respeta también el aviso.
    const ana = await person(c, "Ana Torres", { openWindow: true, refused: ["avisos"] })
    await book(c, ana.patientId, later(5 * DAY))
    expect((await deliver(c)).map((result) => result.outcome)).toEqual(["omitido"])
    const theirs = (await jobsOf(c)).find((job) => job.contactId === ana.contactId)
    expect(theirs).toMatchObject({ status: "omitido", cause: "sin_permiso", taskId: null })
    expect(await ownerDb.select().from(crmTask).where(eq(crmTask.organizationId, c.orgId))).toEqual([])
  })
})

describe("cuándo le pide el agente confirmar", () => {
  it("dice cuándo saldrá el primer recordatorio, cuándo salió, y nada si no se lo va a pedir", async () => {
    const c = await clinic()
    await lineOn(c)
    const rosa = await person(c, "Rosa Quispe", { consent: ["recordatorio"], openWindow: true })
    const startsAt = later(3 * DAY)
    const booked = await book(c, rosa.patientId, startsAt, { notice: false })
    expect(await run(c, (tx) => appointmentConfirmationPlan(tx, c.orgId, booked.id))).toEqual({
      askAt: new Date(startsAt.getTime() - DAY).toISOString(),
      askedAt: null,
    })
    const soon = await book(c, rosa.patientId, new Date(Date.now() + 3 * HOUR + 5 * 60_000), { notice: false })
    await run(c, (tx) => syncAppointmentReminders(tx, c.orgId, new Date()))
    await deliver(c, new Date(Date.now() + 10 * 60_000))
    const plan = await run(c, (tx) => appointmentConfirmationPlan(tx, c.orgId, soon.id))
    expect(plan?.askAt).toBeNull()
    expect(plan?.askedAt).not.toBeNull()
    // Confirmada no se le pide.
    await run(c, (tx) => setAppointmentStatus(tx, c.orgId, c.ownerId, soon.id, "confirmada"))
    expect(await run(c, (tx) => appointmentConfirmationPlan(tx, c.orgId, soon.id))).toBeNull()

    // Nunca se le preguntó: igual se le pedirá confirmar (es parte del servicio).
    const other = await person(c, "Sin preguntar", { openWindow: true })
    const unasked = await book(c, other.patientId, later(3 * DAY + 2 * HOUR), { notice: false })
    expect(await run(c, (tx) => appointmentConfirmationPlan(tx, c.orgId, unasked.id))).not.toBeNull()
    // Pidió no recibir recordatorios: no se le pedirá.
    const refused = await person(c, "Se dio de baja", { openWindow: true, refused: ["recordatorio"] })
    const optedOut = await book(c, refused.patientId, later(3 * DAY + 4 * HOUR), { notice: false })
    expect(await run(c, (tx) => appointmentConfirmationPlan(tx, c.orgId, optedOut.id))).toBeNull()
  })

  it("el cajón de la cita dice a quién se le escribe, de qué conversación salió y cuándo confirmará", async () => {
    const c = await clinic()
    await lineOn(c)
    const rosa = await person(c, "Rosa Quispe", { consent: ["recordatorio"], openWindow: true, phone: "51987654100" })
    await ownerDb.update(contact).set({ phone: "+51987654100" }).where(eq(contact.id, rosa.contactId))
    const booked = await run(c, (tx) =>
      createAppointment(tx, c.orgId, c.ownerId, {
        branchId: c.branchId, patientId: rosa.patientId, professionalUserId: c.professionalId, roomId: c.roomId,
        startsAt: later(3 * DAY).toISOString(), outsideSchedule: true, source: "conversacion", conversationId: rosa.conversationId!,
      }),
    )
    const context = await run(c, (tx) => getAppointmentContext(tx, c.orgId, booked.id))
    expect(context.person).toMatchObject({ contactId: rosa.contactId, name: "Rosa Quispe", phone: "+51987654100", relationship: "self" })
    expect(context.origin).toMatchObject({ source: "conversacion", conversationId: rosa.conversationId, channel: "whatsapp" })
    expect(context.confirmation?.askAt).not.toBeNull()
  })
})

describe("la persona confirma por escrito", () => {
  it("confirma solo una cita suya, con la misma operación del botón, y lo deja dicho", async () => {
    const c = await clinic()
    const rosa = await person(c, "Rosa Quispe", { openWindow: true })
    const ana = await person(c, "Ana Torres", { openWindow: true })
    const own = await book(c, rosa.patientId, later(3 * DAY), { notice: false })
    const theirs = await book(c, ana.patientId, later(4 * DAY), { notice: false })
    // La de otra persona nunca.
    await expect(
      run(c, (tx) => confirmAppointmentByContact(tx, c.orgId, { contactId: rosa.contactId, conversationId: rosa.conversationId!, appointmentId: theirs.id })),
    ).rejects.toMatchObject({ code: "APPOINTMENT_NOT_CONFIRMABLE" })
    const result = await run(c, (tx) => confirmAppointmentByContact(tx, c.orgId, { contactId: rosa.contactId, conversationId: rosa.conversationId! }))
    expect(result).toMatchObject({ outcome: "confirmada", appointment: { appointmentId: own.id, patientName: "Rosa Quispe", branchName: "Centro" } })
    const [row] = await ownerDb.select({ status: appointment.status }).from(appointment).where(eq(appointment.id, own.id))
    expect(row?.status).toBe("confirmada")
    const [trail] = await ownerDb
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.organizationId, c.orgId), eq(auditEvent.entityId, own.id), eq(auditEvent.action, "appointment.status_confirmada")))
    expect(trail).toMatchObject({ actorUserId: null, metadata: { from: "programada", via: "conversacion", conversationId: rosa.conversationId } })
    // Otra vez: ya estaba confirmada.
    expect(await run(c, (tx) => confirmAppointmentByContact(tx, c.orgId, { contactId: rosa.contactId, conversationId: rosa.conversationId! }))).toMatchObject({ outcome: "ya_confirmada" })
    const [still] = await ownerDb.select({ status: appointment.status }).from(appointment).where(eq(appointment.id, theirs.id))
    expect(still?.status).toBe("programada")
  })

  it("con varias por confirmar pide cuál; sin ninguna lo dice", async () => {
    const c = await clinic()
    const rosa = await person(c, "Rosa Quispe", { openWindow: true })
    expect(await run(c, (tx) => confirmAppointmentByContact(tx, c.orgId, { contactId: rosa.contactId, conversationId: rosa.conversationId! }))).toEqual({ outcome: "ninguna" })
    await book(c, rosa.patientId, later(3 * DAY), { notice: false })
    await book(c, rosa.patientId, later(5 * DAY), { notice: false })
    const many = await run(c, (tx) => confirmAppointmentByContact(tx, c.orgId, { contactId: rosa.contactId, conversationId: rosa.conversationId! }))
    expect(many.outcome).toBe("varias")
    expect(many.outcome === "varias" ? many.options : []).toHaveLength(2)
    const statuses = await ownerDb.select({ status: appointment.status }).from(appointment).where(eq(appointment.organizationId, c.orgId))
    expect(statuses.every((item) => item.status === "programada")).toBe(true)
  })
})

describe("la persona cambia su cita en la conversación con la regla de la cita propia", () => {
  it("cancelar deja el motivo «paciente» y no se lleva la cita más allá de lo que permite el enlace", async () => {
    const c = await clinic()
    const rosa = await person(c, "Rosa Quispe", { openWindow: true })
    const booked = await book(c, rosa.patientId, later(3 * DAY), { notice: false })
    const propose = (action: string, payload: Record<string, unknown>) =>
      run(c, (tx) =>
        createProposal(tx, c.orgId, { conversationId: rosa.conversationId!, action, payload, idempotencyKey: `prueba:${randomUUID()}` }),
      )
    // Más allá del horizonte de la cita propia (120 días): no se mueve.
    const far = await propose("reprogramar_cita", {
      appointmentId: booked.id, expectedVersion: booked.version, startsAt: later(200 * DAY).toISOString(),
    })
    const refused = await run(c, (tx) => confirmProposalByPhone(tx, c.orgId, c.ownerId, far.id))
    expect(refused.status).toBe("fallida")
    expect(refused.error).toMatch(/120 días/)
    const [same] = await ownerDb.select({ startsAt: appointment.startsAt }).from(appointment).where(eq(appointment.id, booked.id))
    expect(same?.startsAt.toISOString()).toBe(booked.startsAt)
    // Cancelarla deja el motivo «paciente», como desde su enlace o el portal.
    const cancel = await propose("cancelar_cita", { appointmentId: booked.id })
    expect((await run(c, (tx) => confirmProposalByPhone(tx, c.orgId, c.ownerId, cancel.id))).status).toBe("ejecutada")
    const [trail] = await ownerDb
      .select({ metadata: auditEvent.metadata })
      .from(auditEvent)
      .where(and(eq(auditEvent.organizationId, c.orgId), eq(auditEvent.entityId, booked.id), eq(auditEvent.action, "appointment.status_cancelada")))
    expect(trail?.metadata).toMatchObject({ cancelReason: "paciente" })
  })
})

describe("solo novedades y promociones pide permiso (ADR 0030)", () => {
  it("lo de su atención sale sin preguntar y respeta la baja; novedades solo con su sí", async () => {
    const c = await clinic()
    const rosa = await person(c, "Rosa Quispe")
    const may = (purpose: "recordatorio" | "seguimiento" | "novedades") =>
      run(c, (tx) => mayWriteFirst(tx, c.orgId, rosa.contactId, purpose))
    expect([await may("recordatorio"), await may("seguimiento"), await may("novedades")]).toEqual([true, true, false])
    // Un «no» guardado cuenta como baja; un sí habilita las novedades.
    await ownerDb.insert(automationConsent).values([
      { organizationId: c.orgId, contactId: rosa.contactId, purpose: "seguimiento", status: "revoked", source: "registro" },
      { organizationId: c.orgId, contactId: rosa.contactId, purpose: "novedades", status: "granted", source: "presencial" },
    ])
    expect([await may("recordatorio"), await may("seguimiento"), await may("novedades")]).toEqual([true, false, true])
  })

  it("tras reservar en la conversación, el agente pregunta una sola vez y el botón lo anota sin modelo", async () => {
    const c = await clinic()
    const rosa = await person(c, "Rosa Quispe", { openWindow: true })
    const ana = await person(c, "Ana Torres", { openWindow: true })
    const since = new Date(Date.now() - 60_000)
    const ask = (conversationId: string) => run(c, (tx) => askGeneralPermissionAfterBooking(tx, c.orgId, { conversationId, since }))
    // Sin una reserva en esa conversación no pregunta; tampoco se anota una respuesta sin pregunta.
    expect(await ask(rosa.conversationId!)).toBe(false)
    expect(await run(c, (tx) => answerGeneralPermission(tx, c.orgId, { conversationId: rosa.conversationId!, granted: true }))).toBe("no_preguntado")
    await run(c, (tx) =>
      createAppointment(tx, c.orgId, c.ownerId, {
        branchId: c.branchId, patientId: rosa.patientId, professionalUserId: c.professionalId, roomId: c.roomId,
        startsAt: later(3 * DAY).toISOString(), outsideSchedule: true, source: "conversacion", conversationId: rosa.conversationId!, notice: false,
      }),
    )
    expect(await ask(rosa.conversationId!)).toBe(true)
    const thread = await ownerDb.select().from(message).where(eq(message.conversationId, rosa.conversationId!)).orderBy(asc(message.createdAt))
    expect(thread.at(-1)).toMatchObject({ direction: "out", senderKind: "agent", body: GENERAL_PERMISSION_QUESTION })
    expect(thread.at(-1)?.replyButtons?.map((button) => button.title)).toEqual(["Sí", "No, gracias"])
    // Una sola vez por persona, aunque no responda.
    expect(await ask(rosa.conversationId!)).toBe(false)
    // El botón solo vale en su conversación.
    expect(await run(c, (tx) => handleAutomationReply(tx, c.orgId, { conversationId: ana.conversationId!, replyId: replyId("permiso_si", rosa.contactId) }))).toBe(false)
    expect(await run(c, (tx) => handleAutomationReply(tx, c.orgId, { conversationId: rosa.conversationId!, replyId: replyId("permiso_si", rosa.contactId) }))).toBe(true)
    const permissions = await run(c, (tx) => getMessagePermissions(tx, c.orgId, rosa.contactId))
    expect(permissions.find((row) => row.purpose === "novedades")).toMatchObject({ granted: true, source: "conversacion" })
    const after = await ownerDb.select().from(message).where(eq(message.conversationId, rosa.conversationId!)).orderBy(asc(message.createdAt))
    expect(after.at(-1)?.body).toBe(GENERAL_PERMISSION_YES)
    // Ya respondió: escribirlo después no cambia nada.
    expect(await run(c, (tx) => answerGeneralPermission(tx, c.orgId, { conversationId: rosa.conversationId!, granted: false }))).toBe("ya_respondio")
    // Si ya dio o negó ese permiso, no se le pregunta.
    await ownerDb.insert(automationConsent).values({ organizationId: c.orgId, contactId: ana.contactId, purpose: "novedades", status: "revoked", source: "registro" })
    await run(c, (tx) =>
      createAppointment(tx, c.orgId, c.ownerId, {
        branchId: c.branchId, patientId: ana.patientId, professionalUserId: c.professionalId, roomId: c.roomId,
        startsAt: later(4 * DAY).toISOString(), outsideSchedule: true, source: "conversacion", conversationId: ana.conversationId!, notice: false,
      }),
    )
    expect(await ask(ana.conversationId!)).toBe(false)
  })
})

describe("una clínica nueva trae prendido «Recordar la cita»", () => {
  it("se prende a nombre de quien la crea, solo esa línea y nunca encima de una que ya existe", async () => {
    const c = await clinic()
    await run(c, (tx) => turnOnNewClinicLines(tx, c.orgId, c.ownerId))
    const rules = await ownerDb.select().from(automationRule).where(eq(automationRule.organizationId, c.orgId))
    expect(rules.map((rule) => [rule.kind, rule.enabled, rule.enabledBy, rule.agentPart, rule.teamPart])).toEqual([
      ["recordatorio_cita", true, c.ownerId, true, true],
    ])
    const trail = await ownerDb
      .select({ action: auditEvent.action, actor: auditEvent.actorUserId })
      .from(auditEvent)
      .where(and(eq(auditEvent.organizationId, c.orgId), eq(auditEvent.entity, "automation")))
    expect(trail.map((row) => row.action).sort()).toEqual(["admin_line.default_on", "admin_line.updated"])
    expect(trail.every((row) => row.actor === c.ownerId)).toBe(true)

    // Quien la apagó la tiene apagada: volver a llamarlo no la prende.
    await run(c, (tx) => setLine(tx, c.orgId, c.ownerId, "recordatorio_cita", { enabled: false }))
    await run(c, (tx) => turnOnNewClinicLines(tx, c.orgId, c.ownerId))
    const [rule] = await ownerDb.select().from(automationRule).where(eq(automationRule.organizationId, c.orgId))
    expect(rule?.enabled).toBe(false)
  })
})

describe("«Escribirle»", () => {
  it("con el número que eligió el equipo nace su WhatsApp y una conversación nueva", async () => {
    const c = await clinic()
    const rosa = await run(c, (tx) => createContact(tx, c.orgId, { displayName: "Rosa Quispe", phone: "+51987654100" }, { userId: c.ownerId }))
    const first = await run(c, (tx) => writeToPerson(tx, c.orgId, c.ownerId, rosa.id))
    expect(first).toMatchObject({ created: true, channel: "whatsapp", identityCreated: true })
    const identities = await ownerDb.select().from(contactIdentity).where(eq(contactIdentity.contactId, rosa.id))
    expect(identities.map((row) => [row.channel, row.externalUserId])).toEqual([["whatsapp", "wa:51987654100"]])
    // Otra vez: la misma conversación, sin otra identidad.
    expect(await run(c, (tx) => writeToPerson(tx, c.orgId, c.ownerId, rosa.id))).toMatchObject({ conversationId: first.conversationId, created: false, identityCreated: false })
    const trail = await ownerDb
      .select({ action: auditEvent.action, actor: auditEvent.actorUserId })
      .from(auditEvent)
      .where(and(eq(auditEvent.organizationId, c.orgId), eq(auditEvent.entityId, rosa.id)))
    expect(trail).toContainEqual({ action: "contact.identity_added", actor: c.ownerId })
  })

  it("el número de otra persona no se mueve; sin número ni WhatsApp dice qué falta", async () => {
    const c = await clinic()
    const rosa = await person(c, "Rosa Quispe", { phone: "51987654100" })
    const jorge = await run(c, (tx) => createContact(tx, c.orgId, { displayName: "Jorge Ramos" }, { userId: c.ownerId }))
    await expect(run(c, (tx) => writeToPerson(tx, c.orgId, c.ownerId, jorge.id))).rejects.toMatchObject({ code: "NO_PHONE" })
    await expect(run(c, (tx) => writeToPerson(tx, c.orgId, c.ownerId, jorge.id, { phone: "+51 987 654 100" }))).rejects.toMatchObject({
      code: "IDENTITY_IN_USE",
      message: "Ese número de WhatsApp ya es de otra persona de la clínica. Ábrela desde Contactos o escribe otro número.",
    })
    const still = await ownerDb
      .select({ contactId: contactIdentity.contactId })
      .from(contactIdentity)
      .where(and(eq(contactIdentity.organizationId, c.orgId), eq(contactIdentity.externalUserId, "wa:51987654100")))
    expect(still).toEqual([{ contactId: rosa.contactId }])
    // Un número escrito sin código de país toma el de la clínica.
    expect(await run(c, (tx) => writeToPerson(tx, c.orgId, c.ownerId, jorge.id, { phone: "912 345 678" }))).toMatchObject({ identityCreated: true })

    const without = await clinic({ whatsapp: false })
    const lucia = await run(without, (tx) => createContact(tx, without.orgId, { displayName: "Lucía Paredes", phone: "+51911222333" }, { userId: without.ownerId }))
    await expect(run(without, (tx) => writeToPerson(tx, without.orgId, without.ownerId, lucia.id))).rejects.toMatchObject({ code: "NO_WHATSAPP" })
  })

  it("si escribió hace poco, se le responde en esa conversación", async () => {
    const c = await clinic()
    const rosa = await person(c, "Rosa Quispe", { openWindow: true })
    expect(await run(c, (tx) => writeToPerson(tx, c.orgId, c.ownerId, rosa.contactId))).toMatchObject({
      conversationId: rosa.conversationId,
      created: false,
      identityCreated: false,
    })
  })
})

describe("buscar por teléfono", () => {
  it("la Bandeja y la lista de personas encuentran por los dígitos del número", async () => {
    const c = await clinic()
    const rosa = await person(c, "Rosa Quispe", { openWindow: true, phone: "51987654100" })
    await ownerDb.update(contact).set({ phone: "+51987654100" }).where(eq(contact.id, rosa.contactId))
    await person(c, "Ana Torres", { openWindow: true, phone: "51911222333" })
    const found = await run(c, (tx) => listConversations(tx, c.orgId, { q: "987 654" }))
    expect(found.items.map((item) => item.contact.displayName)).toEqual(["Rosa Quispe"])
    expect((await run(c, (tx) => listConversations(tx, c.orgId, { q: "Ana" }))).items.map((item) => item.contact.displayName)).toEqual(["Ana Torres"])
    const people = await run(c, (tx) => listContacts(tx, c.orgId, { q: "987-654" }))
    expect(people.items.map((item) => item.displayName)).toEqual(["Rosa Quispe"])
  })
})

describe("«Contexto» de la conversación", () => {
  it("trae la próxima cita a quien ve la agenda y lo que aceptó recibir", async () => {
    const c = await clinic()
    const rosa = await person(c, "Rosa Quispe", { consent: ["recordatorio"], openWindow: true })
    await book(c, rosa.patientId, later(5 * DAY), { notice: false })
    const next = await book(c, rosa.patientId, later(2 * DAY), { notice: false })
    const caps = { conversations: true, tasks: true, agent: false }
    const seen = await run(c, (tx) => getContactWorkspace(tx, c.orgId, rosa.contactId, { capabilities: { ...caps, appointments: true } }))
    expect(seen.nextAppointment).toMatchObject({ id: next.id, patientName: "Rosa Quispe", branchName: "Centro", professionalName: "Dra. Ana Torres", timeZone: "America/Lima" })
    expect(seen.messages).toEqual({ recordatorio: true, seguimiento: null, novedades: null, avisos: null })
    const blind = await run(c, (tx) => getContactWorkspace(tx, c.orgId, rosa.contactId, { capabilities: caps }))
    expect(blind.nextAppointment).toBeNull()
  })
})

/**
 * Reportes › Agente: lo pagado son las mismas cuentas de la factura de
 * odentIA (ADR 0031); lo cobrado en sus citas son los pagos de esas citas, sin
 * contar dos veces la que además fue recuperada; las conversaciones y la
 * primera respuesta siguen la regla de la antigua «Atención».
 */
import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { agentHandoff } from "@odentia/db/schema/agent"
import { appointment, scheduleChair } from "@odentia/db/schema/agenda"
import { user } from "@odentia/db/schema/auth"
import { automationJob } from "@odentia/db/schema/automation"
import {
  encounter,
  encounterProcedure,
  patientCharge,
  patientContact,
  patientPayment,
  patientPaymentApplication,
  patientPaymentRefund,
} from "@odentia/db/schema/clinical"
import { channelConnection, contact, conversation, message } from "@odentia/db/schema/crm"
import { branch } from "@odentia/db/schema/org"
import { saasAction, saasCharge, saasChargeLine, saasPlan, saasSubscription } from "@odentia/db/schema/saas-billing"
import { and, asc, eq, sql } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { nextPatientNumber } from "./patients.js"
import {
  agentBillingMany,
  agentBookedMany,
  agentCollectedMany,
  agentConversationsMany,
  agentHandoffsMany,
  agentRecoveredMany,
  firstResponsesMany,
  getAgentReportList,
  getReportAgent,
} from "./report-agent.js"
import { agentBookingsMany, getReportSummary } from "./report-summary.js"
import { countRecoveredAppointment } from "./saas-actions.js"
import { createSaasPlan } from "./saas-billing.js"
import { closeSaasPeriods } from "./saas-invoicing.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"
import { insertTestPatients } from "./test-patient.js"

setupTestDb()

let planId: string

beforeAll(async () => {
  const admin = "agent-report-admin"
  await ownerDb.insert(user).values({ id: admin, name: "Administración", email: "admin@agent-report.test" })
  await ownerDb.update(saasPlan).set({ isDefault: false })
  const plan = await createSaasPlan(ownerDb, admin, {
    code: "agent-report-odentia",
    name: "Plan odentIA",
    currency: "USD",
    priceCents: 2900,
    creditCents: 2900,
    conversationMicros: 500_000,
    consultationMicros: 400_000,
    recoveryMicros: 4_000_000,
    trialCreditCents: 5000,
    trialMaxCreditCents: 13000,
    isDefault: true,
  })
  planId = plan.id
})

const day = (iso: string): Date => new Date(iso)
/** Meses de Lima: empiezan a las 05:00 en UTC. */
const OCTOBER = { start: day("2026-10-01T05:00:00Z"), end: day("2026-11-01T05:00:00Z") }
const NOVEMBER = { start: OCTOBER.end, end: day("2026-12-01T05:00:00Z") }
const SEPTEMBER = { start: day("2026-09-01T05:00:00Z"), end: OCTOBER.start }

async function clinic(subscription?: { start: Date; end: Date }) {
  const orgId = `agt-${randomUUID().slice(0, 8)}`
  await insertOrg(ownerDb, orgId, orgId)
  if (subscription) {
    const values = { status: "activa", planId, activatedAt: subscription.start, currentPeriodStart: subscription.start, currentPeriodEnd: subscription.end, billingCycle: "mensual" }
    await ownerDb.insert(saasSubscription).values({ organizationId: orgId, ...values }).onConflictDoUpdate({ target: saasSubscription.organizationId, set: values })
  }
  const dentist = randomUUID()
  await ownerDb.insert(user).values({ id: dentist, name: "Dra. Ana Torres", email: `${dentist}@agent-report.test` })
  const [site] = await ownerDb.insert(branch).values({ organizationId: orgId, name: "Centro" }).returning()
  const [chair] = await ownerDb.insert(scheduleChair).values({ organizationId: orgId, branchId: site!.id, name: "Unidad dental 1" }).returning()
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  return { orgId, dentist, branchId: site!.id, chairId: chair!.id, run }
}
type Clinic = Awaited<ReturnType<typeof clinic>>

async function person(c: Clinic, name: string) {
  const [created] = await insertTestPatients(ownerDb, { organizationId: c.orgId, displayName: name, patientNumber: await nextPatientNumber(ownerDb, c.orgId) })
  const [self] = await ownerDb
    .select({ contactId: patientContact.contactId })
    .from(patientContact)
    .where(and(eq(patientContact.patientId, created!.id), eq(patientContact.relationship, "self")))
  return { patientId: created!.id, contactId: self!.contactId }
}

async function visit(c: Clinic, patientId: string, input: { source: string; bookedAt: Date; startsAt: Date; status: string }) {
  const [row] = await ownerDb
    .insert(appointment)
    .values({
      organizationId: c.orgId,
      branchId: c.branchId,
      chairId: c.chairId,
      dentistUserId: c.dentist,
      patientId,
      serviceName: "Limpieza dental",
      startsAt: input.startsAt,
      endsAt: new Date(input.startsAt.getTime() + 30 * 60_000),
      durationMin: 30,
      status: input.status,
      source: input.source,
      createdAt: input.bookedAt,
    })
    .returning()
  return row!
}

/** La atención cerrada de una cita con su cargo y lo que se pagó de él (y lo devuelto de ese pago). */
async function charged(c: Clinic, visitRow: Awaited<ReturnType<typeof visit>>, input: { cents: number; paid: number; refunded?: number }) {
  const endedAt = visitRow.endsAt
  const [session] = await ownerDb
    .insert(encounter)
    .values({
      organizationId: c.orgId,
      patientId: visitRow.patientId,
      branchId: c.branchId,
      dentistUserId: c.dentist,
      appointmentId: visitRow.id,
      reason: "Limpieza dental",
      evolution: "Sin complicaciones.",
      startedAt: visitRow.startsAt,
      signerName: "Ana Torres",
      signerTitle: "Cirujano dentista",
      signerRegistration: "12345",
    })
    .returning()
  const [procedure] = await ownerDb
    .insert(encounterProcedure)
    .values({ organizationId: c.orgId, encounterId: session!.id, description: "Limpieza dental", quantity: 1, priceCents: input.cents, currency: "PEN", createdBy: c.dentist, createdAt: endedAt })
    .returning()
  await ownerDb.execute(sql`
    update encounter set status = 'finalizada', ended_at = ${endedAt.toISOString()}::timestamptz, finalized_at = ${endedAt.toISOString()}::timestamptz, finalized_by = dentist_user_id
    where id = ${session!.id}`)
  const [charge] = await ownerDb
    .insert(patientCharge)
    .values({ organizationId: c.orgId, patientId: visitRow.patientId, encounterProcedureId: procedure!.id, branchId: c.branchId, description: "Limpieza dental", amountCents: input.cents, currency: "PEN", createdBy: c.dentist, createdAt: endedAt })
    .returning()
  const [payment] = await ownerDb
    .insert(patientPayment)
    .values({ organizationId: c.orgId, patientId: visitRow.patientId, branchId: c.branchId, amountCents: input.paid, currency: "PEN", paidAt: endedAt, methodName: "Efectivo" })
    .returning()
  await ownerDb.insert(patientPaymentApplication).values({ organizationId: c.orgId, patientId: visitRow.patientId, paymentId: payment!.id, chargeId: charge!.id, amountCents: input.paid, createdAt: endedAt })
  if (input.refunded) {
    await ownerDb
      .insert(patientPaymentRefund)
      .values({ organizationId: c.orgId, patientId: visitRow.patientId, paymentId: payment!.id, amountCents: input.refunded, refundedAt: new Date(endedAt.getTime() + 86_400_000), reason: "Devolución" })
  }
}

async function filler(orgId: string, count: number, from: Date, everyHours = 1) {
  for (let index = 0; index < count; index++) {
    await ownerDb.insert(saasAction).values({
      organizationId: orgId,
      kind: "conversacion",
      occurredAt: new Date(from.getTime() + index * everyHours * 3_600_000),
      contactId: randomUUID(),
      detail: "Atendió una conversación por WhatsApp",
      currency: "USD",
      basePriceMicros: 500_000,
      priceMicros: 500_000,
      discountBps: 0,
      dedupeKey: randomUUID(),
    })
  }
}

const chargesOf = (orgId: string) =>
  ownerDb.select().from(saasCharge).where(eq(saasCharge.organizationId, orgId)).orderBy(asc(saasCharge.periodEnd), asc(saasCharge.createdAt))
const cuotaOf = async (chargeId: string) =>
  (await ownerDb.select().from(saasChargeLine).where(and(eq(saasChargeLine.chargeId, chargeId), eq(saasChargeLine.kind, "cuota"))))[0]?.amountCents ?? 0

describe("lo que pagaste por el agente", () => {
  it("es la factura del mes: lo que pasó del crédito más el crédito del plan, con la devolución de la cita recuperada", async () => {
    const c = await clinic(OCTOBER)
    const rosa = await person(c, "Rosa Quispe")
    // El Administrador le escribe en octubre, ella conversa con Recepción y el agente le reserva para noviembre.
    await ownerDb.insert(automationJob).values({
      organizationId: c.orgId,
      kind: "seguimiento_presupuesto",
      status: "enviado",
      dedupeKey: randomUUID(),
      scheduledFor: day("2026-10-27T15:00:00Z"),
      contactId: rosa.contactId,
      updatedAt: day("2026-10-27T15:00:00Z"),
    })
    await ownerDb.insert(saasAction).values({
      organizationId: c.orgId,
      kind: "conversacion",
      occurredAt: day("2026-10-28T15:00:00Z"),
      contactId: rosa.contactId,
      detail: "Atendió una conversación por WhatsApp",
      currency: "USD",
      basePriceMicros: 500_000,
      priceMicros: 500_000,
      discountBps: 0,
      dedupeKey: randomUUID(),
    })
    const booked = await visit(c, rosa.patientId, { source: "agent", bookedAt: day("2026-10-28T15:10:00Z"), startsAt: day("2026-11-04T15:00:00Z"), status: "programada" })
    // Octubre se cierra: solo la cuota; la conversación la cubre el crédito.
    await closeSaasPeriods(ownerDb, day("2026-11-01T06:00:00Z"))
    // Noviembre: 58 conversaciones agotan justo el crédito; Rosa asiste el 4.
    await filler(c.orgId, 58, day("2026-11-02T12:00:00Z"))
    await ownerDb.update(appointment).set({ status: "atendida" }).where(eq(appointment.id, booked.id))
    expect(await countRecoveredAppointment(ownerDb, c.orgId, booked.id, day("2026-11-05T16:00:00Z"))).toBe(true)
    await closeSaasPeriods(ownerDb, day("2026-12-01T06:00:00Z"))
    const [october, november] = await chargesOf(c.orgId)

    const [inOctober, inNovember] = await c.run((tx) => agentBillingMany(tx, c.orgId, [OCTOBER, NOVEMBER], day("2026-12-05T12:00:00Z")))
    // Noviembre pasó del crédito: lo pagado es la factura sin impuesto (cuota + cita − devolución).
    expect(november).toMatchObject({ subtotalCents: 3250 })
    expect(inNovember).toMatchObject({
      currency: "USD",
      totalCents: november!.subtotalCents,
      coveredCents: 2900,
      overCents: (november!.subtotalCents ?? 0) - (await cuotaOf(november!.id)),
      refunds: { count: 1, amountCents: 50 },
    })
    expect(inNovember?.lines).toEqual([
      { kind: "conversacion", count: 58, unitMicros: 500_000, amountCents: 2900 },
      { kind: "consulta", count: 0, unitMicros: null, amountCents: 0 },
      { kind: "cita", count: 1, unitMicros: 4_000_000, amountCents: 400 },
    ])
    // Octubre no pasó del crédito: la factura es solo la cuota y la conversación la cubrió el crédito.
    expect(inOctober).toMatchObject({ totalCents: 50, coveredCents: 50, overCents: (october!.subtotalCents ?? 0) - (await cuotaOf(october!.id)) })
    expect(inOctober?.overCents).toBe(0)

    // La pestaña entera da lo mismo para el mes de la factura, y no lo entrega a quien no ve Facturación.
    const report = await c.run((tx) => getReportAgent(tx, c.orgId, { period: "2026-11" }, day("2026-12-05T12:00:00Z"), { billing: true }))
    expect(report.paid).toMatchObject({ totalCents: november!.subtotalCents, planCreditCents: 2900, tax: { label: "IGV", rateBps: 1800 } })
    expect(report.recovered.current).toBe(1)
    const hidden = await c.run((tx) => getReportAgent(tx, c.orgId, { period: "2026-11" }, day("2026-12-05T12:00:00Z")))
    expect(hidden.paid).toBeNull()
  })

  it("un mes calendario que cruza dos tramos toma cada acción con el estado de su tramo", async () => {
    // El plan se activó el 15 de octubre: el crédito de cada tramo se gasta en su orden.
    const start = day("2026-10-15T05:00:00Z")
    const c = await clinic({ start, end: day("2026-11-15T05:00:00Z") })
    // Una conversación cada 12 horas hasta el 14 de noviembre: las 58 primeras llenan el crédito.
    await filler(c.orgId, 60, day("2026-10-15T06:00:00Z"), 12)
    await closeSaasPeriods(ownerDb, day("2026-11-15T06:00:00Z"))
    const [first] = await chargesOf(c.orgId)
    const [tramo, november] = await c.run((tx) =>
      agentBillingMany(tx, c.orgId, [{ start, end: day("2026-11-15T05:00:00Z") }, NOVEMBER], day("2026-11-20T12:00:00Z")),
    )
    expect(first).toMatchObject({ subtotalCents: 3000 })
    expect(tramo).toMatchObject({ totalCents: 3000, coveredCents: 2900, overCents: (first!.subtotalCents ?? 0) - (await cuotaOf(first!.id)) })
    // Noviembre (desde el 1) toma las 26 últimas: 24 dentro del crédito del tramo y las 2 que pasaron.
    expect(november).toMatchObject({ totalCents: 1300, coveredCents: 1200, overCents: 100 })
    expect(november?.lines[0]?.count).toBe(26)
  })
})

describe("lo que hizo el agente y lo cobrado en sus citas", () => {
  it("cuenta lo que agendó, lo recuperado y lo cobrado en esas citas, cada cita una vez", async () => {
    const c = await clinic()
    const ana = await person(c, "Ana Paz")
    const bruno = await person(c, "Bruno Díaz")
    const carla = await person(c, "Carla Soto")
    const diego = await person(c, "Diego Ruiz")
    const elena = await person(c, "Elena Mora")
    // Agendó el agente y vino: pagó 200 y se le devolvieron 50.
    const a = await visit(c, ana.patientId, { source: "agent", bookedAt: day("2026-09-03T15:00:00Z"), startsAt: day("2026-09-10T15:00:00Z"), status: "atendida" })
    await charged(c, a, { cents: 20_000, paid: 20_000, refunded: 5_000 })
    // Desde su enlace: pagó 60 de 100.
    const b = await visit(c, bruno.patientId, { source: "enlace", bookedAt: day("2026-09-05T15:00:00Z"), startsAt: day("2026-09-12T15:00:00Z"), status: "atendida" })
    await charged(c, b, { cents: 10_000, paid: 6_000 })
    // La agendó recepción: no es del agente.
    const r = await visit(c, carla.patientId, { source: "recepcion", bookedAt: day("2026-09-04T15:00:00Z"), startsAt: day("2026-09-11T15:00:00Z"), status: "atendida" })
    await charged(c, r, { cents: 50_000, paid: 50_000 })
    // Reservada en agosto por el agente y recuperada en septiembre: va en su línea.
    const d = await visit(c, diego.patientId, { source: "agent", bookedAt: day("2026-08-28T15:00:00Z"), startsAt: day("2026-09-15T15:00:00Z"), status: "atendida" })
    await charged(c, d, { cents: 30_000, paid: 30_000 })
    await ownerDb.insert(saasAction).values({
      organizationId: c.orgId,
      kind: "cita",
      occurredAt: day("2026-09-15T16:00:00Z"),
      contactId: diego.contactId,
      appointmentId: d.id,
      channel: "agent",
      windowStart: day("2026-08-26T15:00:00Z"),
      detail: "Volvió tras «Retomar un presupuesto» y reservó en la conversación",
      dedupeKey: `cita:${d.id}`,
    })
    // Agendada por el agente y aún por venir.
    await visit(c, elena.patientId, { source: "agent", bookedAt: day("2026-09-20T15:00:00Z"), startsAt: day("2026-10-20T15:00:00Z"), status: "programada" })

    const [booked] = await c.run((tx) => agentBookedMany(tx, c.orgId, undefined, [SEPTEMBER]))
    expect(booked).toEqual({ booked: 3, attended: 2, all: 4 })
    expect(await c.run((tx) => agentRecoveredMany(tx, c.orgId, undefined, [SEPTEMBER]))).toEqual([1])
    const [collected] = await c.run((tx) => agentCollectedMany(tx, c.orgId, undefined, [SEPTEMBER]))
    expect(collected).toEqual({
      booked: { visits: 2, byCurrency: [{ currency: "PEN", cents: 21_000 }] },
      recovered: { visits: 1, byCurrency: [{ currency: "PEN", cents: 30_000 }] },
    })
    // El Resumen dice lo mismo junto a «Citas que agendó el agente».
    expect(await c.run((tx) => agentBookingsMany(tx, c.orgId, undefined, [SEPTEMBER]))).toEqual([{ booked: 3, recovered: 1 }])
    const summary = await c.run((tx) => getReportSummary(tx, c.orgId, { period: "2026-09" }, day("2026-10-05T12:00:00Z")))
    expect(summary.agent.current).toEqual({ booked: 3, recovered: 1, collectedCents: 51_000 })
    // Si se deshace la asistencia de la recuperada, el cobro la anula y aquí deja de contar.
    await ownerDb.update(appointment).set({ status: "programada" }).where(eq(appointment.id, d.id))
    expect(await c.run((tx) => agentRecoveredMany(tx, c.orgId, undefined, [SEPTEMBER]))).toEqual([0])
    await ownerDb.update(appointment).set({ status: "atendida" }).where(eq(appointment.id, d.id))

    // «Ver cuáles»: las tres que agendó en septiembre, con lo pagado en cada una.
    const list = await c.run((tx) => getAgentReportList(tx, c.orgId, { period: "2026-09", list: "agent_booked" }, day("2026-10-05T12:00:00Z")))
    expect(list.total).toBe(3)
    expect(Object.fromEntries(list.rows.map((row) => [row.personName, row.cents]))).toEqual({ "Ana Paz": 15_000, "Bruno Díaz": 6_000, "Elena Mora": null })
    // Otra sede no tiene sus citas.
    const [elsewhere] = await ownerDb.insert(branch).values({ organizationId: c.orgId, name: "Norte" }).returning()
    expect(await c.run((tx) => agentBookedMany(tx, c.orgId, elsewhere!.id, [SEPTEMBER]))).toEqual([{ booked: 0, attended: 0, all: 0 }])
  })

  it("conversaciones que atendió, las que pasó al equipo y quién respondió primero", async () => {
    const c = await clinic()
    const [channel] = await ownerDb
      .insert(channelConnection)
      .values({ organizationId: c.orgId, channel: "whatsapp", provider: "prueba", displayName: "Canal controlado", configEncrypted: "no-se-usa", webhookSecret: "no-se-usa" })
      .returning()
    const thread = async (name: string, inboundAt: Date, replies: Array<{ by: "agent" | "user"; seconds: number; mock?: boolean }>) => {
      const [who] = await ownerDb.insert(contact).values({ organizationId: c.orgId, displayName: name }).returning()
      const [conv] = await ownerDb
        .insert(conversation)
        .values({ organizationId: c.orgId, contactId: who!.id, channelConnectionId: channel!.id, externalThreadId: randomUUID() })
        .returning()
      await ownerDb.insert(message).values({ organizationId: c.orgId, conversationId: conv!.id, direction: "in", senderKind: "contact", status: "received", createdAt: inboundAt })
      for (const reply of replies) {
        const sentAt = new Date(inboundAt.getTime() + reply.seconds * 1000)
        await ownerDb.insert(message).values({
          organizationId: c.orgId,
          conversationId: conv!.id,
          direction: "out",
          senderKind: reply.by,
          status: "sent",
          externalId: `${reply.mock ? "mock" : "proveedor"}-${randomUUID()}`,
          createdAt: sentAt,
          sentAt,
        })
      }
      return conv!.id
    }
    await thread("Solo con el agente", day("2026-09-02T15:00:00Z"), [{ by: "agent", seconds: 60 }])
    const passed = await thread("Pasó al equipo", day("2026-09-03T15:00:00Z"), [
      { by: "agent", seconds: 120 },
      { by: "user", seconds: 900 },
    ])
    await ownerDb.insert(agentHandoff).values({ organizationId: c.orgId, conversationId: passed, reason: "Pide una persona", summary: "Pide una persona", createdAt: day("2026-09-03T15:03:00Z") })
    await thread("Respondió el equipo", day("2026-09-04T15:00:00Z"), [{ by: "user", seconds: 600 }])
    await thread("Sin respuesta", day("2026-09-05T15:00:00Z"), [])
    // Un envío de prueba no es una respuesta.
    await thread("Envío de prueba", day("2026-09-06T15:00:00Z"), [{ by: "agent", seconds: 30, mock: true }])

    expect(await c.run((tx) => agentConversationsMany(tx, c.orgId, [SEPTEMBER]))).toEqual([{ attended: 2, alone: 1 }])
    expect(await c.run((tx) => agentHandoffsMany(tx, c.orgId, [SEPTEMBER]))).toEqual([1])
    const [first] = await c.run((tx) => firstResponsesMany(tx, c.orgId, [SEPTEMBER]))
    expect(first).toEqual({ conversations: 5, responded: 3, byAgent: 2, byTeam: 1, agentMedianSeconds: 90, teamMedianSeconds: 600 })

    // «Ver cuáles»: la conversación que pasó, con su motivo; quien escribió aún no es paciente.
    const list = await c.run((tx) => getAgentReportList(tx, c.orgId, { period: "2026-09", list: "agent_handoffs" }, day("2026-10-05T12:00:00Z")))
    expect(list.total).toBe(1)
    expect(list.rows[0]).toMatchObject({ personName: "Pasó al equipo", title: "Pide una persona", conversationId: passed, patientId: null })
  })
})

import { randomUUID } from "node:crypto"
import { appointment, scheduleRoom } from "@odentia/db/schema/agenda"
import { user } from "@odentia/db/schema/auth"
import { automationJob } from "@odentia/db/schema/automation"
import { patientContact } from "@odentia/db/schema/clinical"
import { branch } from "@odentia/db/schema/org"
import { saasAction, saasCharge, saasChargeLine, saasPlan, saasSubscription } from "@odentia/db/schema/saas-billing"
import { and, asc, eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { nextPatientNumber } from "./patients.js"
import { countRecoveredAppointment, listPeriodActions } from "./saas-actions.js"
import { createSaasPlan } from "./saas-billing.js"
import { closeSaasPeriods } from "./saas-invoicing.js"
import { insertOrg, ownerDb, setupTestDb } from "./test-setup.js"
import { insertTestPatients } from "./test-patient.js"

/**
 * La conversación que llevó a una cita recuperada se cobra en su tramo y, si
 * la persona asiste, la cita la devuelve (ADR 0031): nunca se cobran las dos.
 */
setupTestDb()
const DAY = 86_400_000
let planId: string

beforeAll(async () => {
  const admin = "recovery-admin"
  await ownerDb.insert(user).values({ id: admin, name: "Administración", email: "admin@recovery.test" })
  await ownerDb.update(saasPlan).set({ isDefault: false })
  const plan = await createSaasPlan(ownerDb, admin, {
    code: "recovery-odentia",
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

async function clinic(start: Date, end: Date, billingCycle: "mensual" | "quincenal" = "mensual") {
  const orgId = `rec-${randomUUID().slice(0, 8)}`
  await insertOrg(ownerDb, orgId, orgId)
  const values = { status: "activa", planId, activatedAt: start, currentPeriodStart: start, currentPeriodEnd: end, billingCycle }
  await ownerDb.insert(saasSubscription).values({ organizationId: orgId, ...values }).onConflictDoUpdate({ target: saasSubscription.organizationId, set: values })
  return orgId
}

/**
 * El Administrador le escribe, la persona conversa con Recepción y el agente
 * le reserva una cita: la escena de una cita recuperada, aún por venir.
 */
async function recovery(orgId: string, input: { sentAt: Date; talkedAt: Date; bookedAt: Date; startsAt: Date }) {
  const professional = randomUUID()
  await ownerDb.insert(user).values({ id: professional, name: "Odontóloga", email: `${professional}@recovery.test` })
  const [person] = await insertTestPatients(ownerDb, { organizationId: orgId, displayName: "Rosa Quispe", patientNumber: await nextPatientNumber(ownerDb, orgId) })
  const [self] = await ownerDb
    .select({ contactId: patientContact.contactId })
    .from(patientContact)
    .where(and(eq(patientContact.patientId, person!.id), eq(patientContact.relationship, "self")))
  const contactId = self!.contactId
  const [site] = await ownerDb.insert(branch).values({ organizationId: orgId, name: `Sede ${randomUUID().slice(0, 6)}` }).returning()
  const [room] = await ownerDb.insert(scheduleRoom).values({ organizationId: orgId, branchId: site!.id, name: "Unidad dental" }).returning()
  await ownerDb.insert(automationJob).values({
    organizationId: orgId,
    kind: "seguimiento_presupuesto",
    status: "enviado",
    dedupeKey: randomUUID(),
    scheduledFor: input.sentAt,
    contactId,
    updatedAt: input.sentAt,
  })
  const [conversation] = await ownerDb
    .insert(saasAction)
    .values({
      organizationId: orgId,
      kind: "conversacion",
      tier: "gestiona",
      occurredAt: input.talkedAt,
      contactId,
      detail: "Atendió una conversación por WhatsApp",
      currency: "USD",
      basePriceMicros: 500_000,
      priceMicros: 500_000,
      discountBps: 0,
      dedupeKey: randomUUID(),
    })
    .returning()
  const [appt] = await ownerDb
    .insert(appointment)
    .values({
      organizationId: orgId,
      branchId: site!.id,
      roomId: room!.id,
      professionalUserId: professional,
      patientId: person!.id,
      startsAt: input.startsAt,
      endsAt: new Date(input.startsAt.getTime() + 30 * 60_000),
      durationMin: 30,
      status: "programada",
      source: "agent",
      createdAt: input.bookedAt,
    })
    .returning()
  return { orgId, conversationId: conversation!.id, appointmentId: appt!.id }
}

/** La persona asiste: la cita queda atendida y se cuenta como recuperada. */
async function attend(scene: Awaited<ReturnType<typeof recovery>>, at: Date) {
  await ownerDb.update(appointment).set({ status: "atendida" }).where(eq(appointment.id, scene.appointmentId))
  expect(await countRecoveredAppointment(ownerDb, scene.orgId, scene.appointmentId, at)).toBe(true)
}

async function filler(orgId: string, count: number, from: Date) {
  for (let index = 0; index < count; index++) {
    await ownerDb.insert(saasAction).values({
      organizationId: orgId,
      kind: "conversacion",
      tier: "gestiona",
      occurredAt: new Date(from.getTime() + index * 3_600_000),
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
const linesOf = async (chargeId: string) =>
  (await ownerDb.select().from(saasChargeLine).where(eq(saasChargeLine.chargeId, chargeId)).orderBy(asc(saasChargeLine.sortOrder))).map(
    (line) => [line.kind, line.quantity, line.amountCents],
  )
const chargeOfAction = async (id: string) =>
  (await ownerDb.select({ chargeId: saasAction.chargeId }).from(saasAction).where(eq(saasAction.id, id)))[0]?.chargeId ?? null

const october = { start: new Date("2026-10-01T12:00:00Z"), end: new Date("2026-11-01T12:00:00Z") }
const november = { start: october.end, end: new Date("2026-12-01T12:00:00Z") }
const rosa = {
  sentAt: new Date("2026-10-27T15:00:00Z"),
  talkedAt: new Date("2026-10-28T15:00:00Z"),
  bookedAt: new Date("2026-10-28T15:10:00Z"),
  startsAt: new Date("2026-11-04T15:00:00Z"),
}
const tax = (cents: number) => Math.round(cents * 0.18)

describe("conversación de una cita recuperada", () => {
  it("se cobra en su mes y, si la persona asiste el mes siguiente, la cita la devuelve una sola vez", async () => {
    const orgId = await clinic(october.start, october.end)
    const scene = await recovery(orgId, rosa)
    // Al cerrar octubre la conversación se cobra como cualquiera (la cubre el crédito).
    await closeSaasPeriods(ownerDb, new Date("2026-11-01T13:00:00Z"))
    const [first] = await chargesOf(orgId)
    expect(await linesOf(first!.id)).toEqual([
      ["cuota", 1, 2900],
      ["credito", 1, 0],
      ["impuesto", 1, tax(2900)],
    ])
    expect(await chargeOfAction(scene.conversationId)).toBe(first!.id)
    // En noviembre 58 conversaciones agotan el crédito; Rosa asiste el 4.
    await filler(orgId, 58, new Date("2026-11-02T12:00:00Z"))
    await attend(scene, new Date("2026-11-05T16:00:00Z"))
    const listed = await listPeriodActions(ownerDb, orgId, { ...november, credit: "mes", creditCents: 2900 })
    const cita = listed.find((row) => row.kind === "cita")
    expect(cita).toMatchObject({ state: "sobre_credito", refunds: [{ actionId: scene.conversationId, priceMicros: 500_000 }] })
    await closeSaasPeriods(ownerDb, new Date("2026-12-01T13:00:00Z"))
    const charges = await chargesOf(orgId)
    // La cita USD 4 y la devolución de su conversación de octubre: neto USD 3,50.
    expect(await linesOf(charges[1]!.id)).toEqual([
      ["cuota", 1, 2900],
      ["cita", 1, 400],
      ["devolucion", 1, -50],
      ["credito", 58, 0],
      ["impuesto", 1, tax(2900 + 350)],
    ])
    expect(charges[1]).toMatchObject({ subtotalCents: 3250 })
    // Diciembre no la vuelve a devolver.
    await closeSaasPeriods(ownerDb, new Date("2027-01-01T13:00:00Z"))
    expect(await linesOf((await chargesOf(orgId))[2]!.id)).toEqual([
      ["cuota", 1, 2900],
      ["impuesto", 1, tax(2900)],
    ])
  })

  it("dentro del crédito, la devolución vuelve como crédito: la cita gasta su precio menos la conversación", async () => {
    const orgId = await clinic(october.start, october.end)
    const scene = await recovery(orgId, rosa)
    await closeSaasPeriods(ownerDb, new Date("2026-11-01T13:00:00Z"))
    // 51 conversaciones (USD 25,50) más la cita neta (USD 3,50) llenan justo los USD 29.
    await filler(orgId, 51, new Date("2026-11-02T12:00:00Z"))
    await attend(scene, new Date("2026-11-05T16:00:00Z"))
    const listed = await listPeriodActions(ownerDb, orgId, { ...november, credit: "mes", creditCents: 2900 })
    expect(listed.every((row) => row.state === "credito")).toBe(true)
    await closeSaasPeriods(ownerDb, new Date("2026-12-01T13:00:00Z"))
    const charges = await chargesOf(orgId)
    expect(await linesOf(charges[1]!.id)).toEqual([
      ["cuota", 1, 2900],
      ["credito", 52, 0],
      ["impuesto", 1, tax(2900)],
    ])
  })

  it("si la cita no se da o se deshace la asistencia, no hay devolución", async () => {
    const orgId = await clinic(october.start, october.end)
    const cancelled = await recovery(orgId, rosa)
    const undone = await recovery(orgId, rosa)
    await closeSaasPeriods(ownerDb, new Date("2026-11-01T13:00:00Z"))
    await ownerDb.update(appointment).set({ status: "cancelada" }).where(eq(appointment.id, cancelled.appointmentId))
    await attend(undone, new Date("2026-11-05T16:00:00Z"))
    await ownerDb.update(appointment).set({ status: "programada" }).where(eq(appointment.id, undone.appointmentId))
    const listed = await listPeriodActions(ownerDb, orgId, { ...november, credit: "mes", creditCents: 2900 })
    expect(listed.map((row) => [row.kind, row.state, row.refunds.length])).toEqual([["cita", "anulada", 0]])
    await closeSaasPeriods(ownerDb, new Date("2026-12-01T13:00:00Z"))
    expect(await linesOf((await chargesOf(orgId))[1]!.id)).toEqual([
      ["cuota", 1, 2900],
      ["impuesto", 1, tax(2900)],
    ])
    expect(await chargeOfAction(cancelled.conversationId)).toBe((await chargesOf(orgId))[0]!.id)
  })

  it("en el mismo mes y aún sin cobrar, la conversación va dentro de la cita", async () => {
    const orgId = await clinic(october.start, october.end)
    const scene = await recovery(orgId, { ...rosa, startsAt: new Date("2026-10-30T15:00:00Z") })
    await attend(scene, new Date("2026-10-30T16:00:00Z"))
    const listed = await listPeriodActions(ownerDb, orgId, { ...october, credit: "mes", creditCents: 2900 })
    expect(listed.map((row) => [row.kind, row.state, row.refunds.length])).toEqual([
      ["conversacion", "dentro_de_cita", 0],
      ["cita", "credito", 0],
    ])
  })

  it("quincenal: cobrada a mitad del tramo, la cita del cierre la devuelve", async () => {
    const start = new Date("2026-08-01T12:00:00Z")
    const orgId = await clinic(start, new Date("2026-09-01T12:00:00Z"), "quincenal")
    // 58 conversaciones a USD 0,50 agotan el crédito de USD 29.
    await filler(orgId, 58, new Date("2026-08-02T12:00:00Z"))
    const scene = await recovery(orgId, {
      sentAt: new Date("2026-08-09T15:00:00Z"),
      talkedAt: new Date("2026-08-10T15:00:00Z"),
      bookedAt: new Date("2026-08-10T15:10:00Z"),
      startsAt: new Date("2026-08-20T15:00:00Z"),
    })
    await closeSaasPeriods(ownerDb, new Date("2026-08-16T13:00:00Z"))
    const [half] = await chargesOf(orgId)
    expect(await linesOf(half!.id)).toEqual([
      ["conversacion", 1, 50],
      ["credito", 58, 0],
      ["impuesto", 1, tax(50)],
    ])
    await attend(scene, new Date("2026-08-20T16:00:00Z"))
    await closeSaasPeriods(ownerDb, new Date("2026-09-01T13:00:00Z"))
    const final = (await chargesOf(orgId))[1]!
    expect(await linesOf(final.id)).toEqual([
      ["cuota", 1, 2900],
      ["cita", 1, 400],
      ["devolucion", 1, -50],
      ["impuesto", 1, tax(2900 + 350)],
    ])
  })
})

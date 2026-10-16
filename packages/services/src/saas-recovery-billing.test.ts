import { randomUUID } from "node:crypto"
import { appointment, scheduleChair } from "@odentia/db/schema/agenda"
import { user } from "@odentia/db/schema/auth"
import { automationJob } from "@odentia/db/schema/automation"
import { patient, patientContact } from "@odentia/db/schema/clinical"
import { branch } from "@odentia/db/schema/org"
import { saasAction, saasCharge, saasChargeLine, saasPlan, saasSubscription } from "@odentia/db/schema/saas-billing"
import { and, asc, eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { nextPatientNumber } from "./patients.js"
import { countRecoveredAppointment, listPeriodActions } from "./saas-actions.js"
import { createSaasPlan } from "./saas-billing.js"
import { closeSaasPeriods } from "./saas-invoicing.js"
import { insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/**
 * La conversación que llevó a una cita recuperada va dentro de la cita aunque
 * la cita se cuente en otro tramo (ADR 0031): nunca se cobran las dos.
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
  const dentist = randomUUID()
  await ownerDb.insert(user).values({ id: dentist, name: "Odontóloga", email: `${dentist}@recovery.test` })
  const [person] = await ownerDb
    .insert(patient)
    .values({ organizationId: orgId, displayName: "Rosa Quispe", patientNumber: await nextPatientNumber(ownerDb, orgId) })
    .returning()
  const [self] = await ownerDb
    .select({ contactId: patientContact.contactId })
    .from(patientContact)
    .where(and(eq(patientContact.patientId, person!.id), eq(patientContact.relationship, "self")))
  const contactId = self!.contactId
  const [site] = await ownerDb.insert(branch).values({ organizationId: orgId, name: `Sede ${randomUUID().slice(0, 6)}` }).returning()
  const [chair] = await ownerDb.insert(scheduleChair).values({ organizationId: orgId, branchId: site!.id, name: "Sillón" }).returning()
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
      chairId: chair!.id,
      dentistUserId: dentist,
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

describe("conversación de una cita recuperada que cruza el cierre", () => {
  it("cierre del mes: la conversación espera y, si asiste, va dentro de la cita del mes siguiente", async () => {
    const start = new Date("2026-10-01T12:00:00Z")
    const end = new Date("2026-11-01T12:00:00Z")
    const orgId = await clinic(start, end)
    const scene = await recovery(orgId, {
      sentAt: new Date("2026-10-27T15:00:00Z"),
      talkedAt: new Date("2026-10-28T15:00:00Z"),
      bookedAt: new Date("2026-10-28T15:10:00Z"),
      startsAt: new Date("2026-11-04T15:00:00Z"),
    })
    // Al cerrar octubre la cita sigue por venir: la conversación espera y no gasta crédito.
    const october = await listPeriodActions(ownerDb, orgId, { start, end, credit: "mes", creditCents: 2900 })
    expect(october.map((row) => row.state)).toEqual(["esperando"])
    await closeSaasPeriods(ownerDb, new Date("2026-11-01T13:00:00Z"))
    const [first] = await chargesOf(orgId)
    expect(await linesOf(first!.id)).toEqual([
      ["cuota", 1, 2900],
      ["impuesto", 1, 522],
    ])
    expect(await chargeOfAction(scene.conversationId)).toBeNull()
    // Asiste en noviembre: se cuenta la cita y la conversación va dentro de ella.
    await attend(scene, new Date("2026-11-04T16:00:00Z"))
    const novemberStart = end
    const novemberEnd = new Date("2026-12-01T12:00:00Z")
    const november = await listPeriodActions(ownerDb, orgId, { start: novemberStart, end: novemberEnd, credit: "mes", creditCents: 2900 })
    expect(november.map((row) => [row.kind, row.state])).toEqual([["cita", "credito"]])
    await closeSaasPeriods(ownerDb, new Date("2026-12-01T13:00:00Z"))
    const charges = await chargesOf(orgId)
    expect(charges).toHaveLength(2)
    expect(await linesOf(charges[1]!.id)).toEqual([
      ["cuota", 1, 2900],
      ["credito", 1, 0],
      ["impuesto", 1, 522],
    ])
    // La conversación nunca se cobró; la cita, una vez.
    expect(await chargeOfAction(scene.conversationId)).toBeNull()
    const [cita] = await ownerDb.select().from(saasAction).where(and(eq(saasAction.organizationId, orgId), eq(saasAction.kind, "cita")))
    expect(cita?.chargeId).toBe(charges[1]!.id)
  })

  it("si la cita no se da, la conversación se cobra al cerrar el tramo siguiente, una sola vez", async () => {
    const start = new Date("2026-10-01T12:00:00Z")
    const end = new Date("2026-11-01T12:00:00Z")
    const orgId = await clinic(start, end)
    const scene = await recovery(orgId, {
      sentAt: new Date("2026-10-27T15:00:00Z"),
      talkedAt: new Date("2026-10-28T15:00:00Z"),
      bookedAt: new Date("2026-10-28T15:10:00Z"),
      startsAt: new Date("2026-11-04T15:00:00Z"),
    })
    await closeSaasPeriods(ownerDb, new Date("2026-11-01T13:00:00Z"))
    expect(await chargeOfAction(scene.conversationId)).toBeNull()
    await ownerDb.update(appointment).set({ status: "cancelada" }).where(eq(appointment.id, scene.appointmentId))
    // Noviembre la muestra como suya: es lo que cobra este tramo.
    const november = await listPeriodActions(ownerDb, orgId, { start: end, end: new Date("2026-12-01T12:00:00Z"), credit: "mes", creditCents: 2900 })
    expect(november.map((row) => [row.id, row.state])).toEqual([[scene.conversationId, "credito"]])
    await closeSaasPeriods(ownerDb, new Date("2026-12-01T13:00:00Z"))
    const charges = await chargesOf(orgId)
    expect(await linesOf(charges[1]!.id)).toEqual([
      ["cuota", 1, 2900],
      ["credito", 1, 0],
      ["impuesto", 1, 522],
    ])
    expect(await chargeOfAction(scene.conversationId)).toBe(charges[1]!.id)
    // Diciembre ya no la arrastra.
    await closeSaasPeriods(ownerDb, new Date("2027-01-01T13:00:00Z"))
    const all = await chargesOf(orgId)
    expect(await linesOf(all[2]!.id)).toEqual([
      ["cuota", 1, 2900],
      ["impuesto", 1, 522],
    ])
  })

  it("quincenal: a mitad del tramo la conversación espera; si asiste antes del cierre va dentro de la cita", async () => {
    const start = new Date("2026-08-01T12:00:00Z")
    const end = new Date("2026-09-01T12:00:00Z")
    const orgId = await clinic(start, end, "quincenal")
    // 58 conversaciones a USD 0,50 agotan el crédito de USD 29.
    await filler(orgId, 58, new Date("2026-08-02T12:00:00Z"))
    const scene = await recovery(orgId, {
      sentAt: new Date("2026-08-09T15:00:00Z"),
      talkedAt: new Date("2026-08-10T15:00:00Z"),
      bookedAt: new Date("2026-08-10T15:10:00Z"),
      startsAt: new Date("2026-08-20T15:00:00Z"),
    })
    // A los 15 días no hay nada por encima del crédito que cobrar: la conversación espera.
    await closeSaasPeriods(ownerDb, new Date("2026-08-16T13:00:00Z"))
    expect(await chargesOf(orgId)).toHaveLength(0)
    expect(await chargeOfAction(scene.conversationId)).toBeNull()
    await attend(scene, new Date("2026-08-20T16:00:00Z"))
    await closeSaasPeriods(ownerDb, new Date("2026-09-01T13:00:00Z"))
    const [final] = await chargesOf(orgId)
    // Solo la cita pasa del crédito; la conversación va dentro de ella.
    expect(await linesOf(final!.id)).toEqual([
      ["cuota", 1, 2900],
      ["cita", 1, 400],
      ["credito", 58, 0],
      ["impuesto", 1, Math.round(3300 * 0.18)],
    ])
    expect(await chargeOfAction(scene.conversationId)).toBeNull()
  })
})

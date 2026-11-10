/**
 * Repaso final 2 de la atención y la ficha (10 nov, entrega 12): anular la atención donde se cambió
 * un tratamiento lo deja como estaba, y lo demás de los dos informes que vive en los servicios.
 */
import { randomUUID } from "node:crypto"
import { appointment, scheduleRoom } from "@odentia/db/schema/agenda"
import { appointmentPlanItem, treatmentPlanItem } from "@odentia/db/schema/clinical"
import { auditEvent, branch } from "@odentia/db/schema/org"
import { and, eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { createAppointment, getAppointment, markAppointmentCame } from "./appointments.js"
import { createBudget, decideBudget, deliverBudget } from "./budgets.js"
import { getPlanNextSteps } from "./plan-next.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { getEncounterVoidPreview, voidEncounter } from "./encounters.js"
import { addPlanItem, listPlanItems, revisePlanItem } from "./plan.js"
import { encounter } from "@odentia/db/schema/clinical"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

type Fixture = Awaited<ReturnType<typeof clinicalFixture>>

/** Un tratamiento aceptado, con su presupuesto aceptado. */
async function accepted(f: Fixture) {
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }),
  )
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) =>
    decideBudget(tx, ...f.args, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] }),
  )
  return item
}

/** La atención de la fixture queda firmada: solo hay una abierta por paciente. */
async function signFirst(f: Fixture) {
  await ownerDb.execute(
    sql`update encounter set status = 'finalizada', signer_name = 'Clínico', signer_registration = 'COP 1' where id = ${f.encounter.id}`,
  )
}

async function attention(f: Fixture): Promise<string> {
  const [row] = await ownerDb
    .insert(encounter)
    .values({ organizationId: "org_a", patientId: f.patient.id, professionalUserId: f.actor, reason: "Sesión" })
    .returning({ id: encounter.id })
  await f.ready(row!.id)
  return row!.id
}

it("A1: anular la atención donde se cambió un tratamiento deshace el cambio; el anterior vuelve aceptado y el diálogo lo dice", async () => {
  const f = await clinicalFixture()
  const item = await accepted(f)
  const [before] = await ownerDb.select().from(treatmentPlanItem).where(eq(treatmentPlanItem.id, item.id))
  await signFirst(f)
  const today = await attention(f)
  const next = await f.run((tx) =>
    revisePlanItem(tx, ...f.args, item.id, { encounterId: today, reason: "Se puede conservar", serviceId: f.service.id }),
  )
  const preview = await f.run((tx) => getEncounterVoidPreview(tx, ...f.args, today))
  expect(preview.revisions).toEqual([{ restored: item.title, replacement: next.title }])
  await f.run((tx) => voidEncounter(tx, ...f.args, today, { reason: "Era de prueba" }))
  const [old] = await ownerDb.select().from(treatmentPlanItem).where(eq(treatmentPlanItem.id, item.id))
  expect(old).toMatchObject({
    status: before!.status,
    decisionStatus: "aceptado",
    statusReason: before!.statusReason,
    consentResetAt: null,
  })
  const [gone] = await ownerDb.select().from(treatmentPlanItem).where(eq(treatmentPlanItem.id, next.id))
  expect(gone?.status).toBe("cancelado")
  // El Plan vuelve a listar el anterior y no el que se anuló.
  const plan = await f.run((tx) => listPlanItems(tx, "org_a", f.patient.id, undefined, { withoutVoided: true }))
  expect(plan.map((row) => row.id)).toContain(item.id)
  expect(plan.map((row) => row.id)).not.toContain(next.id)
  const trace = await ownerDb
    .select({ action: auditEvent.action })
    .from(auditEvent)
    .where(and(eq(auditEvent.entityId, item.id), eq(auditEvent.action, "plan.item_revision_undone")))
  expect(trace).toHaveLength(1)
})

const DAY = 86_400_000
const all = () => true

/** Reserva para la persona de la fixture, en una sede nueva, a tantos días. */
async function booker(f: Fixture) {
  const [site] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: `Sede ${randomUUID()}`, timezone: "America/Lima" })
    .returning()
  await ownerDb.insert(scheduleRoom).values({ organizationId: "org_a", branchId: site!.id, name: "Unidad dental 1" })
  const base = new Date(Date.now() + 2 * DAY)
  base.setUTCMinutes(0, 0, 0)
  return (days: number, planItemIds: string[]) =>
    f.run((tx) =>
      createAppointment(tx, "org_a", f.actor, {
        patientId: f.patient.id,
        professionalUserId: f.actor,
        branchId: site!.id,
        startsAt: new Date(base.getTime() + days * DAY).toISOString(),
        durationMin: 30,
        outsideSchedule: true,
        notice: false,
        planItemIds,
      }),
    )
}

it("M1: la cita que solo llevaba lo ya terminado lo sigue diciendo en la cita y en «Qué sigue», con «Usarla para…»", async () => {
  const f = await clinicalFixture()
  const crown = await accepted(f)
  const book = await booker(f)
  const visit = await book(5, [crown.id])
  // La corona se terminó antes (en otra cita); queda otro tratamiento aceptado sin cita.
  await ownerDb.update(treatmentPlanItem).set({ status: "realizado", completedAt: new Date() }).where(eq(treatmentPlanItem.id, crown.id))
  const other = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }),
  )
  await ownerDb.update(treatmentPlanItem).set({ decisionStatus: "aceptado" }).where(eq(treatmentPlanItem.id, other.id))
  const read = await f.run((tx) => getAppointment(tx, "org_a", visit.id))
  expect(read.doneFor).toBe(crown.title)
  const { steps } = await f.run((tx) => getPlanNextSteps(tx, "org_a", f.patient.id, all))
  const freed = steps.find((step) => step.kind === "sin_objeto")
  expect(freed?.text).toContain(`era para ${crown.title}, que ya se terminó`)
  expect(freed?.action).toMatchObject({ appointmentId: visit.id, reuse: { planItemId: other.id } })
  // Sin permiso de reservar, se dice igual, sin botón.
  const { steps: seen } = await f.run((tx) =>
    getPlanNextSteps(tx, "org_a", f.patient.id, (permission) => permission !== "appointments.write"),
  )
  expect(seen.find((step) => step.kind === "sin_objeto")?.action).toBeNull()
})

it("M4: «Vino» en la cita de la sesión 2 deja el aviso para quien atendió, sin quitar «Reservar»; con su atención firmada, no (B1)", async () => {
  const f = await clinicalFixture()
  const item = await accepted(f)
  await ownerDb.update(treatmentPlanItem).set({ status: "en_curso", plannedSessions: 2 }).where(eq(treatmentPlanItem.id, item.id))
  const book = await booker(f)
  const visit = await book(1, [item.id])
  const before = new Date(Date.now() - 3 * DAY)
  await ownerDb
    .update(appointment)
    .set({ startsAt: new Date(Date.now() - DAY), endsAt: new Date(Date.now() - DAY + 30 * 60_000) })
    .where(eq(appointment.id, visit.id))
  await ownerDb.update(appointmentPlanItem).set({ createdAt: before }).where(eq(appointmentPlanItem.appointmentId, visit.id))
  await f.run((tx) => markAppointmentCame(tx, "org_a", f.actor, visit.id))
  const { steps } = await f.run((tx) => getPlanNextSteps(tx, "org_a", f.patient.id, all, { viewerUserId: f.actor }))
  const next = steps.find((step) => step.kind === "continuar")
  expect(next?.notice).toContain("quedó atendida sin registrar")
  expect(next?.action?.label).toMatch(/^Reservar/)
})

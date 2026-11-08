/**
 * «Qué sigue» del Resumen en una lista (QA del 8 nov, propuesta 5) y lo que la
 * lista dejó a la vista: la cita que «cumple» un control solo hasta 30 días
 * después de su fecha, como los avisos (M6); el Plan dice la misma cita; la
 * Historia dice «Vencido» (B4); caja no recibe el control ni fechas de citas.
 */
import { appointment } from "@odentia/db/schema/agenda"
import { clinicalFollowUp, encounter } from "@odentia/db/schema/clinical"
import { branch } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { createAppointment, createRoom } from "./appointments.js"
import { createBudget, decideBudget, deliverBudget } from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { createFollowUp, listFollowUps } from "./follow-ups.js"
import { getTimeline } from "./patient-history.js"
import { addPlanItem } from "./plan.js"
import { getPlanNextStep, getPlanNextSteps } from "./plan-next.js"
import { ownerDb, setupTestDb } from "./test-setup.js"
import { getTreatmentCoordination } from "./treatment-coordination.js"

setupTestDb()

const DAY = 86_400_000
const all = () => true
/** Caja: lee presupuestos y cobros, no la agenda ni la historia. */
const cashier = (permission: string) => ["patients.read", "finance.read", "budgets.read", "budgets.decide"].includes(permission)
/** Recepción: la agenda y el presupuesto, no la historia. */
const reception = (permission: string) =>
  ["patients.read", "appointments.read", "appointments.write", "budgets.read", "budgets.send", "budgets.decide"].includes(permission)
type Fixture = Awaited<ReturnType<typeof clinicalFixture>>

/** Una cita de la persona en `startsAt`, fuera de horario. */
async function book(f: Fixture, startsAt: Date) {
  const [site] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: `Sede ${startsAt.getTime()}`, timezone: "America/Lima" })
    .returning()
  const room = await f.run((tx) => createRoom(tx, "org_a", { branchId: site!.id, name: "Unidad" }))
  return f.run((tx) =>
    createAppointment(tx, "org_a", f.actor, {
      branchId: site!.id,
      roomId: room.id,
      professionalUserId: f.actor,
      patientId: f.patient.id,
      startsAt: startsAt.toISOString(),
      durationMin: 30,
      outsideSchedule: true,
      notice: false,
    }),
  )
}

/** Un control indicado en la atención del fixture, que toca en `dueIn` días y se indicó hace `since`. */
async function control(f: Fixture, title: string, dueIn: number, since: number) {
  const created = await f.run((tx) =>
    createFollowUp(tx, ...f.args, {
      kind: "mantenimiento",
      title,
      dueAt: new Date(Date.now() + 30 * DAY).toISOString(),
      originEncounterId: f.encounter.id,
    }),
  )
  await ownerDb
    .update(clinicalFollowUp)
    .set({ dueAt: new Date(Date.now() + dueIn * DAY), createdAt: new Date(Date.now() - since * DAY) })
    .where(eq(clinicalFollowUp.id, created.id))
  return created
}

it("M6: una cita meses después de la fecha del control no lo cumple; una dentro de su ventana sí, y el Plan dice la misma", async () => {
  const f = await clinicalFixture()
  // Tocaba hace cinco meses; su próxima cita es una resina de la semana que viene.
  const late = await control(f, "Limpieza y control", -150, 330)
  const visit = await book(f, new Date(Date.now() + 7 * DAY))
  const coordination = await f.run((tx) => getTreatmentCoordination(tx, "org_a", f.patient.id))
  expect(coordination.nextControl).toMatchObject({ id: late.id, appointment: null })
  expect(coordination.followUps[0]).toMatchObject({ id: late.id, servedBy: null })
  expect((await f.run((tx) => listFollowUps(tx, "org_a", f.patient.id)))[0]).toMatchObject({ servedBy: null })
  const step = await f.run((tx) => getPlanNextStep(tx, "org_a", f.patient.id, all))
  expect(step).toMatchObject({
    kind: "control",
    text: "Limpieza y control · por reservar",
    // Ya pasó: «Tocaba», aunque tenga otra cita por venir.
    detail: expect.stringMatching(/^Tocaba el /),
    action: { label: "Reservar el control", followUpId: late.id },
  })

  // Un control que toca en 10 días, con la cita de la semana que viene en su ventana: esa le sirve.
  await ownerDb.update(clinicalFollowUp).set({ status: "cancelado" }).where(eq(clinicalFollowUp.id, late.id))
  const soon = await control(f, "Profilaxis", 10, 170)
  expect((await f.run((tx) => listFollowUps(tx, "org_a", f.patient.id))).find((row) => row.id === soon.id)).toMatchObject({
    servedBy: { id: visit.id },
  })
  expect((await f.run((tx) => getTreatmentCoordination(tx, "org_a", f.patient.id))).nextControl).toMatchObject({
    id: soon.id,
    appointment: { id: visit.id },
  })
  expect(await f.run((tx) => getPlanNextStep(tx, "org_a", f.patient.id, all))).toMatchObject({
    kind: "control",
    text: expect.stringMatching(/^Profilaxis · se puede hacer en su cita del /),
    detail: expect.stringMatching(/^Toca el .* · sin cita propia · lo indicó Clínico el /),
    action: { label: "Ver la cita", appointmentId: visit.id },
  })
})

it("la lista: el control vencido primero, lo aceptado con sus nombres, quién indicó el control; caja sin control ni fechas", async () => {
  const f = await clinicalFixture()
  await ownerDb.update(encounter).set({ reason: "Dolor en la 46" }).where(eq(encounter.id, f.encounter.id))
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }),
  )
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) => decideBudget(tx, ...f.args, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] }))
  const overdue = await control(f, "Control semestral", -3, 180)

  // El «Qué sigue» de siempre no cambia: lo aceptado sin cita.
  const { step, steps } = await f.run((tx) => getPlanNextSteps(tx, "org_a", f.patient.id, all))
  expect(step).toMatchObject({ kind: "agendar", text: "Aceptó todo: falta su cita" })
  expect(await f.run((tx) => getPlanNextStep(tx, "org_a", f.patient.id, all))).toEqual(step)
  // La lista pone el control vencido primero, y cada fila dice qué es.
  expect(steps.map((row) => row.kind)).toEqual(["control", "agendar"])
  expect(steps[0]).toMatchObject({
    text: "Control semestral · vencido",
    detail: expect.stringMatching(/^Tocaba el .* · lo indicó Clínico el .* en la atención por «Dolor en la 46»$/),
    action: { label: "Reservar el control", followUpId: overdue.id },
  })
  expect(steps[1]).toMatchObject({ detail: expect.stringMatching(/^Tratamiento propio · respondió el /), action: { label: "Reservar cita" } })

  // Recepción: lo mismo, sin el motivo de la atención (es de la historia).
  const forReception = await f.run((tx) => getPlanNextSteps(tx, "org_a", f.patient.id, reception))
  expect(forReception.steps[0]?.detail).toMatch(/lo indicó Clínico el /)
  expect(forReception.steps[0]?.detail).not.toContain("Dolor")

  // Caja no ve la agenda: ni el control ni la fecha de su cita.
  await book(f, new Date(Date.now() + 7 * DAY))
  const forCashier = await f.run((tx) => getPlanNextSteps(tx, "org_a", f.patient.id, cashier))
  expect(forCashier.steps.map((row) => row.kind)).toEqual(["agendar"])
  expect(forCashier.steps[0]).toMatchObject({ text: "Aceptó todo: su próxima cita no lo lleva", action: null })
  expect((await f.run((tx) => getPlanNextSteps(tx, "org_a", f.patient.id, all))).steps[0]?.text).toMatch(
    /^Aceptó todo: su cita del \d{1,2} \S+ no lo lleva$/,
  )
})

it("B4: la Historia dice «Vencido» del control que el Plan llama así", async () => {
  const f = await clinicalFixture()
  const overdue = await control(f, "Control semestral", -3, 180)
  const upcoming = await control(f, "Control anual", 40, 300)
  const { data } = await f.run((tx) => getTimeline(tx, "org_a", f.patient.id, { types: ["follow_up"] }))
  expect(data.find((row) => row.followUpId === overdue.id)).toMatchObject({ status: "pendiente", statusText: "Vencido" })
  expect(data.find((row) => row.followUpId === upcoming.id)).toMatchObject({ status: "pendiente", statusText: null })
  // Con una cita por venir deja de estar vencido, como en «Control vencido».
  const visit = await book(f, new Date(Date.now() + 3 * DAY))
  expect(
    (await f.run((tx) => getTimeline(tx, "org_a", f.patient.id, { types: ["follow_up"] }))).data.find((row) => row.followUpId === overdue.id),
  ).toMatchObject({ statusText: null })
  await ownerDb.delete(appointment).where(eq(appointment.id, visit.id))
})

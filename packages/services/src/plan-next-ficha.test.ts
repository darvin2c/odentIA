/**
 * «Qué sigue» tras el repaso de la ficha del 9 nov: lo que va después de otro
 * tratamiento de la misma pieza (la corona tras la endodoncia), sumar lo
 * aceptado a la cita que ya tiene, la corona y el control de su endodoncia en
 * una fila, y seguir un presupuesto que no contesta.
 */
import { randomUUID } from "node:crypto"
import { user } from "@odentia/db/schema/auth"
import { professionalSchedule } from "@odentia/db/schema/availability"
import {
  appointmentPlanItem,
  clinicalFollowUp,
  serviceCatalog,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { orgSpecialty, professionalSpecialty } from "@odentia/db/schema/clinical-forms"
import { crmTask } from "@odentia/db/schema/crm"
import { branch } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { createAppointment, createRoom, setAppointmentPlanItems } from "./appointments.js"
import { BUDGET_CALLBACK_KEY, noteBudgetNoAnswer } from "./budget-callback.js"
import { cancelBudget, createBudget, decideBudget, deliverBudget } from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { createFollowUp } from "./follow-ups.js"
import { addPlanItem } from "./plan.js"
import { getPlanNextSteps } from "./plan-next.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const DAY = 86_400_000
const all = () => true
type Fixture = Awaited<ReturnType<typeof clinicalFixture>>

/** Un tratamiento del plan con su pieza, su fase y su estado, ya aceptado. */
async function item(
  f: Fixture,
  title: string,
  site: { tooth: string; phase: string; status?: string; plannedSessions?: number },
) {
  const created = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }),
  )
  const [row] = await ownerDb
    .update(treatmentPlanItem)
    .set({
      title,
      siteSystem: "FDI",
      siteCode: site.tooth,
      phase: site.phase,
      status: site.status ?? "pendiente",
      decisionStatus: "aceptado",
      plannedSessions: site.plannedSessions ?? 1,
    })
    .where(eq(treatmentPlanItem.id, created.id))
    .returning()
  return row!
}

/** Una cita de la persona en `startsAt` (fuera de horario), con lo que lleva. */
async function book(f: Fixture, startsAt: Date, planItemIds: string[] = []) {
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
      planItemIds,
    }),
  )
}

const steps = (f: Fixture) => f.run((tx) => getPlanNextSteps(tx, "org_a", f.patient.id, all)).then((result) => result.steps)

it("la corona de la 36 espera a la endodoncia en curso de la 36: lo dice y busca hora desde el día siguiente a su sesión", async () => {
  const f = await clinicalFixture()
  const endo = await item(f, "Endodoncia", { tooth: "36", phase: "basica", status: "en_curso", plannedSessions: 2 })
  const corona = await item(f, "Corona", { tooth: "36", phase: "rehabilitadora" })
  const session = await book(f, new Date(Date.now() + 2 * DAY), [endo.id])
  const [first, ...rest] = await steps(f)
  expect(first).toMatchObject({
    kind: "agendar",
    text: "Corona: va después de terminar Endodoncia",
    detail: expect.stringMatching(/^Su sesión 1 de 2 es el /),
    action: { label: "Reservar lo aceptado", planItemIds: [corona.id], note: expect.stringMatching(/^Va después de terminar Endodoncia \(su sesión 1 de 2 es el /) },
  })
  // El día siguiente a la sesión, en la zona de la clínica.
  const sessionDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date(session.startsAt))
  expect(first?.action?.date && first.action.date > sessionDay).toBe(true)
  // No se le ofrece sumarla a la cita de la endodoncia.
  expect(first?.action?.join).toBeUndefined()
  expect(rest.some((step) => step.kind === "agendar")).toBe(false)

  // Una resina de la misma pieza va en la misma fase: no espera; la corona sigue diciendo después de qué.
  const resina = await item(f, "Resina", { tooth: "36", phase: "basica" })
  const [next] = await steps(f)
  expect(next).toMatchObject({ kind: "agendar", action: { planItemIds: [resina.id] } })
  expect(next?.detail).toContain("Corona: va después de Endodoncia")
})

it("dos tratamientos de la misma pieza y la misma fase no se esperan", async () => {
  const f = await clinicalFixture()
  await item(f, "Terapia", { tooth: "36", phase: "basica", status: "en_curso", plannedSessions: 3 })
  const otra = await item(f, "Control de la terapia", { tooth: "36", phase: "basica" })
  const scheduled = (await steps(f)).find((step) => step.kind === "agendar")
  expect(scheduled?.action?.planItemIds).toEqual([otra.id])
})

it("lo aceptado se suma a la cita que ya tiene, sin otra visita, y se deshace", async () => {
  const f = await clinicalFixture()
  const resina = await item(f, "Resina", { tooth: "15", phase: "basica" })
  const visit = await book(f, new Date(Date.now() + 3 * DAY))
  const [first] = await steps(f)
  expect(first).toMatchObject({
    kind: "agendar",
    text: expect.stringMatching(/aún no van? en su cita del /),
    action: { label: "Otra cita", planItemIds: [resina.id], join: { appointmentId: visit.id, label: expect.stringMatching(/^Sumar a su cita del /) } },
  })
  const joined = await f.run((tx) =>
    setAppointmentPlanItems(tx, "org_a", f.actor, visit.id, { expectedVersion: visit.version, add: [resina.id] }),
  )
  expect(joined.version).toBe(visit.version + 1)
  // Quien tiene la cita atiende ese servicio (o nadie lo tiene asignado): nada que avisar.
  expect(joined.outsideService).toEqual([])
  expect((await steps(f)).some((step) => step.kind === "agendar")).toBe(false)
  // Con la versión vieja, no: otro la cambió.
  await expect(
    f.run((tx) => setAppointmentPlanItems(tx, "org_a", f.actor, visit.id, { expectedVersion: visit.version, remove: [resina.id] })),
  ).rejects.toMatchObject({ code: "STALE_VERSION" })
  await f.run((tx) => setAppointmentPlanItems(tx, "org_a", f.actor, visit.id, { expectedVersion: joined.version, remove: [resina.id] }))
  expect((await steps(f))[0]).toMatchObject({ kind: "agendar", action: { planItemIds: [resina.id] } })
  const links = await ownerDb.select().from(appointmentPlanItem).where(eq(appointmentPlanItem.appointmentId, visit.id))
  expect(links).toEqual([])

  // Lo que otra cita por venir ya lleva no se lleva dos veces.
  const other = await book(f, new Date(Date.now() + 5 * DAY), [resina.id])
  const fresh = await f.run(async (tx) => (await import("./appointments.js")).getAppointment(tx, "org_a", visit.id))
  await expect(
    f.run((tx) => setAppointmentPlanItems(tx, "org_a", f.actor, visit.id, { expectedVersion: fresh.version, add: [resina.id] })),
  ).rejects.toMatchObject({ code: "ITEM_SCHEDULED" })
  expect(other.id).not.toBe(visit.id)
})

it("«Sumar a su cita» con quien no atiende ese servicio lo dice, sin frenarlo (entrega 8)", async () => {
  const f = await clinicalFixture()
  const resina = await item(f, "Resina", { tooth: "15", phase: "basica" })
  const visit = await book(f, new Date(Date.now() + 3 * DAY), [])
  // La resina es de Restauradora, que en esa sede atiende otra persona con horario.
  const [specialty] = await ownerDb
    .insert(orgSpecialty)
    .values({ organizationId: "org_a", key: "restauradora", name: "Restauradora" })
    .returning()
  await ownerDb
    .update(serviceCatalog)
    .set({ specialtyId: specialty!.id })
    .where(eq(serviceCatalog.id, f.service.id))
  const other = `otra-${randomUUID()}`
  await ownerDb
    .insert(user)
    .values({ id: other, name: "Dra. Otra", email: `${other}@test.local`, emailVerified: true })
  await ownerDb
    .insert(professionalSpecialty)
    .values({ organizationId: "org_a", specialtyId: specialty!.id, userId: other })
  await ownerDb
    .insert(professionalSchedule)
    .values({
      organizationId: "org_a",
      branchId: visit.branchId,
      professionalUserId: other,
      weekday: 1,
      startMin: 540,
      endMin: 780,
      validFrom: "2020-01-01",
    })
  const joined = await f.run((tx) =>
    setAppointmentPlanItems(tx, "org_a", f.actor, visit.id, {
      expectedVersion: visit.version,
      add: [resina.id],
    }),
  )
  // Antes se sumaba en silencio: ahora la pantalla lo avisa con su nombre, y la cita lo lleva igual.
  expect(joined.outsideService).toEqual(["Resina"])
  const links = await ownerDb
    .select()
    .from(appointmentPlanItem)
    .where(eq(appointmentPlanItem.appointmentId, visit.id))
  expect(links.map((row) => row.planItemId)).toEqual([resina.id])
})

it("la corona y el control de la endodoncia de la misma pieza: una fila, primero, desde que el control se puede hacer", async () => {
  const f = await clinicalFixture()
  const endo = await item(f, "Endodoncia", { tooth: "46", phase: "basica", status: "realizado" })
  const corona = await item(f, "Corona", { tooth: "46", phase: "rehabilitadora" })
  const resina = await item(f, "Resina", { tooth: "15", phase: "basica" })
  const control = await f.run((tx) =>
    createFollowUp(tx, ...f.args, {
      kind: "tratamiento",
      title: "Control de la endodoncia",
      dueAt: new Date(Date.now() + 7 * DAY).toISOString(),
      originEncounterId: f.encounter.id,
      planItemId: endo.id,
    }),
  )
  const [first, second] = await steps(f)
  expect(first).toMatchObject({
    kind: "agendar",
    text: "Falta su cita: lo aceptado y el control",
    action: { label: "Reservar lo aceptado y el control", planItemIds: [corona.id], followUpIds: [control.id], date: expect.any(String) },
  })
  // Lo de otra pieza no se atrasa por el control: va en su fila.
  expect(second).toMatchObject({ kind: "agendar", action: { planItemIds: [resina.id] } })
})

it("«No contesta»: la fila dice cuándo volver a llamar y qué tratamientos son; al responder, la tarea se cierra sola", async () => {
  const f = await clinicalFixture()
  const resina = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }),
  )
  const corona = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }),
  )
  await ownerDb.update(treatmentPlanItem).set({ title: "Resina" }).where(eq(treatmentPlanItem.id, resina.id))
  await ownerDb.update(treatmentPlanItem).set({ title: "Corona" }).where(eq(treatmentPlanItem.id, corona.id))
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [resina.id, corona.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  const waiting = (await steps(f)).find((step) => step.kind === "respuesta")
  expect(waiting).toMatchObject({ text: "Entregado · espera respuesta", detail: expect.stringMatching(/^Resina · Corona · /) })

  const callAgainAt = new Date(Date.now() + 3 * DAY)
  await f.run((tx) => noteBudgetNoAnswer(tx, ...f.args, budget.id, { callAgainAt: callAgainAt.toISOString() }))
  // Otra vez no contesta: la misma tarea, otra fecha.
  await f.run((tx) => noteBudgetNoAnswer(tx, ...f.args, budget.id, { callAgainAt: new Date(Date.now() + 4 * DAY).toISOString() }))
  const tasks = await ownerDb.select().from(crmTask).where(eq(crmTask.idempotencyKey, `${BUDGET_CALLBACK_KEY}${budget.id}`))
  expect(tasks).toHaveLength(1)
  expect(tasks[0]).toMatchObject({ status: "open", area: "recepcion", patientId: f.patient.id })
  const called = (await steps(f)).find((step) => step.kind === "respuesta")
  expect(called).toMatchObject({
    text: expect.stringMatching(/^No contestó el .+ · volver a llamar el /),
    action: { label: "¿Qué respondió?", budgetId: budget.id },
  })

  await f.run((tx) =>
    decideBudget(tx, ...f.args, budget.id, {
      decisions: [
        { planItemId: resina.id, decision: "aceptado" },
        { planItemId: corona.id, decision: "aceptado" },
      ],
    }),
  )
  const [closed] = await ownerDb
    .select()
    .from(crmTask)
    .where(and(eq(crmTask.idempotencyKey, `${BUDGET_CALLBACK_KEY}${budget.id}`)))
  expect(closed).toMatchObject({ status: "done", settledReason: "Ya respondió su presupuesto" })
  // Ya respondió: no se anota otro «no contesta».
  await expect(
    f.run((tx) => noteBudgetNoAnswer(tx, ...f.args, budget.id, { callAgainAt: callAgainAt.toISOString() })),
  ).rejects.toMatchObject({ code: "BUDGET_NOT_AWAITING" })
})

it("un control lejano (a meses) no atrasa la corona; una endodoncia pausada también va antes", async () => {
  const f = await clinicalFixture()
  const endo = await item(f, "Endodoncia", { tooth: "46", phase: "basica", status: "realizado" })
  const corona = await item(f, "Corona", { tooth: "46", phase: "rehabilitadora" })
  await f.run((tx) =>
    createFollowUp(tx, ...f.args, {
      kind: "tratamiento",
      title: "Control radiográfico",
      dueAt: new Date(Date.now() + 180 * DAY).toISOString(),
      originEncounterId: f.encounter.id,
      planItemId: endo.id,
    }),
  )
  const scheduled = (await steps(f)).find((step) => step.kind === "agendar")
  expect(scheduled?.action).toMatchObject({ planItemIds: [corona.id] })
  expect(scheduled?.action?.followUpIds).toBeUndefined()

  const g = await clinicalFixture()
  await item(g, "Endodoncia", { tooth: "36", phase: "basica", status: "suspendido", plannedSessions: 2 })
  await item(g, "Corona", { tooth: "36", phase: "rehabilitadora" })
  expect((await steps(g)).find((step) => step.kind === "agendar")?.text).toBe("Corona: va después de terminar Endodoncia")
})

it("anular el presupuesto cierra su «volver a llamar»", async () => {
  const f = await clinicalFixture()
  const resina = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }),
  )
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [resina.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) => noteBudgetNoAnswer(tx, ...f.args, budget.id, { callAgainAt: new Date(Date.now() + DAY).toISOString() }))
  await f.run((tx) => cancelBudget(tx, ...f.args, budget.id))
  const [task] = await ownerDb.select().from(crmTask).where(eq(crmTask.idempotencyKey, `${BUDGET_CALLBACK_KEY}${budget.id}`))
  expect(task).toMatchObject({ status: "done", settledReason: "Se anuló su presupuesto", title: "Volver a llamar por el presupuesto de Paciente de prueba" })
})

it("si todo lo aceptado espera a otro tratamiento, el control vencido va en su propia fila con su botón", async () => {
  const f = await clinicalFixture()
  await item(f, "Endodoncia", { tooth: "36", phase: "basica", status: "en_curso", plannedSessions: 2 })
  await item(f, "Corona", { tooth: "36", phase: "rehabilitadora" })
  const limpieza = await f.run((tx) =>
    createFollowUp(tx, ...f.args, {
      kind: "mantenimiento",
      title: "Limpieza y control",
      dueAt: new Date(Date.now() + 30 * DAY).toISOString(),
      originEncounterId: f.encounter.id,
    }),
  )
  await ownerDb
    .update(clinicalFollowUp)
    .set({ dueAt: new Date(Date.now() - 5 * DAY), createdAt: new Date(Date.now() - 180 * DAY) })
    .where(eq(clinicalFollowUp.id, limpieza.id))
  const list = await steps(f)
  const waiting = list.find((step) => step.kind === "agendar")
  expect(waiting?.text).toBe("Corona: va después de terminar Endodoncia")
  expect(waiting?.action?.followUpIds).toBeUndefined()
  expect(list.find((step) => step.kind === "control")).toMatchObject({ action: { label: "Reservar el control", followUpId: limpieza.id } })
})

it("«Lo piensa» también cierra el «volver a llamar»: la fila dice lo que respondió", async () => {
  const f = await clinicalFixture()
  const resina = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }),
  )
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [resina.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) => noteBudgetNoAnswer(tx, ...f.args, budget.id, { callAgainAt: new Date(Date.now() + DAY).toISOString() }))
  await f.run((tx) => decideBudget(tx, ...f.args, budget.id, { decisions: [{ planItemId: resina.id, decision: "pospuesto" }] }))
  const [task] = await ownerDb.select().from(crmTask).where(eq(crmTask.idempotencyKey, `${BUDGET_CALLBACK_KEY}${budget.id}`))
  expect(task?.status).toBe("done")
  expect((await steps(f)).find((step) => step.kind === "respuesta")?.text).toBe("Lo está pensando")
})

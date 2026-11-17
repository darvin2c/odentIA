/**
 * Estudio de la atención, entrega 7 (16 nov): «Lo que sigue» de la atención firmada es la lista de
 * «Qué sigue» con lo de esta atención primero; «¿Cuándo vuelve?» ofrece lo aceptado de la misma
 * pieza y después lo del mismo plan, contando lo que la firma termina (la corona tras la
 * endodoncia), y propone un control a 30 días si lo que va después no tiene cita; «Usarla para…»
 * lleva todo eso; e Inicio dice la atención que quedó abierta hoy.
 */
import { randomUUID } from "node:crypto"
import { appointment, scheduleRoom } from "@odentia/db/schema/agenda"
import {
  appointmentPlanItem,
  clinicalFollowUp,
  encounter,
  serviceCatalog,
  treatmentPlan,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { branch } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { reuseAppointment } from "./appointments.js"
import { createBudget, decideBudget, deliverBudget } from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { addEncounterProcedure, finalizeEncounter, getEncounterClosing } from "./encounters.js"
import { addPlanItem } from "./plan.js"
import { getEncounterNextSteps, getPlanNextSteps } from "./plan-next.js"
import { insertTestPatients } from "./test-patient.js"
import { ownerDb, setupTestDb } from "./test-setup.js"
import { getWorkspaceHome, workspaceAccessFor } from "./workspace.js"

setupTestDb()

const DAY = 86_400_000
const all = () => true
type Fixture = Awaited<ReturnType<typeof clinicalFixture>>

/** Un tratamiento aceptado de `sessions` sesiones previstas, con su presupuesto aceptado. */
async function acceptedTreatment(f: Fixture, sessions: number) {
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id, plannedSessions: sessions }),
  )
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) => decideBudget(tx, ...f.args, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] }))
  return item
}

async function service(name: string, scope: "tooth" | "general") {
  const [row] = await ownerDb
    .insert(serviceCatalog)
    .values({ organizationId: "org_a", name, scope, source: "custom", priceCents: 50_000, currency: "PEN" })
    .returning()
  return row!
}

/** Un tratamiento del plan, aceptado (o como se diga) y sin empezar, con su pieza, su fase y cuándo se respondió. */
async function planned(
  f: Fixture,
  input: {
    serviceId: string
    title: string
    tooth?: string
    phase?: string
    decidedAt?: Date
    planId?: string
    decision?: string
    sessions?: number
  },
) {
  const [row] = await ownerDb
    .insert(treatmentPlanItem)
    .values({
      organizationId: "org_a",
      patientId: f.patient.id,
      planId: input.planId ?? f.plan.id,
      serviceId: input.serviceId,
      title: input.title,
      scope: input.tooth ? "tooth" : "general",
      ...(input.tooth ? { siteSystem: "ISO-3950", siteCode: input.tooth } : {}),
      plannedSessions: input.sessions ?? 1,
      priceCents: 50_000,
      currency: "PEN",
      status: "pendiente",
      decisionStatus: input.decision ?? "aceptado",
      decidedAt: input.decidedAt ?? new Date(),
      phase: input.phase ?? "basica",
    })
    .returning()
  return row!
}

/** Raúl: la endodoncia de la 36 (de `sessions` sesiones), la corona que va después, la resina 15 y la limpieza aceptadas. */
async function raul(f: Fixture, sessions: number) {
  const endo = await planned(f, { serviceId: (await service("Endodoncia posterior vital", "tooth")).id, title: "Endodoncia posterior vital", tooth: "36", sessions })
  const corona = await planned(f, { serviceId: (await service("Corona metal-cerámica", "tooth")).id, title: "Corona metal-cerámica", tooth: "36", phase: "rehabilitadora" })
  const resina = await planned(f, { serviceId: (await service("Obturación con resina", "tooth")).id, title: "Obturación con resina", tooth: "15", decidedAt: new Date(Date.now() - 30 * DAY) })
  const limpieza = await planned(f, { serviceId: (await service("Limpieza dental", "general")).id, title: "Limpieza dental" })
  // B2b: lo aceptado hace más de un año, en otro plan y en este, no cambia el cierre.
  const [otherPlan] = await ownerDb
    .insert(treatmentPlan)
    .values({ organizationId: "org_a", patientId: f.patient.id, title: "Plan de 2025", originEncounterId: f.encounter.id })
    .returning()
  const yearAgo = new Date(Date.now() - 400 * DAY)
  const blanqueamiento = await planned(f, { serviceId: (await service("Blanqueamiento", "general")).id, title: "Blanqueamiento", decidedAt: yearAgo, planId: otherPlan!.id })
  const carillas = await planned(f, { serviceId: (await service("Carillas", "general")).id, title: "Carillas", decidedAt: yearAgo })
  await f.ready(f.encounter.id)
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: endo.id }))
  return { endo, corona, resina, limpieza, blanqueamiento, carillas }
}

it("B1: la atención firmada dice la misma lista que la ficha, con «Reservar la sesión 2» de esta atención primero", async () => {
  const f = await clinicalFixture()
  const endo = await acceptedTreatment(f, 2)
  // Un control de otro tratamiento (de otra atención), vencido: en la ficha va primero.
  const exodoncia = await planned(f, { serviceId: f.service.id, title: "Exodoncia" })
  await ownerDb.update(treatmentPlanItem).set({ status: "realizado" }).where(eq(treatmentPlanItem.id, exodoncia.id))
  await ownerDb.insert(clinicalFollowUp).values({
    organizationId: "org_a",
    patientId: f.patient.id,
    planItemId: exodoncia.id,
    kind: "tratamiento",
    title: "Control de la exodoncia",
    dueAt: new Date(Date.now() - 10 * DAY),
    status: "pendiente",
  })
  await f.ready(f.encounter.id)
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: endo.id }))
  await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))

  const { steps: ficha } = await f.run((tx) => getPlanNextSteps(tx, "org_a", f.patient.id, all))
  const signed = await f.run((tx) => getEncounterNextSteps(tx, "org_a", f.patient.id, f.encounter.id, all))
  expect(ficha[0]?.text).toContain("Control de la exodoncia")
  expect(signed[0]).toMatchObject({
    kind: "continuar",
    text: "Falta la cita de la próxima sesión: Tratamiento propio · sesión 2 de 2",
    action: { label: "Reservar la sesión 2", planItemIds: [endo.id] },
  })
  // Los mismos pasos, con las mismas palabras: solo cambia el orden.
  const words = (steps: typeof ficha) => steps.map((step) => `${step.kind}|${step.text}|${step.detail}`).sort()
  expect(words(signed)).toEqual(words(ficha))
  // Una atención de otra persona no se lee desde aquí.
  const g = await clinicalFixture()
  await expect(f.run((tx) => getEncounterNextSteps(tx, "org_a", f.patient.id, g.encounter.id, all))).rejects.toThrow()
})

it("B2: al terminar la endodoncia vuelve para la corona de la 36, la resina 15 y la limpieza; no para lo de hace un año, y propone el control a 30 días", async () => {
  const f = await clinicalFixture()
  const { corona, resina, limpieza } = await raul(f, 1)
  const closing = await f.run((tx) => getEncounterClosing(tx, ...f.args, f.encounter.id))
  // Primero lo de la misma pieza, que la firma deja de esperar; después lo del mismo plan.
  expect(closing.sessions.accepted.map((session) => session.planItemId)).toEqual([corona.id, resina.id, limpieza.id])
  expect(closing.sessions.accepted[0]).toMatchObject({ n: 0, m: 1, before: { title: "Endodoncia posterior vital" } })
  expect(closing.sessions.waiting).toEqual([])
  // La corona iba después de lo que hoy termina y no tiene cita: el control corto se propone.
  expect(closing.sessions.afterUnbooked.map((session) => session.planItemId)).toEqual([corona.id])
  const done = await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  expect(done.nextSessions.map((session) => session.planItemId)).toEqual([corona.id, resina.id, limpieza.id])
  expect(done.waitingAfter).toEqual([])
})

it("B2: con la corona «lo piensa» no se ofrece, pero el control a 30 días se propone igual; con su cita, no", async () => {
  const f = await clinicalFixture()
  const endodoncia = await service("Endodoncia posterior vital", "tooth")
  const endo = await planned(f, { serviceId: endodoncia.id, title: "Endodoncia posterior vital", tooth: "46" })
  const corona = await planned(f, {
    serviceId: (await service("Corona", "tooth")).id,
    title: "Corona",
    tooth: "46",
    phase: "rehabilitadora",
    decision: "pospuesto",
  })
  await f.ready(f.encounter.id)
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: endo.id }))
  const closing = await f.run((tx) => getEncounterClosing(tx, ...f.args, f.encounter.id))
  expect(closing.sessions.accepted).toEqual([])
  expect(closing.sessions.afterUnbooked.map((session) => session.planItemId)).toEqual([corona.id])
  // Con una cita por venir que la lleva, ya no hace falta el control.
  const [site] = await ownerDb.insert(branch).values({ organizationId: "org_a", name: `Sede ${randomUUID()}`, timezone: "America/Lima" }).returning()
  const [room] = await ownerDb.insert(scheduleRoom).values({ organizationId: "org_a", branchId: site!.id, name: "Unidad dental 1" }).returning()
  const startsAt = new Date(Date.now() + 10 * DAY)
  const [visit] = await ownerDb
    .insert(appointment)
    .values({
      organizationId: "org_a",
      branchId: site!.id,
      roomId: room!.id,
      professionalUserId: f.actor,
      patientId: f.patient.id,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      durationMin: 30,
      status: "programada",
    })
    .returning()
  await ownerDb.insert(appointmentPlanItem).values({ organizationId: "org_a", patientId: f.patient.id, appointmentId: visit!.id, planItemId: corona.id })
  const booked = await f.run((tx) => getEncounterClosing(tx, ...f.args, f.encounter.id))
  expect(booked.sessions.afterUnbooked).toEqual([])
})

it("con la endodoncia en curso, la corona espera y «Atención finalizada» la dice después de la sesión 2", async () => {
  const f = await clinicalFixture()
  const { corona, resina, limpieza } = await raul(f, 2)
  const closing = await f.run((tx) => getEncounterClosing(tx, ...f.args, f.encounter.id))
  expect(closing.sessions.continuing).toHaveLength(1)
  expect(closing.sessions.waiting.map((session) => session.planItemId)).toEqual([corona.id])
  // Lo de otras piezas no espera a la endodoncia, pero el cierre lo ofrece solo si nada sigue en curso.
  expect(closing.sessions.accepted.map((session) => session.planItemId)).toEqual([resina.id, limpieza.id])
  expect(closing.sessions.afterUnbooked).toEqual([])
  const done = await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  expect(done.nextSessions.map((session) => session.title)).toEqual(["Endodoncia posterior vital"])
  expect(done.waitingAfter).toEqual([
    { planItemId: corona.id, title: "Corona metal-cerámica", place: expect.any(String), beforeTitle: "Endodoncia posterior vital" },
  ])
})

it("otro tratamiento en curso sin su sesión de hoy va primero: no vuelve para lo aceptado", async () => {
  const f = await clinicalFixture()
  const other = await planned(f, { serviceId: (await service("Ortodoncia", "general")).id, title: "Ortodoncia", sessions: 12 })
  await ownerDb.update(treatmentPlanItem).set({ status: "en_curso" }).where(eq(treatmentPlanItem.id, other.id))
  await raul(f, 1)
  const closing = await f.run((tx) => getEncounterClosing(tx, ...f.args, f.encounter.id))
  expect(closing.sessions.accepted).toEqual([])
})

it("«Usarla para…» deja la cita sobrante para todo lo que vuelve a hacer, con el servicio del primero", async () => {
  const f = await clinicalFixture()
  const first = await acceptedTreatment(f, 1)
  const second = await acceptedTreatment(f, 1)
  const done = await acceptedTreatment(f, 1)
  const [site] = await ownerDb.insert(branch).values({ organizationId: "org_a", name: `Sede ${randomUUID()}`, timezone: "America/Lima" }).returning()
  const [room] = await ownerDb.insert(scheduleRoom).values({ organizationId: "org_a", branchId: site!.id, name: "Unidad dental 1" }).returning()
  const startsAt = new Date(Date.now() + 8 * DAY)
  const [visit] = await ownerDb
    .insert(appointment)
    .values({
      organizationId: "org_a",
      branchId: site!.id,
      roomId: room!.id,
      professionalUserId: f.actor,
      patientId: f.patient.id,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      durationMin: 30,
      status: "programada",
    })
    .returning()
  await ownerDb.insert(appointmentPlanItem).values({ organizationId: "org_a", patientId: f.patient.id, appointmentId: visit!.id, planItemId: done.id })
  const used = await f.run((tx) =>
    reuseAppointment(tx, "org_a", f.actor, visit!.id, { expectedVersion: visit!.version, planItemIds: [first.id, second.id] }),
  )
  const links = await ownerDb.select({ planItemId: appointmentPlanItem.planItemId }).from(appointmentPlanItem).where(eq(appointmentPlanItem.appointmentId, visit!.id))
  expect(links.map((row) => row.planItemId).sort()).toEqual([first.id, second.id].sort())
  expect(used.serviceId).toBe(f.service.id)
  // Uno solo, como desde «Qué sigue», sigue sirviendo.
  await expect(
    f.run((tx) => reuseAppointment(tx, "org_a", f.actor, visit!.id, { expectedVersion: used.version, planItemId: done.id })),
  ).resolves.toBeTruthy()
})

/**
 * Una hora de hoy en Lima (la zona de la sede de la prueba), cerca de `desde ahora`: «Mis pacientes
 * de hoy» mira el día de la clínica, y una hora calculada solo desde ahora cae en otro día cerca de
 * la medianoche (el CI corrió a las 00:47 de Lima y la cita de «hace 3 horas» era de ayer).
 */
function todayInLima(fromNowMs: number): Date {
  const offset = 5 * 60 * 60_000
  const dayStart = Math.floor((Date.now() - offset) / 86_400_000) * 86_400_000 + offset
  const target = Date.now() + fromNowMs
  return new Date(Math.min(Math.max(target, dayStart + 60_000), dayStart + 86_400_000 - 31 * 60_000))
}

it("B6: la atención que quedó abierta hoy sale en «Mis pacientes de hoy», sin repetir la de su cita ni sumar a «Te espera»", async () => {
  const f = await clinicalFixture()
  // Otra paciente con su cita de hoy y su atención unida: ya sale como «En atención».
  const [carmen] = await insertTestPatients(ownerDb, { organizationId: "org_a", displayName: "Carmen Rivas", patientNumber: Math.floor(Math.random() * 1_000_000) })
  const [site] = await ownerDb.insert(branch).values({ organizationId: "org_a", name: `Sede ${randomUUID()}`, timezone: "America/Lima" }).returning()
  const [room] = await ownerDb.insert(scheduleRoom).values({ organizationId: "org_a", branchId: site!.id, name: "Unidad dental 1" }).returning()
  const startsAt = todayInLima(60 * 60_000)
  const [visit] = await ownerDb
    .insert(appointment)
    .values({
      organizationId: "org_a",
      branchId: site!.id,
      roomId: room!.id,
      professionalUserId: f.actor,
      patientId: carmen!.id,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      durationMin: 30,
      status: "programada",
    })
    .returning()
  await ownerDb.insert(encounter).values({ organizationId: "org_a", patientId: carmen!.id, professionalUserId: f.actor, appointmentId: visit!.id, reason: "Control" })
  const home = await f.run((tx) => getWorkspaceHome(tx, "org_a", f.actor, workspaceAccessFor("clinician")))
  expect(home.today?.scope).toBe("mine")
  // Solo la atención sin cita de hoy (la del fixture), con desde cuándo está abierta.
  expect(home.today?.openEncounters?.map((row) => ({ id: row.id, patientId: row.patientId }))).toEqual([
    { id: f.encounter.id, patientId: f.patient.id },
  ])
  expect(home.today?.openEncounters?.[0]?.openedAt).toEqual(expect.any(String))
  // No suma a las cifras del día ni es una fila de «Te espera».
  expect(home.today?.summary.total).toBe(1)
  expect(home.waiting.some((row) => row.kind === "staleEncounter")).toBe(false)

  // Q11 (Elena): la misma persona tiene además su cita de hoy, que ya pasó y nadie cerró. Una sola
  // fila: la de su cita dice su atención abierta, y la fila aparte no la repite.
  const earlier = todayInLima(-3 * 60 * 60_000)
  const [own] = await ownerDb
    .insert(appointment)
    .values({
      organizationId: "org_a",
      branchId: site!.id,
      roomId: room!.id,
      professionalUserId: f.actor,
      patientId: f.patient.id,
      startsAt: earlier,
      endsAt: new Date(earlier.getTime() + 30 * 60_000),
      durationMin: 30,
      status: "confirmada",
    })
    .returning()
  const again = await f.run((tx) => getWorkspaceHome(tx, "org_a", f.actor, workspaceAccessFor("clinician")))
  expect(again.today?.openEncounters).toEqual([])
  expect(again.today?.appointments.find((row) => row.id === own!.id)).toMatchObject({
    patientId: f.patient.id,
    encounter: null,
    openEncounter: { id: f.encounter.id, openedAt: expect.any(String) },
  })
  // La cita de Carmen, que ya tiene su atención unida, no cambia.
  expect(again.today?.appointments.find((row) => row.id === visit!.id)?.openEncounter ?? null).toBeNull()
})

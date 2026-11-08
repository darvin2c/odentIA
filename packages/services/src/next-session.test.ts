/**
 * La próxima sesión se reserva donde termina la anterior (propuesta 2 de la QA
 * del 8 nov): el cierre dice si la siguiente sesión ya tiene cita, el resultado
 * de firmar dice qué sigue en curso y qué falta reservar, y «Qué sigue» pone lo
 * empezado antes que el presupuesto por enviar y que lo aceptado sin empezar.
 */
import { randomUUID } from "node:crypto"
import { scheduleRoom } from "@odentia/db/schema/agenda"
import { encounter, treatmentPlanItem } from "@odentia/db/schema/clinical"
import { branch } from "@odentia/db/schema/org"
import { eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { createAppointment } from "./appointments.js"
import { createBudget, decideBudget, deliverBudget } from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { addEncounterProcedure, finalizeEncounter, getEncounterClosing } from "./encounters.js"
import { getPlanNextStep, planNextStepsOf } from "./plan-next.js"
import { addPlanItem } from "./plan.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

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

/** Reserva una cita de la persona a `days` días, con lo que se le pida. */
async function booker(f: Fixture) {
  const [site] = await ownerDb.insert(branch).values({ organizationId: "org_a", name: `Sede ${randomUUID()}`, timezone: "America/Lima" }).returning()
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

/** Una atención en borrador de la persona, lista para firmarse. */
async function attention(f: Fixture): Promise<string> {
  const [row] = await ownerDb
    .insert(encounter)
    .values({ organizationId: "org_a", patientId: f.patient.id, professionalUserId: f.actor, reason: "Sesión" })
    .returning({ id: encounter.id })
  await f.ready(row!.id)
  return row!.id
}

it("X5: «Qué sigue» pone lo empezado sin cita antes de lo aceptado sin empezar; el presupuesto por enviar sigue primero y lo dice", async () => {
  const f = await clinicalFixture()
  const endo = await acceptedTreatment(f, 2)
  // La corona aceptada, que va después de la endodoncia.
  await acceptedTreatment(f, 1)
  // Sesión 1 de 2, firmada: la endodoncia queda en curso y sin cita para la sesión 2.
  await f.ready(f.encounter.id)
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: endo.id }))
  await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  const next = await f.run((tx) => getPlanNextStep(tx, "org_a", f.patient.id, all))
  expect(next).toMatchObject({
    kind: "continuar",
    text: "Falta la cita de la próxima sesión: Tratamiento propio · sesión 2 de 2",
    action: { label: "Reservar cita", planItemIds: [endo.id], serviceId: f.service.id },
  })
  expect((await f.run((tx) => planNextStepsOf(tx, "org_a", [f.patient.id], all))).get(f.patient.id)).toEqual(next)

  // Algo indicado después, en un presupuesto armado y sin enviar: enviarlo sigue primero
  // (es el atajo «Presupuesto sin enviar» de Pacientes), pero dice que falta la sesión.
  const later = await attention(f)
  const extra = await f.run((tx) => addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: later }))
  await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [extra.id] }))
  const sending = await f.run((tx) => getPlanNextStep(tx, "org_a", f.patient.id, all))
  expect(sending.kind).toBe("enviar")
  expect(sending.detail).toContain("también falta la cita de la próxima sesión de Tratamiento propio")
  // Con la sesión 2 reservada, el detalle ya no lo dice.
  const book = await booker(f)
  await book(1, [endo.id])
  expect((await f.run((tx) => getPlanNextStep(tx, "org_a", f.patient.id, all))).detail).not.toContain("también falta")
})

it("Al firmar la sesión 1, el resultado dice la sesión que falta reservar; si ya tenía cita, la dice el cierre y el resultado", async () => {
  const f = await clinicalFixture()
  const endo = await acceptedTreatment(f, 2)
  await f.ready(f.encounter.id)
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: endo.id }))
  // Sin cita para la sesión 2: el cierre no dice ninguna.
  const before = await f.run((tx) => getEncounterClosing(tx, ...f.args, f.encounter.id))
  expect(before.sessions.continuing).toEqual([{ planItemId: endo.id, title: "Tratamiento propio", n: 1, m: 2 }])
  const closed = await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  expect(closed.nextSessions).toEqual([
    { planItemId: endo.id, title: "Tratamiento propio", serviceId: f.service.id, booked: null, toBook: { n: 2, m: 2 } },
  ])

  // Otra persona del mismo caso: la sesión 2 ya se reservó antes de firmar la 1.
  const g = await clinicalFixture()
  const other = await acceptedTreatment(g, 2)
  const book = await booker(g)
  const second = await book(3, [other.id])
  await g.ready(g.encounter.id)
  await g.run((tx) => addEncounterProcedure(tx, ...g.args, g.encounter.id, { planItemId: other.id }))
  const closing = await g.run((tx) => getEncounterClosing(tx, ...g.args, g.encounter.id))
  expect(closing.sessions.continuing).toEqual([
    {
      planItemId: other.id,
      title: "Tratamiento propio",
      n: 1,
      m: 2,
      booked: { appointmentId: second.id, startsAt: new Date(second.startsAt), n: 2, m: 2 },
    },
  ])
  const signed = await g.run((tx) => finalizeEncounter(tx, ...g.args, g.encounter.id))
  expect(signed.nextSessions).toEqual([
    {
      planItemId: other.id,
      title: "Tratamiento propio",
      serviceId: g.service.id,
      booked: { appointmentId: second.id, startsAt: new Date(second.startsAt), n: 2, m: 2 },
      toBook: null,
    },
  ])
})

it("«Falta otra sesión» deja por reservar la que se sumó; lo que se termina al firmar no queda por reservar", async () => {
  const f = await clinicalFixture()
  const endo = await acceptedTreatment(f, 1)
  const resin = await acceptedTreatment(f, 1)
  await f.ready(f.encounter.id)
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: endo.id }))
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: resin.id }))
  const closed = await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id, { addSessionPlanItemIds: [endo.id] }))
  expect(closed.nextSessions).toEqual([
    { planItemId: endo.id, title: "Tratamiento propio", serviceId: f.service.id, booked: null, toBook: { n: 2, m: 2 } },
  ])
  const [row] = await ownerDb.select().from(treatmentPlanItem).where(eq(treatmentPlanItem.id, resin.id))
  expect(row!.status).toBe("realizado")
  // La sesión 2 en otra atención: «Falta otra sesión» otra vez, ahora va por la 3.
  const second = await attention(f)
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, second, { planItemId: endo.id }))
  const again = await f.run((tx) => finalizeEncounter(tx, ...f.args, second, { addSessionPlanItemIds: [endo.id] }))
  expect(again.nextSessions).toMatchObject([{ planItemId: endo.id, booked: null, toBook: { n: 3, m: 3 } }])
  // La constancia de «¿Cuándo vuelve?»: no se preguntó por un control porque sigue en curso.
  const [audit] = await ownerDb.execute<{ next: string }>(
    sql`select metadata->>'nextControl' as next from audit_event where action = 'encounter.finalized' and entity_id = ${second}`,
  )
  expect(audit!.next).toBe("sesion_en_curso")
})

/**
 * Un tratamiento de varias sesiones se ve como tal (QA del 6 nov): la cita dice
 * «sesión 1 de 2», la segunda cita también lo lleva, «Completar» no se ofrece
 * sin la sesión, el cierre pregunta «¿Terminaste?» y el servicio directo avisa
 * antes de abrir otro tratamiento que se cobraría completo otra vez.
 */
import { randomUUID } from "node:crypto"
import { scheduleRoom } from "@odentia/db/schema/agenda"
import { appointmentPlanItem, encounter, serviceCatalog, treatmentPlanItem } from "@odentia/db/schema/clinical"
import { branch } from "@odentia/db/schema/org"
import { eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { createAppointment, getAppointment, listAppointments, setAppointmentStatus } from "./appointments.js"
import { createBudget, decideBudget, deliverBudget } from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import {
  addEncounterProcedure,
  finalizeEncounter,
  findEarlierTreatment,
  getEncounterClosing,
} from "./encounters.js"
import { getPlanNextStep, planNextStepsOf } from "./plan-next.js"
import { addPlanItem, listPlanItems, setPlanItemStatus } from "./plan.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"
import {
  canBookAnother,
  canBookAnotherSql,
  isToSchedule,
  patientsToSchedule,
  sessionCountsOf,
  toScheduleSql,
} from "./to-schedule.js"
import { getTreatmentCoordination } from "./treatment-coordination.js"

setupTestDb()

const DAY = 86_400_000
const all = () => true
type Fixture = Awaited<ReturnType<typeof clinicalFixture>>

/** Un tratamiento aceptado de `sessions` sesiones previstas, con su presupuesto aceptado. */
async function acceptedTreatment(f: Fixture, sessions: number, billingMode: "treatment" | "session" = "treatment") {
  if (billingMode === "session")
    await ownerDb.update(serviceCatalog).set({ billingMode: "session", priceCents: 15_000 }).where(eq(serviceCatalog.id, f.service.id))
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id, plannedSessions: sessions }),
  )
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) => decideBudget(tx, ...f.args, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] }))
  return item
}

/** Una sede con dos unidades y una forma de reservar a `days` días (a la hora en punto). */
async function agenda(f: Fixture) {
  const [site] = await ownerDb.insert(branch).values({ organizationId: "org_a", name: `Sede ${randomUUID()}`, timezone: "America/Lima" }).returning()
  await ownerDb.insert(scheduleRoom).values([
    { organizationId: "org_a", branchId: site!.id, name: "Unidad dental 1" },
    { organizationId: "org_a", branchId: site!.id, name: "Unidad dental 2" },
  ])
  const base = new Date(Date.now() + 2 * DAY)
  base.setUTCMinutes(0, 0, 0)
  const book = (days: number, input: { planItemIds?: string[]; serviceId?: string; status?: string } = {}) =>
    f.run((tx) =>
      createAppointment(tx, "org_a", f.actor, {
        patientId: f.patient.id,
        professionalUserId: f.actor,
        branchId: site!.id,
        startsAt: new Date(base.getTime() + days * DAY).toISOString(),
        durationMin: 30,
        outsideSchedule: true,
        notice: false,
        ...input,
      }),
    )
  const list = () =>
    f.run((tx) =>
      listAppointments(tx, "org_a", {
        branchId: site!.id,
        from: new Date(Date.now() - 2 * DAY).toISOString(),
        to: new Date(Date.now() + 40 * DAY).toISOString(),
      }),
    )
  return { site: site!, book, list }
}

/** Una atención en borrador de la persona, unida a la cita si se da, lista para firmarse. */
async function attention(f: Fixture, appointmentId: string | null = null): Promise<string> {
  const [row] = await ownerDb
    .insert(encounter)
    .values({ organizationId: "org_a", patientId: f.patient.id, professionalUserId: f.actor, reason: "Sesión", appointmentId })
    .returning({ id: encounter.id })
  await f.ready(row!.id)
  return row!.id
}

it("D1: «Completar» sin sesión lo dice; con la sesión de hoy, se completa", async () => {
  const f = await clinicalFixture()
  const item = await acceptedTreatment(f, 1)
  await expect(
    f.run((tx) => setPlanItemStatus(tx, ...f.args, item.id, { status: "realizado", encounterId: f.encounter.id })),
  ).rejects.toMatchObject({ code: "INVALID_TRANSITION", message: "Registra primero la sesión de hoy: un tratamiento sin sesiones no se completa" })
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: item.id }))
  const done = await f.run((tx) => setPlanItemStatus(tx, ...f.args, item.id, { status: "realizado", encounterId: f.encounter.id }))
  expect(done.status).toBe("realizado")
})

it("D2: la cita dice en qué sesión va, sin contar canceladas, «No vino» ni lo ya registrado, y sin «3 de 2»", async () => {
  const f = await clinicalFixture()
  const item = await acceptedTreatment(f, 2)
  const single = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }),
  )
  await ownerDb.update(treatmentPlanItem).set({ decisionStatus: "aceptado" }).where(eq(treatmentPlanItem.id, single.id))
  const { book, list } = await agenda(f)
  const first = await book(1, { planItemIds: [item.id, single.id] })
  const cancelled = await book(2, { planItemIds: [item.id] })
  await f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, cancelled.id, "cancelada"))
  const second = await book(3, { planItemIds: [item.id] })
  const sessionsOf = async (id: string) => (await list()).find((row) => row.id === id)?.sessions ?? []
  // Lo de una sola sesión no dice «sesión 1 de 1».
  expect(await sessionsOf(first.id)).toEqual([{ planItemId: item.id, title: "Tratamiento propio", n: 1, m: 2 }])
  expect(await sessionsOf(second.id)).toMatchObject([{ n: 2, m: 2 }])
  expect(await sessionsOf(cancelled.id)).toEqual([])
  expect((await f.run((tx) => getAppointment(tx, "org_a", second.id))).sessions).toMatchObject([{ n: 2, m: 2 }])

  // Una de más no dice «3 de 2»: es la sesión 3 de 2 previstas (la pantalla: «sesión 3 (2 previstas)»).
  const extra = await book(5, { planItemIds: [item.id] })
  expect(await sessionsOf(extra.id)).toMatchObject([{ n: 3, m: 2 }])
  // «No vino» libera su lugar: la siguiente vuelve a ser la 2.
  await ownerDb.execute(sql`update appointment set status = 'no_asistio' where id = ${second.id}`)
  expect(await sessionsOf(extra.id)).toMatchObject([{ n: 2, m: 2 }])
  await ownerDb.execute(sql`update appointment set status = 'programada' where id = ${second.id}`)

  // La sesión 1 se registra en la atención de la primera cita: no se cuenta dos veces.
  await ownerDb.execute(sql`update encounter set status = 'finalizada', signer_name = 'Clínico', signer_registration = 'COP 1' where id = ${f.encounter.id}`)
  const firstVisit = await attention(f, first.id)
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, firstVisit, { planItemId: item.id }))
  expect(await sessionsOf(first.id)).toMatchObject([{ n: 1, m: 2 }])
  expect(await sessionsOf(second.id)).toMatchObject([{ n: 2, m: 2 }])
  // Firmada, la cita ya no viene a hacer nada.
  await f.run((tx) => finalizeEncounter(tx, ...f.args, firstVisit))
  expect(await sessionsOf(first.id)).toEqual([])
  expect(await sessionsOf(second.id)).toMatchObject([{ n: 2, m: 2 }])
  // Dos procedimientos en una misma atención son una sola sesión.
  expect((await f.run((tx) => listPlanItems(tx, "org_a", f.patient.id))).find((row) => row.id === item.id)?.sessionsDone).toBe(1)
})

it("D3: «puede llevar otra cita» es otra regla; «aceptó y no tiene cita» no cambia, y Sofi une la segunda sesión", async () => {
  const f = await clinicalFixture()
  const item = await acceptedTreatment(f, 2)
  const { book } = await agenda(f)
  const row = async () => (await ownerDb.select().from(treatmentPlanItem).where(eq(treatmentPlanItem.id, item.id)))[0]!
  /** Lo que dicen las dos reglas, en código y en SQL, y lo que ve la reserva. */
  const rules = async () => {
    const current = await row()
    const counts = await f.run((tx) => sessionCountsOf(tx, "org_a", [item.id]))
    const carried = new Set(
      (await ownerDb.execute<{ plan_item_id: string }>(sql`select l.plan_item_id from appointment_plan_item l join appointment a on a.id = l.appointment_id
        where l.plan_item_id = ${item.id} and a.status in ('programada', 'confirmada') and a.starts_at > now()`)).map((r) => r.plan_item_id),
    )
    const [sqlRow] = await f.run((tx) =>
      tx.execute<{ to_schedule: boolean; another: boolean }>(sql`select
        ${toScheduleSql({ id: sql`i.id`, organizationId: sql`i.organization_id`, status: sql`i.status`, decisionStatus: sql`i.decision_status` })} as to_schedule,
        ${canBookAnotherSql({ id: sql`i.id`, organizationId: sql`i.organization_id`, status: sql`i.status`, decisionStatus: sql`i.decision_status`, plannedSessions: sql`i.planned_sessions` })} as another
        from treatment_plan_item i where i.id = ${item.id}`),
    )
    const coordination = (await f.run((tx) => getTreatmentCoordination(tx, "org_a", f.patient.id))).treatments.find((t) => t.id === item.id)!
    const code = { toSchedule: isToSchedule(current, carried), another: canBookAnother(current, counts.get(item.id)!) }
    expect({ toSchedule: sqlRow!.to_schedule, another: sqlRow!.another }).toEqual(code)
    return { ...code, sessionsLeft: coordination.sessionsLeft, nextSession: coordination.nextSession, coordinationToSchedule: coordination.toSchedule }
  }
  expect(await rules()).toEqual({ toSchedule: true, another: true, sessionsLeft: 2, nextSession: { n: 1, m: 2 }, coordinationToSchedule: true })
  await book(1, { planItemIds: [item.id] })
  // Con la primera cita ya no «falta agendar» (Inicio, Pacientes, Argos), pero le falta la segunda.
  expect(await rules()).toEqual({ toSchedule: false, another: true, sessionsLeft: 1, nextSession: { n: 2, m: 2 }, coordinationToSchedule: false })
  expect(await f.run((tx) => patientsToSchedule(tx, "org_a"))).not.toContain(f.patient.id)
  const next = await f.run((tx) => getPlanNextStep(tx, "org_a", f.patient.id, all))
  expect(next).toMatchObject({
    kind: "continuar",
    text: "Falta la cita de la próxima sesión: Tratamiento propio · sesión 2 de 2",
    action: { label: "Reservar cita", planItemIds: [item.id] },
  })
  expect((await f.run((tx) => planNextStepsOf(tx, "org_a", [f.patient.id], all))).get(f.patient.id)).toEqual(next)

  // Sofi o el enlace reservan con el servicio y sin decir qué trae: la segunda cita lleva el mismo tratamiento.
  const second = await book(3, { serviceId: f.service.id })
  const linked = await ownerDb.select().from(appointmentPlanItem).where(eq(appointmentPlanItem.appointmentId, second.id))
  expect(linked.map((link) => link.planItemId)).toEqual([item.id])
  expect(await rules()).toEqual({ toSchedule: false, another: false, sessionsLeft: 0, nextSession: { n: 3, m: 2 }, coordinationToSchedule: false })
  // Con las dos reservadas, una tercera ya no lo lleva.
  const third = await book(5, { serviceId: f.service.id })
  expect(await ownerDb.select().from(appointmentPlanItem).where(eq(appointmentPlanItem.appointmentId, third.id))).toEqual([])
  expect((await f.run((tx) => getPlanNextStep(tx, "org_a", f.patient.id, all))).kind).not.toBe("continuar")
})

it("D3: el cobro no cambia con dos citas: por tratamiento, la segunda sesión queda cubierta; por sesión, hasta el tope", async () => {
  for (const mode of ["treatment", "session"] as const) {
    const f = await clinicalFixture()
    const item = await acceptedTreatment(f, 2, mode)
    const { book } = await agenda(f)
    const one = await book(1, { planItemIds: [item.id] })
    const two = await book(3, { serviceId: f.service.id })
    await ownerDb.execute(sql`update encounter set status = 'finalizada', signer_name = 'Clínico', signer_registration = 'COP 1' where id = ${f.encounter.id}`)
    const charged = []
    // En la segunda «Falta otra sesión»: sin decirlo, llegar a las previstas lo termina.
    const visits: Array<[string | null, { addSessionPlanItemIds?: string[] }]> = [[one.id, {}], [two.id, { addSessionPlanItemIds: [item.id] }], [null, {}]]
    for (const [appointmentId, answer] of visits) {
      const visit = await attention(f, appointmentId)
      await f.run((tx) => addEncounterProcedure(tx, ...f.args, visit, { planItemId: item.id }))
      const closed = await f.run((tx) => finalizeEncounter(tx, ...f.args, visit, answer))
      charged.push(closed.billing.lines.map((line) => line.reason ?? line.amountCents))
    }
    if (mode === "treatment") expect(charged).toEqual([[120_000], ["covered"], ["covered"]])
    else expect(charged).toEqual([[15_000], [15_000], ["sessions_complete"]])
  }
})

it("D4: el cierre pregunta por lo trabajado hoy; a mitad no cierra nada, «Falta otra sesión» suma una y «Sí, terminar» lo completa", async () => {
  const f = await clinicalFixture()
  const item = await acceptedTreatment(f, 2)
  const statusOf = async () => (await ownerDb.select().from(treatmentPlanItem).where(eq(treatmentPlanItem.id, item.id)))[0]!
  await f.ready(f.encounter.id)
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: item.id }))
  expect((await f.run((tx) => getEncounterClosing(tx, ...f.args, f.encounter.id))).sessions).toEqual({
    finishing: [],
    continuing: [{ planItemId: item.id, title: "Tratamiento propio", n: 1, m: 2 }],
    notRegistered: [],
  })
  // Lo que no se trabajó en esta atención no se responde.
  await expect(
    f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id, { completePlanItemIds: [randomUUID()] })),
  ).rejects.toMatchObject({ code: "VALIDATION" })
  await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  expect((await statusOf()).status).toBe("en_curso")

  // Segunda: llega a las previstas y pregunta. «Falta otra sesión» la deja en curso con una más.
  const second = await attention(f)
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, second, { planItemId: item.id }))
  expect((await f.run((tx) => getEncounterClosing(tx, ...f.args, second))).sessions.finishing).toEqual([
    { planItemId: item.id, title: "Tratamiento propio", n: 2, m: 2 },
  ])
  await expect(
    f.run((tx) => finalizeEncounter(tx, ...f.args, second, { completePlanItemIds: [item.id], addSessionPlanItemIds: [item.id] })),
  ).rejects.toMatchObject({ code: "VALIDATION" })
  await f.run((tx) => finalizeEncounter(tx, ...f.args, second, { addSessionPlanItemIds: [item.id] }))
  expect(await statusOf()).toMatchObject({ status: "en_curso", plannedSessions: 3 })

  // Tercera: «Sí, terminar» lo completa en la misma firma.
  const third = await attention(f)
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, third, { planItemId: item.id }))
  expect((await f.run((tx) => getEncounterClosing(tx, ...f.args, third))).sessions.finishing).toMatchObject([{ n: 3, m: 3 }])
  await f.run((tx) => finalizeEncounter(tx, ...f.args, third, { completePlanItemIds: [item.id] }))
  expect(await statusOf()).toMatchObject({ status: "realizado" })
  const [link] = await ownerDb.execute<{ n: number }>(
    sql`select count(*)::int as n from encounter_plan_item where plan_item_id = ${item.id} and encounter_id = ${third}`,
  )
  expect(link!.n).toBe(1)
})

it("D5: el servicio directo avisa si ya se hizo en esa pieza: en curso queda como su sesión; realizado hace poco, que es un acto nuevo; una consulta sin pieza no avisa", async () => {
  const f = await clinicalFixture()
  const [endo] = await ownerDb
    .insert(serviceCatalog)
    .values({ organizationId: "org_a", name: "Endodoncia", scope: "tooth", source: "custom", priceCents: 50_000, currency: "PEN" })
    .returning()
  const earlier = (toothNumber: number) =>
    f.run((tx) => findEarlierTreatment(tx, "org_a", f.patient.id, f.encounter.id, { serviceId: endo!.id, toothNumber }))
  expect(await earlier(46)).toBeNull()
  // Sesión 1 como servicio directo: queda un tratamiento realizado de la 46.
  const direct = await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { serviceId: endo!.id, toothNumber: 46 }))
  const found = await earlier(46)
  expect(found).toMatchObject({ planItemId: direct.planItemId, title: "Endodoncia", status: "realizado", n: 2, m: 1, site: { toothNumber: 46 } })
  expect(found!.lastDoneAt).toBeInstanceOf(Date)
  // Otra pieza no es el mismo tratamiento.
  expect(await earlier(36)).toBeNull()
  // Pasados 60 días ya no avisa.
  await ownerDb
    .update(treatmentPlanItem)
    .set({ completedAt: new Date(Date.now() - 61 * DAY) })
    .where(eq(treatmentPlanItem.id, direct.planItemId!))
  expect(await earlier(46)).toBeNull()

  // En curso (aceptado de dos sesiones, con la primera hecha): se ofrece como su sesión 2.
  const planned = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: endo!.id, planId: f.plan.id, sourceEncounterId: f.encounter.id, toothNumber: 36, plannedSessions: 2 }),
  )
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: planned.id, acceptWhenDone: true }))
  expect(await earlier(36)).toMatchObject({ planItemId: planned.id, status: "en_curso", n: 2, m: 2 })

  // Una consulta sin pieza se repite sin ser otra sesión: no avisa.
  const [consult] = await ownerDb
    .insert(serviceCatalog)
    .values({ organizationId: "org_a", name: "Consulta", scope: "general", source: "custom", priceCents: 5_000, currency: "PEN" })
    .returning()
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { serviceId: consult!.id }))
  expect(await f.run((tx) => findEarlierTreatment(tx, "org_a", f.patient.id, f.encounter.id, { serviceId: consult!.id }))).toBeNull()
})

it("D4: si la cita traía el tratamiento y no se registró su sesión, el cierre lo avisa sin frenar la firma", async () => {
  const f = await clinicalFixture()
  const item = await acceptedTreatment(f, 2)
  const { book } = await agenda(f)
  const visit = await book(1, { planItemIds: [item.id] })
  // La atención abierta de la persona viene de esa cita.
  await ownerDb.update(encounter).set({ appointmentId: visit.id }).where(eq(encounter.id, f.encounter.id))
  await f.ready(f.encounter.id)
  const today = f.encounter.id
  expect((await f.run((tx) => getEncounterClosing(tx, ...f.args, today))).sessions).toEqual({
    finishing: [],
    continuing: [],
    notRegistered: [{ planItemId: item.id, title: "Tratamiento propio", n: 1, m: 2 }],
  })
  // Registrada la sesión, ya no es un aviso: sigue en curso.
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, today, { planItemId: item.id }))
  expect((await f.run((tx) => getEncounterClosing(tx, ...f.args, today))).sessions).toMatchObject({
    continuing: [{ planItemId: item.id, n: 1, m: 2 }],
    notRegistered: [],
  })
})

it("D4: «Falta otra sesión» no cambia lo que se cobra en esa firma: por sesión y sin presupuesto, la de más no se cobra", async () => {
  const f = await clinicalFixture()
  await ownerDb.update(serviceCatalog).set({ billingMode: "session", priceCents: 15_000 }).where(eq(serviceCatalog.id, f.service.id))
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id, plannedSessions: 2 }),
  )
  // Aceptado sin presupuesto: el tope son sus sesiones previstas.
  await ownerDb.update(treatmentPlanItem).set({ decisionStatus: "aceptado" }).where(eq(treatmentPlanItem.id, item.id))
  await ownerDb.execute(sql`update encounter set status = 'finalizada', signer_name = 'Clínico', signer_registration = 'COP 1' where id = ${f.encounter.id}`)
  const charged = []
  for (const answer of [{}, { addSessionPlanItemIds: [item.id] }, { addSessionPlanItemIds: [item.id] }]) {
    const visit = await attention(f)
    await f.run((tx) => addEncounterProcedure(tx, ...f.args, visit, { planItemId: item.id }))
    const closed = await f.run((tx) => finalizeEncounter(tx, ...f.args, visit, answer))
    charged.push(closed.billing.lines.map((line) => line.reason ?? line.amountCents))
    // Como quedó lo firmado antes de terminar por omisión: abierto con sus previstas ya hechas.
    if (charged.length === 2) await ownerDb.update(treatmentPlanItem).set({ plannedSessions: 2 }).where(eq(treatmentPlanItem.id, item.id))
  }
  expect(charged).toEqual([[15_000], [15_000], ["sessions_complete"]])
  const [after] = await ownerDb.select().from(treatmentPlanItem).where(eq(treatmentPlanItem.id, item.id))
  expect(after).toMatchObject({ status: "en_curso", plannedSessions: 4 })
})

it("X1: lo que llega a sus sesiones previstas se termina al firmar sin responder; lo que no llega sigue en curso", async () => {
  const f = await clinicalFixture()
  // Una resina de una sesión y una endodoncia de dos, aceptadas y hechas hoy.
  const resin = await acceptedTreatment(f, 1)
  const endo = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id, plannedSessions: 2 }),
  )
  await ownerDb.update(treatmentPlanItem).set({ decisionStatus: "aceptado" }).where(eq(treatmentPlanItem.id, endo.id))
  await f.ready(f.encounter.id)
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: resin.id }))
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: endo.id }))
  expect((await f.run((tx) => getEncounterClosing(tx, ...f.args, f.encounter.id))).sessions).toMatchObject({
    finishing: [{ planItemId: resin.id, n: 1, m: 1 }],
    continuing: [{ planItemId: endo.id, n: 1, m: 2 }],
  })
  // Firmar sin tocar «¿Terminaste?»: la resina queda realizada en esta atención.
  await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  const statusOf = async (id: string) => (await ownerDb.select().from(treatmentPlanItem).where(eq(treatmentPlanItem.id, id)))[0]!
  expect(await statusOf(resin.id)).toMatchObject({ status: "realizado", plannedSessions: 1 })
  expect((await statusOf(resin.id)).completedAt).toBeInstanceOf(Date)
  expect(await statusOf(endo.id)).toMatchObject({ status: "en_curso", plannedSessions: 2 })
  // Ya no la piden como pendiente: solo falta la segunda sesión de la endodoncia.
  const next = await f.run((tx) => getPlanNextStep(tx, "org_a", f.patient.id, all))
  expect(next).toMatchObject({ kind: "continuar", action: { planItemIds: [endo.id] } })
  const coordination = (await f.run((tx) => getTreatmentCoordination(tx, "org_a", f.patient.id))).treatments
  expect(coordination.map((t) => t.id)).toEqual([endo.id])
})

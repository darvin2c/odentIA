/**
 * Ventas que se mueven solas, tareas que se cierran solas (ADR 0028): la
 * oportunidad avanza con lo que pasa de verdad (una cita, un presupuesto, su
 * respuesta), por la misma operación que el movimiento a mano, y las tareas se
 * ven por «Mías y de mi área» con páginas y búsqueda en el servidor.
 */
import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { scheduleChair } from "@odentia/db/schema/agenda"
import { member, user } from "@odentia/db/schema/auth"
import { patientContact } from "@odentia/db/schema/clinical"
import { branch } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { createAppointment, setAppointmentStatus } from "./appointments.js"
import { createBudget, decideBudget, deliverBudget } from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { createContact } from "./contacts.js"
import { closeOpportunity, createOpportunity, dayWords, getOpportunity, listOpportunities } from "./opportunities.js"
import { addPlanItem } from "./plan.js"
import { completeTask, createTask, pageTasks } from "./tasks.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const DAY = 86_400_000
const LIMA = { timezone: "America/Lima", locale: "es-PE" }

/** La propia persona del paciente del fixture (la crea la base con la ficha). */
async function ownContact(patientId: string): Promise<string> {
  const [link] = await ownerDb
    .select({ contactId: patientContact.contactId })
    .from(patientContact)
    .where(and(eq(patientContact.patientId, patientId), eq(patientContact.relationship, "self")))
  return link!.contactId
}

let place: { branchId: string; chairId: string } | null = null
async function agendaPlace(): Promise<{ branchId: string; chairId: string }> {
  if (place) return place
  const [site] = await ownerDb.insert(branch).values({ organizationId: "org_a", name: "Centro", timezone: "America/Lima" }).returning({ id: branch.id })
  const [chair] = await ownerDb.insert(scheduleChair).values({ organizationId: "org_a", branchId: site!.id, name: "Unidad dental 1" }).returning({ id: scheduleChair.id })
  place = { branchId: site!.id, chairId: chair!.id }
  return place
}

it("agendar una cita mueve sola su oportunidad «Interesado» y la tarjeta dice por qué; las demás no se tocan", async () => {
  const f = await clinicalFixture()
  const contactId = await ownContact(f.patient.id)
  const { branchId, chairId } = await agendaPlace()
  const older = await f.run((tx) => createOpportunity(tx, "org_a", { contactId, title: "Limpieza" }, { userId: f.actor }))
  const wanted = await f.run((tx) =>
    createOpportunity(tx, "org_a", { contactId, title: "Tratamiento", serviceId: f.service.id }, { userId: null, origin: "agente" }),
  )
  // Con servicio, el valor sale de la lista de precios.
  expect(wanted).toMatchObject({ amountCents: 120000, currency: "PEN", amountFromPriceList: true, moment: "interesado" })
  // Hora fija: con la del reloj, una corrida entre las 03:00 y las 04:00 UTC
  // chocaba en la misma unidad dental con la cita de la prueba de cancelar.
  const startsAt = new Date(Date.now() + 3 * DAY)
  startsAt.setUTCHours(15, 0, 0, 0)
  await f.run((tx) =>
    createAppointment(tx, "org_a", f.actor, {
      branchId, chairId, patientId: f.patient.id, dentistUserId: f.actor, serviceId: f.service.id,
      startsAt: startsAt.toISOString(), outsideSchedule: true,
    }),
  )
  const moved = await f.run((tx) => getOpportunity(tx, "org_a", wanted.id, { appointments: true }))
  expect(moved).toMatchObject({
    moment: "evaluacion_agendada",
    why: `Pasó sola: agendó su evaluación para ${dayWords(startsAt, new Date(), LIMA)}`,
    after: "Cuando se presente el presupuesto, avanza sola",
  })
  expect(moved.nextAppointment?.text).toContain("Tratamiento propio")
  expect(moved.history.at(-1)).toMatchObject({ origin: "automatico", who: "Automático" })
  expect(moved.history.at(-1)?.what).toMatch(/^Pasó sola a «Evaluación agendada»: agendó su evaluación para /)
  // La del otro interés sigue donde estaba.
  expect((await f.run((tx) => getOpportunity(tx, "org_a", older.id))).moment).toBe("interesado")
})

it("el presupuesto se une solo a la del mismo tratamiento y la mueve; aceptarlo la gana, rechazarlo la pierde", async () => {
  const f = await clinicalFixture()
  const contactId = await ownContact(f.patient.id)
  const same = await f.run((tx) => createOpportunity(tx, "org_a", { contactId, title: "Tratamiento", serviceId: f.service.id }))
  const newest = await f.run((tx) => createOpportunity(tx, "org_a", { contactId, title: "Blanqueamiento" }))
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }),
  )
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  const linked = await f.run((tx) => getOpportunity(tx, "org_a", same.id))
  expect(linked).toMatchObject({ budgetId: budget.id, patientId: f.patient.id, moment: "presupuesto_enviado" })
  expect(linked.why).toBe("Pasó sola: presupuesto presentado hoy")
  expect((await f.run((tx) => getOpportunity(tx, "org_a", newest.id))).budgetId).toBeNull()
  await f.run((tx) => decideBudget(tx, ...f.args, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] }))
  expect(await f.run((tx) => getOpportunity(tx, "org_a", same.id))).toMatchObject({
    status: "won", moment: "decidio", closeReason: "acepto_presupuesto", why: "Ganada: aceptó el presupuesto",
  })

  // Otra persona: sin oportunidad del mismo tratamiento, va a la más reciente; rechazarlo la pierde.
  const g = await clinicalFixture()
  const other = await ownContact(g.patient.id)
  await g.run((tx) => createOpportunity(tx, "org_a", { contactId: other, title: "Primero" }))
  const recent = await g.run((tx) => createOpportunity(tx, "org_a", { contactId: other, title: "Lo más reciente" }))
  const plan = await g.run((tx) => addPlanItem(tx, ...g.args, { serviceId: g.service.id, planId: g.plan.id, sourceEncounterId: g.encounter.id }))
  const offer = await g.run((tx) => createBudget(tx, ...g.args, { planId: g.plan.id, itemIds: [plan.id] }))
  await g.run((tx) => deliverBudget(tx, ...g.args, offer.id))
  await g.run((tx) => decideBudget(tx, ...g.args, offer.id, { decisions: [{ planItemId: plan.id, decision: "rechazado" }] }))
  expect(await g.run((tx) => getOpportunity(tx, "org_a", recent.id))).toMatchObject({
    status: "lost", closeReason: "rechazo_presupuesto", why: "Perdida: «Rechazó el presupuesto»",
  })
})

it("cancelar la evaluación la devuelve sola a «Interesado» si no le queda otra cita; con otra por venir, no", async () => {
  const f = await clinicalFixture()
  const contactId = await ownContact(f.patient.id)
  const { branchId, chairId } = await agendaPlace()
  const opp = await f.run((tx) => createOpportunity(tx, "org_a", { contactId, title: "Evaluación", serviceId: f.service.id }))
  // Horas que no usa otra prueba de la misma unidad dental.
  const at = (days: number) => {
    const date = new Date(Date.now() + days * DAY)
    date.setUTCHours(3, 0, 0, 0)
    return date
  }
  const book = (startsAt: Date) =>
    f.run((tx) =>
      createAppointment(tx, "org_a", f.actor, {
        branchId, chairId, patientId: f.patient.id, dentistUserId: f.actor, serviceId: f.service.id,
        startsAt: startsAt.toISOString(), outsideSchedule: true,
      }),
    )
  const first = await book(at(3))
  const second = await book(at(6))
  expect((await f.run((tx) => getOpportunity(tx, "org_a", opp.id))).moment).toBe("evaluacion_agendada")
  // Le queda otra cita por venir: no vuelve.
  await f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, first.id, "cancelada"))
  expect((await f.run((tx) => getOpportunity(tx, "org_a", opp.id))).moment).toBe("evaluacion_agendada")
  // Sin ninguna, vuelve sola y la tarjeta dice por qué, con la fecha de la cita cancelada.
  await f.run((tx) => setAppointmentStatus(tx, "org_a", f.actor, second.id, "cancelada"))
  const back = await f.run((tx) => getOpportunity(tx, "org_a", opp.id))
  expect(back).toMatchObject({ moment: "interesado", status: "open" })
  expect(back.why).toMatch(/^Volvió sola: canceló su evaluación del \S+ \d+$/)
  expect(back.history.at(-1)).toMatchObject({ origin: "automatico", who: "Automático" })
  expect(back.history.at(-1)?.what).toMatch(/^Volvió sola a «Interesado»: canceló su evaluación del /)
})

it("al presentar el presupuesto su total es el valor de la oportunidad; aceptado en parte, lo aceptado", async () => {
  const f = await clinicalFixture()
  const contactId = await ownContact(f.patient.id)
  const opp = await f.run((tx) => createOpportunity(tx, "org_a", { contactId, title: "Ortodoncia" }))
  expect(opp.amountCents).toBeNull()
  const one = await f.run((tx) => addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }))
  const two = await f.run((tx) => addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }))
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [one.id, two.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  expect(await f.run((tx) => getOpportunity(tx, "org_a", opp.id))).toMatchObject({
    amountCents: 240000, currency: "PEN", amountFromBudget: true, amountFromPriceList: false, moment: "presupuesto_enviado",
  })
  await f.run((tx) =>
    decideBudget(tx, ...f.args, budget.id, {
      decisions: [{ planItemId: one.id, decision: "aceptado" }, { planItemId: two.id, decision: "rechazado" }],
    }),
  )
  expect(await f.run((tx) => getOpportunity(tx, "org_a", opp.id))).toMatchObject({ status: "won", amountCents: 120000 })
})

it("el equipo no duplica una oportunidad abierta del mismo interés; cerrada, sí puede abrir otra", async () => {
  const person = await withOrgContext(appDb, "org_a", (tx) => createContact(tx, "org_a", { displayName: `Duplicado ${randomUUID().slice(0, 6)}` }))
  const first = await withOrgContext(appDb, "org_a", (tx) => createOpportunity(tx, "org_a", { contactId: person.id, title: "Implante" }))
  await expect(withOrgContext(appDb, "org_a", (tx) => createOpportunity(tx, "org_a", { contactId: person.id, title: " implante " })))
    .rejects.toMatchObject({ code: "OPPORTUNITY_EXISTS", status: 409 })
  await withOrgContext(appDb, "org_a", (tx) => closeOpportunity(tx, "org_a", first.id, { outcome: "lost", reason: "precio" }))
  const again = await withOrgContext(appDb, "org_a", (tx) => createOpportunity(tx, "org_a", { contactId: person.id, title: "Implante" }))
  expect(again.id).not.toBe(first.id)
  const listed = await withOrgContext(appDb, "org_a", (tx) => listOpportunities(tx, "org_a", { contactId: person.id, limit: 5 }))
  expect(listed.items.map((o) => o.status).sort()).toEqual(["lost", "open"])
})

it("tareas: se abren en «Mías y de mi área»; «Toda la clínica», vencidas, hechas, búsqueda y páginas los decide el servidor", async () => {
  const orgId = "org_b"
  const me = randomUUID()
  const other = randomUUID()
  await ownerDb.insert(user).values([
    { id: me, name: "Recepcionista", email: `${me}@tareas.test`, emailVerified: true },
    { id: other, name: "Cajera", email: `${other}@tareas.test`, emailVerified: true },
  ])
  await ownerDb.insert(member).values([
    { id: randomUUID(), organizationId: orgId, userId: me, role: "reception", createdAt: new Date() },
    { id: randomUUID(), organizationId: orgId, userId: other, role: "cashier", createdAt: new Date() },
  ])
  const run = <T>(fn: Parameters<typeof withOrgContext<T>>[2]) => withOrgContext(appDb, orgId, fn)
  const tag = randomUUID().slice(0, 6)
  const make = (title: string, extra: Record<string, unknown> = {}) =>
    run((tx) => createTask(tx, orgId, { title: `${title} ${tag}`, createdBy: "user", ...extra }))
  const past = new Date(Date.now() - DAY).toISOString()
  const soon = new Date(Date.now() + DAY).toISOString()
  const mine = await make("Mía vencida", { assigneeUserId: me, dueAt: past })
  const area = await make("De recepción", { area: "recepcion", dueAt: soon })
  const cash = await make("De caja", { area: "caja" })
  const theirs = await make("De la cajera", { assigneeUserId: other })
  const done = await make("Mía hecha", { assigneeUserId: me })
  await run((tx) => completeTask(tx, orgId, done.id))
  const ids = (page: { items: Array<{ id: string }> }) => page.items.map((t) => t.id)
  const viewer = { userId: me, areas: ["recepcion"], all: false }
  // «Mías y de mi área»: las suyas y las sin responsable de recepción; lo que vence antes primero.
  const open = await run((tx) => pageTasks(tx, orgId, { viewer, q: tag }))
  expect(ids(open)).toEqual([mine.id, area.id])
  expect(open.total).toBe(2)
  // Vencidas son siempre abiertas.
  expect(ids(await run((tx) => pageTasks(tx, orgId, { viewer, view: "vencidas", q: tag })))).toEqual([mine.id])
  expect(ids(await run((tx) => pageTasks(tx, orgId, { viewer, view: "hechas", q: tag })))).toEqual([done.id])
  // «Toda la clínica» trae también las de otras personas y áreas.
  const all = await run((tx) => pageTasks(tx, orgId, { viewer: { ...viewer, all: true }, q: tag }))
  expect(new Set(ids(all))).toEqual(new Set([mine.id, area.id, cash.id, theirs.id]))
  // Buscar por el nombre de la persona y paginar sin perder filas.
  const page1 = await run((tx) => pageTasks(tx, orgId, { viewer: { ...viewer, all: true }, q: tag, limit: 3 }))
  expect(page1.items).toHaveLength(3)
  expect(page1.total).toBe(4)
  const page2 = await run((tx) => pageTasks(tx, orgId, { viewer: { ...viewer, all: true }, q: tag, limit: 3, cursor: page1.nextCursor! }))
  expect(new Set([...ids(page1), ...ids(page2)])).toEqual(new Set(ids(all)))
  expect(page2.nextCursor).toBeNull()
  // Un cursor de otra búsqueda no vale.
  await expect(run((tx) => pageTasks(tx, orgId, { viewer, q: "otra", cursor: page1.nextCursor! }))).rejects.toMatchObject({ status: 400 })
})

it("una tarea de un paciente dice de quién es: queda en su propia persona", async () => {
  const f = await clinicalFixture()
  const contactId = await ownContact(f.patient.id)
  const task = await f.run((tx) => createTask(tx, "org_a", { title: "Llamar por su control", patientId: f.patient.id, createdBy: "admin", area: "recepcion" }))
  expect(task).toMatchObject({ patientId: f.patient.id, contactId, contactName: "Paciente de prueba" })
})

import { randomUUID } from "node:crypto"
import { type Db, withOrgContext } from "@odentia/db"
import { appointment, scheduleRoom } from "@odentia/db/schema/agenda"
import { member, user } from "@odentia/db/schema/auth"
import {
  appointmentPlanItem,
  clinicalFollowUp,
  treatmentBudget,
  treatmentBudgetItem,
  treatmentBudgetOption,
  treatmentPlan,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { agentConfig } from "@odentia/db/schema/crm"
import { branch } from "@odentia/db/schema/org"
import { eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { countOverdueControls, getAdminRecommendation } from "./agent-admin.js"
import { peopleShortcutMembers } from "./people-shortcuts.js"
import { nextPatientNumber } from "./patients.js"
import { getPlanNextStep } from "./plan-next.js"
import { upcomingWork } from "./report-finance.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"
import { insertTestPatients } from "./test-patient.js"
import {
  isOverdueControl,
  isToSchedule,
  overdueControlSql,
  patientsToSchedule,
  patientsWithOverdueControl,
  toScheduleSql,
} from "./to-schedule.js"
import { getWorkspaceHome, type WorkspaceAccess } from "./workspace.js"

setupTestDb()

const DAY = 86_400_000
const LIMA = "America/Lima"
const all = () => true
const reception: WorkspaceAccess = {
  patients: true, appointments: true, conversations: false, tasks: false, finance: true, clinical: false,
  crm: false, agent: false, allTasks: false, configure: false, ownAppointments: false,
}

interface Clinic {
  orgId: string
  actor: string
  branchId: string
  roomId: string
  run: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>
}

async function clinic(): Promise<Clinic> {
  const orgId = randomUUID()
  const actor = `dra-${orgId}`
  await insertOrg(ownerDb, orgId, `agendar-${orgId}`)
  await ownerDb.insert(user).values({ id: actor, name: "Dra. Vela", email: `${actor}@agendar.test`, emailVerified: true })
  await ownerDb.insert(member).values({ id: `m-${actor}`, userId: actor, organizationId: orgId, role: "owner", createdAt: new Date() })
  const [site] = await ownerDb.insert(branch).values({ organizationId: orgId, name: "Centro", timezone: LIMA }).returning({ id: branch.id })
  const [room] = await ownerDb.insert(scheduleRoom).values({ organizationId: orgId, branchId: site!.id, name: "Unidad 1" }).returning({ id: scheduleRoom.id })
  return { orgId, actor, branchId: site!.id, roomId: room!.id, run: (fn) => withOrgContext(appDb, orgId, fn) }
}

async function person(c: Clinic, name: string, isActive = true): Promise<string> {
  const [row] = await insertTestPatients(ownerDb, {
    organizationId: c.orgId, displayName: name, givenNames: name.split(" ")[0], patientNumber: await nextPatientNumber(ownerDb, c.orgId), isActive,
  })
  return row!.id
}

let number = 7000
/** Un tratamiento aceptado en un presupuesto aceptado hace `daysAgo` días, a S/ 100. */
async function accepted(c: Clinic, patientId: string, status = "pendiente", daysAgo = 10): Promise<string> {
  const [plan] = await ownerDb.insert(treatmentPlan).values({ organizationId: c.orgId, patientId, title: "Plan" }).returning({ id: treatmentPlan.id })
  const [item] = await ownerDb
    .insert(treatmentPlanItem)
    .values({ organizationId: c.orgId, patientId, planId: plan!.id, title: "Corona", currency: "PEN", priceCents: 10_000, status, decisionStatus: "aceptado" })
    .returning({ id: treatmentPlanItem.id })
  const [budget] = await ownerDb
    .insert(treatmentBudget)
    .values({ organizationId: c.orgId, patientId, planId: plan!.id, budgetNumber: number++, title: "Corona", currency: "PEN", status: "borrador" })
    .returning({ id: treatmentBudget.id })
  const optionId = randomUUID()
  await ownerDb.insert(treatmentBudgetOption).values({ id: optionId, organizationId: c.orgId, patientId, budgetId: budget!.id, position: 1, isRecommended: true })
  await ownerDb.insert(treatmentBudgetItem).values({
    organizationId: c.orgId, patientId, planId: plan!.id, budgetId: budget!.id, optionId, planItemId: item!.id,
    title: "Corona", currency: "PEN", priceCents: 10_000, decision: "aceptado",
  })
  await ownerDb.update(treatmentBudget).set({ status: "aceptado", decidedAt: new Date(Date.now() - daysAgo * DAY) }).where(eq(treatmentBudget.id, budget!.id))
  return item!.id
}

/** Una cita en `daysAhead` días; `carries` son los tratamientos que lleva. */
async function bookIn(c: Clinic, patientId: string, daysAhead: number, carries: string[] = []): Promise<string> {
  const startsAt = new Date(Date.now() + daysAhead * DAY)
  const [row] = await ownerDb
    .insert(appointment)
    .values({
      organizationId: c.orgId, branchId: c.branchId, patientId, professionalUserId: c.actor, roomId: c.roomId,
      startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), durationMin: 30, status: "programada",
    })
    .returning({ id: appointment.id })
  for (const planItemId of carries) {
    await ownerDb.insert(appointmentPlanItem).values({ organizationId: c.orgId, patientId, appointmentId: row!.id, planItemId })
  }
  return row!.id
}

it("«aceptó y no tiene cita» es una sola regla: código, SQL, Pacientes, Inicio, Reportes y Argos dicen lo mismo", async () => {
  const c = await clinic()
  const ana = await person(c, "Ana Paz")
  const beto = await person(c, "Beto Paz")
  const caro = await person(c, "Caro Paz")
  const dani = await person(c, "Dani Paz")
  const eva = await person(c, "Eva Paz")
  const fede = await person(c, "Fede Paz", false)
  await accepted(c, ana)
  // Beto tiene una limpieza mañana que no lleva su corona: la corona sigue sin cita.
  await accepted(c, beto)
  await bookIn(c, beto, 1)
  // La cita de Caro lleva su corona.
  await bookIn(c, caro, 2, [await accepted(c, caro)])
  // Lo de Dani va por sesiones y no tiene la siguiente; lo de Eva está suspendido.
  await accepted(c, dani, "en_curso")
  await accepted(c, eva, "suspendido")
  // Fede está archivado.
  await accepted(c, fede)
  // A Gabi se le deshizo la atención que lo había hecho: vuelve a estar por agendar.
  const gabi = await person(c, "Gabi Paz")
  await accepted(c, gabi, "programado")

  // La regla en código y en SQL dicen lo mismo de cada tratamiento.
  const items = await c.run((tx) =>
    tx.execute<{ id: string; status: string; decisionStatus: string; carried: boolean; due: boolean }>(sql`
      select i.id, i.status, i.decision_status as "decisionStatus",
        exists (select 1 from appointment_plan_item x join appointment a on a.id = x.appointment_id
          where x.plan_item_id = i.id and a.status in ('programada','confirmada') and a.starts_at > now()) as carried,
        ${toScheduleSql({ id: sql`i.id`, organizationId: sql`i.organization_id`, status: sql`i.status`, decisionStatus: sql`i.decision_status` })} as due
      from treatment_plan_item i where i.organization_id = ${c.orgId}`),
  )
  const carried = new Set(items.filter((row) => row.carried).map((row) => row.id))
  for (const row of items) expect(isToSchedule(row, carried)).toBe(row.due)

  const expected = [ana, beto, dani, gabi].sort()
  expect((await c.run((tx) => patientsToSchedule(tx, c.orgId))).sort()).toEqual(expected)
  // Pacientes › «Por agendar»: la misma regla.
  const members = await c.run((tx) => peopleShortcutMembers(tx, c.orgId, all, LIMA, new Date(), "por_agendar"))
  expect(members.por_agendar?.sort()).toEqual(expected)
  // Reportes («No tienen cita») e Inicio: el mismo número, y lo que suma.
  const work = await c.run((tx) => upcomingWork(tx, c.orgId, "PEN", new Date()))
  expect(work.unbooked).toEqual({ patients: 4, cents: 40_000 })
  const home = await c.run((tx) => getWorkspaceHome(tx, c.orgId, c.actor, reception, { can: all }))
  expect(home.waiting.find((row) => row.kind === "acceptedUnbooked")).toMatchObject({ patients: 4, cents: 40_000 })
  // Argos: la misma regla con sus días, un caso por presupuesto; la fila de Beto dice su otra cita.
  const argos = await c.run((tx) => getAdminRecommendation(tx, c.orgId, all, "presupuestos_sin_cita"))
  expect(argos.total).toBe(4)
  expect(argos.items.map((item) => item.patientId).sort()).toEqual(expected)
  expect(argos.items.find((item) => item.patientId === beto)?.line).toMatch(/· su cita del .+ no lo lleva$/)
  expect(argos.items.find((item) => item.patientId === dani)?.line).toMatch(/^Falta la cita de la próxima sesión · /)
  expect(await c.run((tx) => getPlanNextStep(tx, c.orgId, gabi, all))).toMatchObject({ kind: "agendar" })
  // «Qué sigue» de Beto dice que su cita no la lleva, no que le falta una.
  expect((await c.run((tx) => getPlanNextStep(tx, c.orgId, beto, all))).text).toMatch(/^Aceptó todo: su cita del .+ no lo lleva$/)

  // Con un presupuesto por enviar, «Qué sigue» pide enviarlo, y sigue en «Por agendar».
  const [plan] = await ownerDb.insert(treatmentPlan).values({ organizationId: c.orgId, patientId: ana, title: "Otro plan" }).returning({ id: treatmentPlan.id })
  const [other] = await ownerDb
    .insert(treatmentPlanItem)
    .values({ organizationId: c.orgId, patientId: ana, planId: plan!.id, title: "Limpieza", currency: "PEN", priceCents: 5_000 })
    .returning({ id: treatmentPlanItem.id })
  const [draft] = await ownerDb
    .insert(treatmentBudget)
    .values({ organizationId: c.orgId, patientId: ana, planId: plan!.id, budgetNumber: number++, title: "Limpieza", currency: "PEN", status: "borrador" })
    .returning({ id: treatmentBudget.id })
  const optionId = randomUUID()
  await ownerDb.insert(treatmentBudgetOption).values({ id: optionId, organizationId: c.orgId, patientId: ana, budgetId: draft!.id, position: 1 })
  await ownerDb.insert(treatmentBudgetItem).values({
    organizationId: c.orgId, patientId: ana, planId: plan!.id, budgetId: draft!.id, optionId, planItemId: other!.id, title: "Limpieza", currency: "PEN", priceCents: 5_000,
  })
  expect((await c.run((tx) => getPlanNextStep(tx, c.orgId, ana, all))).kind).toBe("enviar")
  const both = await c.run((tx) => peopleShortcutMembers(tx, c.orgId, all, LIMA, new Date()))
  expect(both.por_agendar).toContain(ana)
  expect(both.presupuesto_sin_enviar).toContain(ana)
})

it("«control vencido sin cita»: su día ya pasó y la persona no tiene ninguna cita; Pacientes, Inicio y Argos dicen lo mismo", async () => {
  const c = await clinic()
  const hugo = await person(c, "Hugo Rey")
  const iris = await person(c, "Iris Rey")
  const juan = await person(c, "Juan Rey")
  const kira = await person(c, "Kira Rey")
  const control = (patientId: string, dueAt: Date, status = "pendiente", appointmentId?: string) =>
    ownerDb.insert(clinicalFollowUp).values({ organizationId: c.orgId, patientId, kind: "mantenimiento", title: "Control de presión", dueAt, status, appointmentId })
  await control(hugo, new Date(Date.now() - 5 * DAY))
  // Iris tiene una cita por venir: a un control le sirve cualquier visita.
  await control(iris, new Date(Date.now() - 5 * DAY))
  await bookIn(c, iris, 3)
  // A Juan le toca hoy; el de Kira ya tiene su cita.
  await control(juan, new Date())
  await control(kira, new Date(Date.now() - 5 * DAY), "programado", await bookIn(c, kira, 4))

  // La regla en código y en SQL dicen lo mismo de cada control.
  const rows = await c.run((tx) =>
    tx.execute<{ status: string; dueAt: string; next: string | null; due: boolean }>(sql`
      select f.status, f.due_at as "dueAt",
        (select min(a.starts_at) from appointment a where a.patient_id = f.patient_id and a.status in ('programada','confirmada') and a.starts_at > now()) as next,
        ${overdueControlSql({ organizationId: sql`f.organization_id`, patientId: sql`f.patient_id`, status: sql`f.status`, dueAt: sql`f.due_at` }, LIMA)} as due
      from clinical_follow_up f where f.organization_id = ${c.orgId}`),
  )
  for (const row of rows) {
    expect(isOverdueControl({ status: row.status, dueAt: new Date(row.dueAt) }, row.next ? new Date(row.next) : null, LIMA)).toBe(row.due)
  }

  expect(await c.run((tx) => patientsWithOverdueControl(tx, c.orgId, LIMA))).toEqual([hugo])
  const members = await c.run((tx) => peopleShortcutMembers(tx, c.orgId, all, LIMA, new Date(), "control_por_reservar"))
  expect(members.control_por_reservar).toEqual([hugo])
  expect(await c.run((tx) => countOverdueControls(tx, c.orgId))).toEqual({ controls: 1, patients: 1 })
  expect((await c.run((tx) => getAdminRecommendation(tx, c.orgId, all, "recordatorio_control"))).title).toBe("1 control vencido de un paciente sin cita")
  // «Qué sigue»: Iris tiene cita, no está «por reservar»; a Juan le toca hoy.
  expect(await c.run((tx) => getPlanNextStep(tx, c.orgId, iris, all))).toMatchObject({ text: expect.stringMatching(/^Control de presión · tiene cita el /), action: { label: "Ver la cita" } })
  expect(await c.run((tx) => getPlanNextStep(tx, c.orgId, juan, all))).toMatchObject({ text: "Control de presión · por reservar", detail: expect.stringMatching(/^Toca el /) })

  // Inicio, con Argos apagado: la fila con la misma cuenta. Encendido, es su línea y no se repite.
  const rowOf = async () =>
    (await c.run((tx) => getWorkspaceHome(tx, c.orgId, c.actor, reception, { can: all }))).waiting.find((row) => row.kind === "overdueControls")
  expect(await rowOf()).toMatchObject({ controls: 1, patients: 1 })
  await ownerDb.insert(agentConfig).values({ organizationId: c.orgId, enabled: true, advisor: { enabled: true } })
  expect(await rowOf()).toBeUndefined()
})

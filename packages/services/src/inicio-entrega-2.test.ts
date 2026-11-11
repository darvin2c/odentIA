/**
 * Inicio y Agenda, entrega 2 (mesa del 10 nov): «Llegó tu paciente» en el equipo de
 * quien atiende, la derivación de un colega con su fila, los controles propios del
 * odontólogo, la sede con citas hoy, la ausencia en todas las sedes y la cita
 * confirmada que se mueve a otro día.
 */
import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { appointment, scheduleRoom } from "@odentia/db/schema/agenda"
import { scheduleBlock } from "@odentia/db/schema/availability"
import { member, user } from "@odentia/db/schema/auth"
import { clinicalFollowUp } from "@odentia/db/schema/clinical"
import { crmTask } from "@odentia/db/schema/crm"
import { branch } from "@odentia/db/schema/org"
import { pushSubscription } from "@odentia/db/schema/workspace"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { moveAppointment } from "./appointments.js"
import { listScheduleBlocks } from "./availability.js"
import { listMyOverdueControls } from "./agent-admin.js"
import { collectOrgPushes, savePushSubscription } from "./push.js"
import { insertTestPatients } from "./test-patient.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"
import { getWorkspaceHome, type WorkspaceAccess, workspaceAccessFor } from "./workspace.js"
import type { WaitingRow } from "./workspace-home.js"

setupTestDb()

const rowsOf = <K extends WaitingRow["kind"]>(rows: WaitingRow[], kind: K) =>
  rows.filter((row): row is Extract<WaitingRow, { kind: K }> => row.kind === kind)

/** Una clínica con dos sedes, una unidad dental en cada una, recepción y dos odontólogos. */
async function clinic() {
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, `inicio2-${orgId.slice(0, 8)}`)
  const ids = { rita: randomUUID(), ana: randomUUID(), luis: randomUUID() }
  await ownerDb.insert(user).values([
    { id: ids.rita, name: "Rita Recepción", email: `${ids.rita}@inicio2.test`, emailVerified: true },
    { id: ids.ana, name: "Dra. Ana Torres", email: `${ids.ana}@inicio2.test`, emailVerified: true },
    { id: ids.luis, name: "Dr. Luis Rojas", email: `${ids.luis}@inicio2.test`, emailVerified: true },
  ])
  await ownerDb.insert(member).values([
    { id: randomUUID(), organizationId: orgId, userId: ids.rita, role: "reception", createdAt: new Date() },
    { id: randomUUID(), organizationId: orgId, userId: ids.ana, role: "clinician", createdAt: new Date() },
    { id: randomUUID(), organizationId: orgId, userId: ids.luis, role: "clinician", createdAt: new Date() },
  ])
  const [first] = await ownerDb
    .insert(branch)
    .values({ organizationId: orgId, name: "Centro", timezone: "America/Lima", createdAt: new Date(Date.now() - 60_000) })
    .returning({ id: branch.id })
  const [second] = await ownerDb.insert(branch).values({ organizationId: orgId, name: "Norte", timezone: "America/Lima" }).returning({ id: branch.id })
  const [roomA] = await ownerDb.insert(scheduleRoom).values({ organizationId: orgId, branchId: first!.id, name: "Unidad 1" }).returning({ id: scheduleRoom.id })
  const [roomB] = await ownerDb.insert(scheduleRoom).values({ organizationId: orgId, branchId: second!.id, name: "Unidad 1" }).returning({ id: scheduleRoom.id })
  const patient = async (name: string) =>
    (await insertTestPatients(ownerDb, { organizationId: orgId, displayName: name, patientNumber: Math.floor(Math.random() * 1_000_000) }))[0]!
  const book = async (input: { patientId: string; professional: string; branchId: string; roomId: string; startsAt: Date; status?: string }) =>
    (
      await ownerDb
        .insert(appointment)
        .values({
          organizationId: orgId, patientId: input.patientId, professionalUserId: input.professional, status: input.status ?? "confirmada",
          serviceName: "Control", branchId: input.branchId, roomId: input.roomId, startsAt: input.startsAt,
          endsAt: new Date(input.startsAt.getTime() + 30 * 60_000), durationMin: 30,
        })
        .returning()
    )[0]!
  const tx = <T>(fn: Parameters<typeof withOrgContext<T>>[2]) => withOrgContext(appDb, orgId, fn)
  return { orgId, ids, branches: { first: first!.id, second: second!.id }, rooms: { a: roomA!.id, b: roomB!.id }, patient, book, tx }
}

const clinicianAccess: WorkspaceAccess = { ...workspaceAccessFor("clinician") }

it("«Llegó tu paciente»: al profesional le llega cuando recepción marca la llegada, sin el nombre y solo en horario", async () => {
  const c = await clinic()
  const person = await c.patient("Rosa Quispe Mamani")
  // Lunes 16 de noviembre de 2026, 10:00 en Lima: una clínica sin horario cargado está abierta.
  const now = new Date("2026-11-16T15:00:00Z")
  await c.tx((db) =>
    savePushSubscription(db, c.orgId, c.ids.ana, workspaceAccessFor("clinician"), {
      endpoint: "https://fcm.googleapis.com/fcm/send/ana-1",
      p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
      auth: "tBHItJI5svbpez7KI4CCXg",
    }),
  )
  await ownerDb
    .update(pushSubscription)
    .set({ welcomedAt: now, arrivalsSince: new Date(now.getTime() - 3_600_000) })
    .where(eq(pushSubscription.organizationId, c.orgId))
  const visit = await c.book({ patientId: person.id, professional: c.ids.ana, branchId: c.branches.first, roomId: c.rooms.a, startsAt: now })
  await ownerDb
    .update(appointment)
    .set({ arrivedAt: new Date(now.getTime() - 60_000), arrivedBy: c.ids.rita })
    .where(eq(appointment.id, visit.id))
  const pushes = await c.tx((db) => collectOrgPushes(db, c.orgId, now))
  const arrived = pushes.filter((push) => push.message.tag === "llego")
  expect(arrived).toHaveLength(1)
  expect(arrived[0]!.message.body).toMatch(/^Llegó tu paciente de las 10:00/)
  expect(JSON.stringify(arrived)).not.toMatch(/Rosa|Quispe/)
  // Una vez: la siguiente vuelta no lo repite.
  expect((await c.tx((db) => collectOrgPushes(db, c.orgId, now))).filter((push) => push.message.tag === "llego")).toEqual([])
})

it("la derivación de un colega va en su propia fila con quién la pasó; la tarea propia sin fecha no", async () => {
  const c = await clinic()
  const person = await c.patient("Jorge Ramos")
  await ownerDb.insert(crmTask).values([
    { organizationId: c.orgId, assigneeUserId: c.ids.ana, patientId: person.id, title: "Evaluar la 36 para endodoncia", createdBy: c.ids.luis },
    { organizationId: c.orgId, assigneeUserId: c.ids.ana, title: "Pedir resina", createdBy: c.ids.ana },
  ])
  const home = await c.tx((db) => getWorkspaceHome(db, c.orgId, c.ids.ana, { ...clinicianAccess, tasks: true }))
  const referred = rowsOf(home.waiting, "task").filter((row) => row.referredBy)
  expect(referred).toMatchObject([{ title: "Evaluar la 36 para endodoncia", referredBy: "Dr. Luis Rojas" }])
})

it("el odontólogo ve en su Inicio los controles vencidos que él indicó, no los de otro", async () => {
  const c = await clinic()
  const mine = await c.patient("Elena Huamán")
  const other = await c.patient("Carmen Rojas")
  const dueAt = new Date(Date.now() - 10 * 86_400_000)
  await ownerDb.insert(clinicalFollowUp).values([
    { organizationId: c.orgId, patientId: mine.id, kind: "mantenimiento", title: "Control de la endodoncia", dueAt, createdBy: c.ids.ana },
    { organizationId: c.orgId, patientId: other.id, kind: "mantenimiento", title: "Control de ortodoncia", dueAt, createdBy: c.ids.luis },
  ])
  const home = await c.tx((db) => getWorkspaceHome(db, c.orgId, c.ids.ana, clinicianAccess))
  expect(rowsOf(home.waiting, "overdueControls")).toMatchObject([{ controls: 1, patients: 1, mine: true }])
  const list = await c.tx((db) => listMyOverdueControls(db, c.orgId, c.ids.ana))
  expect(list.map((row) => row.personName)).toEqual(["Elena Huamán"])
})

it("sin una sede elegida, Inicio abre en la que hoy tiene citas", async () => {
  const c = await clinic()
  const person = await c.patient("Lucía Fernández")
  await c.book({ patientId: person.id, professional: c.ids.ana, branchId: c.branches.second, roomId: c.rooms.b, startsAt: new Date(Date.now() + 60_000) })
  const home = await c.tx((db) => getWorkspaceHome(db, c.orgId, c.ids.rita, workspaceAccessFor("reception")))
  expect(home.today?.branch?.id).toBe(c.branches.second)
})

it("la ausencia de un profesional vale en todas las sedes", async () => {
  const c = await clinic()
  const from = new Date(Date.now() + 86_400_000)
  await ownerDb.insert(scheduleBlock).values({
    organizationId: c.orgId, branchId: c.branches.first, professionalUserId: c.ids.ana, kind: "ausencia",
    startsAt: from, endsAt: new Date(from.getTime() + 8 * 3_600_000), reason: "Vacaciones",
  })
  const blocks = await c.tx((db) =>
    listScheduleBlocks(db, c.orgId, {
      branchId: c.branches.second,
      from: from.toISOString(),
      to: new Date(from.getTime() + 86_400_000).toISOString(),
    }),
  )
  expect(blocks.map((block) => block.professionalUserId)).toEqual([c.ids.ana])
})

it("una cita confirmada que se mueve a otro día queda por confirmar", async () => {
  const c = await clinic()
  const person = await c.patient("Andrés Vega")
  const startsAt = new Date(Date.now() + 2 * 86_400_000)
  const visit = await c.book({ patientId: person.id, professional: c.ids.ana, branchId: c.branches.first, roomId: c.rooms.a, startsAt })
  const moved = await c.tx((db) =>
    moveAppointment(db, c.orgId, c.ids.rita, visit.id, {
      expectedVersion: visit.version,
      startsAt: new Date(startsAt.getTime() + 2 * 86_400_000).toISOString(),
      outsideSchedule: true,
    }),
  )
  expect(moved.status).toBe("programada")
  // El mismo día, a otra hora, sigue confirmada.
  const other = await c.book({ patientId: person.id, professional: c.ids.luis, branchId: c.branches.first, roomId: c.rooms.a, startsAt })
  const sameDay = await c.tx((db) =>
    moveAppointment(db, c.orgId, c.ids.rita, other.id, {
      expectedVersion: other.version,
      startsAt: new Date(startsAt.getTime() + 3_600_000).toISOString(),
      outsideSchedule: true,
    }),
  )
  expect(sameDay.status).toBe("confirmada")
  // La que pide la propia persona (su enlace o su conversación) sigue confirmada: eligió la hora.
  const asked = await c.book({ patientId: person.id, professional: c.ids.ana, branchId: c.branches.second, roomId: c.rooms.b, startsAt })
  const byPatient = await c.tx((db) =>
    moveAppointment(
      db,
      c.orgId,
      c.ids.rita,
      asked.id,
      { expectedVersion: asked.version, startsAt: new Date(startsAt.getTime() + 3 * 86_400_000).toISOString(), outsideSchedule: true },
      { byPatient: true },
    ),
  )
  expect(byPatient.status).toBe("confirmada")
})

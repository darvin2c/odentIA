/**
 * «Mientras no estabas»: una vez al día, la primera visita a Inicio cuenta lo
 * que hicieron los agentes desde la visita anterior, con lo que cada rol ve.
 */
import { randomUUID } from "node:crypto"
import { type Db, withOrgContext } from "@odentia/db"
import { appointment, scheduleRoom } from "@odentia/db/schema/agenda"
import { user } from "@odentia/db/schema/auth"
import { branch } from "@odentia/db/schema/org"
import { describe, expect, it } from "vitest"
import { recordHomeVisit } from "./home-away.js"
import { nextPatientNumber } from "./patients.js"
import { insertTestPatients } from "./test-patient.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const owner = { appointments: true, ownAppointments: false, agent: true, allTasks: true }
const professional = { appointments: true, ownAppointments: true, agent: false, allTasks: false }
const cashier = { appointments: false, ownAppointments: false, agent: false, allTasks: false }

/** Hora de Lima (UTC−5) de un día de octubre de 2026. */
const lima = (day: number, hh: number, mm = 0) => new Date(Date.UTC(2026, 9, day, hh + 5, mm))

async function clinic() {
  const orgId = `org-${randomUUID()}`
  await insertOrg(ownerDb, orgId, orgId)
  const carmen = `u-${randomUUID()}`
  const ana = `u-${randomUUID()}`
  await ownerDb.insert(user).values([
    { id: carmen, name: "Carmen Ruiz", email: `${carmen}@t.test`, emailVerified: true },
    { id: ana, name: "Ana Torres", email: `${ana}@t.test`, emailVerified: true },
  ])
  const [site] = await ownerDb
    .insert(branch)
    .values({ organizationId: orgId, name: "Centro", timezone: "America/Lima" })
    .returning({ id: branch.id })
  const [room] = await ownerDb
    .insert(scheduleRoom)
    .values({ organizationId: orgId, branchId: site!.id, name: "Unidad dental 1" })
    .returning({ id: scheduleRoom.id })
  const [patient] = await insertTestPatients(ownerDb, {
    organizationId: orgId,
    displayName: "Lucía Ramos",
    patientNumber: await nextPatientNumber(ownerDb, orgId),
  })
  const book = (createdAt: Date, source: string, professionalUserId: string) =>
    ownerDb.insert(appointment).values({
      organizationId: orgId,
      branchId: site!.id,
      patientId: patient!.id,
      professionalUserId,
      roomId: room!.id,
      // Cada una a su hora: la unidad dental no admite dos citas a la vez.
      startsAt: new Date(createdAt.getTime() + 7 * 86_400_000),
      endsAt: new Date(createdAt.getTime() + 7 * 86_400_000 + 30 * 60_000),
      durationMin: 30,
      status: "programada",
      source,
      createdAt,
    })
  return { orgId, carmen, ana, book }
}

const visit = (orgId: string, userId: string, access: typeof owner, at: Date) =>
  withOrgContext(appDb as Db, orgId, (tx) => recordHomeVisit(tx, orgId, userId, access, at))

describe("mientras no estabas", () => {
  it("cuenta desde la visita anterior, una vez al día y solo lo que hizo el agente", async () => {
    const c = await clinic()
    // La primera vez que entra no hay «antes».
    expect(await visit(c.orgId, c.carmen, owner, lima(16, 19, 10))).toBeNull()

    await c.book(lima(17, 11), "agent", c.ana)
    await c.book(lima(18, 9), "enlace", c.carmen)
    await c.book(lima(18, 10), "recepcion", c.carmen) // la agendó una persona: no cuenta

    // Lunes 8:50: primera visita del día.
    const monday = await visit(c.orgId, c.carmen, owner, lima(19, 8, 50))
    expect(monday).toMatchObject({ appointments: 2, recovered: 0, cases: 0 })
    expect(monday?.since).toBe(lima(16, 19, 10).toISOString())

    // El mismo día ya no vuelve a aparecer, aunque haya más trabajo.
    await c.book(lima(19, 9), "agent", c.carmen)
    expect(await visit(c.orgId, c.carmen, owner, lima(19, 13))).toBeNull()

    // Al día siguiente cuenta solo desde la última visita (13:00 del lunes).
    expect(await visit(c.orgId, c.carmen, owner, lima(20, 8))).toBeNull()
  }, 120_000)

  it("el odontólogo cuenta solo sus citas y quien no ve la agenda no recibe números", async () => {
    const c = await clinic()
    await visit(c.orgId, c.ana, professional, lima(16, 18))
    await visit(c.orgId, c.carmen, cashier, lima(16, 18))
    await c.book(lima(17, 11), "agent", c.ana)
    await c.book(lima(17, 12), "agent", c.carmen)
    expect(await visit(c.orgId, c.ana, professional, lima(19, 9))).toMatchObject({
      appointments: 1,
      cases: null,
    })
    expect(await visit(c.orgId, c.carmen, cashier, lima(19, 9))).toBeNull()
  }, 120_000)
})

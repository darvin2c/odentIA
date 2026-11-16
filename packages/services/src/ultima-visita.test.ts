/**
 * Estudio de la atención, entrega 8 (16 nov): quien se atendió sin cita también vino. «Última
 * visita» de Pacientes, los activos y «sin venir» de Reportes e «Invitar a volver» cuentan la cita
 * atendida o la atención firmada sin cita, con una sola regla (`visitRowsSql`), y la clave que
 * evita repetir la invitación lleva el id de esa visita.
 */
import { randomUUID } from "node:crypto"
import { type Db, withOrgContext } from "@odentia/db"
import { appointment, scheduleRoom } from "@odentia/db/schema/agenda"
import { member, user } from "@odentia/db/schema/auth"
import { automationJob, automationRule } from "@odentia/db/schema/automation"
import { encounter } from "@odentia/db/schema/clinical"
import { agentConfig } from "@odentia/db/schema/crm"
import { auditEvent, branch } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { setLine, syncLapsedInvites } from "./automation.js"
import { nextPatientNumber } from "./patients.js"
import { listPeople } from "./people.js"
import { activePatientsMany, getPatientReportList, invitedToReturnCount } from "./report-patients.js"
import { INVITED_TO_RETURN_ACTION, lapsedToInvite } from "./return-invites.js"
import { insertTestPatients } from "./test-patient.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const DAY = 86_400_000
const LIMA = "America/Lima"
const everything = () => true

async function clinic() {
  const orgId = randomUUID()
  const ownerId = `owner-${orgId}`
  await insertOrg(ownerDb, orgId, `visita-${orgId}`)
  await ownerDb.insert(user).values({ id: ownerId, name: "Dra. Ana", email: `${ownerId}@visita.test`, emailVerified: true })
  await ownerDb.insert(member).values({ id: `m-${ownerId}`, userId: ownerId, organizationId: orgId, role: "owner", createdAt: new Date() })
  await ownerDb.insert(agentConfig).values({
    organizationId: orgId,
    enabled: true,
    advisor: { enabled: true },
    writingHours: Array.from({ length: 7 }, (): Array<[number, number]> => [[0, 1440]]),
  })
  const [site] = await ownerDb.insert(branch).values({ organizationId: orgId, name: "Centro", timezone: LIMA }).returning()
  const [room] = await ownerDb.insert(scheduleRoom).values({ organizationId: orgId, branchId: site!.id, name: "Unidad 1" }).returning()
  const run = <T>(fn: (tx: Db) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  const person = async (name: string) =>
    (await insertTestPatients(ownerDb, { organizationId: orgId, displayName: name, patientNumber: await nextPatientNumber(ownerDb, orgId) }))[0]!.id
  /** Una cita atendida. */
  const attended = async (patientId: string, at: Date) => {
    const [row] = await ownerDb
      .insert(appointment)
      .values({
        organizationId: orgId,
        branchId: site!.id,
        roomId: room!.id,
        professionalUserId: ownerId,
        patientId,
        serviceName: "Limpieza",
        startsAt: at,
        endsAt: new Date(at.getTime() + 30 * 60_000),
        durationMin: 30,
        status: "atendida",
      })
      .returning()
    return row!
  }
  /** Una atención firmada (sin cita, salvo que se diga), o en el estado que se pida. */
  const signed = async (patientId: string, at: Date, status: "finalizada" | "borrador" | "anulada" = "finalizada", appointmentId?: string) => {
    const [row] = await ownerDb
      .insert(encounter)
      .values({
        organizationId: orgId,
        patientId,
        professionalUserId: ownerId,
        branchId: site!.id,
        reason: "Consulta",
        startedAt: at,
        status,
        ...(appointmentId ? { appointmentId } : {}),
        ...(status === "finalizada" ? { finalizedAt: at, signerName: "Dra. Ana", signerRegistration: "COP 1" } : {}),
        ...(status === "anulada" ? { voidedAt: at, voidedBy: ownerId, voidReason: "Era de otra persona" } : {}),
      })
      .returning()
    return row!
  }
  return { orgId, ownerId, run, person, attended, signed }
}

it("B8: atendida dos veces hoy sin cita, Pacientes dice su última visita y Reportes la cuenta activa", async () => {
  const c = await clinic()
  const marta = await c.person("Marta Salas")
  const morning = new Date(Date.now() - 5 * 60 * 60_000)
  const noon = new Date(Date.now() - 2 * 60 * 60_000)
  await c.signed(marta, morning)
  await c.signed(marta, noon)
  // Lo que no cuenta: una atención sin firmar y otra anulada, más recientes.
  await c.signed(marta, new Date(Date.now() - 30 * 60_000), "anulada")
  const page = await c.run((tx) => listPeople(tx, c.orgId, { view: "pacientes" }, everything))
  const row = page.items.find((item) => item.displayName === "Marta Salas")
  expect(row?.lastVisitAt && new Date(row.lastVisitAt).getTime()).toBe(Math.floor(noon.getTime() / 1000) * 1000)
  expect(await c.run((tx) => activePatientsMany(tx, c.orgId, { branch: null, timezone: LIMA }, [new Date()]))).toEqual([1])
})

it("B8c: con una cita atendida y una atención sin cita después, cuenta la más reciente; la de su cita no cuenta dos veces", async () => {
  const c = await clinic()
  const rosa = await c.person("Rosa Díaz")
  const visit = await c.attended(rosa, new Date(Date.now() - 40 * DAY))
  // La atención de esa cita es la misma visita.
  await c.signed(rosa, new Date(Date.now() - 40 * DAY), "finalizada", visit.id)
  const later = new Date(Date.now() - 3 * DAY)
  await c.signed(rosa, later)
  const page = await c.run((tx) => listPeople(tx, c.orgId, { view: "pacientes" }, everything))
  const row = page.items.find((item) => item.displayName === "Rosa Díaz")
  expect(new Date(row!.lastVisitAt!).getTime()).toBe(Math.floor(later.getTime() / 1000) * 1000)
  // Vino hace 3 días: no está «sin venir».
  expect(await c.run((tx) => lapsedToInvite(tx, c.orgId, LIMA, new Date()))).toEqual([])
})

it("B8b: quien vino sin cita hace 7 meses toca invitarlo, con su atención como la visita; quien vino sin cita hace poco no", async () => {
  const c = await clinic()
  const luis = await c.person("Luis Quispe")
  const carmen = await c.person("Carmen Huamán")
  const away = await c.signed(luis, new Date(Date.now() - 215 * DAY))
  // Carmen tuvo su cita atendida hace 8 meses, pero se atendió sin cita hace un mes: ya no toca.
  await c.attended(carmen, new Date(Date.now() - 240 * DAY))
  await c.signed(carmen, new Date(Date.now() - 30 * DAY))
  const due = await c.run((tx) => lapsedToInvite(tx, c.orgId, LIMA, new Date()))
  expect(due).toMatchObject([{ patientId: luis, visitId: away.id, appointmentId: null }])
})

it("B8b: con la línea prendida, la invitación de quien vino sin cita sale una sola vez, con la clave de su atención", async () => {
  const c = await clinic()
  const luis = await c.person("Luis Quispe")
  // Cumplió los seis meses después de prender la línea: entra en este ciclo.
  const away = await c.signed(luis, new Date(Date.now() - 184 * DAY))
  const rule = await c.run((tx) => setLine(tx, c.orgId, c.ownerId, "invitar_a_volver", { enabled: true }))
  await ownerDb.update(automationRule).set({ enabledAt: new Date(Date.now() - 10 * DAY) }).where(eq(automationRule.id, rule.id))
  await c.run((tx) => syncLapsedInvites(tx, c.orgId, new Date()))
  await c.run((tx) => syncLapsedInvites(tx, c.orgId, new Date()))
  const jobs = await ownerDb
    .select()
    .from(automationJob)
    .where(and(eq(automationJob.organizationId, c.orgId), eq(automationJob.kind, "invitar_a_volver")))
  expect(jobs).toHaveLength(1)
  expect(jobs[0]).toMatchObject({ patientId: luis, appointmentId: null, dedupeKey: `invitar_a_volver:${luis}:${away.id}:0` })
})

// Revisión del 16 nov (R6): Marta fue invitada a volver y volvió sin cita; su atención firmada es la
// visita. «Volvieron tras la invitación» la cuenta, como «Invitar a volver» ya no la invita.
it("R6: quien vuelve sin cita tras la invitación cuenta en «Volvieron tras la invitación», con su atención", async () => {
  const c = await clinic()
  const marta = await c.person("Marta Salas")
  const rosa = await c.person("Rosa Díaz")
  const invite = (patientId: string) =>
    ownerDb.insert(auditEvent).values({
      organizationId: c.orgId,
      action: INVITED_TO_RETURN_ACTION,
      entity: "patient",
      entityId: patientId,
      metadata: { via: "telefono" },
      createdAt: new Date("2026-09-05T15:00:00Z"),
    })
  await invite(marta)
  await invite(rosa)
  const back = await c.signed(marta, new Date("2026-10-02T15:00:00Z"))
  // Rosa tiene una atención sin firmar después de la invitación: todavía no volvió.
  await c.signed(rosa, new Date("2026-10-03T15:00:00Z"), "borrador")
  const september = { start: new Date("2026-09-01T05:00:00Z"), end: new Date("2026-10-01T05:00:00Z") }
  expect(await c.run((tx) => invitedToReturnCount(tx, c.orgId, september))).toEqual({ invited: 2, returned: 1 })
  const list = await c.run((tx) =>
    getPatientReportList(tx, c.orgId, { period: "2026-09", list: "invited_returned" }, new Date("2026-10-12T15:00:00Z")),
  )
  expect(list.rows.map((row) => [row.id, row.personName, row.at, row.branchName])).toEqual([
    [back.id, "Marta Salas", "2026-10-02T15:00:00.000Z", "Centro"],
  ])
})

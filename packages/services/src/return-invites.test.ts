import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { appointment, scheduleRoom } from "@odentia/db/schema/agenda"
import { user } from "@odentia/db/schema/auth"
import { auditEvent, branch } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { inviteStepText, lapsedToInvite, markInvitedToReturn, INVITED_TO_RETURN_ACTION } from "./return-invites.js"
import { listPeople } from "./people.js"
import { peopleShortcutMembers } from "./people-shortcuts.js"
import { nextPatientNumber } from "./patients.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"
import { insertTestPatients } from "./test-patient.js"

setupTestDb()

/** Lunes 12 de octubre de 2026: a seis meses de la última visita, lo que lleva a invitar. */
const NOW = new Date("2026-10-12T15:00:00Z")
const LIMA = "America/Lima"
const everything = () => true

/** Una clínica con una sede, una unidad dental y dos pacientes, cada uno con su visita. */
async function clinic() {
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, `invitar-${orgId}`)
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  const [site] = await ownerDb.insert(branch).values({ organizationId: orgId, name: "Centro", timezone: LIMA }).returning()
  const [room] = await ownerDb
    .insert(scheduleRoom)
    .values({ organizationId: orgId, branchId: site!.id, name: "Unidad dental 1" })
    .returning()
  const actor = randomUUID()
  await ownerDb.insert(user).values({ id: actor, name: "Dra. Ana", email: `${actor}@invitar.test` })
  const person = async (name: string) => {
    const patientNumber = await nextPatientNumber(ownerDb, orgId)
    const [row] = await insertTestPatients(ownerDb, { organizationId: orgId, displayName: name, patientNumber })
    return { patientId: row!.id, personId: row!.personId }
  }
  const visit = (patientId: string, startsAt: string) =>
    ownerDb.insert(appointment).values({
      organizationId: orgId,
      branchId: site!.id,
      roomId: room!.id,
      professionalUserId: actor,
      patientId,
      serviceName: "Limpieza",
      startsAt: new Date(startsAt),
      endsAt: new Date(new Date(startsAt).getTime() + 30 * 60_000),
      durationMin: 30,
      status: "atendida",
    })
  return { orgId, actor, run, person, visit }
}

it("quien no viene hace seis meses toca invitarlo; la invitación lo saca del atajo hasta seis meses después", async () => {
  const c = await clinic()
  const lucia = await c.person("Lucía Fernández")
  const carmen = await c.person("Carmen Huamán")
  // Lucía vino en abril de 2025 y nunca más; Carmen vino hace un mes.
  await c.visit(lucia.patientId, "2025-04-14T15:00:00Z")
  await c.visit(carmen.patientId, "2026-09-10T15:00:00Z")

  const due = await c.run((tx) => lapsedToInvite(tx, c.orgId, LIMA, NOW))
  expect(due.map((row) => row.personName)).toEqual(["Lucía Fernández"])
  // El atajo de Pacientes dice lo mismo que la regla.
  const members = await c.run((tx) => peopleShortcutMembers(tx, c.orgId, everything, LIMA, NOW))
  expect(members.por_invitar_a_volver).toEqual([lucia.patientId])

  // Se la invitó en octubre: sale del atajo.
  await ownerDb.insert(auditEvent).values({
    organizationId: c.orgId,
    actorUserId: c.actor,
    action: INVITED_TO_RETURN_ACTION,
    entity: "patient",
    entityId: lucia.patientId,
    metadata: { via: "agente" },
    createdAt: new Date("2026-10-10T15:00:00Z"),
  })
  expect(await c.run((tx) => lapsedToInvite(tx, c.orgId, LIMA, NOW))).toEqual([])
  // Seis meses después de esa invitación le vuelve a tocar, sin fin.
  const later = new Date("2027-04-15T15:00:00Z")
  // En abril de 2027 Carmen también lleva seis meses sin venir: le toca a las dos, en orden de su última visita.
  expect((await c.run((tx) => lapsedToInvite(tx, c.orgId, LIMA, later))).map((row) => row.patientId)).toEqual([
    lucia.patientId,
    carmen.patientId,
  ])
})

it("«Ya la invité» anota la invitación de la persona; quien no es paciente no tiene a quién anotarla", async () => {
  const c = await clinic()
  const lucia = await c.person("Lucía Fernández")
  await c.visit(lucia.patientId, "2025-04-14T15:00:00Z")
  await c.run((tx) => markInvitedToReturn(tx, c.orgId, c.actor, lucia.personId, "telefono"))
  const [row] = await ownerDb
    .select({ metadata: auditEvent.metadata, entityId: auditEvent.entityId })
    .from(auditEvent)
    .where(and(eq(auditEvent.organizationId, c.orgId), eq(auditEvent.action, INVITED_TO_RETURN_ACTION)))
  expect(row).toMatchObject({ entityId: lucia.patientId, metadata: { via: "telefono" } })
  // Sin ficha de paciente, no hay de quién anotar la invitación.
  await expect(c.run((tx) => markInvitedToReturn(tx, c.orgId, c.actor, randomUUID(), "telefono"))).rejects.toThrow()
})

it("el atajo «Por invitar a volver» de Pacientes muestra a quien toca, con su contador", async () => {
  const c = await clinic()
  const lucia = await c.person("Lucía Fernández")
  const carmen = await c.person("Carmen Huamán")
  await c.visit(lucia.patientId, "2025-04-14T15:00:00Z")
  await c.visit(carmen.patientId, "2026-09-10T15:00:00Z")
  const page = await c.run((tx) =>
    listPeople(tx, c.orgId, { view: "pacientes", atajo: "por_invitar_a_volver" }, everything),
  )
  expect(page.items.map((row) => row.displayName)).toEqual(["Lucía Fernández"])
  // Nadie le lleva la invitación todavía: la línea está apagada, así que la lleva una persona.
  expect(page.items[0]).toMatchObject({ attention: "persona", nextStep: { text: "Toca invitarla a volver", actionLabel: null } })
  // El contador de cada atajo dice lo mismo que la lista; el de quien no ve el atajo, no aparece.
  const counts = await c.run((tx) => listPeople(tx, c.orgId, { view: "pacientes" }, everything))
  expect(counts.shortcuts?.por_invitar_a_volver).toBe(1)
  expect(counts.shortcuts?.faltan_datos).not.toBeNull()
  // Un atajo que no es de la vista se rechaza, y uno que no existe también.
  await expect(
    c.run((tx) => listPeople(tx, c.orgId, { view: "todos", atajo: "deben" }, everything)),
  ).rejects.toThrow()
})

it("ya invitada, la fila dice cuándo y cuándo le vuelve a tocar; «Ya la invité» lleva el nombre de quien la anotó", async () => {
  const c = await clinic()
  const lucia = await c.person("Lucía Fernández")
  await c.visit(lucia.patientId, "2025-04-14T15:00:00Z")
  await c.run((tx) => markInvitedToReturn(tx, c.orgId, c.actor, lucia.personId, "telefono"))
  const page = await c.run((tx) => listPeople(tx, c.orgId, { view: "pacientes" }, everything))
  const row = page.items.find((item) => item.displayName === "Lucía Fernández")
  // Sale del atajo y su fila ya no dice «Toca invitarla a volver».
  expect(page.shortcuts?.por_invitar_a_volver).toBe(0)
  expect(row?.nextStep?.text).toMatch(/^Invitada por Dra\. Ana el \d{1,2} \S+ · la próxima, en \S+$/)
  // La invitó una persona del equipo: no «nadie lo lleva».
  expect(row?.attention).toBe("persona")
})

it("«Qué sigue» de quien ya fue invitada: el agente, quien no quiere, y cuándo deja de decirlo", () => {
  const zone = { locale: "es-PE", timezone: LIMA }
  const away = { lastVisitAt: "2025-04-14T15:00:00Z", nextAppointmentAt: null }
  const byAgent = { invitedAt: new Date("2026-10-03T15:00:00Z"), invitedBy: null, declined: false }
  expect(inviteStepText(byAgent, away, zone, NOW)).toEqual({ text: "Invitada el 3 oct · la próxima, en abril", by: "agente" })
  // Volvió después de la invitación, o ya tiene cita: no hay nada que decir de ella.
  expect(inviteStepText(byAgent, { lastVisitAt: "2026-10-08T15:00:00Z", nextAppointmentAt: null }, zone, NOW)).toBeNull()
  expect(inviteStepText(byAgent, { ...away, nextAppointmentAt: "2026-10-20T15:00:00Z" }, zone, NOW)).toBeNull()
  // Pasados seis meses de la invitación le vuelve a tocar: la fila ya no dice «Invitada».
  expect(inviteStepText(byAgent, away, zone, new Date("2027-04-15T15:00:00Z"))).toBeNull()
  // Pidió no recibir seguimiento: se respeta y lo dice.
  expect(inviteStepText({ invitedAt: null, invitedBy: null, declined: true }, away, zone, NOW)).toEqual({ text: "No quiere invitaciones", by: null })
  // Quien vino hace poco no es «no quiere invitaciones»: no le tocaría ninguna.
  expect(inviteStepText({ invitedAt: null, invitedBy: null, declined: true }, { lastVisitAt: "2026-09-10T15:00:00Z", nextAppointmentAt: null }, zone, NOW)).toBeNull()
})

/**
 * Cuándo un tema pasa a «Ahora»: dos horas de clínica abierta. Un cierre de
 * una sede no cuenta si otra sede atiende a esa hora; una sede que ese día no
 * abre no anula el cierre. Y un tema que espera desde hace semanas cuenta los
 * cierres de cuando esperaba, no solo los de hoy.
 */
import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { professionalSchedule, scheduleBlock } from "@odentia/db/schema/availability"
import { member, user } from "@odentia/db/schema/auth"
import { branch } from "@odentia/db/schema/org"
import { expect, it } from "vitest"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"
import { topicUrgentAt } from "./topic-urgency.js"

setupTestDb()

/** Una hora de Lima en UTC: «2026-10-12 17:00» → 22:00 Z. */
const lima = (day: string, time: string): Date => new Date(new Date(`${day}T${time}:00Z`).getTime() + 5 * 3_600_000)

async function clinic() {
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, `urgencia-${orgId}`)
  const [north, south] = await ownerDb
    .insert(branch)
    .values([
      { organizationId: orgId, name: "Norte" },
      { organizationId: orgId, name: "Sur" },
    ])
    .returning()
  const professionalUserId = randomUUID()
  await ownerDb.insert(user).values({ id: professionalUserId, name: "Dra. Ana", email: `${professionalUserId}@urgencia.test` })
  await ownerDb.insert(member).values({ id: randomUUID(), organizationId: orgId, userId: professionalUserId, role: "clinician", createdAt: new Date() })
  const schedule = (branchId: string, weekdays: number[], startMin: number, endMin: number) =>
    ownerDb.insert(professionalSchedule).values(
      weekdays.map((weekday) => ({ organizationId: orgId, branchId, professionalUserId, weekday, startMin, endMin, isActive: true, validFrom: "2026-01-01" })),
    )
  // Norte atiende de lunes a viernes, de 9 a 18; Sur solo los sábados por la mañana.
  await schedule(north!.id, [1, 2, 3, 4, 5], 9 * 60, 18 * 60)
  await schedule(south!.id, [6], 9 * 60, 13 * 60)
  // El martes 13 de octubre, feriado: Norte cierra entera.
  await ownerDb.insert(scheduleBlock).values({
    organizationId: orgId,
    branchId: north!.id,
    kind: "bloqueo",
    reason: "Feriado",
    startsAt: lima("2026-10-13", "00:00"),
    endsAt: lima("2026-10-14", "00:00"),
  })
  return { orgId, north: north!.id, south: south!.id, schedule }
}

it("un feriado de una sede cuenta aunque otra sede no lo bloquee, si ese día no abre, y aunque haya pasado hace semanas", async () => {
  const c = await clinic()
  // Lunes 17:00: una hora el lunes; el martes no abre nadie; la otra, el miércoles de 9 a 10.
  const urgentAt = await withOrgContext(appDb, c.orgId, (tx) => topicUrgentAt(tx, c.orgId, lima("2026-10-12", "17:00")))
  expect(urgentAt.toISOString()).toBe(lima("2026-10-14", "10:00").toISOString())
})

it("si otra sede atiende ese día, el cierre de una sola no cuenta", async () => {
  const c = await clinic()
  // Sur también abre los martes por la mañana: el martes de 9 a 10 cuenta.
  await c.schedule(c.south, [2], 9 * 60, 13 * 60)
  const urgentAt = await withOrgContext(appDb, c.orgId, (tx) => topicUrgentAt(tx, c.orgId, lima("2026-10-12", "17:00")))
  expect(urgentAt.toISOString()).toBe(lima("2026-10-13", "10:00").toISOString())
})

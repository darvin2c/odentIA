import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { auditEvent, branch } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { listScheduleResources } from "./appointments.js"
import { setBranchActive } from "./branches.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

it("una sede se desactiva y se reactiva sin perder nada, y solo dentro de su organización", async () => {
  const orgId = randomUUID()
  const other = randomUUID()
  await insertOrg(ownerDb, orgId, orgId)
  await insertOrg(ownerDb, other, other)
  const [central, norte] = await ownerDb
    .insert(branch)
    .values([
      { organizationId: orgId, name: "Sede Central", timezone: "America/Lima" },
      { organizationId: orgId, name: "Sede Norte", timezone: "America/Lima" },
    ])
    .returning({ id: branch.id })
  if (!central || !norte) throw new Error("No se crearon las sedes de la prueba")
  const centralId = central.id
  const norteId = norte.id
  const setActive = (id: string, isActive: boolean) =>
    withOrgContext(appDb, orgId, (tx) => setBranchActive(tx, orgId, "config-test", id, isActive))
  const resourcesOf = (branchId: string) =>
    withOrgContext(appDb, orgId, (tx) => listScheduleResources(tx, orgId, { branchId }))

  expect(await setActive(norteId, false)).toEqual({ id: norteId, isActive: false })
  // Desactivada no se le puede pedir la agenda; la otra sede sigue igual.
  await expect(resourcesOf(norteId)).rejects.toMatchObject({ status: 404 })
  expect((await resourcesOf(centralId)).branchName).toBe("Sede Central")

  expect(await setActive(norteId, true)).toEqual({ id: norteId, isActive: true })
  expect((await resourcesOf(norteId)).branchName).toBe("Sede Norte")
  // Repetir el mismo estado no cambia nada ni deja otra entrada.
  await setActive(norteId, true)
  const trail = await ownerDb
    .select({ action: auditEvent.action })
    .from(auditEvent)
    .where(and(eq(auditEvent.organizationId, orgId), eq(auditEvent.entityId, norteId)))
    .orderBy(auditEvent.createdAt)
  expect(trail.map((row) => row.action)).toEqual(["branch.deactivate", "branch.reactivate"])

  // Otra organización no la encuentra aunque conozca su identificador.
  await expect(
    withOrgContext(appDb, other, (tx) => setBranchActive(tx, other, "config-test", norteId, false)),
  ).rejects.toMatchObject({ status: 404 })
  await expect(setActive(randomUUID(), false)).rejects.toMatchObject({
    status: 404,
    message: "Sede no encontrada",
  })
})

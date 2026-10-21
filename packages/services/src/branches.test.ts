import { randomUUID } from "node:crypto"
import { type Db, withOrgContext } from "@odentia/db"
import { auditEvent, branch } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { listScheduleResources } from "./appointments.js"
import { createBranch, setBranchActive, updateBranch } from "./branches.js"
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

it("la dirección de la sede tiene la forma de la del paciente y se valida con el país (issue 36)", async () => {
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, orgId)
  const run = <T>(fn: (tx: Db) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  const created = await run((tx) =>
    createBranch(tx, orgId, "config-test", {
      name: "  Sede Miraflores ",
      addressLine1: "Av. José Larco 345",
      city: "Miraflores",
      district: "Lima",
      region: "PE-LMA",
    }),
  )
  // El país, si no se eligió, es el de la clínica.
  expect(created).toMatchObject({ name: "Sede Miraflores", region: "PE-LMA", country: "PE" })
  // En Perú el departamento se elige de la lista.
  await expect(run((tx) => updateBranch(tx, orgId, "config-test", created.id, { region: "Lima" }))).rejects.toMatchObject({
    status: 400,
    message: "Elige el departamento de la lista",
  })
  // Lo que no llega queda como estaba; vaciar un campo lo deja en null.
  const updated = await run((tx) => updateBranch(tx, orgId, "config-test", created.id, { postalCode: "15074", city: "" }))
  expect(updated).toMatchObject({ addressLine1: "Av. José Larco 345", city: null, region: "PE-LMA", postalCode: "15074" })
  await expect(run((tx) => updateBranch(tx, orgId, "config-test", randomUUID(), { name: "X" }))).rejects.toMatchObject({ status: 404 })
})

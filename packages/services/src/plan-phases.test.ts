import { encounterProcedure } from "@odentia/db/schema/clinical"
import { expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { addPlanItem, listPlanItems, updatePlanItemPlanning } from "./plan.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

async function withItems() {
  const f = await clinicalFixture()
  const add = (input: { phase?: string; plannedSessions?: number } = {}) =>
    f.run((tx) =>
      addPlanItem(tx, ...f.args, {
        serviceId: f.service.id,
        planId: f.plan.id,
        sourceEncounterId: f.encounter.id,
        ...input,
      }),
    )
  return { ...f, add }
}

it("la indicación entra al final de su fase propuesta y con sesiones previstas", async () => {
  const f = await withItems()
  const first = await f.add()
  const second = await f.add({ phase: "urgencia", plannedSessions: 2 })
  expect(first).toMatchObject({ phase: "basica", plannedSessions: 1, sortOrder: 1 })
  expect(second).toMatchObject({ phase: "urgencia", plannedSessions: 2, sortOrder: 2 })
  await expect(f.add({ phase: "otra" })).rejects.toMatchObject({ status: 400 })
})

it("reordena dentro de la fase por teclado y cambia de fase al final de la nueva", async () => {
  const f = await withItems()
  const a = await f.add()
  const b = await f.add()
  await f.run((tx) => updatePlanItemPlanning(tx, ...f.args, b.id, { move: "up" }))
  let items = await f.run((tx) => listPlanItems(tx, "org_a", f.patient.id))
  expect(items.map((i) => i.id)).toEqual([b.id, a.id])
  // Subir al primero no hace nada.
  await f.run((tx) => updatePlanItemPlanning(tx, ...f.args, b.id, { move: "up" }))
  items = await f.run((tx) => listPlanItems(tx, "org_a", f.patient.id))
  expect(items.map((i) => i.id)).toEqual([b.id, a.id])
  const moved = await f.run((tx) =>
    updatePlanItemPlanning(tx, ...f.args, b.id, { phase: "rehabilitadora" }),
  )
  expect(moved.phase).toBe("rehabilitadora")
  expect(moved.sortOrder).toBeGreaterThan(a.sortOrder)
})

it("el progreso cuenta las sesiones hechas y no admite prever menos", async () => {
  const f = await withItems()
  const item = await f.add({ plannedSessions: 3 })
  // La ejecución exige presupuesto aceptado; aquí basta el acto registrado.
  await ownerDb.insert(encounterProcedure).values({
    organizationId: "org_a",
    encounterId: f.encounter.id,
    planItemId: item.id,
    description: "Sesión 1",
  })
  await ownerDb.insert(encounterProcedure).values({
    organizationId: "org_a",
    encounterId: f.encounter.id,
    planItemId: item.id,
    description: "Sesión anulada",
    voidedAt: new Date(),
    voidReason: "Duplicada",
  })
  const [listed] = await f.run((tx) => listPlanItems(tx, "org_a", f.patient.id))
  expect(listed).toMatchObject({ sessionsDone: 1, plannedSessions: 3 })
  await expect(
    f.run((tx) => updatePlanItemPlanning(tx, ...f.args, item.id, { plannedSessions: 0 })),
  ).rejects.toMatchObject({ status: 400 })
  const two = await f.run((tx) =>
    updatePlanItemPlanning(tx, ...f.args, item.id, { plannedSessions: 2 }),
  )
  expect(two).toMatchObject({ plannedSessions: 2, sessionsDone: 1 })
})

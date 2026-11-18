/**
 * «¿Corona es otro camino o va también?» (mesa del 17 nov, hallazgo 2 del novato): «Va también»
 * solo dejaba de preguntar en la pantalla y, al recargar, la pregunta volvía. Ahora la respuesta
 * es la operación de los caminos («todos») y queda guardada en el tratamiento, sin cambiar el
 * presupuesto de una sola opción.
 */
import { serviceCatalog } from "@odentia/db/schema/clinical"
import { expect, it } from "vitest"
import { placeBudgetPath } from "./budget-paths.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { addPlanItem, listPlanItems } from "./plan.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

it("«Va también» queda guardado: al volver a leer el plan sigue respondido y el presupuesto suma los dos", async () => {
  const f = await clinicalFixture()
  const service = async (name: string, priceCents: number) =>
    (
      await ownerDb
        .insert(serviceCatalog)
        .values({
          organizationId: "org_a",
          name,
          scope: "tooth",
          source: "custom",
          priceCents,
          currency: "PEN",
        })
        .returning()
    )[0]!
  const indicate = async (serviceId: string) =>
    f.run((tx) =>
      addPlanItem(tx, ...f.args, { serviceId, sourceEncounterId: f.encounter.id, toothNumber: 46 }),
    )
  const endodoncia = await indicate((await service("Endodoncia", 65000)).id)
  const corona = await indicate((await service("Corona", 90000)).id)
  const read = async () =>
    (await f.run((tx) => listPlanItems(tx, "org_a", f.patient.id))).find(
      (item) => item.id === corona.id,
    )!
  // Sin responder: la pantalla pregunta.
  expect((await read()).pathAnsweredAt).toBeNull()

  const budget = await f.run((tx) =>
    placeBudgetPath(tx, ...f.args, f.encounter.id, { planItemId: corona.id, path: "todos" }),
  )
  // No compite: una sola opción con los dos.
  expect(budget.options).toHaveLength(1)
  expect(budget.items.map((line) => line.planItemId).sort()).toEqual(
    [endodoncia.id, corona.id].sort(),
  )
  // Como al recargar: la respuesta sigue, y la pregunta no vuelve.
  const after = await read()
  expect(after.pathAnsweredAt).toBeInstanceOf(Date)
  expect(after.path).toBeNull()
  // Lo otro de la pieza no se respondió: sigue sin respuesta propia.
  expect(
    (await f.run((tx) => listPlanItems(tx, "org_a", f.patient.id))).find(
      (item) => item.id === endodoncia.id,
    )?.pathAnsweredAt,
  ).toBeNull()
})

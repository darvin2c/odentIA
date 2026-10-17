/**
 * Claves compuestas de la fase 3: lo que nombra otra fila
 * clínica la nombra dentro de la misma organización y del mismo paciente.
 */
import { odontogramAssessment, odontogramEntry, treatmentBudgetOption } from "@odentia/db/schema/clinical"
import { expect, it } from "vitest"
import { createBudget } from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { addPlanItem } from "./plan.js"
import { nextPatientNumber } from "./patients.js"
import { ownerDb, setupTestDb } from "./test-setup.js"
import { insertTestPatients } from "./test-patient.js"

setupTestDb()

const ORG = "org_a"

async function rejects(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause
    return cause?.code ?? (error as { code?: string }).code ?? "error"
  }
  return "OK"
}

it("una opción, lo tratado que queda dibujado y el odontograma firmado no cruzan de paciente", async () => {
  const f = await clinicalFixture()
  const [other] = await insertTestPatients(ownerDb, { organizationId: ORG, displayName: "Otra persona", patientNumber: await nextPatientNumber(ownerDb, ORG) })
  const item = await f.run((tx) => addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }))
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))

  // 23503: violación de clave foránea.
  expect(await rejects(ownerDb.insert(treatmentBudgetOption).values({ organizationId: ORG, patientId: other!.id, budgetId: budget.id, position: 2 }))).toBe("23503")
  expect(
    await rejects(
      ownerDb.insert(odontogramEntry).values({ organizationId: ORG, patientId: other!.id, toothNumber: 16, condition: "restauracion", leftByPlanItemId: item.id }),
    ),
  ).toBe("23503")
  expect(
    await rejects(
      ownerDb.insert(odontogramAssessment).values({
        organizationId: ORG,
        patientId: other!.id,
        authorUserId: f.actor,
        purpose: "inicio",
        specifications: "",
        observations: "",
        examinerName: "Dra. Prueba",
        examinerTitle: "Cirujano dentista",
        registrationNumber: "COP 1",
        patientName: "Otra persona",
        patientNumber: 1,
        entries: [],
        standard: "PE-NTS-188",
        encounterId: f.encounter.id,
      }),
    ),
  ).toBe("23503")
  // Del mismo paciente, sí.
  expect(
    await rejects(
      ownerDb.insert(odontogramEntry).values({ organizationId: ORG, patientId: f.patient.id, toothNumber: 16, condition: "restauracion", leftByPlanItemId: item.id }),
    ),
  ).toBe("OK")
})

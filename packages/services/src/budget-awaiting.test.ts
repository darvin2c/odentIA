/**
 * «Presupuesto que espera respuesta»: una sola regla. La misma en código y en
 * SQL, y la usan el Resumen (`getPatientSummary`), la coordinación de
 * recepción (`getTreatmentCoordination`) y la cuenta (`awaitsAnswer`).
 */
import { treatmentBudget, treatmentBudgetItem } from "@odentia/db/schema/clinical"
import { and, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { budgetAwaitsAnswer, budgetAwaitsAnswerSql } from "./budget-awaiting.js"
import { createBudget, getBudgetDetail } from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { getPatientSummary } from "./patient-history.js"
import { addPlanItem } from "./plan.js"
import { ownerDb, setupTestDb } from "./test-setup.js"
import { getTreatmentCoordination } from "./treatment-coordination.js"

setupTestDb()

const ORG = "org_a"

it("espera respuesta lo enviado y lo que «lo está pensando»; un borrador nunca", async () => {
  const f = await clinicalFixture()
  const patientId = f.args[2]
  const first = await f.run((tx) =>
    addPlanItem(tx, ...f.args, {
      serviceId: f.service.id,
      planId: f.plan.id,
      sourceEncounterId: f.encounter.id,
    }),
  )
  const second = await f.run((tx) =>
    addPlanItem(tx, ...f.args, {
      serviceId: f.service.id,
      planId: f.plan.id,
      sourceEncounterId: f.encounter.id,
    }),
  )
  const budget = await f.run((tx) =>
    createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [first.id, second.id] }),
  )

  const cases: Array<{ status: string; decisions: [string, string]; awaits: boolean }> = [
    { status: "borrador", decisions: ["pendiente", "pendiente"], awaits: false },
    { status: "presentado", decisions: ["pendiente", "pendiente"], awaits: true },
    { status: "pospuesto", decisions: ["pospuesto", "pospuesto"], awaits: true },
    // Aceptó una parte y dejó otra para después: lo sigue pensando.
    { status: "parcial", decisions: ["aceptado", "pospuesto"], awaits: true },
    { status: "parcial", decisions: ["aceptado", "rechazado"], awaits: false },
    { status: "aceptado", decisions: ["aceptado", "aceptado"], awaits: false },
    { status: "rechazado", decisions: ["rechazado", "rechazado"], awaits: false },
    { status: "sustituido", decisions: ["pendiente", "pendiente"], awaits: false },
    { status: "cancelado", decisions: ["pendiente", "pendiente"], awaits: false },
  ]
  for (const item of cases) {
    // Primero el estado y después las decisiones: un presupuesto entregado solo admite cambiar la decisión.
    await ownerDb
      .update(treatmentBudget)
      .set({ status: item.status })
      .where(eq(treatmentBudget.id, budget.id))
    const lines = [
      [first.id, item.decisions[0]],
      [second.id, item.decisions[1]],
    ] as const
    for (const [planItemId, decision] of lines) {
      await ownerDb
        .update(treatmentBudgetItem)
        .set({ decision })
        .where(
          and(
            eq(treatmentBudgetItem.budgetId, budget.id),
            eq(treatmentBudgetItem.planItemId, planItemId),
          ),
        )
    }
    const label = `${item.status} con ${item.decisions.join(" y ")}`

    // La misma regla en código y en SQL.
    expect(
      budgetAwaitsAnswer({
        status: item.status,
        items: item.decisions.map((decision) => ({ decision })),
      }),
      label,
    ).toBe(item.awaits)
    const [row] = await ownerDb
      .select({ awaits: budgetAwaitsAnswerSql(treatmentBudget) })
      .from(treatmentBudget)
      .where(eq(treatmentBudget.id, budget.id))
    expect(Boolean(row?.awaits), label).toBe(item.awaits)

    // Y la usan todos: el Resumen, la coordinación de recepción y la cuenta.
    const summary = await f.run((tx) => getPatientSummary(tx, ORG, patientId))
    expect(
      summary.proposedBudgets.map((proposed) => proposed.id),
      label,
    ).toEqual(item.awaits ? [budget.id] : [])
    const coordination = await f.run((tx) => getTreatmentCoordination(tx, ORG, patientId))
    expect(
      coordination.budgetsAwaitingDecision.map((waiting) => waiting.id),
      label,
    ).toEqual(item.awaits ? [budget.id] : [])
    const detail = await f.run((tx) => getBudgetDetail(tx, ORG, patientId, budget.id))
    expect(detail.awaitsAnswer, label).toBe(item.awaits)
  }
})

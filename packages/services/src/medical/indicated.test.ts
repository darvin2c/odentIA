import { orgProfile } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { listBudgets } from "../budgets.js"
import { clinicalFixture } from "../clinical-test-fixture.js"
import { addEncounterProcedure, createEncounter, finalizeEncounter } from "../encounters.js"
import { addPlanItem, setPlanItemStatus } from "../plan.js"
import { getPlanNextStep } from "../plan-next.js"
import { ownerDb, setupTestDb } from "../test-setup.js"
import { listTreatmentJourneys } from "../treatment-journey.js"

setupTestDb()

const setProduct = (product: "dental" | "medical") =>
  ownerDb.update(orgProfile).set({ product }).where(eq(orgProfile.organizationId, "org_a"))

it("en latidIA lo indicado queda aceptado: se agenda, se vincula y se realiza sin presupuesto (issue 229, decisión 15)", async () => {
  const f = await clinicalFixture()
  const indicate = () =>
    f.run((tx) =>
      addPlanItem(tx, ...f.args, { serviceId: f.service.id, sourceEncounterId: f.encounter.id }),
    )

  // odentIA, como siempre: lo indicado espera su presupuesto.
  const dental = await indicate()
  expect(dental.decision).toBe("pendiente")
  await expect(
    f.run((tx) => setPlanItemStatus(tx, ...f.args, dental.id, { status: "programado" })),
  ).rejects.toThrow(/no está aceptado/)

  await setProduct("medical")
  try {
    const nebulization = await indicate()
    expect(nebulization).toMatchObject({
      decision: "aceptado",
      decisionStatus: "aceptado",
      budgetId: null,
    })
    expect(nebulization.decidedAt).not.toBeNull()
    const control = await indicate()

    // Su próximo paso es iniciarlo, no presupuestarlo; «Qué sigue» pide agendarlo.
    const journeys = await f.run((tx) => listTreatmentJourneys(tx, "org_a", f.patient.id))
    expect(journeys.find((row) => row.item.id === nebulization.id)?.nextAction).toBe("iniciar")
    const next = await f.run((tx) => getPlanNextStep(tx, "org_a", f.patient.id, () => true))
    expect(next).toMatchObject({ kind: "agendar", text: "Falta la cita de lo indicado" })

    // Se realiza en la atención sin presupuesto: queda en curso y luego realizado.
    await f.run((tx) =>
      addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: nebulization.id }),
    )
    const done = await f.run((tx) =>
      setPlanItemStatus(tx, ...f.args, nebulization.id, {
        status: "realizado",
        encounterId: f.encounter.id,
      }),
    )
    expect(done.status).toBe("realizado")

    // Al firmar no se arma un presupuesto: no hay nada que esperar.
    await f.ready(f.encounter.id)
    await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id, {}))
    const budgets = await f.run((tx) => listBudgets(tx, "org_a", f.patient.id))
    expect(budgets).toHaveLength(0)

    // Una atención nueva trae lo indicado sin presupuesto.
    const visit = await f.run((tx) =>
      createEncounter(tx, ...f.args, { reason: "Control", planItemIds: [control.id] }),
    )
    expect(visit.status).toBe("borrador")

    // Lo de odentIA que espera presupuesto sigue sin poder agendarse.
    await expect(
      f.run((tx) => setPlanItemStatus(tx, ...f.args, dental.id, { status: "programado" })),
    ).rejects.toThrow(/no está aceptado/)
  } finally {
    await setProduct("dental")
  }
})

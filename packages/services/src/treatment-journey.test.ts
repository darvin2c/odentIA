import { withOrgContext } from "@odentia/db"
import { encounter, odontogramEntry, patientContact } from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import {
  createBudget,
  decideBudget,
  deliverBudget,
  getBudgetDetail,
  reviseBudget,
} from "./budgets.js"
import { registerPatientDocument } from "./clinical.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { addEncounterProcedure, createEncounter } from "./encounters.js"
import { createFollowUp } from "./follow-ups.js"
import { getPatientSummary, getTimeline } from "./patient-history.js"
import {
  addPlanItem,
  createOptionGroup,
  listPlanItems,
  revisePlanItem,
  setPlanItemStatus,
} from "./plan.js"
import { createPrescription } from "./prescriptions.js"
import { grantResponsibility, revokeResponsibility } from "./responsibilities.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"
import { getTreatmentJourney } from "./treatment-journey.js"
setupTestDb()
it("traza alternativas, propuesta versionada, representante, sesiones y evidencia clínica", async () => {
  const f = await clinicalFixture()
  const [representative] = await ownerDb
    .insert(contact)
    .values({ organizationId: "org_a", displayName: "Representante" })
    .returning()
  await ownerDb.insert(patientContact).values({
    organizationId: "org_a",
    patientId: f.patient.id,
    contactId: representative.id,
    relationship: "guardian",
  })
  const role = await f.run((tx) =>
    grantResponsibility(tx, ...f.args, {
      contactId: representative.id,
      kind: "representante_legal",
      startsAt: "2020-01-01",
    }),
  )
  const group = await f.run((tx) =>
    createOptionGroup(tx, ...f.args, { planId: f.plan.id, title: "Alternativas" }),
  )
  const indication = {
    planId: f.plan.id,
    serviceId: f.service.id,
    sourceEncounterId: f.encounter.id,
    optionGroupId: group.id,
  }
  const a = await f.run((tx) => addPlanItem(tx, ...f.args, { ...indication, isRecommended: true }))
  const b = await f.run((tx) => addPlanItem(tx, ...f.args, indication))
  // Trazabilidad clínica: la indicación puede responder a un hallazgo del odontograma.
  const [finding] = await ownerDb
    .insert(odontogramEntry)
    .values({
      organizationId: "org_a",
      patientId: f.patient.id,
      toothNumber: 36,
      condition: "caries",
      details: { variant: "dentin" },
    })
    .returning()
  expect(finding).toBeDefined()
  const fromFinding = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { ...indication, odontogramEntryId: finding?.id }),
  )
  expect(fromFinding.odontogramEntryId).toBe(finding?.id)
  const findingJourney = await f.run((tx) =>
    getTreatmentJourney(tx, "org_a", f.patient.id, fromFinding.id, { finance: true }),
  )
  expect(findingJourney.originFinding).toMatchObject({ id: finding?.id, condition: "caries" })
  // Un hallazgo de otro paciente no puede motivar la indicación.
  await expect(
    f.run((tx) =>
      addPlanItem(tx, ...f.args, {
        ...indication,
        odontogramEntryId: "11111111-1111-4111-8111-111111111111",
      }),
    ),
  ).rejects.toMatchObject({ status: 404 })
  const budget = await f.run((tx) =>
    createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [a.id, b.id] }),
  )
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await expect(
    f.run((tx) =>
      decideBudget(tx, ...f.args, budget.id, {
        decisions: [{ planItemId: a.id, decision: "aceptado" }],
      }),
    ),
  ).rejects.toMatchObject({ code: "VALIDATION" })
  const decisions = [
    { planItemId: a.id, decision: "aceptado" as const },
    { planItemId: b.id, decision: "pospuesto" as const },
  ]
  const decided = await f.run((tx) =>
    decideBudget(tx, ...f.args, budget.id, { decisions, decidedByContactId: representative.id }),
  )
  expect(decided.status).toBe("parcial")
  expect(
    (await f.run((tx) => listPlanItems(tx, "org_a", f.patient.id))).find((i) => i.id === b.id),
  ).toMatchObject({ decisionStatus: "rechazado", decisionNote: "Alternativa no elegida" })
  const revision = await f.run((tx) =>
    reviseBudget(tx, ...f.args, budget.id, { itemIds: [a.id], reason: "Propuesta elegida" }),
  )
  expect(revision).toMatchObject({
    revisionNumber: 2,
    budgetNumber: budget.budgetNumber,
    supersedesBudgetId: budget.id,
  })
  expect((await f.run((tx) => getBudgetDetail(tx, "org_a", f.patient.id, budget.id))).status).toBe(
    "parcial",
  )
  await f.run((tx) => deliverBudget(tx, ...f.args, revision.id))
  await f.run((tx) =>
    decideBudget(tx, ...f.args, revision.id, {
      decisions: [decisions[0]],
      decidedByContactId: representative.id,
    }),
  )
  expect((await f.run((tx) => getBudgetDetail(tx, "org_a", f.patient.id, budget.id))).status).toBe(
    "sustituido",
  )
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: a.id }))
  await ownerDb
    .update(encounter)
    .set({
      status: "finalizada",
      finalizedAt: new Date(),
      signerName: "Clínico",
      signerRegistration: "COP 12345",
    })
    .where(eq(encounter.id, f.encounter.id))
  const second = await f.run((tx) =>
    createEncounter(tx, ...f.args, { reason: "Segunda sesión", planItemIds: [a.id] }),
  )
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, second.id, { planItemId: a.id }))
  const during = await f.run((tx) =>
    getTreatmentJourney(tx, "org_a", f.patient.id, a.id, { finance: true }),
  )
  expect(during.item.status).toBe("en_curso")
  expect(during.procedures.map((p) => p.encounter.id)).toEqual([f.encounter.id, second.id])
  await f.run((tx) =>
    setPlanItemStatus(tx, ...f.args, a.id, { status: "realizado", encounterId: second.id }),
  )
  await expect(
    f.run((tx) =>
      revisePlanItem(tx, ...f.args, a.id, {
        encounterId: second.id,
        serviceId: f.service.id,
        reason: "Cambio",
      }),
    ),
  ).rejects.toMatchObject({ code: "ITEM_CLOSED" })
  const followUp = await f.run((tx) =>
    createFollowUp(tx, ...f.args, {
      kind: "tratamiento",
      planItemId: a.id,
      title: "Control",
      dueAt: new Date(Date.now() + 86400000).toISOString(),
    }),
  )
  const rx = await f.run((tx) =>
    createPrescription(tx, ...f.args, {
      planItemId: a.id,
      encounterId: second.id,
      items: [
        {
          genericName: "paracetamol",
          strength: "500 mg",
          dosageForm: "tableta",
          dose: "Dosis",
          route: "oral",
          frequency: "Indicada",
          duration: "Indicada",
        },
      ],
    }),
  )
  const doc = await f.run((tx) =>
    registerPatientDocument(tx, ...f.args, {
      category: "receta",
      label: "Receta clínica",
      storageKey: "test/rx",
      contentType: "application/pdf",
      sizeBytes: 4,
      prescriptionId: rx.id,
      followUpId: followUp.id,
      budgetId: revision.id,
    }),
  )
  const journey = await f.run((tx) =>
    getTreatmentJourney(tx, "org_a", f.patient.id, a.id, { finance: true }),
  )
  expect(journey.documents.map((d) => d.id)).toContain(doc.id)
  expect(journey.prescriptions.map((p) => p.id)).toContain(rx.id)
  expect(journey.followUps.map((c) => c.id)).toContain(followUp.id)
  const summary = await f.run((tx) => getPatientSummary(tx, "org_a", f.patient.id))
  expect(summary.treatmentJourneys.find((j) => j.item.id === a.id)?.nextAction).toBe("controlar")
  expect(
    (await f.run((tx) => getTimeline(tx, "org_a", f.patient.id))).data.map((e) => e.type),
  ).toEqual(expect.arrayContaining(["plan", "budget", "prescription", "follow_up"]))
  await expect(
    withOrgContext(appDb, "org_b", (tx) =>
      getTreatmentJourney(tx, "org_b", f.patient.id, a.id, { finance: true }),
    ),
  ).rejects.toMatchObject({ status: 404 })
  await f.run((tx) =>
    revokeResponsibility(tx, ...f.args, role.id, { reason: "Fin de representación" }),
  )
})

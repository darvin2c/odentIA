/**
 * Revisión final de formularios (15 nov, Y2 de la voz clínica; §D de la entrega 6): indicar una
 * exodoncia a quien toma warfarina o un bisfosfonato no avisaba nada. Ahora la fila de la exodoncia
 * dice lo que toma y qué pedir, con quién lo dijo, sin frenar nada.
 */
import { patientMedication } from "@odentia/db/schema/clinical"
import { serviceFinding } from "@odentia/db/schema/dental"
import { expect, it } from "vitest"
import { addDeclaredHealth, recordHealthDeclaration } from "./clinical.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { addPlanItem, listPlanItems } from "./plan.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

it("la exodoncia por hacer dice lo que toma y la cambia; lo demás del plan y la coordinación, no", async () => {
  const f = await clinicalFixture()
  // El servicio del plan es una exodoncia: deja la pieza ausente.
  await ownerDb.insert(serviceFinding).values({ serviceId: f.service.id, organizationId: "org_a", condition: "missing_tooth" })
  const declared = {
    anticoagulants: { state: "recorded" as const, detail: "warfarina 5 mg" },
    boneMedicines: { state: "recorded" as const, detail: "alendronato 70 mg" },
  }
  await f.run(async (tx) => {
    await addDeclaredHealth(tx, "org_a", null, f.patient.id, declared, { entity: "registration_hold", entityId: f.patient.id, at: new Date() })
    await recordHealthDeclaration(tx, "org_a", f.patient.id, { via: "enlace", by: { kind: "patient", name: null, relation: null }, health: declared })
  })
  const item = await f.run((tx) => addPlanItem(tx, ...f.args, { planId: f.plan.id, serviceId: f.service.id, sourceEncounterId: f.encounter.id }))
  const [listed] = (await f.run((tx) => listPlanItems(tx, "org_a", f.patient.id, undefined, { extractionRisks: true }))).filter(
    (row) => row.id === item.id,
  )
  expect(listed?.extractionRisks).toEqual([
    expect.stringMatching(/^Toma warfarina 5 mg \(lo dijo el? ?[^)]*\): pide su INR del día\.$/),
    expect.stringMatching(/^Toma alendronato 70 mg \(lo dijo[^)]*\): riesgo de osteonecrosis de los maxilares\.$/),
  ])
  // Sin pedirlo (la coordinación, el dictado), no viaja.
  const plain = (await f.run((tx) => listPlanItems(tx, "org_a", f.patient.id))).find((row) => row.id === item.id)
  expect(plain).not.toHaveProperty("extractionRisks")
})

it("un apixabán dice el riesgo de sangrado, y el bisfosfonato que ya dejó sigue contando", async () => {
  const f = await clinicalFixture()
  await ownerDb.insert(serviceFinding).values({ serviceId: f.service.id, organizationId: "org_a", condition: "missing_tooth" })
  await ownerDb.insert(patientMedication).values([
    { organizationId: "org_a", patientId: f.patient.id, name: "Apixabán 5 mg", genericName: "apixabán", atcCode: "B01AF02" },
    { organizationId: "org_a", patientId: f.patient.id, name: "Ácido zoledrónico", atcCode: "M05BA08", endDate: "2024-01-01" },
    { organizationId: "org_a", patientId: f.patient.id, name: "Clopidogrel 75 mg", atcCode: "B01AC04", endDate: "2024-01-01" },
  ])
  const item = await f.run((tx) => addPlanItem(tx, ...f.args, { planId: f.plan.id, serviceId: f.service.id, sourceEncounterId: f.encounter.id }))
  const listed = (await f.run((tx) => listPlanItems(tx, "org_a", f.patient.id, undefined, { extractionRisks: true }))).find(
    (row) => row.id === item.id,
  )
  expect(listed?.extractionRisks).toEqual([
    "Toma Apixabán 5 mg: riesgo de sangrado.",
    "Tomó Ácido zoledrónico: riesgo de osteonecrosis de los maxilares.",
  ])
})

it("sin anticoagulante ni medicina para los huesos, la exodoncia no dice nada", async () => {
  const f = await clinicalFixture()
  await ownerDb.insert(serviceFinding).values({ serviceId: f.service.id, organizationId: "org_a", condition: "missing_tooth" })
  await ownerDb.insert(patientMedication).values({ organizationId: "org_a", patientId: f.patient.id, name: "Losartán 50 mg", atcCode: "C09CA01" })
  const item = await f.run((tx) => addPlanItem(tx, ...f.args, { planId: f.plan.id, serviceId: f.service.id, sourceEncounterId: f.encounter.id }))
  const listed = (await f.run((tx) => listPlanItems(tx, "org_a", f.patient.id, undefined, { extractionRisks: true }))).find(
    (row) => row.id === item.id,
  )
  expect(listed).not.toHaveProperty("extractionRisks")
})

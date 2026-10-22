import { orgProfile } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { finalizeEncounter, getEncounterClosing, getEncounterDetail } from "./encounters.js"
import { getPatientSummary } from "./patient-history.js"
import { loadPatientRecord } from "./patient-record.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const setProduct = (product: "dental" | "medical") =>
  ownerDb.update(orgProfile).set({ product }).where(eq(orgProfile.organizationId, "org_a"))

it("cada momento de lo común pregunta al producto: una clínica médica no ve nada dental", async () => {
  const f = await clinicalFixture()
  // odentIA: el cierre informa el odontograma y el periodontograma; el resumen,
  // los diagnósticos por pieza y las encías; la copia, el odontograma vigente.
  const dental = await f.run((tx) => getEncounterClosing(tx, ...f.args, f.encounter.id))
  expect(dental).toHaveProperty("odontogram", null)
  expect(dental).toHaveProperty("periodontal", null)
  expect(await f.run((tx) => getPatientSummary(tx, "org_a", f.patient.id))).toHaveProperty(
    "activeDiagnoses",
    [],
  )
  expect(
    await f.run((tx) => getEncounterDetail(tx, "org_a", f.patient.id, f.encounter.id)),
  ).toHaveProperty("odontogramEntries", [])
  const dentalRecord = await f.run((tx) => loadPatientRecord(tx, "org_a", f.patient.id))
  expect(dentalRecord.productSections.map((section) => section.title)).toEqual([
    "Odontograma vigente",
  ])

  await setProduct("medical")
  try {
    const closing = await f.run((tx) => getEncounterClosing(tx, ...f.args, f.encounter.id))
    expect(closing).not.toHaveProperty("odontogram")
    expect(closing).not.toHaveProperty("periodontal")
    const summary = await f.run((tx) => getPatientSummary(tx, "org_a", f.patient.id))
    expect(summary).not.toHaveProperty("activeDiagnoses")
    expect(summary).not.toHaveProperty("periodontal")
    expect(
      await f.run((tx) => getEncounterDetail(tx, "org_a", f.patient.id, f.encounter.id)),
    ).not.toHaveProperty("odontogramEntries")
    expect(
      (await f.run((tx) => loadPatientRecord(tx, "org_a", f.patient.id))).productSections,
    ).toEqual([])
    // Cerrar sigue igual en lo común, sin nada del odontograma.
    await f.ready(f.encounter.id)
    const closed = await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
    expect(closed.encounter.status).toBe("finalizada")
    expect(closed).not.toHaveProperty("odontogram")
  } finally {
    await setProduct("dental")
  }
})

import { randomUUID } from "node:crypto"
import { expect, it } from "vitest"
import { addOdontogramEntries } from "./odontogram.js"
import { clinicalFixture, seedDiagnosisCodes } from "../clinical-test-fixture.js"
import { addEncounterDiagnosis } from "../encounter-diagnoses.js"
import { setupTestDb } from "../test-setup.js"
import { getToothHistory } from "./tooth-history.js"

setupTestDb()

it("la historia de una pieza reúne sus hechos del más reciente al más antiguo", async () => {
  const f = await clinicalFixture()
  await seedDiagnosisCodes([{ code: "K02.1", title: "Caries de la dentina" }])
  await f.run((tx) =>
    addOdontogramEntries(tx, ...f.args, {
      toothNumber: 36,
      condition: "caries",
      surfaces: ["occlusal"],
      details: { variant: "dentin" },
      encounterId: f.encounter.id,
    }),
  )
  await f.run((tx) =>
    addEncounterDiagnosis(tx, ...f.args, f.encounter.id, {
      diagnosisCode: "K02.1",
      diagnosisType: "confirmed",
      toothNumber: 36,
      surfaces: ["occlusal"],
    }),
  )
  // Otra pieza no se mezcla.
  await f.run((tx) =>
    addEncounterDiagnosis(tx, ...f.args, f.encounter.id, {
      diagnosisCode: "K02.1",
      diagnosisType: "provisional",
      toothNumber: 46,
    }),
  )
  const events = await f.run((tx) => getToothHistory(tx, "org_a", f.patient.id, 36))
  expect(events.map((e) => e.kind)).toEqual(["diagnostico", "hallazgo"])
  expect(events[0]).toMatchObject({
    title: "Caries de la dentina",
    code: "CIE-10 · K02.1",
    surfaces: ["occlusal"],
    status: "activo",
    encounterOpen: true,
    authorName: "Clínico",
  })
  expect(events[1]).toMatchObject({ code: "caries", status: "vigente" })
})

it("rechaza piezas fuera de la notación FDI y pacientes ajenos", async () => {
  const f = await clinicalFixture()
  await expect(f.run((tx) => getToothHistory(tx, "org_a", f.patient.id, 19))).rejects.toMatchObject(
    { status: 400 },
  )
  await expect(f.run((tx) => getToothHistory(tx, "org_a", randomUUID(), 36))).rejects.toMatchObject(
    { status: 404 },
  )
})

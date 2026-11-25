import { expect, it } from "vitest"
import { clinicalFixture, seedDiagnosisCodes } from "../clinical-test-fixture.js"
import { getDiagnosisSuggestions } from "../diagnosis-codes.js"
import { setupTestDb } from "../test-setup.js"
import { addOdontogramEntries } from "./odontogram.js"

setupTestDb()

// QA del 23 nov (H5): la caries mesio-oclusal de la 26 proponía «26 · Oclusal» y perdía la mesial.
it("una caries de dos caras propone su diagnóstico con las dos caras", async () => {
  await seedDiagnosisCodes([
    { code: "K02", title: "Caries dental", isCategory: true },
    { code: "K02.1", title: "Caries de la dentina" },
    { code: "K02.9", title: "Caries dental, no especificada" },
  ])
  const f = await clinicalFixture()
  await f.run((tx) =>
    addOdontogramEntries(tx, ...f.args, {
      toothNumber: 26,
      condition: "caries",
      surfaces: ["mesial", "occlusal"],
      details: { variant: "dentin" },
      encounterId: f.encounter.id,
    }),
  )
  const suggestions = await f.run((tx) =>
    getDiagnosisSuggestions(tx, "org_a", { patientId: f.patient.id, encounterId: f.encounter.id }),
  )
  const fromFinding = suggestions.proposed.filter((item) => item.source === "hallazgo")
  expect(fromFinding).toHaveLength(1)
  expect(fromFinding[0]).toMatchObject({ toothNumber: 26 })
  expect([...((fromFinding[0] as { surfaces?: string[] }).surfaces ?? [])].sort()).toEqual([
    "mesial",
    "occlusal",
  ])
})

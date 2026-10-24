import { expect, it } from "vitest"
import { clinicalFixture, seedDiagnosisCodes } from "./clinical-test-fixture.js"
import { renderHealthDocumentPdf } from "./health-documents.js"
import {
  cancelMedicalLeave,
  createMedicalLeave,
  getMedicalLeavePrint,
  listMedicalLeaves,
} from "./medical-leaves.js"
import { setupTestDb } from "./test-setup.js"

setupTestDb()

it("el descanso médico: numerado, firmado, con el diagnóstico solo si se autorizó, y anulable (issue 229)", async () => {
  const f = await clinicalFixture()
  await seedDiagnosisCodes([{ code: "J03.9", title: "Amigdalitis aguda, no especificada" }])

  // Sin autorización, el diagnóstico no se guarda aunque llegue.
  const first = await f.run((tx) =>
    createMedicalLeave(tx, ...f.args, {
      encounterId: f.encounter.id,
      startsOn: "2026-10-24",
      days: 3,
      diagnosisCode: "J03.9",
      notes: "Reposo relativo",
    }),
  )
  expect(first).toMatchObject({
    leaveNumber: 1,
    status: "emitido",
    startsOn: "2026-10-24",
    endsOn: "2026-10-26",
    showDiagnosis: false,
    diagnosisCode: null,
    signerRegistration: "COP 12345",
  })

  // Con autorización, figura y la hoja trae su descripción.
  const second = await f.run((tx) =>
    createMedicalLeave(tx, ...f.args, {
      startsOn: "2026-10-27",
      days: 1,
      showDiagnosis: true,
      diagnosisCode: "J03.9",
    }),
  )
  expect(second).toMatchObject({
    leaveNumber: 2,
    showDiagnosis: true,
    diagnosisCode: "J03.9",
    endsOn: "2026-10-27",
  })
  const print = await f.run((tx) => getMedicalLeavePrint(tx, "org_a", f.patient.id, second.id))
  expect(print.diagnosisDescription).toBe("Amigdalitis aguda, no especificada")
  const pdf = await f.run((tx) =>
    renderHealthDocumentPdf(tx, "org_a", f.patient.id, "medical_leave", second.id),
  )
  expect(pdf.label).toBe("Descanso médico N.º 2")
  expect(pdf.bytes.byteLength).toBeGreaterThan(500)

  await expect(f.run((tx) => createMedicalLeave(tx, ...f.args, { days: 0 }))).rejects.toThrow(
    /de 1 a 365/,
  )

  // Se anula con motivo, una sola vez.
  const cancelled = await f.run((tx) =>
    cancelMedicalLeave(tx, ...f.args, first.id, { reason: "Fechas equivocadas" }),
  )
  expect(cancelled).toMatchObject({ status: "anulado", cancelReason: "Fechas equivocadas" })
  await expect(
    f.run((tx) => cancelMedicalLeave(tx, ...f.args, first.id, { reason: "Otra vez" })),
  ).rejects.toThrow(/ya está anulado/)
  const list = await f.run((tx) => listMedicalLeaves(tx, "org_a", f.patient.id))
  expect(list.map((leave) => leave.leaveNumber)).toEqual([2, 1])
})

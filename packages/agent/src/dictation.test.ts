import { describe, expect, it } from "vitest"
import { demoExtraction } from "./dictation.js"

/** Extracción de demostración: reglas simples para ver el recorrido sin proveedor. No mide a ningún modelo. */
const SERVICES = ["Resina compuesta", "Endodoncia multirradicular", "Profilaxis dental"]
const NOW = new Date("2026-10-12T15:00:00Z")

describe("dictado en modo de demostración", () => {
  it("ordena motivo, diagnóstico, indicaciones con su pieza y un control", () => {
    const drafts = demoExtraction(
      "Viene por dolor al masticar del lado derecho. En la dieciséis hay caries en dentina. Le ponemos una resina en la cara oclusal de la dieciséis. En la veintiséis hacemos endodoncia. Control en 6 meses.",
      SERVICES,
      NOW,
    )
    expect(drafts.map((draft) => draft.kind)).toEqual(["nota", "diagnostico", "plan", "plan", "control"])
    expect(drafts[0]).toMatchObject({ payload: { reason: "Viene por dolor al masticar del lado derecho." } })
    expect(drafts[1]).toMatchObject({
      payload: { cie10Code: "K02.1", diagnosisType: "presuntivo", toothNumber: 16 },
      sourceText: "En la dieciséis hay caries en dentina.",
    })
    expect(drafts[2]?.payload).toEqual({ service: "Resina compuesta", toothNumber: 16, surfaces: ["oclusal"] })
    expect(drafts[3]?.payload).toEqual({ service: "Endodoncia multirradicular", toothNumber: 26 })
    expect(drafts[4]?.payload).toMatchObject({ title: "Control en 6 meses" })
    expect(new Date(String(drafts[4]?.payload["dueAt"])).toISOString().slice(0, 7)).toBe("2027-04")
  })

  it("lee la pieza en cifras o en palabras y no inventa lo que no se dijo", () => {
    expect(demoExtraction("Profilaxis en toda la boca.", SERVICES, NOW)).toEqual([
      { kind: "plan", payload: { service: "Profilaxis dental" }, sourceText: "Profilaxis en toda la boca." },
    ])
    expect(demoExtraction("Resina en la pieza 46, cara mesial y distal.", SERVICES, NOW)[0]?.payload).toEqual({
      service: "Resina compuesta", toothNumber: 46, surfaces: ["mesial", "distal"],
    })
    expect(demoExtraction("Endodoncia en la cuarenta y seis.", SERVICES, NOW)[0]?.payload).toMatchObject({ toothNumber: 46 })
    expect(demoExtraction("Buenos días, tome asiento.", SERVICES, NOW)).toEqual([])
  })
})

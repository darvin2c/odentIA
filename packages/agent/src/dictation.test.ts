import { describe, expect, it } from "vitest"
import { demoExtraction, demoSegment, groundSource } from "./dictation.js"

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

  it("al seguir dictando reconoce una corrección de pieza y un «quita…» sobre lo pendiente", () => {
    const pending = [{ label: "Diagnóstico: K02.1 Caries de la dentina, Pieza 16" }, { label: "Plan de tratamiento: Endodoncia multirradicular, Pieza 25" }]
    expect(demoSegment("No, es la veintiséis.", SERVICES, NOW, pending)).toEqual({
      drafts: [],
      corrections: [{ index: 1, changes: { toothNumber: 26 }, sourceText: "No, es la veintiséis." }],
      removals: [],
    })
    expect(demoSegment("Quita la endodoncia.", SERVICES, NOW, pending)).toEqual({ drafts: [], corrections: [], removals: [{ index: 1, sourceText: "Quita la endodoncia." }] })
    // La corrección sigue a algo dicho en el mismo tramo: cambia eso, no lo pendiente.
    const same = demoSegment("En la veinticinco hacemos endodoncia. No, es la veintiséis.", SERVICES, NOW, pending)
    expect(same.corrections).toEqual([])
    expect(same.drafts[0]?.payload).toEqual({ service: "Endodoncia multirradicular", toothNumber: 26 })
    // Sin nada pendiente ni dicho, no hay qué corregir ni quitar.
    expect(demoSegment("No, es la veintiséis. Quita la corona.", SERVICES, NOW, [])).toEqual({ drafts: [], corrections: [], removals: [] })
  })

  it("solo conserva como «lo que dijiste» lo que de verdad está en lo dictado", () => {
    const heard = "En la dieciséis hay caries en dentina,  le ponemos una resina. Control en 6 meses."
    expect(groundSource("en la dieciséis hay caries en dentina", heard)).toBe("en la dieciséis hay caries en dentina")
    expect(groundSource("Control en 6 meses. El paciente tiene diabetes.", heard)).toBe("Control en 6 meses.")
    expect(groundSource("Caries profunda en la pieza 16", heard)).toBe("")
    expect(groundSource(undefined, heard)).toBe("")
  })
})

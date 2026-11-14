import { describe, expect, it } from "vitest"
import { portalHealthLines } from "./portal"

// Mesa de formularios del 13 nov, entrega 10 (C8): en su portal lee lo que envió, tal como lo envió.
describe("lo que nos contaste de tu salud, en el portal", () => {
  it("cada grupo en una línea, con «No» y «No sé» como los dijo", () => {
    expect(
      portalHealthLines({
        allergies: { state: "recorded", items: [{ substance: "Penicilina", severity: "desconocida" }] },
        conditions: { state: "none", items: [] },
        anticoagulants: { state: "recorded", detail: "Warfarina 5 mg" },
        boneMedicines: { state: "unknown" },
        medications: { state: "recorded", items: [{ name: "Metformina", dose: "850 mg" }] },
      }),
    ).toEqual([
      { label: "Alergias", value: "Penicilina" },
      { label: "Enfermedades", value: "No" },
      { label: "Anticoagulantes", value: "Warfarina 5 mg" },
      { label: "Medicinas para los huesos", value: "No sé" },
      { label: "Otros medicamentos", value: "Metformina 850 mg" },
    ])
    // Lo que no respondió no se dice.
    expect(portalHealthLines({ allergies: { state: "unanswered", items: [] } })).toEqual([])
  })
})

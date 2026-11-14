import { describe, expect, it } from "vitest"
import { declaredMedications, declaredTakesNoMedicine } from "./clinical.js"

// Sin base: las reglas puras de cómo entra lo que declaró en «Tus medicinas».
describe("declaredMedications", () => {
  it("lo dicho al responder «Sí» a una clase entra con su clase, y «algún otro» sin ella", () => {
    const rows = declaredMedications({
      anticoagulants: { state: "recorded", detail: "Warfarina 5 mg" },
      boneMedicines: { state: "recorded", detail: "Alendronato" },
      medications: { state: "recorded", items: [{ name: "Losartán" }] },
    })
    expect(rows.map((row) => [row.name, row.declaredClass])).toEqual([
      ["Warfarina 5 mg", "anticoagulants"],
      ["Alendronato", "boneMedicines"],
      ["Losartán", null],
    ])
  })

  it("un Sí sin decir cuál deja una fila que lo dice, y un No o un No sé no deja ninguna", () => {
    const rows = declaredMedications({
      anticoagulants: { state: "recorded" },
      boneMedicines: { state: "none" },
    })
    expect(rows).toEqual([{ name: "Anticoagulante (no dijo cuál)", declaredClass: "anticoagulants" }])
    expect(declaredMedications({ anticoagulants: { state: "unknown" } })).toEqual([])
  })

  it("lo que repitió con el mismo nombre en «algún otro» no se duplica", () => {
    const rows = declaredMedications({
      anticoagulants: { state: "recorded", detail: "warfarina" },
      medications: { state: "recorded", items: [{ name: "Warfarina" }, { name: "Metformina" }] },
    })
    expect(rows.map((row) => row.name)).toEqual(["warfarina", "Metformina"])
  })

  it("«Sintrom» escrito en «algún otro» no lleva clase: el nombre no se reconoce", () => {
    const rows = declaredMedications({
      anticoagulants: { state: "unknown" },
      medications: { state: "recorded", items: [{ name: "Sintrom" }] },
    })
    expect(rows).toEqual([{ name: "Sintrom", declaredClass: null }])
  })
})

// QA del 14 nov (B1): el «No» a «¿algún otro medicamento?» se guardaba como «no toma ninguno», al lado de
// un «No sé» al anticoagulante.
describe("declaredTakesNoMedicine", () => {
  it("«No» a «algún otro» es «ninguno» solo si también dijo que no a las dos clases", () => {
    expect(declaredTakesNoMedicine({ medications: { state: "none", items: [] }, anticoagulants: { state: "unknown" } })).toBe(false)
    expect(
      declaredTakesNoMedicine({
        medications: { state: "none", items: [] },
        anticoagulants: { state: "none" },
        boneMedicines: { state: "none" },
      }),
    ).toBe(true)
    // Un registro de antes, con una sola pregunta.
    expect(declaredTakesNoMedicine({ medications: { state: "none", items: [] } })).toBe(true)
  })
})

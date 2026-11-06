import { describe, expect, it } from "vitest"
import { DENTAL_MEDICATION_CATALOG, duplicateWarnings } from "./allergens.js"

describe("duplicateWarnings (ADR 0143)", () => {
  it("avisa el mismo principio, el mismo grupo y lo repetido; no lo que no se parece", () => {
    const taking = [{ name: "Ibuprofeno 400 mg", atcCode: "M01AE01" }]
    // Dos AINE: del mismo grupo.
    expect(duplicateWarnings([{ genericName: "diclofenaco" }], taking, DENTAL_MEDICATION_CATALOG)).toEqual([
      "Diclofenaco: ya toma Ibuprofeno 400 mg, del mismo grupo (antiinflamatorios no esteroideos).",
    ])
    // El mismo principio que ya toma.
    expect(duplicateWarnings([{ genericName: "ibuprofeno" }], taking, DENTAL_MEDICATION_CATALOG)[0]).toMatch(/el mismo principio activo \(ATC M01AE01\)/)
    // El mismo medicamento dos veces en la receta.
    expect(duplicateWarnings([{ genericName: "amoxicilina" }, { genericName: "amoxicilina" }], [], DENTAL_MEDICATION_CATALOG)).toEqual([
      "Amoxicilina va dos veces en la receta (ATC J01CA04).",
    ])
    // Paracetamol con un AINE no es un duplicado; lo escrito a mano, sin ATC, no se compara.
    expect(duplicateWarnings([{ genericName: "paracetamol" }], taking, DENTAL_MEDICATION_CATALOG)).toEqual([])
    expect(duplicateWarnings([{ genericName: "diclofenaco" }], [{ name: "Algo para el dolor", atcCode: null }], DENTAL_MEDICATION_CATALOG)).toEqual([])
  })
})

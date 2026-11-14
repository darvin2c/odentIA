import { describe, expect, it } from "vitest"
import type { Allergy, PatientHealth } from "../../lib/patients"
import { bareProduct, declareProduct } from "../../product/product-ui"
import { allergyOrigin } from "./allergies-card"

declareProduct(bareProduct("dental"))

// QA del 14 nov (H3 de desarrollo): la fila decía «La declaró el paciente» con el día en que entró a
// su ficha, aunque la hubiera dicho su madre o la hubiera dicho días antes.
describe("la fila de cada alergia en Antecedentes", () => {
  const latex = {
    id: "a1",
    substance: "Látex",
    source: "paciente",
    createdAt: "2026-11-14T15:00:00.000Z",
    createdBy: null,
  } as unknown as Allergy
  const member = () => "Dra. Ana Torres"
  const byMother = { kind: "representative" as const, name: "Carla Paz", relation: "madre" }

  it("dice quién lo dijo y el día en que lo dijo, con las palabras de la franja", () => {
    const pending = {
      declared: [
        {
          by: byMother,
          at: "2026-11-10T15:00:00.000Z",
          allergies: ["a1"],
          conditions: [],
          medications: [],
          pregnancy: false,
          saidNo: { allergies: false, conditions: false, medications: false },
        },
      ],
    } as unknown as PatientHealth
    expect(allergyOrigin(latex, pending, "M", member)).toBe("Lo dijo su madre, Carla, el 10 nov · sin revisar")
    expect(allergyOrigin(latex, pending, "M", member)).not.toContain("paciente")
  })

  it("ya revisada, sigue diciendo quién la dijo, sin «sin revisar»", () => {
    const reviewed = {
      declared: [],
      declarations: [
        { at: "2026-11-12T15:00:00.000Z", enteredAt: "2026-11-14T15:00:00.000Z", via: "registro", by: { kind: "patient", name: null, relation: null }, health: {} },
      ],
    } as unknown as PatientHealth
    expect(allergyOrigin(latex, reviewed, "F", member)).toBe("Lo dijo ella el 12 nov")
  })

  it("la del equipo dice quién la registró", () => {
    expect(allergyOrigin({ ...latex, source: "equipo", createdBy: "u1" } as Allergy, { declared: [] }, "F", member)).toMatch(
      /^Registrada por Dra\. Ana Torres · 14 nov/,
    )
  })
})

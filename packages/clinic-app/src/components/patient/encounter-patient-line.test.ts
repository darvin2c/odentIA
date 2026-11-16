import { describe, expect, it } from "vitest"
import { bareProduct, declareProduct } from "../../product/product-ui"
import { shortPatientName } from "./encounter-patient-line"
import { alertsByRisk } from "./patient-header"

declareProduct(bareProduct("dental"))

type Detail = Parameters<typeof alertsByRisk>[0]

const base: Detail = {
  activeAllergies: [],
  activeConditions: [],
  currentMedications: [],
  allergyReview: null,
  allergySaidUnknown: null,
}

// Estudio de la atención (16 nov, P12, la voz clínica): en el teléfono se ve una alerta y «+N». El
// orden es por riesgo: nunca «Niega alergias» a la vista con el anticoagulante escondido.
describe("las alertas de la línea fija, por riesgo", () => {
  it("la alergia a la penicilina y el anticoagulante van primero; «Niega alergias», al final", () => {
    const detail = {
      ...base,
      activeAllergies: [
        {
          id: "penicilina",
          substance: "Penicilina",
          substanceSystem: null,
          substanceCode: null,
          kind: "alergia",
          severity: "severa",
          criticality: "alta",
          verification: "confirmada",
        },
      ],
      currentMedications: [
        { id: "warfarina", name: "Warfarina", dose: "5 mg", atcCode: "B01AA03" },
        { id: "paracetamol", name: "Paracetamol", dose: null, atcCode: "N02BE01" },
      ],
      activeConditions: [{ id: "hta", name: "Hipertensión arterial" }],
    } as unknown as Detail
    expect(alertsByRisk(detail, null).map((alert) => alert.id)).toEqual([
      "penicilina",
      "warfarina",
      "hta",
      "paracetamol",
    ])
  })

  it("sin alergias: «Niega alergias» queda detrás del anticoagulante, y «no se le preguntó» va adelante", () => {
    const anticoagulated = {
      ...base,
      currentMedications: [{ id: "warfarina", name: "Warfarina", dose: null, atcCode: "B01AA03" }],
    } as unknown as Detail
    expect(alertsByRisk({ ...anticoagulated, allergyReview: "none" }, null).map((alert) => alert.label)).toEqual([
      "Anticoagulante: Warfarina",
      "Niega alergias",
    ])
    expect(alertsByRisk({ ...anticoagulated, allergyReview: "unknown" }, null).map((alert) => alert.label)).toEqual([
      "Alergias: no se le preguntó",
      "Anticoagulante: Warfarina",
    ])
  })
})

describe("el nombre corto del teléfono", () => {
  it("«Carmen R.»: el primer nombre y la inicial del apellido", () => {
    expect(shortPatientName({ givenNames: "Carmen Lucía", familyName: "Rivas Soto", displayName: "Carmen Lucía Rivas Soto" })).toBe("Carmen R.")
    expect(shortPatientName({ givenNames: null, familyName: null, displayName: "Carmen Rivas" })).toBe("Carmen Rivas")
  })
})

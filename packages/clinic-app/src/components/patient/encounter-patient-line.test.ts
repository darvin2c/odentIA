import { describe, expect, it } from "vitest"
import { bareProduct, declareProduct } from "../../product/product-ui"
import { SHOWN, shortPatientName } from "./encounter-patient-line"
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

// QA del 16 nov, Q6 (B9b): Carmen, alérgica a penicilinas (sin gravedad anotada) y con warfarina. A
// 390 px la línea decía «Anticoagulante: Warfarina 5 mg · +1» y la alergia quedaba escondida.
describe("en el teléfono, la alergia y el anticoagulante se leen sin tocar nada", () => {
  const carmen = {
    ...base,
    activeAllergies: [
      {
        id: "penicilinas",
        substance: "Penicilinas",
        substanceSystem: null,
        substanceCode: null,
        kind: "alergia",
        severity: "desconocida",
        criticality: "desconocida",
        verification: "sin_confirmar",
      },
      {
        id: "lactosa",
        substance: "Lactosa",
        substanceSystem: null,
        substanceCode: null,
        kind: "intolerancia",
        severity: "leve",
        criticality: "baja",
        verification: "sin_confirmar",
      },
    ],
    currentMedications: [{ id: "warfarina", name: "Warfarina", dose: "5 mg", atcCode: "B01AA03" }],
  } as unknown as Detail

  it("toda alergia va antes que el anticoagulante; la intolerancia, después", () => {
    expect(alertsByRisk(carmen, null).map((alert) => alert.id)).toEqual(["penicilinas", "warfarina", "lactosa"])
  })

  it("caben dos, con su rótulo corto: «Alergia: Penicilinas» y «Warfarina»", () => {
    expect(SHOWN.phone).toBe(2)
    const shown = alertsByRisk(carmen, null).slice(0, SHOWN.phone)
    expect(shown.map((alert) => alert.short)).toEqual(["Alergia: Penicilinas", "Warfarina"])
    // El rótulo entero sigue en la tableta y el escritorio, y al pasar el cursor.
    expect(shown.map((alert) => alert.label)).toEqual(["Alergia: Penicilinas", "Anticoagulante: Warfarina 5 mg"])
  })
})

describe("el nombre corto del teléfono", () => {
  it("«Carmen R.»: el primer nombre y la inicial del apellido", () => {
    expect(shortPatientName({ givenNames: "Carmen Lucía", familyName: "Rivas Soto", displayName: "Carmen Lucía Rivas Soto" })).toBe("Carmen R.")
    expect(shortPatientName({ givenNames: null, familyName: null, displayName: "Carmen Rivas" })).toBe("Carmen Rivas")
  })
})

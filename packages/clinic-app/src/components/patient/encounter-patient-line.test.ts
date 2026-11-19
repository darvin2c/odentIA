import { describe, expect, it } from "vitest"
import { bareProduct, declareProduct } from "../../product/product-ui"
import { SHOWN, shortPatientName } from "./encounter-patient-line"
import { alertsByRisk, clinicalAlerts, drugWords } from "./patient-header"

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
      "Anticoagulante: warfarina",
      "Niega alergias",
    ])
    expect(alertsByRisk({ ...anticoagulated, allergyReview: "unknown" }, null).map((alert) => alert.label)).toEqual([
      "Alergias: no se le preguntó",
      "Anticoagulante: warfarina",
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
    expect(shown.map((alert) => alert.label)).toEqual(["Alergia: Penicilinas", "Anticoagulante: warfarina 5 mg"])
  })
})

describe("el nombre corto del teléfono", () => {
  it("«Carmen R.»: el primer nombre y la inicial del apellido", () => {
    expect(shortPatientName({ givenNames: "Carmen Lucía", familyName: "Rivas Soto", displayName: "Carmen Lucía Rivas Soto" })).toBe("Carmen R.")
    expect(shortPatientName({ givenNames: null, familyName: null, displayName: "Carmen Rivas" })).toBe("Carmen Rivas")
  })
})

// QA de diseño del 18 nov (H12): arriba iban huesos, anticoagulante y alergia; en la línea fija,
// alergia, huesos y anticoagulante. Y «alendronato» junto a «Apixabán».
it("la franja de arriba y la línea fija dicen sus alertas en el mismo orden y con las mismas minúsculas", () => {
  const teresa = {
    ...base,
    activeAllergies: [
      {
        id: "penicilinas",
        substance: "Penicilinas",
        substanceSystem: null,
        substanceCode: null,
        kind: "alergia",
        severity: "moderada",
        criticality: "baja",
        verification: "confirmada",
      },
    ],
    currentMedications: [
      { id: "alendronato", name: "alendronato 70 mg semanal", dose: null, atcCode: "M05BA04" },
      { id: "apixaban", name: "Apixabán", dose: null, atcCode: "B01AF02" },
    ],
  } as unknown as Detail
  const top = clinicalAlerts(teresa).map((alert) => alert.id)
  const fixed = alertsByRisk(teresa, null).map((alert) => alert.id)
  expect(top).toEqual(["penicilinas", "alendronato", "apixaban"])
  expect(fixed).toEqual(top)
  expect(clinicalAlerts(teresa).map((alert) => alert.label).slice(1)).toEqual([
    "Medicina para los huesos: alendronato 70 mg semanal",
    "Anticoagulante: apixabán",
  ])
  // Una sigla queda como está.
  expect(drugWords("Antiagregante: AAS 100 mg")).toBe("Antiagregante: AAS 100 mg")
})

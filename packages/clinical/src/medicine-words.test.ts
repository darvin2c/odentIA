import { describe, expect, it } from "vitest"
import { doseFromSaid, frequencyCodeOf, groundedDose, medicineLine, medicineName, medicineWords, structuredDose } from "./medicine-words.js"

describe("una medicina dicha, en sus partes (revisión del 25 nov)", () => {
  it.each([
    ["apixabán de cinco miligramos cada doce horas", { name: "apixabán", dose: "5 mg", frequency: "cada 12 h" }],
    ["aspirina de cien miligramos una vez al día", { name: "aspirina", dose: "100 mg", frequency: "1 vez al día" }],
    ["metformina ochocientos cincuenta miligramos dos veces al día", { name: "metformina", dose: "850 mg", frequency: "2 veces al día" }],
    ["Eliquis 5mg", { name: "Eliquis", dose: "5 mg" }],
    ["metformina 850 mg dos veces al día", { name: "metformina", dose: "850 mg", frequency: "2 veces al día" }],
    ["salbutamol dos puffs cada ocho horas", { name: "salbutamol", dose: "2 puffs", frequency: "cada 8 h" }],
    ["Eliquis 5mg c/12h", { name: "Eliquis", dose: "5 mg", frequency: "c/12h" }],
    // Revisión de código del 26 nov: miles y decimales.
    ["Vitamina B12 1.000 mcg", { name: "Vitamina B12", dose: "1000 mcg" }],
    ["Vitamina D3 50.000 UI semanal", { name: "Vitamina D3", dose: "50000 UI", frequency: "semanal" }],
    ["Vitamina D 50,000 UI", { name: "Vitamina D", dose: "50000 UI" }],
    ["vitamina D de cincuenta mil UI", { name: "vitamina D", dose: "50000 UI" }],
    ["clonazepam de cero coma cinco miligramos", { name: "clonazepam", dose: "0,5 mg" }],
    ["levotiroxina 0,25 mg", { name: "levotiroxina", dose: "0,25 mg" }],
  ])("«%s»", (said, parts) => {
    expect(medicineWords(said)).toEqual(parts)
  })

  it.each([
    "omega 3",
    "vitamina D",
    "ácido fólico",
    "apixabán",
    "losartán una vez al día",
    // Sin unidad dicha no se adivina: la levotiroxina «de cien» son microgramos, no miligramos.
    "apixabán de cinco",
    "losartán cincuenta",
    "levotiroxina de cien",
    "insulina de veinte",
    "omega tres",
    "vitamina B doce",
    "coenzima Q diez",
    "metformina de quinientos dos al día",
    "clonazepam cero punto cinco",
    // Lo que no es claro no se parte (revisión de código del 26 nov).
    "apixabán cada doce horas",
    "denosumab cada seis meses",
    "warfarina desde hace dos años",
    "alendronato por cinco años",
    "metformina una al día",
    "losartán uno en la mañana",
    "insulina mixta setenta treinta",
    "losartán de 50 y amlodipino de 5",
    "Losartán 50 mg con hidroclorotiazida 12,5 mg",
    "Enalapril y amlodipino de 5 mg",
    "Xarelto 20",
    "Glucophage XR 750",
  ])("«%s» se queda entero como nombre", (said) => {
    expect(medicineWords(said)).toEqual({ name: said })
  })

  it("en una línea se lee como en una receta", () => {
    expect(medicineLine(medicineWords("apixabán de cinco miligramos cada doce horas"))).toBe("apixabán 5 mg cada 12 h")
  })
})

describe("el nombre sin la dosis del final, para comparar filas", () => {
  it.each([
    ["Losartán 50", "Losartán"],
    ["losartán cincuenta", "losartán"],
    ["losartán 50 mg", "losartán"],
    ["Xarelto 20", "Xarelto"],
    ["Vitamina B12", "Vitamina B12"],
    ["ácido fólico", "ácido fólico"],
  ])("«%s» → «%s»", (said, name) => {
    expect(medicineName(said)).toBe(name)
  })
})

describe("la dosis que trae Clío, con lo que se dijo (QA del 26 nov)", () => {
  const said = "tomo apixaban de cinco miligramos cada doce horas y losartan cincuenta"
  it.each([
    ["5 mg", "5 mg"],
    ["50 mg", "50"],
    ["cincuenta", "50"],
    ["5mg", "5 mg"],
    ["una tableta", ""],
    ["diez mg", ""],
  ])("«%s» → «%s»", (dose, grounded) => {
    expect(groundedDose(dose, said)).toBe(grounded)
  })
})

describe("la dosis y cada cuánto en los campos de la fila", () => {
  it("«5 mg» y «cada 12 h» son de la lista; «50» y «en la noche», no", () => {
    expect(structuredDose("5 mg")).toEqual({ doseValue: 5, doseUnit: "mg" })
    expect(structuredDose("2 puffs")).toEqual({ doseValue: 2, doseUnit: "{puff}" })
    expect(structuredDose("50")).toBeNull()
    expect(frequencyCodeOf("cada 12 h")).toBe("cada_12_h")
    expect(frequencyCodeOf("2 veces al día")).toBe("cada_12_h")
    expect(frequencyCodeOf("en la noche")).toBeNull()
  })
})

describe("la dosis leída de la frase, junto a su nombre (QA del 26 nov)", () => {
  const said = "tomo apixaban de cinco miligramos cada doce horas y losartan cincuenta, y metformina 850 miligramos"
  it.each([
    ["apixabán", { dose: "5 mg", frequency: "cada 12 h" }],
    ["losartán", {}],
    ["metformina", { dose: "850 mg" }],
    ["warfarina", {}],
  ])("«%s»", (name, parts) => {
    expect(doseFromSaid(name, said)).toEqual(parts)
  })
})

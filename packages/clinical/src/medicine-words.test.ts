import { describe, expect, it } from "vitest"
import { medicineLine, medicineWords } from "./medicine-words.js"

describe("una medicina dicha, en sus partes (revisión del 25 nov)", () => {
  it.each([
    ["apixabán de cinco miligramos cada doce horas", { name: "apixabán", dose: "5 mg", frequency: "cada 12 h" }],
    ["apixabán de cinco", { name: "apixabán", dose: "5" }],
    ["losartán cincuenta", { name: "losartán", dose: "50" }],
    ["aspirina de cien una vez al día", { name: "aspirina", dose: "100", frequency: "1 vez al día" }],
    ["metformina ochocientos cincuenta dos veces al día", { name: "metformina", dose: "850", frequency: "2 veces al día" }],
    ["Eliquis 5mg", { name: "Eliquis", dose: "5 mg" }],
    ["metformina 850 mg dos veces al día", { name: "metformina", dose: "850 mg", frequency: "2 veces al día" }],
    ["salbutamol dos puffs cada ocho horas", { name: "salbutamol", dose: "2 puffs", frequency: "cada 8 h" }],
    ["enalapril de diez y medio", { name: "enalapril", dose: "10,5" }],
    ["vitamina D de cincuenta mil UI", { name: "vitamina D", dose: "50000 UI" }],
    ["Eliquis 5mg c/12h", { name: "Eliquis", dose: "5 mg", frequency: "c/12h" }],
  ])("«%s»", (said, parts) => {
    expect(medicineWords(said)).toEqual(parts)
  })

  it.each([
    "omega 3",
    "vitamina D",
    "ácido fólico",
    "apixabán",
    "losartán una vez al día",
    // Lo que no es claro no se parte (revisión de código del 26 nov).
    "apixabán cada doce horas",
    "denosumab cada seis meses",
    "warfarina desde hace dos años",
    "alendronato por cinco años",
    "metformina una al día",
    "losartán uno en la mañana",
    "insulina mixta setenta treinta",
    "losartán de 50 y amlodipino de 5",
  ])("«%s» se queda entero como nombre", (said) => {
    expect(medicineWords(said)).toEqual({ name: said })
  })

  it("sin unidad dicha no se inventa: la levotiroxina «de cien» queda en «100»", () => {
    expect(medicineWords("levotiroxina de cien")).toEqual({ name: "levotiroxina", dose: "100" })
  })

  it("en una línea se lee como en una receta", () => {
    expect(medicineLine(medicineWords("apixabán de cinco miligramos cada doce horas"))).toBe("apixabán 5 mg cada 12 h")
  })
})

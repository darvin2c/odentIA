import { describe, expect, it } from "vitest"
import { medicineLine, medicineWords } from "./medicine-words.js"

describe("una medicina dicha, en sus partes (revisión del 25 nov)", () => {
  it.each([
    ["apixabán de cinco miligramos cada doce horas", { name: "apixabán", dose: "5 mg", frequency: "cada 12 h" }],
    ["apixabán de cinco", { name: "apixabán", dose: "5 mg" }],
    ["losartán cincuenta", { name: "losartán", dose: "50 mg" }],
    ["aspirina de cien una vez al día", { name: "aspirina", dose: "100 mg", frequency: "1 vez al día" }],
    ["metformina ochocientos cincuenta dos veces al día", { name: "metformina", dose: "850 mg", frequency: "2 veces al día" }],
    ["Eliquis 5mg", { name: "Eliquis", dose: "5 mg" }],
    ["metformina 850 mg dos veces al día", { name: "metformina", dose: "850 mg", frequency: "2 veces al día" }],
    ["salbutamol dos puffs cada ocho horas", { name: "salbutamol", dose: "2 puffs", frequency: "cada 8 h" }],
    ["enalapril de diez y medio", { name: "enalapril", dose: "10,5 mg" }],
  ])("«%s»", (said, parts) => {
    expect(medicineWords(said)).toEqual(parts)
  })

  it.each(["omega 3", "vitamina D", "ácido fólico", "apixabán", "losartán una vez al día"])("«%s» se queda entero como nombre", (said) => {
    expect(medicineWords(said)).toEqual({ name: said })
  })

  it("en una línea se lee como en una receta", () => {
    expect(medicineLine(medicineWords("apixabán de cinco miligramos cada doce horas"))).toBe("apixabán 5 mg cada 12 h")
  })
})

import { describe, expect, it } from "vitest"
import { suggestedQuantity } from "./prescribed-quantity.js"

const amoxicilina = {
  dose: "1 cápsula",
  frequency: "cada 8 h",
  duration: "7 días",
  dosageForm: "cápsula",
  strength: "500 mg",
}

describe("la cantidad total que propone el dictado", () => {
  it("amoxicilina 500 mg, 1 cápsula cada 8 h por 7 días son 21 cápsulas", () => {
    const suggestion = suggestedQuantity(amoxicilina)
    expect(suggestion).toEqual({ quantity: 21, perDose: 1, perDay: 3, days: 7 })
  })

  // Revisión de las reglas clínicas del 18 nov: el dictado lo calculaba con la palabra de la dosis.
  it("sin la forma farmacéutica dicha, la dosis con su unidad cuenta: «1 tableta» cada 8 horas por 7 días son 21", () => {
    const said = {
      dose: "1 tableta",
      frequency: "cada 8 horas",
      duration: "7 días",
      dosageForm: "",
    }
    expect(suggestedQuantity(said)?.quantity).toBe(21)
    expect(suggestedQuantity({ ...said, dose: "dos cápsulas" })?.quantity).toBe(42)
    // Sin unidad que se cuente, nada; con una forma que no se cuenta, tampoco.
    expect(suggestedQuantity({ ...said, dose: "10 mL" })).toBeNull()
    expect(suggestedQuantity({ ...said, dosageForm: "jarabe" })).toBeNull()
  })

  it("se lee como se escribe o se dicta: «8 h», «c/8 hrs», «cada ocho horas», «3 veces al día», semanas", () => {
    expect(suggestedQuantity({ ...amoxicilina, frequency: "8 h" })?.quantity).toBe(21)
    expect(suggestedQuantity({ ...amoxicilina, frequency: "c/8h" })?.quantity).toBe(21)
    expect(suggestedQuantity({ ...amoxicilina, frequency: "c/8 hrs" })?.quantity).toBe(21)
    expect(suggestedQuantity({ ...amoxicilina, frequency: "cada ocho horas" })?.quantity).toBe(21)
    expect(suggestedQuantity({ ...amoxicilina, frequency: "3 veces al día" })?.quantity).toBe(21)
    expect(suggestedQuantity({ ...amoxicilina, frequency: "una vez al día" })?.quantity).toBe(7)
    expect(suggestedQuantity({ ...amoxicilina, duration: "dos semanas" })?.quantity).toBe(42)
    expect(
      suggestedQuantity({
        ...amoxicilina,
        dose: "2 cápsulas",
        frequency: "cada 12 horas",
        duration: "x 5 días",
      })?.quantity,
    ).toBe(20)
  })

  it("la dosis en mg cuenta si es un múltiplo entero de la concentración", () => {
    // Ibuprofeno 400 mg, 400 mg cada 8 horas por 3 días: 9 tabletas.
    const ibuprofeno = {
      dose: "400 mg",
      frequency: "cada 8 horas",
      duration: "3 días",
      dosageForm: "tableta",
      strength: "400 mg",
    }
    expect(suggestedQuantity(ibuprofeno)?.quantity).toBe(9)
    expect(suggestedQuantity({ ...amoxicilina, dose: "1 g" })?.quantity).toBe(42)
    // 600 mg con tabletas de 400 mg no es un número entero de tabletas: no se adivina.
    expect(suggestedQuantity({ ...ibuprofeno, dose: "600 mg" })).toBeNull()
  })

  it("media tableta se redondea hacia arriba al total", () => {
    const half = {
      dose: "½ tableta",
      frequency: "cada 8 horas",
      duration: "5 días",
      dosageForm: "tableta",
    }
    expect(suggestedQuantity(half)?.quantity).toBe(8)
    expect(suggestedQuantity({ ...half, dose: "media tableta" })?.quantity).toBe(8)
  })

  it("«si hay dolor» con frecuencia y duración propone el máximo; sin duración, nada", () => {
    const ibuprofeno = {
      dose: "1 tableta",
      frequency: "cada 8 h si hay dolor",
      duration: "3 días",
      dosageForm: "tableta",
      strength: "400 mg",
    }
    expect(suggestedQuantity(ibuprofeno)?.quantity).toBe(9)
    expect(suggestedQuantity({ ...ibuprofeno, duration: "" })).toBeNull()
    expect(suggestedQuantity({ ...ibuprofeno, frequency: "si hay dolor" })).toBeNull()
  })

  it("los sobres se cuentan por toma, como antes", () => {
    const sobre = {
      dose: "1 sobre",
      frequency: "cada 12 horas",
      duration: "5 días",
      dosageForm: "polvo",
    }
    expect(suggestedQuantity(sobre)?.quantity).toBe(10)
    expect(suggestedQuantity({ ...sobre, dosageForm: "sobre" })?.quantity).toBe(10)
  })

  it("nada en un jarabe, un tópico, uso continuo, dosis por peso o «cada 5 h»", () => {
    expect(
      suggestedQuantity({
        dose: "5 ml",
        frequency: "cada 8 horas",
        duration: "5 días",
        dosageForm: "jarabe",
        strength: "250 mg/5 ml",
      }),
    ).toBeNull()
    expect(
      suggestedQuantity({
        dose: "1 aplicación",
        frequency: "cada 8 horas",
        duration: "7 días",
        dosageForm: "gel",
      }),
    ).toBeNull()
    expect(suggestedQuantity({ ...amoxicilina, duration: "uso continuo" })).toBeNull()
    expect(suggestedQuantity({ ...amoxicilina, dose: "15 mg/kg" })).toBeNull()
    expect(suggestedQuantity({ ...amoxicilina, frequency: "cada 5 horas" })).toBeNull()
    // Sin forma dicha y con la dosis en mg, no se sabe qué se cuenta.
    expect(suggestedQuantity({ ...amoxicilina, dosageForm: "", dose: "500 mg" })).toBeNull()
  })
})

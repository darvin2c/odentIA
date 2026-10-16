import { describe, expect, it } from "vitest"
import { budgetAnswerText, budgetOptionLabel, budgetStateText } from "./budget-words.js"

describe("un solo nombre para cada estado del presupuesto", () => {
  it("dice cada estado con las palabras del tablero 3", () => {
    const said = (status: string) => budgetStateText({ status, items: [] })
    expect(said("borrador")).toBe("Por enviar")
    expect(said("presentado")).toBe("Enviado · espera respuesta")
    expect(said("pospuesto")).toBe("Lo está pensando")
    expect(said("aceptado")).toBe("Aceptó todo")
    expect(said("rechazado")).toBe("No aceptó")
    expect(said("sustituido")).toBe("Reemplazado")
    expect(said("cancelado")).toBe("Anulado")
    // Un estado desconocido nunca sale como código.
    expect(said("en_espera")).toBe("En espera")
  })

  it("«Aceptó N de M» cuenta solo las líneas de la opción elegida", () => {
    const items = [
      { decision: "aceptado", optionId: "a" },
      { decision: "pospuesto", optionId: "a" },
      { decision: "aceptado", optionId: "b" },
      { decision: "no_elegida", optionId: "b" },
    ]
    expect(
      budgetStateText({ status: "parcial", items, options: [{ id: "a", decision: "elegida" }, { id: "b", decision: "no_elegida" }] }),
    ).toBe("Aceptó 1 de 2")
    // Sin opción elegida (una sola opción), cuentan todas menos las no elegidas.
    expect(budgetStateText({ status: "parcial", items })).toBe("Aceptó 2 de 3")
  })

  it("la respuesta por tratamiento y la letra de cada opción", () => {
    expect(budgetAnswerText("pospuesto")).toBe("Lo está pensando")
    expect(budgetAnswerText("no_elegida")).toBe("No elegida")
    expect(budgetAnswerText(null)).toBe("Por responder")
    expect([1, 2, 3].map(budgetOptionLabel)).toEqual(["Opción A", "Opción B", "Opción C"])
  })
})

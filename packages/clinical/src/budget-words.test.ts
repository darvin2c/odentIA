import { describe, expect, it } from "vitest"
import { budgetAnswerText, budgetOptionLabel, budgetStateText, isRetiredPlanStatus, planItemStateText } from "./budget-words.js"

describe("un solo nombre para cada estado del presupuesto", () => {
  it("dice cada estado con las palabras del tablero 3", () => {
    const said = (status: string) => budgetStateText({ status, items: [] })
    expect(said("borrador")).toBe("Por enviar")
    expect(said("presentado")).toBe("Entregado · espera respuesta")
    expect(said("pospuesto")).toBe("Lo está pensando")
    expect(said("aceptado")).toBe("Aceptó todo")
    expect(said("rechazado")).toBe("No aceptó")
    expect(said("sustituido")).toBe("Reemplazado")
    expect(said("cancelado")).toBe("Anulado")
    // Un estado desconocido nunca sale como código.
    expect(said("en_espera")).toBe("En espera")
  })

  // QA del 9 nov: la Historia y el Plan decían «Aceptó todo» junto a «Exodoncia · No elegida».
  it("con varias opciones, aceptar es elegir una: «Eligió la opción A»", () => {
    const items = [
      { decision: "aceptado", optionId: "a" },
      { decision: "no_elegida", optionId: "b" },
    ]
    const options = [
      { id: "a", decision: "elegida", position: 1 },
      { id: "b", decision: "no_elegida", position: 2 },
    ]
    expect(budgetStateText({ status: "aceptado", items, options })).toBe("Eligió la opción A")
    // Una sola opción sigue siendo «Aceptó todo».
    expect(budgetStateText({ status: "aceptado", items, options: [{ id: "a", decision: "elegida", position: 1 }] })).toBe(
      "Aceptó todo",
    )
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

// Tercer repaso del 9 nov (E9): la tarjeta plegada decía «Cancelado» y la abierta «Por decidir».
describe("una sola etiqueta por tratamiento, plegado y abierto", () => {
  it("lo que no empezó dice su decisión; lo empezado o quitado, su estado", () => {
    expect(planItemStateText("pendiente", "pendiente")).toBe("Por responder")
    expect(planItemStateText("pendiente", "pospuesto")).toBe("Lo está pensando")
    expect(planItemStateText("pendiente", "aceptado")).toBe("Aceptado")
    expect(planItemStateText("programado", "aceptado")).toBe("Con cita")
    expect(planItemStateText("en_curso", "aceptado")).toBe("En curso")
    // Quitado, aunque nadie respondiera: «Cancelado», no «Por responder».
    expect(planItemStateText("cancelado", "pendiente")).toBe("Cancelado")
    expect(planItemStateText("reemplazado", null)).toBe("Reemplazado")
  })

  it("lo cancelado o reemplazado ya no es trabajo vigente", () => {
    expect(isRetiredPlanStatus("cancelado")).toBe(true)
    expect(isRetiredPlanStatus("reemplazado")).toBe(true)
    expect(isRetiredPlanStatus("realizado")).toBe(false)
    expect(isRetiredPlanStatus("en_curso")).toBe(false)
  })
})

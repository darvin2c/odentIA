import { describe, expect, it } from "vitest"
import {
  budgetAnswerLine,
  budgetChoiceText,
  budgetAnswerText,
  budgetOptionLabel,
  budgetStateText,
  isRetiredPlanStatus,
  planItemStateText,
} from "./budget-words.js"

describe("un solo nombre para cada estado del presupuesto", () => {
  it("dice cada estado con las palabras del tablero 3", () => {
    const said = (status: string) => budgetStateText({ status, items: [] })
    expect(said("borrador")).toBe("Por enviar")
    expect(said("presentado")).toBe("Entregado · espera respuesta")
    expect(said("pospuesto")).toBe("Lo piensa")
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
    expect(budgetAnswerText("pospuesto")).toBe("Lo piensa")
    expect(budgetAnswerText("no_elegida")).toBe("No elegida")
    expect(budgetAnswerText(null)).toBe("Por responder")
    expect([1, 2, 3].map(budgetOptionLabel)).toEqual(["Opción A", "Opción B", "Opción C"])
  })
})

// Tercer repaso del 9 nov (E9): la tarjeta plegada decía «Cancelado» y la abierta «Por decidir».
describe("una sola etiqueta por tratamiento, plegado y abierto", () => {
  it("lo que no empezó dice su decisión; lo empezado o quitado, su estado", () => {
    expect(planItemStateText("pendiente", "pendiente")).toBe("Por responder")
    expect(planItemStateText("pendiente", "pospuesto")).toBe("Lo piensa")
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

// QA del 16 nov (E3, B1c): la línea de lo elegido decía el total de la opción y «Lo está pensando».
describe("lo respondido en una línea", () => {
  const money = (cents: number) => `S/ ${(cents / 100).toFixed(2)}`
  const line = (planItemId: string, optionId: string, title: string, cents: number, decision: string) => ({
    planItemId,
    optionId,
    title,
    lineTotalCents: cents,
    currency: "PEN",
    decision,
  })
  it("eligió la opción A: lo aceptado, no el total de la opción, y «lo piensa» con lo que suma", () => {
    const options = [
      { id: "a", position: 1, decision: "elegida" },
      { id: "b", position: 2, decision: "no_elegida" },
    ]
    const items = [
      line("endo", "a", "Endodoncia", 65000, "aceptado"),
      line("corona", "a", "Corona cerámica", 90000, "pospuesto"),
      line("resina", "a", "Resina", 18000, "aceptado"),
      line("limpieza", "a", "Profilaxis", 12000, "aceptado"),
      line("exo", "b", "Exodoncia", 15000, "no_elegida"),
      line("resina", "b", "Resina", 18000, "no_elegida"),
      line("limpieza", "b", "Profilaxis", 12000, "no_elegida"),
    ]
    expect(budgetAnswerLine({ status: "parcial", items, options }, money)).toBe(
      "Eligió la opción A · aceptó S/ 950.00 · lo piensa: Corona cerámica · S/ 900.00",
    )
  })
  it("sin opciones: «Aceptó todo» con su importe; sin respuesta, nada", () => {
    const items = [line("r", "a", "Resina", 18000, "aceptado"), line("c", "a", "Corona", 90000, "aceptado")]
    expect(budgetAnswerLine({ status: "aceptado", items, options: [{ id: "a", decision: "pendiente" }] }, money)).toBe(
      "Aceptó todo · S/ 1080.00",
    )
    expect(budgetAnswerLine({ status: "presentado", items, options: [] }, money)).toBeNull()
  })
})

describe("lo que dice la Historia de un presupuesto", () => {
  const options = [
    { id: "a", decision: "elegida", position: 1 },
    { id: "b", decision: "no_elegida", position: 2 },
  ]
  const items = [
    { decision: "aceptado", optionId: "a", planItemId: "resina" },
    { decision: "rechazado", optionId: "a", planItemId: "profilaxis" },
    { decision: "no_elegida", optionId: "b", planItemId: "corona" },
  ]

  it("con una opción elegida dice cuál, sin importes, aunque haya aceptado una parte", () => {
    expect(budgetChoiceText({ status: "parcial", items, options })).toBe("Eligió la opción A")
    expect(budgetStateText({ status: "parcial", items, options })).toBe("Aceptó 1 de 2")
  })

  it("sin opciones, o reemplazado, dice lo de siempre", () => {
    const single = { status: "parcial", items: items.slice(0, 2), options: [options[0]!] }
    expect(budgetChoiceText(single)).toBe(budgetStateText(single))
    expect(budgetChoiceText({ status: "sustituido", items, options })).toBe("Reemplazado")
  })

  // Revisión de las reglas clínicas del 18 nov: «Eligió» solo cuando ya respondió.
  it("con la opción elegida pero sin responder del todo, o sin aceptar, dice su estado", () => {
    expect(budgetChoiceText({ status: "aceptado", items, options })).toBe("Eligió la opción A")
    expect(budgetChoiceText({ status: "rechazado", items, options })).toBe("No aceptó")
    const asked = [{ decision: "pendiente", optionId: "a", planItemId: "profilaxis" }, ...items.filter((line) => line.planItemId !== "profilaxis")]
    expect(budgetChoiceText({ status: "parcial", items: asked, options })).toBe("Aceptó 1 · 1 por responder")
    expect(budgetChoiceText({ status: "presentado", items, options })).toBe("Entregado · espera respuesta")
  })
})

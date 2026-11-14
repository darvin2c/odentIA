import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { BudgetPresentation } from "../../../lib/budgets"
import { bareProduct, declareProduct } from "../../../product/product-ui"
import { OptionsText, optionHeading, recommendedNotice } from "./budget-review"

declareProduct(bareProduct("dental"))

const option = (
  label: string,
  over: Partial<BudgetPresentation["options"][number]> = {},
): BudgetPresentation["options"][number] => ({
  id: label,
  label,
  name: null,
  pros: null,
  cons: null,
  isRecommended: false,
  ...over,
})

// La demo de Rosa: la propuesta decía «Le recomendamos la corona», pero la marca
// seguía en la resina, la A, que nace recomendada; el paciente la recibía marcada.
const rosa = [
  option("Opción A", { name: "Restaurar con resina", isRecommended: true }),
  option("Opción B", { name: "Proteger con corona" }),
]

describe("el cajón de «Revisar y enviar» dice cuál es la recomendada", () => {
  it("cada opción lleva su marca, como en el Plan", () => {
    expect(optionHeading(rosa[0]!)).toBe("Opción A · recomendada")
    expect(optionHeading(rosa[1]!)).toBe("Opción B")
  })

  it("«Antes de enviar» dice cuál verá marcada el paciente, sin leer la propuesta", () => {
    expect(recommendedNotice(rosa)).toBe(
      "El paciente verá marcada como recomendada la opción A (Restaurar con resina): revisa que coincida con lo que le propones.",
    )
    // El nombre que se está escribiendo, aunque todavía no se haya guardado.
    expect(recommendedNotice(rosa, { "Opción A": "Resina" })).toContain("la opción A (Resina)")
    // Sin nombre, solo la letra.
    expect(recommendedNotice([option("Opción A"), option("Opción B", { isRecommended: true })])).toBe(
      "El paciente verá marcada como recomendada la opción B: revisa que coincida con lo que le propones.",
    )
    // Con una sola opción no hay nada que elegir.
    expect(recommendedNotice([option("Opción A", { isRecommended: true })])).toBeNull()
  })

  it("quien solo lo lee también ve cuál va recomendada", () => {
    const page = renderToStaticMarkup(
      <OptionsText
        options={[
          { ...rosa[0]!, isRecommended: false },
          { ...rosa[1]!, isRecommended: true },
        ]}
        draft
      />,
    )
    expect(page).toContain("Opción B · recomendada · Proteger con corona")
    expect(page).not.toContain("Opción A · recomendada")
  })
})

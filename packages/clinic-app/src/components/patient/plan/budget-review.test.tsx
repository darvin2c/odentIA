import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { BudgetPresentation } from "../../../lib/budgets"
import { bareProduct, declareProduct } from "../../../product/product-ui"
import {
  budgetRecommendedNotice,
  optionHeading,
  recommendedNotice,
  recommendedSavedText,
  withRecommendation,
} from "./budget-recommended"
import { markGuard, OptionsText, RecommendedNote } from "./budget-review"

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
    expect(recommendedNotice(rosa, { names: { "Opción A": "Resina" } })).toContain(
      "la opción A (Resina)",
    )
    // Con una sola opción no hay nada que elegir.
    expect(recommendedNotice([option("Opción A", { isRecommended: true })])).toBeNull()
  })

  it("sin nombre, dice lo que solo lleva esa opción, no lo que va en las dos", () => {
    const lines = [
      { optionId: "Opción A", planItemId: "limpieza", title: "Limpieza" },
      { optionId: "Opción A", planItemId: "resina", title: "Resina pieza 46" },
      { optionId: "Opción B", planItemId: "limpieza", title: "Limpieza" },
      { optionId: "Opción B", planItemId: "corona", title: "Corona cerámica pieza 46" },
    ]
    expect(
      recommendedNotice([option("Opción A"), option("Opción B", { isRecommended: true })], { lines }),
    ).toBe(
      "El paciente verá marcada como recomendada la opción B (Corona cerámica pieza 46): revisa que coincida con lo que le propones.",
    )
  })

  // QA del 14 nov, punto 7: recepción envía, pero no propone.
  it("a quien solo lo envía le dice que avise a quien lo armó", () => {
    expect(recommendedNotice(rosa, { audience: "envia" })).toBe(
      "El paciente verá marcada como recomendada la opción A (Restaurar con resina). Si no es la que le recomendaron, avisa a quien armó el presupuesto.",
    )
  })

  // QA del 14 nov, punto 1: otra pestaña u otra persona marcó la B; la línea decía A.
  it("la marca que vale es la del detalle que se vuelve a leer, no la del cajón al abrirse", () => {
    const fromServer = [
      { id: "Opción A", isRecommended: false },
      { id: "Opción B", isRecommended: true },
    ]
    const shown = withRecommendation(rosa, fromServer)
    expect(shown.map((row) => optionHeading(row))).toEqual(["Opción A", "Opción B · recomendada"])
    expect(recommendedNotice(shown)).toContain("la opción B (Proteger con corona)")
    // Mientras se guarda la que se acaba de pulsar, esa.
    expect(withRecommendation(rosa, fromServer, "Opción A")[0]!.isRecommended).toBe(true)
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

// QA del 14 nov, punto 2: el presupuesto de Rosa ya estaba entregado con la resina.
describe("lo entregado dice cuál ve el paciente y cómo cambiarla", () => {
  const delivered = {
    status: "presentado",
    canChange: true,
    options: rosa.map((row) => ({ ...row, position: 1, decision: "pendiente", lineCount: 1 })),
    items: [],
  } as unknown as Parameters<typeof budgetRecommendedNotice>[0]

  it("en presente y sin pedir que coincida con lo que propone", () => {
    expect(budgetRecommendedNotice(delivered, true)).toBe(
      "El paciente ve marcada como recomendada la opción A (Restaurar con resina).",
    )
  })

  it("con la salida que ya existe, «Crear revisión», solo si se puede hacer", () => {
    const text = budgetRecommendedNotice(delivered, true)!
    const withRevise = renderToStaticMarkup(<RecommendedNote text={text} onRevise={() => {}} />)
    expect(withRevise).toContain("Para cambiar la recomendada, crea una revisión.")
    expect(withRevise).toContain(">Crear revisión</button>")
    const readOnly = renderToStaticMarkup(<RecommendedNote text={text} />)
    expect(readOnly).not.toContain("Crear revisión")
  })
})

describe("marcar la recomendada desde el cajón", () => {
  // QA del 14 nov, punto 5: el doble clic mandaba dos veces la operación.
  it("un segundo clic antes de que termine no la pide otra vez", () => {
    const guard = markGuard()
    expect(guard.start("Opción B")).toBe(true)
    expect(guard.start("Opción B")).toBe(false)
    expect(guard.start("Opción A")).toBe(false)
    guard.end()
    expect(guard.start("Opción A")).toBe(true)
  })

  // Punto 4: la marca se guarda al pulsarla; se dice, no se promete deshacerla.
  it("dice que quedó guardada", () => {
    expect(recommendedSavedText("Opción B")).toBe("Guardado: recomendada la opción B")
  })
})

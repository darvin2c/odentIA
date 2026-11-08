import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { PendingList } from "./resumen-tab"

// QA del 6 nov (M9): «Pendientes» decía «Sin pendientes» mientras todavía cargaba.
describe("Pendientes mientras carga", () => {
  it("no dice que no hay nada antes de saberlo", () => {
    const page = renderToStaticMarkup(<PendingList pending={[]} loading />)
    expect(page).not.toContain("Sin pendientes")
    expect(page).toContain("Consultando pendientes")
  })
  it("con lo que ya llegó, avisa que sigue consultando", () => {
    const page = renderToStaticMarkup(
      <PendingList pending={[{ id: "t", title: "Tarea: llamar", detail: "Vence mañana.", action: null }]} loading />,
    )
    expect(page).toContain("Tarea: llamar")
    expect(page).toContain("Consultando si hay más")
  })
  it("ya sin nada que esperar, dice «Sin pendientes»", () => {
    expect(renderToStaticMarkup(<PendingList pending={[]} />)).toContain("Sin pendientes")
  })
})

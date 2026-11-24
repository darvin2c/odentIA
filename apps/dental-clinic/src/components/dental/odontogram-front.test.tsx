import { FDI_ADULT_ROWS } from "@odentia/dental"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { OdontogramEntry } from "../../lib/dental/odontogram"
import { OdontogramFront } from "./odontogram-front"

// Lienzo del 23 nov 2026: la boca de frente, con su raíz. Cada pieza es un botón con el mismo nombre
// que en el arco, la elegida se marca y lo que tiene la pieza se lee sin depender del dibujo.
describe("la vista de frente del odontograma", () => {
  const post: OdontogramEntry = {
    id: "e1",
    toothNumber: 15,
    condition: "post_and_core",
    status: "recorded",
    details: { quality: "good" },
  }
  const html = renderToStaticMarkup(
    <OdontogramFront
      rows={[FDI_ADULT_ROWS[0]!, FDI_ADULT_ROWS[1]!]}
      entriesOf={(tooth) => (tooth === 15 ? [post] : [])}
      selected={[15]}
      onToggle={() => {}}
    />,
  )

  it("tiene un botón por pieza, con su número de frente y no el del arco", () => {
    expect(html.match(/data-front-tooth="/g)).toHaveLength(32)
    expect(html).not.toContain('data-tooth="')
  })

  it("dice lo que tiene cada pieza y marca la elegida", () => {
    expect(html).toContain('aria-label="Pieza 15: Espigo-muñón')
    expect(html).toMatch(/data-front-tooth="15"[^>]*aria-pressed="true"/)
    expect(html).toContain('aria-label="Pieza 16: sin hallazgos. Seleccionar pieza."')
  })

  it("es una sola parada de Tab: la elegida", () => {
    expect(html.match(/tabindex="0"/g)).toHaveLength(1)
    expect(html).toMatch(/data-front-tooth="15"[^>]*tabindex="0"/)
  })
})

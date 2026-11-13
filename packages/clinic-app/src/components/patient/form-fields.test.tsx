import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { FormFieldDef } from "../../lib/clinical-forms"
import { bareProduct, declareProduct } from "../../product/product-ui"
import { AnswerField } from "./form-fields"

declareProduct(bareProduct("dental"))

const pain: FormFieldDef = { id: "dolor", label: "¿Tienes dolor ahora?", type: "booleano", required: true }
const scale: FormFieldDef = { id: "intensidad", label: "¿Cuánto te duele?", type: "escala", min: 0, max: 10 }

const html = (field: FormFieldDef, value: unknown, disabled = false) =>
  renderToStaticMarkup(<AnswerField field={field} value={value} disabled={disabled} onChange={() => {}} />)

/** Los botones de la respuesta, con lo que dice cada uno de sí mismo. */
function options(markup: string): Array<{ text: string; tabIndex: string | null; pressed: string | null }> {
  return [...markup.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)].map(([, attributes = "", text = ""]) => ({
    text,
    tabIndex: /\btabindex="(-?\d+)"/.exec(attributes)?.[1] ?? null,
    pressed: /\baria-pressed="(true|false)"/.exec(attributes)?.[1] ?? null,
  }))
}

describe("la respuesta de una escala o de un Sí/No", () => {
  // Mesa de formularios del 13 nov (UX-2): cada número era una parada de Tab, 10 para llegar al 8.
  // Como grupo de opciones del sistema, ninguna opción es una parada por su cuenta: el grupo deja
  // una sola al montarse y las demás se alcanzan con las flechas (eso se ve en el navegador).
  it("la escala de 0 a 10 es un solo grupo de opciones, no once paradas de Tab", () => {
    const markup = html(scale, null)
    expect(markup).toContain('data-slot="toggle-group"')
    const found = options(markup)
    expect(found.map((option) => option.text)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"])
    expect(found.filter((option) => option.tabIndex === "0")).toHaveLength(0)
    expect(found.filter((option) => option.tabIndex === "-1")).toHaveLength(11)
  })

  it("lo marcado se dice marcado, también el «No» y el cero", () => {
    expect(options(html(scale, 8)).filter((option) => option.pressed === "true").map((option) => option.text)).toEqual(["8"])
    expect(options(html(scale, 0)).filter((option) => option.pressed === "true").map((option) => option.text)).toEqual(["0"])
    expect(options(html(scale, null)).filter((option) => option.pressed === "true")).toEqual([])
    const yesNo = options(html(pain, false))
    expect(yesNo.map((option) => [option.text, option.pressed, option.tabIndex])).toEqual([
      ["Sí", "false", "-1"],
      ["No", "true", "-1"],
    ])
  })

  it("el grupo lleva el nombre de su pregunta, y dice que es obligatoria sin depender del asterisco", () => {
    const markup = html(pain, null)
    const labelId = /<legend[^>]*\bid="([^"]+)"/.exec(markup)?.[1]
    expect(labelId).toBeTruthy()
    expect(markup).toContain(`aria-labelledby="${labelId}"`)
    expect(markup).toMatch(/<legend[^>]*>.*¿Tienes dolor ahora\?.*\(obligatoria\).*<\/legend>/s)
    expect(html(scale, null)).not.toContain("(obligatoria)")
  })
})

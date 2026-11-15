import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { FormFieldDef } from "../../lib/clinical-forms"
import { bareProduct, declareProduct } from "../../product/product-ui"
import { AnswerField, AnswerInput, answerSpan, isAsideNote, sameWords } from "./form-fields"

declareProduct(bareProduct("dental"))

const pain: FormFieldDef = { id: "dolor", label: "¿Tienes dolor ahora?", type: "booleano", required: true }
const scale: FormFieldDef = { id: "intensidad", label: "¿Cuánto te duele?", type: "escala", min: 0, max: 10 }

const html = (field: FormFieldDef, value: unknown, disabled = false) =>
  renderToStaticMarkup(<AnswerField field={field} value={value} disabled={disabled} onChange={() => {}} />)

/** Las opciones del grupo: su texto (el de su etiqueta) y si se dice marcada. */
function options(markup: string): Array<{ text: string; checked: string | null }> {
  return [...markup.matchAll(/<label\b[^>]*>(.*?)<\/label>/gs)].map(([, inner = ""]) => ({
    text: inner.replace(/<[^>]+>/g, "").trim(),
    checked: /\brole="radio"[^>]*\baria-checked="(true|false)"|\baria-checked="(true|false)"[^>]*\brole="radio"/.exec(inner)?.slice(1).find(Boolean) ?? null,
  }))
}

/**
 * Lo que se ve sin navegador: qué es el control y qué dice de cada respuesta. El teclado (una
 * parada de Tab en la opción elegida, flechas, Enter que no marca) se prueba con el componente de
 * verdad en `ui-patterns` (`radio-chips.test.tsx`, `enter-advances.test.tsx`).
 */
describe("la respuesta de una escala o de un Sí/No", () => {
  it("es un grupo de radios con el nombre de su pregunta, no botones sueltos", () => {
    const markup = html(scale, null)
    const labelId = /<legend[^>]*\bid="([^"]+)"/.exec(markup)?.[1]
    expect(labelId).toBeTruthy()
    expect(markup).toMatch(new RegExp(`role="radiogroup"[^>]*aria-labelledby="${labelId}"|aria-labelledby="${labelId}"[^>]*role="radiogroup"`))
    expect(options(markup).map((option) => option.text)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"])
    expect(markup).not.toContain("aria-pressed")
  })

  it("lo guardado se dice marcado, también el «No» y el cero, y sin respuesta no hay nada marcado", () => {
    const marked = (markup: string) => options(markup).filter((option) => option.checked === "true").map((option) => option.text)
    expect(marked(html(scale, 8))).toEqual(["8"])
    expect(marked(html(scale, 0))).toEqual(["0"])
    expect(marked(html(scale, null))).toEqual([])
    expect(marked(html(pain, false))).toEqual(["No"])
    expect(marked(html(pain, true))).toEqual(["Sí"])
  })

  it("«Quitar respuesta» solo en la que no es obligatoria, con algo respondido y si se puede editar", () => {
    expect(html(scale, 8)).toContain("Quitar respuesta")
    expect(html(scale, null)).not.toContain("Quitar respuesta")
    expect(html(scale, 8, true)).not.toContain("Quitar respuesta")
    expect(html(pain, true)).not.toContain("Quitar respuesta")
  })

  it("la pregunta obligatoria lo dice con palabras, sin depender del asterisco", () => {
    expect(html(pain, null)).toMatch(/<legend[^>]*>.*¿Tienes dolor ahora\?.*\(obligatoria\).*<\/legend>/s)
    expect(html(scale, null)).not.toContain("(obligatoria)")
  })
})

describe("la tecla Enter del teléfono en una respuesta de una línea", () => {
  const input = (field: FormFieldDef, hint?: "next") =>
    renderToStaticMarkup(<AnswerInput field={field} value={null} onChange={() => {}} enterKeyHint={hint} />)

  it("donde Enter pasa de pregunta dice «Siguiente»; nunca «Enviar», y fuera de ahí no promete nada", () => {
    for (const field of [
      { id: "motivo", label: "¿Por qué vienes?", type: "texto" },
      { id: "peso", label: "Tu peso", type: "numero" },
    ] satisfies FormFieldDef[]) {
      expect(input(field, "next")).toContain('enterKeyHint="next"')
      expect(input(field)).not.toContain("enterKeyHint")
    }
    // En un texto largo Enter es un salto de línea.
    expect(input({ id: "algo", label: "¿Algo más?", type: "texto_largo" }, "next")).not.toContain("enterKeyHint")
  })
})

// Pedido del 15 nov: la ficha no seguía el sistema de diseño (casillas sueltas, «Hábitos» › «Hábitos»,
// todo a lo ancho en un panel angosto).
describe("la ficha ordenada como los demás formularios", () => {
  it("cada casilla es un `Field` horizontal con su etiqueta, no una etiqueta suelta", () => {
    const markup = renderToStaticMarkup(
      <AnswerInput
        field={{ id: "mordida", label: "Mordida cruzada", type: "opcion_multiple", options: ["No tiene", "Anterior"] }}
        value={["Anterior"]}
        onChange={() => {}}
      />,
    )
    expect(markup.match(/data-slot="field"[^>]*data-orientation="horizontal"/g)).toHaveLength(2)
    expect(markup).toMatch(/<label[^>]*for="[^"]+-1"[^>]*>Anterior<\/label>/)
  })
  it("lo corto va de a pares (también los números) y lo largo a todo el ancho", () => {
    expect(answerSpan({ id: "a", label: "Clase molar derecha (Angle)", type: "opcion_unica" })).toBe("")
    expect(answerSpan({ id: "b", label: "Overjet", type: "numero", unit: "mm" })).toBe("")
    expect(answerSpan({ id: "c", label: "Desviación de la línea media superior", type: "numero", unit: "mm" })).toBe("")
    expect(answerSpan({ id: "d", label: "Hábitos", type: "opcion_multiple" })).toBe("@md:col-span-2")
    expect(answerSpan({ id: "e", label: "Observaciones", type: "texto_largo" })).toBe("@md:col-span-2")
  })
  it("el título de la sección y la pregunta se reconocen iguales sin contar mayúsculas ni tildes", () => {
    expect(sameWords("Hábitos", "habitos ")).toBe(true)
    expect(sameWords("Higiene oral", "Índice de higiene oral")).toBe(false)
  })
  it("se pliega «Observaciones» opcional; «Hallazgos» u «Observaciones» obligatoria, no", () => {
    expect(isAsideNote({ id: "o", label: "Observaciones", type: "texto_largo" })).toBe(true)
    expect(isAsideNote({ id: "n", label: "Notas", type: "texto_largo" })).toBe(true)
    expect(isAsideNote({ id: "h", label: "Hallazgos", type: "texto_largo" })).toBe(false)
    expect(isAsideNote({ id: "r", label: "Observaciones", type: "texto_largo", required: true })).toBe(false)
    expect(isAsideNote({ id: "t", label: "Observaciones", type: "texto" })).toBe(false)
  })
})

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { guideToSave, offersSuggestion, ServiceGuideSection } from "./service-guide"

const suggestion = { how: "Se retira el nervio dañado.", visits: "1 a 2" }

describe("Lo que se le explica al paciente", () => {
  it("el texto sugerido no se guarda solo: sin tocar, no hay nada que enviar", () => {
    expect(guideToSave(undefined)).toBeNull()
    // Usarlo solo llena el borrador: lo vuelve real el «Guardar» del formulario.
    expect(guideToSave(suggestion)).toEqual({ patientGuide: suggestion })
    // Vaciarlo y guardar quita la explicación.
    expect(guideToSave({ how: "   ", schedule: [{ when: "", what: "" }] })).toEqual({ patientGuide: null })
  })

  it("solo se ofrece si el servicio está vacío y nada se ha escrito", () => {
    expect(offersSuggestion(null, suggestion, undefined)).toBe(true)
    expect(offersSuggestion({ how: "Lo nuestro" }, suggestion, undefined)).toBe(false)
    expect(offersSuggestion(null, suggestion, { how: "Escrito" })).toBe(false)
    expect(offersSuggestion(null, null, undefined)).toBe(false)
  })

  it("el aviso no pone el texto en los campos hasta que se pide", () => {
    const page = renderToStaticMarkup(
      <ServiceGuideSection
        idPrefix="s"
        saved={null}
        suggestion={suggestion}
        draft={undefined}
        reviewedWords={null}
        consents={null}
        onChange={() => {}}
      />,
    )
    expect(page).toContain("Hay un texto sugerido")
    expect(page).toContain("Usar el texto sugerido")
    expect(page).not.toContain("Se retira el nervio dañado.")
  })

  it("calendario y señales de alarma quedan detrás de su botón, salvo que ya traigan dato", () => {
    const render = (saved: Parameters<typeof ServiceGuideSection>[0]["saved"]) =>
      renderToStaticMarkup(
        <ServiceGuideSection
          idPrefix="s"
          saved={saved}
          suggestion={null}
          draft={undefined}
          reviewedWords={null}
          consents={null}
          onChange={() => {}}
        />,
      )
    expect(render(null)).toContain("Agregar calendario")
    expect(render(null)).toContain("Agregar señales de alarma")
    const full = render({ warnings: "Fiebre", schedule: [{ when: "Semana 8", what: "Eco" }] })
    expect(full).not.toContain("Agregar calendario")
    expect(full).not.toContain("Agregar señales de alarma")
    expect(full).toContain("Fiebre")
  })
})

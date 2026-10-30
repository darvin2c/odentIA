import type { PatientGuide } from "@odentia/clinical"
import { useAppForm } from "@odentia/ui-patterns"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import {
  EMPTY_GUIDE,
  guideDraftOf,
  guideSchema,
  guideToSave,
  offersSuggestion,
  ServiceGuideSection,
} from "./service-guide"

const suggestion = { how: "Se retira el nervio dañado.", visits: "1 a 2" }

function Harness({
  saved,
  suggested,
}: {
  saved: PatientGuide | null
  suggested: PatientGuide | null
}) {
  const form = useAppForm({ defaultValues: { patientGuide: guideDraftOf(saved) } })
  return (
    <ServiceGuideSection
      form={form}
      fields="patientGuide"
      idPrefix="s"
      saved={saved}
      suggestion={suggested}
      reviewedWords={null}
      consents={null}
    />
  )
}

describe("Lo que se le explica al paciente", () => {
  it("el texto sugerido no se guarda solo: sin escribir nada, no hay nada que enviar", () => {
    expect(guideToSave(null, EMPTY_GUIDE)).toBeNull()
    expect(guideToSave(suggestion, guideDraftOf(suggestion))).toBeNull()
    // Usarlo solo llena los campos: lo vuelve real el «Guardar» del formulario.
    expect(guideToSave(null, guideDraftOf(suggestion))?.patientGuide).toEqual({
      visits: "1 a 2",
      how: "Se retira el nervio dañado.",
    })
    // Vaciarlo y guardar quita la explicación.
    expect(guideToSave(suggestion, { ...EMPTY_GUIDE, how: "   " })).toEqual({ patientGuide: null })
  })

  it("solo se ofrece si el servicio está vacío y nada se ha escrito", () => {
    expect(offersSuggestion(null, suggestion, EMPTY_GUIDE)).toBe(true)
    expect(offersSuggestion({ how: "Lo nuestro" }, suggestion, EMPTY_GUIDE)).toBe(false)
    expect(offersSuggestion(null, suggestion, { ...EMPTY_GUIDE, how: "Escrito" })).toBe(false)
    expect(offersSuggestion(null, null, EMPTY_GUIDE)).toBe(false)
  })

  it("el aviso no pone el texto en los campos hasta que se pide", () => {
    const page = renderToStaticMarkup(<Harness saved={null} suggested={suggestion} />)
    expect(page).toContain("Hay un texto sugerido")
    expect(page).toContain("Usar el texto sugerido")
    expect(page).not.toContain("Se retira el nervio dañado.")
  })

  it("calendario y señales de alarma quedan detrás de su botón, salvo que ya traigan dato", () => {
    const empty = renderToStaticMarkup(<Harness saved={null} suggested={null} />)
    expect(empty).toContain("Agregar calendario")
    expect(empty).toContain("Agregar señales de alarma")
    const full = renderToStaticMarkup(
      <Harness
        saved={{ warnings: "Fiebre", schedule: [{ when: "Semana 8", what: "Eco" }] }}
        suggested={null}
      />,
    )
    expect(full).not.toContain("Agregar calendario")
    expect(full).not.toContain("Agregar señales de alarma")
    expect(full).toContain("Fiebre")
  })

  it("una fila del calendario a medias se dice en su campo, no se pierde al guardar", () => {
    const result = guideSchema.safeParse({
      ...EMPTY_GUIDE,
      schedule: [{ when: "Semana 1", what: "" }],
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(["schedule", 0, "what"])
  })
})

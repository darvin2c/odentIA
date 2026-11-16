// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type ClioFormProposals, ClioFormProposalsContext, proposesValue, reread } from "./clio-form-proposals"
import { UnusedNotice } from "./dictation-panel"
import { type DictationSuggestion, markedByDefault, type UnusedDictation, withoutAnsweredUnused } from "./dictation-session"

afterEach(cleanup)

const clioWith = (openAt: ClioFormProposals["openAt"]): ClioFormProposals => ({
  items: [],
  accept: async () => {},
  discard: () => {},
  restore: () => {},
  busy: false,
  setFormOpen: () => {},
  hint: null,
  openAt,
  clearHint: () => {},
})

const unused = (over: Partial<UnusedDictation>): UnusedDictation => ({ phrases: [], unnamed: false, why: {}, targets: {}, ...over })

// Prueba con voz del 15 nov: lo que la red avisa («Parece de «Percusión»») se lleva a su pregunta en un toque.
describe("«No pude usar esto» con un toque", () => {
  const percussion = { responseId: "endo", fieldId: "percusion", label: "Percusión" }
  it("la frase de una pregunta lleva «Usar en…», que abre esa pregunta con la frase; no llena nada", () => {
    const openAt = vi.fn()
    render(
      <ClioFormProposalsContext.Provider value={clioWith(openAt)}>
        <UnusedNotice
          session={{
            unused: unused({
              phrases: ["dolor a la percusión", "pásame el espejo"],
              why: { "dolor a la percusión": "Parece de «Percusión»: revísala en la ficha." },
              targets: { "dolor a la percusión": [percussion] },
            }),
            dismissUnused: () => {},
          }}
        />
      </ClioFormProposalsContext.Provider>,
    )
    const use = screen.getByRole("button", { name: "Usar «dolor a la percusión» en «Percusión»" })
    expect(use.textContent).toBe("Usar en Percusión")
    // Solo la que nombra una pregunta lleva el botón.
    expect(screen.getAllByRole("button", { name: /^Usar/ })).toHaveLength(1)
    fireEvent.click(use)
    expect(openAt).toHaveBeenCalledWith({ ...percussion, said: "dolor a la percusión" })
  })

  it("entre dos hermanas, un botón por cada una, con el rótulo corto", () => {
    const openAt = vi.fn()
    const twins = [
      { responseId: "norma", fieldId: "cpod_c", label: "CPOD · C, cariados" },
      { responseId: "norma", fieldId: "ceod_c", label: "ceod · c, cariados" },
    ]
    render(
      <ClioFormProposalsContext.Provider value={clioWith(openAt)}>
        <UnusedNotice session={{ unused: unused({ phrases: ["cariados 3"], targets: { "cariados 3": twins } }), dismissUnused: () => {} }} />
      </ClioFormProposalsContext.Provider>,
    )
    expect(screen.getAllByRole("button", { name: /^Usar «cariados 3» en/ }).map((button) => button.textContent)).toEqual([
      "Usar en CPOD · C, cariados",
      "Usar en ceod · c, cariados",
    ])
    const molar = [{ responseId: "orto", fieldId: "clase_molar_derecha", label: "Clase molar derecha (Angle)" }]
    cleanup()
    render(
      <ClioFormProposalsContext.Provider value={clioWith(openAt)}>
        <UnusedNotice session={{ unused: unused({ phrases: ["volar derecha clase dos"], targets: { "volar derecha clase dos": molar } }), dismissUnused: () => {} }} />
      </ClioFormProposalsContext.Provider>,
    )
    expect(screen.getByRole("button", { name: /^Usar/ }).textContent).toBe("Usar en Clase molar derecha")
  })

  it("fuera de una atención con fichas no hay botón", () => {
    render(<UnusedNotice session={{ unused: unused({ phrases: ["dolor a la percusión"], targets: { "dolor a la percusión": [percussion] } }), dismissUnused: () => {} }} />)
    expect(screen.queryByRole("button", { name: /^Usar/ })).toBeNull()
    expect(screen.getByRole("button", { name: "Entendido" })).toBeTruthy()
  })
})

describe("lo de la segunda lectura", () => {
  const item = (status: DictationSuggestion["status"], payload: Record<string, unknown>): DictationSuggestion => ({
    id: "s1",
    kind: "ficha",
    payload,
    sourceText: "dolor a la percusión",
    status,
    note: null,
    summary: "",
    voice: null,
    removal: null,
  })
  it("propone su valor por revisar y al firmar viene desmarcada; sin valor es solo un aviso", () => {
    const read = item("por_revisar", { value: "Positiva", reread: true })
    expect(reread(read)).toBe(true)
    expect(proposesValue(read)).toBe(true)
    expect(markedByDefault(read)).toBe(false)
    expect(proposesValue(item("por_revisar", { value: null }))).toBe(false)
    expect(markedByDefault(item("lista", { value: "Positiva" }))).toBe(true)
  })
})

// Prueba con voz del 16 nov (c6, v07): la pausa cortó «…frío sin respuesta calor» y avisó «calor»;
// la siguiente propuso «calor sin respuesta». El aviso de antes ya no tiene que decir nada.
describe("lo que una pausa siguiente respondió deja de avisarse", () => {
  const calor = { responseId: "endo", fieldId: "calor", label: "Prueba de calor" }
  const before = unused({
    phrases: ["calor", "sondaje no lo pude medir bien"],
    why: { calor: "No alcanzó para responder «Prueba de calor»: dilo con el valor o escríbelo en la ficha." },
    targets: { calor: [calor], "sondaje no lo pude medir bien": [{ responseId: "endo", fieldId: "sondaje", label: "Sondaje" }] },
  })
  const proposal = (over: Partial<DictationSuggestion>): DictationSuggestion => ({
    id: "s2",
    kind: "ficha",
    payload: { responseId: "endo", fieldId: "calor", value: "Sin respuesta" },
    sourceText: "calor sin respuesta",
    status: "lista",
    note: null,
    summary: "",
    voice: null,
    removal: null,
    ...over,
  })

  it("la frase que contiene la propuesta de su pregunta sale del aviso; lo demás queda", () => {
    const after = withoutAnsweredUnused(before, [proposal({})])
    expect(after.phrases).toEqual(["sondaje no lo pude medir bien"])
    expect(after.why).toEqual({})
    expect(Object.keys(after.targets)).toEqual(["sondaje no lo pude medir bien"])
  })

  it("con otras palabras, en otra pregunta o descartada, el aviso queda", () => {
    expect(withoutAnsweredUnused(before, [proposal({ sourceText: "prueba térmica negativa" })])).toBe(before)
    expect(withoutAnsweredUnused(before, [proposal({ payload: { responseId: "endo", fieldId: "frio", value: "Sin respuesta" } })])).toBe(before)
    expect(withoutAnsweredUnused(before, [proposal({ status: "descartada" })])).toBe(before)
    expect(withoutAnsweredUnused(before, [])).toBe(before)
  })
})

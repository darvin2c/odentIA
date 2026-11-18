// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import * as React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { RadioChips } from "../radio-chips.js"
import { advanceOnEnter } from "./enter-advances.js"

afterEach(cleanup)

const YES_NO = [
  { value: "si", label: "Sí" },
  { value: "no", label: "No" },
]

/** Un cuestionario de una sola página, como el que responde el paciente en su teléfono, con el grupo de opciones de verdad. */
function Questionnaire({ onSubmit, guarded = true }: { onSubmit: () => void; guarded?: boolean }) {
  const [pain, setPain] = React.useState<string | null>(null)
  return (
    <form
      onKeyDown={guarded ? advanceOnEnter : undefined}
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <label>
        ¿Por qué vienes?
        <input />
      </label>
      <p id="pain">¿Tienes dolor?</p>
      <RadioChips aria-labelledby="pain" value={pain} options={YES_NO} onChange={setPain} />
      <output data-testid="pain">{pain ?? "sin responder"}</output>
      <div hidden>
        <label>
          Pregunta de otro paso
          <input />
        </label>
      </div>
      <label>
        ¿Qué te ayudaría a estar más tranquila?
        <input />
      </label>
      <label>
        ¿Algo que quieras que sepamos?
        <textarea />
      </label>
      <label>
        País
        <input role="combobox" aria-expanded="false" aria-controls="paises" />
      </label>
      <label>
        Tu peso
        <input type="number" />
      </label>
      <button type="submit">Enviar respuestas</button>
    </form>
  )
}

describe("advanceOnEnter", () => {
  // Mesa de formularios del 13 nov (UX-3): un Enter en una respuesta corta enviaba el cuestionario
  // entero, con las preguntas siguientes vacías y sin poder corregir.
  it("sin él, Enter en una respuesta corta envía el formulario: eso es lo que evita", async () => {
    const onSubmit = vi.fn()
    render(<Questionnaire onSubmit={onSubmit} guarded={false} />)
    await userEvent.type(screen.getByLabelText("¿Por qué vienes?"), "Dolor de muela{Enter}")
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it("Enter en una respuesta corta pasa a la pregunta siguiente y no envía ni responde", async () => {
    const onSubmit = vi.fn()
    render(<Questionnaire onSubmit={onSubmit} />)
    await userEvent.type(screen.getByLabelText("¿Por qué vienes?"), "Dolor de muela{Enter}")
    expect(onSubmit).not.toHaveBeenCalled()
    // La siguiente parada es el grupo de opciones (su primera opción, sin nada elegido), no lo oculto.
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Sí" }))
    // Otro Enter ahí no la marca: sigue a la pregunta que viene.
    await userEvent.keyboard("{Enter}")
    expect(screen.getByTestId("pain").textContent).toBe("sin responder")
    expect(document.activeElement).toBe(screen.getByLabelText("¿Qué te ayudaría a estar más tranquila?"))
    await userEvent.keyboard("Música{Enter}")
    expect(document.activeElement).toBe(screen.getByLabelText("¿Algo que quieras que sepamos?"))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("en la última respuesta lleva al botón, y solo el botón envía", async () => {
    const onSubmit = vi.fn()
    render(<Questionnaire onSubmit={onSubmit} />)
    await userEvent.type(screen.getByLabelText("Tu peso"), "70{Enter}")
    expect(onSubmit).not.toHaveBeenCalled()
    const send = screen.getByRole("button", { name: "Enviar respuestas" })
    expect(document.activeElement).toBe(send)
    await userEvent.keyboard("{Enter}")
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it("en un texto largo Enter sigue siendo un salto de línea", async () => {
    const onSubmit = vi.fn()
    render(<Questionnaire onSubmit={onSubmit} />)
    const long = screen.getByLabelText("¿Algo que quieras que sepamos?") as HTMLTextAreaElement
    await userEvent.type(long, "Uno{Enter}dos")
    expect(long.value).toBe("Uno\ndos")
    expect(document.activeElement).toBe(long)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("en un buscador Enter elige de su lista: ni envía ni se va a otra pregunta", async () => {
    const onSubmit = vi.fn()
    render(<Questionnaire onSubmit={onSubmit} />)
    const country = screen.getByLabelText("País")
    await userEvent.type(country, "Per{Enter}")
    expect(onSubmit).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(country)
  })

  // El teclado del teléfono, mientras compone una palabra: ese Enter la confirma. No envía (el
  // navegador enviaría el formulario si no se cancela) y el foco se queda donde está.
  it("mientras el teclado compone una palabra, Enter tampoco envía y no cambia de pregunta", () => {
    render(<Questionnaire onSubmit={() => {}} />)
    const reason = screen.getByLabelText("¿Por qué vienes?")
    reason.focus()
    const allowed = fireEvent.keyDown(reason, { key: "Enter", isComposing: true })
    expect(allowed).toBe(false)
    expect(document.activeElement).toBe(reason)
    // Sin composición, el mismo Enter tampoco deja pasar el envío.
    expect(fireEvent.keyDown(reason, { key: "Enter" })).toBe(false)
  })
})

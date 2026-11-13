// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { advanceOnEnter } from "./enter-advances.js"

afterEach(cleanup)

/** Un cuestionario de una sola página, como el que responde el paciente en su teléfono. */
function Questionnaire({ onSubmit, guarded = true }: { onSubmit: () => void; guarded?: boolean }) {
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
      {/* Un grupo de opciones: una sola parada, la opción activa. */}
      <fieldset aria-label="¿Tienes dolor?">
        <button type="button" tabIndex={0}>
          Sí
        </button>
        <button type="button" tabIndex={-1}>
          No
        </button>
      </fieldset>
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

  it("Enter en una respuesta corta pasa a la pregunta siguiente y no envía", async () => {
    const onSubmit = vi.fn()
    render(<Questionnaire onSubmit={onSubmit} />)
    await userEvent.type(screen.getByLabelText("¿Por qué vienes?"), "Dolor de muela{Enter}")
    expect(onSubmit).not.toHaveBeenCalled()
    // La siguiente parada: la opción activa del grupo, no cada opción ni lo que está oculto.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Sí" }))
    await userEvent.type(screen.getByLabelText("¿Qué te ayudaría a estar más tranquila?"), "Música{Enter}")
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

  it("en un texto largo Enter sigue siendo un salto de línea, y en una opción la marca", async () => {
    const onSubmit = vi.fn()
    render(<Questionnaire onSubmit={onSubmit} />)
    const long = screen.getByLabelText("¿Algo que quieras que sepamos?") as HTMLTextAreaElement
    await userEvent.type(long, "Uno{Enter}dos")
    expect(long.value).toBe("Uno\ndos")
    expect(document.activeElement).toBe(long)
    const yes = screen.getByRole("button", { name: "Sí" })
    const clicked = vi.fn()
    yes.addEventListener("click", clicked)
    yes.focus()
    await userEvent.keyboard("{Enter}")
    expect(clicked).toHaveBeenCalledTimes(1)
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
})

// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import * as React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { advanceOnEnter } from "./form/enter-advances.js"
import { RadioChips } from "./radio-chips.js"

afterEach(cleanup)

const YES_NO = [
  { value: "si", label: "Sí" },
  { value: "no", label: "No" },
]
const SCALE = Array.from({ length: 11 }, (_, n) => ({ value: String(n), label: String(n) }))

/** El cuestionario del paciente con sus controles de verdad: texto, Sí/No obligatorio, escala opcional, texto y «Enviar». */
function Questionnaire({ onSubmit, pain = null, level = null }: { onSubmit: () => void; pain?: string | null; level?: string | null }) {
  const [answers, setAnswers] = React.useState({ pain, level })
  return (
    <form
      onKeyDown={advanceOnEnter}
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <label>
        ¿Por qué vienes?
        <input />
      </label>
      <p id="pain">¿Tienes dolor ahora?</p>
      <RadioChips aria-labelledby="pain" value={answers.pain} options={YES_NO} onChange={(next) => setAnswers((now) => ({ ...now, pain: next }))} />
      <p id="level">¿Cuánto te duele?</p>
      <RadioChips
        aria-labelledby="level"
        value={answers.level}
        options={SCALE}
        onChange={(next) => setAnswers((now) => ({ ...now, level: next }))}
        onClear={() => setAnswers((now) => ({ ...now, level: null }))}
      />
      <label>
        ¿Algo más?
        <input />
      </label>
      <button type="submit">Enviar respuestas</button>
      <output data-testid="answers">{JSON.stringify(answers)}</output>
    </form>
  )
}

const answers = () => JSON.parse(screen.getByTestId("answers").textContent ?? "{}") as { pain: string | null; level: string | null }
const group = (name: string) => screen.getByRole("radiogroup", { name })
const option = (name: string, label: string) => within(group(name)).getByRole("radio", { name: label })

describe("RadioChips", () => {
  it("es un grupo de radios con el nombre de su pregunta: cada opción dice su lugar y se elige una sola", () => {
    render(<Questionnaire onSubmit={() => {}} level="8" />)
    expect(within(group("¿Cuánto te duele?")).getAllByRole("radio")).toHaveLength(11)
    expect(option("¿Cuánto te duele?", "8").getAttribute("aria-checked")).toBe("true")
    expect(within(group("¿Cuánto te duele?")).getAllByRole("radio", { checked: true })).toHaveLength(1)
  })

  // Revisión de la entrega 3: la parada quedaba en la primera opción y un Espacio cambiaba 8 por 0.
  it("Tab entra en la opción elegida, o en la primera si no hay ninguna, y es una sola parada", async () => {
    render(<Questionnaire onSubmit={() => {}} level="8" />)
    screen.getByLabelText("¿Por qué vienes?").focus()
    await userEvent.tab()
    expect(document.activeElement).toBe(option("¿Tienes dolor ahora?", "Sí"))
    await userEvent.tab()
    expect(document.activeElement).toBe(option("¿Cuánto te duele?", "8"))
    // Con una respuesta, la parada siguiente es «Quitar respuesta»; después, la pregunta siguiente.
    await userEvent.tab()
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Quitar respuesta" }))
    await userEvent.tab()
    expect(document.activeElement).toBe(screen.getByLabelText("¿Algo más?"))
    expect(answers()).toEqual({ pain: null, level: "8" })
  })

  it("las flechas mueven y eligen, y Espacio elige", async () => {
    render(<Questionnaire onSubmit={() => {}} level="8" />)
    option("¿Cuánto te duele?", "8").focus()
    await userEvent.keyboard("{ArrowRight}")
    expect(document.activeElement).toBe(option("¿Cuánto te duele?", "9"))
    expect(answers().level).toBe("9")
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}")
    expect(answers().level).toBe("7")
    option("¿Tienes dolor ahora?", "Sí").focus()
    await userEvent.keyboard(" ")
    expect(answers().pain).toBe("si")
  })

  // Revisión de la entrega 3: Enter llevaba el foco a «Sí» y el Enter siguiente lo marcaba.
  it("Enter repetido recorre las preguntas sin responder ni cambiar ninguna, y no envía", async () => {
    const onSubmit = vi.fn()
    render(<Questionnaire onSubmit={onSubmit} level="8" />)
    await userEvent.type(screen.getByLabelText("¿Por qué vienes?"), "Dolor{Enter}")
    expect(document.activeElement).toBe(option("¿Tienes dolor ahora?", "Sí"))
    await userEvent.keyboard("{Enter}")
    expect(answers()).toEqual({ pain: null, level: "8" })
    // De la escala salta a la pregunta siguiente: «Quitar respuesta» no es una parada de Enter.
    expect(document.activeElement).toBe(option("¿Cuánto te duele?", "8"))
    await userEvent.keyboard("{Enter}")
    expect(document.activeElement).toBe(screen.getByLabelText("¿Algo más?"))
    await userEvent.keyboard("{Enter}")
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Enviar respuestas" }))
    expect(answers()).toEqual({ pain: null, level: "8" })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("«Quitar respuesta» solo donde se puede dejar sin responder y hay algo que quitar; al quitar, el foco vuelve al grupo", async () => {
    render(<Questionnaire onSubmit={() => {}} pain="si" level="8" />)
    // La obligatoria no se desmarca; la opcional sí.
    const clear = screen.getAllByRole("button", { name: "Quitar respuesta" })
    expect(clear).toHaveLength(1)
    expect(clear[0]?.getAttribute("aria-describedby")).toBe("level")
    await userEvent.click(clear[0] as HTMLElement)
    expect(answers()).toEqual({ pain: "si", level: null })
    expect(screen.queryByRole("button", { name: "Quitar respuesta" })).toBeNull()
    expect(document.activeElement).toBe(option("¿Cuánto te duele?", "0"))
  })

  it("apagado se lee y no se cambia", async () => {
    const onChange = vi.fn()
    render(
      <>
        <p id="q">¿Tienes dolor ahora?</p>
        <RadioChips aria-labelledby="q" value="si" options={YES_NO} onChange={onChange} onClear={() => {}} disabled />
      </>,
    )
    await userEvent.click(screen.getByRole("radio", { name: "No" }))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: "Quitar respuesta" })).toBeNull()
  })

  // QA de la entrega 3 (14 nov): el foco del teclado casi no se veía (el borde de un círculo de 16 px)
  // y la opción elegida se veía igual con foco que sin él.
  it("el foco del teclado se marca en toda la pastilla, con el anillo de los botones, no en el círculo", () => {
    render(<Questionnaire onSubmit={() => {}} level="8" />)
    const chosen = option("¿Cuánto te duele?", "8")
    const chip = chosen.closest("label") as HTMLElement
    expect(chip.className).toContain("has-[[role=radio]:focus-visible]:ring-3")
    expect(chosen.className).toContain("focus-visible:ring-0")
  })
})

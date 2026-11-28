// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  AiQuestion,
  AiSuggestion,
  AiSuggestionBar,
  AiSuggestionChips,
  AiSuggestionMark,
} from "./ai-suggestion.js"

afterEach(cleanup)

describe("propuesta de la IA", () => {
  it("un texto propuesto se cambia aquí mismo y «Usar» devuelve el texto final", async () => {
    const accept = vi.fn()
    render(<AiSuggestion text="Zapatilla de lona." onAccept={accept} onDiscard={vi.fn()} />)
    expect(screen.getByRole("group", { name: /Propuesta de la IA/ })).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "Cambiar" }))
    const box = screen.getByRole("textbox", { name: "Cambiar la propuesta" })
    expect(document.activeElement).toBe(box)
    await userEvent.type(box, " Calza normal.")
    await userEvent.click(screen.getByRole("button", { name: "Usar" }))
    expect(accept).toHaveBeenCalledWith("Zapatilla de lona. Calza normal.")
  })

  it("una propuesta nueva reemplaza lo que se estaba cambiando de la anterior", async () => {
    const accept = vi.fn()
    const { rerender } = render(
      <AiSuggestion text="Primera." onAccept={accept} onDiscard={vi.fn()} />,
    )
    await userEvent.click(screen.getByRole("button", { name: "Cambiar" }))
    await userEvent.type(screen.getByRole("textbox"), " editada")
    rerender(<AiSuggestion text="Segunda." onAccept={accept} onDiscard={vi.fn()} />)
    expect(screen.queryByRole("textbox")).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "Usar" }))
    expect(accept).toHaveBeenCalledWith("Segunda.")
  })

  it("lo que no es texto ofrece «Cambiar» solo si la pantalla sabe editarlo", () => {
    const change = vi.fn()
    const discard = vi.fn()
    const { rerender } = render(
      <AiSuggestion layout="row" onAccept={vi.fn()} onDiscard={discard}>
        Desde 3 a S/ 109
      </AiSuggestion>,
    )
    expect(screen.queryByRole("button", { name: "Cambiar" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Descartar" }))
    expect(discard).toHaveBeenCalledOnce()
    rerender(
      <AiSuggestion layout="row" onAccept={vi.fn()} onDiscard={discard} onChange={change}>
        Desde 3 a S/ 109
      </AiSuggestion>,
    )
    fireEvent.click(screen.getByRole("button", { name: "Cambiar" }))
    expect(change).toHaveBeenCalledOnce()
  })

  it("mientras la IA trabaja no hay nada que usar", () => {
    render(
      <AiSuggestion pending="Completando con las fotos…" onAccept={vi.fn()} onDiscard={vi.fn()} />,
    )
    const group = screen.getByRole("group", { name: "Completando con las fotos…" })
    expect(group.getAttribute("aria-busy")).toBe("true")
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("la marca dice de dónde salió sin abrirla y, abierta, deja usar o descartar", async () => {
    const accept = vi.fn()
    render(
      <AiSuggestionMark
        reason="Visto en las fotos: «Lona»."
        onAccept={accept}
        onDiscard={vi.fn()}
      />,
    )
    const mark = screen.getByRole("button", {
      name: "Propuesta de la IA: Visto en las fotos: «Lona».",
    })
    await userEvent.click(mark)
    await userEvent.click(await screen.findByRole("button", { name: "Usar" }))
    expect(accept).toHaveBeenCalledOnce()
    expect(screen.queryByRole("button", { name: "Usar" })).toBeNull()
  })

  it("al usar desde la marca, el foco va al campo propuesto y no se pierde", async () => {
    function Campo() {
      const [proposed, setProposed] = useState(true)
      return (
        <>
          {proposed ? (
            <AiSuggestionMark
              reason="Visto en las fotos."
              fieldId="nombre"
              onAccept={() => setProposed(false)}
              onDiscard={() => setProposed(false)}
            />
          ) : null}
          <input id="nombre" aria-label="Nombre" defaultValue="Zapatilla de lona" />
        </>
      )
    }
    render(<Campo />)
    await userEvent.click(screen.getByRole("button", { name: /Propuesta de la IA/ }))
    expect(await screen.findByRole("button", { name: "Cambiar" })).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "Usar" }))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Nombre" })))
  })

  it("cada pastilla se usa o se descarta por su nombre", () => {
    const accept = vi.fn()
    const discard = vi.fn()
    render(
      <AiSuggestionChips
        items={[
          { id: "u", label: "zapatilla urbana" },
          { id: "b", label: "zapatilla blanca" },
        ]}
        onAccept={accept}
        onDiscard={discard}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Usar «zapatilla urbana»" }))
    fireEvent.click(screen.getByRole("button", { name: "Descartar «zapatilla blanca»" }))
    expect(accept).toHaveBeenCalledWith("u")
    expect(discard).toHaveBeenCalledWith("b")
  })

  it("«Aplicar todos» solo aparece con algo pendiente", () => {
    const all = vi.fn()
    const { rerender } = render(<AiSuggestionBar count={2} onAcceptAll={all} />)
    expect(screen.getByText("La IA propone 2 cambios.")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Aplicar todos" }))
    expect(all).toHaveBeenCalledOnce()
    rerender(<AiSuggestionBar count={0} onAcceptAll={all} />)
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("después de «Aplicar todos» el foco queda en la línea que dice lo que pasó", async () => {
    function Barra() {
      const [count, setCount] = useState(3)
      return (
        <div>
          <button type="button">Antes</button>
          <AiSuggestionBar count={count} onAcceptAll={() => setCount(0)} />
        </div>
      )
    }
    render(<Barra />)
    await userEvent.click(screen.getByRole("button", { name: "Aplicar todos" }))
    const status = screen.getByRole("status")
    expect(status.textContent).toContain("Usaste las 3 propuestas.")
    await waitFor(() => expect(document.activeElement).toBe(status))
  })

  it("la pregunta nombra su grupo y devuelve la respuesta elegida", () => {
    const answer = vi.fn()
    render(
      <AiQuestion
        question="¿Cómo calza?"
        reason="No se ve en las fotos."
        options={[
          { value: "Normal", label: "Normal" },
          { value: "Chico", label: "Chico" },
        ]}
        onAnswer={answer}
      />,
    )
    const group = screen.getByRole("group", { name: "¿Cómo calza?" })
    expect(group.getAttribute("aria-describedby")).toBe(
      screen.getByText("No se ve en las fotos.").id,
    )
    fireEvent.click(screen.getByRole("button", { name: "Chico" }))
    expect(answer).toHaveBeenCalledWith("Chico")
  })
})

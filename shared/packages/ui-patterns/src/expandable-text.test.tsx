// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ExpandableText } from "./expandable-text.js"

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe("lectura ampliable", () => {
  it("amplía sin abrir la fila y conserva una sola copia del texto", () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} })
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(120)
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(40)
    const open = vi.fn()
    render(<table><tbody><tr onClick={open} onKeyDown={open}><td><ExpandableText text="Contexto completo de la tarea" label="contexto" /></td></tr></tbody></table>)
    fireEvent.click(screen.getByRole("button", { name: "Ver más: contexto" }))
    expect(open).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Ver menos: contexto" }).getAttribute("aria-expanded")).toBe("true")
    expect(screen.getAllByText("Contexto completo de la tarea")).toHaveLength(1)
  })

  it("no ofrece ampliar si el contenido cabe", () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} })
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(20)
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(20)
    render(<ExpandableText text="Confirmar cita" />)
    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.getByText("Confirmar cita")).toBeTruthy()
  })
})

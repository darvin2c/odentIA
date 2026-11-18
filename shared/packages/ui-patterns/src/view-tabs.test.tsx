// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ViewTabs } from "./view-tabs.js"

afterEach(() => {
  cleanup()
  document.body.innerHTML = ""
})

const options = [
  { value: "abiertas", label: "Mías y de mi área" },
  { value: "vencidas", label: "Vencidas", count: 4 },
  { value: "hechas", label: "Hechas" },
] as const

describe("ViewTabs", () => {
  it("dibuja una pestaña por vista, con su conteo, y marca la activa", () => {
    render(<ViewTabs label="Qué tareas ver" value="abiertas" onValueChange={() => {}} options={options} />)
    expect(screen.getByRole("tablist", { name: "Qué tareas ver" })).toBeTruthy()
    const tabs = screen.getAllByRole("tab")
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Mías y de mi área", "Vencidas · 4", "Hechas"])
    expect(screen.getByRole("tab", { name: "Mías y de mi área" }).getAttribute("aria-selected")).toBe("true")
  })

  it("avisa de la vista elegida sin tocar las demás", () => {
    const onValueChange = vi.fn()
    render(<ViewTabs label="Qué tareas ver" value="abiertas" onValueChange={onValueChange} options={options} />)
    fireEvent.click(screen.getByRole("tab", { name: /^Vencidas/ }))
    expect(onValueChange).toHaveBeenCalledWith("vencidas")
  })

  it("una opción deshabilitada no se elige", () => {
    const onValueChange = vi.fn()
    render(
      <ViewTabs
        label="De qué agente"
        value="todos"
        onValueChange={onValueChange}
        options={[
          { value: "todos", label: "Todos" },
          { value: "clio", label: "Clío", disabled: true },
        ]}
      />,
    )
    const clio = screen.getByRole("tab", { name: "Clío" })
    expect(clio.hasAttribute("disabled") || clio.getAttribute("aria-disabled") === "true").toBe(true)
  })
})

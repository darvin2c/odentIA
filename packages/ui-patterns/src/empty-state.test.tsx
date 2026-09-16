// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Armchair } from "lucide-react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { common } from "./common.js"
import { EmptyState } from "./empty-state.js"

afterEach(() => {
  cleanup()
  document.body.innerHTML = ""
})

describe("EmptyState", () => {
  it("renderiza título y descripción por defecto desde common.states", () => {
    render(<EmptyState />)
    expect(screen.getByText(common.states.empty)).toBeTruthy()
    expect(screen.getByText(common.states.emptyHint)).toBeTruthy()
  })

  it("renderiza el icono dentro de la caja de media y es decorativo", () => {
    const { container } = render(<EmptyState icon={Armchair} title="Sin mesas" />)
    const media = container.querySelector('[data-slot="empty-icon"]')
    expect(media).toBeTruthy()
    expect(media?.getAttribute("aria-hidden")).toBe("true")
    expect(media?.querySelector("svg")).toBeTruthy()
  })

  it("acción primaria y secundaria disparan sus handlers", () => {
    const onAction = vi.fn()
    const onSecondary = vi.fn()
    render(
      <EmptyState
        title="Sin mesas"
        actionLabel="Nueva mesa"
        onAction={onAction}
        secondaryActionLabel="Importar"
        onSecondaryAction={onSecondary}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Nueva mesa" }))
    fireEvent.click(screen.getByRole("button", { name: "Importar" }))
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onSecondary).toHaveBeenCalledTimes(1)
  })

  it("label sin handler no renderiza botón (guard de contrato)", () => {
    render(<EmptyState title="Sin mesas" actionLabel="Nueva mesa" />)
    expect(screen.queryByRole("button", { name: "Nueva mesa" })).toBeNull()
  })

  it("learn more renderiza enlace externo con icono", () => {
    render(
      <EmptyState
        title="Sin mesas"
        learnMoreLabel="Aprender más"
        learnMoreHref="https://docs.example.com"
      />,
    )
    const link = screen.getByRole("link", { name: /Aprender más/ })
    expect(link.getAttribute("href")).toBe("https://docs.example.com")
    expect(link.getAttribute("target")).toBe("_blank")
    expect(link.getAttribute("rel")).toContain("noreferrer")
  })

  it("sin acciones ni learn more no renderiza EmptyContent", () => {
    const { container } = render(<EmptyState title="Sin mesas" />)
    expect(container.querySelector('[data-slot="empty-content"]')).toBeNull()
  })
})

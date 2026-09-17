// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type * as React from "react"
import { afterEach, beforeAll, describe, expect, it, type Mock, vi } from "vitest"

import { FormPanel } from "./form-panel.js"

// Base UI ScrollArea y jsdom necesitan polyfills mínimos
beforeAll(() => {
  if (typeof window !== "undefined" && !window.ResizeObserver) {
    window.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof window.ResizeObserver
  }
  // Web Animations API: Base UI ScrollArea viewport llama getAnimations
  if (typeof Element !== "undefined" && !Element.prototype.getAnimations) {
    Element.prototype.getAnimations = () => []
  }
  if (typeof HTMLElement !== "undefined" && !HTMLElement.prototype.getAnimations) {
    HTMLElement.prototype.getAnimations = () => []
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  document.body.innerHTML = ""
})

function renderPanel(overrides: Partial<React.ComponentProps<typeof FormPanel>> = {}) {
  const props: React.ComponentProps<typeof FormPanel> = {
    onClose: vi.fn(),
    title: "Editar mesa",
    description: "Descripción de prueba",
    onSubmit: vi.fn((e: React.FormEvent) => e.preventDefault()),
    children: <div>contenido hijo</div>,
    ...overrides,
  }
  const utils = render(<FormPanel {...props} />)
  return {
    onClose: props.onClose as Mock,
    utils,
  }
}

describe("FormPanel", () => {
  it("es una región con nombre accesible, no un diálogo modal", () => {
    renderPanel()
    expect(screen.getByRole("region", { name: "Editar mesa" })).not.toBeNull()
    expect(screen.getByText("Descripción de prueba")).not.toBeNull()
    expect(screen.getByText("contenido hijo")).not.toBeNull()
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("Esc cierra cuando el formulario está prístino", () => {
    const { onClose } = renderPanel()
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("Esc con isDirty y confirm=false no cierra; con confirm=true sí", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false)
    const { onClose } = renderPanel({ isDirty: true })
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" })
    expect(confirmSpy).toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    confirmSpy.mockReturnValue(true)
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("Esc no cierra con un diálogo abierto encima", () => {
    const overlay = document.createElement("div")
    overlay.setAttribute("role", "dialog")
    document.body.appendChild(overlay)
    const { onClose } = renderPanel()
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" })
    expect(onClose).not.toHaveBeenCalled()
  })
})

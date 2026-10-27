// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type * as React from "react"
import { afterEach, beforeAll, describe, expect, it, type Mock, vi } from "vitest"

import { common } from "../common.js"
import { FormPanel } from "./form-panel.js"

const unsaved = common.confirm.unsaved

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

  it("con cambios, Esc pregunta con el diálogo propio y no con el del navegador", async () => {
    const nativeConfirm = vi.spyOn(window, "confirm")
    const { onClose } = renderPanel({ isDirty: true })
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" })
    const dialog = await screen.findByRole("alertdialog", { name: unsaved.title })
    expect(dialog.textContent).toContain(unsaved.description)
    expect(nativeConfirm).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    // El foco entra en la pregunta.
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
  })

  it("«Continuar editando» no cierra y devuelve el foco al campo", async () => {
    const { onClose } = renderPanel({ isDirty: true, children: <input aria-label="Nombre" /> })
    const field = screen.getByLabelText("Nombre")
    field.focus()
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" })
    await screen.findByRole("alertdialog", { name: unsaved.title })
    fireEvent.click(screen.getByRole("button", { name: unsaved.keepEditing }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(onClose).not.toHaveBeenCalled()
    await waitFor(() => expect(document.activeElement).toBe(field))
  })

  it("Esc con la pregunta abierta solo cierra la pregunta", async () => {
    const { onClose } = renderPanel({ isDirty: true })
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" })
    const dialog = await screen.findByRole("alertdialog", { name: unsaved.title })
    fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" })
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(onClose).not.toHaveBeenCalled()
  })

  it("«Descartar y salir» cierra", async () => {
    const { onClose } = renderPanel({ isDirty: true })
    fireEvent.click(screen.getByRole("button", { name: common.actions.cancel }))
    await screen.findByRole("alertdialog", { name: unsaved.title })
    fireEvent.click(screen.getByRole("button", { name: unsaved.discard }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("sin cambios, Cancelar cierra directo sin preguntar", () => {
    const { onClose } = renderPanel()
    fireEvent.click(screen.getByRole("button", { name: common.actions.cancel }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })

  it("la «×» de la cabecera es el mismo cierre protegido que «Cancelar»", async () => {
    const { onClose } = renderPanel({ isDirty: true })
    fireEvent.click(screen.getByRole("button", { name: common.actions.close }))
    await screen.findByRole("alertdialog", { name: unsaved.title })
    fireEvent.click(screen.getByRole("button", { name: unsaved.discard }))
    expect(onClose).toHaveBeenCalledTimes(1)
    // «Cancelar» sigue en el pie.
    expect(screen.queryByRole("button", { name: common.actions.cancel })).not.toBeNull()
  })

  it("un botón del pie que solo diría «Cerrar» no repite la «×»", () => {
    renderPanel({ cancelLabel: common.actions.close, submitLabel: common.actions.close })
    expect(screen.getAllByRole("button", { name: common.actions.close })).toHaveLength(1)
  })

  it("mientras se envía no cierra ni pregunta", () => {
    const { onClose } = renderPanel({ isDirty: true, isSubmitting: true })
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByRole("alertdialog")).toBeNull()
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

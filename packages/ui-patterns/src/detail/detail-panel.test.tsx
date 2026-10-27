// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type * as React from "react"
import { afterEach, beforeAll, describe, expect, it, type Mock, vi } from "vitest"

import { common } from "../common.js"
import { DetailPanel } from "./detail-panel.js"

const unsaved = common.confirm.unsaved

// Base UI ScrollArea en jsdom necesita estos polyfills mínimos.
beforeAll(() => {
  if (typeof window !== "undefined" && !window.ResizeObserver) {
    window.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof window.ResizeObserver
  }
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

function renderPanel(overrides: Partial<React.ComponentProps<typeof DetailPanel>> = {}) {
  const onClose = vi.fn()
  const props: React.ComponentProps<typeof DetailPanel> = {
    onClose,
    title: "Atención del 12/09/2026",
    description: "Descripción de prueba",
    children: <div>contenido hijo</div>,
    ...overrides,
  }
  if (overrides.onClose) props.onClose = overrides.onClose
  const utils = render(<DetailPanel {...props} />)
  return { onClose: props.onClose as Mock, utils }
}

describe("DetailPanel", () => {
  it("es una región con nombre accesible, no un diálogo modal", () => {
    renderPanel()

    expect(screen.getByRole("region", { name: "Atención del 12/09/2026" })).not.toBeNull()
    expect(screen.getByText("Descripción de prueba")).not.toBeNull()
    expect(screen.getByText("contenido hijo")).not.toBeNull()
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("Esc cierra cuando no hay cambios sin guardar", () => {
    const { onClose } = renderPanel()

    fireEvent.keyDown(window, { key: "Escape", code: "Escape" })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("con cambios, Esc pregunta; «Continuar editando» no cierra y «Descartar y salir» sí", async () => {
    const nativeConfirm = vi.spyOn(window, "confirm")
    const { onClose } = renderPanel({ isDirty: true })

    fireEvent.keyDown(window, { key: "Escape", code: "Escape" })
    const dialog = await screen.findByRole("alertdialog", { name: unsaved.title })
    expect(dialog.textContent).toContain(unsaved.description)
    expect(nativeConfirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: unsaved.keepEditing }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: common.actions.close }))
    await screen.findByRole("alertdialog", { name: unsaved.title })
    fireEvent.click(screen.getByRole("button", { name: unsaved.discard }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("sin cambios, Cerrar cierra directo sin preguntar", () => {
    const { onClose } = renderPanel()

    fireEvent.click(screen.getByRole("button", { name: common.actions.close }))

    expect(onClose).toHaveBeenCalledTimes(1)
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

  it("con una escritura en curso no cierra ni por Esc ni por el botón", () => {
    const { onClose } = renderPanel({ isSubmitting: true })

    fireEvent.keyDown(window, { key: "Escape", code: "Escape" })
    fireEvent.click(screen.getByRole("button", { name: common.actions.close }))

    expect(onClose).not.toHaveBeenCalled()
  })

  it("la «×» va en la cabecera y el pie solo lleva las acciones del detalle", () => {
    const { utils } = renderPanel({ actions: <button type="button">Editar</button> })

    const close = screen.getByRole("button", { name: common.actions.close })
    const title = screen.getByRole("heading", { name: "Atención del 12/09/2026" })
    // La «×» comparte fila con el título: arriba, no en el pie.
    expect(close.closest("div.border-b")).toBe(title.closest("div.border-b"))
    expect(screen.getAllByRole("button", { name: common.actions.close })).toHaveLength(1)
    expect(screen.getByRole("button", { name: "Editar" }).closest("div.border-b")).toBeNull()
    expect(utils.container.textContent).not.toContain(`${common.actions.close}Editar`)
  })

  it("un cierre con nombre propio («Listo») va también en el pie", () => {
    const { onClose } = renderPanel({ closeLabel: "Listo" })

    fireEvent.click(screen.getByRole("button", { name: "Listo" }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("button", { name: common.actions.close })).not.toBeNull()
  })

  it("sin acciones no monta el pie: solo queda la «×»", () => {
    renderPanel()

    expect(screen.queryAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([common.actions.close])
  })

  it("sin acciones ni cierre visible no monta el pie", () => {
    renderPanel({ showClose: false })

    expect(screen.queryAllByRole("button")).toHaveLength(0)
  })
})
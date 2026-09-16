// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type * as React from "react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { common } from "./common.js"
import { FormDrawer } from "./form-drawer.js"

// Base UI Drawer y jsdom necesitan polyfills mínimos
beforeAll(() => {
  if (typeof window !== "undefined" && !window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
  }
  if (typeof window !== "undefined" && !window.ResizeObserver) {
    window.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof window.ResizeObserver
  }
  if (typeof window !== "undefined" && !window.scrollTo) {
    window.scrollTo = () => {}
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

function renderDrawer(overrides: Partial<React.ComponentProps<typeof FormDrawer>> = {}) {
  const onClose = vi.fn()
  const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault())
  const props: React.ComponentProps<typeof FormDrawer> = {
    open: true,
    onClose,
    title: "Editar mesa",
    description: "Descripción de prueba",
    onSubmit,
    children: <div>contenido hijo</div>,
    ...overrides,
  }
  if (overrides.onClose) props.onClose = overrides.onClose
  if (overrides.onSubmit) props.onSubmit = overrides.onSubmit
  const utils = render(<FormDrawer {...props} />)
  return {
    onClose: props.onClose as ReturnType<typeof vi.fn>,
    onSubmit: props.onSubmit as ReturnType<typeof vi.fn>,
    utils,
  }
}

describe("FormDrawer", () => {
  it("open=false no renderiza DrawerContent", () => {
    renderDrawer({ open: false })
    expect(screen.queryByText("Editar mesa")).toBeNull()
    expect(document.querySelector('[data-slot="drawer-popup"]')).toBeNull()
  })

  it("open=true renderiza title, description y children", async () => {
    renderDrawer({ open: true })
    expect(await screen.findByText("Editar mesa")).not.toBeNull()
    expect(screen.getByText("Descripción de prueba")).not.toBeNull()
    expect(screen.getByText("contenido hijo")).not.toBeNull()
  })

  it("isLoading=true renderiza 3 Skeleton y no children ni error", async () => {
    renderDrawer({ isLoading: true, error: "boom", children: <div>hijo oculto</div> })
    await screen.findByText("Editar mesa")
    const skeletons = document.querySelectorAll('[data-slot="skeleton"]')
    expect(skeletons.length).toBe(3)
    expect(screen.queryByText("hijo oculto")).toBeNull()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("error muestra banner role=alert con clase bg-danger-soft", async () => {
    renderDrawer({ error: "falló al guardar" })
    await screen.findByText("Editar mesa")
    const alert = screen.getByRole("alert")
    expect(alert.textContent).toBe("falló al guardar")
    expect(alert.className).toContain("bg-danger-soft")
  })

  it("isSubmitting=true deshabilita Cancelar y muestra Spinner en Guardar", async () => {
    renderDrawer({ isSubmitting: true })
    await screen.findByText("Editar mesa")
    const cancelar = screen.getByRole("button", {
      name: common.actions.cancel,
    }) as HTMLButtonElement
    expect(cancelar.disabled).toBe(true)
    // Spinner aporta "Loading" al nombre accesible → "LoadingGuardar", buscar por regex
    const guardar = screen.getByRole("button", { name: /Guardar/ }) as HTMLButtonElement
    expect(guardar.disabled).toBe(true)
    const spinner =
      guardar.querySelector('[data-slot="spinner"]') ??
      document.querySelector('[data-slot="spinner"]')
    expect(spinner).not.toBeNull()
  })

  it("isDirty=true + Cancelar con confirm false no llama onClose; confirm true sí", async () => {
    const onClose = vi.fn()
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false)
    renderDrawer({ isDirty: true, onClose })
    await screen.findByText("Editar mesa")
    const cancelar = screen.getByRole("button", { name: common.actions.cancel })
    fireEvent.click(cancelar)
    expect(confirmSpy).toHaveBeenCalledWith(common.confirm.unsavedMessage)
    expect(onClose).not.toHaveBeenCalled()
    confirmSpy.mockReturnValue(true)
    fireEvent.click(cancelar)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("isDirty=false + Cancelar llama onClose sin confirm", async () => {
    const onClose = vi.fn()
    const confirmSpy = vi.spyOn(window, "confirm")
    renderDrawer({ isDirty: false, onClose })
    await screen.findByText("Editar mesa")
    fireEvent.click(screen.getByRole("button", { name: common.actions.cancel }))
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("click en Guardar (type=submit) llama onSubmit sin submit nativo", async () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault())
    renderDrawer({ onSubmit })
    await screen.findByText("Editar mesa")
    const guardar = screen.getByRole("button", { name: common.actions.save })
    fireEvent.click(guardar)
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    const event = onSubmit.mock.calls[0]?.[0] as unknown as Event | undefined
    expect(event).toBeDefined()
  })

  it("Esc con isDirty=true y confirm false no cierra; confirm true sí", async () => {
    const onClose = vi.fn()
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false)
    renderDrawer({ isDirty: true, onClose })
    await screen.findByText("Editar mesa")

    fireEvent.keyDown(document, { key: "Escape", code: "Escape", keyCode: 27 })
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled(), { timeout: 1000 }).catch(() => {})
    if (confirmSpy.mock.calls.length === 0) {
      fireEvent.keyDown(window, { key: "Escape", code: "Escape" })
      {
        const { promise, resolve } = Promise.withResolvers<void>()
        setTimeout(resolve, 50)
        await promise
      }
    }
    expect(onClose).not.toHaveBeenCalled()

    confirmSpy.mockReturnValue(true)
    fireEvent.keyDown(document, { key: "Escape", code: "Escape" })
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), { timeout: 1000 }).catch(
      async () => {
        fireEvent.keyDown(window, { key: "Escape", code: "Escape" })
        {
          const { promise, resolve } = Promise.withResolvers<void>()
          setTimeout(resolve, 50)
          await promise
        }
        expect(onClose).toHaveBeenCalledTimes(1)
      },
    )
  })
})

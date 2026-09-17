// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it } from "vitest"

import { MasterDetail, useDetailMode } from "./master-detail.js"

// react-resizable-panels mide el group con ResizeObserver; jsdom no lo trae.
beforeAll(() => {
  if (typeof window !== "undefined" && !window.ResizeObserver) {
    window.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof window.ResizeObserver
  }
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ""
})

function mockMatchMedia(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

function ModeProbe() {
  return <output>{useDetailMode()}</output>
}

describe("useDetailMode", () => {
  it("devuelve panel en viewport ancho y drawer en estrecho", () => {
    mockMatchMedia(true)
    render(<ModeProbe />)
    expect(screen.getByText("panel")).not.toBeNull()
    cleanup()

    mockMatchMedia(false)
    render(<ModeProbe />)
    expect(screen.getByText("drawer")).not.toBeNull()
  })
})

describe("MasterDetail", () => {
  it("en modo drawer monta el maestro solo y descarta el panel", () => {
    mockMatchMedia(false)
    render(
      <MasterDetail panel={<div>formulario</div>}>
        <div>tabla</div>
      </MasterDetail>,
    )
    expect(screen.getByText("tabla")).not.toBeNull()
    expect(screen.queryByText("formulario")).toBeNull()
    expect(document.querySelector('[data-slot="resizable-panel-group"]')).toBeNull()
  })

  it("en modo panel monta maestro y detalle como paneles redimensionables", () => {
    mockMatchMedia(true)
    render(
      <MasterDetail panel={<div>formulario</div>}>
        <div>tabla</div>
      </MasterDetail>,
    )
    const panels = document.querySelectorAll('[data-slot="resizable-panel"]')
    expect(panels.length).toBe(2)
    expect(panels[1]?.textContent).toContain("formulario")
    const handle = document.querySelector('[data-slot="resizable-handle"]')
    expect(handle).not.toBeNull()
    expect(handle?.getAttribute("aria-disabled")).toBeNull()
  })

  it("si nunca se abrió, no monta el panel de detalle ni el handle", () => {
    mockMatchMedia(true)
    render(
      <MasterDetail panel={null}>
        <div>tabla</div>
      </MasterDetail>,
    )
    expect(document.querySelectorAll('[data-slot="resizable-panel"]').length).toBe(1)
    expect(document.querySelector('[data-slot="resizable-handle"]')).toBeNull()
  })

  it("tras abrir y cerrar, el detalle queda colapsado y el handle deshabilitado", () => {
    mockMatchMedia(true)
    const utils = render(
      <MasterDetail panel={<div>formulario</div>}>
        <div>tabla</div>
      </MasterDetail>,
    )
    utils.rerender(
      <MasterDetail panel={null}>
        <div>tabla</div>
      </MasterDetail>,
    )
    const handle = document.querySelector('[data-slot="resizable-handle"]')
    expect(handle?.getAttribute("aria-disabled")).toBe("true")
    const panels = document.querySelectorAll('[data-slot="resizable-panel"]')
    expect(panels[1]?.textContent).toBe("")
  })
})

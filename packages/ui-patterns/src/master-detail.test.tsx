// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import type * as React from "react"
import { afterEach, beforeAll, describe, expect, it } from "vitest"

import { MasterDetail, useDetailMode } from "./master-detail.js"
import { SideDockProvider, SideDockSlot, useSideDock } from "./side-dock.js"

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

  it("si nunca se abrió, monta el detalle colapsado y el handle apagado", () => {
    mockMatchMedia(true)
    render(
      <MasterDetail panel={null}>
        <div>tabla</div>
      </MasterDetail>,
    )
    // El panel existe desde el arranque (colapsado) porque una entrada animada
    // necesita un estado de partida; el handle sí queda apagado.
    const panels = document.querySelectorAll('[data-slot="resizable-panel"]')
    expect(panels.length).toBe(2)
    expect(panels[1]?.textContent).toBe("")
    const handle = document.querySelector('[data-slot="resizable-handle"]')
    expect(handle?.getAttribute("aria-disabled")).toBe("true")
  })

  it("tras abrir y cerrar, el detalle queda colapsado, inerte y sin foco alcanzable", () => {
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
    // El contenido sobrevive al cierre (la columna se anima vacía si no), pero
    // queda fuera del alcance del teclado y de la tecnología asistiva.
    expect(panels[1]?.textContent).toContain("formulario")
    const contenido = panels[1]?.querySelector("[data-closed]")
    expect(contenido?.getAttribute("inert")).toBe("")
  })

  describe("con columna lateral en el layout", () => {
    function Occupied() {
      return <output data-testid="ocupada">{String(useSideDock().occupied)}</output>
    }
    const layout = (panel: React.ReactNode) => (
      <SideDockProvider>
        <div data-testid="pagina">
          <MasterDetail panel={panel}>
            <div>tabla</div>
          </MasterDetail>
        </div>
        <div data-testid="columna">
          <SideDockSlot />
        </div>
        <Occupied />
      </SideDockProvider>
    )

    it("monta el detalle en la columna del layout, fuera de la página, y la marca ocupada", () => {
      mockMatchMedia(true)
      const utils = render(layout(<div>formulario</div>))
      expect(document.querySelector('[data-slot="resizable-panel-group"]')).toBeNull()
      expect(screen.getByTestId("pagina").textContent).toBe("tabla")
      const column = screen.getByTestId("columna")
      expect(column.textContent).toContain("formulario")
      expect(column.querySelector("aside [role=separator]")).not.toBeNull()
      expect(screen.getByTestId("ocupada").textContent).toBe("true")

      // Al cerrar, la columna desaparece y queda libre; la lista no se remonta.
      const table = screen.getByText("tabla")
      utils.rerender(layout(null))
      expect(column.querySelector("aside")).toBeNull()
      expect(screen.getByTestId("ocupada").textContent).toBe("false")
      expect(screen.getByText("tabla")).toBe(table)
    })

    it("en ventana estrecha no usa la columna: el formulario es cosa del drawer de la página", () => {
      mockMatchMedia(false)
      render(layout(<div>formulario</div>))
      expect(screen.queryByText("formulario")).toBeNull()
      expect(screen.getByTestId("ocupada").textContent).toBe("false")
    })
  })
})

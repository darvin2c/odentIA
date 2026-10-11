// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import type * as React from "react"
import { afterEach, beforeAll, describe, expect, it } from "vitest"

import { FormDrawer } from "./form/form-drawer.js"
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

    it("lo que se abre desde la columna es un cajón: ahí dentro el modo es drawer", () => {
      mockMatchMedia(true)
      render(
        layout(
          <div>
            formulario <ModeProbe />
          </div>,
        ),
      )
      const column = screen.getByTestId("columna")
      expect(column.querySelector("output")?.textContent).toBe("drawer")
    })

    it("dentro de un cajón el modo también es drawer aunque la ventana sea ancha", () => {
      mockMatchMedia(true)
      render(
        <SideDockProvider>
          <ModeProbe />
          <FormDrawer open title="Primero" onClose={() => {}} onSubmit={() => {}}>
            <span data-testid="anidado">
              <ModeProbe />
            </span>
          </FormDrawer>
        </SideDockProvider>,
      )
      expect(screen.getByTestId("anidado").textContent).toBe("drawer")
      expect(screen.getAllByText("panel").length).toBe(1)
    })

    it("la columna es de quien la pide primero: el segundo sale como cajón y no la desplaza", () => {
      mockMatchMedia(true)
      const errors: unknown[] = []
      const original = console.error
      console.error = (...args: unknown[]) => errors.push(args[0])
      try {
        const twice = (second: React.ReactNode) => (
          <SideDockProvider>
            <MasterDetail panel={<div>primero</div>}>
              <div>tabla uno</div>
            </MasterDetail>
            <MasterDetail panel={second}>
              <div>tabla dos</div>
            </MasterDetail>
            <div data-testid="columna">
              <SideDockSlot />
            </div>
          </SideDockProvider>
        )
        const utils = render(twice(<div>segundo</div>))
        const column = screen.getByTestId("columna")
        expect(column.querySelectorAll("aside").length).toBe(1)
        expect(column.textContent).toContain("primero")
        expect(column.textContent).not.toContain("segundo")
        const fallback = document.querySelector("[data-slot='drawer-popup']")
        expect(fallback?.textContent).toContain("segundo")

        // Al cerrarse el segundo, el primero sigue en su sitio.
        utils.rerender(twice(null))
        expect(column.textContent).toContain("primero")
      } finally {
        console.error = original
      }
    })

    describe("FormDrawer", () => {
      const form = (title: string, children?: React.ReactNode) => (
        <FormDrawer open title={title} onClose={() => {}} onSubmit={() => {}}>
          {children ?? <span>campos de {title}</span>}
        </FormDrawer>
      )
      const withColumn = (content: React.ReactNode) => (
        <SideDockProvider>
          {content}
          <div data-testid="columna">
            <SideDockSlot />
          </div>
        </SideDockProvider>
      )
      const popups = () => document.querySelectorAll("[data-slot='drawer-popup']")

      it("en ventana ancha se abre en la columna del layout, sin cajón", () => {
        mockMatchMedia(true)
        render(withColumn(form("Nueva tarea")))
        const column = screen.getByTestId("columna")
        expect(column.querySelector("aside section")?.textContent).toContain("campos de Nueva tarea")
        expect(popups().length).toBe(0)
      })

      it("en ventana estrecha sigue siendo cajón", () => {
        mockMatchMedia(false)
        render(withColumn(form("Nueva tarea")))
        expect(screen.getByTestId("columna").querySelector("aside")).toBeNull()
        expect(popups().length).toBe(1)
      })

      it("un formulario abierto desde otro se apila como cajón y el primero sigue en la columna", () => {
        mockMatchMedia(true)
        render(withColumn(form("Primero", form("Segundo"))))
        const column = screen.getByTestId("columna")
        expect(column.querySelectorAll("aside").length).toBe(1)
        expect(column.querySelector("aside")?.textContent).toContain("Primero")
        expect(popups().length).toBe(1)
        expect(popups()[0]?.textContent).toContain("campos de Segundo")
      })

      it("con la columna ocupada, otro formulario de la página se abre como cajón", () => {
        mockMatchMedia(true)
        const utils = render(withColumn(form("Primero")))
        utils.rerender(
          withColumn(
            <>
              {form("Primero")}
              {form("Otro")}
            </>,
          ),
        )
        const column = screen.getByTestId("columna")
        expect(column.querySelectorAll("aside").length).toBe(1)
        expect(column.textContent).toContain("campos de Primero")
        expect(popups()[0]?.textContent).toContain("campos de Otro")
      })

      it("un cajón pensado como vista inmersiva (muy ancho) no va a la columna", () => {
        mockMatchMedia(true)
        render(
          withColumn(
            <FormDrawer
              open
              title="Visor"
              onClose={() => {}}
              onSubmit={() => {}}
              className="data-[swipe-axis=x]:sm:[--drawer-content-width:min(72rem,calc(100vw-2rem))]"
            >
              <span>visor</span>
            </FormDrawer>,
          ),
        )
        expect(screen.getByTestId("columna").querySelector("aside")).toBeNull()
        expect(popups().length).toBe(1)
      })
    })

    it("en ventana estrecha no usa la columna: el formulario es cosa del drawer de la página", () => {
      mockMatchMedia(false)
      render(layout(<div>formulario</div>))
      expect(screen.queryByText("formulario")).toBeNull()
      expect(screen.getByTestId("ocupada").textContent).toBe("false")
    })
  })
})

// @vitest-environment jsdom

import { Sidebar, SidebarContent, SidebarProvider } from "@odentia/ui"
import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { HeaderUtilitiesProvider, useHeaderCompact } from "./header-utilities.js"
import { PageHeader } from "./page-header.js"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ""
})

/** jsdom no mide: el título pide 300 px y solo le quedan 120. */
function stubNarrowRow() {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  )
  const width = (el: Element, kind: "client" | "scroll") =>
    el.tagName === "H1" ? (kind === "scroll" ? 300 : 120) : 0
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return width(this, "client")
  })
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
    return width(this, "scroll")
  })
}

function CompactProbe() {
  return <span>{useHeaderCompact() ? "fila compacta" : "fila completa"}</span>
}

describe("PageHeader", () => {
  it("el título va en la fila del encabezado; la acción principal, con su nombre accesible", () => {
    render(
      <PageHeader
        title="María de los Ángeles Quispe Flores de la Cruz"
        primary={{ label: "Nueva atención", icon: <span aria-hidden="true">+</span>, onClick: () => {} }}
      />,
    )

    const header = screen.getByRole("banner")
    expect(within(header).getByRole("heading", { level: 1 }).textContent).toBe(
      "María de los Ángeles Quispe Flores de la Cruz",
    )
    expect(within(header).getByRole("button", { name: "Nueva atención" })).toBeTruthy()
  })

  it("el contexto de la página va en su fila propia, fuera del encabezado", () => {
    render(<PageHeader title="Pacientes" subtitle="Contacto desde hace 3 meses" />)

    const header = screen.getByRole("banner")
    expect(header.textContent).toBe("Pacientes")
    expect(screen.getByText("Contacto desde hace 3 meses")).toBeTruthy()
    expect(header.contains(screen.getByText("Contacto desde hace 3 meses"))).toBe(false)
  })

  it("sin acciones ni utilidades no dibuja el menú ⋯", () => {
    render(<PageHeader title="Prestaciones" />)
    expect(screen.queryByRole("button", { name: "Más opciones" })).toBeNull()
  })

  it("con acciones secundarias, el menú ⋯ aparece en la fila", () => {
    render(
      <PageHeader
        title="Finanzas"
        menu={[{ label: "Registrar gasto", onSelect: () => {} }]}
      />,
    )
    expect(screen.getByRole("button", { name: "Más opciones" })).toBeTruthy()
  })

  it("si la fila cabe, las utilidades van completas y el ⋯ sin opciones de la página no aparece", () => {
    render(
      <HeaderUtilitiesProvider
        value={{
          utilities: (
            <>
              <button type="button">Avisos</button>
              <CompactProbe />
            </>
          ),
          menuItems: <span>Ayuda desde el ⋯</span>,
        }}
      >
        <PageHeader title="Inicio" />
      </HeaderUtilitiesProvider>,
    )

    const header = screen.getByRole("banner")
    expect(within(header).getByRole("button", { name: "Avisos" })).toBeTruthy()
    expect(within(header).getByText("fila completa")).toBeTruthy()
    expect(within(header).queryByRole("button", { name: "Más opciones" })).toBeNull()
  })

  it("si el título se recorta de más, la fila se compacta y el ⋯ recibe las opciones extra", () => {
    stubNarrowRow()
    render(
      <HeaderUtilitiesProvider
        value={{ utilities: <CompactProbe />, menuItems: <span>Ayuda desde el ⋯</span> }}
      >
        <PageHeader title="Configuración de la clínica" />
      </HeaderUtilitiesProvider>,
    )

    const header = screen.getByRole("banner")
    expect(within(header).getByText("fila compacta")).toBeTruthy()
    expect(within(header).getByRole("button", { name: "Más opciones" })).toBeTruthy()
  })

  it("sin shell no monta el disparador del menú; dentro del shell lo monta y lo nombra", () => {
    const { unmount } = render(<PageHeader title="Pacientes" />)
    expect(screen.queryByRole("button", { name: "Alternar menú lateral" })).toBeNull()
    unmount()

    render(
      <SidebarProvider>
        <Sidebar>
          <SidebarContent />
        </Sidebar>
        <PageHeader title="Pacientes" />
      </SidebarProvider>,
    )
    expect(screen.getByRole("button", { name: "Alternar menú lateral" })).toBeTruthy()
  })
})

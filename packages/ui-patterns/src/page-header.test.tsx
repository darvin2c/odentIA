// @vitest-environment jsdom

import { Sidebar, SidebarContent, SidebarProvider } from "@odentia/ui"
import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { HeaderUtilitiesProvider } from "./header-utilities.js"
import { PageHeader } from "./page-header.js"

afterEach(() => {
  cleanup()
  document.body.innerHTML = ""
})

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

  it("las utilidades globales y las opciones extra del proveedor van en la fila y en el ⋯", () => {
    render(
      <HeaderUtilitiesProvider
        value={{
          utilities: <button type="button">Avisos</button>,
          menuItems: <span>Ayuda desde el ⋯</span>,
        }}
      >
        <PageHeader title="Inicio" />
      </HeaderUtilitiesProvider>,
    )

    const header = screen.getByRole("banner")
    expect(within(header).getByRole("button", { name: "Avisos" })).toBeTruthy()
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

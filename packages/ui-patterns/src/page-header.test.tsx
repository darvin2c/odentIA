// @vitest-environment jsdom

import { Sidebar, SidebarContent, SidebarProvider } from "@odentia/ui"
import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { PageHeader } from "./page-header.js"

afterEach(() => {
  cleanup()
  document.body.innerHTML = ""
})

describe("PageHeader", () => {
  it("el encabezado lleva el título completo aunque se recorte, y las acciones van con él", () => {
    render(
      <PageHeader
        title="María de los Ángeles Quispe Flores de la Cruz"
        subtitle="Contacto desde hace 3 meses"
        actions={<button type="button">Nueva atención</button>}
      />,
    )

    const header = screen.getByRole("banner")
    expect(within(header).getByRole("heading", { level: 1 }).textContent).toBe(
      "María de los Ángeles Quispe Flores de la Cruz",
    )
    expect(within(header).getByText("Contacto desde hace 3 meses")).toBeTruthy()
    expect(within(header).getByRole("button", { name: "Nueva atención" })).toBeTruthy()
  })

  it("sin subtítulo no deja hueco ni texto de relleno", () => {
    render(<PageHeader title="Prestaciones" />)

    const header = screen.getByRole("banner")
    expect(header.textContent).toBe("Prestaciones")
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

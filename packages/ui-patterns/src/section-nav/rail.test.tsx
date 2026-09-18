// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { SectionNavRail } from "./rail.js"
import type { SectionNavItem } from "./types.js"

afterEach(cleanup)

function AnchorLink({
  to,
  search,
  children,
  ...rest
}: {
  to?: string
  search?: Record<string, string>
  children: ReactNode
  [key: string]: unknown
}) {
  return (
    <a href={search ? `${to}?${new URLSearchParams(search)}` : to} {...rest}>
      {children}
    </a>
  )
}

const items: SectionNavItem[] = [
  { label: "Resumen", to: "/pacientes/123" },
  { label: "Historia clínica", to: "/pacientes/123/historia" },
  { label: "Documentos", to: "/pacientes/123/documentos" },
]

function renderRail(pathname: string, navItems: SectionNavItem[] = items, side?: "left" | "right") {
  return render(
    <SectionNavRail
      label="Secciones de la ficha"
      items={navItems}
      pathname={pathname}
      LinkComponent={AnchorLink}
      side={side}
    >
      <p>contenido de la sección</p>
    </SectionNavRail>,
  )
}

describe("SectionNavRail", () => {
  it("expone un landmark con nombre accesible y renderiza el contenido", () => {
    renderRail("/pacientes/123")
    const nav = screen.getByRole("navigation", { name: "Secciones de la ficha" })
    expect(nav.querySelectorAll("a")).toHaveLength(items.length)
    expect(screen.getAllByText("contenido de la sección")).toHaveLength(1)
  })

  it("un solo link por ítem, apuntando a su ruta", () => {
    renderRail("/pacientes/123")
    expect(screen.getAllByRole("link")).toHaveLength(items.length)
    expect(screen.getByRole("link", { name: "Documentos" }).getAttribute("href")).toBe(
      "/pacientes/123/documentos",
    )
  })

  it("marca el ítem de la ruta exacta y ninguno más", () => {
    renderRail("/pacientes/123")
    expect(screen.getByRole("link", { name: "Resumen" }).getAttribute("aria-current")).toBe("page")
    expect(
      screen.getByRole("link", { name: "Historia clínica" }).getAttribute("aria-current"),
    ).toBeNull()
  })

  it("en una subruta gana la ruta más específica, no el padre", () => {
    renderRail("/pacientes/123/historia")
    expect(
      screen.getByRole("link", { name: "Historia clínica" }).getAttribute("aria-current"),
    ).toBe("page")
    expect(screen.getByRole("link", { name: "Resumen" }).getAttribute("aria-current")).toBeNull()
  })

  it("no marca ningún ítem fuera de la sección", () => {
    renderRail("/pacientes/999")
    for (const link of screen.getAllByRole("link")) {
      expect(link.getAttribute("aria-current")).toBeNull()
    }
  })

  it("reserva el espacio del contador y lo deja fuera del nombre accesible", () => {
    renderRail("/pacientes/123", [{ label: "Documentos", to: "/pacientes/123", badge: 3 }])
    const link = screen.getByRole("link", { name: "Documentos" })
    expect(link.className).toContain("pr-8")
    expect(screen.getAllByText("3")).toHaveLength(1)
    expect(link.contains(screen.getByText("3"))).toBe(false)
  })

  it("dibuja el icono relleno en el activo y el de contorno en el resto", () => {
    const Linea = ({ className }: { className?: string }) => (
      <span className={className}>linea</span>
    )
    const Relleno = ({ className }: { className?: string }) => (
      <span className={className}>relleno</span>
    )
    renderRail("/pacientes/123", [
      { label: "Resumen", to: "/pacientes/123", icon: Linea, iconActive: Relleno },
      { label: "Documentos", to: "/pacientes/123/documentos", icon: Linea, iconActive: Relleno },
    ])
    const activo = screen.getByRole("link", { name: /Resumen/ })
    expect(activo.querySelector("span")?.textContent).toBe("relleno")
    const inactivo = screen.getByRole("link", { name: /Documentos/ })
    expect(inactivo.querySelector("span")?.textContent).toBe("linea")
  })

  it("mantiene la navegación antes del contenido en los dos lados", () => {
    const { container } = renderRail("/pacientes/123", items, "right")
    const nav = container.querySelector("nav")
    const content = nav?.nextElementSibling
    expect(content).not.toBeNull()
    expect(content?.contains(screen.getByText("contenido de la sección"))).toBe(true)
  })
})

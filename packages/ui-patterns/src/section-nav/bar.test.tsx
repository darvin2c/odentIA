// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { SectionNavBar } from "./bar.js"
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

function renderBar(
  pathname: string,
  navItems: SectionNavItem[] = items,
  mobilePosition?: "header" | "footer",
) {
  return render(
    <SectionNavBar
      label="Secciones de la ficha"
      items={navItems}
      pathname={pathname}
      LinkComponent={AnchorLink}
      mobilePosition={mobilePosition}
    >
      <p>contenido de la sección</p>
    </SectionNavBar>,
  )
}

describe("SectionNavBar", () => {
  it("expone un landmark con nombre accesible y renderiza el contenido", () => {
    renderBar("/pacientes/123")
    const nav = screen.getByRole("navigation", { name: "Secciones de la ficha" })
    expect(nav.querySelectorAll("a")).toHaveLength(items.length)
    expect(screen.getAllByText("contenido de la sección")).toHaveLength(1)
  })

  it("un solo link por ítem, apuntando a su ruta", () => {
    renderBar("/pacientes/123")
    expect(screen.getAllByRole("link")).toHaveLength(items.length)
    expect(screen.getByRole("link", { name: "Documentos" }).getAttribute("href")).toBe(
      "/pacientes/123/documentos",
    )
  })

  it("marca el ítem de la ruta exacta y ninguno más", () => {
    renderBar("/pacientes/123")
    expect(screen.getByRole("link", { name: "Resumen" }).getAttribute("aria-current")).toBe("page")
    expect(
      screen.getByRole("link", { name: "Historia clínica" }).getAttribute("aria-current"),
    ).toBeNull()
  })

  it("en una subruta gana la ruta más específica, no el padre", () => {
    renderBar("/pacientes/123/historia")
    expect(
      screen.getByRole("link", { name: "Historia clínica" }).getAttribute("aria-current"),
    ).toBe("page")
    expect(screen.getByRole("link", { name: "Resumen" }).getAttribute("aria-current")).toBeNull()
  })

  it("deja el contador fuera del link y aparece una sola vez", () => {
    renderBar("/pacientes/123", [{ label: "Documentos", to: "/pacientes/123", badge: 3 }])
    const link = screen.getByRole("link", { name: "Documentos" })
    expect(link.querySelector("span:last-child")?.textContent).toBe("Documentos")
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
    renderBar("/pacientes/123", [
      { label: "Resumen", to: "/pacientes/123", icon: Linea, iconActive: Relleno },
      { label: "Documentos", to: "/pacientes/123/documentos", icon: Linea, iconActive: Relleno },
    ])
    expect(screen.getByRole("link", { name: /Resumen/ }).querySelector("span")?.textContent).toBe(
      "relleno",
    )
    expect(
      screen.getByRole("link", { name: /Documentos/ }).querySelector("span")?.textContent,
    ).toBe("linea")
  })

  it("monta igual pegada arriba o abajo", () => {
    const { unmount } = renderBar("/pacientes/123", items, "header")
    expect(screen.getAllByRole("link")).toHaveLength(items.length)
    unmount()
    renderBar("/pacientes/123", items, "footer")
    expect(screen.getAllByRole("link")).toHaveLength(items.length)
  })
})

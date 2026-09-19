// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { SectionNav, type SectionNavProps } from "./index.js"
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

function renderNav(props: Partial<SectionNavProps> = {}) {
  return render(
    <SectionNav
      label="Secciones de la ficha"
      items={items}
      pathname="/pacientes/123/historia"
      LinkComponent={AnchorLink}
      {...props}
    >
      <p>contenido de la sección</p>
    </SectionNav>,
  )
}

/** El `<nav>` del árbol montado. */
function navOf(container: HTMLElement): HTMLElement {
  const nav = container.querySelector("nav")
  if (!nav) throw new Error("el árbol no tiene nav")
  return nav
}

describe("SectionNav", () => {
  it("monta un solo árbol: un landmark, un link por ítem y el contenido una vez", () => {
    const { container } = renderNav()
    expect(container.querySelectorAll("nav")).toHaveLength(1)
    expect(screen.getAllByRole("link")).toHaveLength(items.length)
    expect(screen.getAllByText("contenido de la sección")).toHaveLength(1)
  })

  it("mantiene la navegación antes del contenido", () => {
    const { container } = renderNav()
    const nav = container.querySelector("nav")
    const content = nav?.nextElementSibling
    expect(content).not.toBeNull()
    expect(content?.contains(screen.getByText("contenido de la sección"))).toBe(true)
  })

  it("lleva las dos superficies en el mismo markup: el corte lo resuelve el CSS", () => {
    const { container } = renderNav()
    const wrapper = container.firstElementChild as HTMLElement
    const nav = container.querySelector("nav") as HTMLElement
    // Barra y riel conviven: el riel es lo que añade `lg:` (1024px).
    expect(wrapper.className).toContain("flex-col")
    expect(wrapper.className).toContain("lg:flex-row")
    expect(nav.className).toContain("bottom-0")
    expect(nav.className).toContain("lg:top-6")
    expect(nav.className).toContain("lg:w-56")
  })

  it("no consulta el ancho en JavaScript: sin `matchMedia` el riel sigue en el markup", () => {
    const original = window.matchMedia
    window.matchMedia = (() => {
      throw new Error("SectionNav no debe consultar el ancho en cliente")
    }) as unknown as typeof window.matchMedia
    try {
      const { container } = renderNav()
      expect(container.querySelector("nav")?.className).toContain("lg:w-56")
    } finally {
      window.matchMedia = original
    }
  })

  it("mueve la barra al borde pedido, y sólo la barra", () => {
    const { container: abajo } = renderNav()
    const footer = navOf(abajo)
    expect(footer.className).toContain("bottom-0")
    expect(footer.className).toContain("lg:bottom-auto")
    cleanup()

    const { container: arriba } = renderNav({ mobilePosition: "header" })
    const header = navOf(arriba)
    expect(header.className).toContain("top-0")
    expect(header.className).not.toContain("bottom-0")
  })

  it("mueve el riel al lado pedido, y sólo el riel", () => {
    const { container: izquierda } = renderNav()
    expect((izquierda.firstElementChild as HTMLElement).className).toContain("lg:flex-row")
    expect((izquierda.firstElementChild as HTMLElement).className).not.toContain(
      "lg:flex-row-reverse",
    )
    cleanup()

    const { container: derecha } = renderNav({ side: "right" })
    expect((derecha.firstElementChild as HTMLElement).className).toContain("lg:flex-row-reverse")
  })

  it("un solo link por ítem, apuntando a su ruta", () => {
    renderNav()
    expect(screen.getByRole("link", { name: "Documentos" }).getAttribute("href")).toBe(
      "/pacientes/123/documentos",
    )
  })

  it("marca el ítem de la ruta exacta y ninguno más", () => {
    renderNav({ pathname: "/pacientes/123" })
    expect(screen.getByRole("link", { name: "Resumen" }).getAttribute("aria-current")).toBe("page")
    expect(
      screen.getByRole("link", { name: "Historia clínica" }).getAttribute("aria-current"),
    ).toBeNull()
  })

  it("en una subruta gana la ruta más específica, no el padre", () => {
    renderNav()
    expect(
      screen.getByRole("link", { name: "Historia clínica" }).getAttribute("aria-current"),
    ).toBe("page")
    expect(screen.getByRole("link", { name: "Resumen" }).getAttribute("aria-current")).toBeNull()
  })

  it("no marca ningún ítem fuera de la sección", () => {
    renderNav({ pathname: "/pacientes/999" })
    for (const link of screen.getAllByRole("link")) {
      expect(link.getAttribute("aria-current")).toBeNull()
    }
  })

  it("deja el contador fuera del link, una sola vez y con su espacio reservado", () => {
    renderNav({ items: [{ label: "Documentos", to: "/pacientes/123", badge: 3 }] })
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
    renderNav({
      pathname: "/pacientes/123",
      items: [
        { label: "Resumen", to: "/pacientes/123", icon: Linea, iconActive: Relleno },
        { label: "Documentos", to: "/pacientes/123/documentos", icon: Linea, iconActive: Relleno },
      ],
    })
    expect(screen.getByRole("link", { name: /Resumen/ }).querySelector("span")?.textContent).toBe(
      "relleno",
    )
    expect(
      screen.getByRole("link", { name: /Documentos/ }).querySelector("span")?.textContent,
    ).toBe("linea")
  })
})
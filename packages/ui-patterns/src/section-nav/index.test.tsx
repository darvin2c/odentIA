// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { SectionNav } from "./index.js"
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
  { label: "Historia", to: "/pacientes/123/historia" },
  { label: "Documentos", to: "/pacientes/123/documentos" },
]

/** matchMedia controlable: el corte del nav (1023px) y su evento `change`. */
function installMatchMedia(initial: boolean) {
  const listeners = new Set<() => void>()
  let matches = initial
  window.matchMedia = ((query: string) => ({
    get matches() {
      return matches
    },
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: (_event: string, listener: () => void) => {
      listeners.add(listener)
    },
    removeEventListener: (_event: string, listener: () => void) => {
      listeners.delete(listener)
    },
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  return {
    set(next: boolean) {
      matches = next
      for (const listener of listeners) listener()
    },
  }
}

function renderNav() {
  return render(
    <SectionNav
      label="Secciones de la ficha"
      items={items}
      pathname="/pacientes/123/historia"
      LinkComponent={AnchorLink}
    >
      <p>contenido de la sección</p>
    </SectionNav>,
  )
}

describe("SectionNav", () => {
  it("monta una sola superficie: nunca duplica links ni landmarks", () => {
    installMatchMedia(false)
    const { container } = renderNav()
    expect(container.querySelectorAll("nav")).toHaveLength(1)
    expect(screen.getAllByRole("link")).toHaveLength(items.length)
    expect(screen.getAllByText("contenido de la sección")).toHaveLength(1)
  })

  it("cambia de superficie al cruzar el corte sin perder el activo", () => {
    const media = installMatchMedia(false)
    const { container } = renderNav()
    const ancho = container.querySelector("nav")?.outerHTML

    act(() => media.set(true))
    expect(container.querySelectorAll("nav")).toHaveLength(1)
    expect(screen.getAllByRole("link")).toHaveLength(items.length)
    const estrecho = container.querySelector("nav")?.outerHTML

    expect(estrecho).not.toBe(ancho)
    expect(screen.getByRole("link", { name: "Historia" }).getAttribute("aria-current")).toBe("page")
  })

  it("pasa el borde elegido a la barra", () => {
    installMatchMedia(true)
    const { container: footer } = render(
      <SectionNav
        label="Secciones de la ficha"
        items={items}
        pathname="/pacientes/123/historia"
        LinkComponent={AnchorLink}
      >
        <p>contenido</p>
      </SectionNav>,
    )
    const abajo = footer.querySelector("nav")?.outerHTML
    cleanup()
    const { container: header } = render(
      <SectionNav
        label="Secciones de la ficha"
        items={items}
        pathname="/pacientes/123/historia"
        LinkComponent={AnchorLink}
        mobilePosition="header"
      >
        <p>contenido</p>
      </SectionNav>,
    )
    const arriba = header.querySelector("nav")?.outerHTML

    // Cada borde pega la barra a un lado distinto: el markup tiene que cambiar.
    expect(arriba).not.toBe(abajo)
    expect(arriba).toContain("top-0")
    expect(abajo).toContain("bottom-0")
  })

  it("no cruza las opciones entre superficies: web riel, tablet y móvil barra", () => {
    installMatchMedia(false)
    const { container: web } = render(
      <SectionNav
        label="Secciones de la ficha"
        items={items}
        pathname="/pacientes/123/historia"
        LinkComponent={AnchorLink}
        side="right"
        mobilePosition="header"
      >
        <p>contenido</p>
      </SectionNav>,
    )
    const riel = web.querySelector("nav")?.outerHTML ?? ""
    expect(riel).toContain("w-56")
    expect(riel).not.toContain("bottom-0")
    cleanup()

    installMatchMedia(true)
    const { container: tablet } = render(
      <SectionNav
        label="Secciones de la ficha"
        items={items}
        pathname="/pacientes/123/historia"
        LinkComponent={AnchorLink}
        side="right"
        mobilePosition="header"
      >
        <p>contenido</p>
      </SectionNav>,
    )
    const barra = tablet.querySelector("nav")?.outerHTML ?? ""
    expect(barra).toContain("top-0")
    expect(barra).not.toContain("w-56")
  })
})

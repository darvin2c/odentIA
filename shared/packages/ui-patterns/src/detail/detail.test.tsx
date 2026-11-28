// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { Detail } from "./detail.js"
import { DetailDrawer } from "./detail-drawer.js"
import { DetailSection } from "./detail-rows.js"
import { DetailSplit } from "./detail-split.js"

// Base UI Drawer y ScrollArea en jsdom: matchMedia decide el modo, el resto es
// andamiaje mínimo (mismo que form-drawer.test).
beforeAll(() => {
  if (typeof window !== "undefined" && !window.ResizeObserver) {
    window.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof window.ResizeObserver
  }
  if (typeof window !== "undefined" && !window.scrollTo) {
    window.scrollTo = () => {}
  }
  if (typeof Element !== "undefined" && !Element.prototype.getAnimations) {
    Element.prototype.getAnimations = () => []
  }
  if (typeof HTMLElement !== "undefined" && !HTMLElement.prototype.getAnimations) {
    HTMLElement.prototype.getAnimations = () => []
  }
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ""
})

/** El modo lo decide `useDetailMode` consultando esta única media query. */
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

function renderDetail(overrides: Partial<React.ComponentProps<typeof Detail>> = {}) {
  const props: React.ComponentProps<typeof Detail> = {
    open: true,
    onClose: vi.fn(),
    title: "Atención del 12/09/2026",
    children: <div>contenido hijo</div>,
    ...overrides,
  }
  return render(<Detail {...props} />)
}

describe("Detail", () => {
  it("en viewport ancho monta la tarjeta lateral y no un diálogo", () => {
    mockMatchMedia(true)
    renderDetail()

    expect(screen.getByRole("region", { name: "Atención del 12/09/2026" })).not.toBeNull()
    expect(screen.getByText("contenido hijo")).not.toBeNull()
    expect(document.querySelector('[data-slot="drawer-popup"]')).toBeNull()
  })

  it("en viewport estrecho monta el drawer modal y no la tarjeta", async () => {
    mockMatchMedia(false)
    renderDetail({ description: "Detalle en drawer" })

    const popup = await screen.findByText("contenido hijo")
    expect(document.querySelector('[data-slot="drawer-popup"]')).not.toBeNull()
    expect(screen.queryByRole("region", { name: "Atención del 12/09/2026" })).toBeNull()
    // El nombre accesible del popup se cablea al `h2` del shell: Base UI no
    // deriva el suyo porque el `DrawerTitle` no se usa.
    const labelledBy = popup.closest("[data-slot='drawer-popup']")?.getAttribute("aria-labelledby")
    expect(labelledBy).toBeTruthy()
    expect(document.getElementById(labelledBy as string)?.textContent).toBe(
      "Atención del 12/09/2026",
    )
  })

  it("cerrado no monta el detalle en modo panel", () => {
    mockMatchMedia(true)
    renderDetail({ open: false })

    expect(screen.queryByText("contenido hijo")).toBeNull()
    expect(screen.queryByRole("region", { name: "Atención del 12/09/2026" })).toBeNull()
    expect(document.querySelector('[data-slot="drawer-popup"]')).toBeNull()
  })
})

describe("el detalle de dos columnas", () => {
  it("el cajón `split` mide 68rem (nunca más que la ventana) y su cuerpo mide por contenedor", async () => {
    mockMatchMedia(false)
    render(
      <DetailDrawer open size="split" title="Carla Mendoza · 0164" onClose={() => {}}>
        <DetailSplit aside={<p>Confirma el Yape</p>} asideLabel="Lo que toca">
          <p>El pedido</p>
        </DetailSplit>
      </DetailDrawer>,
    )
    const dialog = await screen.findByRole("dialog", { name: "Carla Mendoza · 0164" })
    expect(dialog.className).toContain("[--drawer-content-width:min(68rem,calc(100vw-2rem))]")
    const aside = screen.getByRole("region", { name: "Lo que toca" })
    // Lo que toca va primero en el documento: arriba al apilarse, y a la derecha con `@3xl`.
    expect(aside.compareDocumentPosition(screen.getByText("El pedido")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(aside.className).toContain("@3xl:order-2")
    expect(aside.closest('[class~="@container"]')).toBeTruthy()
  })

  it("la «×» mide 44 px con el dedo y 40 con el mouse", async () => {
    mockMatchMedia(false)
    render(
      <DetailDrawer open title="Atención" onClose={() => {}}>
        <p>cuerpo</p>
      </DetailDrawer>,
    )
    const close = await screen.findByRole("button", { name: "Cerrar" })
    expect(close.className).toContain("size-10")
    expect(close.className).toContain("touch:size-11")
  })

  it("los botones de la fila de una sección miden 44 px con el dedo; lo de adentro es del contenido", () => {
    render(
      <DetailSection title="La clienta" actions={<button type="button">Ver</button>}>
        <p>Carla</p>
      </DetailSection>,
    )
    const actions = screen.getByRole("button", { name: "Ver" }).parentElement as HTMLElement
    expect(actions.className).toContain("touch:[&_[data-slot=button]]:min-h-11")
    const section = screen.getByText("La clienta").closest("section") as HTMLElement
    expect(section.className).not.toContain("[data-slot=button]")
  })
})

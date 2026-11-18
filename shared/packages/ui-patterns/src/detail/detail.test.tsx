// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { Detail } from "./detail.js"

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
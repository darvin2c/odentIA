// @vitest-environment jsdom

import { Tabs, TabsTrigger } from "@odentia/ui"
import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { revealActiveTab, ScrollingTabsList } from "./scrolling-tabs-list.js"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** jsdom no mide: la franja ocupa `scroll` px y se ven `client`. */
function stubStrip(client: number, scroll: number) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(client)
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(scroll)
}

function Strip({ count = 0 }: { count?: number }) {
  return (
    <Tabs value="atender" data-count={count}>
      <ScrollingTabsList aria-label="Vista de la bandeja">
        <TabsTrigger value="atender">Por atender</TabsTrigger>
        <TabsTrigger value="sofi">Las atiende Sofi</TabsTrigger>
        <TabsTrigger value="spam">Spam</TabsTrigger>
      </ScrollingTabsList>
    </Tabs>
  )
}

describe("ScrollingTabsList", () => {
  it("un nuevo dibujo del padre (un recuento que llega) no devuelve la franja a la elegida", async () => {
    stubStrip(300, 700)
    const scrollTo = vi.fn()
    HTMLElement.prototype.scrollTo = scrollTo as unknown as typeof HTMLElement.prototype.scrollTo
    // La elegida queda fuera de la vista: al montar se trae (Base UI la marca justo después).
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return (this.dataset.slot === "tabs-trigger" ? { left: 400, right: 480 } : { left: 0, right: 300 }) as DOMRect
    })
    const { rerender } = render(<Strip />)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const atMount = scrollTo.mock.calls.length
    expect(atMount).toBeGreaterThan(0)
    rerender(<Strip count={1} />)
    rerender(<Strip count={2} />)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(scrollTo).toHaveBeenCalledTimes(atMount)
  })

  it("si caben todas, no dibuja la flecha", () => {
    stubStrip(400, 400)
    const { container } = render(<Strip />)
    expect(container.querySelector("button[aria-hidden]")).toBeNull()
  })

  it("si quedan pestañas a la derecha, la flecha las anuncia y avanza la franja", () => {
    stubStrip(300, 700)
    const scrollBy = vi.fn()
    HTMLElement.prototype.scrollBy = scrollBy
    const { container } = render(<Strip />)

    const arrow = container.querySelector('button[data-edge="after"]')
    expect(arrow).not.toBeNull()
    expect(container.querySelector('button[data-edge="before"]')).toBeNull()
    fireEvent.click(arrow as Element)
    expect(scrollBy).toHaveBeenCalledWith({ left: 210, behavior: "smooth" })
  })

  it("si quedó algo escondido a la izquierda, también hay flecha hacia ese lado", () => {
    stubStrip(300, 700)
    vi.spyOn(HTMLElement.prototype, "scrollLeft", "get").mockReturnValue(120)
    const scrollBy = vi.fn()
    HTMLElement.prototype.scrollBy = scrollBy
    const { container } = render(<Strip />)

    const back = container.querySelector('button[data-edge="before"]')
    expect(back).not.toBeNull()
    fireEvent.click(back as Element)
    expect(scrollBy).toHaveBeenCalledWith({ left: -210, behavior: "smooth" })
  })
})

/** Una franja de 300 px que empieza en 0 y se ve desde `scrollLeft`; la pestaña elegida ocupa `left..right`. */
function stripWith(tab: { left: number; right: number }, scrollLeft: number) {
  const list = document.createElement("div")
  const active = document.createElement("button")
  active.dataset.slot = "tabs-trigger"
  active.dataset.active = ""
  list.append(active)
  list.getBoundingClientRect = () => ({ left: 0, right: 300 }) as DOMRect
  active.getBoundingClientRect = () => ({ left: tab.left, right: tab.right }) as DOMRect
  Object.defineProperty(list, "scrollLeft", { value: scrollLeft, writable: true })
  Object.defineProperty(list, "clientWidth", { value: 300 })
  Object.defineProperty(list, "scrollWidth", { value: 800 })
  const scrollTo = vi.fn()
  list.scrollTo = scrollTo as unknown as typeof list.scrollTo
  return { list, scrollTo }
}

describe("revealActiveTab", () => {
  it("trae entera la elegida que quedó cortada a la derecha, fuera de la flecha", () => {
    const { list, scrollTo } = stripWith({ left: 250, right: 360 }, 0)
    revealActiveTab(list, "auto")
    expect(scrollTo).toHaveBeenCalledWith({ left: 104, behavior: "auto" })
  })

  it("trae la elegida que quedó cortada a la izquierda («0» suelto de «Abiertos · 0»)", () => {
    const { list, scrollTo } = stripWith({ left: -60, right: 20 }, 200)
    revealActiveTab(list, "smooth")
    expect(scrollTo).toHaveBeenCalledWith({ left: 96, behavior: "smooth" })
  })

  it("si ya se ve entera, no mueve nada", () => {
    const { list, scrollTo } = stripWith({ left: 60, right: 200 }, 0)
    revealActiveTab(list, "auto")
    expect(scrollTo).not.toHaveBeenCalled()
  })
})

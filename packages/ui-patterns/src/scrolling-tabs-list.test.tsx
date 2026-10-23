// @vitest-environment jsdom

import { Tabs, TabsTrigger } from "@odentia/ui"
import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ScrollingTabsList } from "./scrolling-tabs-list.js"

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

function Strip() {
  return (
    <Tabs value="atender">
      <ScrollingTabsList aria-label="Vista de la bandeja">
        <TabsTrigger value="atender">Por atender</TabsTrigger>
        <TabsTrigger value="sofi">Las atiende Sofi</TabsTrigger>
        <TabsTrigger value="spam">Spam</TabsTrigger>
      </ScrollingTabsList>
    </Tabs>
  )
}

describe("ScrollingTabsList", () => {
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

    const arrow = container.querySelector("button[aria-hidden]")
    expect(arrow).not.toBeNull()
    fireEvent.click(arrow as Element)
    expect(scrollBy).toHaveBeenCalledWith({ left: 210, behavior: "smooth" })
  })
})

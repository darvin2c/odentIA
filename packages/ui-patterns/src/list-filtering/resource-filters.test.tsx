// @vitest-environment jsdom

import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { FilterBar } from "./filter-bar.js"
import { FilterControl } from "./filter-control.js"
import { useListSearch } from "./list-search.js"

const filter = {
  type: "multi" as const,
  key: "professionals",
  label: "Profesionales",
  emptyMeansAll: true,
  options: [
    { value: "ana", label: "Ana" },
    { value: "luis", label: "Luis" },
  ],
}
beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  HTMLElement.prototype.getAnimations ??= () => []
  HTMLElement.prototype.scrollIntoView ??= () => {}
})
afterEach(cleanup)
function mount(initialEntry = "/", toolbar = false) {
  function Surface() {
    const { get } = useListSearch()
    return (
      <>
        {toolbar ? (
          <FilterBar
            filters={[filter]}
            sortOptions={[]}
            showSearch={false}
            resetKeys={["q", "professionals"]}
          />
        ) : (
          <FilterControl filter={filter} layout="inline" />
        )}
        <output>
          {["date", "view", "group", "q", "professionals"]
            .map((key) => `${key}=${get(key) ?? ""}`)
            .join(";")}
        </output>
      </>
    )
  }
  const router = createRouter({
    routeTree: createRootRoute({
      component: Surface,
      validateSearch: (search: Record<string, unknown>) => search,
    }),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  render(<RouterProvider router={router} />)
}
describe("selección de recursos", () => {
  it("distingue todos, selección parcial y ninguno durante toggles sucesivos", async () => {
    mount()
    const ana = await screen.findByRole("option", { name: "Ana" })
    const luis = screen.getByRole("option", { name: "Luis" })
    expect(ana.getAttribute("aria-selected")).toBe("true")
    expect(luis.getAttribute("aria-selected")).toBe("true")
    fireEvent.click(ana)
    await waitFor(() => expect(ana.getAttribute("aria-selected")).toBe("false"))
    expect(luis.getAttribute("aria-selected")).toBe("true")
    fireEvent.click(luis)
    await waitFor(() => expect(luis.getAttribute("aria-selected")).toBe("false"))
    expect(screen.getByRole("status").textContent).toContain("professionals=none")
    fireEvent.click(screen.getByRole("button", { name: "Todos" }))
    await waitFor(() => expect(ana.getAttribute("aria-selected")).toBe("true"))
    expect(luis.getAttribute("aria-selected")).toBe("true")
    fireEvent.click(screen.getByRole("button", { name: "Ninguno" }))
    await waitFor(() => expect(ana.getAttribute("aria-selected")).toBe("false"))
    expect(luis.getAttribute("aria-selected")).toBe("false")
  })
  it("limpiar filtros conserva fecha, vista y agrupación y no ofrece ordenar", async () => {
    mount("/?date=2026-09-25&view=board&group=rooms&q=Rosa&professionals=none", true)
    const clear = await screen.findAllByRole("button", { name: "Limpiar" })
    fireEvent.click(clear[0])
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "date=2026-09-25;view=board;group=rooms;q=;professionals=",
      ),
    )
    expect(screen.queryByRole("button", { name: /Ordenar/ })).toBeNull()
    expect(screen.queryByRole("searchbox")).toBeNull()
  })
})

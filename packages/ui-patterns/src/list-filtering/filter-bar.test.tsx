// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { Calendar } from "./calendar.js"
import { FilterBar } from "./filter-bar.js"
import { FilterControl } from "./filter-control.js"
import { SearchInput } from "./search-input.js"
import { SortMenu } from "./sort-menu.js"

const mocks = vi.hoisted(() => ({
  values: {} as Record<string, string | undefined>,
  setParam: vi.fn(),
  setParams: vi.fn(),
  resetFilters: vi.fn(),
  resizeCallbacks: [] as (() => void)[],
}))

vi.mock("./list-search.js", () => ({
  useListSearch: () => ({
    search: mocks.values,
    get: (key: string) => mocks.values[key],
    setParam: mocks.setParam,
    setParams: mocks.setParams,
    resetFilters: mocks.resetFilters,
  }),
}))

beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  }
  window.ResizeObserver = class ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      // Test seam: el componente solo necesita el aviso, sin entries.
      mocks.resizeCallbacks.push(() => callback([], {} as ResizeObserver))
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  if (!HTMLElement.prototype.getAnimations) HTMLElement.prototype.getAnimations = () => []
  if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => {}
  if (!window.scrollTo) window.scrollTo = () => {}
})

beforeEach(() => {
  mocks.values = {}
  mocks.setParam.mockReset()
  mocks.setParams.mockReset()
  mocks.resetFilters.mockReset()
  mocks.resizeCallbacks = []
  setRowLayout(1600, 0)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  document.body.innerHTML = ""
})

const statusFilter = {
  type: "multi" as const,
  key: "status",
  label: "Estado",
  options: [
    { value: "ready", label: "Listo" },
    { value: "completed", label: "Completado" },
  ],
}

const largeMultiFilter = {
  type: "multi" as const,
  key: "category",
  label: "Categoría",
  options: Array.from({ length: 8 }, (_, index) => ({
    value: `option-${index + 1}`,
    label: `Opción ${index + 1}`,
  })),
}

const largeSelectFilter = {
  type: "select" as const,
  key: "branch_id",
  label: "Sucursal",
  options: [
    ...Array.from({ length: 7 }, (_, index) => ({
      value: `branch-${index + 1}`,
      label: `Sucursal ${index + 1}`,
    })),
    { value: "south", label: "Sucursal Sur" },
  ],
}

const overflowTotalFilter = {
  type: "number-range" as const,
  key: "total",
  label: "Totales",
  placement: "overflow" as const,
  money: true,
}

/** Simula el ancho medido del row desktop: jsdom no hace layout. */
function setRowLayout(clientWidth: number, scrollWidth: number) {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => clientWidth,
  })
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get: () => scrollWidth,
  })
}
/**
 * Ancho simulado a partir del DOM: cada chip suma su estimado y el hook
 * converge como en el navegador. Solo el row desktop mide; el resto es 0.
 */
function setRowLayoutFitted(clientWidth: number) {
  const SEARCH = 160
  const CHIP = 200
  const MORE = 150
  const CLEAR = 120
  const SORT = 80
  const GAP = 8
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: function (this: HTMLElement) {
      return this.hasAttribute("data-filter-row") ? clientWidth : 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get: function (this: HTMLElement) {
      if (!this.hasAttribute("data-filter-row")) return 0
      const parts: number[] = []
      for (const child of Array.from(this.children)) {
        const element = child as HTMLElement
        if (element.tagName === "BUTTON") {
          const label = element.getAttribute("aria-label") ?? ""
          parts.push(label.startsWith("Limpiar") ? CLEAR : MORE)
        } else if (element.querySelector('[role="searchbox"]')) {
          parts.push(SEARCH)
        } else if ((element.textContent ?? "").includes("Ordenar")) {
          parts.push(SORT)
        } else {
          parts.push(CHIP)
        }
      }
      return parts.reduce((total, part) => total + part, 0) + GAP * Math.max(0, parts.length - 1)
    },
  })
}

function triggerRowResize() {
  act(() => {
    for (const callback of mocks.resizeCallbacks) callback()
  })
}

describe("filtros de listas", () => {
  it("muestra el valor activo en el chip", () => {
    mocks.values = { status: "ready" }
    render(<FilterControl filter={statusFilter} layout="popover" />)
    expect(screen.getByRole("button", { name: /Estado: Listo/ })).toBeTruthy()
  })

  it("quita solo el filtro activo desde la x del chip", () => {
    mocks.values = { status: "ready" }
    render(<FilterControl filter={statusFilter} layout="popover" />)
    fireEvent.click(screen.getByRole("button", { name: "Limpiar: Estado" }))
    expect(mocks.setParams).toHaveBeenCalledWith({ status: undefined })
  })

  it("une la selección multi con comas", async () => {
    mocks.values = { status: "ready" }
    render(<FilterControl filter={statusFilter} layout="popover" />)
    fireEvent.click(screen.getByRole("button", { name: /Estado: Listo/ }))
    fireEvent.click(await screen.findByText("Completado"))
    expect(mocks.setParam).toHaveBeenCalledWith("status", "ready,completed")
  })

  it("usa un listbox múltiple sin checkboxes y con navegación por flechas", async () => {
    mocks.values = { status: "ready" }
    render(<FilterControl filter={statusFilter} layout="popover" />)
    fireEvent.click(screen.getByRole("button", { name: /Estado: Listo/ }))

    expect(await screen.findByRole("listbox", { name: "Estado" })).toBeTruthy()
    expect(screen.queryByRole("checkbox")).toBeNull()
    expect(screen.queryByRole("searchbox")).toBeNull()
    const ready = screen.getByRole("option", { name: "Listo" })
    const completed = screen.getByRole("option", { name: "Completado" })
    expect(ready.getAttribute("aria-selected")).toBe("true")
    expect(completed.getAttribute("aria-selected")).toBe("false")

    ready.focus()
    fireEvent.keyDown(ready, { key: "ArrowDown" })
    expect(document.activeElement).toBe(completed)
  })

  it("filtra localmente un selector múltiple desde ocho opciones", async () => {
    render(<FilterControl filter={largeMultiFilter} layout="popover" />)
    fireEvent.click(screen.getByRole("button", { name: "Categoría" }))
    const search = await screen.findByRole("searchbox", { name: /Buscar.*Categoría/ })
    fireEvent.change(search, { target: { value: "opcion 8" } })

    expect(screen.queryByRole("option", { name: "Opción 1" })).toBeNull()
    fireEvent.click(screen.getByRole("option", { name: "Opción 8" }))
    expect(mocks.setParam).toHaveBeenCalledWith("category", "option-8")
  })

  it("filtra localmente un selector simple desde ocho opciones", async () => {
    render(<FilterControl filter={largeSelectFilter} layout="popover" />)
    fireEvent.click(screen.getByRole("button", { name: "Sucursal" }))
    const search = await screen.findByRole("searchbox", { name: /Buscar.*Sucursal/ })
    fireEvent.change(search, { target: { value: "sur" } })

    expect(screen.queryByRole("option", { name: "Sucursal 1" })).toBeNull()
    fireEvent.click(screen.getByRole("option", { name: "Sucursal Sur" }))
    expect(mocks.setParam).toHaveBeenCalledWith("branch_id", "south")
  })

  it("mantiene búsqueda y ordenamiento fuera del drawer compacto", async () => {
    const { container } = render(
      <FilterBar
        filters={[statusFilter]}
        sortOptions={[{ value: "created_at", label: "Fecha" }]}
      />,
    )
    const compactBar = container.querySelector<HTMLElement>('[class~="md:hidden"]')
    const compact = within(compactBar as HTMLElement)
    expect(compact.getByRole("searchbox")).toBeTruthy()
    expect(compact.getByRole("button", { name: "Filtros" })).toBeTruthy()
    expect(compact.getByRole("button", { name: "Ordenar" })).toBeTruthy()

    fireEvent.click(compact.getByRole("button", { name: "Filtros" }))
    const drawer = await screen.findByRole("dialog", { name: "Filtros" })
    expect(within(drawer).queryByRole("searchbox")).toBeNull()
    expect(within(drawer).queryByRole("button", { name: "Ordenar" })).toBeNull()
  })

  it("agrupa filtros secundarios activos en Más filtros", async () => {
    mocks.values = { total_min: "100" }
    setRowLayout(400, 2000)
    render(
      <FilterBar
        filters={[statusFilter, overflowTotalFilter]}
        sortOptions={[{ value: "created_at", label: "Fecha" }]}
      />,
    )

    const moreFilters = screen.getByRole("button", { name: "Más filtros: 1" })
    expect(moreFilters.classList.contains("border-accent")).toBe(true)
    fireEvent.click(moreFilters)

    const drawer = await screen.findByRole("dialog", { name: "Más filtros" })
    expect(within(drawer).getByText("Totales")).toBeTruthy()
  })

  it("prioriza primarias y usa el sitio sobrante para overflow", async () => {
    const filters = [
      {
        type: "select" as const,
        key: "filter_1",
        label: "Filtro 1",
        options: [{ value: "active", label: "Activo" }],
      },
      {
        type: "select" as const,
        key: "filter_2",
        label: "Filtro 2",
        options: [{ value: "active", label: "Activo" }],
      },
      {
        type: "select" as const,
        key: "filter_3",
        label: "Filtro 3",
        placement: "overflow" as const,
        options: [{ value: "active", label: "Activo" }],
      },
      {
        type: "select" as const,
        key: "filter_4",
        label: "Filtro 4",
        placement: "overflow" as const,
        options: [{ value: "active", label: "Activo" }],
      },
    ]
    setRowLayoutFitted(1100)
    render(<FilterBar filters={filters} sortOptions={[{ value: "name", label: "Nombre" }]} />)

    expect(screen.getByRole("button", { name: "Filtro 2" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Filtro 3" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Filtro 4" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Más filtros" }))

    const drawer = await screen.findByRole("dialog", { name: "Más filtros" })
    expect(within(drawer).getByText("Filtro 4")).toBeTruthy()
    expect(within(drawer).queryByText("Filtro 3")).toBeNull()
  })

  it("muestra inline todos los filtros cuando hay espacio", () => {
    const filters = Array.from({ length: 4 }, (_, index) => ({
      type: "select" as const,
      key: `filter_${index + 1}`,
      label: `Filtro ${index + 1}`,
      options: [{ value: "active", label: "Activo" }],
    }))
    render(<FilterBar filters={filters} sortOptions={[]} />)

    expect(screen.getByRole("button", { name: "Filtro 4" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Más filtros" })).toBeNull()
  })

  it("mueve al overflow lo que no cabe y lo devuelve al haber espacio", async () => {
    const filters = Array.from({ length: 4 }, (_, index) => ({
      type: "select" as const,
      key: `filter_${index + 1}`,
      label: `Filtro ${index + 1}`,
      options: [{ value: "active", label: "Activo" }],
    }))
    setRowLayout(400, 2000)
    render(<FilterBar filters={filters} sortOptions={[]} />)

    expect(screen.queryByRole("button", { name: "Filtro 4" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Más filtros" }))

    const drawer = await screen.findByRole("dialog", { name: "Más filtros" })
    expect(within(drawer).getByText("Filtro 4")).toBeTruthy()
    fireEvent.click(within(drawer).getByRole("button", { name: "Cerrar" }))

    setRowLayout(1600, 0)
    triggerRowResize()
    expect(screen.getByRole("button", { name: "Filtro 4" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Más filtros" })).toBeNull()
  })

  it("mueve al overflow el último filtro cuando un valor lo hace crecer", () => {
    const filters = Array.from({ length: 4 }, (_, index) => ({
      type: "select" as const,
      key: `filter_${index + 1}`,
      label: `Filtro ${index + 1}`,
      options: [{ value: "active", label: "Activo" }],
    }))
    const { rerender } = render(<FilterBar filters={filters} sortOptions={[]} />)
    expect(screen.getByRole("button", { name: "Filtro 4" })).toBeTruthy()

    mocks.values = { filter_1: "active" }
    setRowLayout(400, 2000)
    rerender(<FilterBar filters={filters} sortOptions={[]} />)

    expect(screen.queryByRole("button", { name: "Filtro 4" })).toBeNull()
    expect(screen.getByRole("button", { name: "Más filtros: 1" })).toBeTruthy()
  })

  it("invierte la dirección al pulsar el sort activo", async () => {
    mocks.values = { sort: "created_at" }
    render(<SortMenu options={[{ value: "created_at", label: "Fecha" }]} />)
    fireEvent.click(screen.getByRole("button", { name: /Fecha/ }))
    const items = await screen.findAllByText("Fecha")
    fireEvent.click(items.at(-1) as HTMLElement)
    await waitFor(() => expect(mocks.setParam).toHaveBeenCalledWith("sort", "-created_at"))
  })

  it("aplica los accesos rápidos del rango de fechas", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-09-10T12:00:00Z"))
    const onSelect = vi.fn()
    render(<Calendar mode="range" selected={{}} onSelect={onSelect} />)
    fireEvent.click(screen.getByRole("button", { name: "Últimos 30 días" }))
    expect(onSelect).toHaveBeenCalledWith({ from: "2026-08-12", to: "2026-09-10" })
  })

  it("actualiza q con replace tras 300 ms", () => {
    vi.useFakeTimers()
    render(<SearchInput />)
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "ceviche" } })
    expect(mocks.setParam).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(300))
    expect(mocks.setParam).toHaveBeenCalledWith("q", "ceviche", { replace: true })
  })
})

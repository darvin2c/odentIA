// @vitest-environment jsdom

import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { DataTable, DataTableSkeleton } from "./data-table.js"
import type { DataTableView } from "./data-table-view.js"
import { DataRefreshMarker } from "./loading-state.js"

type Person = { id: string; name: string }
const rows: Person[] = [
  { id: "1", name: "Ana" },
  { id: "2", name: "Bruno" },
]
const columns: ColumnDef<Person>[] = [
  { accessorKey: "id", header: "ID" },
  { accessorKey: "name", header: "Nombre" },
]

const originalMatchMedia = window.matchMedia

// Base UI ScrollArea en jsdom necesita estos polyfills mínimos: la tabla vive
// dentro de un área con barra horizontal propia.
beforeAll(() => {
  if (typeof window !== "undefined" && !window.ResizeObserver) {
    window.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof window.ResizeObserver
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
  window.matchMedia = originalMatchMedia
})

// jsdom no simula anchos: fija el resultado de la media query móvil.
function stubMatchMedia(matches: boolean) {
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

function TestTable({ onRowClick }: { onRowClick: (row: Person) => void }) {
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() })
  return <DataTable table={table} onRowClick={onRowClick} />
}

function ActiveTable({ activeId }: { activeId: string }) {
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() })
  return <DataTable table={table} isRowActive={(row) => row.id === activeId} />
}

describe("DataTable", () => {
  it("renderiza celdas y entrega la fila pulsada", () => {
    const onRowClick = vi.fn()
    render(<TestTable onRowClick={onRowClick} />)
    expect(screen.getByText("Ana")).toBeTruthy()
    expect(screen.getByText("Bruno")).toBeTruthy()
    fireEvent.click(screen.getByText("Bruno"))
    expect(onRowClick).toHaveBeenCalledWith(rows[1])
  })

  it("marca solo la fila en edición, con aria-current para lectores de pantalla", () => {
    const { container } = render(<ActiveTable activeId="2" />)
    const marked = container.querySelectorAll('[data-state="active"]')
    expect(marked).toHaveLength(1)
    expect(marked[0]?.textContent).toContain("Bruno")
    expect(marked[0]?.getAttribute("aria-current")).toBe("true")
  })

  it("mantiene la geometría de la tabla durante la carga inicial", () => {
    const { container } = render(<DataTableSkeleton columnCount={3} rowCount={2} showPagination />)
    const status = screen.getByRole("status", { name: "Cargando…" })

    expect(status.getAttribute("aria-busy")).toBe("true")
    expect(container.querySelectorAll("thead [data-slot='skeleton']")).toHaveLength(3)
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2)
    expect(container.querySelectorAll("tbody [data-slot='skeleton']")).toHaveLength(6)
  })

  it("reserva el hueco de la lista cuando la vista no tiene cabecera", () => {
    const { container } = render(<DataTableSkeleton view="list" rowCount={2} />)
    const status = screen.getByRole("status", { name: "Cargando…" })

    expect(status.getAttribute("aria-busy")).toBe("true")
    expect(container.querySelector("table")).toBeNull()
    expect(container.querySelectorAll("[data-slot='item']")).toHaveLength(2)
  })

  it("reserva el hueco de las cards, con sus pares label/valor", () => {
    const { container } = render(<DataTableSkeleton view="card" columnCount={3} rowCount={2} />)

    expect(container.querySelector("table")).toBeNull()
    const cards = container.querySelectorAll("[data-slot='data-table-skeleton-card']")
    expect(cards).toHaveLength(2)
    expect(cards[0]?.querySelectorAll("[data-slot='data-table-skeleton-field']")).toHaveLength(3)
  })

  it("en pantallas pequeñas reserva lista aunque se pida card", () => {
    stubMatchMedia(true)
    const { container } = render(<DataTableSkeleton view="card" rowCount={2} />)

    expect(container.querySelector("[data-slot='data-table-skeleton-card']")).toBeNull()
    expect(container.querySelectorAll("[data-slot='item']")).toHaveLength(2)
  })

  it("muestra el Marker oficial con shimmer durante una actualización", () => {
    render(<DataRefreshMarker />)
    const status = screen.getByRole("status")
    const content = screen.getByText("Actualizando…")

    expect(status).toBeTruthy()
    expect(content.classList.contains("shimmer")).toBe(true)
    expect(content.classList.contains("shimmer-color-accent/60")).toBe(true)
    expect(content.classList.contains("motion-reduce:shimmer-none")).toBe(true)
  })
})

/* --------------------------- Vistas lista y card --------------------------- */

type Task = { id: string; title: string; due: string; status: string }

const tasks: Task[] = [
  { id: "1", title: "Llamar a Ana", due: "12 mar", status: "open" },
  { id: "2", title: "Confirmar cita", due: "13 mar", status: "done" },
]

const taskColumns: ColumnDef<Task>[] = [
  { accessorKey: "title", header: "Título" },
  { accessorKey: "due", header: "Vence" },
  { accessorKey: "status", header: "Estado" },
  { id: "actions", header: "", cell: () => <button type="button">Completar</button> },
]

function TaskTable({
  view,
  onRowClick,
  columns = taskColumns,
}: {
  view?: DataTableView
  onRowClick?: (row: Task) => void
  columns?: ColumnDef<Task>[]
}) {
  const table = useReactTable({ data: tasks, columns, getCoreRowModel: getCoreRowModel() })
  return <DataTable table={table} view={view} onRowClick={onRowClick} />
}

describe("DataTable en lista", () => {
  it("muestra título y resumen sin cabeceras ni tabla", () => {
    const { container } = render(<TaskTable view="list" />)

    expect(container.querySelector("table")).toBeNull()
    expect(container.querySelectorAll("[data-slot='item']")).toHaveLength(2)
    expect(screen.getByText("Llamar a Ana")).toBeTruthy()
    const summary = container.querySelector("[data-slot='item-description']")
    expect(summary?.textContent).toContain("12 mar")
    expect(summary?.textContent).toContain("open")
  })

  it("la fila completa abre el registro y sus acciones internas no", () => {
    const onRowClick = vi.fn()
    render(<TaskTable view="list" onRowClick={onRowClick} />)

    fireEvent.click(screen.getByText("Llamar a Ana"))
    expect(onRowClick).toHaveBeenCalledWith(tasks[0])

    fireEvent.click(screen.getAllByText("Completar")[0])
    expect(onRowClick).toHaveBeenCalledTimes(1)
  })

  it("conserva el seleccionar-todas de la columna de selección", () => {
    const columns: ColumnDef<Task>[] = [
      {
        id: "select",
        header: () => <input type="checkbox" aria-label="Seleccionar todas las tareas" />,
        cell: () => <input type="checkbox" />,
        meta: { view: { role: "select" } },
      },
      ...taskColumns,
    ]
    render(<TaskTable view="list" columns={columns} />)

    expect(screen.getByLabelText("Seleccionar todas las tareas")).toBeTruthy()
    expect(screen.getByText("Seleccionar todo")).toBeTruthy()
    expect(screen.getByText("Llamar a Ana")).toBeTruthy()
  })

  it("se fuerza en pantallas pequeñas aunque se pida tabla", () => {
    stubMatchMedia(true)
    const { container } = render(<TaskTable />)

    expect(container.querySelector("table")).toBeNull()
    expect(container.querySelectorAll("[data-slot='item']")).toHaveLength(2)
  })
})

describe("DataTable en card", () => {
  const cardColumns: ColumnDef<Task>[] = [
    { accessorKey: "title", header: "Título", meta: { view: { role: "title" } } },
    { accessorKey: "due", header: "Vence", meta: { view: { primary: true } } },
    { accessorKey: "status", header: "Estado" },
    { id: "actions", header: "", cell: () => <button type="button">Completar</button> },
  ]

  it("sube el campo principal a la cabecera y deja el resto en la ficha, con etiqueta", () => {
    const { container } = render(<TaskTable view="card" columns={cardColumns} />)

    expect(container.querySelector("table")).toBeNull()
    const cards = container.querySelectorAll("[data-slot='data-table-card']")
    expect(cards).toHaveLength(2)
    expect(Array.from(container.querySelectorAll("dt")).map((dt) => dt.textContent)).toEqual([
      "Estado",
      "Estado",
    ])
    expect(screen.getByText("Llamar a Ana")).toBeTruthy()
    expect(screen.getAllByText("Completar")).toHaveLength(2)
  })

  it("no repite en la ficha el campo que ya está en la cabecera", () => {
    render(<TaskTable view="card" columns={cardColumns} />)

    const card = screen.getByText("Llamar a Ana").closest("[data-slot='data-table-card']")
    expect(card?.querySelector("p")?.textContent).toContain("12 mar")
    expect(card?.textContent).not.toContain("Vence")
  })
})

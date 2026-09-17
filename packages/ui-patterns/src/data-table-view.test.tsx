// @vitest-environment jsdom
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import {
  columnLabel,
  type DataTableView,
  resolveViewColumns,
  useResolvedView,
  type ViewColumns,
} from "./data-table-view.js"

type Person = { id: string; name: string; email: string; role: string }

const people: Person[] = [{ id: "1", name: "Ana", email: "ana@clinica.pe", role: "admin" }]

const originalMatchMedia = window.matchMedia

afterEach(() => {
  cleanup()
  window.matchMedia = originalMatchMedia
})

// matchMedia bajo control: jsdom no simula anchos reales.
function stubMatchMedia(initial: boolean) {
  let matches = initial
  const listeners = new Set<() => void>()
  window.matchMedia = () =>
    ({
      get matches() {
        return matches
      },
      media: "(max-width: 767px)",
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: (_type: string, cb: () => void) => {
        listeners.add(cb)
      },
      removeEventListener: (_type: string, cb: () => void) => {
        listeners.delete(cb)
      },
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList
  return {
    setMatches(next: boolean) {
      matches = next
      listeners.forEach((cb) => {
        cb()
      })
    },
    listenerCount() {
      return listeners.size
    },
  }
}

/** Ejecuta `resolveViewColumns` sobre una tabla real sin pintar nada. */
function resolve(columns: ColumnDef<Person>[]): ViewColumns<Person> {
  const holder: { current: ViewColumns<Person> | null } = { current: null }
  function Probe() {
    const table = useReactTable({ data: people, columns, getCoreRowModel: getCoreRowModel() })
    holder.current = resolveViewColumns(table)
    return null
  }
  render(<Probe />)
  if (holder.current === null) throw new Error("resolveViewColumns no llegó a ejecutarse")
  return holder.current
}

function ids(columns: { id: string }[] | null): string[] {
  return (columns ?? []).map((column) => column.id)
}

function ViewProbe({ view }: { view: DataTableView }) {
  const resolved = useResolvedView(view)
  return <span data-testid="resolved">{resolved}</span>
}

function renderedView(): string | null {
  return screen.getByTestId("resolved").textContent
}

describe("resolveViewColumns", () => {
  it("toma como título la primera columna y aparta selección y acciones", () => {
    const resolved = resolve([
      { id: "select", header: () => null, meta: { view: { role: "select" } } },
      { accessorKey: "name", header: "Nombre" },
      { accessorKey: "email", header: "Correo" },
      { id: "actions", header: "" },
    ])

    expect(resolved.title?.id).toBe("name")
    expect(resolved.select?.id).toBe("select")
    // Las acciones se reconocen por la convención `id: "actions"`, sin anotación.
    expect(resolved.actions?.id).toBe("actions")
    expect(ids(resolved.cardFields)).toEqual(["email"])
  })

  it("respeta role: title por encima del orden de columnas", () => {
    const resolved = resolve([
      { accessorKey: "id", header: "ID" },
      { accessorKey: "name", header: "Nombre", meta: { view: { role: "title" } } },
      { accessorKey: "email", header: "Correo" },
    ])

    expect(resolved.title?.id).toBe("name")
    expect(ids(resolved.cardFields)).toEqual(["id", "email"])
  })

  it("resume con las columnas primary y, si no hay, con las dos siguientes al título", () => {
    const withPrimary = resolve([
      { accessorKey: "name", header: "Nombre" },
      { accessorKey: "email", header: "Correo" },
      { accessorKey: "role", header: "Rol", meta: { view: { primary: true } } },
    ])
    expect(ids(withPrimary.summary)).toEqual(["role"])

    const byDefault = resolve([
      { accessorKey: "name", header: "Nombre" },
      { accessorKey: "email", header: "Correo" },
      { accessorKey: "role", header: "Rol" },
      { accessorKey: "id", header: "ID" },
    ])
    expect(ids(byDefault.summary)).toEqual(["email", "role"])
  })

  it("deja tableOnly fuera del resumen y de la card, aunque pida ser primary", () => {
    const resolved = resolve([
      { accessorKey: "name", header: "Nombre" },
      {
        accessorKey: "email",
        header: "Correo",
        meta: { view: { tableOnly: true, primary: true } },
      },
      { accessorKey: "role", header: "Rol" },
    ])

    expect(ids(resolved.cardFields)).toEqual(["role"])
    expect(ids(resolved.summary)).toEqual(["role"])
  })

  it("separa la media del resto de campos", () => {
    const resolved = resolve([
      { accessorKey: "name", header: "Nombre" },
      { id: "channels", header: "Canales", meta: { view: { role: "media" } } },
      { accessorKey: "email", header: "Correo" },
    ])

    expect(resolved.media?.id).toBe("channels")
    expect(ids(resolved.cardFields)).toEqual(["email"])
  })
})

describe("columnLabel", () => {
  it("usa el header textual y cae a meta.view.label cuando no lo es", () => {
    const resolved = resolve([
      { accessorKey: "name", header: "Nombre" },
      { accessorKey: "email", header: () => null, meta: { view: { label: "Correo" } } },
      { accessorKey: "role", header: () => null },
    ])
    const [email, role] = resolved.cardFields
    const title = resolved.title
    if (!title || !email || !role) throw new Error("faltan columnas")

    expect(columnLabel(title)).toBe("Nombre")
    expect(columnLabel(email)).toBe("Correo")
    expect(columnLabel(role)).toBeNull()
  })
})

describe("useResolvedView", () => {
  it("fuerza list por debajo del breakpoint móvil", () => {
    stubMatchMedia(true)
    render(<ViewProbe view="card" />)

    expect(renderedView()).toBe("list")
  })

  it("respeta la vista pedida por código en escritorio", () => {
    stubMatchMedia(false)
    render(<ViewProbe view="card" />)

    expect(renderedView()).toBe("card")
  })

  it("reacciona al cruce del breakpoint y libera el listener al desmontar", () => {
    const media = stubMatchMedia(false)
    render(<ViewProbe view="table" />)
    expect(renderedView()).toBe("table")
    expect(media.listenerCount()).toBe(1)

    act(() => media.setMatches(true))
    expect(renderedView()).toBe("list")

    cleanup()
    expect(media.listenerCount()).toBe(0)
  })
})

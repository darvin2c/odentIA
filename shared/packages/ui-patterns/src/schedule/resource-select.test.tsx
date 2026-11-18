// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import * as React from "react"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { ResourceSelect, type ResourceSelectOption } from "./resource-select.js"

beforeAll(() => {
  if (!window.ResizeObserver) {
    window.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof window.ResizeObserver
  }
})

afterEach(cleanup)

const FRAMES: ResourceSelectOption[] = [
  { id: "a", label: "Montura acetato", detail: "Ray-Ban · RB5154" },
  { id: "b", label: "Montura metal", detail: "Oakley · OX3227" },
]

/** El servidor busca por lo que no está en el nombre (el código de barras): entrega solo la segunda. */
function ServerSearch() {
  const [query, setQuery] = React.useState("")
  const options = query === "7501234567890" ? [FRAMES[1] as ResourceSelectOption] : FRAMES
  return (
    <ResourceSelect
      id="producto"
      placeholder="Buscar producto…"
      value=""
      options={options}
      onQueryChange={setQuery}
      onChange={() => undefined}
    />
  )
}

describe("ResourceSelect", () => {
  it("con búsqueda en servidor muestra lo que entrega, aunque lo escrito no esté en el nombre", async () => {
    render(<ServerSearch />)
    await userEvent.type(screen.getByRole("combobox"), "7501234567890")
    expect(await screen.findByRole("option", { name: /Montura metal/ })).toBeTruthy()
    expect(screen.queryByRole("option", { name: /Montura acetato/ })).toBeNull()
  })

  it("sin búsqueda en servidor filtra por el nombre", async () => {
    render(
      <ResourceSelect
        id="sala"
        placeholder="Buscar sala…"
        value=""
        options={FRAMES}
        onChange={() => undefined}
      />,
    )
    await userEvent.type(screen.getByRole("combobox"), "metal")
    expect(await screen.findByRole("option", { name: /Montura metal/ })).toBeTruthy()
    expect(screen.queryByRole("option", { name: /Montura acetato/ })).toBeNull()
  })
})

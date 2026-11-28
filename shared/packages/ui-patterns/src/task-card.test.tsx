// @vitest-environment jsdom

import { Badge } from "@odentia/ui"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { TaskCard } from "./task-card.js"

afterEach(cleanup)

function carla(overrides: Partial<React.ComponentProps<typeof TaskCard>> = {}) {
  const onOpen = vi.fn()
  render(
    <ul>
      <TaskCard
        title="Carla Mendoza"
        reference="0164"
        image="/fotos/sandalia.jpg"
        status={<Badge variant="warning">Pago por confirmar</Badge>}
        details={["Sandalia de tiras · dorado · 38", "Tarde · sin repartidor · Callao"]}
        task="Confirma el Yape: dice S/ 74 de S/ 101."
        actionLabel="Ver el Yape"
        label="Carla Mendoza, pedido 0164: Pago por confirmar"
        onOpen={onOpen}
        {...overrides}
      />
    </ul>,
  )
  return onOpen
}

describe("TaskCard", () => {
  it("la tarjeta y su botón abren lo mismo; el botón no actúa solo", () => {
    const onOpen = carla()
    fireEvent.click(screen.getByRole("button", { name: "Abrir: Carla Mendoza, pedido 0164: Pago por confirmar" }))
    fireEvent.click(screen.getByRole("button", { name: "Ver el Yape: Carla Mendoza" }))
    expect(onOpen).toHaveBeenCalledTimes(2)
  })

  it("arriba lo que es y abajo lo que toca, en una lista", () => {
    carla()
    const item = screen.getByRole("listitem")
    expect(item.textContent).toContain("Carla Mendoza")
    expect(item.textContent).toContain("0164")
    expect(item.textContent).toContain("Pago por confirmar")
    expect(item.textContent).toContain("Confirma el Yape")
    // La foto es decorativa: el nombre va escrito.
    expect(item.querySelector("img")?.getAttribute("alt")).toBe("")
  })

  it("lo que sigue solo va sin botón y se dice como tal", () => {
    carla({ owner: "auto", actionLabel: undefined, task: "Sigue solo: Jhon lo lleva de 9 a 1." })
    expect(screen.queryByRole("button", { name: /Ver el Yape/ })).toBeNull()
    expect(screen.getAllByRole("button")).toHaveLength(1)
    expect(screen.getByText("Sigue solo: Jhon lo lleva de 9 a 1.").className).toContain("text-muted-foreground")
  })

  it("sin foto el cuadro queda vacío y la tarjeta no cambia de forma", () => {
    carla({ image: null })
    const item = screen.getByRole("listitem")
    expect(item.querySelector("img")).toBeNull()
    expect(item.querySelector(".size-12")).toBeTruthy()
  })

  it("sin nombre propio, la tarjeta se nombra por su título y su referencia", () => {
    carla({ label: undefined })
    expect(screen.getByRole("button", { name: "Abrir: Carla Mendoza, 0164" })).toBeTruthy()
  })

  it("abierta al lado se marca, y lo que trae de arrastre va en su raíz", () => {
    const onPointerDown = vi.fn()
    carla({ selected: true, onPointerDown, "data-dragging": "true" } as never)
    const item = screen.getByRole("listitem")
    expect(item.getAttribute("data-selected")).toBe("true")
    expect(item.getAttribute("data-dragging")).toBe("true")
    expect(screen.getByRole("button", { name: /^Abrir:/ }).getAttribute("aria-current")).toBe("true")
    fireEvent.pointerDown(screen.getByText("Carla Mendoza"))
    expect(onPointerDown).toHaveBeenCalled()
  })
})

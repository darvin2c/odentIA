// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { RowActions } from "./row-actions.js"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  document.body.innerHTML = ""
})

function renderRow() {
  const onEdit = vi.fn()
  const onDelete = vi.fn()
  render(
    <RowActions
      label="Acciones de Mesa T1"
      items={[
        { key: "edit", label: "Editar", onSelect: onEdit },
        { key: "delete", label: "Eliminar", tone: "danger", onSelect: onDelete },
      ]}
    />,
  )
  return { onEdit, onDelete }
}

describe("RowActions", () => {
  it("un solo botón ellipsis con label accesible", () => {
    renderRow()
    const trigger = screen.getByRole("button", { name: "Acciones de Mesa T1" })
    expect(trigger).toBeTruthy()
    expect(screen.queryByRole("menuitem")).toBeNull()
  })

  it("abre el menú y dispara la acción elegida", async () => {
    const { onEdit, onDelete } = renderRow()
    fireEvent.click(screen.getByRole("button", { name: "Acciones de Mesa T1" }))
    const edit = await screen.findByRole("menuitem", { name: "Editar" })
    fireEvent.click(edit)
    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onDelete).not.toHaveBeenCalled()
  })

  it("el ítem danger se ve en rojo", async () => {
    renderRow()
    fireEvent.click(screen.getByRole("button", { name: "Acciones de Mesa T1" }))
    const del = await screen.findByRole("menuitem", { name: "Eliminar" })
    expect(del.getAttribute("data-variant")).toBe("destructive")
  })

  it("ítem deshabilitado no dispara", async () => {
    const onGone = vi.fn()
    render(
      <RowActions
        label="Acciones"
        items={[{ key: "x", label: "Quitar", disabled: true, onSelect: onGone }]}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Acciones" }))
    const item = await screen.findByRole("menuitem", { name: "Quitar" })
    fireEvent.click(item)
    await waitFor(() => expect(onGone).not.toHaveBeenCalled())
  })
})

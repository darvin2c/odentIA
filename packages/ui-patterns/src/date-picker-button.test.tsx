// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { DatePickerButton } from "./date-picker-button.js"

describe("DatePickerButton", () => {
  it("dice la fecha con el texto de la pantalla y entrega la elegida como fecha-sola", async () => {
    const onChange = vi.fn()
    render(
      <DatePickerButton value="2026-10-12" onChange={onChange}>
        Lunes 12 de octubre
      </DatePickerButton>,
    )
    fireEvent.click(screen.getByRole("button", { name: "Lunes 12 de octubre" }))
    // El calendario abre en el mes de la fecha elegida: el 15 es de octubre.
    const grid = await screen.findByRole("grid")
    const fifteenth = [...grid.querySelectorAll<HTMLElement>("button")].find(
      (button) => button.textContent?.trim() === "15",
    )
    if (!fifteenth) throw new Error("falta el día 15")
    fireEvent.click(fifteenth)
    expect(onChange).toHaveBeenCalledWith("2026-10-15")
  })

  it("no deja elegir antes de la primera fecha permitida", async () => {
    const onChange = vi.fn()
    render(
      <DatePickerButton value="2026-10-12" min="2026-10-12" onChange={onChange}>
        Desde hoy
      </DatePickerButton>,
    )
    fireEvent.click(screen.getByRole("button", { name: "Desde hoy" }))
    const grid = await screen.findByRole("grid")
    const ninth = [...grid.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "9",
    )
    if (!ninth) throw new Error("falta el día 9")
    expect(ninth.disabled).toBe(true)
    fireEvent.click(ninth)
    expect(onChange).not.toHaveBeenCalled()
  })
})

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { DatePickerButton } from "./date-picker-button.js"

afterEach(cleanup)

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

  it("sin texto propio, dice el día con su año escrito, también a quien no ve la pantalla", () => {
    render(
      <>
        <label htmlFor="toma">Fecha de toma</label>
        <DatePickerButton id="toma" value="2026-11-20" onChange={() => {}} />
      </>,
    )
    const button = screen.getByRole("button", { name: "Fecha de toma" })
    expect(button.textContent).toContain("Vie 20 nov 2026")
    // La etiqueta es el nombre; la fecha elegida, su descripción.
    const described = document.getElementById(button.getAttribute("aria-describedby") ?? "")
    expect(described?.textContent).toBe("Vie 20 nov 2026")
  })

  it("elige el año y el mes de una lista para llegar lejos sin pasar mes a mes", async () => {
    const onChange = vi.fn()
    render(<DatePickerButton value="2026-10-12" onChange={onChange} aria-label="Vence" />)
    fireEvent.click(screen.getByRole("button", { name: "Vence" }))
    fireEvent.change(await screen.findByRole("combobox", { name: "Elegir el año" }), {
      target: { value: "2029" },
    })
    fireEvent.change(screen.getByRole("combobox", { name: "Elegir el mes" }), { target: { value: "2" } })
    const third = [...screen.getByRole("grid").querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "3" && !button.closest("[data-outside]"),
    )
    if (!third) throw new Error("falta el día 3")
    fireEvent.click(third)
    expect(onChange).toHaveBeenCalledWith("2029-03-03")
  })

  it("una fecha opcional se quita desde el propio calendario", async () => {
    const onChange = vi.fn()
    render(<DatePickerButton value="2026-10-12" onChange={onChange} emptyLabel="Sin vencimiento" aria-label="Vence" />)
    fireEvent.click(screen.getByRole("button", { name: "Vence" }))
    fireEvent.click(await screen.findByRole("button", { name: "Sin vencimiento" }))
    expect(onChange).toHaveBeenCalledWith("")
  })
})

// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import * as React from "react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { TimeSelect, type TimeSelectProps, timeOptions } from "./time-select.js"

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

function Harness(props: Partial<TimeSelectProps> & { initial?: string }) {
  const [value, setValue] = React.useState(props.initial ?? "")
  return (
    <TimeSelect
      aria-label="Desde"
      {...props}
      value={value}
      onChange={(next) => {
        setValue(next)
        props.onChange?.(next)
      }}
    />
  )
}

describe("timeOptions", () => {
  it("ofrece cada 15 minutos dentro de los límites", () => {
    expect(timeOptions({ min: "08:00", max: "09:00" })).toEqual(["08:00", "08:15", "08:30", "08:45", "09:00"])
    expect(timeOptions({}).length).toBe(96)
    // El inicio se redondea hacia arriba: nunca antes del mínimo.
    expect(timeOptions({ min: "10:07", max: "10:45" })).toEqual(["10:15", "10:30", "10:45"])
  })

  it("conserva una hora guardada que no cae en el paso", () => {
    expect(timeOptions({ min: "10:00", max: "11:00", value: "10:35" })).toContain("10:35")
  })
})

describe("TimeSelect", () => {
  it("elige una hora de la lista y la entrega como HH:MM", async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} min="07:00" max="09:00" />)
    await userEvent.click(screen.getByRole("combobox", { name: "Desde" }))
    await userEvent.click(await screen.findByRole("option", { name: "08:15" }))
    expect(onChange).toHaveBeenLastCalledWith("08:15")
    expect(screen.getByRole("combobox", { name: "Desde" }).textContent).toContain("08:15")
  })

  it("la opción vacía deja la hora sin elegir", async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} initial="10:00" min="09:00" max="10:30" emptyLabel="Ahora (10:35)" />)
    await userEvent.click(screen.getByRole("combobox", { name: "Desde" }))
    await userEvent.click(await screen.findByRole("option", { name: "Ahora (10:35)" }))
    expect(onChange).toHaveBeenLastCalledWith("")
    // Sin hora, el campo dice la opción vacía, no «Elegir la hora».
    expect(screen.getByRole("combobox", { name: "Desde" }).textContent).toContain("Ahora (10:35)")
  })
})

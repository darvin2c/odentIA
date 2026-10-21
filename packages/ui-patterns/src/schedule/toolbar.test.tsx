// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { setupScheduleDom } from "./test-utils.js"
import { ScheduleToolbar } from "./toolbar.js"

setupScheduleDom()

const VISTAS = [
  { id: "dia", label: "Día" },
  { id: "semana", label: "Semana" },
  { id: "mes", label: "Mes" },
]

describe("ScheduleToolbar", () => {
  it("navega, vuelve a hoy y anuncia el rango", () => {
    const onPrevious = vi.fn()
    const onNext = vi.fn()
    const onToday = vi.fn()
    render(
      <ScheduleToolbar
        rangeLabel="Lunes 21 de setiembre"
        onPrevious={onPrevious}
        onNext={onNext}
        onToday={onToday}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Anterior" }))
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }))
    fireEvent.click(screen.getByRole("button", { name: "Hoy" }))
    expect(onPrevious).toHaveBeenCalledTimes(1)
    expect(onNext).toHaveBeenCalledTimes(1)
    expect(onToday).toHaveBeenCalledTimes(1)
    expect(screen.getByText("Lunes 21 de setiembre")).toBeTruthy()
  })

  it("el conmutador marca la vista activa y avisa del cambio", () => {
    const onViewChange = vi.fn()
    render(<ScheduleToolbar rangeLabel="Semana 39" views={VISTAS} view="semana" onViewChange={onViewChange} />)
    expect(screen.getByRole("tab", { name: "Semana" }).getAttribute("aria-selected")).toBe("true")
    expect(screen.getByRole("tab", { name: "Día" }).getAttribute("aria-selected")).toBe("false")
    fireEvent.click(screen.getByRole("tab", { name: "Mes" }))
    expect(onViewChange).toHaveBeenCalledWith("mes")
  })

  it("la acción principal y el contexto se renderizan", () => {
    render(
      <ScheduleToolbar
        rangeLabel="Hoy"
        context={<span>Sede Miraflores</span>}
        action={<button type="button">Nueva cita</button>}
      />,
    )
    expect(screen.getByText("Sede Miraflores")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Nueva cita" })).toBeTruthy()
  })
})

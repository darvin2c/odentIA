// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import * as React from "react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { minutesToInstant } from "../schedule/time.js"
import { DueAtField, defaultMinutesFor, dueParts } from "./due-at-field.js"

const LIMA = "America/Lima"

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

describe("dueParts", () => {
  it("un día y una hora elegidos en la clínica vuelven al mismo instante", () => {
    const iso = minutesToInstant("2026-10-17", 10 * 60 + 30, LIMA)
    expect(iso).toBe("2026-10-17T15:30:00.000Z")
    expect(dueParts(iso, LIMA)).toEqual({ date: "2026-10-17", minutes: 630 })
    expect(dueParts("basura", LIMA)).toBeNull()
  })
})

describe("DueAtField", () => {
  it("cambia la hora sin mover el día, en la zona de la clínica", async () => {
    const onChange = vi.fn()
    function Harness() {
      const [value, setValue] = React.useState<string | null>("2099-10-17T14:00:00.000Z")
      return (
        <DueAtField
          timeZone={LIMA}
          value={value}
          onChange={(next) => {
            setValue(next)
            onChange(next)
          }}
        />
      )
    }
    render(<Harness />)
    // 14:00 UTC son las 09:00 en Lima.
    const hour = screen.getByRole("combobox", { name: "Hora" })
    expect(hour.textContent).toContain("09:00")
    await userEvent.click(hour)
    await userEvent.click(await screen.findByRole("option", { name: "10:45" }))
    expect(onChange).toHaveBeenLastCalledWith("2099-10-17T15:45:00.000Z")
  })

  it("«Sin fecha» la quita", async () => {
    const onChange = vi.fn()
    render(<DueAtField timeZone={LIMA} value="2099-10-17T14:00:00.000Z" onChange={onChange} />)
    await userEvent.click(screen.getByRole("button", { name: "Sin fecha" }))
    expect(onChange).toHaveBeenCalledWith(null)
  })
})

describe("la hora con la que nace una fecha de vencimiento", () => {
  it("otro día, a las 9:00; hoy antes de las 9:00, también", () => {
    expect(defaultMinutesFor("2026-11-06", "2026-11-05", 15 * 60)).toBe(9 * 60)
    expect(defaultMinutesFor("2026-11-05", "2026-11-05", 8 * 60)).toBe(9 * 60)
  })
  it("hoy, pasadas las 9:00, la próxima media hora: no nace vencida", () => {
    expect(defaultMinutesFor("2026-11-05", "2026-11-05", 10 * 60 + 12)).toBe(10 * 60 + 30)
    expect(defaultMinutesFor("2026-11-05", "2026-11-05", 10 * 60 + 30)).toBe(11 * 60)
    expect(defaultMinutesFor("2026-11-05", "2026-11-05", 23 * 60)).toBe(22 * 60)
  })
})

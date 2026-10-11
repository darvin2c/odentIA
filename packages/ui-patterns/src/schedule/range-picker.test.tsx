// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { ScheduleRangePicker, scheduleRangeState } from "./range-picker.js"
import { setupScheduleDom } from "./test-utils.js"
import { minutesToInstant } from "./time.js"
import type { ScheduleAvailability, ScheduleColumn } from "./types.js"

setupScheduleDom()

const TZ = "America/Lima"
const DATE = "2026-10-12"
const at = (hour: number, minute = 0) => minutesToInstant(DATE, hour * 60 + minute, TZ)

const LANES: ScheduleColumn[] = [
  { id: "ana", label: "Dra. Ana Torres" },
  { id: "luis", label: "Dr. Luis Vega" },
]
/** Los dos atienden de 08:00 a 14:00. */
const OPEN: ScheduleAvailability[] = [
  { columnId: "ana", start: at(8), end: at(14) },
  { columnId: "luis", start: at(8), end: at(14) },
]
/** Ana tiene libre 11:00–11:30 y 12:00–14:00; Luis, toda la mañana. */
const FREE: ScheduleAvailability[] = [
  { columnId: "ana", start: at(11), end: at(11, 30) },
  { columnId: "ana", start: at(12), end: at(14) },
  { columnId: "luis", start: at(8), end: at(14) },
]

// 60 px por hora: un píxel es un minuto y la jornada empieza a las 08:00.
const props = {
  lanes: LANES,
  date: DATE,
  timeZone: TZ,
  free: FREE,
  open: OPEN,
  defaultMinutes: 60,
  hourHeight: 60,
  marginMinutes: 0,
}

function lane(container: HTMLElement, id: string): HTMLElement {
  const node = container.querySelector<HTMLElement>(`[data-range-lane='${id}']`)
  if (!node) throw new Error(`falta el carril ${id}`)
  return node
}

describe("scheduleRangeState", () => {
  const input = { free: FREE, open: OPEN, timeZone: TZ }
  it("distingue lo libre, lo ocupado dentro del horario y lo que sale del horario", () => {
    expect(scheduleRangeState({ columnId: "ana", start: at(12), end: at(13) }, input)).toBe("free")
    expect(scheduleRangeState({ columnId: "ana", start: at(9), end: at(10) }, input)).toBe("taken")
    expect(scheduleRangeState({ columnId: "ana", start: at(13, 30), end: at(14, 30) }, input)).toBe(
      "outside",
    )
  })
})

describe("ScheduleRangePicker", () => {
  it("tocar un hueco coloca el bloque con la duración habitual", () => {
    const onChange = vi.fn()
    const { container } = render(<ScheduleRangePicker {...props} value={null} onChange={onChange} />)
    // 12:07 en la columna de Ana: se ajusta al cuarto de hora anterior.
    fireEvent.click(lane(container, "ana"), { clientY: 4 * 60 + 7 })
    expect(onChange).toHaveBeenCalledWith({ columnId: "ana", start: at(12), end: at(13) })
  })

  it("en un hueco más corto que la cita habitual, el bloque toma el hueco", () => {
    const onChange = vi.fn()
    const { container } = render(<ScheduleRangePicker {...props} value={null} onChange={onChange} />)
    fireEvent.click(lane(container, "ana"), { clientY: 3 * 60 })
    expect(onChange).toHaveBeenCalledWith({ columnId: "ana", start: at(11), end: at(11, 30) })
  })

  it("pinta en blanco solo lo libre y dice cómo queda el bloque", () => {
    const { container } = render(
      <ScheduleRangePicker
        {...props}
        value={{ columnId: "ana", start: at(9), end: at(10) }}
        onChange={() => {}}
      />,
    )
    expect(lane(container, "ana").querySelectorAll("[data-range-free]")).toHaveLength(2)
    expect(container.querySelector("[data-range-block]")?.getAttribute("data-state")).toBe("taken")
  })

  it("con teclado: las flechas mueven el bloque y Mayús con flechas lo estiran", () => {
    const onChange = vi.fn()
    render(
      <ScheduleRangePicker
        {...props}
        value={{ columnId: "ana", start: at(12), end: at(13) }}
        onChange={onChange}
      />,
    )
    const block = screen.getByRole("button", { name: /^De 12:00 a 13:00 con Dra. Ana Torres/ })
    fireEvent.keyDown(block, { key: "ArrowDown" })
    expect(onChange).toHaveBeenLastCalledWith({ columnId: "ana", start: at(12, 15), end: at(13, 15) })
    fireEvent.keyDown(block, { key: "ArrowUp", shiftKey: true })
    expect(onChange).toHaveBeenLastCalledWith({ columnId: "ana", start: at(12), end: at(12, 45) })
    fireEvent.keyDown(block, { key: "ArrowRight" })
    expect(onChange).toHaveBeenLastCalledWith({ columnId: "luis", start: at(12), end: at(13) })
  })

  it("deja una hora de margen fuera del horario, donde cabe una urgencia", () => {
    const onChange = vi.fn()
    const { container } = render(
      <ScheduleRangePicker {...props} marginMinutes={60} value={null} onChange={onChange} />,
    )
    // Con margen la jornada visible va de 07:00 a 15:00: 14:30 queda a 7 h 30 del borde.
    fireEvent.click(lane(container, "ana"), { clientY: 7 * 60 + 30 })
    const picked = { columnId: "ana", start: at(14, 30), end: at(15) }
    expect(onChange).toHaveBeenCalledWith(picked)
    expect(scheduleRangeState(picked, { free: FREE, open: OPEN, timeZone: TZ })).toBe("outside")
  })

  it("señala dónde está la cita que se mueve, sin que estorbe al tocar", () => {
    const onChange = vi.fn()
    const { container } = render(
      <ScheduleRangePicker
        {...props}
        value={null}
        onChange={onChange}
        marker={{ columnId: "ana", start: at(11), end: at(11, 30), label: "Ahora está aquí, 11:00" }}
      />,
    )
    expect(screen.getByText("Ahora está aquí, 11:00")).toBeTruthy()
    expect(lane(container, "luis").querySelector("[data-range-marker]")).toBeNull()
    expect(container.querySelector("[data-range-block]")).toBeNull()
  })

  it("con la duración ya decidida, el bloque se mueve pero no se estira", () => {
    const onChange = vi.fn()
    const { container } = render(
      <ScheduleRangePicker
        {...props}
        resizable={false}
        value={{ columnId: "ana", start: at(12), end: at(13) }}
        onChange={onChange}
      />,
    )
    expect(container.querySelectorAll("[data-range-block] > div")).toHaveLength(0)
    const block = screen.getByRole("button", { name: /^De 12:00 a 13:00 con Dra. Ana Torres\. Flechas para mover$/ })
    fireEvent.keyDown(block, { key: "ArrowUp", shiftKey: true })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.keyDown(block, { key: "ArrowDown" })
    expect(onChange).toHaveBeenLastCalledWith({ columnId: "ana", start: at(12, 15), end: at(13, 15) })
    // Al tocar un hueco corto conserva su hora entera: no se encoge para caber.
    fireEvent.click(lane(container, "ana"), { clientY: 3 * 60 })
    expect(onChange).toHaveBeenLastCalledWith({ columnId: "ana", start: at(11), end: at(12) })
  })

  it("arrastrar el borde inferior cambia la duración", () => {
    const onChange = vi.fn()
    const { container } = render(
      <ScheduleRangePicker
        {...props}
        value={{ columnId: "luis", start: at(9), end: at(10) }}
        onChange={onChange}
      />,
    )
    const handles = container.querySelectorAll<HTMLElement>("[data-range-block] > div")
    const bottom = handles[handles.length - 1]
    if (!bottom) throw new Error("falta el asa inferior")
    fireEvent.pointerDown(bottom, { pointerId: 1, clientY: 120 })
    fireEvent.pointerMove(bottom, { pointerId: 1, clientY: 150 })
    fireEvent.pointerUp(bottom, { pointerId: 1, clientY: 150 })
    expect(onChange).toHaveBeenLastCalledWith({ columnId: "luis", start: at(9), end: at(10, 30) })
  })
})

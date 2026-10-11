// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { ScheduleGrid } from "./grid.js"
import { setupScheduleDom } from "./test-utils.js"
import { addDays, minutesToInstant } from "./time.js"
import type {
  ScheduleAvailability,
  ScheduleBlocked,
  ScheduleColumn,
  ScheduleEntry,
  ScheduleLane,
  ScheduleStatus,
} from "./types.js"

setupScheduleDom()

// Datos deterministas: Lima, lunes 21 de setiembre de 2026.
const SCHEDULE_TIME_ZONE = "America/Lima"
const SCHEDULE_DATE = "2026-09-21"
const scheduleInstant = (hour: number, minute = 0) =>
  minutesToInstant(SCHEDULE_DATE, hour * 60 + minute, SCHEDULE_TIME_ZONE)
const SCHEDULE_COLUMNS: ScheduleColumn[] = [
  { id: "ana", label: "Dra. Ana Quispe" },
  { id: "luis", label: "Dr. Luis Ramos" },
  { id: "elena", label: "Dra. Elena Vargas" },
]
function entry(
  id: string,
  columnId: string,
  hour: number,
  minute: number,
  duration: number,
  title: string,
  subtitle: string,
  status: ScheduleStatus,
): ScheduleEntry {
  return {
    id,
    columnId,
    start: scheduleInstant(hour, minute),
    end: minutesToInstant(SCHEDULE_DATE, hour * 60 + minute + duration, SCHEDULE_TIME_ZONE),
    status,
    title,
    subtitle,
  }
}
/** Doce citas con los cinco estados y dos solapes (c1/c10 y c6/c12). */
const SCHEDULE_ENTRIES: ScheduleEntry[] = [
  entry("c1", "ana", 8, 0, 60, "Rosa Quispe", "Limpieza", "confirmada"),
  entry("c10", "ana", 8, 30, 45, "Julio Paredes", "Urgencia", "programada"),
  entry("c2", "ana", 9, 15, 45, "Miguel Torres", "Control", "programada"),
  entry("c3", "ana", 11, 0, 90, "Lucía Fernández", "Endodoncia", "confirmada"),
  entry("c11", "ana", 17, 0, 60, "Carmen Silva", "Control", "confirmada"),
  entry("c4", "luis", 8, 30, 90, "Pedro Castillo", "Endodoncia", "atendida"),
  entry("c5", "luis", 10, 30, 45, "María López", "Consulta", "programada"),
  entry("c6", "luis", 14, 0, 60, "Jorge Díaz", "Endodoncia", "confirmada"),
  entry("c12", "luis", 14, 30, 45, "Teresa Luna", "Dolor agudo", "programada"),
  entry("c7", "elena", 9, 0, 45, "Ana Torres", "Ortodoncia", "no_asistio"),
  entry("c8", "elena", 13, 0, 30, "Luis Vega", "Ajuste", "cancelada"),
  entry("c9", "elena", 15, 0, 90, "Sofía Herrera", "Ortodoncia", "confirmada"),
]
const SCHEDULE_BLOCKED: ScheduleBlocked[] = [
  {
    id: "b1",
    columnId: "ana",
    start: scheduleInstant(13),
    end: scheduleInstant(14),
    label: "Almuerzo",
  },
  {
    id: "b2",
    columnId: "elena",
    start: scheduleInstant(12),
    end: scheduleInstant(12, 30),
    label: "Reunión",
  },
]

const LANES: ScheduleLane[] = SCHEDULE_COLUMNS.map((column) => ({
  id: column.id,
  columnId: column.id,
  date: SCHEDULE_DATE,
  label: column.label,
}))

/** Ana 08–18; Luis 09–13 y 14–18; Elena 08–17. */
const AVAILABILITY: ScheduleAvailability[] = [
  { columnId: "ana", start: scheduleInstant(8), end: scheduleInstant(18) },
  { columnId: "luis", start: scheduleInstant(9), end: scheduleInstant(13) },
  { columnId: "luis", start: scheduleInstant(14), end: scheduleInstant(18) },
  { columnId: "elena", start: scheduleInstant(8), end: scheduleInstant(17) },
]

// 60 px por hora: un píxel es un minuto y la jornada empieza a las 08:00.
const baseProps = {
  lanes: LANES,
  timeZone: SCHEDULE_TIME_ZONE,
  entries: SCHEDULE_ENTRIES,
  availability: AVAILABILITY,
  blocked: SCHEDULE_BLOCKED,
  hourHeight: 60,
}

function lane(container: HTMLElement, id: string): HTMLElement {
  const node = container.querySelector<HTMLElement>(`[data-lane='${id}']`)
  if (!node) throw new Error(`falta el carril ${id}`)
  return node
}

const at = (minutes: number, date = SCHEDULE_DATE) =>
  minutesToInstant(date, minutes, SCHEDULE_TIME_ZONE)

describe("ScheduleGrid", () => {
  it("pinta un carril por recurso y una tarjeta por cita", () => {
    const { container } = render(<ScheduleGrid {...baseProps} />)
    for (const column of SCHEDULE_COLUMNS) {
      expect(screen.getByText(column.label)).toBeTruthy()
      expect(lane(container, column.id)).toBeTruthy()
    }
    expect(screen.getAllByRole("button", { name: /^Cita de/ })).toHaveLength(SCHEDULE_ENTRIES.length)
  })

  it("apaga lo que queda fuera del horario de cada recurso", () => {
    const { container } = render(<ScheduleGrid {...baseProps} />)
    // Luis no atiende de 08:00 a 09:00 ni de 13:00 a 14:00.
    const closed = lane(container, "luis").querySelectorAll<HTMLElement>("[data-closed]")
    expect(closed).toHaveLength(2)
    expect(closed[0]?.style.top).toBe("0px")
    expect(closed[0]?.style.height).toBe("60px")
    expect(closed[1]?.style.top).toBe("300px")
    // Ana atiende toda la jornada visible.
    expect(lane(container, "ana").querySelector("[data-closed]")).toBeNull()
  })

  it("sin horario conocido no afirma que algo esté cerrado", () => {
    const { container } = render(<ScheduleGrid {...baseProps} availability={undefined} />)
    expect(container.querySelector("[data-closed]")).toBeNull()
  })

  it("los bloqueos se ven con su motivo", () => {
    const { container } = render(<ScheduleGrid {...baseProps} />)
    expect(lane(container, "ana").querySelector("[data-blocked='b1']")?.textContent).toBe("Almuerzo")
  })

  it("una cita fuera del horario ensancha la jornada en vez de desaparecer", () => {
    render(
      <ScheduleGrid
        {...baseProps}
        entries={[
          ...SCHEDULE_ENTRIES,
          {
            id: "temprano",
            columnId: "ana",
            start: at(7 * 60 + 15),
            end: at(7 * 60 + 45),
            status: "confirmada",
            title: "Cita Temprana",
          },
        ]}
      />,
    )
    expect(screen.getByText("07:00")).toBeTruthy()
    expect(screen.getByRole("button", { name: /^Cita de Cita Temprana, 07:15/ })).toBeTruthy()
  })

  it("tocar un hueco libre propone reservar con recurso, fecha y hora ajustada", () => {
    const onCreate = vi.fn()
    const { container } = render(<ScheduleGrid {...baseProps} onCreate={onCreate} />)
    // 13:25 en el carril de Elena: la cita cancelada de las 13:00 no ocupa.
    fireEvent.click(lane(container, "elena"), { clientY: 325 })
    expect(onCreate).toHaveBeenCalledWith({
      columnId: "elena",
      date: SCHEDULE_DATE,
      start: at(13 * 60 + 15),
      end: at(13 * 60 + 45),
    })
  })

  it("no propone reservar fuera de horario, sobre un bloqueo ni sobre otra cita", () => {
    const onCreate = vi.fn()
    const { container } = render(<ScheduleGrid {...baseProps} onCreate={onCreate} />)
    fireEvent.click(lane(container, "luis"), { clientY: 285 }) // 12:45 libre…
    expect(onCreate).toHaveBeenCalledTimes(1)
    fireEvent.click(lane(container, "luis"), { clientY: 320 }) // 13:20: sin atención
    fireEvent.click(lane(container, "elena"), { clientY: 250 }) // 12:10: bloqueo «Reunión»
    fireEvent.click(lane(container, "elena"), { clientY: 440 }) // 15:20: cita de Sofía
    expect(onCreate).toHaveBeenCalledTimes(1)
  })

  it("lo que ya pasó hoy no se ofrece", () => {
    const onCreate = vi.fn()
    const { container } = render(
      <ScheduleGrid {...baseProps} now={scheduleInstant(10, 20)} onCreate={onCreate} />,
    )
    fireEvent.click(lane(container, "ana"), { clientY: 125 }) // 10:05: ya pasó
    expect(onCreate).not.toHaveBeenCalled()
    fireEvent.click(lane(container, "ana"), { clientY: 152 }) // 10:32: aún libre
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ columnId: "ana", start: at(10 * 60 + 30) }),
    )
  })

  it("el hueco propuesto se recorta para no pisar la cita siguiente", () => {
    const onCreate = vi.fn()
    const { container } = render(<ScheduleGrid {...baseProps} onCreate={onCreate} />)
    // Ana: libre de 10:00 a 11:00. A las 10:45 solo caben 15 minutos.
    fireEvent.click(lane(container, "ana"), { clientY: 170 })
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ start: at(10 * 60 + 45), end: at(11 * 60) }),
    )
  })

  it("teclado: la flecha abajo mueve la hora y la derecha cambia de recurso", () => {
    const onEntryMove = vi.fn()
    render(<ScheduleGrid {...baseProps} onEntryMove={onEntryMove} />)
    const card = screen.getByRole("button", { name: /^Cita de Miguel Torres, 09:15/ })
    fireEvent.keyDown(card, { key: "Enter", altKey: true })
    fireEvent.keyDown(card, { key: "ArrowDown" })
    fireEvent.keyDown(card, { key: "ArrowRight" })
    fireEvent.keyDown(card, { key: "Enter" })
    expect(onEntryMove).toHaveBeenCalledWith(expect.objectContaining({ id: "c2" }), {
      columnId: "luis",
      start: at(9 * 60 + 30),
      end: at(10 * 60 + 15),
    })
  })

  it("en la semana el carril es un día: la flecha derecha cambia la fecha y conserva el recurso", () => {
    const onEntryMove = vi.fn()
    const next = addDays(SCHEDULE_DATE, 1)
    const week: ScheduleLane[] = [SCHEDULE_DATE, next].map((date) => ({
      id: date,
      columnId: "ana",
      date,
      label: date,
      kind: "day",
    }))
    render(<ScheduleGrid {...baseProps} lanes={week} onEntryMove={onEntryMove} />)
    // Solo las citas de Ana tienen carril esta semana.
    const deAna = SCHEDULE_ENTRIES.filter((entry) => entry.columnId === "ana").length
    expect(screen.getAllByRole("button", { name: /^Cita de/ })).toHaveLength(deAna)
    const card = screen.getByRole("button", { name: /^Cita de Miguel Torres, 09:15/ })
    fireEvent.keyDown(card, { key: "Enter", altKey: true })
    fireEvent.keyDown(card, { key: "ArrowRight" })
    fireEvent.keyDown(card, { key: "Enter" })
    expect(onEntryMove).toHaveBeenCalledWith(expect.objectContaining({ id: "c2" }), {
      columnId: "ana",
      start: at(9 * 60 + 15, next),
      end: at(10 * 60, next),
    })
  })

  it("la doble reserva se reparte lado a lado", () => {
    render(<ScheduleGrid {...baseProps} />)
    const rosa = screen.getByRole("button", { name: /^Cita de Rosa Quispe/ }).parentElement
    const julio = screen.getByRole("button", { name: /^Cita de Julio Paredes/ }).parentElement
    expect(rosa?.style.left).toContain("calc(0%")
    expect(rosa?.style.width).toContain("50%")
    expect(julio?.style.left).toContain("calc(50%")
  })

  it("rotula la hora actual y la cruza por los carriles de hoy", () => {
    const { container } = render(<ScheduleGrid {...baseProps} now={scheduleInstant(10, 20)} />)
    expect(container.querySelector("[data-now-label]")?.textContent).toBe("10:20")
    expect(container.querySelectorAll("[data-now]")).toHaveLength(1)
  })

  it("deja ver en su carril la cita que el formulario está por reservar", () => {
    const { container } = render(
      <ScheduleGrid
        {...baseProps}
        preview={{ columnId: "luis", start: at(11 * 60), end: at(11 * 60 + 45), title: "Rosa Quispe" }}
      />,
    )
    const preview = lane(container, "luis").querySelector<HTMLElement>("[data-preview]")
    expect(preview?.textContent).toContain("Rosa Quispe")
    expect(preview?.textContent).toContain("por reservar")
    expect(preview?.style.top).toBe("181px")
    expect(container.querySelectorAll("[data-preview]")).toHaveLength(1)
  })

  it("marca la cita cuyo detalle está abierto", () => {
    render(<ScheduleGrid {...baseProps} selectedEntryId="c3" />)
    expect(
      screen.getByRole("button", { name: /^Cita de Lucía Fernández/ }).getAttribute("aria-current"),
    ).toBe("true")
  })

  it("lo que ya pasó se apaga solo dentro del horario, y lo cerrado va liso", () => {
    const { container } = render(<ScheduleGrid {...baseProps} now={at(10 * 60 + 20)} />)
    // Luis atiende desde las 09:00: su pasado va de 09:00 a 10:20.
    const past = lane(container, "luis").querySelectorAll<HTMLElement>("[data-past]")
    expect(past).toHaveLength(1)
    expect(past[0]?.style.top).toBe("60px")
    expect(past[0]?.style.height).toBe("80px")
    const closed = lane(container, "luis").querySelector<HTMLElement>("[data-closed]")
    expect(closed?.style.backgroundImage ?? "").toBe("")
    // Otro día no tiene pasado.
    const tomorrow = LANES.map((item) => ({ ...item, date: addDays(SCHEDULE_DATE, 1) }))
    const next = render(<ScheduleGrid {...baseProps} lanes={tomorrow} now={at(10 * 60 + 20)} />)
    expect(next.container.querySelector("[data-past]")).toBeNull()
  })

  it("sin carriles lo dice", () => {
    render(<ScheduleGrid {...baseProps} lanes={[]} />)
    expect(screen.getByText("No hay a quién mostrar en la agenda")).toBeTruthy()
  })
})

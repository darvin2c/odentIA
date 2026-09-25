// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { ScheduleTimeline, type ScheduleTimelineApi } from "./timeline.js"
import {
  SCHEDULE_BLOCKED,
  SCHEDULE_COLUMNS,
  SCHEDULE_DATE,
  SCHEDULE_ENTRIES,
  SCHEDULE_TIME_ZONE,
  scheduleInstant,
} from "./story-fixtures.js"
import { setupScheduleDom, stubMatchMedia } from "./test-utils.js"
import { SCHEDULE_SMALL_QUERY } from "./media.js"
import { addDays, formatDateLong, formatDayMonthShort, minutesToInstant } from "./time.js"
import * as React from "react"

setupScheduleDom()

const DAY_PREV = addDays(SCHEDULE_DATE, -1)
const DAY_NEXT = addDays(SCHEDULE_DATE, 1)
// 720 min de jornada (08:00–20:00) a 110px por hora.
const DAY_WIDTH = 720 * (110 / 60)

const baseProps = {
  dates: [SCHEDULE_DATE],
  timeZone: SCHEDULE_TIME_ZONE,
  columns: SCHEDULE_COLUMNS,
  entries: SCHEDULE_ENTRIES,
  blocked: SCHEDULE_BLOCKED,
}

function scrollViewport(container: HTMLElement): HTMLElement {
  const viewport = container.querySelector<HTMLElement>("[data-slot=scroll-area-viewport]")
  if (!viewport) throw new Error("falta el viewport del scroll")
  return viewport
}

describe("ScheduleTimeline", () => {
  it("una fila por recurso con su nombre fijo a la izquierda", () => {
    render(<ScheduleTimeline {...baseProps} />)
    for (const column of SCHEDULE_COLUMNS) {
      expect(screen.getByText(column.label)).toBeTruthy()
    }
    expect(screen.getAllByRole("button", { name: /Cita de/ })).toHaveLength(SCHEDULE_ENTRIES.length)
  })

  it("la doble reserva hace crecer la fila y reparte el alto", () => {
    const { container } = render(<ScheduleTimeline {...baseProps} />)
    // c6 (14:00–15:00) y c12 (14:30–15:15) comparten la fila del Dr. Luis:
    // dos subfilas de 44px en una fila de 88px.
    const lane = container.querySelector<HTMLElement>("[data-column='luis']")
    expect(lane?.style.height).toBe("88px")
    const jorge = screen.getByRole("button", { name: /Cita de Jorge Díaz/ }).closest("div")
    const teresa = screen.getByRole("button", { name: /Cita de Teresa Luna/ }).closest("div")
    expect(jorge?.style.height).toBe("40px")
    expect(jorge?.style.top).toBe("2px")
    expect(teresa?.style.top).toBe("46px")
  })

  it("la línea de ahora cruza la jornada", () => {
    const { container } = render(<ScheduleTimeline {...baseProps} now={scheduleInstant(10, 20)} />)
    expect(container.querySelector("[data-now]")).toBeTruthy()
    expect(screen.getByText("10:20")).toBeTruthy()
  })

  it("teclado: la flecha abajo cambia de recurso y la derecha mueve la hora", () => {
    const onEntryMove = vi.fn()
    render(<ScheduleTimeline {...baseProps} onEntryMove={onEntryMove} />)
    const bloque = screen.getByRole("button", { name: /Cita de Rosa Quispe, 08:00 – 09:00/ })

    fireEvent.keyDown(bloque, { key: "Enter", altKey: true })
    fireEvent.keyDown(bloque, { key: "ArrowRight" }) // +15 min en el eje horizontal
    fireEvent.keyDown(bloque, { key: "ArrowDown" }) // fila del Dr. Luis
    fireEvent.keyDown(bloque, { key: "Enter" })

    expect(onEntryMove).toHaveBeenCalledWith(expect.objectContaining({ id: "c1" }), {
      columnId: "luis",
      start: minutesToInstant(SCHEDULE_DATE, 495, SCHEDULE_TIME_ZONE),
      end: minutesToInstant(SCHEDULE_DATE, 555, SCHEDULE_TIME_ZONE),
    })
  })

  it("teclado: la flecha en el borde de la jornada cruza al día vecino", () => {
    const onEntryMove = vi.fn()
    render(
      <ScheduleTimeline
        {...baseProps}
        dates={[DAY_PREV, SCHEDULE_DATE, DAY_NEXT]}
        onEntryMove={onEntryMove}
      />,
    )
    const bloque = screen.getByRole("button", { name: /Cita de Rosa Quispe, 08:00 – 09:00/ })

    fireEvent.keyDown(bloque, { key: "Enter", altKey: true })
    fireEvent.keyDown(bloque, { key: "ArrowLeft" }) // 08:00 del día ancla → 19:00 del día anterior
    fireEvent.keyDown(bloque, { key: "Enter" })

    expect(onEntryMove).toHaveBeenCalledWith(expect.objectContaining({ id: "c1" }), {
      columnId: "ana",
      start: minutesToInstant(DAY_PREV, 1140, SCHEDULE_TIME_ZONE),
      end: minutesToInstant(DAY_PREV, 1200, SCHEDULE_TIME_ZONE),
    })
  })

  it("los días cargados se ven en la cabecera y posicionan sus citas", () => {
    const maniana = {
      id: "x1",
      columnId: "ana",
      start: minutesToInstant(DAY_NEXT, 600, SCHEDULE_TIME_ZONE),
      end: minutesToInstant(DAY_NEXT, 660, SCHEDULE_TIME_ZONE),
      title: "Mañana Temprano",
      subtitle: "Control",
      status: "programada" as const,
    }
    const { container } = render(
      <ScheduleTimeline
        {...baseProps}
        dates={[SCHEDULE_DATE, DAY_NEXT]}
        entries={[...SCHEDULE_ENTRIES, maniana]}
      />,
    )
    expect(container.querySelector(`[data-day-header='${DAY_NEXT}']`)).toBeTruthy()
    // Día siguiente: un ancho de día (1320px) más dos horas desde las 08:00.
    const bloque = screen.getByRole("button", { name: /Cita de Mañana Temprano/ }).closest("div")
    expect(parseFloat(bloque?.style.left ?? "")).toBeCloseTo(DAY_WIDTH + 220 + 2, 0)
  })

  it("las citas de días no cargados no aparecen", () => {
    render(<ScheduleTimeline {...baseProps} dates={[DAY_NEXT]} />)
    expect(screen.queryAllByRole("button", { name: /Cita de/ })).toHaveLength(0)
  })

  it("la cabecera fija el día y el mes mientras se recorre el día", () => {
    const { container } = render(<ScheduleTimeline {...baseProps} />)
    const header = container.querySelector(`[data-day-header='${SCHEDULE_DATE}']`)
    const label = header?.querySelector(".sticky")
    expect(label).toBeTruthy()
    expect(label?.textContent).toContain("lun 21")
    expect(label?.textContent).toMatch(/set/i)
  })

  it("la rueda vertical recorre el tiempo en horizontal", () => {
    const { container } = render(
      <ScheduleTimeline {...baseProps} dates={[DAY_PREV, SCHEDULE_DATE, DAY_NEXT]} />,
    )
    const viewport = scrollViewport(container)
    Object.defineProperty(viewport, "scrollWidth", { value: 5000, configurable: true })
    Object.defineProperty(viewport, "clientWidth", { value: 800, configurable: true })

    fireEvent.wheel(viewport, { deltaY: 120 })
    expect(viewport.scrollLeft).toBe(120)
    fireEvent.wheel(viewport, { deltaY: -240 })
    expect(viewport.scrollLeft).toBe(0)
    // El gesto horizontal del trackpad no se intercepta.
    fireEvent.wheel(viewport, { deltaX: 50, deltaY: 10 })
    expect(viewport.scrollLeft).toBe(0)
  })

  it("con muchas filas deja la rueda vertical nativa y reserva Mayús para recorrer horarios", () => {
    const { container } = render(<ScheduleTimeline {...baseProps} />)
    const viewport = scrollViewport(container)
    Object.defineProperties(viewport, {
      scrollHeight: { value: 3000, configurable: true },
      clientHeight: { value: 400, configurable: true },
      scrollWidth: { value: 5000, configurable: true },
      clientWidth: { value: 800, configurable: true },
    })
    expect(fireEvent.wheel(viewport, { deltaY: 120, cancelable: true })).toBe(true)
    expect(viewport.scrollLeft).toBe(0)
    fireEvent.wheel(viewport, { deltaY: 120, shiftKey: true })
    expect(viewport.scrollLeft).toBe(120)
  })

  it("la densidad horizontal solo muestra la hora cuando se lee entera", () => {
    const entries = [
      {
        id: "h1",
        columnId: "ana",
        start: minutesToInstant(SCHEDULE_DATE, 480, SCHEDULE_TIME_ZONE),
        end: minutesToInstant(SCHEDULE_DATE, 510, SCHEDULE_TIME_ZONE),
        title: "Cita Estrecha",
        subtitle: "Control",
        status: "confirmada" as const,
      },
      {
        id: "h2",
        columnId: "ana",
        start: minutesToInstant(SCHEDULE_DATE, 720, SCHEDULE_TIME_ZONE),
        end: minutesToInstant(SCHEDULE_DATE, 810, SCHEDULE_TIME_ZONE),
        title: "Cita Holgada",
        subtitle: "Control",
        status: "confirmada" as const,
      },
    ]
    render(<ScheduleTimeline {...baseProps} entries={entries} hourWidth={72} />)
    // 30 min a 72px/hora = 36px de ancho: solo el título.
    const estrecha = screen.getByRole("button", { name: /Cita de Cita Estrecha/ })
    expect(estrecha.textContent).not.toContain("08:00")
    // 90 min a 72px/hora = 108px de ancho: título y hora.
    const holgada = screen.getByRole("button", { name: /Cita de Cita Holgada/ })
    expect(holgada.textContent).toContain("12:00")
  })

  it("los días infinitos montan las dos sentinelas laterales", () => {
    const { container } = render(<ScheduleTimeline {...baseProps} onExtendDays={() => {}} />)
    expect(container.querySelector("[data-sentinel='start']")).toBeTruthy()
    expect(container.querySelector("[data-sentinel='end']")).toBeTruthy()
  })

  it("al anteponer un día el contenido no salta bajo el viewport", () => {
    const { container, rerender } = render(
      <ScheduleTimeline {...baseProps} dates={[SCHEDULE_DATE, DAY_NEXT]} />,
    )
    const viewport = scrollViewport(container)
    rerender(<ScheduleTimeline {...baseProps} dates={[DAY_PREV, SCHEDULE_DATE, DAY_NEXT]} />)
    expect(viewport.scrollLeft).toBeCloseTo(DAY_WIDTH, 0)
  })

  it("arranca con la hora actual centrada y la API vuelve a ella", () => {
    const scrollTo = vi.fn()

    Element.prototype.scrollTo = scrollTo
    const api = React.createRef<ScheduleTimelineApi | null>()
    const { container, rerender } = render(<ScheduleTimeline {...baseProps} apiRef={api} />)
    const viewport = scrollViewport(container)
    Object.defineProperty(viewport, "clientWidth", { value: 1200, configurable: true })
    // Simula el ancho computado del margen: no fija el diseño por defecto.
    const root =
      container.querySelector<HTMLElement>("[data-day-header]")?.parentElement?.parentElement
    root?.style.setProperty("--schedule-gutter", "240px")
    rerender(<ScheduleTimeline {...baseProps} now={scheduleInstant(15, 20)} apiRef={api} />)
    // La hora queda centrada en el espacio útil, descontando la regla de recursos.
    const primera = scrollTo.mock.calls[0][0] as { left: number }
    expect(240 + 440 * (110 / 60) - primera.left).toBeCloseTo((1200 + 240) / 2, 0)

    scrollTo.mockClear()
    act(() => api.current?.scrollToNow())
    expect(scrollTo).toHaveBeenCalledTimes(1)
  })

  it("el modo equipo conserva varios recursos en teléfono al ocultar y restaurar una fila", () => {
    stubMatchMedia((query) => query === SCHEDULE_SMALL_QUERY)
    const { rerender } = render(<ScheduleTimeline {...baseProps} mobileLayout="team" />)
    expect(screen.getByRole("button", { name: /Cita de Rosa Quispe, 08:00/ })).toBeTruthy()
    expect(screen.getByRole("button", { name: /Cita de Pedro Castillo, 08:30/ })).toBeTruthy()
    rerender(
      <ScheduleTimeline {...baseProps} mobileLayout="team" columns={[SCHEDULE_COLUMNS[0]]} />,
    )
    expect(screen.queryByRole("button", { name: /Cita de Pedro Castillo, 08:30/ })).toBeNull()
    rerender(<ScheduleTimeline {...baseProps} mobileLayout="team" />)
    expect(screen.getByRole("button", { name: /Cita de Pedro Castillo, 08:30/ })).toBeTruthy()
  })

  it("ampliar el zoom conserva el instante bajo el borde en vez de volver a hoy", () => {
    const { container, rerender } = render(<ScheduleTimeline {...baseProps} hourWidth={100} />)
    const viewport = scrollViewport(container)
    viewport.scrollLeft = 250
    rerender(<ScheduleTimeline {...baseProps} hourWidth={200} />)
    expect(viewport.scrollLeft / 200).toBeCloseTo(2.5)
  })
  it("en pantalla chica: un recurso por pantalla elegido con chips", () => {
    stubMatchMedia((query) => query === SCHEDULE_SMALL_QUERY)
    render(<ScheduleTimeline {...baseProps} />)
    // Chips de recurso arriba; el primero activo.
    const chipAna = screen.getByRole("button", { name: "Dra. Ana Quispe" })
    expect(chipAna.getAttribute("aria-pressed")).toBe("true")
    // Solo la fila del recurso activo.
    const deAna = SCHEDULE_ENTRIES.filter((e) => e.columnId === "ana").length
    expect(screen.getAllByRole("button", { name: /Cita de/ })).toHaveLength(deAna)
    // Cambiar de recurso cambia la fila.
    fireEvent.click(screen.getByRole("button", { name: "Dr. Luis Ramos" }))
    const deLuis = SCHEDULE_ENTRIES.filter((e) => e.columnId === "luis").length
    expect(screen.getAllByRole("button", { name: /Cita de/ })).toHaveLength(deLuis)
    expect(
      screen.getByRole("button", { name: "Dr. Luis Ramos" }).getAttribute("aria-pressed"),
    ).toBe("true")
  })

  it("en pantalla chica el tiempo corre vertical con horas a la izquierda", () => {
    stubMatchMedia((query) => query === SCHEDULE_SMALL_QUERY)
    const { container } = render(<ScheduleTimeline {...baseProps} />)
    // El día bajo el pulgar, con mes, pegado arriba.
    expect(screen.getByText(formatDayMonthShort(SCHEDULE_DATE))).toBeTruthy()
    // Regla de horas vertical: el último tramo de la jornada solo existe ahí.
    expect(screen.getByText("19:00")).toBeTruthy()
    // La cita de las 08:00 arranca en el borde superior de su día.
    const bloque = screen.getByRole("button", { name: /Cita de Rosa Quispe, 08:00 – 09:00/ })
    const caja = bloque.parentElement as HTMLElement
    expect(caja.style.top).toBe("2px")
    expect(Math.abs(Number.parseFloat(caja.style.height) - 84)).toBeLessThan(0.01)
    expect(container.querySelector("[data-slot=scroll-area-viewport]")).toBeNull()
  })

  it("teclado vertical: la flecha arriba en el borde cruza al día anterior", () => {
    stubMatchMedia((query) => query === SCHEDULE_SMALL_QUERY)
    const onEntryMove = vi.fn()
    render(
      <ScheduleTimeline
        {...baseProps}
        dates={[DAY_PREV, SCHEDULE_DATE, DAY_NEXT]}
        onEntryMove={onEntryMove}
      />,
    )
    const bloque = screen.getByRole("button", { name: /Cita de Rosa Quispe, 08:00 – 09:00/ })

    fireEvent.keyDown(bloque, { key: "Enter", altKey: true })
    fireEvent.keyDown(bloque, { key: "ArrowUp" }) // 08:00 del día ancla → 19:00 del día anterior
    fireEvent.keyDown(bloque, { key: "Enter" })

    expect(onEntryMove).toHaveBeenCalledWith(expect.objectContaining({ id: "c1" }), {
      columnId: "ana",
      start: minutesToInstant(DAY_PREV, 1140, SCHEDULE_TIME_ZONE),
      end: minutesToInstant(DAY_PREV, 1200, SCHEDULE_TIME_ZONE),
    })
  })

  it("en pantalla chica los días infinitos montan las dos sentinelas", () => {
    stubMatchMedia((query) => query === SCHEDULE_SMALL_QUERY)
    const { container } = render(<ScheduleTimeline {...baseProps} onExtendDays={() => {}} />)
    expect(container.querySelector("[data-sentinel='start']")).toBeTruthy()
    expect(container.querySelector("[data-sentinel='end']")).toBeTruthy()
  })

  it("en pantalla chica la franja semanal salta a otro día del stream", () => {
    stubMatchMedia((query) => query === SCHEDULE_SMALL_QUERY)
    const scrollTo = vi.fn()
    Element.prototype.scrollTo = scrollTo
    render(
      <ScheduleTimeline
        {...baseProps}
        dates={[DAY_PREV, SCHEDULE_DATE, DAY_NEXT]}
        now={scheduleInstant(10, 20)}
      />,
    )
    const franja = screen.getByRole("navigation", { name: "Semana visible" })
    const celdas = within(franja).getAllByRole("button")
    expect(celdas).toHaveLength(7)
    // Tocar el día siguiente en la franja centra su jornada en el stream.
    fireEvent.click(within(franja).getByRole("button", { name: formatDateLong(DAY_NEXT) }))
    expect(scrollTo).toHaveBeenCalled()
  })

  it("la franja sigue al día bajo la cabecera al cruzar medianoche en el stream", () => {
    stubMatchMedia((query) => query === SCHEDULE_SMALL_QUERY)
    const { container } = render(
      <ScheduleTimeline {...baseProps} dates={[DAY_PREV, SCHEDULE_DATE, DAY_NEXT]} />,
    )
    const stream = container.querySelector<HTMLElement>("[class*=overflow-y-auto]")
    if (!stream) throw new Error("falta el stream vertical")
    // Jornada de 720 min a 88px/h = 1056px por día: dos días abajo es DAY_NEXT.
    stream.scrollTop = 1056 * 2
    fireEvent.scroll(stream)
    const franja = screen.getByRole("navigation", { name: "Semana visible" })
    expect(
      within(franja)
        .getByRole("button", { name: formatDateLong(DAY_NEXT) })
        .getAttribute("aria-current"),
    ).toBe("date")
  })

  it("en escritorio la franja sigue al día bajo la regla de recursos y avisa al consumidor", () => {
    const onVisibleDateChange = vi.fn()
    const { container } = render(
      <ScheduleTimeline
        {...baseProps}
        dates={[DAY_PREV, SCHEDULE_DATE, DAY_NEXT]}
        onVisibleDateChange={onVisibleDateChange}
      />,
    )
    const franja = screen.getByRole("navigation", { name: "Semana visible" })
    expect(within(franja).getAllByRole("button")).toHaveLength(7)
    // Un día de ancho hacia la derecha: el martes queda bajo la regla.
    const viewport = container.querySelector("[data-slot=scroll-area-viewport]") as HTMLElement
    const dayWidth = 12 * 60 * (110 / 60) // 08:00–20:00 a 110px/hora
    viewport.scrollLeft = dayWidth
    fireEvent.scroll(viewport)
    expect(onVisibleDateChange).toHaveBeenCalledWith(SCHEDULE_DATE)
    expect(
      within(franja)
        .getByRole("button", { name: formatDateLong(SCHEDULE_DATE) })
        .getAttribute("aria-current"),
    ).toBe("date")
  })

  it("sin recursos lo dice", () => {
    render(
      <ScheduleTimeline
        dates={[SCHEDULE_DATE]}
        timeZone={SCHEDULE_TIME_ZONE}
        columns={[]}
        entries={[]}
      />,
    )
    expect(screen.getByText("Sin recursos en la agenda")).toBeTruthy()
  })
})

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  addDays,
  clampToWindow,
  dayMinutesIn,
  formatDateLong,
  formatDayMonthShort,
  formatDayMonthYear,
  formatDayShort,
  formatMonthLong,
  hourLabel,
  minutesToInstant,
  onDate,
  overlapsDay,
  regionToday,
  snapMinutes,
  timeRangeLabel,
  weekDates,
  zonedDateOf,
} from "./time.js"

const LIMA = "America/Lima"
/** 08:00 en el muro de Lima: 13:00 UTC. */
const OCHO_LIMA = "2026-09-21T13:00:00.000Z"
const NUEVE_LIMA = "2026-09-21T14:00:00.000Z"

describe("tiempo de agenda", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("mide los minutos desde la medianoche de la sede, no del navegador", () => {
    expect(dayMinutesIn(OCHO_LIMA, LIMA)).toBe(480)
    expect(dayMinutesIn(NUEVE_LIMA, LIMA)).toBe(540)
  })

  it("minutesToInstant es la inversa exacta de dayMinutesIn", () => {
    expect(minutesToInstant("2026-09-21", 480, LIMA)).toBe(OCHO_LIMA)
    expect(minutesToInstant("2026-09-21", 495, LIMA)).toBe("2026-09-21T13:15:00.000Z")
  })

  it("el viaje redondo aguanta días de 23 y 25 horas", () => {
    // America/Santiago: el 6 de setiembre de 2026 adelanta (día de 23h) y el
    // 5 de abril atrasa (día de 25h). El drag depende de este invariante.
    for (const [date, minutos] of [
      ["2026-09-06", 90],
      ["2026-09-06", 800],
      ["2026-04-05", 90],
      ["2026-04-05", 1499],
    ] as const) {
      const iso = minutesToInstant(date, minutos, "America/Santiago")
      expect(dayMinutesIn(iso, "America/Santiago")).toBe(minutos)
    }
  })

  it("snapMinutes redondea al cuarto de hora más cercano", () => {
    expect(snapMinutes(482, 15)).toBe(480)
    expect(snapMinutes(488, 15)).toBe(495)
    expect(snapMinutes(490, 15)).toBe(495)
  })

  it("clampToWindow mantiene el bloque dentro sin cambiar su duración", () => {
    const window = { startMinutes: 480, endMinutes: 1200 }
    expect(clampToWindow(400, 60, window)).toBe(480)
    expect(clampToWindow(1190, 60, window)).toBe(1140)
    expect(clampToWindow(600, 60, window)).toBe(600)
  })

  it("la semana empieza en lunes", () => {
    expect(weekDates("2026-09-21")).toEqual([
      "2026-09-21",
      "2026-09-22",
      "2026-09-23",
      "2026-09-24",
      "2026-09-25",
      "2026-09-26",
      "2026-09-27",
    ])
    // Un domingo pertenece a la semana que empieza el lunes anterior.
    expect(weekDates("2026-09-27")[0]).toBe("2026-09-21")
  })

  it("addDays cruza meses y años", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01")
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28")
  })

  it("rotula fechas y horas en español sin coma", () => {
    vi.useFakeTimers({ now: new Date("2026-10-16T15:00:00.000Z"), toFake: ["Date"] })
    expect(formatDateLong("2026-09-21")).toBe("Lunes 21 de setiembre")
    expect(formatDayShort("2026-09-21")).toBe("lun 21")
    expect(formatDayMonthShort("2026-09-21")).toBe("lun 21 Set")
    expect(hourLabel(480)).toBe("08:00")
    expect(timeRangeLabel(OCHO_LIMA, NUEVE_LIMA, LIMA)).toBe("08:00 – 09:00")
  })

  it("una fecha de otro año lleva su año; la del año en curso, no", () => {
    vi.useFakeTimers({ now: new Date("2026-10-16T15:00:00.000Z"), toFake: ["Date"] })
    expect(formatDateLong("2027-01-04")).toBe("Lunes 4 de enero de 2027")
    expect(formatDateLong("2025-12-31")).toBe("Miércoles 31 de diciembre de 2025")
    expect(formatDateLong("2026-12-31")).toBe("Jueves 31 de diciembre")
    expect(formatMonthLong("2027-01-04")).toBe("enero de 2027")
    expect(formatMonthLong("2026-11-04")).toBe("noviembre")
  })

  it("el año en curso es el de la clínica, no el del navegador", () => {
    // 31 de diciembre a las 23:00 en Lima: en UTC ya es 2027.
    vi.useFakeTimers({ now: new Date("2027-01-01T04:00:00.000Z"), toFake: ["Date"] })
    expect(regionToday()).toBe("2026-12-31")
    expect(formatDateLong("2026-12-31")).toBe("Jueves 31 de diciembre")
  })

  it("el botón de un día escribe siempre el año", () => {
    expect(formatDayMonthYear("2026-11-20")).toBe("Vie 20 nov 2026")
  })

  it("la fecha local de un instante es la de la sede", () => {
    expect(zonedDateOf(OCHO_LIMA, LIMA)).toBe("2026-09-21")
    // 02:00 UTC del 21 son las 21:00 del 20 en Lima.
    expect(zonedDateOf("2026-09-21T02:00:00.000Z", LIMA)).toBe("2026-09-20")
  })

  it("una cita que cruza medianoche toca los dos días", () => {
    const cita = { start: "2026-09-22T04:30:00.000Z", end: "2026-09-22T05:30:00.000Z" }
    // 23:30 a 00:30 en Lima: toca el 21 y el 22.
    expect(overlapsDay(cita, "2026-09-21", LIMA)).toBe(true)
    expect(overlapsDay(cita, "2026-09-22", LIMA)).toBe(true)
    expect(overlapsDay(cita, "2026-09-23", LIMA)).toBe(false)
    expect(onDate([cita], "2026-09-21", LIMA)).toHaveLength(1)
  })
})

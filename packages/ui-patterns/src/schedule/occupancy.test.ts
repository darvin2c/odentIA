import { describe, expect, it } from "vitest"

import {
  daySegments,
  dayRangeOf,
  formatSpan,
  freeMinutesOf,
  isCovered,
  mergeRanges,
  overlapsAny,
  subtractRanges,
  windowCovering,
} from "./occupancy.js"
import { minutesToInstant } from "./time.js"

const TZ = "America/Lima"
const range = (startMinutes: number, endMinutes: number) => ({ startMinutes, endMinutes })

describe("tramos de la agenda", () => {
  it("une los tramos que se tocan y descarta los vacíos", () => {
    expect(mergeRanges([range(600, 660), range(480, 540), range(540, 600), range(700, 700)])).toEqual(
      [range(480, 660)],
    )
  })

  it("quita los huecos de una base sin tocar lo de fuera", () => {
    expect(subtractRanges([range(480, 840)], [range(540, 600), range(780, 900)])).toEqual([
      range(480, 540),
      range(600, 780),
    ])
  })

  it("las citas contiguas no se pisan", () => {
    expect(overlapsAny(range(540, 570), [range(510, 540), range(570, 600)])).toBe(false)
    expect(overlapsAny(range(540, 570), [range(560, 600)])).toBe(true)
  })

  it("un tramo cabe solo si un turno lo cubre entero", () => {
    expect(isCovered(range(540, 600), [range(480, 780)])).toBe(true)
    // Dos turnos con almuerzo en medio no cubren una cita que lo cruza.
    expect(isCovered(range(770, 800), [range(480, 780), range(840, 1020)])).toBe(false)
  })

  it("recorta al día civil la cita que cruza medianoche", () => {
    const start = minutesToInstant("2026-09-21", 23 * 60, TZ)
    const end = minutesToInstant("2026-09-22", 60, TZ)
    expect(dayRangeOf(start, end, "2026-09-21", TZ)).toEqual(range(1380, 1440))
    expect(dayRangeOf(start, end, "2026-09-22", TZ)).toEqual(range(0, 60))
    expect(dayRangeOf(start, end, "2026-09-23", TZ)).toBeNull()
  })

  it("la ventana se ensancha para una cita fuera del horario habitual", () => {
    const fallback = { startMinutes: 480, endMinutes: 1200 }
    expect(windowCovering([], fallback)).toEqual(fallback)
    // Atención 08:00–14:00 y una cita a las 07:15: la jornada empieza a las 07:00.
    expect(windowCovering([range(480, 840), range(435, 465)], fallback)).toEqual({
      startMinutes: 420,
      endMinutes: 840,
    })
  })
})

describe("reparto del día", () => {
  const window = { startMinutes: 480, endMinutes: 840 }

  it("separa cerrado, ocupado y libre dentro de la jornada", () => {
    const segments = daySegments({
      window,
      open: [range(540, 780)],
      busy: [range(540, 585), range(660, 720)],
    })
    expect(segments).toEqual([
      { ...range(480, 540), kind: "closed" },
      { ...range(540, 585), kind: "busy" },
      { ...range(585, 660), kind: "free" },
      { ...range(660, 720), kind: "busy" },
      { ...range(720, 780), kind: "free" },
      { ...range(780, 840), kind: "closed" },
    ])
    expect(freeMinutesOf(segments)).toBe(135)
  })

  it("un bloqueo cierra el tramo aunque haya horario", () => {
    const segments = daySegments({
      window,
      open: [range(480, 840)],
      busy: [],
      blocked: [range(480, 600)],
    })
    expect(segments[0]).toEqual({ ...range(480, 600), kind: "closed" })
    expect(freeMinutesOf(segments)).toBe(240)
  })

  it("lo libre que ya pasó hoy no cuenta como libre", () => {
    const segments = daySegments({
      window,
      open: [range(480, 840)],
      busy: [range(510, 555)],
      nowMinutes: 620,
    })
    expect(segments).toEqual([
      { ...range(480, 510), kind: "past" },
      { ...range(510, 555), kind: "busy" },
      { ...range(555, 620), kind: "past" },
      { ...range(620, 840), kind: "free" },
    ])
    expect(freeMinutesOf(segments)).toBe(220)
  })

  it("dice la duración como se dice en recepción", () => {
    expect(formatSpan(45)).toBe("45 min")
    expect(formatSpan(180)).toBe("3 h")
    expect(formatSpan(90)).toBe("1 h 30")
    expect(formatSpan(125)).toBe("2 h 05")
  })
})

import { describe, expect, it } from "vitest"
import { windowOpen, WINDOW_MARGIN_MS, WHATSAPP_WINDOW_MS } from "./message-window.js"
import {
  DEFAULT_WRITING_HOURS,
  isWritingTime,
  nextWritingDay,
  normalizeWritingWeek,
  sendTimeFor,
  writingSchedule,
} from "./writing-hours.js"

/**
 * «Horario de recontacto» (decisión 18 v3, ADR 0042), con el horario que viene:
 * lunes a viernes de 8:00 a 20:00, sábado de 8:00 a 14:00, domingo sin
 * mensajes. Lima es UTC−5 todo el año; el 12 de octubre de 2026 es lunes.
 */
const LIMA = "America/Lima"
const at = (iso: string) => new Date(iso)
const schedule = writingSchedule(DEFAULT_WRITING_HOURS, LIMA)

describe("horario de recontacto", () => {
  it("viene de lunes a viernes de 8:00 a 20:00, el sábado hasta las 14:00 y el domingo nada", () => {
    expect(isWritingTime(at("2026-10-12T13:00:00Z"), schedule)).toBe(true) // lunes 8:00
    expect(isWritingTime(at("2026-10-13T00:59:00Z"), schedule)).toBe(true) // lunes 19:59
    expect(isWritingTime(at("2026-10-13T01:00:00Z"), schedule)).toBe(false) // lunes 20:00
    expect(isWritingTime(at("2026-10-17T18:59:00Z"), schedule)).toBe(true) // sábado 13:59
    expect(isWritingTime(at("2026-10-17T19:00:00Z"), schedule)).toBe(false) // sábado 14:00
    expect(isWritingTime(at("2026-10-18T15:00:00Z"), schedule)).toBe(false) // domingo 10:00
  })

  it("se lee con la hora de cada sede: las 8:00 de Madrid no son las 8:00 de Lima", () => {
    const madrid = writingSchedule(DEFAULT_WRITING_HOURS, "Europe/Madrid")
    const instant = at("2026-10-12T06:30:00Z") // lunes 8:30 en Madrid, 1:30 en Lima
    expect(isWritingTime(instant, madrid)).toBe(true)
    expect(isWritingTime(instant, schedule)).toBe(false)
  })

  it("dentro del horario sale a su hora; lo que ya tocaba, ahora", () => {
    const now = at("2026-10-12T15:00:00Z") // lunes 10:00
    const target = at("2026-10-13T15:00:00Z") // martes 10:00
    expect(sendTimeFor(target, now, schedule)).toEqual(target)
    expect(sendTimeFor(at("2026-10-12T14:00:00Z"), now, schedule)).toEqual(now)
  })

  it("fuera del horario sale en el último momento permitido antes", () => {
    // Cita el lunes 9:00; el aviso de 24 horas toca el domingo 9:00, sin mensajes: sale el sábado a las 13:59.
    const now = at("2026-10-16T15:00:00Z") // viernes 10:00
    expect(sendTimeFor(at("2026-10-18T14:00:00Z"), now, schedule, at("2026-10-19T14:00:00Z"))?.toISOString()).toBe(
      "2026-10-17T18:59:00.000Z",
    )
    // De noche (lunes 22:00) sale a las 19:59 de ese día.
    expect(sendTimeFor(at("2026-10-13T03:00:00Z"), at("2026-10-12T15:00:00Z"), schedule)?.toISOString()).toBe("2026-10-13T00:59:00.000Z")
  })

  it("si ya no hay un momento antes, sale en el primero después con una hora de margen antes de la cita", () => {
    const now = at("2026-10-18T13:00:00Z") // domingo 8:00: lo de antes ya pasó
    // Cita el lunes 10:00: el aviso sale el lunes a las 8:00, dos horas antes.
    expect(sendTimeFor(at("2026-10-18T15:00:00Z"), now, schedule, at("2026-10-19T15:00:00Z"))?.toISOString()).toBe(
      "2026-10-19T13:00:00.000Z",
    )
    // Cita el lunes 8:30: a las 8:00 falta media hora, ya no sale.
    expect(sendTimeFor(at("2026-10-18T15:00:00Z"), now, schedule, at("2026-10-19T13:30:00Z"))).toBeNull()
    // Sin cita (un seguimiento) sale igual el lunes a las 8:00.
    expect(sendTimeFor(at("2026-10-18T15:00:00Z"), now, schedule)?.toISOString()).toBe("2026-10-19T13:00:00.000Z")
  })

  it("quien ya recibió su mensaje hoy espera al primer momento de otro día", () => {
    expect(nextWritingDay(at("2026-10-16T15:00:00Z"), schedule).toISOString()).toBe("2026-10-17T13:00:00.000Z") // sábado 8:00
    expect(nextWritingDay(at("2026-10-17T15:00:00Z"), schedule).toISOString()).toBe("2026-10-19T13:00:00.000Z") // lunes 8:00
  })

  it("una semana se valida: siete días y tramos que terminan después de empezar", () => {
    expect(() => normalizeWritingWeek([[[480, 1200]]])).toThrow(/siete días/)
    expect(() => normalizeWritingWeek(Array.from({ length: 7 }, () => [[600, 500]]))).toThrow(/terminar después/)
    // Los tramos que se pisan se juntan.
    const week = normalizeWritingWeek([[], [[480, 720], [700, 900]], [], [], [], [], []])
    expect(week[1]).toEqual([[480, 900]])
  })
})

describe("la ventana de 24 horas", () => {
  it("una sola regla con su margen: abierta o cerrada la conversación", () => {
    const now = Date.parse("2026-10-12T15:00:00Z")
    expect(windowOpen(null, now)).toBe(false)
    expect(windowOpen(new Date(now - 3 * 3_600_000), now)).toBe(true)
    expect(windowOpen(new Date(now - (WHATSAPP_WINDOW_MS - WINDOW_MARGIN_MS) + 60_000), now)).toBe(true)
    expect(windowOpen(new Date(now - (WHATSAPP_WINDOW_MS - WINDOW_MARGIN_MS)), now)).toBe(false)
    expect(windowOpen(new Date(now - WHATSAPP_WINDOW_MS), now)).toBe(false)
  })
})
